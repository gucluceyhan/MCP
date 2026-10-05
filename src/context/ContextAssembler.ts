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
 * - Kurallar (Step 8): `RulesResolver`'in bir kez çözümü (`resolvedRules`)
 *   HAZIR gelir; bu modül onları REDAKTE + SOFT BÜTÇE + güvenli kompaksiyon
 *   disiplininden geçirip worker prompt'una bayt-tam olarak sabitler
 *   (çözüm/keşif — `src/rules` — BURADA YOK; `rulesSoftBudget` config'ten).
 *
 * Algoritma (deterministik sıra):
 *   1. girdi/override doğrulaması (sabit güvenli mesajlar; `rulesSoftBudget`
 *      dahil)
 *   2. `refreshRuntimeInfo` → yetkili tavan (`R`) — başarısızlık tip'li
 *      hata olarak aynen yayılır (backend sorununu icat edilmiş bir duruma
 *      çevrilmez)
 *   3. geçerli tavan = açık SEMBOLİK kademe (`64k`/`128k`/`192k`/
 *      `runtime_max`; `refreshRuntimeInfo` SONRASI token'a çözülür — kanonik
 *      kademe `R`'yi aşıyorsa `invalid_input`, sessizce sıkıştırılmaz) veya
 *      `R`. Provenance (etiket) `TierCandidate`'da taşınır.
 *   4. görev metni redakte edilir (worker'a redakte EDİLMİŞ form gider)
 *   5. düzenlenebilir bloklar (lexicographic): secret dosya → marker
 *      (içerik girmez); binary → BINARY marker; symlink → metadata; yok →
 *      ABSENT; metin → strict UTF-8 + redaksiyon
 *   6. salt-okunur bloklar: HER yol ÖNCE `normalizeRepoPath` (`.git`/`..`/
 *      mutlak/backslash/NUL → `unsafe_path`) + DEDUPE + sort; kök fail-closed
 *      `realpath`; symlink ATAL fail-closed; ENOENT → ABSENT; diğer →
 *      fail-closed
 *   7. KURALLAR (Step 8): belge başına redaksiyon (raw secret ASLA
 *      tokenize/prompt'a girmez) → RULES SOURCE blokları → TAM tokenize
 *      (soft bütçe karşılaştırması); aşım → YALNIZ birebir kopya belgeler
 *      atılır (yeniden TAM ölçü) → hâlâ aşım: benzersiz içerik KORUNUR +
 *      sabit uyarı. `none` → prompt'ta kurallar bloğu YOK.
 *   8. PREFLIGHT (zorunlu: görev + düzenlenebilir + KURALLAR; salt-okunur
 *      YOK): tam ölçü; `required + pay > tavan` → `needs_split`
 *      (BİLEŞTİRİLMEZ, KISILMAZ, inference'a inmez) + pressure dosyaları
 *      (tam blok tokenize, içerik YOK; ölçüm/iptal hatası sahte sıralamaya
 *      dönüştürülmez)
 *   9. TAM bağlam (zorunlu + TÜM salt-okunur) + adaptif kade: en küçük
 *      sığan kade; sığmıyorsa salt-okunur LEXICOGRAPHİK SONDAN TAM DOSYA
 *      atılır + yeniden TAM ölçülür. Düzenlenebilir kod ASLA kıpırdamaz.
 *   10. pay müzakeresi (yalnız açık pay verilmEDİSE): tercih payı YALNIZCA
 *      seçilen kadeye sığıyorsa kullanılır; salt-okunur atılmaz, kade
 *      yükseltilmez. (usable context > preferred reserve)
 *   11. `messages` = ölçülen mesajların KENDİSİ — dispatch byte-bayt aynen
 *      onu taşır (`context.input_tokens` = bu tam ölçü, `usage.in` ASLA değil).
 *
 * Uyarılar SABİT sözlüktür (kaynak/secret/path/komut YOK) — yalnız olay
 * türü bildirilir.
 */

import { lstat, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { noFollowReadFile, StrictReadError } from "../workspace/SafeRepoReader.js";
import { captureStrictLiveExistence, captureStrictLiveFingerprint } from "../workspace/fingerprint.js";
import { BackendError } from "../backend/errors.js";
import type { InferenceMessage, PromptRenderOptions, RuntimeInfo } from "../backend/InferenceBackend.js";
import { buildWorkerMessages, type WorkerHistoryMessage } from "../worker/WorkerContract.js";
import { WorkspaceError, type PathFingerprint, type WorkspaceBaseEntry } from "../workspace/Workspace.js";
import {
  hasSymlinkInPath,
  normalizeRepoPath,
  resolveContained,
  symlinkTargetStaysInside,
} from "../workspace/pathSafety.js";
import { isSecretFilePath, redactText, SECRET_FILE_MARKER } from "./redact.js";
import {
  dedupeRuleDocuments,
  formatRuleDocuments,
  RULES_COMPACTION_WARNING,
  RULES_OVER_BUDGET_WARNING,
} from "./rules.js";
import {
  ContextAssemblyError,
  type AssembledContext,
  type ContextAssemblyInput,
  type ContextFs,
  type ContextHistoryMessage,
  type ContextRuntime,
  type LiveBaseCaptureInput,
  type LiveBaseState,
} from "./types.js";
import type { RuleDocument } from "../rules/types.js";
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

// ── Canlı taban sürüklenme işareti (Step 9/10 stale ölçümü) ─────────────────

/**
 * `captureLiveBase` sentinel parmak izi: düzenlenebilir bir taban yolunun
 * repo içindeki atalarından biri CANLI ağaçta sembolik bağlantı (ör.
 * `src -> elsewhere`) → yol link ÜZERİNDEN ulaşılır; link üzerinden HİÇBİR şey
 * okunmaz/izlenmez, ölçüm bu işarettir. Base modları git modlarıdır
 * (`100644`/`100755`/`120000`/`160000`... ya da `exists:false`) →
 * `fingerprintsEqual` ile HİÇBİR base parmak iziyle eşit olamaz → stale
 * (DESIGN §7.5: tip sürüklenmesi = stale; işletim hatası DEĞİL).
 */
export const SYMLINKED_ANCESTOR_FINGERPRINT: PathFingerprint = Object.freeze({
  exists: true,
  type: "other",
  mode: "symlinked-ancestor",
});

// ── Sabit uyarı sözlüğü (kaynak/secret/path YOK) ─────────────────────────────

export const SECRET_FILE_WARNING = "Secret files were omitted from the context.";
/**
 * Step 8: redaction now covers EVERYTHING that moves to the local model —
 * task, editable base, read-only reference AND the resolved rules — so the
 * warning says "before local-model transfer", not "from the context".
 */
export const REDACTION_WARNING = "Sensitive values were redacted before local-model transfer.";
export const CONTEXT_REDUCTION_WARNING = "Read-only reference context was reduced to fit the context budget.";
/** Step 9: rafine-geçmişi azaltma uyarıları (spec 99) — içerik taşımaz. */
export const HISTORY_REFINEMENT_REDUCTION_WARNING =
  "Older refinement history was reduced to fit the context budget.";
export const HISTORY_WORKER_REDUCTION_WARNING =
  "Previous worker responses were reduced to fit the context budget.";
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

/**
 * Bağlam kade ADAYI — token + KANONİK etiket (BLOCKER 4 provenance).
 * `labelForTier(tokens)` ile tersine türetmek yerine ETİKET adayın
 * kendisinde taşınır: açık `runtime_max` (131072) ≡ `128k` (131072)
 * sayısal değeri AYNI olsa da provenance'ı (etiket) korunur.
 */
export interface TierCandidate {
  tokens: number;
  label: SelectedContextTier;
}

/**
 * Kanonik SEMBOLİK kademe → token (BLOCKER 4). `runtime_max` taze runtime
 * tavanıdır (`refreshRuntimeInfo` SONRASI çözülen `runtimeMax`'a eşit).
 */
function canonicalTierTokens(label: SelectedContextTier, runtimeMax: number): number {
  switch (label) {
    case "64k":
      return 65_536;
    case "128k":
      return 131_072;
    case "192k":
      return 196_608;
    case "runtime_max":
      return runtimeMax;
  }
}

/**
 * `inputTokens + reserve` için en küçük sığan kade (BLOCKER 2).
 * `candidates` token'a ARTAN sıralı olmalı; ilk sığan = en küçük. Hiçbiri
 * sıymıyorsa `null` (çağrı tarafı salt-okunur azaltır). Tek bir saf yardımcı —
 * kademe seçimi mantığı birden fazla döngüye yayılmaz.
 */
function findSmallestFittingTier(args: {
  inputTokens: number;
  reserve: number;
  candidates: readonly TierCandidate[];
}): TierCandidate | null {
  for (const candidate of args.candidates) {
    if (args.inputTokens + args.reserve <= candidate.tokens) {
      return candidate;
    }
  }
  return null;
}

/**
 * Adaptif (açık override YOK) kade aday listesi (BLOCKER 2/4): config
 * kademeleri (≤ runtime max) kanonik etiketle + runtime max `runtime_max`
 * etiketiyle. Aynı token değeri ÇİFT aday üretmez — config kanonik
 * (`128k`) redundant `runtime_max` fallback'ine TERCİH edilir (provenance).
 * Token'a artan sıralı döner.
 */
function automaticTierCandidates(tiers: readonly number[], runtimeMax: number): TierCandidate[] {
  const candidates: TierCandidate[] = [];
  for (const tier of tiers) {
    if (tier <= runtimeMax) {
      candidates.push({ tokens: tier, label: labelForTier(tier) });
    }
  }
  if (!candidates.some((candidate) => candidate.tokens === runtimeMax)) {
    candidates.push({ tokens: runtimeMax, label: "runtime_max" });
  }
  candidates.sort((a, b) => a.tokens - b.tokens);
  return candidates;
}

// ── Production fs (varsayılan seam) ──────────────────────────────────────────

// `readFile` is the shared no-follow safe read (Step 9 spec 50): a regular-file
// read-only reference leaf is read via `open(O_NOFOLLOW)` + same-handle read,
// so a reference path swapped to a symlink between the ancestor/`lstat` checks
// and the content read cannot be followed (outside target never read).
const realFs: ContextFs = { lstat, readFile: noFollowReadFile, readlink, realpath };

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
    // Soft bütçe pozitif tam sayıdır (config load zaten doğruladı; burası
    // savunma derinliği — bozuk bir bütçe politikası sessizce çalışmaz).
    if (!Number.isInteger(input.rulesSoftBudget) || input.rulesSoftBudget <= 0) {
      throw new ContextAssemblyError("invalid_input", "The rules soft budget must be a positive integer");
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
    // Açık kademe override'ı SEMBOLİKTİR (BLOCKER 4): `64k`/`128k`/`192k`/
    // `runtime_max`. Sayısal token `refreshRuntimeInfo` SONRASI çözülür; MCP
    // şeması zaten sayısal/gayrIKANONIK değeri reddetmiştir (savunma derinliği).
    const explicitTier = input.contextTier;

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
    // Açık override'ı SEMBOLİK → token çöz (BLOCKER 4): kanonik kademe
    // runtime max'ı aşıyorsa SESSİZCE SIKIŞTIRILMAZ (`invalid_input`);
    // `runtime_max` her zaman geçerli (kendi tanımı = taze tavan). Provenance
    // (etiket) aday nesnesinde taşınır.
    let explicitCandidate: TierCandidate | null = null;
    if (explicitTier !== undefined) {
      const tokens = canonicalTierTokens(explicitTier, runtimeMax);
      if (explicitTier !== "runtime_max" && tokens > runtimeMax) {
        throw new ContextAssemblyError(
          "invalid_input",
          "The requested context tier exceeds the runtime maximum",
        );
      }
      explicitCandidate = { tokens, label: explicitTier };
    }
    const effectiveMax = explicitCandidate !== null ? explicitCandidate.tokens : runtimeMax;
    // Geçerli tavanın KANONİK etiketi (provenance): adaptif → `runtime_max`;
    // açık override → kendi etiketi. needs_split telemetrisi bunu kullanır
    // (`labelForTier(availableMaxTokens)` ile türetilmez — BLOCKER 5).
    const effectiveMaxLabel: SelectedContextTier =
      explicitCandidate !== null ? explicitCandidate.label : "runtime_max";

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
    // ÖNCE kanonik normalize (BLOCKER 1) + DEDUPE + sort. `normalizeRepoPath`
    // `null` → yol GÜVENLİ DEĞİL (`.git`, `..`, mutlak, backslash, NUL, UNC)
    // → `unsafe_path` (SABİT mesaj; ham yol yüzeye KATILMAZ). Alias'lar
    // (`src/./a.ts` ≡ `src//a.ts` ≡ `src/a.ts`) TEK kanonik yol → TEK blok.
    const readonlySeen = new Set<string>();
    const orderedReadonly: string[] = [];
    for (const raw of input.readonlyPaths ?? []) {
      const canonical = normalizeRepoPath(raw);
      if (canonical === null) {
        throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
      }
      if (!readonlySeen.has(canonical)) {
        readonlySeen.add(canonical);
        orderedReadonly.push(canonical);
      }
    }
    orderedReadonly.sort();

    // Kanonik kök (fail-closed, BLOCKER 1): `realpath` başarısızsa sözdizisel
    // fallback YOK — workspace kök zaten mevcut/geçerli; hata abnormal.
    const readonlyBlocks: ContextBlock[] = [];
    if (orderedReadonly.length > 0) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await this.#fs.realpath(input.workspace.repoRoot);
      } catch (err) {
        throw new ContextAssemblyError("assembly_failed", "Reading the read-only context failed", { cause: err });
      }
      for (const canonical of orderedReadonly) {
        const body = await this.#readReadonlyBody(canonicalRoot, canonical, input.signal);
        const redacted = redactText(body);
        if (redacted !== body) {
          contentRedacted = true;
        }
        if (isSecretFilePath(canonical) && !secretFileSeen) {
          secretFileSeen = true;
        }
        readonlyBlocks.push({ canonical, label: "READ-ONLY REFERENCE", body: redacted });
      }
    }

    // ── 7) KURALLAR (Step 8) — redaksiyon + soft bütçe + güvenli kompaksiyon ──
    // Resolver'ın bayt-tam belgeleri burada REDAKTE edilir: raw secret
    // değerler tokenizer'a, ölçüme veya prompt'a ASLA ulaşmaz (DESIGN.md §9).
    // Soft bütçe aşımında TEK izinli kompaksiyon = birebir kopya belgeler;
    // benzersiz kural malzemesi ASLA silinmez (aşım yalnız bildirilir).
    // `none` (boş belgeler) → prompt'ta kurallar bloğu YOK.
    let rulesText = "";
    let rulesRedacted = false;
    let rulesCompacted = false;
    let rulesOverBudget = false;
    let redactedDocuments: RuleDocument[] = [];
    for (const doc of input.resolvedRules?.documents ?? []) {
      const redacted = redactText(doc.content);
      if (redacted !== doc.content) {
        rulesRedacted = true;
      }
      // Redaksiyon placeholder üretir; normalde boşluk-tek'e düşmez —
      // yine de kuralsız içerik bloğa girmesin (defansif, içerik dokunmaz).
      if (redacted.trim().length > 0) {
        redactedDocuments.push({ source: doc.source, content: redacted });
      }
    }
    if (redactedDocuments.length > 0) {
      rulesText = formatRuleDocuments(redactedDocuments);
      let rulesTokens = await this.#measureRules(rulesText, input.signal);
      if (rulesTokens > input.rulesSoftBudget) {
        const deduped = dedupeRuleDocuments(redactedDocuments);
        if (deduped.removed > 0) {
          rulesCompacted = true;
          redactedDocuments = deduped.kept;
          rulesText = formatRuleDocuments(redactedDocuments);
          // Kompaksiyonun etkisi KESİN olmalı → yeniden TAM ölç.
          rulesTokens = await this.#measureRules(rulesText, input.signal);
        }
        if (rulesTokens > input.rulesSoftBudget) {
          // Benzersiz içerik korunur; soft bütçe (yumuşak) aşım yalnız bildirilir.
          rulesOverBudget = true;
        }
      }
    }

    // ── 7b) rafine-geçmişi redaksiyonu (Step 9, spec 96-98) ──────────────
    // Geçmiş içeriği (geri bildirim + validation + önceki worker sonucu) yerel
    // modele gitmeden AYNI deterministik redaktörden geçer. KAYITLI yetkili
    // `WorkerResult` MÜDAHALE EDİLMEZ (spec 98): burada salt içerik stringi
    // yeniden kurulur; taze kopya döner. Boş geçmiş → boşa küsur ölçümsüz no-op.
    let historyRedacted = false;
    const redactedHistory: ContextHistoryMessage[] = (input.history ?? []).map((message) => {
      const content = redactText(message.content);
      if (content !== message.content) {
        historyRedacted = true;
      }
      return { ...message, content };
    });
    // Zorunlu (preflight) geçmiş = YALNIZ korumalı mesajlar (güncel geri
    // bildirim + son validation; spec 92). İsteğe bağlı eski geçmiş preflight'a
    // girmez — sığma denetimi onları içermez.
    const protectedHistory: ContextHistoryMessage[] = redactedHistory.filter((m) => m.protected);

    // ── 8) mesaj inşası (WorkerContract — saf) ────────────────────────────
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
    const build = (
      activeReserve: number,
      activeReadonly: readonly ContextBlock[],
      activeHistory: readonly ContextHistoryMessage[],
    ): InferenceMessage[] => {
      const context = [...editableBlocks, ...activeReadonly].map(blockFor).join("\n\n");
      // Redakte + bütçelenmiş kurallar: worker'a byte-bayt aynen gider
      // (boş string → WorkerContract PROJECT RULES bloğunu YOK sayar). Geçmiş
      // mesajları `kind`/`protected` taşır ama modele YALNIZ rol+içerik gider;
      // redaksiyon yukarıda (7b) yapıldı, burada salt harita.
      const workerHistory: WorkerHistoryMessage[] = activeHistory.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      return buildWorkerMessages({
        task: redactedTask,
        rules: rulesText,
        context,
        history: workerHistory,
        outputReserveTokens: activeReserve,
      });
    };

    // ── 8) PREFLIGHT — zorunlu bağlam (görev + düzenlenebilir + KURALLAR +
    //    KORUMALI rafine-geçmişi; salt-okunur YOK, isteğe bağlı eski geçmiş YOK)
    // Zorunlu bağlam + pay tavana sığmıyorsa görev TEMELDE çalışamaz →
    // needs_split. (BLOCKER 2: kade seçimi BURALARA AİT DEĞİLDİR — tam bağlam
    // karar verir; zorunlu bağlam yalnız "görev çalışabilir mi?" sorusunu
    // cevaplar ve tier'ı kalıcı olarak seçmez.) Step 9 (spec 92): korumalı
    // geçmiş (güncel geri bildirim + son validation) ZORUNLUDUR; eski geçmiş ve
    // salt-okunur preflight'a girmez.
    const requiredMessages = build(reserve, [], protectedHistory);
    const requiredCount = await measure(requiredMessages);
    if (requiredCount + reserve > effectiveMax) {
      // needs_split: BİLEŞTİRİLMEZ, KISILMAZ, inference'a inmez.
      const pressureFiles = await this.#pressureFiles(editableBlocks, input.signal);
      warnings.push(NEEDS_SPLIT_WARNING);
      if (secretFileSeen) {
        warnings.push(SECRET_FILE_WARNING);
      }
      if (contentRedacted || taskRedacted || rulesRedacted) {
        warnings.push(REDACTION_WARNING);
      }
      if (rulesCompacted) {
        warnings.push(RULES_COMPACTION_WARNING);
      }
      if (rulesOverBudget) {
        warnings.push(RULES_OVER_BUDGET_WARNING);
      }
      return {
        status: "needs_split",
        requiredInputTokens: requiredCount,
        availableMaxTokens: effectiveMax,
        outputReserveTokens: reserve,
        runtimeMaxTokens: runtimeMax,
        selectedContextTier: effectiveMaxLabel,
        pressureFiles,
        warnings,
      };
    }

    // ── 9) TAM bağlam + adaptif tier (BLOCKER 2) + rafine-geçmişi azaltması ──
    // KADE, zorunlu bağlamdan DEĞİL; TAM bağlamdan (görev + düzenlenebilir +
    // TÜM salt-okunur + rafine-geçmişi) seçilir — en küçük sığan kade. Açık
    // override → tek aday (asla üzerine KALKMAZ).
    //
    // Sığmıyorsa AZALTMA SIRASI (spec 87):
    //   1. eski refinement mesajları (korumasız), ESKİDEN İTİBAREN
    //   2. önceki worker yanıtları (assistant), ESKİDEN İTİBAREN
    //   3. salt-okunur referans, lexicographic SON TAM dosya
    //   4. hâlâ sığmıyorsa → needs_split
    // Düzenlenebilir kaynak, pin'li kurallar, GÜNCEL geri bildirim ve SON
    // validation (korumalı) ASLA kıpırdamaz (spec 87/92). Tercih payı için
    // geçmiş YALNIZCA kırpılmaz (spec 88) — azaltma min/explicit pay'a sığmak
    // içindir. Her adımda TAM yeniden ölçü (spec 89); tek `refreshRuntimeInfo`
    // + tek `assemble` çağrısı içinde (spec 90).
    const candidates =
      explicitCandidate !== null
        ? [explicitCandidate]
        : automaticTierCandidates(input.tiers, runtimeMax);
    let activeReadonly = [...readonlyBlocks];
    let activeHistory = [...redactedHistory];
    let historyReducedRefinement = false;
    let historyReducedWorker = false;
    let truncatedReadonly = false;
    let minMessages = build(reserve, activeReadonly, activeHistory);
    let minCount = await measure(minMessages);
    let selectedCandidate = findSmallestFittingTier({ inputTokens: minCount, reserve, candidates });
    while (selectedCandidate === null) {
      let reducedSomething = false;
      // (1) en eski korumasız refinement; (2) en eski önceki worker;
      // (3) salt-okunur; (4) korumalı + zorunlu tek başına → needs_split.
      const oldRefinementIndex = activeHistory.findIndex(
        (m) => m.kind === "refinement" && !m.protected,
      );
      const previousWorkerIndex = activeHistory.findIndex((m) => m.kind === "worker_response");
      if (oldRefinementIndex !== -1) {
        activeHistory = activeHistory.filter((_, idx) => idx !== oldRefinementIndex);
        historyReducedRefinement = true;
        reducedSomething = true;
      } else if (previousWorkerIndex !== -1) {
        activeHistory = activeHistory.filter((_, idx) => idx !== previousWorkerIndex);
        historyReducedWorker = true;
        reducedSomething = true;
      } else if (activeReadonly.length > 0) {
        activeReadonly = activeReadonly.slice(0, -1); // lexicographic SON tam dosya
        truncatedReadonly = true;
        reducedSomething = true;
      }
      if (!reducedSomething) {
        // Sadece korumalı geçmiş + zorunlu bağlam kaldı, yine sığmıyor.
        // Preflight bu kümeyle kontrol etti → yapısal olarak ulaşılmaz; fail-closed.
        throw new ContextAssemblyError(
          "assembly_failed",
          "The assembled context exceeds the context budget",
        );
      }
      minMessages = build(reserve, activeReadonly, activeHistory);
      minCount = await measure(minMessages);
      selectedCandidate = findSmallestFittingTier({ inputTokens: minCount, reserve, candidates });
    }
    if (selectedCandidate === null) {
      throw new ContextAssemblyError("assembly_failed", "Selecting a context tier failed");
    }

    // ── 8) pay müzakeresi (BLOCKER 3: SEÇİLEN kade İÇİNDE; salt-okunur atılmaz)
    // Öncelik: zorunlu düzenlenebilir > salt-okunur > tercih payı. Tercih payı
    // yalnız seçilen kadeye sığıyorsa kullanılır; salt-okunur atılmaz, kade
    // yükseltilmez (usable context > preferred reserve).
    let finalReserve: number;
    let finalMessages: InferenceMessage[];
    let finalCount: number;
    if (input.outputReserveTokens !== undefined) {
      finalReserve = input.outputReserveTokens;
      finalMessages = minMessages;
      finalCount = minCount;
    } else {
      const preferredMessages = build(input.preferredOutputReserve, activeReadonly, activeHistory);
      const preferredCount = await measure(preferredMessages);
      if (preferredCount + input.preferredOutputReserve <= selectedCandidate.tokens) {
        finalReserve = input.preferredOutputReserve;
        finalMessages = preferredMessages;
        finalCount = preferredCount;
      } else {
        finalReserve = input.minOutputReserve;
        finalMessages = minMessages;
        // Invariant: SON ölçüm = dispatch edilecek mesajlar. Preferred
        // ölçüldü ama kullanılmadı → min'i yeniden ölç (byte-bayt eşitlik).
        finalCount = await measure(minMessages);
      }
    }

    // Invariant koruması: final paket seçilen kadeye + runtime tavana sığmalı.
    if (finalCount + finalReserve > selectedCandidate.tokens || finalCount > runtimeMax) {
      throw new ContextAssemblyError(
        "assembly_failed",
        "The assembled context exceeds the context budget",
      );
    }

    // ── 11) uyarılar + sonuç ──────────────────────────────────────────────
    if (secretFileSeen) {
      warnings.push(SECRET_FILE_WARNING);
    }
    if (contentRedacted || taskRedacted || rulesRedacted || historyRedacted) {
      warnings.push(REDACTION_WARNING);
    }
    if (rulesCompacted) {
      warnings.push(RULES_COMPACTION_WARNING);
    }
    if (rulesOverBudget) {
      warnings.push(RULES_OVER_BUDGET_WARNING);
    }
    if (historyReducedRefinement) {
      warnings.push(HISTORY_REFINEMENT_REDUCTION_WARNING);
    }
    if (historyReducedWorker) {
      warnings.push(HISTORY_WORKER_REDUCTION_WARNING);
    }
    if (truncatedReadonly) {
      warnings.push(CONTEXT_REDUCTION_WARNING);
    }

    return {
      status: "ready",
      messages: finalMessages,
      inputTokens: finalCount,
      runtimeMaxTokens: runtimeMax,
      outputReserveTokens: finalReserve,
      selectedContextTier: selectedCandidate.label,
      selectedTierTokens: selectedCandidate.tokens,
      truncatedReadonlyContext: truncatedReadonly,
      warnings,
    };
  }

  /**
   * Immutable tabanın CANLI ana-working-tree ölçümü (Step 9 stale-check'inin
   * salt-okunur yarısı — spec 53: "Do NOT put arbitrary raw filesystem reads
   * directly throughout SessionManager"). SessionManager bu yöntemi çağırır;
   * ham fs okumaları BU modüldedir. Karşılaştırma/MANTIK YAPMAZ (saf karar
   * `session/stale.ts`'tadır) — yalnız güvenli strict yakalamayı taşır.
   * Refine ve close AYNI ölçümü kullanır: stale bir taban close'u ASLA
   * engellemez (DESIGN §7.5) — bu yüzden sürüklenme burada HATA olarak
   * değil, ÖLÇÜM olarak döner.
   *
   * Yol güvenliği zinciri (`#liveBaseTarget`): `normalizeRepoPath`
   * (`.git`/`..`/mutlak/backslash/NUL → `unsafe_path`) → `resolveContained`
   * (containment → `unsafe_path`; kalıcı yollar zaten doğrulanmış — savunma)
   * → atal symlink taraması (fail-closed: belirsiz I/O → `assembly_failed`).
   * Salt-okunur okumalardan TEK farkı: atal SYMLINK hata DEĞİL, sürüklenmedir
   * (ör. `src` → harici dizin) — link üzerinden HİÇBİR şey okunmaz/izlenmez:
   * - taban yolu → `SYMLINKED_ANCESTOR_FINGERPRINT` (hiçbir base parmak
   *   iziyle eşit olamaz → stale);
   * - worker-oluşturulan yol → `true` (varlık link üzerinden doğrulanamaz +
   *   main'de patch hedefi symlink'li dizine düşer → çakışma/stale).
   *
   * Yakalama (spec 45-52, strict):
   * - `basePaths`: `captureStrictLiveFingerprint` — varlık/tip/mod/içerik
   *   SHA-256 (düzenli dosya no-follow okuma; link → hedef metni; dereferans
   *   YOK). `ENOENT`/`ENOTDIR` (önekteki bir bileşen artık dizin değil — yol
   *   var olamaz) → `exists:false`; her başka I/O → `assembly_failed`
   *   (fail-closed; "yok" sayılmaz — spec 47/48/51).
   * - `createdPaths`: `captureStrictLiveExistence` — YALNIZ `lstat` varlık
   *   (içerik ASLA okunmaz — spec 171/266: worker-oluşturulan yolun main'de
   *   var olması yeter). ÇAKIŞMA semantiği: `ENOENT` → `false`; `ENOTDIR`
   *   (önekteki bileşen dizin değil → `create` main'e uygulanamaz) → `true`;
   *   her başka I/O → `assembly_failed`.
   *
   * git YOK (spec 265), saat YOK, yazma YOK, backend çağrısı YOK.
   */
  async captureLiveBase(input: LiveBaseCaptureInput): Promise<LiveBaseState> {
    const baseFingerprints = new Map<string, PathFingerprint>();
    for (const raw of input.basePaths) {
      const target = await this.#liveBaseTarget(input.repoRoot, raw);
      // Atal symlink = sürüklenme: link üzerinden okuma YOK, ölçüm sentinel'dir.
      const fingerprint = target.symlinkedAncestor
        ? SYMLINKED_ANCESTOR_FINGERPRINT
        : await this.#strictCapture(target.absolute);
      baseFingerprints.set(target.absolute, fingerprint);
    }
    const createdExists = new Map<string, boolean>();
    for (const raw of input.createdPaths) {
      const target = await this.#liveBaseTarget(input.repoRoot, raw);
      // Atal symlink: varlık doğrulanamaz (izlenmez) + patch hedefi symlink'li
      // dizine düşer → çakışma (`true` = stale).
      const exists = target.symlinkedAncestor ? true : await this.#strictExistence(target.absolute);
      createdExists.set(target.absolute, exists);
    }
    return { baseFingerprints, createdExists };
  }

  // ── iç yardımcılar ───────────────────────────────────────────────────────

  /**
   * `captureLiveBase`'e özel yol zinciri: normalize → containment → atal
   * symlink taraması (fail-closed). Güvenli değilse `unsafe_path`; atal
   * taramasında belirsiz I/O (EACCES/EIO/ELOOP/...) → `assembly_failed`.
   * Atal SYMLINK hata DEĞİL: `symlinkedAncestor: true` döner (sürüklenme —
   * çağıran link üzerinden hiçbir şey okumaz). Salt-okunur okuma zinciri
   * (`#readReadonlyBody`) bundan etkilenmez — orada atal symlink `unsafe_path`
   * kalır. (`hasSymlinkInPath`'in containment-ihlali `true` dalı burada
   * ulaşılmazdır: `resolveContained` aynı yüklemi önce uygular.)
   */
  async #liveBaseTarget(
    root: string,
    raw: string,
  ): Promise<{ absolute: string; symlinkedAncestor: boolean }> {
    const canonical = normalizeRepoPath(raw);
    if (canonical === null) {
      throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
    }
    const absolute = resolveContained(root, canonical);
    if (absolute === null) {
      throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
    }
    try {
      const symlinkedAncestor = await hasSymlinkInPath(absolute, root, {
        includeTarget: false,
        lstatFn: this.#fs.lstat,
        failClosed: true,
      });
      return { absolute, symlinkedAncestor };
    } catch (err) {
      throw new ContextAssemblyError("assembly_failed", "Reading the live base failed", { cause: err });
    }
  }

  /** Strict canlı parmak izi (spec 45-52); `StrictReadError` → `assembly_failed`. */
  async #strictCapture(absolutePath: string): Promise<PathFingerprint> {
    try {
      return await captureStrictLiveFingerprint(absolutePath, {
        lstat: this.#fs.lstat,
        readlink: this.#fs.readlink,
        readFile: this.#fs.readFile,
      });
    } catch (err) {
      if (err instanceof StrictReadError) {
        throw new ContextAssemblyError("assembly_failed", "Reading the live base failed", { cause: err });
      }
      throw err;
    }
  }

  /** Strict canlı varlık (spec 171/266); `StrictReadError` → `assembly_failed`. */
  async #strictExistence(absolutePath: string): Promise<boolean> {
    try {
      return await captureStrictLiveExistence(absolutePath, { lstat: this.#fs.lstat });
    } catch (err) {
      if (err instanceof StrictReadError) {
        throw new ContextAssemblyError("assembly_failed", "Reading the live base failed", { cause: err });
      }
      throw err;
    }
  }

  /**
   * Kuralların TAM token ölçümü (Step 8 soft bütçe). İptal/backend hatası
   * aynen yayılır (güvenli tip'li sözlük; sahte sayıya dönüştürülmez);
   * diğer her hata fail-closed `assembly_failed` (sabit güvenli mesaj).
   */
  async #measureRules(content: string, signal: AbortSignal | undefined): Promise<number> {
    try {
      const result = await this.#runtime.tokenize(content, { signal });
      return result.count;
    } catch (err) {
      if (err instanceof BackendError) {
        throw err;
      }
      throw new ContextAssemblyError("assembly_failed", "Measuring the project rules failed", { cause: err });
    }
  }

  /**
   * `needs_split` pressure dosyaları (BLOCKER 5): gerçek model-görünür
   * DÜZENLENEBİLİR BLOKUN TAMAMINI (`blockFor`) tam tokenize eder — `body`
   * değil (blok çerçevesi + marker da ölçümdedir). Ölçüm/iptal ASLA 0'a ya da
   * sahte alfabetik sıralamaya dönüştürülmez: tip'li backend/iptal hatası
   * aynen yayılır, diğer hata fail-closed. Sıralama token'a göre, eşitlikte
   * yol asc; en büyük 8.
   */
  async #pressureFiles(blocks: readonly ContextBlock[], signal: AbortSignal | undefined): Promise<string[]> {
    const sized: Array<{ canonical: string; tokens: number }> = [];
    for (const block of blocks) {
      let tokens: number;
      try {
        const result = await this.#runtime.tokenize(blockFor(block), { signal });
        tokens = result.count;
      } catch (err) {
        // İptal (→ BackendError "network") / backend hatası aynen; diğer hata
        // fail-closed. Needs_split ASLA sahte sıralamayla üretilmez.
        if (err instanceof BackendError) {
          throw err;
        }
        throw new ContextAssemblyError(
          "assembly_failed",
          "Computing the pressure-file ranking failed",
          { cause: err },
        );
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
   * Bir salt-okunur yolun CANLI ana-ağaç gövdesi (yol güvenliği zinciri,
   * BLOCKER 1): `root` KANONİK (caller fail-closed `realpath`; sözdizisel
   * fallback YOK) + `canonical` normalize EDİLMİŞ (caller `normalizeRepoPath`
   * — `.git`/`..`/mutlak/backslash/NUL zaten caller'da `unsafe_path`) →
   * containment (defans) → symlink ATAL (fail-closed: I/O → `assembly_failed`;
   * symlink → `unsafe_path`) → lstat (ENOENT → ABSENT; diğer → fail-closed)
   * → link hedefi İÇ içinde (fail-closed) → dosya oku (strict UTF-8 / BINARY).
   * `.git` içeriği buraya ULAŞMAZ (caller'da normalize `null` → `unsafe_path`).
   */
  async #readReadonlyBody(
    root: string,
    canonical: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const abs = resolveContained(root, canonical);
    if (abs === null) {
      throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
    }
    // Atal sembolik bağlantı (fail-closed): I/O hatası (EACCES/EPERM/EIO/
    // ELOOP) "sembolik bağlantı yok" sayılmaz → `assembly_failed`; symlink →
    // `unsafe_path`. (hasSymlinkInPath fail-closed modu hatayı ATAR.)
    try {
      if (
        await hasSymlinkInPath(abs, root, { includeTarget: false, lstatFn: this.#fs.lstat, failClosed: true })
      ) {
        throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
      }
    } catch (err) {
      if (err instanceof ContextAssemblyError) {
        throw err;
      }
      throw new ContextAssemblyError("assembly_failed", "Reading the read-only context failed", { cause: err });
    }

    let stat: Stats;
    try {
      stat = await this.#fs.lstat(abs);
    } catch (err) {
      // YALNIZ GERÇEK yokluk "yok"tur; izin/IO/... fail-closed.
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
      // Hedefi doğrularken `realpath` beklenmedik I/O ile başarısız olursa
      // fail-closed (inference'a sızdırılmaz); kırık hedef (ENOENT) meşru.
      if (!(await symlinkTargetStaysInside(root, abs, target, this.#fs.realpath, true))) {
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
