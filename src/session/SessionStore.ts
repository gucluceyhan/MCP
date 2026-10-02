/**
 * Step 9: kalıcı oturum deposu — disk kalıcılığı (spec 6-18, 324-337).
 *
 * SORUMLULUK (spec 8/14-18): `session.json`'ı atomik biçimde okur/yazar.
 * Disk = source of truth; RAM = aktif önbellek. Bu sınıf:
 *
 * - **Lazy** (spec 18): sunucu kurulumu oturum taramaz; `load` yalnız bir
 *   oturum aracı gerçekten çağrıldığında çalışır.
 * - **Atomik** (spec 14): `session.json` asla yerinde yazılmaz — aynı dizinde
 *   geçici dosya → fsync → `rename` → dizin fsync (destekliyorsa). Crash
 *   yarıda kalmış yetkili bir `session.json` BIRAKMAZ.
 * - **Geçici dosya** (spec 15): deterministik `session.json.tmp`; crash'ten
 *   kalan `.tmp` YETKİLİ DEĞİL — `load` yalnız `session.json` okur.
 * - **Bozuk** (spec 16): bozuk JSON / eksik alan / geçersiz tip / bilinmeyen
 *   sürüm / güvensiz yol / id-uyumsuzluğu / kimlik-uyumsuzluğu / geçersiz
 *   kural provenance / geçersiz worker sonucu → `session_corrupt`. "Best
 *   effort" yeniden yapı YOK — fail-closed.
 * - **İzin** (spec 7): oturum dizinleri 0700, `session.json` 0600.
 * - **No-log** (spec 17): kalıcı içerik ASLA loglanmaz; hatalar sabit güvenli
 *   mesaj + (yalnız geliştirici kanalı) kısa neden etiketi taşır.
 * - **No-Git** (spec 5/113): SessionStore Git BİLMEZ — repository kimliği
 *   enjekte edilen saf `repoIdentity` dikişiyle doğrulanır; workspace
 *   yeniden kurulması `SessionManager`'ın (ve Workspace'in) işidir.
 *
 * I/O yalnız `SessionStoreFs` dikişinden: production `node:fs/promises`
 * (bu dosyadaki gerçek adapter), testler deterministik sahte.
 */

import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { computeRepoId } from "../workspace/git.js";
import { isSafeSessionId, normalizeRepoPath } from "../workspace/pathSafety.js";
import {
  RULES_SOURCES,
  SESSION_SCHEMA_VERSION,
  SessionError,
  sessionError,
  type PersistedRound,
  type PersistedSession,
  type SessionOptions,
  type SessionStoreFs,
  type SessionWriteHandle,
} from "./types.js";
import type { ResolvedRules, RuleDocumentSource } from "../rules/types.js";
import type {
  CompactResult,
  RulesSource,
  SelectedContextTier,
  ValidationResult,
  WorkerResult,
} from "../worker/result.js";
import type { ReasoningEffort } from "../backend/InferenceBackend.js";
import type { WorkspaceRecoveryState } from "../workspace/Workspace.js";

/** Oturum dizin modu (spec 7). */
const DIR_MODE = 0o700;
/** Oturum metadata dosyası modu (spec 7). */
const FILE_MODE = 0o600;
/** Yetkili kalıcı dosya adı (spec 15). */
const SESSION_FILE = "session.json";
/** Deterministik geçici yazım adı (spec 15). */
const SESSION_TMP = "session.json.tmp";

/** `err` bir `NodeJS.ErrnoException` ve `code` verilen errno'ya eşit mi? */
function errnoIs(err: unknown, code: string): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === code
  );
}

// ── Gerçek dosya sistemi adapter'i (node:fs/promises) ───────────────────────

const realFs: SessionStoreFs = {
  async mkdir(dir, mode, recursive) {
    await mkdir(dir, { recursive, mode });
  },
  async chmod(dir, mode) {
    await chmod(dir, mode);
  },
  async readFile(file) {
    return (await readFile(file, "utf8")) as string;
  },
  async openWrite(file, mode): Promise<SessionWriteHandle> {
    const handle = await open(file, "w", mode);
    return {
      writeFile: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async removeFile(file) {
    await rm(file, { force: true });
  },
  async stat(file) {
    const s = await stat(file);
    return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), mode: s.mode };
  },
  async openDir(dir) {
    const handle = await open(dir, "r");
    return { sync: () => handle.sync(), close: () => handle.close() };
  },
};

// ── Saf yapısal doğrulayıcılar (bozukluk → fail-closed) ─────────────────────
//
// Bunlar yalnız ŞEKİL denetler; içerik taşımaz/loglamaz. Her red aynı güvenli
// `session_corrupt`'a düşer; `cause` yalnız KISA bir neden etiketidir (içerik
// ASLA — spec 12/17).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function corruptFail(tag: string): never {
  throw new SessionError("session_corrupt", undefined, { cause: `session_corrupt:${tag}` });
}

function validateRules(value: unknown): ResolvedRules {
  if (!isPlainObject(value)) {
    corruptFail("rules:shape");
  }
  if (typeof value["source"] !== "string" || !(RULES_SOURCES as readonly string[]).includes(value["source"])) {
    corruptFail("rules:source");
  }
  const documents = value["documents"];
  if (!Array.isArray(documents)) {
    corruptFail("rules:documents");
  }
  for (const document of documents) {
    if (!isPlainObject(document)) {
      corruptFail("rules:document");
    }
    const source = document["source"];
    if (source !== "hook" && source !== "CLAUDE.md" && source !== "AGENTS.md") {
      corruptFail("rules:document-source");
    }
    if (typeof document["content"] !== "string") {
      corruptFail("rules:content");
    }
  }
  return value as unknown as ResolvedRules;
}

function validateOptions(value: unknown): SessionOptions {
  if (!isPlainObject(value)) {
    corruptFail("options:shape");
  }
  const options: SessionOptions = {};
  if (value["reasoningEffort"] !== undefined) {
    if (!isReasoningEffort(value["reasoningEffort"])) {
      corruptFail("options:reasoningEffort");
    }
    options.reasoningEffort = value["reasoningEffort"];
  }
  if (value["contextTier"] !== undefined) {
    if (!isContextTier(value["contextTier"])) {
      corruptFail("options:contextTier");
    }
    options.contextTier = value["contextTier"];
  }
  if (value["outputReserveTokens"] !== undefined) {
    if (typeof value["outputReserveTokens"] !== "number" || !Number.isInteger(value["outputReserveTokens"])) {
      corruptFail("options:outputReserveTokens");
    }
    options.outputReserveTokens = value["outputReserveTokens"];
  }
  return options;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "xhigh";
}

function isContextTier(value: unknown): value is SelectedContextTier {
  return value === "64k" || value === "128k" || value === "192k" || value === "runtime_max";
}

function validateWorkerResult(value: unknown): WorkerResult {
  if (!isPlainObject(value)) {
    corruptFail("workerResult:shape");
  }
  if (value["schemaVersion"] !== 1) {
    corruptFail("workerResult:schema");
  }
  if (typeof value["summary"] !== "string" || (value["summary"] as string).trim() === "") {
    corruptFail("workerResult:summary");
  }
  if (!Array.isArray(value["edits"])) {
    corruptFail("workerResult:edits");
  }
  return value as unknown as WorkerResult;
}

function validateValidation(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    corruptFail("validation:shape");
  }
  if (typeof value["editsRequested"] !== "number" || typeof value["editsApplied"] !== "number") {
    corruptFail("validation:count");
  }
  if (!Array.isArray(value["rejected"])) {
    corruptFail("validation:rejected");
  }
  return value as unknown as ValidationResult;
}

function validateResult(value: unknown, sessionId: string): CompactResult {
  if (!isPlainObject(value)) {
    corruptFail("result:shape");
  }
  if (value["sessionId"] !== sessionId) {
    corruptFail("result:sessionId");
  }
  if (typeof value["round"] !== "number" || !Number.isInteger(value["round"]) || (value["round"] as number) < 1) {
    corruptFail("result:round");
  }
  if (typeof value["status"] !== "string" || !isCompactStatus(value["status"])) {
    corruptFail("result:status");
  }
  return value as unknown as CompactResult;
}

function isCompactStatus(value: unknown): value is CompactResult["status"] {
  return (
    value === "applied" ||
    value === "partial" ||
    value === "failed" ||
    value === "stale_base" ||
    value === "needs_split" ||
    value === "max_rounds" ||
    value === "inference_busy"
  );
}

function validateRound(value: unknown, sessionId: string): PersistedRound {
  if (!isPlainObject(value)) {
    corruptFail("round:shape");
  }
  if (typeof value["round"] !== "number" || !Number.isInteger(value["round"]) || (value["round"] as number) < 1) {
    corruptFail("round:round");
  }
  if (value["feedback"] !== undefined && typeof value["feedback"] !== "string") {
    corruptFail("round:feedback");
  }
  validateWorkerResult(value["workerResult"]);
  validateValidation(value["validation"]);
  const result = validateResult(value["result"], sessionId);
  if (result.round !== (value["round"] as number)) {
    corruptFail("round:consistency");
  }
  const round: PersistedRound = {
    round: value["round"] as number,
    workerResult: value["workerResult"] as unknown as WorkerResult,
    validation: value["validation"] as unknown as ValidationResult,
    result,
  };
  if (value["feedback"] !== undefined) {
    round.feedback = value["feedback"] as string;
  }
  return round;
}

function validateWorkspaceRecovery(value: unknown, sessionId: string): WorkspaceRecoveryState {
  // Hafif denetim: varlık + şema + kimlik + taban SHA. Derin git-ağaç
  // doğrulaması Workspace'in `restoreGitWorktreeWorkspace` katmanındadır
  // (spec 113: SessionManager/store Git iç mantığını bilmez).
  if (!isPlainObject(value)) {
    corruptFail("workspaceRecovery:shape");
  }
  if (value["schemaVersion"] !== 1) {
    corruptFail("workspaceRecovery:schema");
  }
  if (value["sessionId"] !== sessionId) {
    corruptFail("workspaceRecovery:sessionId");
  }
  if (typeof value["baseCommit"] !== "string" || (value["baseCommit"] as string) === "") {
    corruptFail("workspaceRecovery:baseCommit");
  }
  return value as unknown as WorkspaceRecoveryState;
}

// ── Depo ─────────────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  /** I/O dikişi; varsayılan `node:fs/promises` (gerçek adapter). */
  fs?: SessionStoreFs;
  /**
   * Deterministik repository kimliği (spec 208); varsayılan saf
   * `computeRepoId` (Git I/O YOK — yalnız kök yolu özetler). Testler sahte
   * enjekte edebilir.
   */
  repoIdentity?: (canonicalRepoRoot: string) => string;
}

/**
 * Kalıcı oturum deposu. `outputRoot` kullanıcı çıktısı kökü (her zaman
 * repository DIŞINDA; `~/.splash` varsayılan, spec 6). Oturumlar
 * `<outputRoot>/sessions/<session-id>/session.json` altında yaşar; repository
 * içine ASLA konmaz.
 */
export class SessionStore {
  readonly #outputRoot: string;
  readonly #fs: SessionStoreFs;
  readonly #repoIdentity: (canonicalRepoRoot: string) => string;
  readonly #sessionsDir: string;

  constructor(outputRoot: string, deps: SessionStoreDeps = {}) {
    if (typeof outputRoot !== "string" || outputRoot === "" || !path.isAbsolute(outputRoot)) {
      throw sessionError("session_operation_failed", "outputRoot must be an absolute path");
    }
    this.#outputRoot = path.resolve(outputRoot);
    this.#fs = deps.fs ?? realFs;
    this.#repoIdentity = deps.repoIdentity ?? computeRepoId;
    this.#sessionsDir = path.join(this.#outputRoot, "sessions");
  }

  /** `<outputRoot>/sessions` — tüm oturumların atal dizini (0700). */
  get sessionsDir(): string {
    return this.#sessionsDir;
  }

  /** İstenen kimliğin oturum dizini — outputRoot'tan YENİDEN hesaplanır (spec 206). */
  sessionDirFor(sessionId: string): string {
    return path.join(this.#sessionsDir, sessionId);
  }

  /** İstenen kimliğin yetkili `session.json` yolu. */
  sessionFileFor(sessionId: string): string {
    return path.join(this.#sessionDirFor(sessionId), SESSION_FILE);
  }

  #sessionDirFor(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
      throw sessionError("session_not_found");
    }
    return path.join(this.#sessionsDir, sessionId);
  }

  /**
   * Bir oturum dizinini ÖZEL (exclusive) oluşturur (spec 327). Kimlik diskte
   * zaten varken (dizin — dolayısıyla `session.json`) `session_conflict` ile
   * reddedilir; mevcut oturum ASLA üst yazılmaz (spec 324/326). Başarıda dizin
   * yolunu döndürür.
   */
  async create(sessionId: string): Promise<string> {
    if (!isSafeSessionId(sessionId)) {
      throw sessionError("session_not_found");
    }
    const dir = this.#sessionDirFor(sessionId);
    try {
      await this.#fs.mkdir(this.#sessionsDir, DIR_MODE, true);
      await this.#fs.chmod(this.#sessionsDir, DIR_MODE);
      await this.#fs.mkdir(dir, DIR_MODE, false); // exclusive: mevcut → EEXIST
      await this.#fs.chmod(dir, DIR_MODE);
    } catch (err) {
      if (errnoIs(err, "EEXIST")) {
        throw sessionError("session_conflict");
      }
      throw sessionError("session_operation_failed", err);
    }
    return dir;
  }

  /**
   * Bir oturumun yetkili durumunu `session.json`'dan okur ve DOĞRULAR
   * (spec 11/16). Güvenli olmayan id, eksik dosya, bozuk JSON ya da herhangi
   * bir yapısal uyumsuzluk → fail-closed (`session_not_found` /
   * `session_corrupt`). Başarıda TAZE (savunmacı kopya) oturum döner.
   *
   * Git çağrısı YOK (spec 5/113): repository kimliği saf `repoIdentity`
   * dikişiyle denetlenir; workspace kurtarması SessionManager'ındır.
   */
  async load(sessionId: string): Promise<PersistedSession> {
    if (!isSafeSessionId(sessionId)) {
      throw sessionError("session_not_found");
    }
    const file = this.sessionFileFor(sessionId);
    let raw: string;
    try {
      raw = await this.#fs.readFile(file);
    } catch (err) {
      // Dosya yok → henüz böyle bir oturum yok. Diğer I/O (EACCES/EIO...) →
      // yetkili durum okunamıyor → bozuk (fail-closed); errno yüzeye taşınmaz.
      if (errnoIs(err, "ENOENT")) {
        throw sessionError("session_not_found");
      }
      throw sessionError("session_corrupt", err);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw sessionError("session_corrupt", err);
    }

    return this.#validate(parsed, sessionId);
  }

  /**
   * Oturum durumunu atomik olarak diske yazar (spec 14/15/28):
   * `session.json.tmp` → 0600 → fsync → `rename` → dizin fsync (destekliyorsa).
   * Başarısızlıkta geçici iz silinir ve `session_persistence_failed` yayılır;
   * yarıda kalmış bir yetkili `session.json` BIRAKILMAZ. İzin (spec 7):
   * dizinler 0700, dosya 0600.
   */
  async save(session: PersistedSession): Promise<void> {
    const fs = this.#fs;
    if (!isSafeSessionId(session.sessionId)) {
      throw sessionError("session_operation_failed", "unsafe session id");
    }
    if (session.schemaVersion !== SESSION_SCHEMA_VERSION) {
      throw sessionError("session_operation_failed", "unsupported schema version");
    }
    const dir = this.#sessionDirFor(session.sessionId);
    const file = path.join(dir, SESSION_FILE);
    const tmp = path.join(dir, SESSION_TMP);

    try {
      await fs.mkdir(dir, DIR_MODE, true);
      await fs.chmod(this.#sessionsDir, DIR_MODE);
      await fs.chmod(dir, DIR_MODE);

      const handle = await fs.openWrite(tmp, FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(session, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);

      // Dizin fsync'i — "where supported": desteklemeyen dosya sistemlerinde
      // (ör. bazı ağ/paylaşımlı FS'ler) sessizce geçilir; dosya fsync'i +
      // rename zaten yetkili içeriği sağlamıştır.
      let dirHandle: { sync(): Promise<void>; close(): Promise<void> } | undefined;
      try {
        dirHandle = await fs.openDir(dir);
        await dirHandle.sync();
      } catch {
        // Dizin fsync'i desteklenmiyor/açılamadı — en iyi çaba; yutulur.
      } finally {
        await dirHandle?.close().catch(() => undefined);
      }
    } catch (err) {
      await fs.removeFile(tmp).catch(() => undefined);
      throw sessionError("session_persistence_failed", err);
    }
  }

  /**
   * Çözülmüş `unknown` JSON'u tam kalıcı şemaya karşı doğrular ve TAZE bir
   * `PersistedSession` kurar (spec 16). Her uyumsuzluk `session_corrupt`'a
   * düşer; hiçbir "best effort" yeniden yapı YOK. `cause` yalnız kısa, güvenli
   * neden etiketi taşır (içerik YOK — spec 12/17).
   */
  #validate(raw: unknown, requestedId: string): PersistedSession {
    if (!isPlainObject(raw)) {
      corruptFail("root:shape");
    }
    if (raw["schemaVersion"] !== SESSION_SCHEMA_VERSION) {
      corruptFail("schemaVersion");
    }

    const sessionId = raw["sessionId"];
    if (typeof sessionId !== "string" || sessionId === "") {
      corruptFail("sessionId:type");
    }
    if (sessionId !== requestedId) {
      corruptFail("sessionId:mismatch");
    }

    const repoRoot = raw["repoRoot"];
    if (typeof repoRoot !== "string" || repoRoot === "") {
      corruptFail("repoRoot:type");
    }
    const repoId = raw["repoId"];
    if (typeof repoId !== "string" || repoId === "") {
      corruptFail("repoId:type");
    }
    if (this.#repoIdentity(repoRoot) !== repoId) {
      corruptFail("repoId:mismatch");
    }

    const task = raw["task"];
    if (typeof task !== "string") {
      corruptFail("task:type");
    }

    const rules = validateRules(raw["rules"]);
    const options = validateOptions(raw["options"]);

    const editablePaths = this.#validateCanonicalPathArray(raw["editablePaths"], "editablePaths");
    const readonlyPaths = this.#validateCanonicalPathArray(raw["readonlyPaths"], "readonlyPaths");

    const workspaceRecovery = validateWorkspaceRecovery(raw["workspaceRecovery"], sessionId);

    const round = raw["round"];
    if (typeof round !== "number" || !Number.isInteger(round) || round < 0) {
      corruptFail("round:type");
    }
    const maxRoundsAcknowledged = raw["maxRoundsAcknowledged"];
    if (typeof maxRoundsAcknowledged !== "boolean") {
      corruptFail("maxRoundsAcknowledged:type");
    }

    const roundsRaw = raw["rounds"];
    if (!Array.isArray(roundsRaw)) {
      corruptFail("rounds:shape");
    }
    const rounds: PersistedRound[] = roundsRaw.map((entry) => validateRound(entry, sessionId));

    const currentCreatedPaths = this.#validateCanonicalPathArray(raw["currentCreatedPaths"], "currentCreatedPaths");

    // Tur tutarlılığı (spec 371-375): `round` = tamamlanan (üretilmiş) tur
    // sayısı; `rounds` 1..N SIKI dizilimde olmalı; `round > 0` ise bir
    // `latestWorkerResult` ZORUNLUDUR (kurtarma yeniden-uygulaması için).
    if (round !== rounds.length) {
      corruptFail("round:consistency");
    }
    for (let i = 0; i < rounds.length; i++) {
      const record = rounds[i];
      if (record === undefined || record.round !== i + 1) {
        corruptFail("rounds:sequence");
      }
    }
    if (round > 0) {
      if (raw["latestWorkerResult"] === undefined) {
        corruptFail("latestWorkerResult:missing");
      }
      if (raw["latestResult"] === undefined) {
        corruptFail("latestResult:missing");
      }
    } else if (raw["latestWorkerResult"] !== undefined) {
      // Tur 0: üretilmiş worker sonucu olamaz (tutarsız kalıcı durum).
      corruptFail("latestWorkerResult:round0");
    }

    const session: PersistedSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      repoRoot,
      repoId,
      task,
      rules,
      options,
      editablePaths,
      readonlyPaths,
      workspaceRecovery,
      round,
      maxRoundsAcknowledged,
      rounds,
      currentCreatedPaths,
    };

    // İsteğe bağlı son-durum alanları — yalnız var olduğunda (boşta `undefined`
    // değil). Her biri yapısal olarak doğrulanır (spec 317).
    if (raw["latestResult"] !== undefined) {
      session.latestResult = validateResult(raw["latestResult"], sessionId);
    }
    if (raw["latestWorkerResult"] !== undefined) {
      session.latestWorkerResult = validateWorkerResult(raw["latestWorkerResult"]);
    }
    if (raw["latestWorkspaceStateHash"] !== undefined) {
      if (typeof raw["latestWorkspaceStateHash"] !== "string" || !/^[0-9a-f]{64}$/.test(raw["latestWorkspaceStateHash"] as string)) {
        corruptFail("latestWorkspaceStateHash:format");
      }
      session.latestWorkspaceStateHash = raw["latestWorkspaceStateHash"] as string;
    }

    return session;
  }

  /** `editablePaths`/`readonlyPaths`/`currentCreatedPaths`: string dizisi + her yol kanonik/güvenli. */
  #validateCanonicalPathArray(value: unknown, field: string): string[] {
    if (!isStringArray(value)) {
      corruptFail(`${field}:shape`);
    }
    const canonical: string[] = [];
    for (const entry of value) {
      const normalized = normalizeRepoPath(entry);
      if (normalized === null) {
        corruptFail(`${field}:unsafe`);
      }
      canonical.push(normalized);
    }
    return canonical;
  }
}
