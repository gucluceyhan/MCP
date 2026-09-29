/**
 * Step 6: MCP wire serileştirme sınırı (DESIGN.md §3, 9, 11 madde 6).
 *
 * İKİ bağımsız serileştirici yaşar burada (asla karıştırılmaz):
 *
 * 1. `serializeCompactResult` — internal camelCase `CompactResult` →
 *    DESIGN §3 wire vocabulary'si (snake_case). `JSON.stringify(result)`
 *    KULLANILMAZ (camelCase sızdırırdı); her alan açıkça eşlenir.
 *    Koşullu alanlar (DESIGN §3) YALNIZCA anlamlı olduğunda çıkar:
 *      - `inference`  → yalnız `status == "inference_busy"`
 *      - `split_hint` → yalnız `status == "needs_split"`   (Step 7 üretir)
 *      - `stale_files`→ yalnız `base_status == "stale"`    (Step 9 üretir)
 *    `null` ile boşta bırakılmaz — BİTTİ (omit) edilir.
 *
 * 2. `serializeToolError` — bilinen tip'li hatalar → güvenli metadata
 *    (`kind` + sabit `message` + `kind: "http"` için `status`). `cause`,
 *    stack, ham stderr, worker çıktısı, yanıt gövdesi, API anahtarı —
 *    hiçbir bilinen hatada YÜZEYE TAŞINMAZ (DESIGN.md §9): bilinen tipler
 *    `message`'lerini zaten güvenli/sabit üretir; bilinmeyen her şey
 *    `internal_error` / "Internal Splash error" olur (spec 58-59).
 */

import { BackendError } from "../backend/errors.js";
import { CoordinatorError } from "../backend/InferenceCoordinator.js";
import { ContextAssemblyError } from "../context/types.js";
import { WorkspaceError } from "../workspace/Workspace.js";
import { WorkerContractError, type CompactResult } from "../worker/result.js";
import { SplashTaskError } from "./SplashTaskService.js";

/** MCP tool hatası wire formu — güvenli metadata yalnız (spec 58). */
export interface ToolErrorWire {
  /** Kapalı, makine-okunur hata türü (bilinen tip'li sözlük korunur). */
  kind: string;
  /** Güvenli, kısa hata mesajı (kaynak/cause/stderr YOK). */
  message: string;
  /** HTTP durum kodu — yalnız `kind: "http"` backend hatalarında. */
  status?: number;
}

/**
 * Bilinen tip'li hataların güvenli sözlüğü korunur (spec 59); bilinmeyen
 * istisnaların `err.message`'ı ASLA yüzeye taşınmaz (arbitrary payload).
 */
export function serializeToolError(err: unknown): ToolErrorWire {
  if (err instanceof BackendError) {
    const wire: ToolErrorWire = { kind: err.kind, message: err.message };
    // `status` yalnız HTTP durumları için anlamlıdır (spec 58/60).
    if (err.kind === "http" && typeof err.status === "number") {
      wire.status = err.status;
    }
    return wire;
  }
  if (err instanceof CoordinatorError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof WorkspaceError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof WorkerContractError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof ContextAssemblyError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof SplashTaskError) {
    return { kind: err.kind, message: err.message };
  }
  // Bilinmeyen istisna: mesaj/detay ASLA taşınmaz (spec 59).
  return { kind: "internal_error", message: "Internal Splash error" };
}

/**
 * Compact result → MCP wire JSON'u (snake_case; DESIGN §3 vocabulary).
 *
 * Dönen nesne `JSON.stringify` ile tool content'ına dönüştürülür. İçerik
 * alanları (summary dosyası kaynak DEĞİL — worker'ın kısa özeti) dışında
 * kaynak kod, diff, kurallar, bağlam içeriği — hiçbir yapısal alan YOK.
 */
export function serializeCompactResult(result: CompactResult): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    session_id: result.sessionId,
    round: result.round,
    status: result.status,
    base_status: result.baseStatus,
    rules_source: result.rulesSource,
    context: {
      runtime_max_tokens: result.context.runtimeMaxTokens,
      input_tokens: result.context.inputTokens,
      output_reserve_tokens: result.context.outputReserveTokens,
      selected_context_tier: result.context.selectedContextTier,
      truncated_readonly_context: result.context.truncatedReadonlyContext,
    },
    summary: result.summary,
    files_changed: [...result.filesChanged],
    diff_stats: {
      files: result.diffStats.files,
      insertions: result.diffStats.insertions,
      deletions: result.diffStats.deletions,
    },
    validation: {
      edits_requested: result.validation.editsRequested,
      edits_applied: result.validation.editsApplied,
      rejected: result.validation.rejected.map((rejection) => ({
        file: rejection.file,
        edit: rejection.edit,
        reason: rejection.reason,
      })),
    },
    warnings: [...result.warnings],
    usage: { in: result.usage.in, out: result.usage.out },
  };

  // Koşullu alanlar — yalnız anlamlı durumda (DESIGN §3; spec 55):
  if (result.status === "inference_busy") {
    wire.inference = { conflict: result.inference.conflict };
  }
  if (result.status === "needs_split") {
    // Step 7 (Context Assembler) bu durumu üretir: zorunlu bağlam tavana
    // sığmadı — `split_hint` kaynak içerik taşımaz, yalnız sayılar + yol adları.
    wire.split_hint = {
      required_input_tokens: result.splitHint.requiredInputTokens,
      available_max_tokens: result.splitHint.availableMaxTokens,
      output_reserve_tokens: result.splitHint.outputReserveTokens,
      pressure_files: [...result.splitHint.pressureFiles],
      ...(result.splitHint.suggestedGroups === undefined
        ? {}
        : { suggested_groups: result.splitHint.suggestedGroups.map((group) => [...group]) }),
    };
  }
  if (result.baseStatus === "stale") {
    // Step 6 stale üretmez (stale denetimi Step 9'da); burada genel
    // vocabulary korunur — `fresh`'te alan BİTTİ kalır.
    wire.stale_files = [...result.staleFiles];
  }
  return wire;
}
