/**
 * Step 7: Context Assembler — tip sözleşmeleri + tip'li hata (DESIGN.md §2.3,
 * §5, §9, 11 madde 7).
 *
 * Bu dosya yalnızca tip'ler + tip'li hatayı taşır; hiçbir I/O yoktur.
 *
 * İKİ enjekte yüzey (DI framework YOK — küçük arayüzler, production
 * davranış BİREBİR node/HTTP):
 * - `ContextRuntime` — backend'in dar görüşü: YALNIZCA durum + ölçüm
 *   işlemleri. `run` ASLA bu arayüzde YOK: tüm jenerasyon Inference
 *   Coordinator üzerinden (single-flight); Context Assembler jenerasyon
 *   YAPMAZ, ÖLÇÜM yapar. `OpenAICompatBackend` bu arayüzü yapısal olarak
 *   sağlar (süreç-tek backend, coordinator ile paylaşılır).
 * - `ContextFs` — read-only salt-okunur bağlam okumalarının dosya yüzeyi
 *   (varsayılan: `node:fs/promises`); testler arıza senaryoları
 *   (ENOENT ≠ EACCES/EIO/...) enjekte edebilir.
 *
 * Güvenlik disiplini (DESIGN.md §9): `ContextAssemblyError.message` KISA
 * ve SABİТtir — dosya içeriği, secret, yol detayı, ham I/O çıktısı ASLA
 * mesajda yer almaz; teknik detay yalnız `cause` (geliştirici kanalı).
 */

import type { Stats } from "node:fs";
import type {
  InferenceMessage,
  PromptRenderOptions,
  ReasoningEffort,
  RuntimeInfo,
  TokenizeOptions,
  TokenizeResult,
} from "../backend/InferenceBackend.js";
import type { ResolvedRules } from "../rules/types.js";
import type { SelectedContextTier } from "../worker/result.js";
import type { WorkerHistoryMessage } from "../worker/WorkerContract.js";
import type { Workspace } from "../workspace/Workspace.js";

// ── Enjekte yüzeyler ─────────────────────────────────────────────────────────

/**
 * Context Assembler'ın dosya sistemi yüzeyi — YALNIZCA salt-okunur işlemler
 * (yazma/yeniden adlandırma/silme üyesi YOK; arayüz yapısı kendisi sınırı
 * tanımlar). Varsayılan `node:fs/promises`'tir; test seam'i bu arayüzün
 * kendisidir (birebir aynı imzalar).
 */
export interface ContextFs {
  lstat(target: string): Promise<Stats>;
  readFile(target: string): Promise<Buffer>;
  readlink(target: string): Promise<string>;
  realpath(target: string): Promise<string>;
}

/**
 * Runtime'ın dar ölçüm/durum yüzeyi (dosya başlığı). `InferenceBackend`'in
 * `run`'suz altkümesi — çekirdek, motoru referans vermez (DESIGN.md 2.5).
 */
export interface ContextRuntime {
  readonly runtimeInfo: RuntimeInfo | null;
  refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo>;
  tokenize(content: string, options?: TokenizeOptions): Promise<TokenizeResult>;
  countPromptTokens(messages: InferenceMessage[], options?: PromptRenderOptions): Promise<number>;
}

// ── Tip'li hata ──────────────────────────────────────────────────────────────

export type ContextAssemblyErrorKind =
  /** Açık override'lar (tier/reserve) girdi sözleşmesine uymuyor. */
  | "invalid_input"
  /** Salt-okunur yol güvenliği ihlali (kaçış, .git, sembolik bağlantı). */
  | "unsafe_path"
  /** I/O veya ölçüm işletimsel hatası (fail-closed; bağlam güvenle kurulamadı). */
  | "assembly_failed";

/**
 * Bağlam katmanının tip'li hatası. `message` SABİТtir (kaynak/cause/stderr
 * YOK); `cause` yalnız geliştirici log kanalına aittir (DESIGN.md §9).
 */
export class ContextAssemblyError extends Error {
  constructor(
    readonly kind: ContextAssemblyErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; alan yeniden declare edilmez.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContextAssemblyError";
  }
}

// ── Girdi / sonuç ────────────────────────────────────────────────────────────

/**
 * `assemble` girdisi — tüm değerler caller tarafından hazır:
 * - `task`: orijinal görev metni (assembler redakte eder; worker'a AYNEN
 *   redakte EDİLMİŞ form gider).
 * - `workspace`: immutable düzenlenebilir tabanın salt-okunur kaynağı
 *   (`readBaseEntry`) + salt-okunur okumaların ana-repo kökü.
 * - `readonlyPaths`: salt-okunur referans yollar (canlı ana ağaçtan taze
 *   okunur). Production v1: her zaman `[]` — assembler yeteneğidir;
 *   Step 6/7 onu doldurmaz (spec: `readonlyPaths=[]`).
 * - `resolvedRules`: Step 8'de `RulesResolver` tarafından BİR KERE
 *   çözülmüş proje kuralları (hook / CLAUDE.md / AGENTS.md / none +
 *   bayt-tam belgeler). Assembler onları REDAKTE + SOFT BÜTÇE + güvenli
 *   kompaksiyon'dan geçirip worker prompt'una sabitler; `source`
 *   (`rules_source`) content'siz olarak compact result'a gider.
 * - `rulesSoftBudget`: config'ten doğrulanmış kurallar soft bütçesi
 *   (token; `SPLASH_CONTEXT_RULES_SOFT_BUDGET`).
 * - `history`: Step 9 (rafine geçmişi) için yer tutucu — Step 8'de `[]`.
 * - `tiers` + reserve'ler: config'ten doğrulanmış değerler.
 * - `contextTier` / `outputReserveTokens`: istek başına açık override'lar
 *   (service ön-doğrulamıştır; assembler runtime'a karşı doğrular).
 */
export interface ContextAssemblyInput {
  task: string;
  workspace: Workspace;
  readonlyPaths?: readonly string[];
  resolvedRules?: ResolvedRules;
  /** Çözülmüş kuralların token soft bütçesi (pozitif tam sayı). */
  rulesSoftBudget: number;
  history?: readonly WorkerHistoryMessage[];
  /** Doğrulanmış adaptif kademeler (64K/128K/192K altkümesi, artan). */
  tiers: readonly number[];
  /** Minimum çıkış payı (token). */
  minOutputReserve: number;
  /** Tercih edilen çıkış payı (token; ≥ min). */
  preferredOutputReserve: number;
  /**
   * Açık kademe override'ı — kanonik SEMBOLİK değer (`64k`/`128k`/`192k`/
   * `runtime_max`). Token sayısalı `refreshRuntimeInfo` SONRASI runtime'a
   * çözülür (BLOCKER 4); `runtime_max` → taze `maximumContextTokens`.
   * Kanonik kademenin token değeri runtime max'ı aşıyorsa `invalid_input`.
   */
  contextTier?: SelectedContextTier;
  /** Açık çıkış payı override'ı (token) — config minimumu altı olamaz. */
  outputReserveTokens?: number;
  /** Ölçüm + dispatch render kimliğini aynen taşır. */
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

/**
 * Kurulmuş paket — dispatch EDİLECEK mesajlar + tam ölçü.
 *
 * KRİTİK invariant: `messages` ölçülen mesajların KENDİSİDİR (aynı string'ler,
 * aynı sıra) — dispatch bu diziyi byte-bayt aynen taşır; yeniden derleme /
 * yeniden ölçüm döngüsü YOK (`context.input_tokens` bu tam ölçüdür,
 * `usage.in` ASLA değildir).
 */
export interface ContextAssemblyReady {
  status: "ready";
  messages: InferenceMessage[];
  /** Tam preflight sayım (`countPromptTokens`) — dispatch öncesi kesin. */
  inputTokens: number;
  /** Runtime'ın yetkili bağlam tavanı (taze yenileme). */
  runtimeMaxTokens: number;
  /** Müzakere edilmiş / açık çıkış payı. */
  outputReserveTokens: number;
  /** Seçilen kadenin etiketi (kanonik 64k/128k/192k; başka → runtime_max). */
  selectedContextTier: SelectedContextTier;
  /** Seçilen kadenin token değeri (dispatch `contextTier` metadata'sı). */
  selectedTierTokens: number;
  /** Salt-okunur referans bağlam azaltıldı mı? */
  truncatedReadonlyContext: boolean;
  /** SABİТ sözlük uyarılar (kaynak/secret/path YOK). */
  warnings: string[];
}

/**
 * `needs_split` — zorunlu (task + düzenlenebilir taban) + minimum pay
 * tavana sığmıyor: BİLEŞTİRİLMEZ, KISILMAZ, inference'a inmez.
 * Kompakt `split_hint` metadata'sı Claude Code'un görevi bölmesi için
 * yeter (kaynak içerik YOK).
 */
export interface ContextAssemblyNeedsSplit {
  status: "needs_split";
  /** Zorunlu adayın tam token sayısı (task + düzenlenebilir taban). */
  requiredInputTokens: number;
  /** Geçerli tavan (açık kademe override'ı veya runtime max). */
  availableMaxTokens: number;
  /** Sığma denetiminde kullanılan pay (açık veya minimum). */
  outputReserveTokens: number;
  runtimeMaxTokens: number;
  /**
   * Geçerli tavanın KANONİK etiketi (provenance). Assembler doğrudan
   * taşır; `labelForTier(availableMaxTokens)` ile yeniden türetilmez
   * (açık `runtime_max` ≡ 131072 durumunu `128k`'tan ayırır — BLOCKER 4/5).
   */
  selectedContextTier: SelectedContextTier;
  /** Baskı oluşturan düzenlenebilir taban dosyaları (en büyük 8; içerik YOK). */
  pressureFiles: string[];
  warnings: string[];
}

export type AssembledContext = ContextAssemblyReady | ContextAssemblyNeedsSplit;
