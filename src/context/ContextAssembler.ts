/**
 * Step 7: Context Assembler (DESIGN.md §2.3, §5, §9, 11 madde 7).
 *
 * Sorumluluk: worker'a gidecek bağlam paketini KUR + TAM ölç + adaptif
 * bütçeye uydur + redakte. SORUMLULUK SINIRI:
 * - JENERASYON YOK: bu modül `run` YAPMAZ (yüzeyinde bile yok) — ölçüm
 *   (`countPromptTokens`/`tokenize`) + durum yenilemesi yapar; jenerasyonu
 *   Inference Coordinator dispatch eder (tek seri kaynak).
 * - git YOK, yazma YOK: düzenlenebilir taraf BİREBİR immutable base
 *   snapshot'ından (`Workspace.readBaseEntry` — bellek, I/O'suz);
 *   salt-okunur taraf CANLI ana ağaçtan salt-okunur fs ile (ContextFs).
 * - Kurallar (Step 8) bu modülde DEĞİLDİR — `rules` hazır string olarak
 *   gelir (Step 7: `undefined`); `rules_soft_budget` yalnız config'te yaşar.
 *
 * Algoritma (deterministik sıra):
 *   1. girdi/override doğrulaması (sabit güvenli mesajlar)
 *   2. `refreshRuntimeInfo` → yetkili tavan (`R`) — başarısızlık tip'li
 *      hata olarak aynen yayılır (backend sorununu icat edilmiş bir duruma
 *      çevrilmez)
 *   3. geçerli tavan = açık kademe override'ı (≤ R; daha büyük →
 *      `invalid_input`) veya `R`
 *   4. görev metni redakte edilir (worker'a redakte EDİLMİŞ form gider)
 *   5. düzenlenebilir bloklar (lexicographic): secret dosya → marker
 *      (içerik girmez); binary → BINARY marker; symlink → metadata; yok →
 *      ABSENT; metin → strict UTF-8 + redaksiyon
 *   6. salt-okunur bloklar (lexicographic): path güvenliği + symlink
 *      kuralları + ENOENT → ABSENT; diğer errno → fail-closed
 *   7. PREFLIGHT (zorunlu: görev + düzenlenebilir): tam ölçü;
 *      `required + pay > tavan` → `needs_split` (BİLEŞTİRİLMEZ, KISILMAZ,
 *      inference'a inmez) + pressure dosyaları (token ölçümü, içerik YOK)
 *   8. kademe seçimi: sığan EN KÜÇÜK kade (64K'ya sığan 128K'a KALKMAZ);
 *      açık override → tek aday (inflation YOK)
 *   9. pay müzakeresi (yalnız açık pay verilmEDİSE): `required + preferred
 *      ≤ seçilen kade` → preferred; değilse min. (Kademeye ASLA çıkılmaz.)
 *   10. TAM paket (zorunlu + salt-okunur) tam ölçülmüş; sığmıyorsa
 *      salt-okunur bloklar LEXICOGRAPHİK SONDAN TAM DOSYA olarak atılır ve
 *      her atımdan sonra YENİDEN TAM ölçülür; ilk sığmaya kadar.
 *      Düzenlenebilir kod ASLA kıpırdamaz — sığmazsa sonuç `needs_split`
 *      olurdu (7'de kanıtlandı).
 *   11. `messages` = ölçülen mesajların KENDİSİ — dispatch byte-bayt aynen
 *      onu taşır (`context.input_tokens` = bu tam ölçü, `usage.in` ASLA değil).
 *
 * Uyarılar SABİТ sözlüktür (kaynak/secret/path/komut YOK) — yalnız olay
 * türü bildirilir.
 */

import path from "node:path";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { BackendError } from "../backend/errors.js";
import type { InferenceMessage, PromptRenderOptions, RuntimeInfo } from "../backend/InferenceBackend.js";
import { buildWorkerMessages } from "../worker/WorkerContract.js";
import { WorkspaceError, type WorkspaceBaseEntry } from "../workspace/Workspace.js";
import {
  hasSymlinkInPath,
  normalizeRepoPath,
  resolveContained,
  symlinkTargetStaysInside,
} from "../workspace/pathSafety.js";
import { isSecretFilePath, redactText, SECRET_FILE_MARKER } from "./redact.js";
import {
  ContextAssemblyError,
  type AssembledContext,
  type ContextAssemblyInput,
  type ContextFs,
  type ContextRuntime,
} from "./types.js";
import type { SelectedContextTier } from "../worker/result.js";

// ── Bağlam blok marker'ları (Step 6'nın simpleContext formatının devamı) ────

/** Düzenli dosya içeriğinin marker'ı (binary → ikame karakteri YOK). */
export const BINARY_CONTENT_MARKER =
  "[BINARY CONTENT OMITTED: modify is unsupported; delete remains possible.]";
/** Sembolik bağlantı metadata'sının öneki (hedef metni takip edilmez). */
export const SYMLINK_MARKER_PREFIX = "[SYMLINK -> ";
/** Tabanda var olmayan seçili yol (worker `create` kullanabilir). */
export const ABSENT_MARKER = "[ABSENT IN IMMUTABLE BASE]";
/** Tabanda temsil edilemeyen tip (dizin/özel nesne). */
export const NOT_REPRESENTABLE_MARKER = "[NOT REPRESENTABLE IN IMMUTABLE BASE]";

// ── Sabit uyarı sözlüğü (kaynak/secret/path YOK) ─────────────────────────────

export const SECRET_FILE_WARNING = "Secret files were omitted from the context.";
export const REDACTION_WARNING = "Sensitive values were redacted from the context.";
export const CONTEXT_REDUCTION_WARNING = "Read-only reference context was reduced to fit the context budget.";
export const NEEDS_SPLIT_WARNING =
  "The required context exceeds the context budget; split the task into smaller files.";

/** Kanonik kademeler → wire etiketi (bilinmeyen değer → `runtime_max`). */
export function labelForTier(tokens: number): SelectedContextTier {
  if (tokens === 65_536) {
    return "64k";
  }
  if (tokens === 131_072) {
    return "128k";
  }
  if (tokens === 196_608) {
    return "192k";
  }
  return "runtime_max";
}

// ── Production fs (varsayılan seam) ──────────────────────────────────────────

const realFs: ContextFs = { lstat, readFile, readlink, realpath };

/** Assembler bağımlılıkları — `fs` isteğe bağlı (varsayılan: node:fs/promises). */
export interface ContextAssemblerDeps {
  /** Süreç-tek backend (coordinator ile paylaşılır); ölçüm yüzeyi. */
  runtime: ContextRuntime;
  /** Test seam: arıza-injection I/O. */
  fs?: ContextFs;
}

interface ContextBlock {
  canonical: string;
  label: "EDITABLE BASE" | "READ-ONLY REFERENCE";
  /** Redakte edilmiş, blok çerçevesi DIŞINDAKİ gövde. */
  body: string;
}

/** `bytes` strict UTF-8 olarak round-trip ediyor mu? (saf, bayt-tam.) */
function isStrictUtf8(bytes: Buffer): boolean {
  return bytes.equals(Buffer.from(bytes.toString("utf8"), "utf8"));
}

/** `err` bir `NodeJS.ErrnoException` ve `code` verilen errno'ya eşit mi? */
function hasErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function blockFor(block: ContextBlock): string {
  return `===== ${block.label}: ${block.canonical} =====\n${block.body}\n===== END ${block.label}: ${block.canonical} =====`;
}

/**
 * Step 7: bağlam paketleyici (sınıf). Tüm yöntemler inşadan sonra durum
 * tutmaz (stateless); tek alanlar = enjekte yüzeyler.
 */
export class ContextAssembler {
  #runtime: ContextRuntime;
  #fs: ContextFs;

  constructor(deps: ContextAssemblerDeps) {
    this.#runtime = deps.runtime;
    this.#fs = deps.fs ?? realFs;
  }

  /**
   * Bağlam paketini kurar (dosya başındaki algoritma).
   *
   * Dönen `AssembledContext`:
   * - `ready` → `messages` dispatch edilecek BİREBİR ölçülen mesajlardır.
   * - `needs_split` → BİLEŞTİRİLMEZ; `split_hint` metadata'sı (kaynak YOK).
   *
   * Hatalar: tip'li `ContextAssemblyError` (güvenli sabit mesaj);
   * `WorkspaceError` / `BackendError` aynen yayılır (zaten güvenli).
   */
  async assemble(input: ContextAssemblyInput): Promise<AssembledContext> {
    // ── 1) girdi / override doğrulaması ─────────────────────────────────
    if (typeof input.task !== "string" || input.task.trim() === "") {
      throw new ContextAssemblyError("invalid_input", "The task must be a non-empty string");
    }
    if (!Number.isInteger(input.minOutputReserve) || input.minOutputReserve <= 0) {
      throw new ContextAssemblyError("invalid_input", "The minimum output reserve must be a positive integer");
    }
    if (
      !Number.isInteger(input.preferredOutputReserve) ||
      input.preferredOutputReserve < input.minOutputReserve
    ) {
      throw new ContextAssemblyError(
        "invalid_input",
        "The preferred output reserve must not be below the minimum reserve",
      );
    }
    let reserve: number = input.minOutputReserve;
    if (input.outputReserveTokens !== undefined) {
      if (
        !Number.isInteger(input.outputReserveTokens) ||
        input.outputReserveTokens < input.minOutputReserve
      ) {
        throw new ContextAssemblyError(
          "invalid_input",
          "The output reserve must be an integer no smaller than the minimum reserve",
        );
      }
      reserve = input.outputReserveTokens;
    }
    let explicitTier: number | null = null;
    if (input.contextTier !== undefined) {
      if (!Number.isInteger(input.contextTier) || input.contextTier <= 0) {
        throw new ContextAssemblyError("invalid_input", "The context tier must be a positive integer");
      }
      explicitTier = input.contextTier;
    }

    // ── 2) yetkili tavan (taze yenileme) ─────────────────────────────────
    let info: RuntimeInfo;
    try {
      info = await this.#runtime.refreshRuntimeInfo(input.signal);
    } catch (err) {
      // Tip'li backend hatası aynen (güvenli mesaj; kök neden orada).
      if (err instanceof BackendError) {
        throw err;
      }
      throw new ContextAssemblyError("assembly_failed", "Refreshing the runtime state failed", { cause: err });
    }
    const runtimeMax = info.maximumContextTokens;
    if (explicitTier !== null && explicitTier > runtimeMax) {
      throw new ContextAssemblyError(
        "invalid_input",
        "The requested context tier exceeds the runtime maximum",
      );
    }
    const effectiveMax = explicitTier ?? runtimeMax;

    // ── 3) görev metni redaksiyonu ───────────────────────────────────────
    const redactedTask = redactText(input.task);
    let taskRedacted = redactedTask !== input.task;

    // ── 4) düzenlenebilir bloklar (immutable base — bellek snapshot'ı) ───
    const warnings: string[] = [];
    let secretFileSeen = false;
    let contentRedacted = false;
    const orderedEditable = [...input.workspace.editablePaths].sort();
    const editableBlocks: ContextBlock[] = [];
    for (const canonical of orderedEditable) {
      let entry: WorkspaceBaseEntry;
      try {
        entry = input.workspace.readBaseEntry(canonical);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          throw err; // zaten güvenli tip'li hata (allow-list/imha/...)
        }
        throw new ContextAssemblyError("assembly_failed", "Reading the editable base failed", { cause: err });
      }
      let body: string;
      if (isSecretFilePath(canonical)) {
        // İÇERİK okunmadan marker (secret dosya politikası): yalnız varlık.
        secretFileSeen = true;
        body = entry.exists ? SECRET_FILE_MARKER : ABSENT_MARKER;
      } else {
        body = this.#editableBody(entry);
        const redacted = redactText(body);
        if (redacted !== body) {
          contentRedacted = true;
        }
        body = redacted;
      }
      editableBlocks.push({ canonical, label: "EDITABLE BASE", body });
    }

    // ── 5) salt-okunur bloklar (canlı ana ağaç — ContextFs) ──────────────
    const orderedReadonly = [...(input.readonlyPaths ?? [])].sort();
    const readonlyBlocks: ContextBlock[] = [];
    for (const canonical of orderedReadonly) {
      const body = await this.#readReadonlyBody(input.workspace.repoRoot, canonical, input.signal);
      const redacted = redactText(body);
      if (redacted !== body) {
        contentRedacted = true;
      }
      if (isSecretFilePath(canonical) && !secretFileSeen) {
        secretFileSeen = true;
      }
      readonlyBlocks.push({ canonical, label: "READ-ONLY REFERENCE", body: redacted });
    }

    // ── mesaj inşası (WorkerContract — saf) ──────────────────────────────
    const renderOptions: PromptRenderOptions = {};
    if (input.reasoningEffort !== undefined) {
      renderOptions.reasoningEffort = input.reasoningEffort;
    }
    if (input.signal !== undefined) {
      renderOptions.signal = input.signal;
    }
    const measure = async (messages: InferenceMessage[]): Promise<number> => {
      try {
        return await this.#runtime.countPromptTokens(messages, renderOptions);
      } catch (err) {
        if (err instanceof BackendError) {
          throw err;
        }
        throw new ContextAssemblyError("assembly_failed", "Measuring the prompt failed", { cause: err });
      }
    };
    const build = (activeReserve: number, activeReadonly: readonly ContextBlock[]): InferenceMessage[] => {
      const context = [...editableBlocks, ...activeReadonly].map(blockFor).join("\n\n");
      return buildWorkerMessages({
        task: redactedTask,
        rules: input.rules,
        context,
        history: input.history,
        outputReserveTokens: activeReserve,
      });
    };

    // ── 6) PREFLIGHT (zorunlu: görev + düzenlenebilir; salt-okunur YOK) ──
    const requiredMessages = build(reserve, []);
    const requiredCount = await measure(requiredMessages);
    if (requiredCount + reserve > effectiveMax) {
      // needs_split: BİLEŞTİRİLMEZ, KISILMAZ, inference'a inmez.
      const pressureFiles = await this.#pressureFiles(editableBlocks, input.signal);
      warnings.push(NEEDS_SPLIT_WARNING);
      if (secretFileSeen) {
        warnings.push(SECRET_FILE_WARNING);
      }
      if (contentRedacted || taskRedacted) {
        warnings.push(REDACTION_WARNING);
      }
      return {
        status: "needs_split",
        requiredInputTokens: requiredCount,
        availableMaxTokens: effectiveMax,
        outputReserveTokens: reserve,
        runtimeMaxTokens: runtimeMax,
        pressureFiles,
        warnings,
      };
    }

    // ── 7) kademe seçimi (inflation YOK) ─────────────────────────────────
    let candidates: number[];
    if (explicitTier !== null) {
      candidates = [explicitTier];
    } else {
      candidates = [...input.tiers].filter((tier) => tier <= runtimeMax);
      if (!candidates.includes(runtimeMax)) {
        candidates.push(runtimeMax);
      }
      candidates.sort((a, b) => a - b);
    }
    let selectedTier: number | null = null;
    for (const tier of candidates) {
      if (requiredCount + reserve <= tier) {
        selectedTier = tier;
        break;
      }
    }
    if (selectedTier === null) {
      // Yapısal olarak ulaşılmaz (preflight, effectiveMax içinde sığdı ve
      // adaylar effectiveMax'ı içerir); yine de fail-closed.
      throw new ContextAssemblyError("assembly_failed", "Selecting a context tier failed");
    }

    // ── 8) pay müzakeresi (yalnız açık pay YOKSA; kademe KALIR) ──────────
    let finalReserve = reserve;
    if (input.outputReserveTokens === undefined) {
      const preferredMessages = build(input.preferredOutputReserve, []);
      const preferredCount = await measure(preferredMessages);
      if (preferredCount + input.preferredOutputReserve <= selectedTier) {
        finalReserve = input.preferredOutputReserve;
      }
    }

    // ── 9) TAM paket + salt-okunur azaltımı ──────────────────────────────
    let activeReadonly = [...readonlyBlocks];
    let messages = build(finalReserve, activeReadonly);
    let inputTokens = await measure(messages);
    let truncatedReadonly = false;
    while (activeReadonly.length > 0 && inputTokens + finalReserve > selectedTier) {
      // LEXICOGRAPHİK SON (büyük) dosya TAM olarak atılır; yeniden TAM ölçü.
      activeReadonly = activeReadonly.slice(0, -1);
      messages = build(finalReserve, activeReadonly);
      inputTokens = await measure(messages);
    }
    if (activeReadonly.length < readonlyBlocks.length) {
      truncatedReadonly = true;
    }
    // Invariant koruması: atımlar sıfıra iner ise paket, preflight'te
    // sığılmış zorunlu yapıya eşittir → sığar. Yine de fail-closed:
    if (inputTokens + finalReserve > selectedTier || inputTokens > runtimeMax) {
      throw new ContextAssemblyError(
        "assembly_failed",
        "The assembled context exceeds the context budget",
      );
    }

    // ── 10) uyarılar + sonuç ─────────────────────────────────────────────
    if (secretFileSeen) {
      warnings.push(SECRET_FILE_WARNING);
    }
    if (contentRedacted || taskRedacted) {
      warnings.push(REDACTION_WARNING);
    }
    if (truncatedReadonly) {
      warnings.push(CONTEXT_REDUCTION_WARNING);
    }

    return {
      status: "ready",
      messages,
      inputTokens,
      runtimeMaxTokens: runtimeMax,
      outputReserveTokens: finalReserve,
      selectedContextTier: labelForTier(selectedTier),
      selectedTierTokens: selectedTier,
      truncatedReadonlyContext: truncatedReadonly,
      warnings,
    };
  }

  // ── iç yardımcılar ───────────────────────────────────────────────────────

  /** `needs_split` pressure dosyaları: tam tokenize, içerik YOK (en büyük 8). */
  async #pressureFiles(blocks: readonly ContextBlock[], signal: AbortSignal | undefined): Promise<string[]> {
    const sized: Array<{ canonical: string; tokens: number }> = [];
    for (const block of blocks) {
      let tokens = 0;
      try {
        const result = await this.#runtime.tokenize(block.body, { signal });
        tokens = result.count;
      } catch {
        // İpucu metadata'sı danışmaktır: ölçüm hatası raporu bozamaz.
      }
      sized.push({ canonical: block.canonical, tokens });
    }
    sized.sort((a, b) => (b.tokens - a.tokens) || a.canonical.localeCompare(b.canonical));
    return sized.slice(0, 8).map((entry) => entry.canonical);
  }

  /**
   * Bir düzenlenebilir yolun base gövdesi (marker kuralları — Step 6 formatı):
   * yok → ABSENT; binary → BINARY marker; symlink → hedef metadata'sı
   * (İÇERİK ASLA takip edilmez); dizin/özel → meta marker; metin → birebir.
   */
  #editableBody(entry: WorkspaceBaseEntry): string {
    if (!entry.exists) {
      return ABSENT_MARKER;
    }
    if (entry.type === "file") {
      return isStrictUtf8(entry.content) ? entry.content.toString("utf8") : BINARY_CONTENT_MARKER;
    }
    if (entry.type === "symlink") {
      return `${SYMLINK_MARKER_PREFIX}${entry.target}]`;
    }
    return NOT_REPRESENTABLE_MARKER;
  }

  /**
   * Bir salt-okunur yolun CANLI ana-ağaç gövdesi (yol güvenliği zinciri):
   * normalize → containment → symlink ATAL (hiç takip edilmez) → lstat
   * (ENOENT → ABSENT; diğer errno → fail-closed) → link hedefi İÇ içinde
   * (dış/kaçan → `unsafe_path`) → dosya oku (strict UTF-8 / BINARY marker).
   */
  async #readReadonlyBody(
    repoRoot: string,
    canonical: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // Kök kanonik: macOS `/var` → `/private/var` gibi zincirler containment
    // denetimini boşlamasın (pathSafety'nin `canonicalizeOutside` deseni).
    let root: string;
    try {
      root = await this.#fs.realpath(repoRoot);
    } catch {
      root = path.resolve(repoRoot);
    }
    const abs = resolveContained(root, canonical);
    if (abs === null) {
      throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
    }
    if (await hasSymlinkInPath(abs, root, { includeTarget: false, lstatFn: this.#fs.lstat })) {
      throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
    }

    let stat: Stats;
    try {
      stat = await this.#fs.lstat(abs);
    } catch (err) {
      // YALNIZ GERÇEK yokluk "yok"tur; izin/IO/... fail-closed (yokmuş
      // gibi değerlendirilmez — bağlam, ağaçla uyuşmazsa kullanılmaz).
      if (hasErrno(err, "ENOENT")) {
        return ABSENT_MARKER;
      }
      throw new ContextAssemblyError("assembly_failed", "Reading the read-only context failed", { cause: err });
    }

    if (stat.isSymbolicLink()) {
      // Link TAKİP EDİLMEZ (tutarlılık: editable ile aynı metadata kuralı).
      let target: string;
      try {
        target = await this.#fs.readlink(abs);
      } catch (err) {
        throw new ContextAssemblyError("assembly_failed", "Reading the read-only context failed", { cause: err });
      }
      if (!(await symlinkTargetStaysInside(root, abs, target, this.#fs.realpath))) {
        throw new ContextAssemblyError("unsafe_path", "A selected path is an unsafe symlink");
      }
      return `${SYMLINK_MARKER_PREFIX}${target}]`;
    }

    if (isSecretFilePath(canonical)) {
      return "[SECRET FILE CONTENT OMITTED]";
    }
    if (stat.isFile()) {
      let bytes: Buffer;
      try {
        bytes = await this.#fs.readFile(abs);
      } catch (err) {
        throw new ContextAssemblyError("assembly_failed", "Reading the read-only context failed", { cause: err });
      }
      return isStrictUtf8(bytes) ? bytes.toString("utf8") : BINARY_CONTENT_MARKER;
    }
    // Dizin / özel nesne: içerik değil, meta (okunacak dosya yok).
    void signal;
    return NOT_REPRESENTABLE_MARKER;
  }
}
