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
import type { PathFingerprint, Workspace } from "../workspace/Workspace.js";

// ── Enjekte yüzeyler ─────────────────────────────────────────────────────────

/**
 * Context Assembler'ın dosya sistemi yüzeyi — YALNIZCA salt-okunur işlemler
 * (yazma/yeniden adlandırma/silme üyesi YOK; arayüz yapısı kendisi sınırı
 * tanımlar). Varsayılan `node:fs/promises`'tir; test seam'i bu arayüzün
 * kendisidir (birebir aynı imzalar).
 *
 * Step 9 hardening (spec 50): the production `readFile` member is the shared
 * no-follow safe read (`workspace/SafeRepoReader.noFollowReadFile`). The
 * ancestor/`lstat`/`readlink` checks are unchanged (spec 50: "Do not weaken
 * ancestor path checks"); the race is closed because the regular-file content
 * read itself is no-follow (`open(O_RDONLY|O_NOFOLLOW)` + same-handle read).
 */
export interface ContextFs {
  lstat(target: string): Promise<Stats>;
  /** Safe content read — no-follow in production (spec 48/50). */
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

// ── Salt-okunur canlı taban yakalama (Step 9 stale-check, spec 53) ──────────

/**
 * `captureLiveBase` girdisi — tüm değerler caller tarafından hazırdır
 * (kanonik, repository-göreceli):
 * - `repoRoot`: ana repository'nin KANONİK mutlak kökü (stale karşılaştırma
 *   CANLI ana working-tree'yi okur — spec 172/265: git YOK, fs yalnız).
 * - `basePaths`: oturumun BİTMEZ (immutable) düzenlenebilir taban yolları —
 *   ana ağaçta strict canlı parmak izi yakalanır (varlık/tip/mod/içerik).
 * - `createdPaths`: worker'ın oluşturduğu yollar — ana ağaçta yalnız VARLIK
 *   sorulur (içerik okunmaz — spec 171/266).
 */
export interface LiveBaseCaptureInput {
  repoRoot: string;
  basePaths: readonly string[];
  createdPaths: readonly string[];
}

/**
 * `captureLiveBase` sonucu — oturumun immutable tabanına karşı stale
 * KARARINI veren saf karşılaştırıcının girdisi (karşılaştırma YAPMAZ;
 * yalnız güvenli canlı ölçümü taşır, spec 53). Anahtarlar MUTLAK yollardır
 * (`repoRoot` + kanonik yol). Sürüklenme (varlık/tip) burada ÖLÇÜMDÜR, hata
 * değil (DESIGN §7.5 — stale bir taban close'u engellemez):
 * - `baseFingerprints`: mutlak yol → strict canlı parmak izi. Önekteki bir
 *   bileşen artık dizin değilse (ENOTDIR) → `{ exists: false }`; repo
 *   içindeki bir atal SYMLINK ise → `SYMLINKED_ANCESTOR_FINGERPRINT`
 *   (`{ exists: true, type: "other", mode: "symlinked-ancestor" }` — hiçbir
 *   base parmak iziyle eşit olamaz; link üzerinden hiçbir şey okunmaz).
 * - `createdExists`: mutlak yol → worker'ın `create`'i main'le ÇAKIŞIYOR mu
 *   (içeriksiz): yol var → `true`; önekteki bir bileşen dizin değilse
 *   (ENOTDIR) → `true` (create uygulanamaz); atal SYMLINK ise → `true`
 *   (varlık doğrulanamaz + patch hedefi symlink'li dizine düşer); yalnız
 *   gerçek yokluk (ENOENT) → `false`.
 */
export interface LiveBaseState {
  readonly baseFingerprints: ReadonlyMap<string, PathFingerprint>;
  readonly createdExists: ReadonlyMap<string, boolean>;
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

/**
 * Sınıflandırılmış rafine-geçmişi mesajı (Step 9, spec 141-151).
 *
 * `kind` + `protected`, assembler'ın EXACT azaltma sırasını belirler
 * (spec 145-146): korumalı olmayan `refinement` grupları (önceki geri bildirim
 * + doğrulama) → korumalı olmayan `worker_response` (önceki worker yanıtı) →
 * salt-okunur referans. Korumalı mesaj (güncel rafine: güncel geri bildirim +
 * son doğrulama; spec 147-148) ASLA düşürülmez — sığmazsa `needs_split`.
 *
 * Roller prompt'taki `user`/`assistant`'tır (spec 141: assistant = worker
 * yanıtı; user = geri bildirim + doğrulama). `content` içerik taşır (yerel
 * model bağlamı) — compact MCP çıktısına ASLA gitmez (spec 144).
 */
export interface ContextHistoryMessage {
  readonly role: "user" | "assistant";
  /** Azaltma kategorisi. */
  readonly kind: "refinement" | "worker_response";
  readonly content: string;
  /** Bütçe baskısı altında asla düşürülmez (güncel rafine koruması). */
  readonly protected: boolean;
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
  * - `history`: Step 9 rafine geçmişi — sınıflandırılmış mesajlar
  *   (`ContextHistoryMessage`). Step 8'de `[]`. Assembler bütçe baskısı altında
  *   korumalı olmayan grupları (önce eski rafine, sonra eski worker yanıtı,
  *   sonra salt-okunur) tam-remeasure ile azaltır (spec 145-151).
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
  /** Step 9 rafine geçmişi — sınıflandırılmış mesajlar (azaltma için). */
  history?: readonly ContextHistoryMessage[];
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
