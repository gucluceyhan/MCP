/**
 * Step 6+7: `splash_task` orkestrasyonu (DESIGN.md §3/5/7, 11 madde 6-7) —
 * Gerçek Splash delege loop'u:
 *
 *   task → repo keşfi → izole worktree → bağlam (assembler: redaksiyon +
 *   tam ölçü + adaptif kademe/pay + azaltma) → worker mesajları →
 *   inference (koordinator) → strict parse → workspace uygulaması → compact
 *
 * SORUMLULUK SINIRI (spec 2): BU ADIM SADECE ORKESTRASYONDUR.
 * - İkinci bir Workspace Manager DEĞİLDİR — `Workspace` sözleşmesini tüketir.
 * - İkinci bir Inference Coordinator DEĞİLDİR — sürece tek coordinator var;
 *   TÜM inference `coordinator.dispatch()` üzerinden (asla `backend.run`).
 * - Context Assembler DEĞİLDİR — sürece tek assembler var; bağlamı
 *   `contextAssembler.assemble()` üzerinden kurar (Step 7); kendi ölçüm /
 *   redaksiyon / bütçe mantığı YOK.
 * - Session Manager DEĞİLDİR — Step 9'a kadar asgari in-memory
 *   active-task kayıt defteri (spec 64); disk kalıcılığı YOK.
 *
 * Güvenlik invariantları (spec 10, 13, 16, 26-36, 73, 74, 75, 79, 84, 85):
 * - Keşif hata verirse: workspace/oturum/infans YOK — güvenli tip'li hata.
 * - `outputRoot` repository DIŞINDA doğrulanır — session mkdir'ından ÖNCE.
 * - Worker kaynak değişimleri ASLA ana checkout'a yazılmaz (workspace'in
 *   kendi garantisi; bu adım yalnızca worktree administrative metadata'sına
 *   izin verilen tek istisnayı taşır).
 * - Tek görev çağrısı ≤ TEK coordinator dispatch (retry/düzeltme infansı YOK).
 * - `context.input_tokens` = assembler'ın TAM preflight ölçüsüdür —
 *   `usage.inputTokens` (runtime'un kendi sayımı) ASLA değildir.
 * - `needs_split` normal compact SONUCtur (MCP hatası değil): model
 *   çağrılmaz, workspace KORUNUR (Step 9 refine/close kullanabilir).
 * - Konstrüksiyon hiçbir dosya sistemi / HTTP işlemi yapmaz; session dizini
 *   yalnız `executeTask` içinde, doğrulardan sonra açılır.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import type { SplashConfig } from "../config.js";
import {
  CoordinatorError,
  type CoordinatedInferenceRequest,
  type CoordinatedInferenceResult,
  type InferenceConflict,
} from "../backend/InferenceCoordinator.js";
import type {
  InferenceRunOptions,
  InferenceUsage,
  ReasoningEffort,
} from "../backend/InferenceBackend.js";
import { WorkerContract } from "../worker/WorkerContract.js";
import {
  WorkerContractError,
  type CompactContextMetadata,
  type CompactResult,
  type SelectedContextTier,
  type ValidationResult,
  type WorkerResult,
} from "../worker/result.js";
import { BackendError } from "../backend/errors.js";
import { discoverRepoRoot } from "../workspace/git.js";
import { canonicalizeOutside, isSafeSessionId } from "../workspace/pathSafety.js";
import { WorkspaceError, type Workspace, type WorkspaceCreateInput } from "../workspace/Workspace.js";
import { createGitWorktreeWorkspace } from "../workspace/GitWorktreeWorkspace.js";
import { redactText } from "../context/redact.js";
import {
  ContextAssemblyError,
  type AssembledContext,
  type ContextAssemblyInput,
} from "../context/types.js";

// ── Tip'li görev katmanı hatası (güvenli mesaj; payload YOK) ────────────────

export type SplashTaskErrorKind =
  /** Görev girdi sözleşmesine uymuyor (task/files/override'lar) — MCP şemasının derin savunması. */
  | "invalid_input"
  /**
   * Yapılandırılmış outputRoot, repository ile çelişiyor: `outputRoot ==
   * repoRoot` ya da outputRoot repo İÇİNDE — `sessions` dizini kullanıcı
   * projesinin içine düşer — session mkdir'ından ÖNCE red. (Repo, outputRoot
   * içinde OLMASI tek başına red DEĞİLDİR: `<outputRoot>/sessions/<id>`
   * repository ağacının dışında kalır; workspace dizinini Step 5 fabrikası
   * ayrıca doğrular.)
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
 * `needs_split` turunun SABİТ compact özeti (spec 26/52): kaynak içerik,
 * dosya, secret, yol YOK — yalnız durum.
 */
const NEEDS_SPLIT_SUMMARY =
  "The required context exceeds the context budget; the task was not started. Split the task into smaller file groups.";

// ── Bağımlılık yüzeyi (küçük DI nesnesi; service locator YOK) ────────────────

/**
 * Context Assembler görünümü: yalnız `assemble`. Üretime süreç-tek
 * `ContextAssembler` (Step 7) bu arayüzü yapısal olarak sağlar; testler
 * instrument edilmiş bir assembler enjekte edebilir. Service BAĞLAMI
 * kendisi KURMAZ — yalnız kurucu + tüketici orkestrasyondur.
 */
export interface ContextAssemblerLike {
  assemble(input: ContextAssemblyInput): Promise<AssembledContext>;
}

/**
 * Koordinatör görünümü: yalnız `dispatch`. Üretime süreç-tek
 * `InferenceCoordinator` bu arayüzü yapısal olarak sağlar; testler
 * instrument edilmiş bir coordinator enjekte edebilir (spec 5/121).
 */
export interface CoordinatorLike {
  dispatch(request: CoordinatedInferenceRequest): Promise<CoordinatedInferenceResult>;
}

/** Worker Contract görünümü: strict çıktı parseı (saf; mesaj inşası Step 7'de assembler'da). */
export interface WorkerContractLike {
  parseResult(raw: string): WorkerResult;
}

/**
 * Workspace fabrikası: üretime `createGitWorktreeWorkspace` (Step 5).
 * Testler sahte/instrument edilmiş fabrika enjekte edebilir.
 */
export type WorkspaceFactory = (input: WorkspaceCreateInput) => Promise<Workspace>;

export interface SplashTaskServiceDeps {
  /** Ortamdan yüklenmiş yapılandırma (outputRoot, repoRoot, context bütçesi). */
  config: SplashConfig;
  /**
   * Sürecin TEK Inference Coordinator'ı (spec 4) — tüm `splash_task`
   * çağrıları bu instance'ı paylaşır; istek başına coordinator YOK.
   */
  coordinator: CoordinatorLike;
  /**
   * Sürecin TEK Context Assembler'ı (Step 7) — tüm çağrılar bu instance'ı
   * paylaşır; istek başına assembler YOK.
   */
  contextAssembler: ContextAssemblerLike;
  workerContract?: WorkerContractLike;
  createWorkspace?: WorkspaceFactory;
  /** Kriptografik oturum kimliği (varsayılan: `crypto.randomUUID`). */
  newSessionId?: () => string;
  /** MCP sürecinin CWD'si — repository keşfinin başlangıç noktası. */
  processCwd?: () => string;
}

/** Bir `splash_task` çağrısının girdisi (MCP katmanı şema doğruladı). */
export interface SplashTaskRequest {
  /** Orijinal görev metni — assembler redakte eder; worker'a redakte EDİLMİŞ form gider. */
  task: string;
  /** Repository-göreceli düzenlenebilir yollar; boş dizi geçerli (create-only). */
  files: readonly string[];
  /**
   * Açık bağlam kademesi — kanonik SEMBOLİK değer (`64k`/`128k`/`192k`/
   * `runtime_max`; BLOCKER 4). Token'ı assembler `refreshRuntimeInfo`
   * SONRASI çözer. VERİLMEDİSE adaptif seçim; dispatch seçeneklerinde TAMAMEN
   * YOK (spec 34).
   */
  contextTier?: SelectedContextTier;
  /**
   * Açık çıkış payı (token; config minimumunun altı olamaz) — VERİLMEDİSE
   * adaptif müzakere (preferred/min).
   */
  outputReserveTokens?: number;
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
  #contextAssembler: ContextAssemblerLike;
  #workerContract: WorkerContractLike;
  #createWorkspace: WorkspaceFactory;
  #newSessionId: () => string;
  #processCwd: () => string;

  /** In-memory active-task defteri (spec 64) — process-özel, kalıcı DEĞİL. */
  #active = new Map<string, ActiveTask>();
  /** `dispose()` sonrası yeni görev kabul edilmez (spec 69). */
  #disposed = false;
  /**
   * Şu an yürüyen (terminale ulaşmamış) `executeTask` çalışmaları —
   * `dispose()` bu defteri BEKLER: shutdown başladıktan sonra hiçbir görev
   * cleanup'suz kaçamaz (fire-and-forget YOK). Genel zamanlayıcı DEĞİLDİR;
   * yalnız yaşam döngüsü izlemesidir.
   */
  #inFlight = new Set<Promise<CompactResult>>();

  constructor(deps: SplashTaskServiceDeps) {
    this.#config = deps.config;
    this.#coordinator = deps.coordinator;
    this.#contextAssembler = deps.contextAssembler;
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
   * Shutdown yaşam döngüsü (spec 69 — dispose yarışına karşı deterministik):
   * - dispose başlamışsa → derhal `shutting_down` (yeni çalışma YOK).
   * - Çalışma BAŞLARKEN in-flight defterine SENKRON kaydedilir (denetimle
   *   kayıt arasında yield YOK — dispose araya giremez).
   * - `dispose()`, in-flight defteri boşalana kadar ÇÖZÜLMEZ: shutdown
   *   öncesi başlayan HER görev ya koruma+dispose imhasından ya da
   *   KENDİ beklenen (await'lenen) temizliğinden geçer — orfan workspace
   *   YOK, fire-and-forget YOK.
   *
   * Başarıda: `CompactResult` (durum applied/partial/failed/needs_split/
   * inference_busy — hepsi NORMAL sonuç; `failed`/`needs_split`/
   * `inference_busy` hata DEĞİLdir).
   * Ara hatada (keşif/outputRoot/oluşum/bağlam/parse/apply/koordinator):
   * tip'li hata YAYILIR — `inference_busy` + `needs_split` HARİCİ tüm
   * yollarda oluşturulan workspace imha edilir, boş session dizini `rmdir`
   * ile temizlenir.
   *
   * SIRA (güvenlik sıralaması — spec 13):
   *   girdi (task/files/override'lar) → repo keşfi → outputRoot containment
   *   → session ID → kayıt çakışması → session mkdir → worktree →
   *   bağlam (assembler) → [needs_split?] → dispatch → parse → apply → kayıt.
   */
  async executeTask(request: SplashTaskRequest): Promise<CompactResult> {
    if (this.#disposed) {
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
    }
    // in-flight kaydı, `#disposed` denetiminden sonra SENKRON yapılır —
    // dispose, kayıttan önce araya giremez (tek iplik; yield yok).
    const execution = this.#runTask(request);
    this.#inFlight.add(execution);
    try {
      return await execution;
    } finally {
      this.#inFlight.delete(execution);
    }
  }

  /** `executeTask` gövdesi — in-flight defterinde izlenir (spec 93 loop'u). */
  async #runTask(request: SplashTaskRequest): Promise<CompactResult> {
    // ── girdi doğrulaması (spec 7/8) — trim YALNIZCA boşluk denetimi ─────
    if (typeof request.task !== "string" || request.task.trim() === "") {
      throw new SplashTaskError("invalid_input", "The task must be a non-empty string");
    }
    if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== "string")) {
      throw new SplashTaskError("invalid_input", "The files must be an array of strings");
    }
    // Bağlam override'ları workspace OLUŞTURULMADAN ÖNCE doğrulanır (spec 13):
    // geçersiz bir bütçe istek çalışacak bir worktree açmamalı.
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
    // Açık kademe kanonik SEMBOLİK kümede olmalı (BLOCKER 4): sayısal veya
    // bilinmeyen değer MCP şemasında zaten reddedilir; burası savunma derinliği.
    if (
      request.contextTier !== undefined &&
      !(["64k", "128k", "192k", "runtime_max"] as readonly string[]).includes(request.contextTier)
    ) {
      throw new SplashTaskError(
        "invalid_input",
        "The context tier must be one of: 64k, 128k, 192k, runtime_max",
      );
    }

    // ── repository keşfi (spec 9/10) — henüz hiçbir yazma YOK ─────────────
    // Başlangıç = MCP süreci CWD'si; config `repoRoot` override olarak gider.
    const repoRoot = await discoverRepoRoot({
      cwd: this.#processCwd(),
      override: this.#config.repoRoot,
    });

    // ── outputRoot containment (spec 13/102) — session mkdir'ından ÖNCE ───
    // Red koşulları (ve yalnız bunlar): `outputRoot == repoRoot` ya da
    // outputRoot repo İÇİNDE — `sessions` dizini kullanıcı repository'sinde
    // ASLA oluşmaz. Repo'nun outputRoot içinde OLMASI tek başına red DEĞİL:
    // `<outputRoot>/sessions/<id>/workspace` repository ağacına otomatik
    // girmez (workspace dizinini Step 5 fabrikası ayrıca doğrular).
    const canonicalOutputRoot = await canonicalizeOutside(this.#config.outputRoot, repoRoot);
    if (canonicalOutputRoot === null) {
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
      // ── bağlam (spec 17-32, Step 7) — süreç-tek assembler ───────────────
      // Assembler: redaksiyon + immutable taban + tam ölçü + adaptif
      // kademe/pay + salt-okunur azaltma. Production v1: salt-okunur
      // referans YOK (`readonlyPaths: []` — spec 86); kurallar (Step 8)
      // YOK; geçmiş (Step 9) BOŞ.
      const assembly = await this.#contextAssembler.assemble({
        task: request.task,
        workspace,
        readonlyPaths: [],
        rules: undefined, // Step 8 kuralları yükler; Step 7: YOK (spec 27)
        history: [], // Step 9 rafine geçmişini getirir; Step 7: BOŞ (spec 28)
        tiers: this.#config.context.tiers,
        minOutputReserve: this.#config.context.minOutputReserve,
        preferredOutputReserve: this.#config.context.preferredOutputReserve,
        contextTier: request.contextTier,
        outputReserveTokens: request.outputReserveTokens,
        reasoningEffort: request.reasoningEffort,
        signal: request.signal,
      });

      // ── needs_split (spec 32): NORMAL compact sonuç — model çağrılmaz, ──
      //    BİLEŞTİRİLMEZ, KISILMAZ; workspace KORUNUR (Step 9'da
      //    refine/close onu kullanabilir) — inference'a inmez.
      if (assembly.status === "needs_split") {
        const result = this.#needsSplitResult(sessionId, assembly);
        await this.#retainOrCleanup(sessionId, workspace, sessionDir, result);
        return result;
      }

      // ── inference (spec 34) — süreç-tek coordinator, TAM AMIR tek dispatch ─
      // `assembly.messages` ölçülen mesajların KENDİSİ — dispatch byte-bayt
      // aynen taşır (yeniden derleme/ölçüm YOK; spec 30/32 invariantı).
      const runOptions: InferenceRunOptions = {
        maxOutputTokens: assembly.outputReserveTokens,
        contextTier: assembly.selectedTierTokens,
      };
      if (request.reasoningEffort !== undefined) {
        runOptions.reasoningEffort = request.reasoningEffort;
      }
      if (request.signal !== undefined) {
        runOptions.signal = request.signal;
      }
      const dispatched = await this.#coordinator.dispatch({
        ownerId: sessionId,
        messages: assembly.messages,
        options: runOptions,
      });

      // ── inference_busy (spec 36/66): GEÇERLİ compact sonuç; workspace
      //    KORUNUR (imha YOK — Step 9'da refine/close onu kullanacak).
      //    (shutdown kazandıysa koruma DEĞİL beklenen self-cleanup + red.) ──
      if (dispatched.status === "inference_busy") {
        const result = this.#busyResult(sessionId, dispatched.conflict, assembly);
        await this.#retainOrCleanup(sessionId, workspace, sessionDir, result);
        return result;
      }

      // ── strict worker parse (spec 38) — yalnız `result.content` ──────────
      // Markdown düzeltme/regex/ikinci inference YOK (Step 4 sıkılığı).
      const workerResult = this.#workerContract.parseResult(dispatched.result.content);

      // ── workspace uygulaması (spec 40) — TAMAMEN tek çağrı ───────────────
      // Workspace Manager tek semantik güvenlik otoritesidir; TaskService
      // search stringi ön-doğrulamaz, diff hesaplamaz, dosya yazmaz.
      const applyResult = await workspace.applyPatchSet(workerResult);

      const result = this.#completedResult(sessionId, workerResult, applyResult, dispatched.result.usage, assembly);
      await this.#retainOrCleanup(sessionId, workspace, sessionDir, result);
      return result;
    } catch (err) {
      // `#retainOrCleanup`'ın sonuçları (shutting_down / task_cleanup_failed)
      // kendi temizliğini ZATEN await'ledi (tek-sahiplik) — workspace
      // ÇİFT-imha edilemez: aynı hata aynen yayılır.
      if (
        err instanceof SplashTaskError &&
        (err.kind === "shutting_down" || err.kind === "task_cleanup_failed")
      ) {
        throw err;
      }
      // Sonuç korunamadan iş hata verdi (spec 73): workspace imha edilir,
      // boş dizinler rmdir ile gider. `inference_busy` ve `needs_split`
      // bu yolun dışındadır (geçerli sonuç; yukarıda korunur).
      await this.#cleanupAfterFailure(workspace, sessionDir, err);
      // Bağlam katmanının girdi sözleşmesi hatası (açık bağlam kademesi
      // runtime tavanını aşıyor) görev katmanının tip'li girdi hatası olarak
      // yüzeye çıkar; diğer bağlam hataları (unsafe_path/assembly_failed)
      // aynen yayılır — MCP wire'i onları ayrı haritalar.
      if (err instanceof ContextAssemblyError && err.kind === "invalid_input") {
        throw new SplashTaskError("invalid_input", err.message, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Kapatım yaşam döngüsü (spec 69):
   *   1. yeni görev kabul edilmez (`#disposed` — ilk await'ten ÖNCE),
   *   2. shutdown ÖNCESİ başlayan TÜM in-flight görevler güvenli terminal
   *      yollarına ulaşıncaya KADAR BEKLENİR (fire-and-forget YOK);
   *      settlement'lar SINIFLANDIRILIR: bir in-flight görevin self-cleanup'ı
   *      başarısız olduysa (`task_cleanup_failed`) veya kanıtlanamaz bir
   *      lifecycle redi varsa, shutdown temizliği BAŞARISIZ sayılır —
   *      `allSettled` redleri görmezden gelinmez;
   *   3. kayıt defterindeki (dispose ÖNCESİ korunan) TÜM worktree'ler
   *      imha edilir (sıralı) — in-flight cleanup hatası olsa bile HER
   *      korunan görev denenir (erken dönüş YOK; best-effort tam kapatım);
   *   4. boşalan Step 6 session dizinleri `rmdir` ile kaldırılır
   *      (geniş `rm -rf <outputRoot>/sessions` YASAK — spec 69/75),
   *   5. kayıt defteri temizlenir.
   *
   * Sahiplik deterministik (çift-imha YOK): in-flight, henüz korunmamış
   * görevin shutdown temizliği KENDİSİNEDİR; korunan görevin imhası
   * dispose'tadır — aynı workspace TEK tarafça imha edilir.
   *
   * Adım 2 veya 3'te bir temizlik başarısızsa `dispose()` GÜVENLİ tip'li
   * `task_cleanup_failed` ile REDDEDİLİR (kaynak/cause yüzeye taşınmaz);
   * orhan workspace "başarılı temizlik" olarak ASLA raporlanmaz.
   * Crash kurtarması Step 9'a aittir (spec 72) — burada yok.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    // 1) Herhangi bir await'ten ÖNCE: artık yeni görev başlatılamaz.
    this.#disposed = true;
    // 2) Shutdown'dan önce başlayan tüm in-flight görevler terminale
    //    (koruma / self-cleanup) ulaşıncaya kadar bekle; red nedenlerini
    //    incele — cleanup hatası dispose'a YAYILIR (yutma YOK).
    let cleanupFailed = false;
    if (this.#inFlight.size > 0) {
      const settlements = await Promise.allSettled(this.#inFlight);
      for (const settlement of settlements) {
        if (settlement.status === "rejected" && inFlightRejectionFailsShutdown(settlement.reason)) {
          cleanupFailed = true;
        }
      }
    }
    // 3) Dispose öncesi korunan görevler: imha sahibi dispose'tur.
    //    In-flight cleanup hatası erken dönüş YAPMAZ — her korunan görev
    //    için destroy + dizin temizliği denenir (sıralı, best-effort tam).
    const tasks = [...this.#active.values()];
    this.#active.clear();

    for (const task of tasks) {
      let destroyFailed = false;
      try {
        await task.workspace.destroy();
      } catch {
        destroyFailed = true; // workspace dizini kalabilir — kullanıcının incelemesi için
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

  /**
   * Turun terminal yolu — sahiplik TETİĞİ (tek sahip; çift-imha YOK):
   * - dispose ÖNCESİ biten → kayıt defterinde KORUNUR (canlı — Step 9'da
   *   refine/close kullanır); imhayı `dispose()` yapar.
   * - dispose SONRASI biten → kayıt defterine GİRMEZ; bu çalışma kendi
   *   temizliğini **await'ler** (fire-and-forget YOK, hata YUTULMAZ):
   *   temizlik başarılı → görev `shutting_down` ile REDDEDİLİR (shutdown
   *   kazandıysa görev ASLA başarıyla çözülmez); temizlik hata →
   *   `task_cleanup_failed` ÖNCELİKLİ yayılır.
   */
  async #retainOrCleanup(
    sessionId: string,
    workspace: Workspace,
    sessionDir: string,
    result: CompactResult,
  ): Promise<void> {
    if (this.#disposed) {
      await this.#cleanupAfterFailure(workspace, sessionDir, null);
      throw new SplashTaskError("shutting_down", "Splash is shutting down");
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

  /**
   * `inference_busy` placeholder sonucu (spec 37): inference çalışmadı →
   * token hakedişi SIFIR; bağlam telemetrisi assembler'ınkindir (bütçe
   * seçimi dispatch ÖNCESİ tamamlandı). PID/komut/yol/içerik YOK;
   * workspace korunduğu için sonradan refine/close (Step 9) aynı
   * oturumu kullanabilir.
   */
  #busyResult(
    sessionId: string,
    conflict: InferenceConflict,
    assembly: Extract<AssembledContext, { status: "ready" }>,
  ): CompactResult {
    const context: CompactContextMetadata = {
      runtimeMaxTokens: assembly.runtimeMaxTokens,
      inputTokens: 0, // model çağrılmadı — hakediş icat edilmez
      outputReserveTokens: assembly.outputReserveTokens,
      selectedContextTier: assembly.selectedContextTier,
      truncatedReadonlyContext: assembly.truncatedReadonlyContext,
    };
    return {
      sessionId,
      round: 1, // her yeni oturum 1. turdur (spec 50)
      status: "inference_busy",
      baseStatus: "fresh", // her yeni oturum yapısal olarak fresh (spec 49)
      rulesSource: "none", // Step 8 kurallar; Step 7: YOK (spec 51)
      context,
      inference: { conflict },
      summary: "Inference is temporarily unavailable; no worker generation was run.",
      filesChanged: [],
      diffStats: { files: 0, insertions: 0, deletions: 0 },
      validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
      warnings: [...assembly.warnings],
      usage: { in: 0, out: 0 },
    };
  }

  /**
   * `needs_split` turu (spec 32): zorunlu bağlam tavana sığmadı — model
   * ÇAĞRILMADI (hakediş SIFIR), bileştirilme/kısılma YOK; workspace
   * KORUNUR. `split_hint` kaynak içerik taşımaz — yalnız sayılar + yol adları.
   */
  #needsSplitResult(
    sessionId: string,
    needsSplit: Extract<AssembledContext, { status: "needs_split" }>,
  ): CompactResult {
    return {
      sessionId,
      round: 1, // her yeni oturum 1. turdur (spec 50)
      status: "needs_split",
      baseStatus: "fresh", // tur denetimi ÖNCESİ — stale olsaydı `stale_base` olurdu
      rulesSource: "none", // Step 8 kurallar; Step 7: YOK (spec 51)
      context: {
        runtimeMaxTokens: needsSplit.runtimeMaxTokens,
        inputTokens: 0, // model çağrılmadı — hakediş icat edilmez
        outputReserveTokens: needsSplit.outputReserveTokens,
        selectedContextTier: needsSplit.selectedContextTier,
        truncatedReadonlyContext: false,
      },
      summary: NEEDS_SPLIT_SUMMARY,
      filesChanged: [],
      diffStats: { files: 0, insertions: 0, deletions: 0 },
      validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
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
   * Tamamlanan turun compact sonucu (spec 31/41-48/51/52):
   * - `context.input_tokens` = assembler'ın TAM preflight ölçüsü
   *   (`usage.inputTokens` ASLA değil — runtime sayımı dispatch sonrası,
   *   ayrıca şablon etkisiyle farklı olabilir; telemetri dispatch ÖNCESİ
   *   kesin olmalı);
   * - `usage` = runtime'ın KENDİ hakedişi (ayrı gerçeğe ayrı alan);
   * - `filesChanged`/`diffStats`/`validation` = workspace/git otoriter;
   * - KAYNAK İÇERİĞİ YOK (summary = WorkerContract'ın normalize ettiği).
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
    assembly: Extract<AssembledContext, { status: "ready" }>,
  ): CompactResult {
    const status = mapValidationToStatus(applyResult.validation);
    return {
      sessionId,
      round: 1,
      status,
      baseStatus: "fresh",
      rulesSource: "none",
      context: {
        runtimeMaxTokens: assembly.runtimeMaxTokens,
        inputTokens: assembly.inputTokens, // tam preflight ölçüsü (spec 31)
        outputReserveTokens: assembly.outputReserveTokens,
        selectedContextTier: assembly.selectedContextTier,
        truncatedReadonlyContext: assembly.truncatedReadonlyContext,
      },
      summary: redactText(workerResult.summary), // normalize edilen özet + çıktı-tarafı secret scrub (aynı redaksiyon disiplini; kaynak/değişiklik değil)
      filesChanged: [...applyResult.filesChanged], // workspace/git otoriter (spec 45)
      diffStats: {
        files: applyResult.diffStats.files,
        insertions: applyResult.diffStats.insertions,
        deletions: applyResult.diffStats.deletions,
      },
      validation: applyResult.validation, // snippet'lar yok — zaten güvenli sözlük (spec 47)
      warnings: [...assembly.warnings],
      usage: { in: usage.inputTokens, out: usage.outputTokens }, // totalTokens YOK (spec 48)
    };
  }
}

/**
 * `dispose()` in-flight settlement sınıflandırması (fail-closed):
 * - `shutting_down` → GÜVENLİ: self-cleanup BAŞARILI (başarısız olsaydı
 *   neden `task_cleanup_failed` ile YERİNE DOLDURULURDU — bkz. catch bloğu).
 * - `task_cleanup_failed` → TEMİZLİK BAŞARISIZ (shutdown'a yayılır).
 * - diğer `SplashTaskError` (invalid_input/output_root_unsafe/session_conflict)
 *   → GÜVENLİ: workspace oluşturulmadan önce atılır — yetkili temizlik YOK.
 * - sıradan tip'li görev hataları
 *   (Workspace/Coordinator/Backend/WorkerContract/ContextAssembly)
 *   → GÜVENLİ: workspace SONRASI hatanın temizliği başarısız olsaydı, red
 *   nedeni orijinal hata değil `task_cleanup_failed` olurdu — orijinal nedenin
 *   bu yola ulaşması temizliğin tamamlandığının KANITIDIR.
 * - kanıtlanamayan (tanınmayan) red → fail-closed TEMİZLİK BAŞARISIZ.
 *   Ham mesaj/detay hiçbir yere taşınmaz — kamu hatası sabit cümledir.
 */
function inFlightRejectionFailsShutdown(reason: unknown): boolean {
  if (reason instanceof SplashTaskError) {
    return reason.kind === "task_cleanup_failed";
  }
  if (
    reason instanceof WorkspaceError ||
    reason instanceof CoordinatorError ||
    reason instanceof BackendError ||
    reason instanceof WorkerContractError ||
    reason instanceof ContextAssemblyError
  ) {
    return false;
  }
  // Tanınmayan lifecycle redi: güvenli temizlik kanıtlanamıyor → kapatımı
  // başarısız say (orhan workspace "temiz" olarak raporlanmasın).
  return true;
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
