/**
 * Step 6: `splash_task` orkestrasyonu (DESIGN.md §3/7, 11 madde 6) —
 * İlk gerçek Splash delege loop'u:
 *
 *   task → repo keşfi → izole worktree → basit bağlam → worker mesajları →
 *   inference (koordinator) → strict parse → workspace uygulaması → compact
 *
 * SORUMLULUK SINIRI (spec 2): BU ADIM SADECE ORKESTRASYONDUR.
 * - İkinci bir Workspace Manager DEĞİLDİR — `Workspace` sözleşmesini tüketir.
 * - İkinci bir Inference Coordinator DEĞİLDİR — sürece tek coordinator var;
 *   TÜM inference `coordinator.dispatch()` üzerinden (asla `backend.run`).
 * - Context Assembler DEĞİLDİR — Step 7'ye kadar geçici basit bağlam
 *   (`simpleContext.ts`) yeter.
 * - Session Manager DEĞİLDİR — Step 9'a kadar asgari in-memory
 *   active-task kayıt defteri (spec 64); disk kalıcılığı YOK.
 *
 * Güvenlik invariantları (spec 10, 13, 16, 73, 74, 75, 79, 84, 85):
 * - Keşif hata verirse: workspace/oturum/infans YOK — güvenli tip'li hata.
 * - `outputRoot` repository DIŞINDA doğrulanır — session mkdir'ından ÖNCE.
 * - Worker kaynak değişimleri ASLA ana checkout'a yazılmaz (workspace'in
 *   kendi garantisi; bu adım yalnızca worktree administrative metadata'sına
 *   izin verilen tek istisnayı taşır).
 * - Tek görev çağrısı ≤ TEK coordinator dispatch (retry/düzeltme infansı YOK).
 * - Konstrüksiyon hiçbir dosya sistemi / HTTP işlemi yapmaz; session dizini
 *   yalnız `executeTask` içinde, doğrulardan sonra açılır.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import type { SplashConfig } from "../config.js";
import type {
  CoordinatedInferenceRequest,
  CoordinatedInferenceResult,
  InferenceConflict,
} from "../backend/InferenceCoordinator.js";
import type {
  InferenceMessage,
  InferenceRunOptions,
  InferenceUsage,
  ReasoningEffort,
  RuntimeInfo,
} from "../backend/InferenceBackend.js";
import { WorkerContract } from "../worker/WorkerContract.js";
import type { WorkerPromptInput } from "../worker/WorkerContract.js";
import type {
  CompactContextMetadata,
  CompactResult,
  ValidationResult,
  WorkerResult,
} from "../worker/result.js";
import { discoverRepoRoot } from "../workspace/git.js";
import { canonicalizeOutside, isPathInsideOrEqual, isSafeSessionId } from "../workspace/pathSafety.js";
import { WorkspaceError, type Workspace, type WorkspaceCreateInput } from "../workspace/Workspace.js";
import { createGitWorktreeWorkspace } from "../workspace/GitWorktreeWorkspace.js";
import { buildSimpleEditableContext } from "./simpleContext.js";

// ── Tip'li görev katmanı hatası (güvenli mesaj; payload YOK) ────────────────

export type SplashTaskErrorKind =
  /** Görev girdi sözleşmesine uymuyor (task/files) — MCP şemasının derin savunması. */
  | "invalid_input"
  /**
   * Yapılandırılmış outputRoot ile repository BİRLİKTE çelişiyor: outputRoot
   * repo içinde/eşit VEYA repo outputRoot içinde (session/workspace dizinleri
   * kullanıcı projesinin içine düşer) — session mkdir'ından ÖNCE red.
   */
  | "output_root_unsafe"
  /** Enjekte ID fabrikası güvenli/tekil bir kimlik üretemedi ya da kayıt çakışması. */
  | "session_conflict"
  /** Workspace imhası ya da session dizini temizliği başarısız (spec 74). */
  | "task_cleanup_failed"
  /** Runtime dispose edilmiş — yeni görev kabul edilmez (spec 69/71). */
  | "shutting_down";

export class SplashTaskError extends Error {
  constructor(
    readonly kind: SplashTaskErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; alan yeniden declare edilmez.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SplashTaskError";
  }
}

/**
 * Step 6'nın sabit (constant) uyarısı (spec 26/52): bağlam katmanı
 * bilinçli olarak eksik. KISA ve SABIТtir; kaynak içeriği, yol, secret adı
 * ya da runtime komutu taşımaz. Step 7/8 tamamlanınca kaldırılır.
 */
export const SIMPLE_CONTEXT_WARNING =
  "Simple context mode: adaptive budgeting, redaction, and project rules are not active yet.";

// ── Bağımlılık yüzeyi (küçük DI nesnesi; service locator YOK) ────────────────

/**
 * Salt-okunur kapasite görünümü: yalnız `runtimeInfo` okunur.
 * Servis backend'in İŞLEMLERİNİ (run/refresh/tokenize/...) ASLA çağrıamaz —
 * tüm üretim (generation) coordinator dispatch'inden geçer (spec 4/30).
 * Üretime `OpenAICompatBackend` bu arayüzü yapısal olarak sağlar.
 */
export interface RuntimeCapacityReader {
  readonly runtimeInfo: RuntimeInfo | null;
}

/**
 * Koordinatör görünümü: yalnız `dispatch`. Üretimde süreç-tek
 * `InferenceCoordinator` bu arayüzü yapısal olarak sağlar; testler
 * instrument edilmiş bir coordinator enjekte edebilir (spec 5/121).
 */
export interface CoordinatorLike {
  dispatch(request: CoordinatedInferenceRequest): Promise<CoordinatedInferenceResult>;
}

/** Worker Contract görünümü: mesaj inşası + strict çıktı parseı (saf). */
export interface WorkerContractLike {
  buildMessages(input: WorkerPromptInput): InferenceMessage[];
  parseResult(raw: string): WorkerResult;
}

/**
 * Workspace fabrikası: üretime `createGitWorktreeWorkspace` (Step 5).
 * Testler sahte/instrument edilmiş fabrika enjekte edebilir.
 */
export type WorkspaceFactory = (input: WorkspaceCreateInput) => Promise<Workspace>;

export interface SplashTaskServiceDeps {
  /** Ortamdan yüklenmiş yapılandırma (outputRoot, repoRoot, context payı). */
  config: SplashConfig;
  /**
   * Sürecin TEK Inference Coordinator'ı (spec 4) — tüm `splash_task`
   * çağrıları bu instance'ı paylaşır; istek başına coordinator YOK.
   */
  coordinator: CoordinatorLike;
  /** Salt-okunur kapasite görünümü (compact `runtime_max_tokens` için). */
  capacity?: RuntimeCapacityReader;
  workerContract?: WorkerContractLike;
  createWorkspace?: WorkspaceFactory;
  /** Kriptografik oturum kimliği (varsayılan: `crypto.randomUUID`). */
  newSessionId?: () => string;
  /** MCP sürecinin CWD'si — repository keşfinin başlangıç noktası. */
  processCwd?: () => string;
}

/** Bir `splash_task` çağrısının girdisi (MCP katmanı şema doğruladı). */
export interface SplashTaskRequest {
  /** Orijinal görev metni — worker'a AYNEN gider (trim yalnız boşluk denetimi). */
  task: string;
  /** Repository-göreceli düzenlenebilir yollar; boş dizi geçerli (create-only). */
  files: readonly string[];
  /** Kullanıcı vermediyse dispatch seçeneklerinde TAMAMEN YOK (spec 34). */
  reasoningEffort?: ReasoningEffort;
  /** MCP SDK'nın istek sinyali → coordinator `options.signal`'a (spec 35). */
  signal?: AbortSignal;
}

/**
 * Geçici active-task kaydı (spec 64) — Step 9'un kalıcı Session Manager'ı
 * bunu değiştirir. Kurallar/geçmiş/kalıcı metadata/stale/bütçe YOK.
 */
export interface ActiveTask {
  workspace: Workspace;
  /** `<outputRoot>/sessions/<sessionId>` — dizin temizliği için tek referans. */
  sessionDir: string;
  latestResult: CompactResult;
}

// ── Hizmet ────────────────────────────────────────────────────────────────────

export class SplashTaskService {
  #config: SplashConfig;
  #coordinator: CoordinatorLike;
  #capacity: RuntimeCapacityReader | undefined;
  #workerContract: WorkerContractLike;
  #createWorkspace: WorkspaceFactory;
  #newSessionId: () => string;
  #processCwd: () => string;

  /** In-memory active-task defteri (spec 64) — process-özel, kalıcı DEĞİL. */
  #active = new Map<string, ActiveTask>();
  /** `dispose()` sonrası yeni görev kabul edilmez (spec 69). */
  #disposed = false;

  constructor(deps: SplashTaskServiceDeps) {
    this.#config = deps.config;
    this.#coordinator = deps.coordinator;
    this.#capacity = deps.capacity;
    this.#workerContract = deps.workerContract ?? new WorkerContract();
    this.#createWorkspace = deps.createWorkspace ?? ((input) => createGitWorktreeWorkspace(input));
    this.#newSessionId = deps.newSessionId ?? (() => randomUUID());
    this.#processCwd = deps.processCwd ?? (() => process.cwd());
  }

  /** Runtime kapatılmış mı? (dispose sonrası yeni görev reddedilir.) */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Aktif görevler (yalnızca test/diagnosis erişimi — MCP aracı YOK, spec 67). */
  activeTasks(): readonly ActiveTask[] {
    return [...this.#active.values()];
  }

  /**
   * Bir `splash_task` çağrısını uçtan uca yürütür (spec 93 loop'u).
   *
   * Başarıda: `CompactResult` (durum applied/partial/failed/inference_busy —
   * hepsi NORMAL sonuç; `failed`/`inference_busy` hata DEĞİLdir).
   * Ara hatada (keşif/outputRoot/oluşum/parse/apply/koordinator): tip'li
   * hata YAYILIR — `inference_busy` HARİCİ tüm yollarda oluşturulan
   * workspace imha edilir, boş session dizini `rmdir` ile temizlenir.
   *
   * SIRA (güvenlik sıralaması — spec 13):
   *   girdi → repo keşfi → outputRoot containment → session ID →
   *   kayıt çakışması → session mkdir → worktree → bağlam → mesaj →
   *   dispatch → parse → apply → kayıt.
   */
  async executeTask(request: SplashTaskRequest): Promise<CompactResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }

    // ── girdi doğrulaması (spec 7/8) — trim YALNIZCA boşluk denetimi ─────
    if (typeof request.task !== "string" || request.task.trim() === "") {
      throw new SplashTaskError("invalid_input", "The task must be a non-empty string");
    }
    if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== "string")) {
      throw new SplashTaskError("invalid_input", "The files must be an array of strings");
    }

    // ── repository keşfi (spec 9/10) — henüz hiçbir yazma YOK ─────────────
    // Başlangıç = MCP süreci CWD'si; config `repoRoot` override olarak gider.
    const repoRoot = await discoverRepoRoot({
      cwd: this.#processCwd(),
      override: this.#config.repoRoot,
    });

    // ── outputRoot containment (spec 13) — session mkdir'ından ÖNCE ──────
    // `outputRoot == repoRoot` ya da repo İÇİ → güvenli red; kullanıcı
    // repository'sinde `.splash` dizini ASLA oluşmaz.
    const canonicalOutputRoot = await canonicalizeOutside(this.#config.outputRoot, repoRoot);
    if (
      // outputRoot repo İÇİNDE veya repo ile eşit (spec 102): `sessions` dizini
      // kullanıcı repository'sinde ASLA oluşmaz.
      canonicalOutputRoot === null ||
      // outputRoot repo'yu İÇERİYOR (spec 102, ters yön): session/workspace
      // dizinleri proje ağacının içine düşer — ikisi de kanonik olduğundan
      // string karşılaştırması güvenlidir.
      isPathInsideOrEqual(canonicalOutputRoot, repoRoot)
    ) {
      throw new SplashTaskError("output_root_unsafe", "The output root must be outside the repository");
    }

    // ── session ID (spec 11) — her deneme için TAZE kriptografik kimlik ──
    const sessionId = this.#newSessionId();
    if (!isSafeSessionId(sessionId)) {
      // Kimlik hata mesajına YANSITILMAZ (yol/kaçış taşıyabilir).
      throw new SplashTaskError("invalid_input", "The session id is not a safe identifier");
    }
    // Kayıt çakışması: workspace OLUŞTURMADAN ÖNCE red (spec 117) —
    // aktif görev sessizce ezip yazılmaz.
    if (this.#active.has(sessionId)) {
      throw new SplashTaskError("session_conflict", "A task with this session id is already active");
    }

    // ── session dizini (spec 12/14) — yalnız gerekli atal; kısıtlayıcı mod ─
    const sessionsParent = path.join(canonicalOutputRoot, "sessions");
    const sessionDir = path.join(sessionsParent, sessionId);
    const workspaceDir = path.join(sessionDir, "workspace");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    // recursive `mode` yalnız YAPRAĞA uygulanır — `sessions` atalı da dahil
    // iki seviye 0700 garanti edilir. Başarısızlık SESSİZCE YUTULMAZ
    // (audit F-1): kısıtlayıcı mod kurulamadıysa görev ilerlemez.
    try {
      await chmod(sessionsParent, 0o700);
      await chmod(sessionDir, 0o700);
    } catch {
      // Bu denemede açtığımız dizinler boş → rmdir (best-effort; temizlik
      // errno'su orijinal tip'li hatayı MASKELEMEZ — audit F-2 kuralı).
      await this.#removeEmptyDirs(workspaceDir, sessionDir, sessionsParent).catch(() => undefined);
      throw new SplashTaskError("task_cleanup_failed", "Session directory preparation failed");
    }

    // ── workspace (spec 15) — oluşturma Step 5'in sorumluluğudur ─────────
    let workspace: Workspace;
    try {
      workspace = await this.#createWorkspace({
        repoRoot,
        workspaceDir,
        sessionId,
        editablePaths: request.files,
        readonlyPaths: [],
      });
    } catch (err) {
      // Yarım worktree'yi createGitWorktreeWorkspace zaten kaldırır; geriye
      // en fazla BOŞ dizinler kalır → `rmdir` (rekürsif YOK, spec 75).
      // BEST-EFFORT (audit F-2): temizlik errno'su (örn. EACCES) orijinal
      // tip'li `WorkspaceError`'ı maskelememeli — `throw err` her zaman
      // kazanır. Not: bu, `#cleanupAfterFailure`'ın (spec 74) AYNI KURAL
      // DEĞİL o orada temizlik hatası BİZZAT sonucu belirler.
      await this.#removeEmptyDirs(workspaceDir, sessionDir).catch(() => undefined);
      throw err;
    }

    try {
      // ── basit bağlam (spec 17-25) — workspace'ten, kanonik yollardan ────
      const context = await buildSimpleEditableContext(workspace.workspaceDir, workspace.editablePaths);

      // ── worker mesajları (spec 33) — sözleşme WorkerContract'ta ─────────
      const messages = this.#workerContract.buildMessages({
        task: request.task,
        rules: undefined, // Step 8 kuralları yükler; Step 6: YOK (spec 27)
        context,
        history: [], // Step 9 rafine geçmişini getirir; Step 6: BOŞ (spec 28)
        outputReserveTokens: this.#config.context.minOutputReserve, // spec 29
      });

      // ── inference (spec 34) — süreç-tek coordinator, TAM AMIR tek dispatch ─
      const runOptions: InferenceRunOptions = {
        maxOutputTokens: this.#config.context.minOutputReserve,
      };
      if (request.reasoningEffort !== undefined) {
        runOptions.reasoningEffort = request.reasoningEffort;
      }
      if (request.signal !== undefined) {
        runOptions.signal = request.signal;
      }
      const dispatched = await this.#coordinator.dispatch({
        ownerId: sessionId,
        messages,
        options: runOptions,
      });

      // ── inference_busy (spec 36/66): GEÇERLİ compact sonuç; workspace
      //    KORUNUR (imha YOK — Step 9'da refine/close onu kullanacak). ──────
      if (dispatched.status === "inference_busy") {
        const result = this.#busyResult(sessionId, dispatched.conflict);
        this.#retain(sessionId, workspace, sessionDir, result);
        return result;
      }

      // ── strict worker parse (spec 38) — yalnız `result.content` ──────────
      // Markdown düzeltme/regex/ikinci inference YOK (Step 4 sıkılığı).
      const workerResult = this.#workerContract.parseResult(dispatched.result.content);

      // ── workspace uygulaması (spec 40) — TAMAMEN tek çağrı ───────────────
      // Workspace Manager tek semantik güvenlik otoritesidir; TaskService
      // search stringi ön-doğrulamaz, diff hesaplamaz, dosya yazmaz.
      const applyResult = await workspace.applyPatchSet(workerResult);

      const result = this.#completedResult(sessionId, workerResult, applyResult, dispatched.result.usage);
      this.#retain(sessionId, workspace, sessionDir, result);
      return result;
    } catch (err) {
      // Sonuç korunamadan iş hata verdi (spec 73): workspace imha edilir,
      // boş dizinler rmdir ile gider. `inference_busy` bu yolun dışındadır
      // (geçerli sonuç; yukarıda korunur).
      await this.#cleanupAfterFailure(workspace, sessionDir, err);
      throw err;
    }
  }

  /**
   * Kapatım yaşam döngüsü (spec 69):
   *   1. yeni görev kabul edilmez (`#disposed`),
   *   2. TÜM aktif worktree'ler imha edilir (sıralı),
   *   3. boşalan Step 6 session dizinleri `rmdir` ile kaldırılır
   *      (geniş `rm -rf <outputRoot>/sessions` YASAK — spec 69/75),
   *   4. kayıt defteri temizlenir.
   *
   * Bir imha/temizlik adımı başarısız olursa güvenli tip'li hata yayılır
   * (kaynak/cause yüzeye taşınmaz); kalan görevler yine denenir.
   * Crash kurtarması Step 9'a aittir (spec 72) — burada yok.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const tasks = [...this.#active.values()];
    this.#active.clear();

    let cleanupFailed = false;
    for (const task of tasks) {
      let destroyFailed = false;
      try {
        await task.workspace.destroy();
      } catch {
        destroyFailed = true; // workspace dizini kalabilir — kullanırın incelemesi için
      }
      let dirsFailed = false;
      try {
        await this.#removeEmptyDir(path.join(task.sessionDir, "workspace"));
        await this.#removeEmptyDir(task.sessionDir);
      } catch {
        dirsFailed = true; // (imha başarısızsa dizinler doludur → ENOTEMPTY affedilir)
      }
      if (destroyFailed || dirsFailed) {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      // `cause` bağlanmaz: imha hatası git stderr'i/yol taşıyabilir —
      // stderr diyagistikleri de aynı sabit cümleyle yetinir (spec 71).
      throw new SplashTaskError("task_cleanup_failed", "Task cleanup failed");
    }
  }

  // ── iç yardımcılar ────────────────────────────────────────────────────────

  /** Sonuç korunur (applied/partial/failed/inference_busy — hepsi canlı). */
  #retain(sessionId: string, workspace: Workspace, sessionDir: string, result: CompactResult): void {
    if (this.#disposed) {
      // dispose() ile yarışan son çağrı: kayıt defteri zaten boş; workspace'i
      // kendisi imha eder — dispose'un tek-geç turu onu görmez (orfan YOK).
      void this.#cleanupAfterFailure(workspace, sessionDir, null).catch(() => undefined);
      return;
    }
    this.#active.set(sessionId, { workspace, sessionDir, latestResult: result });
  }

  /**
   * Sonuç korunamayan arıza yollarında: workspace imhası + BOŞ dizin
   * temizliği. İmha/temizlik başarısızsa GÜVENLİ `task_cleanup_failed`
   * yayılır (spec 74) — sahte "temiz imha" asla raporlanmaz.
   */
  async #cleanupAfterFailure(workspace: Workspace, sessionDir: string, original: unknown): Promise<void> {
    let destroyFailed = false;
    try {
      await workspace.destroy();
    } catch {
      destroyFailed = true;
    }
    let dirsFailed = false;
    try {
      // `git worktree remove` dizini zaten giderse ENOENT (affedilir);
      // imha başarısızsa doludur → ENOTEMPTY (affedilir) — DOKUNULMAZ.
      await this.#removeEmptyDir(workspace.workspaceDir);
      await this.#removeEmptyDir(sessionDir);
    } catch {
      dirsFailed = true;
    }
    if (destroyFailed || dirsFailed) {
      throw new SplashTaskError("task_cleanup_failed", "Task cleanup failed", { cause: original });
    }
  }

  /**
   * Sıralı boş-dizin temizliği: YALNIZ `rmdir` (içerik varsa ENOTEMPTY ile
   * kendisi reddeder); ENOENT (zaten yok) affedilir. Rekürsif silme YOK —
   * canlı worktree asla geniş dosya sistemi operasyonuyla risk altına
   * alınmaz (spec 75).
   */
  async #removeEmptyDirs(...dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      await this.#removeEmptyDir(dir);
    }
  }

  /** Tek dizin: `rmdir` + yalnız ENOENT/ENOTEMPTY toleransı. */
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

  #runtimeMaxTokens(): number {
    // Step 6 adaptif bütçe YOK (spec 29/31): son başarılı runtime yenilemesinin
    // yetkili (authoritative) tavanı; hiç yenileme yoksa 0 (kapasite icat edilmez).
    return this.#capacity?.runtimeInfo?.maximumContextTokens ?? 0;
  }

  /**
   * `inference_busy` placeholder sonucu (spec 37): deterministik BOŞ değerler.
   * PID/komut/yol/içerik YOK; workspace korunduğu için sonradan refine/close
   * (Step 9) aynı oturumu kullanabilir.
   */
  #busyResult(sessionId: string, conflict: InferenceConflict): CompactResult {
    const context: CompactContextMetadata = {
      runtimeMaxTokens: this.#runtimeMaxTokens(),
      inputTokens: 0,
      outputReserveTokens: this.#config.context.minOutputReserve,
      selectedContextTier: "runtime_max", // Step 6 tier seçimi YOK (spec 31)
      truncatedReadonlyContext: false, // Step 6 salt-okunur bağlam YOK (spec 86)
    };
    return {
      sessionId,
      round: 1, // Step 6'da her çağrı 1. turdur (spec 50)
      status: "inference_busy",
      baseStatus: "fresh", // her yeni oturum yapısal olarak fresh (spec 49)
      rulesSource: "none", // Step 8 kurallar; Step 6: YOK (spec 51)
      context,
      inference: { conflict },
      summary: "Inference is temporarily unavailable; no worker generation was run.",
      filesChanged: [],
      diffStats: { files: 0, insertions: 0, deletions: 0 },
      validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
      warnings: [SIMPLE_CONTEXT_WARNING],
      usage: { in: 0, out: 0 },
    };
  }

  /**
   * Tamamlanan turun compact sonucu (spec 31/41-48/51/52):
   * workspace + coordinator çıktılarının metadata'sı; KAYNAK İÇERİĞİ YOK.
   */
  #completedResult(
    sessionId: string,
    workerResult: WorkerResult,
    applyResult: {
      validation: ValidationResult;
      filesChanged: string[];
      diffStats: CompactResult["diffStats"];
    },
    usage: InferenceUsage,
  ): CompactResult {
    const status = mapValidationToStatus(applyResult.validation);
    return {
      sessionId,
      round: 1,
      status,
      baseStatus: "fresh",
      rulesSource: "none",
      context: {
        runtimeMaxTokens: this.#runtimeMaxTokens(),
        inputTokens: usage.inputTokens,
        outputReserveTokens: this.#config.context.minOutputReserve,
        selectedContextTier: "runtime_max",
        truncatedReadonlyContext: false,
      },
      summary: workerResult.summary, // WorkerContract'ın normalize ettiği aynen (spec 44)
      filesChanged: [...applyResult.filesChanged], // workspace/git otoriter (spec 45)
      diffStats: {
        files: applyResult.diffStats.files,
        insertions: applyResult.diffStats.insertions,
        deletions: applyResult.diffStats.deletions,
      },
      validation: applyResult.validation, // snippet'lar yok — zaten güvenli sözlük (spec 47)
      warnings: [SIMPLE_CONTEXT_WARNING],
      usage: { in: usage.inputTokens, out: usage.outputTokens }, // totalTokens YOK (spec 48)
    };
  }
}

/**
 * Workspace semantik doğrulaması → tur durumu (spec 41-43):
 * - red YOK          → `applied` (no-op 0/0 dahil — geçerli tur)
 * - uygulama + red   → `partial`
 * - yalnız red       → `failed` (semantik red — MCP hatası DEĞİL;
 *                      workspace canlı kalır, Step 9'da refine edilebilir)
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
