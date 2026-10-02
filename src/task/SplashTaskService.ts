/**
 * Step 6-9: `splash_task` + `splash_refine` servis katmanı — İNCE ADAPTÖR.
 *
 * Step 9'dan itibaren oturum yaşam döngüsünün TEK yetkili sahibi
 * `SessionManager`'dır (`src/session/SessionManager.ts`):
 *
 *   create → ilk kalıcılık → 1. tur → tur kalıcılığı → RAM önbellek
 *   refine: lazy load + worktree kurtarma + determinizm doğrulaması →
 *   stale denetimi → max-round guard → tur → transactional kalıcılık
 *
 * Bu sınıf KENDİSİNDE orkestrasyon/defter YOKTUR (spec 4: iki rakip kayıt
 * defteri YOK): yalnız süreç-tek `SessionManager`'ı kurar ve
 * `executeTask` / `executeRefine` / `activeTasks` / `dispose` çağrılarını
 * oraya iletir. Step 6'nın geçici in-memory `ActiveTask` defteri BU ADIMDA
 * SessionManager'ın RAM önbelleği ile değiştirildi.
 *
 * SORUMLULUK SINIRI (spec 2/5): BU SINIF ORKESTRASYON SAHİBİ DEĞİLDİR —
 * model, bağlam, workspace, kural, kalıcılık, stale, tur sayısı, kilit,
 * kurtarma ve shutdown kararlarının TÜMÜ `SessionManager` + injected
 * süreç-tek bileşenlerde yaşar.
 *
 * Güvenlik: girdi derin savunması (task/feedback/files/override'lar)
 * `SessionManager`'dadır; bu adaptör yalnız kimliği korur ve iletir.
 */

import type { SplashConfig } from "../config.js";
import type {
  CoordinatedInferenceRequest,
  CoordinatedInferenceResult,
} from "../backend/InferenceCoordinator.js";
import type { RulesResolverLike } from "../rules/types.js";
import type { Workspace, WorkspaceCreateInput } from "../workspace/Workspace.js";
import type {
  AssembledContext,
  ContextAssemblyInput,
  LiveBaseCaptureInput,
  LiveBaseState,
} from "../context/types.js";
import type { WorkerResult } from "../worker/result.js";
import {
  SessionManager,
  type ActiveSessionInfo,
  type SessionManagerDeps,
  type SplashRefineRequest,
  type SplashTaskRequest,
} from "../session/SessionManager.js";
import type { CompactResult } from "../worker/result.js";

// ── Bağımlılık yüzeyi (küçük DI nesnesi; service locator YOK) ────────────────

/**
 * Context Assembler görünümü: `assemble` (tur bağlamı) + `captureLiveBase`
 * (stale ölçümü — Step 9, strict no-follow). Üretime süreç-tek
 * `ContextAssembler` yapısal olarak sağlar; servis KENDİSİ KURMAZ.
 */
export interface ContextAssemblerLike {
  assemble(input: ContextAssemblyInput): Promise<AssembledContext>;
  captureLiveBase(input: LiveBaseCaptureInput): Promise<LiveBaseState>;
}

/**
 * Koordinatör görünümü: yalnız `dispatch`. Üretime süreç-tek
 * `InferenceCoordinator` yapısal olarak sağlar (spec 4).
 */
export interface CoordinatorLike {
  dispatch(request: CoordinatedInferenceRequest): Promise<CoordinatedInferenceResult>;
}

/** Worker Contract görünümü: strict çıktı parseı (saf). */
export interface WorkerContractLike {
  parseResult(raw: string): WorkerResult;
}

/**
 * Workspace fabrikası: üretime `createGitWorktreeWorkspace` (Step 5).
 * Testler sahte/instrument edilmiş fabrika enjekte edebilir.
 */
export type WorkspaceFactory = (input: WorkspaceCreateInput) => Promise<Workspace>;

export interface SplashTaskServiceDeps {
  /** Ortamdan yüklenmiş yapılandırma (outputRoot, repoRoot, context bütçesi, maxRounds). */
  config: SplashConfig;
  /** Sürecin TEK Inference Coordinator'ı (spec 4) — istek/session başına YOK. */
  coordinator: CoordinatorLike;
  /** Sürecin TEK Context Assembler'ı (Step 7+9) — istek başına YOK. */
  contextAssembler: ContextAssemblerLike;
  /** Sürecin TEK Worker Contract'ı (Step 4) — istek başına YOK. */
  workerContract?: WorkerContractLike;
  /** Sürecin TEK Rules Resolver'ı (Step 8) — yalnız YENİ görev kullanır. */
  rulesResolver?: RulesResolverLike;
  /** Workspace fabrikası (varsayılan: Step 5 `createGitWorktreeWorkspace`). */
  createWorkspace?: WorkspaceFactory;
  /** Kriptografik oturum kimliği (varsayılan: `crypto.randomUUID`). */
  newSessionId?: () => string;
  /** MCP sürecinin CWD'si — repository keşfinin başlangıç noktası. */
  processCwd?: () => string;
}

// API uyumu: istek/görünüm tipleri SessionManager'dan re-export edilir.
export type { SplashTaskRequest, SplashRefineRequest, ActiveSessionInfo } from "../session/SessionManager.js";
// Geriye uyum: Step 6-7 import yüzeyi (testler + `wire.ts` buradan alır).
export { SplashTaskError, type SplashTaskErrorKind } from "./errors.js";

// ── Servis ───────────────────────────────────────────────────────────────────

export class SplashTaskService {
  #manager: SessionManager;

  constructor(deps: SplashTaskServiceDeps) {
    const managerDeps: SessionManagerDeps = {
      config: deps.config,
      coordinator: deps.coordinator,
      contextAssembler: deps.contextAssembler,
      workerContract: deps.workerContract,
      rulesResolver: deps.rulesResolver,
      createWorkspace: deps.createWorkspace,
      newSessionId: deps.newSessionId,
      processCwd: deps.processCwd,
    };
    this.#manager = new SessionManager(managerDeps);
  }

  /** Runtime kapatılmış mı? (dispose sonrası yeni görev/refine reddedilir.) */
  get disposed(): boolean {
    return this.#manager.disposed;
  }

  /**
   * RAM önbellekteki açık oturumlar (yalnızca test/diagnosis — spec 160:
   * listeleme MCP aracı YOK).
   */
  activeTasks(): readonly ActiveSessionInfo[] {
    return this.#manager.activeSessions();
  }

  /**
   * Bir `splash_task` çağrısını uçtan uca yürütür ve KALICI oturum açar
   * (yaşam döngüsü `SessionManager`'da): sonuç = `CompactResult`.
   */
  executeTask(request: SplashTaskRequest): Promise<CompactResult> {
    return this.#manager.createTask(request);
  }

  /**
   * Bir `splash_refine` çağrısını uçtan uca yürütür (spec 19-20):
   * lazy load + kurtarma → stale → max-round → tur → kalıcılık.
   */
  executeRefine(request: SplashRefineRequest): Promise<CompactResult> {
    return this.#manager.refine(request);
  }

  /**
   * Step 9 kapatım yaşam döngüsü (spec 128-131): yeni iş reddedilir,
   * in-flight çalışmalara BEKLENİR, RAM temizlenir; KALICI OTURUMLARA
   * DOKUNULMAZ (worktree/sessions silinmez — imha Step 10 `splash_close`).
   */
  dispose(): Promise<void> {
    return this.#manager.dispose();
  }
}
