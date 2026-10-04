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
 * - **Dar silme** (Step 10): `delete` yalnız `unlink` + tek-dizin `rmdir`;
 *   commit noktası = `session.json` unlink'i (rekürsif silme YOK).
 * - **No-log** (spec 17): kalıcı içerik ASLA loglanmaz; hatalar sabit güvenli
 *   mesaj + (yalnız geliştirici kanalı) kısa neden etiketi taşır.
 * - **No-Git** (spec 5/113): SessionStore Git BİLMEZ — repository kimliği
 *   enjekte edilen saf `repoIdentity` dikişiyle doğrulanır; workspace
 *   yeniden kurulması `SessionManager`'ın (ve Workspace'in) işidir.
 *
 * I/O yalnız `SessionStoreFs` dikişinden: production `node:fs/promises`
 * (bu dosyadaki gerçek adapter), testler deterministik sahte.
 */

import { constants, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { computeRepoId } from "../workspace/git.js";
import { isSafeSessionId, isTrustedTreePath, normalizeRepoPath } from "../workspace/pathSafety.js";
import {
  LEGACY_SESSION_SCHEMA_VERSION,
  RULES_SOURCES,
  SESSION_SCHEMA_VERSION,
  SessionError,
  sessionError,
  type PersistedRound,
  type PersistedSession,
  type SessionOptions,
  type SessionDirHandle,
  type SessionReadHandle,
  type SessionStat,
  type SessionStoreFs,
  type SessionWriteHandle,
} from "./types.js";
import type { ResolvedRules, RuleDocumentSource } from "../rules/types.js";
import type {
  CompactResult,
  CompactStatus,
  RulesSource,
  SelectedContextTier,
  ValidationResult,
  WorkerEdit,
  WorkerResult,
} from "../worker/result.js";
import type { ReasoningEffort } from "../backend/InferenceBackend.js";
import type { InferenceConflict } from "../backend/InferenceCoordinator.js";
import type {
  BaseCommitIdentity,
  BaseContentValue,
  BaseTreeEntry,
  PathFingerprint,
  WorkspaceRecoveryState,
} from "../workspace/Workspace.js";

/** Oturum dizin modu (spec 7). */
const DIR_MODE = 0o700;
/** Oturum metadata dosyası modu (spec 7). */
const FILE_MODE = 0o600;
/** Yetkili kalıcı dosya adı (spec 15). */
const SESSION_FILE = "session.json";
/** Deterministik geçici yazım adı (spec 15). */
const SESSION_TMP = "session.json.tmp";
/**
 * Oturum dizini altındaki worktree alt dizini — SessionManager'ın yerleşimi
 * (`<sessionDir>/workspace`). `delete` yalnız BOŞSA `rmdir` eder (Step 10).
 */
const WORKSPACE_SUBDIR = "workspace";

/** `err` bir `NodeJS.ErrnoException` ve `code` verilen errno'ya eşit mi? */
function errnoIs(err: unknown, code: string): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === code
  );
}

/**
 * Kısa `cause` etiketi (Step 10 spec 18): yalnız adım + errno kodu — yol,
 * mesaj, içerik ASLA taşınmaz (errno mesajı mutlak özel yolu içerir).
 */
function deleteCause(step: string, err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof (err as NodeJS.ErrnoException).code === "string"
      ? (err as NodeJS.ErrnoException).code
      : "unknown";
  return `session_delete:${step}:${code}`;
}

async function lstatOptional(fs: SessionStoreFs, target: string): Promise<SessionStat | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

async function setDirectoryModeNoFollow(fs: SessionStoreFs, dir: string, mode: number): Promise<void> {
  const handle = await fs.openDir(dir);
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureDirectoryNoFollow(fs: SessionStoreFs, dir: string, mode: number): Promise<void> {
  const existing = await lstatOptional(fs, dir);
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw sessionError("session_operation_failed", "unsafe session directory");
    }
  } else {
    await fs.mkdir(dir, mode, true);
  }
  await setDirectoryModeNoFollow(fs, dir, mode);
}

async function removeStaleTmpNoFollow(fs: SessionStoreFs, tmp: string): Promise<void> {
  let existing: SessionStat | null;
  try {
    existing = await fs.lstat(tmp);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) {
      return;
    }
    throw err;
  }
  if (existing === null) {
    return;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw sessionError("session_persistence_failed", "unsafe session temp entry");
  }
  await fs.removeFile(tmp);
}

// ── Gerçek dosya sistemi adapter'i (node:fs/promises) ───────────────────────

const realFs: SessionStoreFs = {
  async mkdir(dir, mode, recursive) {
    await mkdir(dir, { recursive, mode });
  },
  async lstat(file) {
    const s = await lstat(file);
    return {
      isFile: () => s.isFile(),
      isDirectory: () => s.isDirectory(),
      isSymbolicLink: () => s.isSymbolicLink(),
      mode: s.mode,
    };
  },
  async openReadNoFollow(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      stat: async () => {
        const s = await handle.stat();
        return {
          isFile: () => s.isFile(),
          isDirectory: () => s.isDirectory(),
          isSymbolicLink: () => s.isSymbolicLink(),
          mode: s.mode,
        };
      },
      readFile: async () => (await handle.readFile("utf8")) as string,
      close: () => handle.close(),
    };
  },
  async openWrite(file, mode): Promise<SessionWriteHandle> {
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    return {
      chmod: (nextMode) => handle.chmod(nextMode),
      writeFile: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async removeFile(file) {
    try {
      await unlink(file);
    } catch (err) {
      if (!errnoIs(err, "ENOENT")) {
        throw err;
      }
    }
  },
  async removeDir(dir) {
    // Tek dizin `rmdir` — rekürsif DEĞİL; symlink'i izlemez (ENOTDIR).
    await rmdir(dir);
  },
  async openDir(dir) {
    const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      chmod: (mode) => handle.chmod(mode),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
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

function hasExactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(value, key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isShaObject(value: unknown): value is string {
  return typeof value === "string" && (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function corruptFail(tag: string): never {
  throw new SessionError("session_corrupt", undefined, { cause: `session_corrupt:${tag}` });
}

function validateRules(value: unknown): ResolvedRules {
  if (!isPlainObject(value)) {
    corruptFail("rules:shape");
  }
  if (!hasExactKeySet(value, ["source", "documents"])) {
    corruptFail("rules:keys");
  }
  if (typeof value["source"] !== "string" || !(RULES_SOURCES as readonly string[]).includes(value["source"])) {
    corruptFail("rules:source");
  }
  const documents = value["documents"];
  if (!Array.isArray(documents)) {
    corruptFail("rules:documents");
  }
  for (const [index, document] of documents.entries()) {
    if (!isPlainObject(document)) {
      corruptFail(`rules:documents[${index}]:object`);
    }
    if (!hasExactKeySet(document, ["source", "content"])) {
      corruptFail(`rules:documents[${index}]:keys`);
    }
    const source = document["source"];
    if (source !== "hook" && source !== "CLAUDE.md" && source !== "AGENTS.md") {
      corruptFail(`rules:documents[${index}]:source`);
    }
    if (typeof document["content"] !== "string") {
      corruptFail(`rules:documents[${index}]:content`);
    }
  }
  return value as unknown as ResolvedRules;
}

function validateOptions(value: unknown): SessionOptions {
  if (!isPlainObject(value)) {
    corruptFail("options:shape");
  }
  const expectedOptions = [
    ...("reasoningEffort" in value ? ["reasoningEffort"] : []),
    ...("contextTier" in value ? ["contextTier"] : []),
    ...("outputReserveTokens" in value ? ["outputReserveTokens"] : []),
  ];
  if (!hasExactKeySet(value, expectedOptions)) {
    corruptFail("options:keys");
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
  if (!hasExactKeySet(value, ["schemaVersion", "summary", "edits"])) {
    corruptFail("workerResult:keys");
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

  const edits: WorkerEdit[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < value["edits"].length; index++) {
    const edit = value["edits"][index];
    if (!isPlainObject(edit)) {
      corruptFail(`workerResult:edits[${index}]:object`);
    }
    const kind = edit["kind"];
    if (kind === "modify") {
      if (!hasExactKeySet(edit, ["kind", "path", "operations"])) {
        corruptFail(`workerResult:edits[${index}]:keys`);
      }
      const editPath = edit["path"];
      if (typeof editPath !== "string" || editPath === "") {
        corruptFail(`workerResult:edits[${index}]:path`);
      }
      if (seenPaths.has(editPath)) {
        corruptFail(`workerResult:edits[${index}]:duplicate-path`);
      }
      seenPaths.add(editPath);
      if (!Array.isArray(edit["operations"]) || edit["operations"].length === 0) {
        corruptFail(`workerResult:edits[${index}]:operations`);
      }
      const operations = edit["operations"].map((operation, operationIndex) => {
        if (!isPlainObject(operation)) {
          corruptFail(`workerResult:edits[${index}].operations[${operationIndex}]:object`);
        }
        if (!hasExactKeySet(operation, ["search", "replace"])) {
          corruptFail(`workerResult:edits[${index}].operations[${operationIndex}]:keys`);
        }
        if (typeof operation["search"] !== "string" || operation["search"] === "") {
          corruptFail(`workerResult:edits[${index}].operations[${operationIndex}]:search`);
        }
        if (typeof operation["replace"] !== "string") {
          corruptFail(`workerResult:edits[${index}].operations[${operationIndex}]:replace`);
        }
        return { search: operation["search"] as string, replace: operation["replace"] as string };
      });
      edits.push({ kind: "modify", path: editPath, operations });
    } else if (kind === "create") {
      if (!hasExactKeySet(edit, ["kind", "path", "content"])) {
        corruptFail(`workerResult:edits[${index}]:keys`);
      }
      const editPath = edit["path"];
      if (typeof editPath !== "string" || editPath === "") {
        corruptFail(`workerResult:edits[${index}]:path`);
      }
      if (seenPaths.has(editPath)) {
        corruptFail(`workerResult:edits[${index}]:duplicate-path`);
      }
      seenPaths.add(editPath);
      if (typeof edit["content"] !== "string") {
        corruptFail(`workerResult:edits[${index}]:content`);
      }
      edits.push({ kind: "create", path: editPath, content: edit["content"] as string });
    } else if (kind === "delete") {
      if (!hasExactKeySet(edit, ["kind", "path"])) {
        corruptFail(`workerResult:edits[${index}]:keys`);
      }
      const editPath = edit["path"];
      if (typeof editPath !== "string" || editPath === "") {
        corruptFail(`workerResult:edits[${index}]:path`);
      }
      if (seenPaths.has(editPath)) {
        corruptFail(`workerResult:edits[${index}]:duplicate-path`);
      }
      seenPaths.add(editPath);
      edits.push({ kind: "delete", path: editPath });
    } else {
      corruptFail(`workerResult:edits[${index}]:kind`);
    }
  }

  return {
    schemaVersion: 1,
    summary: (value["summary"] as string).trim(),
    edits,
  };
}

function validateValidation(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    corruptFail("validation:shape");
  }
  if (!hasExactKeySet(value, ["editsRequested", "editsApplied", "rejected"])) {
    corruptFail("validation:keys");
  }
  if (!isNonNegativeInteger(value["editsRequested"]) || !isNonNegativeInteger(value["editsApplied"])) {
    corruptFail("validation:count");
  }
  if (!Array.isArray(value["rejected"])) {
    corruptFail("validation:rejected");
  }
  const rejected = (value["rejected"] as unknown[]).map((entry, index) => {
    if (!isPlainObject(entry)) {
      corruptFail(`validation:rejected[${index}]:object`);
    }
    if (!hasExactKeySet(entry, ["file", "edit", "reason"])) {
      corruptFail(`validation:rejected[${index}]:keys`);
    }
    if (typeof entry["file"] !== "string" || entry["file"] === "") {
      corruptFail(`validation:rejected[${index}]:file`);
    }
    if (!isNonNegativeInteger(entry["edit"])) {
      corruptFail(`validation:rejected[${index}]:edit`);
    }
    if (typeof entry["reason"] !== "string") {
      corruptFail(`validation:rejected[${index}]:reason`);
    }
    return {
      file: entry["file"] as string,
      edit: entry["edit"] as number,
      reason: entry["reason"] as string,
    };
  });
  return {
    editsRequested: value["editsRequested"] as number,
    editsApplied: value["editsApplied"] as number,
    rejected,
  };
}

function validateContextMetadata(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeySet(value, ["runtimeMaxTokens", "inputTokens", "outputReserveTokens", "selectedContextTier", "truncatedReadonlyContext"])) {
    corruptFail("result:context");
  }
  if (!isNonNegativeInteger(value["runtimeMaxTokens"]) || !isNonNegativeInteger(value["inputTokens"]) || !isNonNegativeInteger(value["outputReserveTokens"])) {
    corruptFail("result:context-tokens");
  }
  if (!isContextTier(value["selectedContextTier"])) {
    corruptFail("result:context-tier");
  }
  if (typeof value["truncatedReadonlyContext"] !== "boolean") {
    corruptFail("result:context-truncated");
  }
}

function validateDiffStats(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeySet(value, ["files", "insertions", "deletions"])) {
    corruptFail("result:diffStats");
  }
  if (!isNonNegativeInteger(value["files"]) || !isNonNegativeInteger(value["insertions"]) || !isNonNegativeInteger(value["deletions"])) {
    corruptFail("result:diffStats-values");
  }
}

function validateUsage(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeySet(value, ["in", "out"])) {
    corruptFail("result:usage");
  }
  if (!isNonNegativeInteger(value["in"]) || !isNonNegativeInteger(value["out"])) {
    corruptFail("result:usage-values");
  }
}

function validateSplitHint(value: unknown): void {
  if (!isPlainObject(value)) {
    corruptFail("result:splitHint");
  }
  const withoutGroups = ["availableMaxTokens", "outputReserveTokens", "pressureFiles", "requiredInputTokens"];
  const withGroups = ["availableMaxTokens", "outputReserveTokens", "pressureFiles", "requiredInputTokens", "suggestedGroups"];
  if (!hasExactKeySet(value, withoutGroups) && !hasExactKeySet(value, withGroups)) {
    corruptFail("result:splitHint-keys");
  }
  if (!isNonNegativeInteger(value["requiredInputTokens"]) || !isNonNegativeInteger(value["availableMaxTokens"]) || !isNonNegativeInteger(value["outputReserveTokens"])) {
    corruptFail("result:splitHint-tokens");
  }
  if (!isStringArray(value["pressureFiles"])) {
    corruptFail("result:splitHint-pressureFiles");
  }
  if (Object.hasOwn(value, "suggestedGroups")) {
    if (!Array.isArray(value["suggestedGroups"])) {
      corruptFail("result:splitHint-suggestedGroups");
    }
    for (const group of value["suggestedGroups"] as unknown[]) {
      if (!isStringArray(group)) {
        corruptFail("result:splitHint-suggestedGroup");
      }
    }
  }
}

function validateInferenceMetadata(value: unknown): void {
  if (!isPlainObject(value) || !hasExactKeySet(value, ["conflict"])) {
    corruptFail("result:inference");
  }
  const conflict = value["conflict"] as InferenceConflict;
  if (conflict !== "splash" && conflict !== "mlx" && conflict !== "ollama" && conflict !== "unknown") {
    corruptFail("result:inference-conflict");
  }
}

function validateResult(value: unknown, sessionId: string, expectedRound?: number): CompactResult {
  if (!isPlainObject(value)) {
    corruptFail("result:shape");
  }
  if (value["sessionId"] !== sessionId) {
    corruptFail("result:sessionId");
  }
  if (!isPositiveInteger(value["round"])) {
    corruptFail("result:round");
  }
  if (expectedRound !== undefined && value["round"] !== expectedRound) {
    corruptFail("result:round-mismatch");
  }
  if (typeof value["status"] !== "string" || !isCompactStatus(value["status"])) {
    corruptFail("result:status");
  }
  if (!isString(value["rulesSource"]) || !(RULES_SOURCES as readonly string[]).includes(value["rulesSource"])) {
    corruptFail("result:rulesSource");
  }
  if (!isStringArray(value["warnings"])) {
    corruptFail("result:warnings");
  }
  if (typeof value["summary"] !== "string") {
    corruptFail("result:summary");
  }
  if (!isStringArray(value["filesChanged"])) {
    corruptFail("result:filesChanged");
  }
  validateContextMetadata(value["context"]);
  validateDiffStats(value["diffStats"]);
  validateValidation(value["validation"]);
  validateUsage(value["usage"]);

  const baseStatus = value["baseStatus"];
  if (baseStatus !== "fresh" && baseStatus !== "stale") {
    corruptFail("result:baseStatus");
  }
  const hasStaleFiles = Object.hasOwn(value, "staleFiles");
  if (baseStatus === "stale" && !hasStaleFiles) {
    corruptFail("result:staleFiles-missing");
  }
  if (baseStatus === "fresh" && hasStaleFiles) {
    corruptFail("result:staleFiles-forbidden");
  }
  if (hasStaleFiles && !isStringArray(value["staleFiles"])) {
    corruptFail("result:staleFiles");
  }

  const status = value["status"] as CompactStatus;
  if (status === "stale_base" && baseStatus !== "stale") {
    corruptFail("result:stale-base-status");
  }
  if ((status === "needs_split" || status === "inference_busy") && baseStatus !== "fresh") {
    corruptFail("result:pre-inference-base-status");
  }

  const commonKeys = ["sessionId", "round", "status", "rulesSource", "context", "warnings", "baseStatus"];
  const outcomeKeys = ["summary", "filesChanged", "diffStats", "validation", "usage"];
  const expectedKeys = [
    ...commonKeys,
    ...(baseStatus === "stale" ? ["staleFiles"] : []),
    ...outcomeKeys,
    ...(status === "needs_split" ? ["splitHint"] : []),
    ...(status === "inference_busy" ? ["inference"] : []),
  ];
  if (!hasExactKeySet(value, expectedKeys)) {
    corruptFail("result:keys");
  }

  if (status === "needs_split") {
    validateSplitHint(value["splitHint"]);
  }
  if (status === "inference_busy") {
    validateInferenceMetadata(value["inference"]);
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
  const hasFeedback = Object.hasOwn(value, "feedback");
  if (!hasExactKeySet(value, hasFeedback ? ["round", "feedback", "workerResult", "validation", "result"] : ["round", "workerResult", "validation", "result"])) {
    corruptFail("round:keys");
  }
  if (!isPositiveInteger(value["round"])) {
    corruptFail("round:round");
  }
  // 1. turda `feedback` İSTEĞE BAĞLIDIR: `splash_task` ile üretilen 1. tur
  // onu taşımaz, ama ilk çağrısı `needs_split`/`inference_busy` dönen (tur 0
  // kalan) oturumun 1. turunu `splash_refine` üretir ve kayıt o turun
  // geri bildirimini MEŞRU olarak taşır. Bunu reddetmek, restart sonrası
  // oturumu kalıcı `session_corrupt` yapardı. `round > 1` zorunluluğu aynen.
  if (value["round"] > 1 && !hasFeedback) {
    corruptFail("round:refine-feedback-missing");
  }
  if (hasFeedback && typeof value["feedback"] !== "string") {
    corruptFail("round:feedback");
  }
  const workerResult = validateWorkerResult(value["workerResult"]);
  const validation = validateValidation(value["validation"]);
  const result = validateResult(value["result"], sessionId, value["round"]);
  if (result.round !== value["round"]) {
    corruptFail("round:consistency");
  }
  const round: PersistedRound = {
    round: value["round"] as number,
    workerResult,
    validation,
    result,
  };
  if (hasFeedback) {
    round.feedback = value["feedback"] as string;
  }
  return round;
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function validateCanonicalRepoPath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    corruptFail(`${field}:type`);
  }
  const normalized = normalizeRepoPath(value);
  if (normalized === null) {
    corruptFail(`${field}:unsafe`);
  }
  return normalized;
}

/**
 * Güvenli (KENDİ-yakaladığı) git-tree yoluna YAPISEL doğrulama — Step 9
 * audit düzeltme A. `workspaceRecovery.basePaths` (tam `git ls-tree -r -z`
 * haritası) ve `immutableBaseEntries`'in `path` alanları KULLANICI/WORKER
 * girdisi DEĞİLDİR; bunlar için `normalizeRepoPath`'ın karakter-kümesi
 * kuralı (backslash'ı her yerde red) POSIX'te backslash'li dosya adını
 * takip EDEN dürüst repository'ların oturumlarını kalıcı `session_corrupt`
 * yapardı (git: `ls-tree` aynen basar, `mktree` birebir aynı `tree`
 * SHA'sını yeniden kurar — ölçüldü).
 *
 * Yapısal kural yalnızca repository dışına kaçış ya da `.git` yönetim
 * alanı müdahalesi potansiyeli taşıyan formları reddeder (boş, NUL,
 * mutlak, `..` bileşeni, tam `.git` bileşeni — bkz. `isTrustedTreePath`):
 * değer AYNEN döner, alias normalizasyonu YOK (sessiz yeniden yazım
 * fail-closed disiplinine aykırı).
 *
 * Güvenilmez (seçili/worker) yollar STRICT küme kuralında kalır
 * (`validateCanonicalRepoPath`): `editablePaths`, `readonlyPaths`,
 * `baseFingerprints`, `baseContents`, `currentCreatedPaths` — iki güven
 * alanı, iki kural.
 */
function validateTrustedTreePath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    corruptFail(`${field}:type`);
  }
  if (!isTrustedTreePath(value)) {
    corruptFail(`${field}:path-unsafe`);
  }
  return value;
}

/**
 * Canlı-ölçüm sentinel'inin modu (`ContextAssembler.SYMLINKED_ANCESTOR_FINGERPRINT`
 * — atal symlink sürüklenmesi). YALNIZ canlı ölçümde üretilir; kalıcı bir
 * TABAN parmak izinde ASLA geçerli değildir: kabul edilseydi sentinel'e eşit
 * bir "taban" (tamper) atal-symlink sürüklenmesini `fresh` gösterirdi.
 * (Dikiş: `test/session-store.test.ts` değeri üretim sabitinden kurar — iki
 * taraf ayrışırsa test kırmızıya düşer.)
 */
const LIVE_SENTINEL_MODE = "symlinked-ancestor";

function validatePathFingerprint(value: unknown, field: string): PathFingerprint {
  if (!isPlainObject(value)) {
    corruptFail(`${field}:object`);
  }
  if (value["exists"] === false) {
    if (!hasExactKeySet(value, ["exists"])) {
      corruptFail(`${field}:absent-keys`);
    }
    return { exists: false };
  }
  if (value["exists"] !== true) {
    corruptFail(`${field}:exists`);
  }
  const hasContent = Object.hasOwn(value, "contentSha256");
  if (!hasExactKeySet(value, hasContent ? ["exists", "type", "mode", "contentSha256"] : ["exists", "type", "mode"])) {
    corruptFail(`${field}:keys`);
  }
  const type = value["type"];
  if (type !== "file" && type !== "symlink" && type !== "directory" && type !== "other") {
    corruptFail(`${field}:type`);
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || mode === "") {
    corruptFail(`${field}:mode`);
  }
  if (mode === LIVE_SENTINEL_MODE) {
    corruptFail(`${field}:mode-live-sentinel`);
  }
  if (type === "file" || type === "symlink") {
    if (!isSha256Hex(value["contentSha256"])) {
      corruptFail(`${field}:content`);
    }
    return { exists: true, type, mode, contentSha256: value["contentSha256"] as string };
  }
  if (hasContent) {
    corruptFail(`${field}:content-forbidden`);
  }
  return { exists: true, type, mode };
}

function validateBaseContentValue(value: unknown, field: string): BaseContentValue {
  if (!isPlainObject(value)) {
    corruptFail(`${field}:object`);
  }
  const type = value["type"];
  if (type === "file") {
    if (!hasExactKeySet(value, ["type", "base64"]) || !isBase64(value["base64"])) {
      corruptFail(`${field}:file`);
    }
    return { type: "file", base64: value["base64"] as string };
  }
  if (type === "symlink") {
    if (!hasExactKeySet(value, ["type", "target"]) || typeof value["target"] !== "string") {
      corruptFail(`${field}:symlink`);
    }
    return { type: "symlink", target: value["target"] as string };
  }
  if (type === "absent") {
    if (!hasExactKeySet(value, ["type"])) {
      corruptFail(`${field}:absent`);
    }
    return { type: "absent" };
  }
  corruptFail(`${field}:type`);
}

function validateBaseTreeEntry(value: unknown, field: string): BaseTreeEntry {
  if (!isPlainObject(value)) {
    corruptFail(`${field}:object`);
  }
  const hasChildren = Object.hasOwn(value, "children");
  if (!hasExactKeySet(value, hasChildren ? ["mode", "oid", "path", "children"] : ["mode", "oid", "path"])) {
    corruptFail(`${field}:keys`);
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || mode === "") {
    corruptFail(`${field}:mode`);
  }
  if (!isShaObject(value["oid"])) {
    corruptFail(`${field}:oid`);
  }
  const entryPath = value["path"];
  if (typeof entryPath !== "string" || entryPath === "") {
    corruptFail(`${field}:path`);
  }
  // Self-captured ağaç girişi → yapısal güven alanı (audit düzeltme A):
  // backslash'li yasal ad kabul; yalnız kaçış/`.git` formları red (bkz.
  // `validateTrustedTreePath` dokümanı).
  if (!isTrustedTreePath(entryPath)) {
    corruptFail(`${field}:path-unsafe`);
  }
  if (mode === "040000") {
    if (!hasChildren || !Array.isArray(value["children"])) {
      corruptFail(`${field}:children-required`);
    }
    const children = (value["children"] as unknown[]).map((child, index) =>
      validateBaseTreeEntry(child, `${field}.children[${index}]`),
    );
    return { mode, oid: value["oid"] as string, path: entryPath, children };
  }
  if (hasChildren) {
    corruptFail(`${field}:children-forbidden`);
  }
  return { mode, oid: value["oid"] as string, path: entryPath };
}

function validateBaseCommitIdentity(value: unknown): BaseCommitIdentity {
  if (
    !isPlainObject(value) ||
    !hasExactKeySet(value, [
      "tree",
      "parents",
      "authorName",
      "authorEmail",
      "authorDate",
      "committerName",
      "committerEmail",
      "committerDate",
      "message",
    ])
  ) {
    corruptFail("workspaceRecovery:baseCommitIdentity");
  }
  if (!isShaObject(value["tree"]) || !Array.isArray(value["parents"]) || (value["parents"] as unknown[]).some((entry) => !isShaObject(entry))) {
    corruptFail("workspaceRecovery:baseCommitIdentity-oids");
  }
  // Açık çalışma-zamanı tip denetimi KAST'tan ÖNCE (spec 16): string OLMAYAN
  // kalıcı değer (123 / null / false / [] / {}) typed state olamaz. Yalnız
  // `=== ""` denetimi yetmez (`null === ""` false) — önce TİP denetlenir,
  // sonra boşluk; altı kimlik alanı için ikisi de zorunlu. Neden etiketi
  // kısa + alan bazlı kalır; public mesaj sabit güvenli metindir (spec 17 —
  // kalıcı içerik ASLA mesajda YOK).
  for (const field of ["authorName", "authorEmail", "authorDate", "committerName", "committerEmail", "committerDate"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue === "") {
      corruptFail(`workspaceRecovery:baseCommitIdentity:${field}`);
    }
  }
  // `message` BOŞ olabılır (Git commit sözleşmesi/parser boş mesaj kabul
  // eder) ama her zaman string olmalıdır.
  if (typeof value["message"] !== "string") {
    corruptFail("workspaceRecovery:baseCommitIdentity:message");
  }
  const identity: BaseCommitIdentity = {
    tree: value["tree"] as string,
    parents: [...(value["parents"] as string[])],
    authorName: value["authorName"] as string,
    authorEmail: value["authorEmail"] as string,
    authorDate: value["authorDate"] as string,
    committerName: value["committerName"] as string,
    committerEmail: value["committerEmail"] as string,
    committerDate: value["committerDate"] as string,
    message: value["message"] as string,
  };
  return identity;
}

function validateStringTupleArray(value: unknown, field: string): Array<readonly [string, string]> {
  if (!Array.isArray(value)) {
    corruptFail(`${field}:array`);
  }
  return (value as unknown[]).map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      corruptFail(`${field}[${index}]:tuple`);
    }
    return [entry[0], entry[1]] as const;
  });
}

/**
 * K1 `liveBaseFingerprints` (v2) fail-closed doğrulaması: `[yol, parmak izi]`
 * dizisi; yol STRICT kanonik (güvenilmez seçili yol), parmak izi
 * `validatePathFingerprint` (canlı sentinel modu RED — tamper atal-symlink
 * sürüklenmesini `fresh` gösteremez); yol kümesi düzenlenebilir yollarla
 * BİREBİR (yinelenen/eksik/fazla RED — eksik bir yol stale denetiminde
 * sessizce atlanırdı).
 */
function validateLiveBaseFingerprints(
  value: unknown,
  editablePaths: readonly string[],
): Array<readonly [string, PathFingerprint]> {
  if (!Array.isArray(value)) {
    corruptFail("liveBaseFingerprints:array");
  }
  const seen = new Set<string>();
  const out = (value as unknown[]).map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      corruptFail(`liveBaseFingerprints[${index}]`);
    }
    const canonical = validateCanonicalRepoPath(entry[0], `liveBaseFingerprints[${index}].path`);
    if (seen.has(canonical)) {
      corruptFail(`liveBaseFingerprints[${index}]:duplicate`);
    }
    seen.add(canonical);
    return [canonical, validatePathFingerprint(entry[1], `liveBaseFingerprints[${index}]`)] as const;
  });
  const editable = new Set(editablePaths);
  if (seen.size !== editable.size || [...seen].some((canonical) => !editable.has(canonical))) {
    corruptFail("liveBaseFingerprints:paths");
  }
  return out;
}

/**
 * `workspaceRecovery` durumunun fail-closed doğrulaması.
 *
 * İki güven alanı (Step 9 audit düzeltme A):
 * - **Güvenli (self-captured)**: `basePaths` (tam `git ls-tree -r -z`) +
 *   `immutableBaseEntries.path` → yapısal doğrulama (`validateTrustedTreePath`)
 *   — backslash'li yasal POSIX adları kabul; yalnız kaçış/`.git` formları red.
 * - **Güvenilmez (seçili/worker)**: `editablePaths`, `readonlyPaths`,
 *   `baseFingerprints`, `baseContents`, `currentCreatedPaths` → STRICT
 *   karakter-kümesi kuralı (`validateCanonicalRepoPath`), değer kanonikleştirilir.
 */
function validateWorkspaceRecovery(value: unknown, sessionId: string): WorkspaceRecoveryState {
  if (!isPlainObject(value)) {
    corruptFail("workspaceRecovery:shape");
  }
  if (
    !hasExactKeySet(value, [
      "schemaVersion",
      "repoRoot",
      "workspaceDir",
      "sessionId",
      "baseCommit",
      "editablePaths",
      "readonlyPaths",
      "baseFingerprints",
      "basePaths",
      "immutableBaseEntries",
      "baseCommitIdentity",
      "baseContents",
      "currentCreatedPaths",
      "recoveryStateHash",
    ])
  ) {
    corruptFail("workspaceRecovery:keys");
  }
  if (value["schemaVersion"] !== 1) {
    corruptFail("workspaceRecovery:schema");
  }
  if (value["sessionId"] !== sessionId) {
    corruptFail("workspaceRecovery:sessionId");
  }
  if (!isSafeSessionId(sessionId)) {
    corruptFail("workspaceRecovery:sessionId-unsafe");
  }
  const repoRoot = value["repoRoot"];
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    corruptFail("workspaceRecovery:repoRoot");
  }
  const workspaceDir = value["workspaceDir"];
  if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
    corruptFail("workspaceRecovery:workspaceDir");
  }
  if (!isShaObject(value["baseCommit"])) {
    corruptFail("workspaceRecovery:baseCommit");
  }
  if (!isStringArray(value["editablePaths"]) || !isStringArray(value["readonlyPaths"]) || !isStringArray(value["currentCreatedPaths"])) {
    corruptFail("workspaceRecovery:paths");
  }
  if (!Array.isArray(value["baseFingerprints"]) || !Array.isArray(value["immutableBaseEntries"]) || !Array.isArray(value["baseContents"])) {
    corruptFail("workspaceRecovery:arrays");
  }
  if (!isSha256Hex(value["recoveryStateHash"])) {
    corruptFail("workspaceRecovery:hash");
  }

  const baseFingerprints = (value["baseFingerprints"] as unknown[]).map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      corruptFail(`workspaceRecovery:baseFingerprints[${index}]`);
    }
    const fingerprint = validatePathFingerprint(entry[1], `workspaceRecovery:baseFingerprints[${index}]`);
    return [validateCanonicalRepoPath(entry[0], `workspaceRecovery:baseFingerprints[${index}].path`), fingerprint] as const;
  });
  // Self-captured tam ağaç → YAPISEL güven alanı (audit düzeltme A):
  // `validateTrustedTreePath` — karakter-kümesi kuralı, dürüst repository'daki
  // backslash'li dosya adlarını kalıcı `session_corrupt` yapıyordu.
  const basePaths = validateStringTupleArray(value["basePaths"], "workspaceRecovery:basePaths").map(
    ([gitPath, mode], index) => [validateTrustedTreePath(gitPath, `workspaceRecovery:basePaths[${index}].path`), mode] as const,
  );
  const immutableBaseEntries = (value["immutableBaseEntries"] as unknown[]).map((entry, index) =>
    validateBaseTreeEntry(entry, `workspaceRecovery:immutableBaseEntries[${index}]`),
  );
  const baseContents = (value["baseContents"] as unknown[]).map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      corruptFail(`workspaceRecovery:baseContents[${index}]`);
    }
    return [
      validateCanonicalRepoPath(entry[0], `workspaceRecovery:baseContents[${index}].path`),
      validateBaseContentValue(entry[1], `workspaceRecovery:baseContents[${index}]`),
    ] as const;
  });

  return {
    schemaVersion: 1,
    repoRoot,
    workspaceDir,
    sessionId,
    baseCommit: value["baseCommit"] as string,
    editablePaths: (value["editablePaths"] as string[]).map((entry) => validateCanonicalRepoPath(entry, "workspaceRecovery:editablePaths")),
    readonlyPaths: (value["readonlyPaths"] as string[]).map((entry) => validateCanonicalRepoPath(entry, "workspaceRecovery:readonlyPaths")),
    baseFingerprints,
    basePaths,
    immutableBaseEntries,
    baseCommitIdentity: validateBaseCommitIdentity(value["baseCommitIdentity"]),
    baseContents,
    currentCreatedPaths: (value["currentCreatedPaths"] as string[]).map((entry) =>
      validateCanonicalRepoPath(entry, "workspaceRecovery:currentCreatedPaths"),
    ),
    recoveryStateHash: value["recoveryStateHash"] as string,
  };
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
      await ensureDirectoryNoFollow(this.#fs, this.#sessionsDir, DIR_MODE);
      const existing = await lstatOptional(this.#fs, dir);
      if (existing !== null) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw sessionError("session_operation_failed", "unsafe session directory");
        }
        throw sessionError("session_conflict");
      }
      await this.#fs.mkdir(dir, DIR_MODE, false); // exclusive: mevcut → EEXIST
      await setDirectoryModeNoFollow(this.#fs, dir, DIR_MODE);
    } catch (err) {
      if (err instanceof SessionError) {
        throw err;
      }
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
    const dir = this.#sessionDirFor(sessionId);
    let dirStat: SessionStat;
    try {
      dirStat = await this.#fs.lstat(dir);
    } catch (err) {
      if (errnoIs(err, "ENOENT")) {
        throw sessionError("session_not_found");
      }
      throw sessionError("session_corrupt", err);
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw sessionError("session_corrupt", "unsafe session directory");
    }

    const file = this.sessionFileFor(sessionId);
    let raw: string;
    let handle: SessionReadHandle;
    try {
      handle = await this.#fs.openReadNoFollow(file);
    } catch (err) {
      // Dosya yok → henüz böyle bir oturum yok. Symlink (ELOOP) veya başka
      // I/O (EACCES/EIO...) → yetkili durum güvenle okunamıyor → bozuk.
      if (errnoIs(err, "ENOENT")) {
        throw sessionError("session_not_found");
      }
      throw sessionError("session_corrupt", err);
    }
    try {
      const fileStat = await handle.stat();
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw sessionError("session_corrupt", "session file is not a regular file");
      }
      raw = await handle.readFile();
    } catch (err) {
      if (err instanceof SessionError) {
        throw err;
      }
      throw sessionError("session_corrupt", err);
    } finally {
      await handle.close().catch(() => undefined);
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
    if (session.schemaVersion !== SESSION_SCHEMA_VERSION && session.schemaVersion !== LEGACY_SESSION_SCHEMA_VERSION) {
      throw sessionError("session_operation_failed", "unsupported schema version");
    }
    // K1: v2 ⇔ `liveBaseFingerprints` — load'un reddedeceği durum YAZILMAZ.
    if ((session.schemaVersion === SESSION_SCHEMA_VERSION) !== (session.liveBaseFingerprints !== undefined)) {
      throw sessionError("session_operation_failed", "schema version and live base fingerprints disagree");
    }
    const dir = this.#sessionDirFor(session.sessionId);
    const file = path.join(dir, SESSION_FILE);
    const tmp = path.join(dir, SESSION_TMP);

    try {
      await ensureDirectoryNoFollow(fs, this.#sessionsDir, DIR_MODE);
      await ensureDirectoryNoFollow(fs, dir, DIR_MODE);
      await removeStaleTmpNoFollow(fs, tmp);

      const handle = await fs.openWrite(tmp, FILE_MODE);
      try {
        await handle.chmod(FILE_MODE);
        await handle.writeFile(JSON.stringify(session, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);

      const fileStat = await fs.lstat(file);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw sessionError("session_persistence_failed", "session file is not a regular file");
      }

      // Dizin fsync'i — "where supported": desteklemeyen dosya sistemlerinde
      // (ör. bazı ağ/paylaşımlı FS'ler) sessizce geçilir; dosya fsync'i +
      // rename zaten yetkili içeriği sağlamıştır.
      let dirHandle: SessionDirHandle | undefined;
      try {
        dirHandle = await fs.openDir(dir);
        await dirHandle.sync();
      } catch {
        // Dizin fsync'i desteklenmiyor/açılamadı — en iyi çaba; yutulur.
      } finally {
        await dirHandle?.close().catch(() => undefined);
      }
    } catch (err) {
      await removeStaleTmpNoFollow(fs, tmp).catch(() => undefined);
      throw sessionError("session_persistence_failed", err);
    }
  }

  /**
   * Bir oturumun YETKİLİ kalıcı durumunu dar kapsamla siler (Step 10 spec
   * 18/19/40). Yol YALNIZ güvenilen `outputRoot` + kimlikten türetilir;
   * kalıcı hiçbir yol (ör. `workspaceRecovery.workspaceDir`) kullanılmaz.
   * İşlemler yalnız `unlink` + TEK-dizin `rmdir`'dir — REKÜRSİF silme YOK,
   * `rm -rf` YOK; `<outputRoot>/patches/...` bu fonksiyonun hiç dokunmadığı
   * yerdedir (export edilen patch KALIR).
   *
   * Sıra:
   * 1. Güvensiz kimlik → `session_not_found` (load/create ile tutarlı; fs YOK).
   * 2. `sessions` / `sessions/<id>` lstat: yok → idempotent dönüş; symlink ya
   *    da dizin-dışı → `session_operation_failed` (hedefe DOKUNULMAZ).
   * 3. `session.json` lstat: yok → zaten silinmiş; symlink/düzenli-dışı →
   *    red (hiçbir şey silinmez); aksi → `unlink`. Hata → durum AYNEN kalır.
   *    **= COMMIT NOKTASI**: yetkili durumun mantıksal silinmesi budur.
   * 4. Commit SONRASI best-effort (hiçbir hata dışarı atılmaz): yalnız DÜZENLİ
   *    `session.json.tmp` unlink; `workspace` ve oturum dizini tek-dizin
   *    `rmdir` (beklenmeyen girdi → ENOTEMPTY → zararsız dizin KALIR;
   *    geniş silme yerine bu tercih edilir). `sessions` atası SİLİNMEZ —
   *    paylaşılan atadır; başka oturumun eşzamanlı `create`'i
   *    `ensureDirectory(sessions)` ile `mkdir(dir)` arasında olabilir.
   *
   * Threat Model A (Step 9, değişmedi): statik symlink savunması vardır
   * (symlink'li `sessions`, oturum dizini ya da `session.json` reddedilir);
   * aynı-kullanıcının AKTİF ata-dizin yarışı (lstat ile unlink arasında
   * yol bileşeninin değiştirilmesi) kabul edilmiş LOW risktir —
   * `openat`/`openat2` ya da native binding KULLANILMAZ.
   */
  async delete(sessionId: string): Promise<void> {
    if (!isSafeSessionId(sessionId)) {
      throw sessionError("session_not_found");
    }
    const fs = this.#fs;
    const dir = this.#sessionDirFor(sessionId);

    let sessionsStat: SessionStat | null;
    try {
      sessionsStat = await lstatOptional(fs, this.#sessionsDir);
    } catch (err) {
      throw sessionError("session_operation_failed", deleteCause("lstat-sessions", err));
    }
    if (sessionsStat === null) {
      return; // silinecek bir şey yok — idempotent
    }
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
      throw sessionError("session_operation_failed", "unsafe sessions directory");
    }

    let dirStat: SessionStat | null;
    try {
      dirStat = await lstatOptional(fs, dir);
    } catch (err) {
      throw sessionError("session_operation_failed", deleteCause("lstat-session-dir", err));
    }
    if (dirStat === null) {
      return; // idempotent
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw sessionError("session_operation_failed", "unsafe session directory");
    }

    const file = path.join(dir, SESSION_FILE);
    let fileStat: SessionStat | null;
    try {
      fileStat = await lstatOptional(fs, file);
    } catch (err) {
      throw sessionError("session_operation_failed", deleteCause("lstat-session-file", err));
    }
    if (fileStat !== null) {
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw sessionError("session_operation_failed", "unsafe session file");
      }
      try {
        await fs.removeFile(file); // COMMIT NOKTASI
      } catch (err) {
        throw sessionError("session_operation_failed", deleteCause("unlink-session-file", err));
      }
    }

    await this.#cleanupAfterDelete(dir);
  }

  /**
   * `delete` commit noktası SONRASI dar + best-effort temizlik (spec 19):
   * yetkili durum zaten silindi — kozmetik bir `rmdir` hatası kapatmayı
   * başarısız saydırmaz. Hiçbir hata dışarı atılmaz; rekürsif işlem YOK.
   */
  async #cleanupAfterDelete(dir: string): Promise<void> {
    const fs = this.#fs;
    try {
      const tmp = path.join(dir, SESSION_TMP);
      const tmpStat = await fs.lstat(tmp);
      // Yalnız DÜZENLİ dosya; symlink/dizin/diğer → olduğu gibi bırakılır.
      if (!tmpStat.isSymbolicLink() && tmpStat.isFile()) {
        await fs.removeFile(tmp);
      }
    } catch {
      // Yok (ENOENT) ya da silinemedi — yetkili değil; yutulur.
    }
    for (const target of [path.join(dir, WORKSPACE_SUBDIR), dir]) {
      try {
        await fs.removeDir(target);
      } catch {
        // ENOENT / ENOTEMPTY / ENOTDIR / diğer — zararsız dizin kalır; yutulur.
      }
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
    const requiredKeys = [
      "schemaVersion",
      "sessionId",
      "repoRoot",
      "repoId",
      "task",
      "rules",
      "options",
      "editablePaths",
      "readonlyPaths",
      "workspaceRecovery",
      "round",
      "maxRoundsAcknowledged",
      "rounds",
      "currentCreatedPaths",
    ];
    // K1: v2 `liveBaseFingerprints`'i ZORUNLU taşır; v1 (eski, okunabilir)
    // taşıyamaz — anahtar kümesi sürüme bağlı (fail-closed).
    const schemaVersion = raw["schemaVersion"];
    if (schemaVersion !== SESSION_SCHEMA_VERSION && schemaVersion !== LEGACY_SESSION_SCHEMA_VERSION) {
      corruptFail("schemaVersion");
    }
    const expectedKeys = [
      ...requiredKeys,
      ...(schemaVersion === SESSION_SCHEMA_VERSION ? ["liveBaseFingerprints"] : []),
      ...(raw["latestResult"] !== undefined ? ["latestResult"] : []),
      ...(raw["latestWorkerResult"] !== undefined ? ["latestWorkerResult"] : []),
      ...(raw["latestWorkspaceStateHash"] !== undefined ? ["latestWorkspaceStateHash"] : []),
    ];
    if (!hasExactKeySet(raw, expectedKeys)) {
      corruptFail("root:keys");
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
    // F-2: repo kökü mutlak olmalı (bağlamsal/özel kök — bozuk durum).
    if (!path.isAbsolute(repoRoot)) {
      corruptFail("repoRoot:not-absolute");
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
    // F-2: kurtarma durumu BİREBİR aynı repo kökünü taşımalı — oturum köküyle
    // ayrışan çift, kurtarma sırasında yanlış repo'ya işletebilir (bozuk durum).
    // Mesaj/yol YOK: yalnız neden etiketi (spec 12/17).
    if (workspaceRecovery.repoRoot !== repoRoot) {
      corruptFail("workspaceRecovery:repoRoot-mismatch");
    }
    const liveBaseFingerprints =
      schemaVersion === SESSION_SCHEMA_VERSION
        ? validateLiveBaseFingerprints(raw["liveBaseFingerprints"], workspaceRecovery.editablePaths)
        : undefined;

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
      schemaVersion,
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
    if (liveBaseFingerprints !== undefined) {
      session.liveBaseFingerprints = liveBaseFingerprints;
    }

    // İsteğe bağlı son-durum alanları — yalnız var olduğunda (boşta `undefined`
    // değil). Her biri yapısal olarak doğrulanır (spec 317).
    if (raw["latestResult"] !== undefined) {
      session.latestResult = validateResult(raw["latestResult"], sessionId, round > 0 ? round : undefined);
    }
    if (raw["latestWorkerResult"] !== undefined) {
      session.latestWorkerResult = validateWorkerResult(raw["latestWorkerResult"]);
    }
    if (raw["latestWorkspaceStateHash"] !== undefined) {
      if (!isSha256Hex(raw["latestWorkspaceStateHash"])) {
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
