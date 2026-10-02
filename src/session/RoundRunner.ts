/**
 * Step 9: paylaşımlı tur (round) yürütücüsü (spec 134-136, 284).
 *
 * `splash_task` (1. tur) ve `splash_refine` (N. tur) AYNI üretim pipeline'ını
 * yürütür — iki ayrı kopya YOK (spec 284: "One common round pipeline"):
 *
 *   ContextAssembler.assemble
 *   → [needs_split?] → sonuç
 *   → InferenceCoordinator.dispatch (süreç-tek; ≤ 1 çağrı, spec 136)
 *   → [inference_busy?] → sonuç
 *   → WorkerContract.parse (strict)
 *   → Workspace.applyPatchSet (tam ikame)
 *   → sonuç
 *
 * SORUMLULUK SINIRI (spec 5/135): bu modül persistence, stale karar,
 * tur sayısı, geçmiş ya da oturum durumu BİLMEZ. Sadece yukarıdaki beş
 * adımı (injected süreç-tek bileşenler üzerinden) yürütür ve sonucu
 * ayrım-çıkarımlı (discriminated) bir birleşim olarak döndürür;
 * `SessionManager` onları `CompactResult`'a çevirir ve kalıcığa taşır.
 *
 * Hatalar: pipeline'ın tip'li hataları (Workspace/Coordinator/Backend/
 * WorkerContract/ContextAssembly) AYNEN yayılır — caller (SessionManager)
 * oturum yaşam döngüsü kararlarını (kurtarma, temizlik, koruma) verir.
 */

import type {
  CoordinatedInferenceRequest,
  CoordinatedInferenceResult,
  InferenceConflict,
} from "../backend/InferenceCoordinator.js";
import type { InferenceRunOptions, InferenceUsage, ReasoningEffort } from "../backend/InferenceBackend.js";
import type { WorkerResult } from "../worker/result.js";
import type { RulesSource } from "../worker/result.js";
import type { ResolvedRules } from "../rules/types.js";
import type {
  AssembledContext,
  ContextAssemblyInput,
  ContextHistoryMessage,
} from "../context/types.js";
import type { SelectedContextTier } from "../worker/result.js";
import type { Workspace, WorkspaceApplyResult } from "../workspace/Workspace.js";

// ── Görünüm arayüzleri (küçük DI; service locator YOK) ──────────────────────

/**
 * Koordinatör görünümü: yalnız `dispatch`. Süreç-tek `InferenceCoordinator`
 * yapısal olarak sağlar; testler instrument edilmiş instance enjekte eder.
 */
export interface RoundCoordinator {
  dispatch(request: CoordinatedInferenceRequest): Promise<CoordinatedInferenceResult>;
}

/**
 * Context Assembler görünümü: `assemble` (tur bağlamı) + `captureLiveBase`
 * (stale ölçümü). Süreç-tek `ContextAssembler` yapısal olarak sağlar.
 */
export interface RoundContextAssembler {
  assemble(input: ContextAssemblyInput): Promise<AssembledContext>;
}

/** Worker Contract görünümü: strict çıktı parseı (saf). */
export interface RoundWorkerContract {
  parseResult(raw: string): WorkerResult;
}

/**
 * Tek bir üretim turunun girdisi — tüm değerler caller (SessionManager)
 * tarafından hazırdır:
 * - `ownerId`: oturum kimliği (coordinator single-flight kimliği).
 * - `workspace`: immutable tabanın kaynağı (`readBaseEntry`) + uygulayıcı.
 * - `resolvedRules`: oturum açılışında BİR KERE çözülüp pin'lenmiş kurallar
 *   (refine'de ASLA yeniden çözülmez — spec 22).
 * - `history`: sınıflandırılmış rafine-geçmişi (1. turda `[]`).
 * - bütçe/tier/pay/reserve + dispatch seçenekleri: config + pinned seçenek.
 */
export interface RoundInput {
  ownerId: string;
  task: string;
  workspace: Workspace;
  readonlyPaths: readonly string[];
  resolvedRules: ResolvedRules;
  rulesSoftBudget: number;
  history: readonly ContextHistoryMessage[];
  tiers: readonly number[];
  minOutputReserve: number;
  preferredOutputReserve: number;
  contextTier?: SelectedContextTier;
  outputReserveTokens?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

/**
 * Tur sonucu — ayrım-çıkarımlı birleşim:
 * - `needs_split`: zorunlu bağlam tavana sığmadı; model ÇAĞRILMADI (spec 32/93).
 * - `inference_busy`: inference kaynağı meşgul; model ÇAĞRILMADI (spec 36/137).
 * - `generated`: worker jenerasyonu + workspace uygulaması TAMAMLANDI.
 */
export type RoundOutcome =
  | {
      kind: "needs_split";
      needsSplit: Extract<AssembledContext, { status: "needs_split" }>;
      rulesSource: RulesSource;
    }
  | {
      kind: "inference_busy";
      conflict: InferenceConflict;
      assembly: Extract<AssembledContext, { status: "ready" }>;
      rulesSource: RulesSource;
    }
  | {
      kind: "generated";
      workerResult: WorkerResult;
      applyResult: WorkspaceApplyResult;
      usage: InferenceUsage;
      assembly: Extract<AssembledContext, { status: "ready" }>;
      rulesSource: RulesSource;
    };

export interface RoundRunner {
  /** Bir turu uçtan uca yürütür (tek dispatch garantisi, spec 136). */
  run(input: RoundInput): Promise<RoundOutcome>;
}

/**
 * Paylaşımlı tur yürütücüsü. Konstrüksiyon saf (I/O YOK) — süreç-tek
 * bileşenler injected olarak verilir; istek başına koordinatör/assembler
 * YOK (spec 4/256-257).
 */
export class DefaultRoundRunner implements RoundRunner {
  #coordinator: RoundCoordinator;
  #contextAssembler: RoundContextAssembler;
  #workerContract: RoundWorkerContract;

  constructor(deps: {
    coordinator: RoundCoordinator;
    contextAssembler: RoundContextAssembler;
    workerContract: RoundWorkerContract;
  }) {
    this.#coordinator = deps.coordinator;
    this.#contextAssembler = deps.contextAssembler;
    this.#workerContract = deps.workerContract;
  }

  async run(input: RoundInput): Promise<RoundOutcome> {
    // ── bağlam (assembler: redaksiyon + tam ölçü + adaptif bütçe + azaltma) ──
    const assembly = await this.#contextAssembler.assemble({
      task: input.task,
      workspace: input.workspace,
      readonlyPaths: input.readonlyPaths,
      resolvedRules: input.resolvedRules,
      rulesSoftBudget: input.rulesSoftBudget,
      history: input.history,
      tiers: input.tiers,
      minOutputReserve: input.minOutputReserve,
      preferredOutputReserve: input.preferredOutputReserve,
      contextTier: input.contextTier,
      outputReserveTokens: input.outputReserveTokens,
      reasoningEffort: input.reasoningEffort,
      signal: input.signal,
    });

    // ── needs_split: NORMAL sonuç — model çağrılmaz, workspace değişmez ──
    if (assembly.status === "needs_split") {
      return {
        kind: "needs_split",
        needsSplit: assembly,
        rulesSource: input.resolvedRules.source,
      };
    }

    // ── inference (süreç-tek coordinator; ≤ 1 dispatch, spec 136) ─────────
    const runOptions: InferenceRunOptions = {
      maxOutputTokens: assembly.outputReserveTokens,
      contextTier: assembly.selectedTierTokens,
    };
    if (input.reasoningEffort !== undefined) {
      runOptions.reasoningEffort = input.reasoningEffort;
    }
    if (input.signal !== undefined) {
      runOptions.signal = input.signal;
    }
    const dispatched = await this.#coordinator.dispatch({
      ownerId: input.ownerId,
      messages: assembly.messages,
      options: runOptions,
    });

    // ── inference_busy: GEÇERLİ sonuç — model çağrılmadı, workspace değişmez ──
    if (dispatched.status === "inference_busy") {
      return {
        kind: "inference_busy",
        conflict: dispatched.conflict,
        assembly,
        rulesSource: input.resolvedRules.source,
      };
    }

    // ── strict worker parse (Step 4 sıkılığı; düzeltme/ikinci inference YOK) ──
    const workerResult = this.#workerContract.parseResult(dispatched.result.content);

    // ── workspace uygulaması (TAMAMEN tek çağrı; semantik otoritesi workspace) ──
    const applyResult = await input.workspace.applyPatchSet(workerResult);

    return {
      kind: "generated",
      workerResult,
      applyResult,
      usage: dispatched.result.usage,
      assembly,
      rulesSource: input.resolvedRules.source,
    };
  }
}
