/**
 * Step 6: MCP wire serileştirme sınırı (DESIGN.md §3, 9, 11 madde 6).
 *
 * Bağımsız serileştiriciler yaşar burada (asla karıştırılmaz):
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
 *
 * 3. `serializeCloseResult` (Step 10) — `splash_close` sonucu: YALNIZ
 *    `patch_path` / `files_changed` / `diff_stats` / `summary` /
 *    `base_status` (+ yalnız stale'de `stale_files`). İçerik YOK.
 *
 * 4. `serializeDiffResult` (Step 10) — `splash_diff` sonucu: oluşturulan
 *    kodu taşıyan TEK araç (kasıtlı içerik istisnası) — `diff` modunda ham
 *    unified diff metni; `stat` modunda yalnız `{"diff_stats":{...}}`.
 */

import { BackendError } from "../backend/errors.js";
import { CoordinatorError } from "../backend/InferenceCoordinator.js";
import { redactText } from "../context/redact.js";
import { ContextAssemblyError } from "../context/types.js";
import { SessionError } from "../session/types.js";
import type { SplashCloseResult, SplashDiffResult } from "../session/SessionManager.js";
import { RulesResolutionError } from "../rules/types.js";
import { WorkspaceError } from "../workspace/Workspace.js";
import { INVALID_PATH_PLACEHOLDER } from "../workspace/validate.js";
import { WorkerContractError, type CompactResult } from "../worker/result.js";
import { SplashTaskError } from "./errors.js";

/**
 * Wire'daki `rejected[].file` üst sınırı: 1024 UTF-16 kod birimi (karakter;
 * `String.length`). UTF-8 bayt sayısı kod birimi sayısından az olamadığından
 * bu sınırı aşan yol macOS `PATH_MAX`'ı (1024 bayt) da aşar — gerçek bir
 * dosya olamaz; worker'ın seçtiği sınırsız metin compact sonucu şişiremez.
 */
const MAX_WIRE_REJECTED_FILE_LENGTH = 1024;

/**
 * İz 4 S#11: `rejected[].file` worker'ın seçtiği metindir (path-güvenliğinden
 * geçse bile keyfi). Wire'a çıkmadan sınırlanır + redakte edilir; sınırı aşan
 * → sabit `<invalid-path>` (regex çalışmadan — DoS yüzeyi yok). Yalnız wire
 * dönüşümüdür: kalıcı/iç sonuç ham kalır (kurtarma determinizmi etkilenmez).
 */
function wireRejectedFile(file: string): string {
  if (file.length > MAX_WIRE_REJECTED_FILE_LENGTH) {
    return INVALID_PATH_PLACEHOLDER;
  }
  const redacted = redactText(file);
  return redacted.length > MAX_WIRE_REJECTED_FILE_LENGTH ? INVALID_PATH_PLACEHOLDER : redacted;
}

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
  if (err instanceof RulesResolutionError) {
    return { kind: err.kind, message: err.message };
  }
  if (err instanceof SplashTaskError) {
    return { kind: err.kind, message: err.message };
  }
  // Step 9 oturum katmanı: 6 tip'li hata — hepsi SABİТ güvenli mesaj (spec 12);
  // `cause` (teknik detay) ASLA yüzeye gitmez.
  if (err instanceof SessionError) {
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
        file: wireRejectedFile(rejection.file),
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
    // Step 9 stale-base denetimi üretir: kanonik, dedup'lu, sıralı yollar —
    // kaynak içeriği/mod YOK (spec 37). `fresh`'te alan BİTTİ kalır (spec 55).
    wire.stale_files = [...result.staleFiles];
  }
  return wire;
}

/**
 * `splash_close` sonucu → MCP wire JSON'u (Step 10 spec 10/29; snake_case).
 *
 * Alan alan AÇIK eşleme (`JSON.stringify(result)` YOK): yalnız
 * `patch_path`, `files_changed`, `diff_stats`, `summary`, `base_status` ve
 * YALNIZ `base_status == "stale"` iken `stale_files`. Kaynak/diff/patch
 * içeriği, worker çıktısı, geçmiş, görev, kurallar, repo kökü, workspace
 * yolu, kurtarma durumu — hiçbiri alan DEĞİLDİR.
 */
export function serializeCloseResult(result: SplashCloseResult): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    patch_path: result.patchPath,
    files_changed: [...result.filesChanged],
    diff_stats: {
      files: result.diffStats.files,
      insertions: result.diffStats.insertions,
      deletions: result.diffStats.deletions,
    },
    summary: result.summary,
    base_status: result.baseStatus,
  };
  if (result.baseStatus === "stale") {
    // Stale export ENGELLENMEDİ; orkestratör otomatik UYGULAMAMALI.
    wire.stale_files = [...result.staleFiles];
  }
  return wire;
}

/**
 * `splash_diff` sonucu → MCP text payload'u (Step 10 spec 9).
 *
 * - `diff` modu: ham unified diff metni — sarmalayıcı metadata YOK (boş
 *   diff → `""`). Oluşturulan kodu döndüren TEK MCP aracıdır (kasıtlı,
 *   açık istekle inceleme).
 * - `stat` modu: yalnız `{"diff_stats":{"files","insertions","deletions"}}`
 *   — kaynak/diff içeriği YOK.
 */
export function serializeDiffResult(result: SplashDiffResult): string {
  if (result.mode === "stat") {
    return JSON.stringify({
      diff_stats: {
        files: result.diffStats.files,
        insertions: result.diffStats.insertions,
        deletions: result.diffStats.deletions,
      },
    });
  }
  return result.diff;
}
