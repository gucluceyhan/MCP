/**
 * Step 9: kalıcı oturum yaşam döngüsü — `SessionManager` (DESIGN.md §2.2,
 * spec 1-13, 29-79, 103-135, 255-272).
 *
 * Bu sınıf, bir Splash oturumunun TEK yetkili yaşam döngüsü sahibidir:
 * create → load → restore → stale denetimi → max-round guard → rafine turu →
 * kalıcılık (transactional) → RAM önbellek. Geçici in-memory `ActiveTask`
 * kayıt defteri BU SİNF'IN `#cache`'i ile değiştirildi (spec 4: iki rakip
 * kayıt defteri YOK).
 *
 * SORUMLULUK SINIRI (spec 5): SAHİP OLDUKLARI: create / load / restore /
 * aynı-oturum kilit (FIFO) / refine / diff / close / persist / stale
 * denetimi / tur sayısı / geçmiş sınıflandırması / salt-okunur kümesi /
 * max-round guard / shutdown ayrılması. SAHİP OLMADIKLARI: model implementasyonu, prompt inşası, patch
 * semantik doğrulaması, Git detayları, kural keşfi — bunlar mevcut
 * bileşenlerde (ContextAssembler / Workspace / RulesResolver / Coordinator)
 * kalır ve injected olarak tüketilir.
 *
 * Step 10 (DESIGN.md §3, §7.5, §7.6): aynı yaşam döngüsü sahibi iki işlemi
 * daha yürütür — `diff` (salt-inceleme: kilit + RAM/kurtarma → workspace
 * diff/stat; inference/kalıcılık/durum mutasyonu YOK) ve `close` (kilit +
 * RAM/kurtarma → refine ile AYNI stale denetimi → metadata → patch export →
 * workspace imhası → yetkili durum silme → RAM silme). Stale taban close'u
 * ENGELLEMEZ; Splash patch'i ana checkout'a ASLA uygulamaz. Git export
 * mantığı `Workspace`'te, dar silme `SessionStore`'da kalır.
 *
 * Otorite (spec 8): DISK = yetkili kaynak; RAM = aktif önbellek. Süreç
 * yeniden başlatması bir açık oturumu GEÇERSİZ KILMAZ — oturum yalnız diski
 * doğrulanabilir + yeniden kurulabilir olduğunda geçerlidir.
 *
 * Güvenlik (spec 12/17): `SessionError.message` SABİТ + KISAdır; kalıcı
 * içerik ASLA loglanmaz; teknik detay (`cause`) yalnız geliştirici kanalıdır.
 */

import { randomUUID } from "node:crypto";
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";

import { computeRepoId, discoverRepoRoot } from "../workspace/git.js";
import { canonicalizeOutside, isSafeSessionId, normalizeRepoPath } from "../workspace/pathSafety.js";
import type { SplashConfig } from "../config.js";
import type { InferenceUsage, ReasoningEffort } from "../backend/InferenceBackend.js";
import { BackendError } from "../backend/errors.js";
import { CoordinatorError } from "../backend/InferenceCoordinator.js";
import type { InferenceConflict } from "../backend/InferenceCoordinator.js";
import { WorkerContract } from "../worker/WorkerContract.js";
import {
  WorkerContractError,
  type CompactContextMetadata,
  type CompactResult,
  type DiffStats,
  type RulesSource,
  type SelectedContextTier,
  type ValidationResult,
} from "../worker/result.js";
import { redactText } from "../context/redact.js";
import {
  ContextAssemblyError,
  type AssembledContext,
  type ContextAssemblyInput,
  type LiveBaseCaptureInput,
  type LiveBaseState,
} from "../context/types.js";
import { SplashTaskError } from "../task/errors.js";
import {
  RULES_RESOLUTION_FAILED_MESSAGE,
  RulesResolutionError,
  type ResolvedRules,
  type RulesResolverLike,
} from "../rules/types.js";
import { RulesResolver } from "../rules/RulesResolver.js";
import type {
  Workspace,
  WorkspaceCreateInput,
  WorkspaceRecoveryState,
} from "../workspace/Workspace.js";
import { WorkspaceError } from "../workspace/Workspace.js";
import { createGitWorktreeWorkspace, restoreGitWorktreeWorkspace } from "../workspace/GitWorktreeWorkspace.js";

import {
  MAX_ROUNDS_WARNING,
  SESSION_SCHEMA_VERSION,
  STALE_BASE_SUMMARY,
  SessionError,
  sessionError,
  type PersistedRound,
  type PersistedSession,
  type SessionOptions,
} from "./types.js";
import { SessionStore } from "./SessionStore.js";
import { buildHistory } from "./history.js";
import { decideStale } from "./stale.js";
import {
  DefaultRoundRunner,
  type RoundCoordinator,
  type RoundContextAssembler,
  type RoundInput,
  type RoundOutcome,
  type RoundWorkerContract,
} from "./RoundRunner.js";

// ── Girdi sözleşmeleri ───────────────────────────────────────────────────────

/** Bir `splash_task` çağrısının girdisi (MCP katmanı şema doğruladı). */
export interface SplashTaskRequest {
  /** Orijinal görev metni — assembler redakte eder; worker'a redakte EDİLMİŞ form gider. */
  task: string;
  /** Repository-göreceli düzenlenebilir yollar; boş dizi geçerli (create-only). */
  files: readonly string[];
  /** Açık bağlam kademesi (kanonik sembolik değer); verilmediyse adaptif. */
  contextTier?: SelectedContextTier;
  /** Açık çıkış payı (token); verilmediyse adaptif müzakere. */
  outputReserveTokens?: number;
  /** Kullanıcı vermediyse dispatch seçeneklerinde TAMAMEN YOK. */
  reasoningEffort?: ReasoningEffort;
  /** Session/hook kuralları (Step 8) — repository fallback'i tetikleyebilir. */
  rules?: string;
  /** MCP SDK'nın istek sinyali. */
  signal?: AbortSignal;
}

/** Bir `splash_refine` çağrısının girdisi (spec 19-20, 245-248). */
export interface SplashRefineRequest {
  /** Açık oturumun kimliği (yalnız bu — oturum kendi kök/kurallarını pin'ledi). */
  sessionId: string;
  /** Düzeltme geri bildirimi — trim ile boşluk-tek denetimi; orijinal metin pin'lenir. */
  feedback: string;
  /** İSTEKLİ açık repository-göreceli salt-okunur referans yolları (glob/dizin YOK). */
  files: readonly string[];
  /** MCP SDK'nın istek sinyali. */
  signal?: AbortSignal;
}

/**
 * Bir `splash_diff` çağrısının girdisi (Step 10 spec 4/7/8). Salt-inceleme:
 * inference / tur artışı / durum mutasyonu YOK.
 */
export interface SplashDiffRequest {
  /** Açık oturumun kimliği. */
  sessionId: string;
  /** İsteğe bağlı repository-göreceli LİTERAL yol filtresi (boş = filtresiz). */
  files?: readonly string[];
  /** `true` → yalnız yapısal istatistik (kaynak/diff metni YOK). */
  stat?: boolean;
}

/**
 * `splash_diff` sonucu — `mode` üzerinden ayrımlı union (spec 8/9):
 * - `diff` → base-göreceli unified diff metni (oluşturulan kodu taşıyan TEK
 *   MCP aracı — kasıtlı içerik istisnası);
 * - `stat` → yalnız files/insertions/deletions (kaynak YOK).
 */
export type SplashDiffResult =
  | { mode: "diff"; diff: string }
  | { mode: "stat"; diffStats: DiffStats };

/** Bir `splash_close` çağrısının girdisi (spec 10) — başka girdi KABUL EDİLMEZ. */
export interface SplashCloseRequest {
  /** Kapatılacak açık oturumun kimliği. */
  sessionId: string;
}

/** `splash_close` sonucunun tüm taban durumlarında ortak alanları (içerik YOK). */
interface SplashCloseCommon {
  /** Export edilen patch'in mutlak yolu (`<outputRoot>/patches/<repo-id>/<session-id>.patch`). */
  patchPath: string;
  /** Son kalıcı üretilmiş sonucun doğrulanmış değişen yolları (tur 0 → `[]`). */
  filesChanged: string[];
  /** Export'tan hemen önce canlı workspace'ten (git numstat) yapısal istatistik. */
  diffStats: DiffStats;
  /** Son kalıcı compact özet (ham worker çıktısı/geri bildirim/kural YOK). */
  summary: string;
}

/**
 * `splash_close` sonucu — taban tazeliği AYRIMLI union (`CompactResult`'taki
 * fresh/stale kalıbı): `fresh` → `staleFiles` olamaz; `stale` → ZORUNLU.
 * Stale export'u ENGELLEMEZ (spec 13); yalnız orkestratörün otomatik
 * uygulamasını yasaklar.
 */
export type SplashCloseResult = SplashCloseCommon &
  ({ baseStatus: "fresh"; staleFiles?: never } | { baseStatus: "stale"; staleFiles: string[] });

// ── Görünüm arayüzları (küçük DI; service locator YOK) ──────────────────────

/**
 * Context Assembler görünümü: `assemble` (tur bağlamı) + `captureLiveBase`
 * (stale ölçümü — strict no-follow, spec 53). Süreç-tek `ContextAssembler`
 * yapısal olarak sağlar; testler instrument edilmiş instance enjekte eder.
 */
export interface ContextAssemblerLike {
  assemble(input: ContextAssemblyInput): Promise<AssembledContext>;
  captureLiveBase(input: LiveBaseCaptureInput): Promise<LiveBaseState>;
}

/** Workspace fabrikası: üretime `createGitWorktreeWorkspace` (Step 5). */
export type WorkspaceFactory = (input: WorkspaceCreateInput) => Promise<Workspace>;

/**
 * Kalıcılık görünümü: `SessionStore` yapısal olarak sağlar; testler sahte
 * I/O (atomik roundtrip / yazım hatası / bozukluk) enjekte eder.
 */
export interface SessionStoreLike {
  /** Tüm oturumların atal dizini (`<outputRoot>/sessions`). */
  readonly sessionsDir: string;
  /** İstenen kimliğin oturum dizini. */
  sessionDirFor(sessionId: string): string;
  /** Exclusive dizin oluşturma (mevcut → `session_conflict`). */
  create(sessionId: string): Promise<string>;
  /** Yetkili durumu oku + doğrula (fail-closed; taze savunmacı kopya). */
  load(sessionId: string): Promise<PersistedSession>;
  /** Atomik yazım (tmp → fsync → rename → dizin fsync). */
  save(session: PersistedSession): Promise<void>;
  /**
   * Dar kapsamlı yetkili durum silme (Step 10 spec 18/19): yalnız `unlink` +
   * tek-dizin `rmdir`; rekürsif silme YOK. Commit noktası = `session.json`
   * unlink'i — sonrasındaki temizlik best-effort'tur, hata dışarı atılmaz.
   */
  delete(sessionId: string): Promise<void>;
}

export interface SessionManagerDeps {
  /** Ortamdan yüklenmiş yapılandırma (outputRoot, repoRoot, bütçe, maxRounds). */
  config: SplashConfig;
  /**
   * Sürecin TEK Inference Coordinator'ı (spec 4/256) — tüm task/refine
   * çağrıları bu instance'ı paylaşır; istek/session başına coordinator YOK.
   */
  coordinator: RoundCoordinator;
  /** Sürecin TEK Context Assembler'ı (Step 7+9). */
  contextAssembler: ContextAssemblerLike;
  /** Sürecin TEK Worker Contract'ı (Step 4). */
  workerContract?: RoundWorkerContract;
  /** Sürecin TEK Rules Resolver'ı (Step 8) — yalnız YENİ görev kullanır. */
  rulesResolver?: RulesResolverLike;
  /** Workspace fabrikası (varsayılan: Step 5 `createGitWorktreeWorkspace`). */
  createWorkspace?: WorkspaceFactory;
  /**
   * Worktree kurtarma (varsayılan: `restoreGitWorktreeWorkspace`). Testler
   * instrument edilmiş restorer enjekte eder.
   */
  restoreWorkspace?: (state: WorkspaceRecoveryState, options: { expectedWorkspaceDir: string }) => Promise<Workspace>;
  /**
   * Kalıcılık deposu (varsayılan: gerçek `SessionStore` —
   * `node:fs/promises`). Testler sahte `SessionStoreFs` ile kurar.
   */
  store?: SessionStoreLike;
  /**
   * Deterministik repository kimliği (spec 208; varsayılan saf
   * `computeRepoId`). Store ile AYNI fonksiyon olmalı (server aynı instance'ı
   * her ikisine bağlar; varsayılanlar aynıdır).
   */
  repoIdentity?: (canonicalRepoRoot: string) => string;
  /** Kriptografik oturum kimliği fabrikası (varsayılan: `crypto.randomUUID`). */
  newSessionId?: () => string;
  /** MCP sürecinin CWD'si — repository keşfinin başlangıç noktası. */
  processCwd?: () => string;
}

/** RAM önbellek girdisi: doğrulanmış kalıcı durum + canlı workspace. */
interface ActiveSession {
  session: PersistedSession;
  workspace: Workspace;
}

/** Test/diagnosis yüzeyi — MCP aracı YOK (spec 160: listeleme aracı yok). */
export interface ActiveSessionInfo {
  readonly sessionId: string;
  readonly round: number;
  readonly latestResult: CompactResult | undefined;
  readonly workspace: Workspace;
}

// ── Sabit güvenli metinler ───────────────────────────────────────────────────

/** `needs_split` turunun SABİТ compact özeti (spec 26/52/93). */
const NEEDS_SPLIT_SUMMARY =
  "The required context exceeds the context budget; the task was not started. Split the task into smaller file groups.";

/** `inference_busy` turunun SABİТ compact özeti (spec 37/137). */
const INFERENCE_BUSY_SUMMARY = "Inference is temporarily unavailable; no worker generation was run.";

/** `max_rounds` guardrailinin SABİТ compact özeti (spec 64). */
const MAX_ROUNDS_SUMMARY = "The maximum refinement rounds were reached; no refinement was run.";

/**
 * Kalıcı compact özeti OLMAYAN oturumun close özeti (Step 10 spec 22):
 * tur 0'da `latestResult` yoksa (ör. kalıcılık aşamaları arasında duran
 * süreç) — sabit, içeriksiz.
 */
const NO_GENERATED_RESULT_SUMMARY = "The session was closed without a generated worker result.";

/**
 * `SessionManager` yaşam döngüsü (Step 9).
 *
 * Konstrüksiyon tembel kalır (spec 18/259): I/O YAPMAZ — oturum tarama,
 * worktree kurtarma, repository açma, backend çağrısı YOK. Tümü lazy (ilk
 * tool çağrısı) ya da süreç-tek bileşenlerin kendi tembelliğindedir.
 */
export class SessionManager {
  #config: SplashConfig;
  #coordinator: RoundCoordinator;
  #contextAssembler: ContextAssemblerLike;
  #workerContract: RoundWorkerContract;
  #rulesResolver: RulesResolverLike;
  #createWorkspace: WorkspaceFactory;
  #restoreWorkspace: (state: WorkspaceRecoveryState, options: { expectedWorkspaceDir: string }) => Promise<Workspace>;
  #store: SessionStoreLike;
  #repoIdentity: (canonicalRepoRoot: string) => string;
  #newSessionId: () => string;
  #processCwd: () => string;
  #roundRunner: DefaultRoundRunner;

  /** RAM aktif önbellek (spec 159) — disk yetkili kalır. */
  #cache = new Map<string, ActiveSession>();
  /**
   * Aynı-oturum FIFO kilitleri (spec 76/78): anahtar = `session_id`
   * (nesne kimliği DEĞİL) — iki eşzamanlı çağrı (disk load tetikleyeni de
   * dahil) sıralanır. Farklı oturumlar paralel (spec 77). Step 10:
   * refine / diff / close AYNI zinciri paylaşır (`#runExclusive`).
   */
  #locks = new Map<string, Promise<void>>();
  /**
   * Şu an yürüyen (terminale ulaşmamış) task/refine/diff/close çalışmaları —
   * `dispose()` bu defteri BEKLER (spec 131: in-flight işler güvenli terminal
   * yollarına ulaşana kadar kapatım çözülmez; fire-and-forget YOK). Tek
   * kayıt yolu: `#trackInFlight`.
   */
  #inFlight = new Set<Promise<unknown>>();
  /** `dispose()` sonrası yeni task/refine/diff/close kabul edilmez (spec 128/131). */
  #disposed = false;
  /** Tek kapanış sözü — tekrarlanan `dispose()` çağrıları bunu paylaşır (S#8). */
  #disposePromise: Promise<void> | undefined;

  constructor(deps: SessionManagerDeps) {
    this.#config = deps.config;
    this.#coordinator = deps.coordinator;
    this.#contextAssembler = deps.contextAssembler;
    this.#workerContract = deps.workerContract ?? new WorkerContract();
    this.#rulesResolver = deps.rulesResolver ?? new RulesResolver();
    this.#createWorkspace = deps.createWorkspace ?? ((input) => createGitWorktreeWorkspace(input));
    this.#restoreWorkspace =
      deps.restoreWorkspace ?? ((state, options) => restoreGitWorktreeWorkspace(state, options));
    this.#repoIdentity = deps.repoIdentity ?? computeRepoId;
    this.#store = deps.store ?? new SessionStore(deps.config.outputRoot, { repoIdentity: this.#repoIdentity });
    this.#newSessionId = deps.newSessionId ?? (() => randomUUID());
    this.#processCwd = deps.processCwd ?? (() => process.cwd());
    this.#roundRunner = new DefaultRoundRunner({
      coordinator: deps.coordinator,
      contextAssembler: deps.contextAssembler,
      workerContract: this.#workerContract,
    });
  }

  /** Runtime kapatılmış mı? (dispose sonrası yeni iş reddedilir.) */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** RAM önbellekteki açık oturumlar (yalnızca test/diagnosis — spec 160). */
  activeSessions(): readonly ActiveSessionInfo[] {
    return [...this.#cache.values()].map((entry) => ({
      sessionId: entry.session.sessionId,
      round: entry.session.round,
      latestResult: entry.session.latestResult,
      workspace: entry.workspace,
    }));
  }

  // ── splash_task (1. tur) ───────────────────────────────────────────────────

  /**
   * Bir `splash_task` çağrısını uçtan uca yürütür ve KALICI oturum açar:
   *
   *   girdi → repo keşfi → outputRoot containment → kurallar (bir kez, pin)
   *   → session id → exclusive dizin → worktree → kurtarma snapshot →
   *   İLK KALICILIK (session.json) → 1. tur (RoundRunner) → tur kalıcılığı
   *   → RAM önbellek → sonuç
   *
   * İlk turun normal durumları (applied/partial/failed/needs_split/
   * inference_busy) HEPSI kalıcı oturum üretir (spec 133/329): sonuç
   * döndürülmeden ÖNCE disk commit'i tamamlanır (spec 328/336).
   * Kullanılamayacak bir sonuç üretilemeyen ilk tur arızalarında oturum +
   * workspace temizlenir (spec 132/234/439) — orfan kalıcı oturum YOK.
   */
  async createTask(request: SplashTaskRequest): Promise<CompactResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }
    // in-flight kaydı, `#disposed` denetiminden sonra SENKRON yapılır —
    // dispose, kayıttan önce araya giremez (tek iplik; yield yok).
    return this.#trackInFlight(this.#runTask(request));
  }

  /** `createTask` gövdesi — in-flight defterinde izlenir. */
  async #runTask(request: SplashTaskRequest): Promise<CompactResult> {
    // ── girdi doğrulaması (MCP şemasının derin savunması) ──────────────────
    if (typeof request.task !== "string" || request.task.trim() === "") {
      throw new SplashTaskError("invalid_input", "The task must be a non-empty string");
    }
    if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== "string")) {
      throw new SplashTaskError("invalid_input", "The files must be an array of strings");
    }
    const minReserve = this.#config.context.minOutputReserve;
    if (
      request.outputReserveTokens !== undefined &&
      (!Number.isInteger(request.outputReserveTokens) || request.outputReserveTokens < minReserve)
    ) {
      throw new SplashTaskError(
        "invalid_input",
        "The output reserve must be an integer no smaller than the minimum reserve",
      );
    }
    if (
      request.contextTier !== undefined &&
      !(["64k", "128k", "192k", "runtime_max"] as readonly string[]).includes(request.contextTier)
    ) {
      throw new SplashTaskError(
        "invalid_input",
        "The context tier must be one of: 64k, 128k, 192k, runtime_max",
      );
    }
    if (request.rules !== undefined && typeof request.rules !== "string") {
      throw new SplashTaskError("invalid_input", "The rules must be a string");
    }

    // ── repository keşfi (henüz hiçbir yazma YOK) ───────────────────────────
    const repoRoot = await discoverRepoRoot({
      cwd: this.#processCwd(),
      override: this.#config.repoRoot,
    });

    // ── outputRoot containment — session dizininden ÖNCE ───────────────────
    const canonicalOutputRoot = await canonicalizeOutside(this.#config.outputRoot, repoRoot);
    if (canonicalOutputRoot === null) {
      throw new SplashTaskError("output_root_unsafe", "The output root must be outside the repository");
    }

    // ── kurallar (BİR KERE çöz + pin — spec 22) ─────────────────────────────
    let resolvedRules: ResolvedRules;
    try {
      resolvedRules = await this.#rulesResolver.resolve({
        suppliedRules: request.rules,
        repoRoot,
      });
    } catch (err) {
      if (err instanceof RulesResolutionError) {
        throw err; // zaten güvenli: sabit mesaj, fs detayı YOK
      }
      throw new RulesResolutionError("rules_resolution_failed", RULES_RESOLUTION_FAILED_MESSAGE, { cause: err });
    }

    // ── session kimliği + çakışma (RAM ÖNCE, disk SONRA — spec 324) ─────────
    const sessionId = this.#newSessionId();
    if (!isSafeSessionId(sessionId)) {
      // Kimlik hata mesajına YANSITILMAZ (yol/kaçış taşıyabilir).
      throw new SplashTaskError("invalid_input", "The session id is not a safe identifier");
    }
    if (this.#cache.has(sessionId)) {
      throw new SessionError("session_conflict");
    }
    // Exclusive dizin (spec 327): diskte mevcutsa `session_conflict` —
    // mevcut oturum ASLA üst yazılmaz (spec 324/326).
    let sessionDir: string;
    try {
      sessionDir = await this.#store.create(sessionId);
    } catch (err) {
      if (err instanceof SessionError) {
        throw err; // conflict / operation_failed — güvenli sabit mesajlar
      }
      throw sessionError("session_operation_failed", err);
    }

    // ── workspace (Step 5; `<sessionDir>/workspace` — repo DIŞINDA) ─────────
    let workspace: Workspace | undefined;
    try {
      workspace = await this.#createWorkspace({
        repoRoot,
        workspaceDir: path.join(sessionDir, "workspace"),
        sessionId,
        editablePaths: request.files,
        readonlyPaths: [],
      });
    } catch (err) {
      // Yarım worktree'yi fabrika zaten temizler; geriye boş dizinler kalır.
      await this.#cleanupCreatedSession(workspace, sessionDir, err);
      throw err; // WorkspaceError — güvenli tip'li hata aynen yayılır
    }

    // ── kurtarma snapshot'ı (spec 112-122) ──────────────────────────────────
    let recovery: WorkspaceRecoveryState;
    try {
      recovery = await workspace.snapshotRecoveryState();
    } catch (err) {
      await this.#cleanupCreatedSession(workspace, sessionDir, err);
      throw err;
    }

    // ── İLK KALICILIK (spec 157/336): oturum kullanılır olmadan ÖNCE disk ──
    const session: PersistedSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      repoRoot,
      repoId: this.#repoIdentity(repoRoot),
      task: request.task,
      rules: resolvedRules,
      options: buildSessionOptions(request),
      editablePaths: [...workspace.editablePaths].sort(), // deterministik (spec 268)
      readonlyPaths: [],
      workspaceRecovery: recovery,
      round: 0,
      maxRoundsAcknowledged: false,
      rounds: [],
      currentCreatedPaths: [],
      // Tur 0 workspace durumu = immutable taban (spec 156): snapshot anında
      // hesaplanan hash (workspace henüz base'te) — kurtarma doğrulaması için.
      latestWorkspaceStateHash: recovery.recoveryStateHash,
    };
    try {
      await this.#store.save(session);
    } catch (err) {
      await this.#cleanupCreatedSession(workspace, sessionDir, err);
      throw err instanceof SessionError ? err : sessionError("session_persistence_failed", err);
    }

    // ── 1. tur (paylaşımlı pipeline; spec 134-136) ──────────────────────────
    let outcome: RoundOutcome;
    try {
      outcome = await this.#roundRunner.run({
        ownerId: sessionId,
        task: request.task,
        workspace,
        readonlyPaths: [],
        resolvedRules,
        rulesSoftBudget: this.#config.context.rulesSoftBudget,
        history: [], // 1. tur: geçmiş YOK (spec 67)
        tiers: this.#config.context.tiers,
        minOutputReserve: this.#config.context.minOutputReserve,
        preferredOutputReserve: this.#config.context.preferredOutputReserve,
        contextTier: request.contextTier,
        outputReserveTokens: request.outputReserveTokens,
        reasoningEffort: request.reasoningEffort,
        signal: request.signal,
      });
    } catch (err) {
      // İlk turda kullanılamayacak bir sonuç YOK → oturum + workspace
      // temizlenir (spec 132/234/439); orfan kalıcı oturum KALMAZ.
      await this.#cleanupCreatedSession(workspace, sessionDir, err);
      if (err instanceof ContextAssemblyError && err.kind === "invalid_input") {
        throw new SplashTaskError("invalid_input", err.message, { cause: err });
      }
      throw err;
    }

    const result = this.#taskRoundResult(sessionId, request, outcome);

    // ── shutdown yarışı (Step 6 garantisi korunur — spec 131) ───────────────
    if (this.#disposed) {
      await this.#cleanupCreatedSession(workspace, sessionDir, null);
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }

    // ── tur kalıcılığı (spec 133/152): disk commit → RAM commit ─────────────
    // İlk turun NORMAL durumları (applied/partial/failed/needs_split/
    // inference_busy) HEPSİ kalıcı oturum üretir: sonuç dönmeden ÖNCE
    // kalıcılık tamamlanır (spec 328/336).
    let updated: PersistedSession;
    if (outcome.kind === "generated") {
      // Yeni workspace state hash'i (spec 156): commit YENİ hash'i taşır —
      // eski (base) hash commit edilseydi kurtarma yanlış mismatch görürdü.
      // Git hatası = işletme hatası (kullanılamaz tur) → oturum temizlenir.
      let newHash: string;
      try {
        newHash = await workspace.recoveryStateHash();
      } catch (err) {
        await this.#cleanupCreatedSession(workspace, sessionDir, err);
        throw err; // WorkspaceError — güvenli tip'li hata aynen yayılır
      }
      updated = this.#commitRound(session, outcome, result, newHash);
    } else {
      // Non-generated 1. tur (needs_split/inference_busy): oturum YİNE
      // kalıcılaşır (spec 133) — tur 0 kalır, workspace state DEĞİŞMEZ
      // (base), worker sonucu YOK, base hash aynen.
      updated = { ...session, latestResult: result };
    }
    try {
      await this.#store.save(updated);
    } catch (err) {
      // İlk tur: sonuç dönemedi → orfan oturum KALMAZ (spec 132/439).
      await this.#cleanupCreatedSession(workspace, sessionDir, err);
      throw err instanceof SessionError ? err : sessionError("session_persistence_failed", err);
    }
    // Atomik RAM insertion (spec 323): kalıcılık BAŞARILI olunca.
    this.#cache.set(sessionId, { session: updated, workspace });
    return result;
  }

  // ── splash_refine (N. tur) ─────────────────────────────────────────────────

  /**
   * Bir `splash_refine` çağrısını uçtan uca yürütür:
   *
   *   girdi → (RAM önbellek | lazy disk load + worktree kurtarma +
   *   determinizm doğrulaması) → STALE denetimi (inference ÖNCESİ) →
   *   max-round guard → salt-okunur kümesi → geçmiş → tur (RoundRunner) →
   *   transactional kalıcılık → RAM commit
   *
   * Aynı oturumun eşzamanlı işlemleri FIFO kilit ile sıralanır (spec 76/78);
   * farklı oturumlar paralel (spec 77). No-generation durumlar
   * (stale/max_rounds/busy/needs_split/hata) oturum durumunu DEĞİŞTİRMEZ —
   * yalnız max-round acknowledgement kalıcılaşır (spec 63/94/330).
   */
  async refine(request: SplashRefineRequest): Promise<CompactResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }
    // Güvenli kimlik denetimi dosya sistemine ERİŞİMDEN ÖNCE (spec 162).
    if (!isSafeSessionId(request.sessionId)) {
      throw new SplashTaskError("invalid_input", "The session id is not a safe identifier");
    }
    if (typeof request.feedback !== "string" || request.feedback.trim() === "") {
      throw new SplashTaskError("invalid_input", "The feedback must be a non-empty string");
    }
    if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== "string")) {
      throw new SplashTaskError("invalid_input", "The files must be an array of strings");
    }
    for (const file of request.files) {
      if (normalizeRepoPath(file) === null) {
        throw new SplashTaskError("invalid_input", "The refine files must be safe repository-relative paths");
      }
    }

    // ── aynı-oturum FIFO kilit (anahtar = session_id, spec 76/78) ───────────
    return this.#runExclusive(request.sessionId, () => this.#runRefine(request));
  }

  /** `refine` gövdesi — per-session FIFO zincirinde sırayla yürür. */
  async #runRefine(request: SplashRefineRequest): Promise<CompactResult> {
    const sessionId = request.sessionId;

    // ── load/restore (lazy; spec 103-127) ───────────────────────────────────
    const entry = this.#cache.get(sessionId) ?? (await this.#loadAndRecover(sessionId));
    const { session } = entry;

    // ── stale-base denetimi — inference ÖNCESİ (spec 29) ────────────────────
    // Model çağrılmadan, tokenizer'a inmeden, bağlam kurulmadan: sürüklenme
    // biliniyorsa token BOŞA harcanmaz. Operasyonel yakalama hatası
    // (EACCES/EIO; ölçüm sırasında yaprak takası → ELOOP vb.) = TOOL HATASI —
    // stale DEĞİLDİR (spec 44); oturum korunur, hata güvenli tip'li olarak
    // yayılır. Atası symlink'e dönüşmüş yol (sentinel) ve ENOTDIR (taban:
    // yokluk / created: çakışma) ise ÖLÇÜMDÜR → stale.
    const staleFiles = await this.#detectStale(session);
    if (staleFiles.length > 0) {
      // Sürüklenmiş taban: inference YOK, tur YOK, oturum AÇIK kalır
      // (spec 43/207/241: destroy/sil/rebase/recapture YOK).
      return this.#staleResult(session, staleFiles);
    }

    // ── max-round guard — stale SONRASI (spec 60-65: stale öncelikli) ───────
    if (session.round >= this.#config.maxRounds && !session.maxRoundsAcknowledged) {
      // İz 4 S#7: iptal edilmiş isteğin yanıtı orkestratöre ULAŞMAZ (SDK
      // düşürür) — ack yazılsaydı guard sessizce tüketilirdi. Ack YAZILMAZ;
      // iptal edilmiş normal refine ile aynı tip'li `aborted` hatası.
      if (request.signal?.aborted === true) {
        throw new CoordinatorError("aborted", "Inference request was aborted before it started");
      }
      const result = this.#maxRoundsResult(session);
      // Acknowledgement kalıcılaşır — restart unutmaz (spec 61/62/210).
      const candidate: PersistedSession = { ...session, maxRoundsAcknowledged: true };
      try {
        await this.#store.save(candidate);
      } catch (err) {
        throw err instanceof SessionError ? err : sessionError("session_persistence_failed", err);
      }
      entry.session = candidate; // RAM commit disk commit SONRASI (spec 155)
      return result;
    }

    // ── salt-okunur aday kümesi (biriği; spec 26-28) ────────────────────────
    // refine.files → READ-ONLY REFERENCE (editable BÜYÜTMEZ — spec 24/28).
    // Editable üyesi duplicate OLMAZ (spec 27). Kümeye commit yalnız
    // tamamlanan üretilmiş turda olur (spec 94/413: transactional).
    const editableSet = new Set(session.editablePaths);
    const readonlyCandidate = new Set(session.readonlyPaths);
    for (const raw of request.files) {
      const canonical = normalizeRepoPath(raw);
      if (canonical === null) {
        throw new SplashTaskError("invalid_input", "The refine files must be safe repository-relative paths");
      }
      if (!editableSet.has(canonical)) {
        readonlyCandidate.add(canonical);
      }
    }
    const readonlyPaths = [...readonlyCandidate].sort(); // deterministik (spec 268)
    // Bu turun workspace doğrulaması aday kümeyi görür (spec 166/213:
    // read-only referansa yazı `readOnlyPath` ile reddedilir).
    entry.workspace.setReadonlyPaths(readonlyPaths);

    // ── geçmiş (sınıflandırılmış; redaksiyon assembler'da — spec 81/96) ─────
    const history = buildHistory(session.rounds, request.feedback);

    // ── tur (paylaşımlı pipeline; pin'li kurallar/seçenekler — spec 21/22) ──
    let outcome: RoundOutcome;
    try {
      outcome = await this.#roundRunner.run({
        ownerId: sessionId,
        task: session.task, // orijinal görev — feedback görevin YERİNE GEÇMEZ (spec 285)
        workspace: entry.workspace,
        readonlyPaths,
        resolvedRules: session.rules, // ASLA yeniden çözülmez (spec 22/258)
        rulesSoftBudget: this.#config.context.rulesSoftBudget,
        history,
        tiers: this.#config.context.tiers,
        minOutputReserve: this.#config.context.minOutputReserve,
        preferredOutputReserve: this.#config.context.preferredOutputReserve,
        contextTier: session.options.contextTier, // pin'li — tur sürüklenmesi YOK (spec 21)
        outputReserveTokens: session.options.outputReserveTokens,
        reasoningEffort: session.options.reasoningEffort,
        signal: request.signal,
      });
    } catch (err) {
      // Tur içi işletme hatası (backend/parse/apply/...) — oturum KORUNUR
      // (spec 75); workspace geri yuvarlandıysa ÖNCEKİ doğrulanmış state
      // yeniden kurulur (spec 72-73). Restore başarısızsa `session_recovery_failed`.
      await this.#restoreAfterFailedRound(entry.workspace, session, err);
      if (err instanceof ContextAssemblyError && err.kind === "invalid_input") {
        throw new SplashTaskError("invalid_input", err.message, { cause: err });
      }
      throw err; // Workspace/Coordinator/Backend/WorkerContract — güvenli
    }

    const displayRound = session.round + 1; // no-generation display (spec 58)

    if (outcome.kind === "needs_split" || outcome.kind === "inference_busy") {
      // Tur üretilmedi: workspace doğrulaması yalnız COMMIT edilmiş salt-okunur
      // kümeyi görmeli — aday küme sonraki işlemlere sızmaz (derin savunma).
      entry.workspace.setReadonlyPaths(session.readonlyPaths);
    }
    if (outcome.kind === "needs_split") {
      return this.#refineNoGenerationResult(session, displayRound, outcome.needsSplit, outcome.rulesSource);
    }
    if (outcome.kind === "inference_busy") {
      return this.#refineBusyResult(session, displayRound, outcome.conflict, outcome.assembly, outcome.rulesSource);
    }

    // ── üretilmiş tur: transactional kalıcılık (spec 152-156) ───────────────
    const result = this.#generatedResult(sessionId, displayRound, outcome);

    // Yeni workspace state hash'i (spec 156) — git hatası = tur hatası.
    let newHash: string;
    try {
      newHash = await entry.workspace.recoveryStateHash();
    } catch (err) {
      await this.#restoreAfterFailedRound(entry.workspace, session, err);
      throw err; // WorkspaceError — güvenli tip'li hata
    }

    const roundRecord: PersistedRound = {
      round: displayRound,
      feedback: request.feedback, // ham (private 0600; wire'a ASLA — spec 97/184)
      workerResult: outcome.workerResult, // normalize (spec 68)
      validation: outcome.applyResult.validation,
      result,
    };
    const candidate: PersistedSession = {
      ...session,
      round: displayRound,
      rounds: [...session.rounds, roundRecord],
      latestWorkerResult: outcome.workerResult,
      latestResult: result,
      readonlyPaths,
      currentCreatedPaths: [...outcome.applyResult.createdPaths], // spec 34
      // Kurtarma durumunun DINAMİK alanları güncellenir (spec 273): immutable
      // taban içeriği ASLA değişmez (base snapshot/fingerprints aynen).
      workspaceRecovery: {
        ...session.workspaceRecovery,
        readonlyPaths: [...readonlyPaths],
        currentCreatedPaths: [...outcome.applyResult.createdPaths],
        recoveryStateHash: newHash,
      },
      latestWorkspaceStateHash: newHash,
    };
    try {
      await this.#store.save(candidate); // = işlemin COMMIT noktası (spec 154)
    } catch (err) {
      // Workspace yeni state'te AMA kalıcılık başarısız (spec 153): önceki
      // doğrulanmış state yeniden kurulur; RAM önbellek ÖNCEKİ durumu
      // korur (spec 155). Disk yetkili kalır.
      await this.#restoreAfterFailedRound(entry.workspace, session, err);
      throw err instanceof SessionError ? err : sessionError("session_persistence_failed", err);
    }
    // RAM commit disk commit SONRASI (spec 155/331): döndürülen = kalıcılıkta.
    entry.session = candidate;
    entry.workspace.setReadonlyPaths(candidate.readonlyPaths); // sonraki tur senkron
    return result;
  }

  // ── splash_diff (Step 10 — salt-inceleme) ─────────────────────────────────

  /**
   * Bir `splash_diff` çağrısını yürütür (Step 10 spec 4-9):
   *
   *   girdi → aynı-oturum FIFO → (RAM önbellek + commit edilmiş state
   *   doğrulaması | lazy disk load + kurtarma)
   *   → `workspace.diff` (varsayılan: tüm workspace, -U3) | `workspace.stat`
   *
   * Gösterilen = close'un export edeceği: RAM'deki worktree dışarıdan
   * değiştiyse önce commit edilmiş duruma döndürülür (`#ensureCommittedWorkspace`).
   *
   * İnceleme amaçlıdır: inference / coordinator / bağlam kurma / kural çözme /
   * stale denetimi / tur artışı / kalıcılık / oturum durumu mutasyonu YOK
   * (yalnız worktree'deki doğrudan düzenlemeler atılır). Stale
   * ana ağaç diff'i ENGELLEMEZ (spec 6) — çıktı her zaman immutable base →
   * workspace katkısıdır. Kilit sayesinde yarım `applyPatchSet` gözlemlenemez.
   * Yol filtresi Workspace'in literal (`:(literal)`) pathspec disiplinini
   * kullanır; burada yalnız derin savunma (fs'e erişmeden red) yapılır.
   */
  async diff(request: SplashDiffRequest): Promise<SplashDiffResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }
    // Güvenli kimlik + girdi denetimi dosya sistemine/kilide ERİŞİMDEN ÖNCE.
    if (!isSafeSessionId(request.sessionId)) {
      throw new SplashTaskError("invalid_input", "The session id is not a safe identifier");
    }
    let files: string[] | undefined;
    if (request.files !== undefined) {
      if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== "string")) {
        throw new SplashTaskError("invalid_input", "The diff files must be an array of strings");
      }
      for (const file of request.files) {
        if (normalizeRepoPath(file) === null) {
          throw new SplashTaskError("invalid_input", "The diff files must be safe repository-relative paths");
        }
      }
      // Savunmacı kopya: kuyrukta beklerken çağıranın mutasyonu doğrulanmış
      // filtreyi değiştiremez.
      files = [...request.files];
    }
    if (request.stat !== undefined && typeof request.stat !== "boolean") {
      throw new SplashTaskError("invalid_input", "The diff stat flag must be a boolean");
    }
    const sessionId = request.sessionId;
    const statOnly = request.stat === true;
    return this.#runExclusive(sessionId, async (): Promise<SplashDiffResult> => {
      const cached = this.#cache.get(sessionId);
      const entry =
        cached !== undefined ? await this.#ensureCommittedWorkspace(cached) : await this.#loadAndRecover(sessionId);
      if (statOnly) {
        return { mode: "stat", diffStats: await entry.workspace.stat({ files }) };
      }
      return { mode: "diff", diff: await entry.workspace.diff({ files }) };
    });
  }

  // ── splash_close (Step 10 — export + kapatma) ─────────────────────────────

  /**
   * Bir `splash_close` çağrısını yürütür (Step 10 spec 10-23, DESIGN §7.5):
   * son patch'i export eder ve oturumu kapatır. Girdi YALNIZ `sessionId`;
   * patch yolu yalnız güvenilen `config.outputRoot`'tan türetilir.
   *
   * Stale taban close'u ENGELLEMEZ (spec 13): `baseStatus: "stale"` +
   * `staleFiles` döner, export yine yapılır — orkestratör stale patch'i
   * otomatik UYGULAMAMALIDIR. Splash patch'i ana checkout'a ASLA uygulamaz.
   * Inference / bağlam kurma / kural çözme / tur artışı / `max_rounds` /
   * `store.save` YOK; `max_rounds`'taki ve tur-0 oturum normal kapanır.
   */
  async close(request: SplashCloseRequest): Promise<SplashCloseResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }
    // Güvenli kimlik denetimi dosya sistemine ERİŞİMDEN ÖNCE.
    if (!isSafeSessionId(request.sessionId)) {
      throw new SplashTaskError("invalid_input", "The session id is not a safe identifier");
    }
    const sessionId = request.sessionId;
    return this.#runExclusive(sessionId, () => this.#runClose(sessionId));
  }

  /**
   * `close` gövdesi — sıra KESİNDİR (spec 11); her hata sınırı açıktır:
   *
   * 1. RAM (commit edilmiş state doğrulaması) | lazy load + kurtarma — hata
   *    aynen; hiçbir şey silinmez.
   * 2. Stale denetimi (refine ile AYNI `#detectStale`) — operasyonel hata
   *    aynen; hiçbir şey silinmez. Stale sonucu export'u ENGELLEMEZ.
   * 3. Metadata (workspace canlıyken): `stat()` + kalıcı son sonuçtan
   *    `filesChanged`/`summary` — diff metni PARSE EDİLMEZ.
   * 4. Export — hata aynen; workspace + session.json + RAM girdisi geçerli
   *    kalır (retry edilebilir; spec 16).
   * 4b. Export sonrası state doğrulaması — uyuşmazlık/hata: RAM girdisi
   *    düşer + `session_recovery_failed`; workspace + session.json KALIR
   *    (yazılmış patch dosyası retry'da üzerine yazılır).
   * 5. Workspace imhası — hata: RAM girdisi düşer (canlılık belirsiz), hata
   *    aynen; patch + session.json KALIR (sonraki çağrı kurtarır; spec 17).
   * 6. Yetkili durum silme — hata: RAM girdisi düşer (workspace imha edildi);
   *    session.json yetkili kalır, retry kurtarma ile workspace'i yeniden
   *    kurar ve export'u deterministik tekrarlar (spec 20).
   * 7. RAM girdisi düşer → sonuç (içerik YOK).
   */
  async #runClose(sessionId: string): Promise<SplashCloseResult> {
    // 1) load/restore (lazy; kurtarma model-free) | RAM: commit edilmiş
    //    duruma bağlama (dış değişiklik export'a GİRMEZ).
    const cached = this.#cache.get(sessionId);
    const entry =
      cached !== undefined ? await this.#ensureCommittedWorkspace(cached) : await this.#loadAndRecover(sessionId);
    const { session, workspace } = entry;

    // 2) stale-base denetimi — export ÖNCESİ, refine ile birebir aynı algoritma.
    const staleFiles = await this.#detectStale(session);

    // 3) metadata — workspace canlıyken (export'tan hemen önce).
    const diffStats = await workspace.stat();
    const filesChanged =
      session.round > 0 && session.latestResult !== undefined ? [...session.latestResult.filesChanged] : [];
    const summary = session.latestResult?.summary ?? NO_GENERATED_RESULT_SUMMARY;

    // 4) export — başarısızsa HİÇBİR ŞEY silinmez (workspace export_failed'de korunur).
    const patchPath = await workspace.exportPatch(this.#config.outputRoot);

    // 4b) export SONRASI yeniden doğrulama: export penceresinde worktree
    //     dışarıdan değiştiyse patch doğrulanmamış içerik taşıyabilir →
    //     workspace + session.json KALIR, RAM düşer; retry kurtarır ve
    //     patch'in üzerine yazar.
    await this.#verifyExportedState(sessionId, session, workspace);

    // 5) workspace imhası — patch artık dayanıklı kurtarma artifact'ı.
    try {
      await workspace.destroy();
    } catch (err) {
      // Canlılığı belirsiz workspace RAM'de "kullanılır" görünmez; disk
      // yetkili kalır — sonraki çağrı lazy kurtarma ile yeniden kurar.
      this.#cache.delete(sessionId);
      throw err;
    }

    // 6) yetkili kalıcı durum silme (commit noktası = session.json unlink'i).
    try {
      await this.#store.delete(sessionId);
    } catch (err) {
      // İmha edilmiş workspace RAM'de bırakılmaz; session.json yetkili kalır.
      this.#cache.delete(sessionId);
      throw err instanceof SessionError ? err : sessionError("session_operation_failed", err);
    }

    // 7) RAM girdisi — kapanan oturum RAM'den diriltilemez.
    this.#cache.delete(sessionId);
    const common = { patchPath, filesChanged, diffStats, summary };
    return staleFiles.length > 0
      ? { ...common, baseStatus: "stale", staleFiles }
      : { ...common, baseStatus: "fresh" };
  }

  // ── kilit / in-flight / stale yardımcıları (refine + diff + close) ─────────

  /**
   * Bir işlemi in-flight defterinde izler: ekle → bekle → (her yolda) sil.
   * Kayıt, çağrı anında SENKRON yapılır (ilk `await`'ten önce) — `dispose`
   * araya giremez. task/refine/diff/close'un TEK izleme yolu.
   */
  async #trackInFlight<T>(operation: Promise<T>): Promise<T> {
    this.#inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(operation);
    }
  }

  /**
   * Aynı-oturum FIFO kilidi (spec 76/78; Step 10 spec 24): gövde, kuyruktaki
   * önceki işlem tamamlanınca başlar; öncesinin HATASI kuyruğu zehirlemez
   * (spec 319/320). Kilit + in-flight kaydı ilk `await`'ten ÖNCE senkron
   * kurulur — kuyruktaki (başlamamış) iş de `dispose` tarafından beklenir
   * (spec 131). refine / diff / close bu TEK yardımcıyı kullanır.
   *
   * İz 4 S#7: sırası geldiğinde `dispose` başlamışsa gövde HİÇ çalışmaz →
   * `shutting_down` (inference / export / imha / kalıcılık YOK; oturum diskte
   * dayanıklı kalır). Kapanış istendikten sonra yeni iş başlatılmaz; dispose
   * bu hızlı reddi de bekler. Başlamış iş etkilenmez (güvenli terminaline
   * ulaşır).
   */
  async #runExclusive<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const start = (): Promise<T> => {
      if (this.#disposed) {
        return Promise.reject(new SplashTaskError("shutting_down", "Splash is shutting down"));
      }
      return body();
    };
    const execution = previous.then(start, start);
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(sessionId, tail);
    try {
      return await this.#trackInFlight(execution);
    } finally {
      // Zincirin SON halkası buysa kilit kayıttan düşer (hafıza sızısı YOK).
      if (this.#locks.get(sessionId) === tail) {
        this.#locks.delete(sessionId);
      }
    }
  }

  /**
   * Stale-base denetimi (spec 29-44; Step 10 spec 12) — refine ve close'un
   * TEK algoritması: `captureLiveBase` (strict no-follow canlı ölçüm) +
   * saf `decideStale` karşılaştırması (içerik/varlık/tip/mod + worker-create
   * çakışması). Taban immutable kalır (rebase/recapture YOK). Operasyonel
   * yakalama hatası (EACCES/EIO, ölçüm sırasında yaprak takası → ELOOP vb.;
   * `ContextAssemblyError`) stale DEĞİLDİR — aynen yayılır. Atası symlink'e
   * dönüşmüş yol (sentinel parmak izi) ve `ENOTDIR` (taban: yokluk /
   * worker-oluşturulan: çakışma) ise ölçümdür → stale. Dönüş: kanonik, dedup,
   * sıralı stale yollar (boş = fresh).
   */
  async #detectStale(session: PersistedSession): Promise<string[]> {
    const live: LiveBaseState = await this.#contextAssembler.captureLiveBase({
      repoRoot: session.repoRoot,
      basePaths: session.workspaceRecovery.editablePaths,
      createdPaths: session.currentCreatedPaths,
    });
    return decideStale({
      repoRoot: session.repoRoot,
      editablePaths: session.workspaceRecovery.editablePaths,
      baseFingerprints: new Map(session.workspaceRecovery.baseFingerprints),
      createdPaths: session.currentCreatedPaths,
      live,
    });
  }

  // ── lazy load + kurtarma (spec 103-127, 259-265, 394-405) ────────────────

  /**
   * Oturumu diskg yükler (store: fail-closed doğrulama) + worktree'yi
   * kurtarır + determinizmi doğrular + RAM önbelleğe ALIKOMIR.
   *
   * - Model ÇAĞRILMAZ (spec 263/403-405): kurtarma model-free'dir.
   * - Kurallar YENİDEN ÇÖZÜLMEZ (spec 104/395), repo YENİDEN KEŞFEDİLMEZ
   *   (spec 248/396) — pinned kalıcı durum yetkili.
   * - Hayatta worktree: kimlik + state hash BİREBİR eşleşirse REUSE
   *   (spec 109/126); değilse güvenilmez — PERSISTED state'ten yeniden
   *   kurulum (spec 110/111/127). Main'den asla yeniden yakalama YOK
   *   (spec 105/118: yeniden beliren dosya base'a GİRMEMELİ → stale).
   * - Önceki worker sonucu varsa: TAM ikame yeniden-uygulama (spec 119);
   *   validation/files/diff/createdPaths + state hash BİREBİR olmalı
   *   (spec 120/121/253) — değilse `session_recovery_failed` (fail-closed).
   */
  async #loadAndRecover(sessionId: string): Promise<ActiveSession> {
    // Disk load + tam doğrulama (store fail-closed: not_found/corrupt).
    const session = await this.#store.load(sessionId);

    // Worktree kurtarma (kimlik + hash → reuse / mismatch → recreate).
    let workspace: Workspace;
    try {
      const expectedWorkspaceDir = path.join(this.#store.sessionDirFor(session.sessionId), "workspace");
      workspace = await this.#restoreWorkspace(session.workspaceRecovery, { expectedWorkspaceDir });
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw sessionError("session_recovery_failed", err);
      }
      throw err;
    }

    // Determinizm doğrulaması (model-free — spec 405): başarısız tur geri
    // yüklemesiyle AYNI yardımcı (`#reapplyCommittedState`).
    try {
      await this.#reapplyCommittedState(workspace, session);
    } catch (err) {
      // Bozuk/kalibre edilemeyen kurtarma: fail-closed; artifact KALIR
      // (spec 164: bozuk oturum dosyası otomatik silinmez).
      throw sessionError("session_recovery_failed", err);
    }

    // RAM insertion YALNIZCA tam doğrulama SONRASI (spec 322).
    const entry = { session, workspace };
    this.#cache.set(sessionId, entry);
    return entry;
  }

  // ── shutdown (spec 128-131) ────────────────────────────────────────────────

  /**
   * Step 9/10 kapatım yaşam döngüsü:
   *   1. yeni iş kabul edilmez (`#disposed` — ilk await'ten ÖNCE),
   *   2. in-flight TÜM task/refine/diff/close çalışmaları (kuyrukta bekleyen
   *      dahil) güvenli terminal yollarına (kalıcılık / self-cleanup /
   *      koruma / kapanış) ulaşıncaya KADAR BEKLENİR (fire-and-forget YOK —
   *      spec 131); consistency redleri (kalıcılık/kurtarma hatası + cleanup
   *      hatası) dispose'a YAYILIR,
   *   3. RAM önbellek + kilit kayıtları temizlenir,
   *   4. KALICI OTURUMLARA DOKUNULMAZ (spec 128-130): worktree'ler imha
   *      EDİLMEZ, session dizinleri/si DELETE EDİLMEZ — süreç kapanışı
   *      implicit close DEĞİL; hayatta kalan geçerli worktree sonraki
   *      süreç tarafından reuse edilir. Dispose bitmeden BAŞARIYLA kapanan
   *      oturum kapalı kalır; export'u başarısız close'un oturumu diskte
   *      dayanıklı kalır (Step 10 spec 25).
   */
  dispose(): Promise<void> {
    // İz 4 S#8: idempotent — her çağrı AYNI kapanış sözünü alır (ikinci çağrı
    // in-flight işi beklemeden erken dönmez, hatayı da yutmaz).
    if (this.#disposePromise === undefined) {
      this.#disposePromise = this.#runDispose();
    }
    return this.#disposePromise;
  }

  /** `dispose` gövdesi — yalnız bir kez çalışır (`#disposePromise`). */
  async #runDispose(): Promise<void> {
    // 1) Herhangi bir await'ten ÖNCE: artık yeni iş başlatılamaz.
    this.#disposed = true;
    // 2) In-flight settlement'lar SINIFLANDIRILIR (fail-closed).
    let cleanupFailed = false;
    if (this.#inFlight.size > 0) {
      const settlements = await Promise.allSettled([...this.#inFlight]);
      for (const settlement of settlements) {
        if (settlement.status === "rejected" && inFlightRejectionFailsShutdown(settlement.reason)) {
          cleanupFailed = true;
        }
      }
    }
    // 3) RAM temizliği — disk (yetkili) VE worktree'ler KALIR (spec 129/130).
    this.#cache.clear();
    this.#locks.clear();
    if (cleanupFailed) {
      throw new SplashTaskError("task_cleanup_failed", "Task cleanup failed");
    }
  }

  // ── tur kalıcılığı + hata yolları ──────────────────────────────────────────

  /**
   * Bir üretilmiş turun session-side kalıcı etkisini üretir (spec 152):
   * round / rounds / latest* / createdPaths + YENİ state hash'i
   * (`newHash` — git I/O'su caller'da; bu fonksiyon saf veri dönüşümü).
   */
  #commitRound(
    session: PersistedSession,
    outcome: Extract<RoundOutcome, { kind: "generated" }>,
    result: CompactResult,
    newHash: string,
  ): PersistedSession {
    const displayRound = session.round + 1;
    const roundRecord: PersistedRound = {
      round: displayRound,
      workerResult: outcome.workerResult, // 1. tur: feedback YOK (spec 67)
      validation: outcome.applyResult.validation,
      result,
    };
    // 1. tur: tur 0 session'ı → salt-okunur kümesi boş kalır.
    return {
      ...session,
      round: displayRound,
      rounds: [...session.rounds, roundRecord],
      latestWorkerResult: outcome.workerResult,
      latestResult: result,
      readonlyPaths: [...session.readonlyPaths],
      currentCreatedPaths: [...outcome.applyResult.createdPaths],
      workspaceRecovery: {
        ...session.workspaceRecovery,
        readonlyPaths: [...session.readonlyPaths],
        currentCreatedPaths: [...outcome.applyResult.createdPaths],
        recoveryStateHash: newHash,
      },
      // Uygulama SONRASI state hash'i (spec 156) — kurtarma doğrulaması
      // yeniden-uygulamanın BİREBİR bu state'e dönmesini bekler.
      latestWorkspaceStateHash: newHash,
    };
  }

  /**
   * Tur içi işletme hatası SONRASI workspace'i ÖNCEKİ doğrulanmış state'e
   * geri getirir (spec 72-73): önceki worker sonucu varsa TAM ikame
   * yeniden-uygulama; yoksa (tur 0) base'e sıfırlama — ardından kurtarma ile
   * AYNI BİREBİR doğrulama (`#reapplyCommittedState`).
   *
   * Salt-okunur küme önce COMMIT edilmiş kümeye döner: turun ADAY kümesi
   * (ör. önceki turun oluşturduğu yolu salt-okunur referans veren refine)
   * yeniden-uygulamadaki create/modify'ı sessizce reddeder ve workspace'i
   * kalıcı durumdan saptırırdı.
   *
   * Başarısız ya da uyuşmazsa: RAM girdisi DÜŞER (belirsiz workspace
   * tutulmaz; sonraki çağrı diskten hash doğrulamalı kurtarır) +
   * `session_recovery_failed` YAYILIR — önceki workspace "sağlam" olarak
   * ASLA raporlanmaz (spec 73/153).
   */
  async #restoreAfterFailedRound(workspace: Workspace, session: PersistedSession, original: unknown): Promise<void> {
    let restoreFailed = false;
    try {
      workspace.setReadonlyPaths(session.readonlyPaths);
      if (session.latestWorkerResult === undefined) {
        await workspace.resetToBase();
      }
      await this.#reapplyCommittedState(workspace, session);
    } catch {
      restoreFailed = true;
    }
    if (restoreFailed) {
      this.#cache.delete(session.sessionId);
      throw sessionError("session_recovery_failed", original);
    }
  }

  /**
   * Kalıcı son doğrulanmış workspace durumunu yeniden kurar + BİREBİR
   * doğrular (model-free; spec 119-121/253/380). Kurtarma (`#loadAndRecover`)
   * ve başarısız tur geri yüklemesi (`#restoreAfterFailedRound`) bu TEK
   * yardımcıyı kullanır:
   * - üretilmiş tur varsa: TAM ikame yeniden-uygulama; validation / değişen
   *   yollar / istatistik / oluşturulan yollar kalıcı son durumla BİREBİR;
   * - kalıcı state hash'i varsa: güncel hash BİREBİR (tur 0'da = taban).
   * Sessiz sapma KABUL EDİLMEZ — her uyuşmazlık atar (sınıflandırma çağıranda).
   */
  async #reapplyCommittedState(workspace: Workspace, session: PersistedSession): Promise<void> {
    if (session.latestWorkerResult !== undefined) {
      const reapply = await workspace.applyPatchSet(session.latestWorkerResult);
      const lastResult = session.latestResult;
      if (lastResult === undefined) {
        // Store doğrulaması (spec 374) bunu garanti eder; savunma dalı.
        throw new Error("internal: generated session without latest result");
      }
      if (
        !validationEqual(reapply.validation, lastResult.validation) ||
        !filesChangedEqual(reapply.filesChanged, lastResult.filesChanged) ||
        !diffStatsEqual(reapply.diffStats, lastResult.diffStats) ||
        !createdPathsEqual(reapply.createdPaths, session.currentCreatedPaths)
      ) {
        throw new Error("internal: reapply divergence");
      }
    }
    if (session.latestWorkspaceStateHash !== undefined) {
      // Step 9 formülüyle kaydedilmiş hash de kabul (Workspace sözleşmesi).
      if (!(await workspace.matchesRecoveryStateHash(session.latestWorkspaceStateHash))) {
        throw new Error("internal: state hash mismatch");
      }
    }
  }

  /**
   * RAM'deki (cache-hit) workspace'i diff/close ÖNCESİ commit edilmiş kalıcı
   * duruma bağlar (Codex P2 — PR #34): son turdan sonra worktree dışarıdan
   * (editör/araç) değiştiyse doğrulanmamış içerik gösterilmez/export edilmez.
   * Hızlı yol YALNIZ güncel formül (`recoveryStateHash() === kalıcı`); aksi
   * halde (Step 9 formülüyle eşleşme dahil) commit edilmiş salt-okunur küme
   * altında TAM yeniden uygulama + doğrulama (tur 0: base'e sıfırlama). Kalıcılık
   * YOK. Başarısızsa: RAM girdisi düşer + `session_recovery_failed` (hiçbir
   * şey silinmez/export edilmez). Lazy kurtarma zaten doğruladığı için yalnız
   * cache-hit yolunda çağrılır.
   */
  async #ensureCommittedWorkspace(entry: ActiveSession): Promise<ActiveSession> {
    const { session, workspace } = entry;
    const expected = session.latestWorkspaceStateHash;
    try {
      if (expected === undefined || (await workspace.recoveryStateHash()) === expected) {
        return entry;
      }
      workspace.setReadonlyPaths(session.readonlyPaths);
      if (session.latestWorkerResult === undefined) {
        await workspace.resetToBase();
      }
      await this.#reapplyCommittedState(workspace, session);
    } catch (err) {
      this.#cache.delete(session.sessionId);
      throw sessionError("session_recovery_failed", err);
    }
    return entry;
  }

  /**
   * close: export edilen state'in hâlâ commit edilmiş state olduğunu doğrular
   * (L3). Uyuşmazlık veya doğrulama hatası → RAM girdisi düşer +
   * `session_recovery_failed`; hiçbir şey silinmez/imha edilmez.
   */
  async #verifyExportedState(sessionId: string, session: PersistedSession, workspace: Workspace): Promise<void> {
    const expected = session.latestWorkspaceStateHash;
    if (expected === undefined) {
      return;
    }
    let verified: boolean;
    try {
      verified = await workspace.matchesRecoveryStateHash(expected);
    } catch (err) {
      this.#cache.delete(sessionId);
      throw sessionError("session_recovery_failed", err);
    }
    if (!verified) {
      this.#cache.delete(sessionId);
      throw sessionError("session_recovery_failed", new Error("internal: workspace changed during export"));
    }
  }

  /**
   * Oluşturulan ama kullanılamaz kalan oturumun temizliği (spec 132/439):
   * workspace imhası + YETKİLİ `session.json` dosyasının TEK DOSYA silinmesi
   * (ilk kalıcılık round 1'den ÖNCE yazılır — kaldırılsa orfan kalıcı oturum
   * olurdu) + BOŞ dizinlerin `rmdir` ile giderilmesi. REKÜRSİF silme YOK,
   * geniş session-root silme YASAK (spec 236/437-438).
   * Başarısızlık `task_cleanup_failed` ile YAYILIR (sahte temizlik YOK).
   */
  async #cleanupCreatedSession(workspace: Workspace | undefined, sessionDir: string, original: unknown): Promise<void> {
    let destroyFailed = false;
    if (workspace !== undefined) {
      try {
        await workspace.destroy();
      } catch {
        destroyFailed = true;
      }
    }
    let dirsFailed = false;
    try {
      // Tek yetkili dosya + olası yarıda kalmış geçici iz — TEK dosya silme
      // (force: ENOENT sessiz; EACCES vb. → cleanup hatası): orfan oturum KALMAZ.
      await rm(path.join(sessionDir, "session.json"), { force: true });
      await rm(path.join(sessionDir, "session.json.tmp"), { force: true });
      // `git worktree remove` dizini giderse ENOENT (affedilir); imha
      // başarısızsa doludur → ENOTEMPTY (affedilir) — DOKUNULMAZ.
      await this.#removeEmptyDir(path.join(sessionDir, "workspace"));
      await this.#removeEmptyDir(sessionDir);
      await this.#removeEmptyDir(this.#store.sessionsDir);
    } catch {
      dirsFailed = true;
    }
    if (destroyFailed || dirsFailed) {
      throw new SplashTaskError("task_cleanup_failed", "Task cleanup failed", { cause: original });
    }
  }

  /** Tek dizin: `rmdir` + yalnız ENOENT/ENOTEMPTY toleransı (spec 75). */
  async #removeEmptyDir(dir: string): Promise<void> {
    try {
      await rmdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        throw err;
      }
    }
  }

  // ── Compact result üreticileri (sabit güvenli sözlük; içerik YOK) ─────────

  /** 1. tur sonucu (tümü fresh — spec 54: taban AZ ELDE EDİLDİ). */
  #taskRoundResult(sessionId: string, request: SplashTaskRequest, outcome: RoundOutcome): CompactResult {
    const round = 1; // her yeni oturum 1. turdur (spec 50/199-200)
    if (outcome.kind === "needs_split") {
      return {
        sessionId,
        round,
        status: "needs_split",
        baseStatus: "fresh",
        rulesSource: outcome.rulesSource,
        context: {
          runtimeMaxTokens: outcome.needsSplit.runtimeMaxTokens,
          inputTokens: 0, // model çağrılmadı — hakediş icat edilmez
          outputReserveTokens: outcome.needsSplit.outputReserveTokens,
          selectedContextTier: outcome.needsSplit.selectedContextTier,
          truncatedReadonlyContext: false,
        },
        summary: NEEDS_SPLIT_SUMMARY,
        filesChanged: [],
        diffStats: { files: 0, insertions: 0, deletions: 0 },
        validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
        warnings: [...outcome.needsSplit.warnings],
        usage: { in: 0, out: 0 },
        splitHint: {
          requiredInputTokens: outcome.needsSplit.requiredInputTokens,
          availableMaxTokens: outcome.needsSplit.availableMaxTokens,
          outputReserveTokens: outcome.needsSplit.outputReserveTokens,
          pressureFiles: [...outcome.needsSplit.pressureFiles],
        },
      };
    }
    if (outcome.kind === "inference_busy") {
      return this.#busyResult(sessionId, round, outcome.conflict, outcome.assembly, outcome.rulesSource);
    }
    return this.#generatedResult(sessionId, round, outcome);
  }

  /** `inference_busy` sonucu (spec 37/137): model çağrılmadı, workspace değişmedi. */
  #busyResult(
    sessionId: string,
    round: number,
    conflict: InferenceConflict,
    assembly: Extract<AssembledContext, { status: "ready" }>,
    rulesSource: RulesSource,
  ): CompactResult {
    return {
      sessionId,
      round,
      status: "inference_busy",
      baseStatus: "fresh",
      rulesSource,
      context: {
        runtimeMaxTokens: assembly.runtimeMaxTokens,
        inputTokens: 0, // model çağrılmadı — hakediş icat edilmez
        outputReserveTokens: assembly.outputReserveTokens,
        selectedContextTier: assembly.selectedContextTier,
        truncatedReadonlyContext: assembly.truncatedReadonlyContext,
      },
      summary: INFERENCE_BUSY_SUMMARY,
      filesChanged: [],
      diffStats: { files: 0, insertions: 0, deletions: 0 },
      validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
      warnings: [...assembly.warnings],
      usage: { in: 0, out: 0 },
      inference: { conflict },
    };
  }

  /**
   * Tamamlanan turun compact sonucu (spec 31/41-48): `context.input_tokens`
   * = assembler'ın TAM preflight ölçüsü; `usage` = runtime hakedişi;
   * `filesChanged`/`diffStats`/`validation` = workspace/git otoriter;
   * KAYNAK İÇERİĞİ YOK (summary = WorkerContract'ın normalize + redakte formu).
   */
  #generatedResult(
    sessionId: string,
    round: number,
    outcome: Extract<RoundOutcome, { kind: "generated" }>,
  ): CompactResult {
    const status = mapValidationToStatus(outcome.applyResult.validation);
    return {
      sessionId,
      round,
      status,
      baseStatus: "fresh",
      rulesSource: outcome.rulesSource,
      context: {
        runtimeMaxTokens: outcome.assembly.runtimeMaxTokens,
        inputTokens: outcome.assembly.inputTokens, // tam preflight ölçüsü (spec 31)
        outputReserveTokens: outcome.assembly.outputReserveTokens,
        selectedContextTier: outcome.assembly.selectedContextTier,
        truncatedReadonlyContext: outcome.assembly.truncatedReadonlyContext,
      },
      summary: redactText(outcome.workerResult.summary),
      filesChanged: [...outcome.applyResult.filesChanged],
      diffStats: {
        files: outcome.applyResult.diffStats.files,
        insertions: outcome.applyResult.diffStats.insertions,
        deletions: outcome.applyResult.diffStats.deletions,
      },
      validation: outcome.applyResult.validation,
      warnings: [...outcome.assembly.warnings],
      usage: { in: outcome.usage.inputTokens, out: outcome.usage.outputTokens },
    };
  }

  /**
   * Refine'da üretilmemiş tur (`needs_split`) — normal compact sonuç
   * (spec 93/206): inference YOK, tur YOK, state DEĞİŞMEZ. Son üretilmiş
   * turun outcome metadata'sı taşınır (tur 0 → sıfır).
   */
  #refineNoGenerationResult(
    session: PersistedSession,
    round: number,
    needsSplit: Extract<AssembledContext, { status: "needs_split" }>,
    rulesSource: RulesSource,
  ): CompactResult {
    const previous = previousOutcomeFields(session);
    return {
      sessionId: session.sessionId,
      round,
      status: "needs_split",
      baseStatus: "fresh",
      rulesSource,
      context: {
        runtimeMaxTokens: needsSplit.runtimeMaxTokens,
        inputTokens: 0, // model çağrılmadı
        outputReserveTokens: needsSplit.outputReserveTokens,
        selectedContextTier: needsSplit.selectedContextTier,
        truncatedReadonlyContext: false,
      },
      summary: NEEDS_SPLIT_SUMMARY,
      filesChanged: previous.filesChanged,
      diffStats: previous.diffStats,
      validation: previous.validation,
      warnings: [...needsSplit.warnings],
      usage: { in: 0, out: 0 },
      splitHint: {
        requiredInputTokens: needsSplit.requiredInputTokens,
        availableMaxTokens: needsSplit.availableMaxTokens,
        outputReserveTokens: needsSplit.outputReserveTokens,
        pressureFiles: [...needsSplit.pressureFiles],
      },
    };
  }

  /**
   * Refine'da inference meşgul (`inference_busy`) — spec 137/205: tur YOK,
   * state DEĞİŞMEZ (geçmiş/salt-okunur/oturum aynı); son outcome metadata'sı.
   */
  #refineBusyResult(
    session: PersistedSession,
    round: number,
    conflict: InferenceConflict,
    assembly: Extract<AssembledContext, { status: "ready" }>,
    rulesSource: RulesSource,
  ): CompactResult {
    const previous = previousOutcomeFields(session);
    return {
      sessionId: session.sessionId,
      round,
      status: "inference_busy",
      baseStatus: "fresh",
      rulesSource,
      context: {
        runtimeMaxTokens: assembly.runtimeMaxTokens,
        inputTokens: 0, // model çağrılmadı
        outputReserveTokens: assembly.outputReserveTokens,
        selectedContextTier: assembly.selectedContextTier,
        truncatedReadonlyContext: assembly.truncatedReadonlyContext,
      },
      summary: INFERENCE_BUSY_SUMMARY,
      filesChanged: previous.filesChanged,
      diffStats: previous.diffStats,
      validation: previous.validation,
      warnings: [...assembly.warnings],
      usage: { in: 0, out: 0 },
      inference: { conflict },
    };
  }

  /**
   * `stale_base` sonucu (spec 38-42/207): inference YOK, tur YOK, oturum
   * AÇIK kalır. `files_changed`/`diff_stats`/`validation` = SON üretilmiş
   * turun workspace durumu (spec 39); bağlam telemetrisi = son bilinen
   * kalıcı metadata ama `input_tokens = 0` (bu turda prompt GÖNDERİLMEDİ —
   * spec 41/334). Usage 0/0 (spec 40). Sıfır tur → sıfır outcome.
   */
  #staleResult(session: PersistedSession, staleFiles: string[]): CompactResult {
    const last = session.latestResult;
    const context: CompactContextMetadata =
      last !== undefined
        ? {
            runtimeMaxTokens: last.context.runtimeMaxTokens,
            inputTokens: 0, // bu turda prompt gönderilmedi (spec 41)
            outputReserveTokens: last.context.outputReserveTokens,
            selectedContextTier: last.context.selectedContextTier,
            truncatedReadonlyContext: last.context.truncatedReadonlyContext,
          }
        : {
            runtimeMaxTokens: 0,
            inputTokens: 0,
            outputReserveTokens: 0,
            selectedContextTier: "runtime_max",
            truncatedReadonlyContext: false,
          };
    const previous = previousOutcomeFields(session);
    return {
      sessionId: session.sessionId,
      round: session.round + 1, // display tur (spec 58)
      status: "stale_base",
      baseStatus: "stale",
      staleFiles: [...staleFiles], // kanonik, dedup, sıralı (spec 37) — içerik YOK
      rulesSource: session.rules.source,
      context,
      summary: STALE_BASE_SUMMARY, // sabit — içerik YOK (spec 42/348)
      filesChanged: previous.filesChanged,
      diffStats: previous.diffStats,
      validation: previous.validation,
      warnings: [],
      usage: { in: 0, out: 0 },
    };
  }

  /**
   * `max_rounds` guardraili sonucu (spec 60-65/208): inference YOK, tur
   * YOK, oturum AÇIK. Son outcome metadata'sı + SABİТ uyarı;
   * acknowledgement kalıcılaşır (spec 61-62).
   */
  #maxRoundsResult(session: PersistedSession): CompactResult {
    const last = session.latestResult;
    const context: CompactContextMetadata =
      last !== undefined
        ? {
            runtimeMaxTokens: last.context.runtimeMaxTokens,
            inputTokens: 0,
            outputReserveTokens: last.context.outputReserveTokens,
            selectedContextTier: last.context.selectedContextTier,
            truncatedReadonlyContext: last.context.truncatedReadonlyContext,
          }
        : {
            runtimeMaxTokens: 0,
            inputTokens: 0,
            outputReserveTokens: 0,
            selectedContextTier: "runtime_max",
            truncatedReadonlyContext: false,
          };
    const previous = previousOutcomeFields(session);
    return {
      sessionId: session.sessionId,
      round: session.round + 1, // display tur (spec 58)
      status: "max_rounds",
      baseStatus: "fresh", // stale öncelikli olduğuna göre fresh (spec 65/181)
      rulesSource: session.rules.source,
      context,
      summary: MAX_ROUNDS_SUMMARY,
      filesChanged: previous.filesChanged,
      diffStats: previous.diffStats,
      validation: previous.validation,
      warnings: [MAX_ROUNDS_WARNING], // sabit güvenli (spec 408)
      usage: { in: 0, out: 0 },
    };
  }
}

// ── Saf yardımcıları ─────────────────────────────────────────────────────────

/** İstek-seviyesi seçeneklerin pin'li kalıcı formu (spec 21). */
function buildSessionOptions(request: SplashTaskRequest): SessionOptions {
  const options: SessionOptions = {};
  if (request.reasoningEffort !== undefined) {
    options.reasoningEffort = request.reasoningEffort;
  }
  if (request.contextTier !== undefined) {
    options.contextTier = request.contextTier;
  }
  if (request.outputReserveTokens !== undefined) {
    options.outputReserveTokens = request.outputReserveTokens;
  }
  return options;
}

/**
 * Son üretilmiş turun outcome metadata'sı (stale/busy/split no-generation
 * sonuçları için): tur 0 → sıfır; tur > 0 → son turun durumu.
 */
function previousOutcomeFields(session: PersistedSession): {
  filesChanged: string[];
  diffStats: CompactResult["diffStats"];
  validation: ValidationResult;
} {
  const last = session.latestResult;
  if (last === undefined) {
    return {
      filesChanged: [],
      diffStats: { files: 0, insertions: 0, deletions: 0 },
      validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
    };
  }
  return {
    filesChanged: [...last.filesChanged],
    diffStats: {
      files: last.diffStats.files,
      insertions: last.diffStats.insertions,
      deletions: last.diffStats.deletions,
    },
    validation: {
      editsRequested: last.validation.editsRequested,
      editsApplied: last.validation.editsApplied,
      rejected: last.validation.rejected.map((rejection) => ({ ...rejection })),
    },
  };
}

/**
 * Workspace semantik doğrulaması → tur durumu:
 * - red YOK → `applied` (no-op 0/0 dahil — geçerli tur)
 * - uygulama + red → `partial`
 * - yalnız red → `failed` (semantik red — MCP hatası DEĞİL)
 */
function mapValidationToStatus(validation: ValidationResult): "applied" | "partial" | "failed" {
  if (validation.rejected.length === 0) {
    return "applied";
  }
  if (validation.editsApplied > 0) {
    return "partial";
  }
  return "failed";
}

/** Kurtarma determinizmi: validation BİREBİR (sayılar + red satırları). */
function validationEqual(a: ValidationResult, b: ValidationResult): boolean {
  if (a.editsRequested !== b.editsRequested || a.editsApplied !== b.editsApplied) {
    return false;
  }
  if (a.rejected.length !== b.rejected.length) {
    return false;
  }
  for (let i = 0; i < a.rejected.length; i++) {
    const left = a.rejected[i];
    const right = b.rejected[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (left.file !== right.file || left.edit !== right.edit || left.reason !== right.reason) {
      return false;
    }
  }
  return true;
}

function filesChangedEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function diffStatsEqual(
  a: { files: number; insertions: number; deletions: number },
  b: { files: number; insertions: number; deletions: number },
): boolean {
  return a.files === b.files && a.insertions === b.insertions && a.deletions === b.deletions;
}

function createdPathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return filesChangedEqual(a, b);
}

/**
 * `dispose()` in-flight settlement sınıflandırması (fail-closed):
 * - `task_cleanup_failed` → TEMİZLİK BAŞARISIZ (shutdown'a yayılır).
 * - `session_persistence_failed` / `session_recovery_failed` → state
 *   consistency garantisi yok (spec 131: kalıcılık hatası YAYILIR).
 * - diğer bilinen tip'li hatalar (Workspace/Coordinator/Backend/Worker/
 *   ContextAssembly/RulesResolution + güvenli `invalid_input`/
 *   `session_not_found`/`session_corrupt`/`session_operation_failed`) →
 *   oturum/workspace tutarlı korunuyor — GÜVENLİ. (Step 10 close hataları
 *   buraya düşer: `export_failed` / imha `workspace_operation_failed` /
 *   silme `session_operation_failed` — disk yetkili ve kurtarılabilir kalır.)
 * - kanıtlanamayan (tanınmayan) red → fail-closed TEMİZLİK BAŞARISIZ.
 */
function inFlightRejectionFailsShutdown(reason: unknown): boolean {
  if (reason instanceof SplashTaskError) {
    return reason.kind === "task_cleanup_failed";
  }
  if (reason instanceof SessionError) {
    return reason.kind === "session_persistence_failed" || reason.kind === "session_recovery_failed";
  }
  if (
    reason instanceof WorkspaceError ||
    reason instanceof CoordinatorError ||
    reason instanceof BackendError ||
    reason instanceof WorkerContractError ||
    reason instanceof ContextAssemblyError ||
    reason instanceof RulesResolutionError
  ) {
    return false;
  }
  return true;
}
