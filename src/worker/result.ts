/**
 * Step 4: worker output + compact result type contracts
 * (DESIGN.md bölüm 3, 7.4 madde 1, 11 madde 4, 12).
 *
 * Bu dosya YALNIZ tip + saf parse sözleşmeleri içerir — hiçbir I/O,
 * workspace, repository, backend ya da oturum mantığı yoktur.
 *
 * İKİ bağımsız sözleşme yaşar burada (asla karıştırılmaz — DESIGN.md 9):
 *
 * 1. **Worker output** — yerel modelin cevabı. Tam olarak
 *    `schema_version` + `summary` + `edits`; başka BİR ŞEY DEĞİLDİR.
 *    `parseWorkerResult()` bu wire format'ı saf ve sıkı doğrular
 *    (DESIGN.md 7.4 adım 1: "Schema (Worker Contract)").
 *
 * 2. **Compact result** — Splash'ın İLERİDE orchestrator'a (Claude Code)
 *    döneceği tip'li yapı (DESIGN.md bölüm 3). `session_id`, `round`,
 *    `status`, `base_status`, `rules_source`, `context`, `summary`,
 *    `files_changed`, `diff_stats`, `validation`, `warnings`, `usage` +
 *    koşullu `split_hint` (yalnız `needs_split`) ve `inference`
 *    (yalnız `inference_busy`). Worker bunların HİÇBİRİNİ üretemez —
 *    bunlar Splash'ın kendisinin ürettigi (step 6+) olgularıdır; bu
 *    dosyada yalnızca ilerideki kompozisyon için tipler tanımlıdır.
 *
 * Güvenlik disiplini (DESIGN.md bölüm 9): parser hata mesajları SABIТ
 * ve KISAdır — şema konumu (`edits[2].operations[0].search ...`) taşınır,
 * worker yükü (search/replace metni, dosya içeriği, yol, kurallar) ASLA
 * taşınmaz. MCP hata yolları kaynak kod sızıntı kanalı olamaz.
 */

import type { InferenceConflict } from "../backend/InferenceCoordinator.js";

// ── Tip'li hata (güvenli mesaj; payload yok) ──────────────────────────────

/**
 * Worker katmanının küçük tip'li hatası.
 * - `invalid_input`  → WorkerContract girdi doğrulaması (prompt inşası).
 * - `invalid_output` → worker çıktısının şema doğrulaması (parser).
 *
 * `message` her zaman SABİТ bir cümledir: durum + (gerekirse) şema
 * konumu. Worker ürettiği metin, ham model çıktısı, proje kuralları,
 * dosya içeriği, görev metni, search/replace metni — hiçbiri mesajda
 * ASLA yer almaz. `cause` ASLA bağlanmaz: V8 `SyntaxError` mesajı
 * girdi snippet'i barındırır (`src/backend/errors.ts` aynı disiplinle
 * `invalid_response` için `cause` taşımaz).
 */
export type WorkerContractErrorKind = "invalid_input" | "invalid_output";

export class WorkerContractError extends Error {
  constructor(
    readonly kind: WorkerContractErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WorkerContractError";
  }
}

// ── Worker output şeması (v1) ─────────────────────────────────────────────

/**
 * Worker cevabının üst düzey wire alanı: `schema_version`.
 * Step 4 tam olarak 1'i destekler; başka sürüm parse edilmez,
 * taşınmaz, tahmin edilmez (ileride bilinçli bir sürüm katmanı eklenir).
 * Parser bu sabite karşı doğrular; prompt şema bloğunu aynı sabitten üretir.
 */
export const WORKER_SCHEMA_VERSION = 1 as const;

/**
 * Tam (exact) arama → değiştirme operasyonu.
 *
 * `search`: worker'a gösterilen değiştirilemez (immutable) tabandan
 * birebir kopyalanmış metindir. Step 4 bu stringi SİYAKET olarak taşır:
 * kırpma, CRLF→LF, Unicode normalizasyonu, boşluk düzenlemesi YOK
 * (Step 5'in immutable-base eşleştiricisi birebir içerikle karşılaştıracak).
 *
 * `replace`: boş olabilir — tam eşleşen bir parçanın kaldırılması
 * meşru bir düzenlemedir.
 */
export interface SearchReplaceOperation {
  search: string;
  replace: string;
}

/**
 * Mevcut dosyada bir ya da daha fazla tam arama/değiştirme uygulayan
 * düzenleme. `content` alanı BULUNAMAZ — normal değişikliklerde
 * bütün-dosya yazımı yok (büyük dosyalar için kesin tasarım kuralı).
 */
export interface ModifyEdit {
  kind: "modify";
  /** Workspace-göreceli yol (Step 4 yalnız boş-olmama kontrolü yapar). */
  path: string;
  operations: SearchReplaceOperation[];
}

/** Yeni dosya: tam içerik. Boş içerik geçerlidir (boş dosya geçerli bir dosyadır). */
export interface CreateEdit {
  kind: "create";
  path: string;
  content: string;
}

/** Silme: yalnız yol. Başka hiçbir alan yoktur. */
export interface DeleteEdit {
  kind: "delete";
  path: string;
}

export type WorkerEdit = ModifyEdit | CreateEdit | DeleteEdit;

/**
 * Doğrulanmış worker çıktısı (v1 Worker Contract).
 *
 * `schemaVersion` TS tarafında camelCase görünümü; ham JSON wire formatı
 * `schema_version` / `summary` / `edits` olarak kalır.
 *
 * Boş `edits` düzenli olarak GEÇERLİDİR (görev zaten karşılanmış /
 * güvenli değişiklik gerekmiyor / worker nedenini `summary`'de açıkladı).
 */
export interface WorkerResult {
  schemaVersion: 1;
  /** Dış boşlukları kırpılmış kısa özet (yalnızca izin verilen normalizasyon). */
  summary: string;
  edits: WorkerEdit[];
}

// ── Saf parse / doğrulama ──────────────────────────────────────────────────

/** Düz JSON nesnesi mi? (null değil, dizi değil.) */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kesin anahtar küme eşitliği — eksik VEYA fazladan anahtar reddedilir. */
function hasExactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      return false;
    }
  }
  return true;
}

const TOP_LEVEL_KEYS = ["schema_version", "summary", "edits"] as const;
const MODIFY_KEYS = ["kind", "path", "operations"] as const;
const CREATE_KEYS = ["kind", "path", "content"] as const;
const DELETE_KEYS = ["kind", "path"] as const;
const OPERATION_KEYS = ["search", "replace"] as const;

/**
 * Worker'ın ham cevabını parse eder ve DOĞRULAR (DESIGN.md 7.4 adım 1).
 *
 * SIKI kuralar:
 * - Tümüyle tek bir JSON belgesi olmalı: öncesinde/sonrasında düz metin,
 *   Markdown çiti (fence), düzeltme ya da yeniden deneme YOK — bozuk
 *   çıktı reddedilir (ilerideki düzeltme turları worker'a şemayı doğru
 *   üretmesini söyleyecek).
 * - Üst düzey tam olarak `{schema_version, summary, edits}`.
 * - `schema_version` tam olarak sayı `1` (`"1"`, `0`, `2`, eksik → red).
 * - `summary`: string; dış boşluk kırpıldıktan sonra boş değil.
 * - `edits`: dizi (boş geçerli); her giriş tam olarak modify | create |
 *   delete ve o türün tam alan kümesi.
 * - modify: `path` boş olmayan string; `operations` BOŞ OLMAYAN dizi;
 *   her operasyon tam olarak `{search, replace}`; `search` boş olmayan
 *   string; `replace` string (boş izinli).
 * - create: `path` boş olmayan string; `content` string (boş izinli).
 * - delete: `path` boş olmayan string; başka alan yok.
 * - İki düzenleme AYNI yola giremez (literal string eşitliği — Step 4
 *   dosya sisteminde yol normalizasyonu yapmaz; çakışmalar otomatik
 *   birleştirilmez, açıkça reddedilir).
 *
 * SINIR (mimari test, bkz. test/worker-result.test.ts): `path`
 * yalnızca "boş olmayan string" olarak doğrulanır. `../foo.ts`,
 * `/absolute/foo.ts`, salt-okunur dosya yolu — bunların tümü burada
 * yapısal olarak GEÇERLİDİR. Yol güvenliği (.. kaçışı, mutlak yol,
 * salt-okunur allow-list, varlık, benzersiz eşleşme, örtüşme) Step 5
 * Workspace Manager'a aittir; Step 4'in repository bilgisi YOKTUR.
 *
 * Saf işlemdir: backend çağrısı, model, dosya, git, kayıt, mutasyon
 * YOK. Başarılıda TAZE normalize yapı döner (taze diziler; string'ler
 * değer olarak). Hatalarda `WorkerContractError("invalid_output")`
 * atılır — mesaj güvenli (yukarıdaki dosya başlığı).
 */
export function parseWorkerResult(raw: string): WorkerResult {
  // Not: `fail` bilinçli olarak FONKSİYON DEKLARASYONU (const ok değil) —
  // bu TypeScript sürümünde const ok `never` çağrısı, guard kolundaki
  // akışı tip seviyesinde SONLANDIRMADIĞI için daraltma bozuluyor.
  // (`message` her zaman SABİТ — worker payload'ı asla taşınmaz.)
  function fail(message: string): never {
    throw new WorkerContractError("invalid_output", message);
  }

  if (typeof raw !== "string") {
    fail("Worker output must be a string");
  }

  // Sıkı: tüm yanıt tek JSON belgesidir. JSON belgesi grameri dış
  // boşlukları kabul eder; düz metin (önce/sonra), Markdown çiti ve
  // bozuk sözde-bilgi `JSON.parse` ile zaten başarısız olur. V8
  // `SyntaxError` mesajı girdi snippet'i taşır — yaygınlaştırmak YASAK;
  // her iki red için SABİТ güvenli mesaj.
  //
  // Not: `parsed` bilinçli olarak `Record<string, unknown>` tipinde
  // (düşük `unknown`) — `let` değişkeninin daraltması closure'larda
  // taşınmadığı için, tip ANOTASYONU ile garanti edilir.
  let parsed: Record<string, unknown>;
  try {
    const document: unknown = JSON.parse(raw);
    if (!isPlainObject(document)) {
      fail("Worker output must be a single JSON object");
    }
    parsed = document;
  } catch (err) {
    // `try` bloğundaki kendi redimiz (nesne değil) aynen yayılır;
    // yalnız GERÇEK parse hatası ("valid JSON değil") burada kurulur.
    if (err instanceof WorkerContractError) {
      throw err;
    }
    fail("Worker output is not valid JSON");
  }

  const missing = TOP_LEVEL_KEYS.filter((key) => !Object.hasOwn(parsed, key));
  if (missing.length > 0) {
    fail("Worker output is missing required fields");
  }
  if (!hasExactKeySet(parsed, TOP_LEVEL_KEYS)) {
    fail("Worker output contains unexpected fields");
  }

  const schemaVersion = parsed["schema_version"];
  if (typeof schemaVersion !== "number" || schemaVersion !== WORKER_SCHEMA_VERSION) {
    fail("Worker output has an unsupported schema_version");
  }

  const summary = parsed["summary"];
  if (typeof summary !== "string") {
    fail("Worker summary must be a string");
  }
  if (summary.trim() === "") {
    fail("Worker summary must not be empty");
  }

  const rawEdits = parsed["edits"];
  if (!Array.isArray(rawEdits)) {
    fail("Worker edits must be an array");
  }

  const edits: WorkerEdit[] = [];
  const seenPaths = new Set<string>();
  const assertUniquePath = (path: string): void => {
    if (seenPaths.has(path)) {
      fail("Worker edit targets the same path more than once");
    }
    seenPaths.add(path);
  };

  for (let index = 0; index < rawEdits.length; index++) {
    const at = `edits[${index}]`;
    const entry = rawEdits[index];
    if (!isPlainObject(entry)) {
      fail(`${at} must be an object`);
    }

    const kind = entry["kind"];
    if (kind === "modify") {
      if (!hasExactKeySet(entry, MODIFY_KEYS)) {
        fail(`${at} has unexpected or missing fields`);
      }
      const path = entry["path"];
      if (typeof path !== "string" || path === "") {
        fail(`${at}.path must be a non-empty string`);
      }
      const rawOperations = entry["operations"];
      if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
        fail(`${at}.operations must be a non-empty array`);
      }
      const operations: SearchReplaceOperation[] = [];
      for (let opIndex = 0; opIndex < rawOperations.length; opIndex++) {
        const opAt = `${at}.operations[${opIndex}]`;
        const operation = rawOperations[opIndex];
        if (!isPlainObject(operation)) {
          fail(`${opAt} must be an object`);
        }
        if (!hasExactKeySet(operation, OPERATION_KEYS)) {
          fail(`${opAt} has unexpected or missing fields`);
        }
        const search = operation["search"];
        const replace = operation["replace"];
        if (typeof search !== "string" || search === "") {
          fail(`${opAt}.search must be a non-empty string`);
        }
        if (typeof replace !== "string") {
          fail(`${opAt}.replace must be a string`);
        }
        operations.push({ search, replace });
      }
      assertUniquePath(path);
      edits.push({ kind: "modify", path, operations });
    } else if (kind === "create") {
      if (!hasExactKeySet(entry, CREATE_KEYS)) {
        fail(`${at} has unexpected or missing fields`);
      }
      const path = entry["path"];
      if (typeof path !== "string" || path === "") {
        fail(`${at}.path must be a non-empty string`);
      }
      const content = entry["content"];
      if (typeof content !== "string") {
        fail(`${at}.content must be a string`);
      }
      assertUniquePath(path);
      edits.push({ kind: "create", path, content });
    } else if (kind === "delete") {
      if (!hasExactKeySet(entry, DELETE_KEYS)) {
        fail(`${at} has unexpected or missing fields`);
      }
      const path = entry["path"];
      if (typeof path !== "string" || path === "") {
        fail(`${at}.path must be a non-empty string`);
      }
      assertUniquePath(path);
      edits.push({ kind: "delete", path });
    } else {
      fail(`${at}.kind has an unsupported value`);
    }
  }

  // TAZE normalize yapı: dışarıya ham parse nesnelerinin referansı
  // taşınmaz; diziler yeniden kurulur, string'ler değer olarak kopyalanır.
  // (İzin verilen TEK normalizasyon: `summary`'nin dış boşlukları.)
  return {
    schemaVersion: WORKER_SCHEMA_VERSION,
    summary: summary.trim(),
    edits,
  };
}

// ── Compact result (ilerideki Splash → orchestrator; DESIGN.md bölüm 3) ──
//
// Bu tipler worker çıktısıyla ALAKASI YOKTUR: worker yalnız
// `schema_version`/`summary`/`edits` üretir. `status`, `base_status`,
// `files_changed`, `diff_stats`, `validation`, `usage`, `session_id`
// ve `inference` metadatası — Splash'ın KENDİSİNİN ürettiği olgulardır
// (step 6+ kompozisyonu). Aşağıdaki union'lar yalnızca ilerideki
// yapıları tip'le korur; step 4'de hiçbir koşullu üretim yoktur.

/** Tur (round) sonuç durumları (kapalı sözlük, DESIGN.md bölüm 3). */
export type CompactStatus =
  | "applied"
  | "partial"
  | "failed"
  | "stale_base"
  | "needs_split"
  | "max_rounds"
  | "inference_busy";

/** Taban tazelik durumu (parmak izi denetimi, DESIGN.md 7.5). */
export type BaseStatus = "fresh" | "stale";

/** Kuralların provenance değeri — kurallar İÇERİĞİ asla döndürülmez. */
export type RulesSource =
  | "hook"
  | "CLAUDE.md"
  | "AGENTS.md"
  | "CLAUDE.md + AGENTS.md"
  | "none";

/** Adaptif bütçenin seçtiği bağlam kademesi (tasarım hedefleri, sert limit değil). */
export type SelectedContextTier = "64k" | "128k" | "192k" | "runtime_max";

/** Hafif bütçe telemetrisi — içerik taşır, yalnızca sayılar + bayrak. */
export interface CompactContextMetadata {
  /** Runtime'ın yetkili (authoritative) bağlam tavanı (token). */
  runtimeMaxTokens: number;
  /** Bu turda worker'a gönderilen girdi (token). */
  inputTokens: number;
  /** Worker yanıtı için ayrılan çıkış payı (token). */
  outputReserveTokens: number;
  selectedContextTier: SelectedContextTier;
  /** Salt-okunur referans bağlam azaltıldı mı? */
  truncatedReadonlyContext: boolean;
}

/** Yalnızca `status == "needs_split"` için — kaynak içerik taşır. */
export interface SplitHint {
  requiredInputTokens: number;
  availableMaxTokens: number;
  outputReserveTokens: number;
  /** Sığdıramayan (baskı oluşturan) değiştirilebilir taban dosyaları. */
  pressureFiles: string[];
  suggestedGroups?: string[][];
}

/**
 * Yalnızca `status == "inference_busy"` için. Koordinatörün (Step 3)
 * kapalı sözlüğünü GİDEREK (import) kullanır — ikinci bir çakışma
 * enum'ı yok. PID, komut satırı, yol, hata nedeni ASLA taşınmaz.
 */
export interface InferenceBusyMetadata {
  conflict: InferenceConflict;
}

/** İleride Workspace Manager tarafından hesaplanır — worker vermez. */
export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/** Yapısal doğrulamanın reddettiği tek bir düzenleme (Step 5/6). */
export interface ValidationRejection {
  file: string;
  /** Reddedilen düzenlemenin `edits` dizisindeki sıralı konumu. */
  edit: number;
  reason: string;
}

/** Turun yapısal doğrulama sonucu (Step 5 Workspace Manager kararı). */
export interface ValidationResult {
  editsRequested: number;
  editsApplied: number;
  rejected: ValidationRejection[];
}

/** Backend inference kullanımından gelen token hakedişi. */
export interface CompactUsage {
  in: number;
  out: number;
}

/** Compact result'ın tüm durumlarında ortak alanları. */
interface CompactResultBase {
  /** Opa oturum kimliği (Splash üretir; worker asla bilmez). */
  sessionId: string;
  /** 1'den başlayan tur sayacı. */
  round: number;
  baseStatus: BaseStatus;
  rulesSource: RulesSource;
  context: CompactContextMetadata;
  warnings: string[];
}

/** Doğrulama/uygulama aşamasına ulaşıp sonuçlanan turların çıktısı. */
interface CompactRoundOutcome {
  summary: string;
  filesChanged: string[];
  diffStats: DiffStats;
  validation: ValidationResult;
  usage: CompactUsage;
}

/**
 * Compact result — `status` üzerinden ayrımlı union (discriminated).
 *
 * - `applied` / `partial` / `failed` / `max_rounds` → sonuç (outcome)
 *   taşır; `staleFiles` yalnız taban stale ise bulunur.
 * - `stale_base` → sonuç, son BAŞARILI turun çıktısını tanımlar ve
 *   `staleFiles` ZORUNLUDUR (hangi taban dosyaları sürüklendi).
 * - `needs_split` → `splitHint` koşullu metadatası; model çağrılmamıştır.
 * - `inference_busy` → `inference` koşullu metadatası; model çağrılmamıştır.
 */
export type CompactResult =
  | (CompactResultBase & CompactRoundOutcome & {
      status: "applied" | "partial" | "failed" | "max_rounds";
      /** Yalnızca stale tabanda bulunur. */
      staleFiles?: string[];
    })
  | (CompactResultBase & CompactRoundOutcome & {
      status: "stale_base";
      /** Sürüklenen taban dosyaları — bu durumda zorunlu. */
      staleFiles: string[];
    })
  | (CompactResultBase & CompactRoundOutcome & {
      status: "needs_split";
      splitHint: SplitHint;
    })
  | (CompactResultBase & CompactRoundOutcome & {
      status: "inference_busy";
      inference: InferenceBusyMetadata;
    });
