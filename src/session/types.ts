/**
 * Step 9: kalıcı oturum (persistent session) — tip sözleşmeleri + tip'li hata
 * (spec 9-16, 21, 67, 107-112).
 *
 * Bu dosya YALNIZCA tipler + tip'li hatayı taşır — hiçbir I/O, Git, workspace,
 * bağlam ya da orkestrasyon mantığı YOK. Bölünüm (spec 3):
 *
 * - `SessionStore` (SessionStore.ts) = disk kalıcılığı (atomik yazım, izin,
 *   bozukluk denetimi, lazy load). Bu dosyadaki `SessionStoreFs` dikişiyle test
 *   edilebilir; production `node:fs/promises`.
 * - `SessionManager` (SessionManager.ts) = yaşam döngüsü (create/load/restore/
 *   refine/stale/max-round/history/lock).
 *
 * Disk = source of truth; RAM = aktif önbellek (spec 8). Süreç yeniden
 * başlatıldığında açık bir oturum GEÇERSİZ KILINMAZ (spec 8); yalnız diski
 * doğrulanabilir ve yeniden kurulabilir bir oturum geçerlidir.
 *
 * Güvenlik disiplini (spec 12/17): `SessionError.message` SABİТ ve KISAdır —
 * ham JSON, kural içeriği, worker patch'i, mutlak özel yol, git stderr, errno
 * detayı ASLA mesajda YOK. Teknik detay (`cause`) yalnız geliştirici kanalıdır
 * ve `serializeToolError` yalnız kind + message taşır, cause ASLA gitmez.
 * SessionStore kalıcı içeriği ASLA loglamaz (spec 17).
 */

import type { ReasoningEffort } from "../backend/InferenceBackend.js";
import type { ResolvedRules } from "../rules/types.js";
import type { WorkspaceRecoveryState } from "../workspace/Workspace.js";
import type {
  CompactResult,
  RulesSource,
  SelectedContextTier,
  ValidationResult,
  WorkerResult,
} from "../worker/result.js";

// ── Şema sürümü (spec 9) ────────────────────────────────────────────────────

/** Kalıcı oturum şemasının tek dışa-aktarılan sabiti. Bilinmeyen sürüm kabul edilmez. */
export const SESSION_SCHEMA_VERSION = 1 as const;

// ── Sabit güvenli metinler (spec 42/408) ─────────────────────────────────────

/**
 * `stale_base` turunun SABİТ compact özeti (spec 42): taban sürüklenmiş,
 * rafine yürütülmedi. Kaynak içerik, dosya, secret, yol YOK — yalnız durum.
 */
export const STALE_BASE_SUMMARY =
  "The session base changed in the main working tree; no refinement was run.";

/**
 * `max_rounds` guardrailinin SABİТ uyarısı (spec 408): guardrail işini
 * yaptı; devam için çağrı tarafının BİLİNÇLİ yeniden çağrısı gerekir
 * (acknowledgement — spec 61). İçerik/geri bildirim YOK.
 */
export const MAX_ROUNDS_WARNING =
  "The maximum refinement-round guardrail was reached; call splash_refine again to continue explicitly.";

// ── Kalıcı oturum modeli (spec 10) ──────────────────────────────────────────

/**
 * Görev açılışında pin'lenen, refine'ler boyunca AYNI kalmak zorunda olan
 * istek-seviyesi seçenekleri (spec 21). Refine bunları yeniden kullanır —
 * tur-durumu sürüklenmesi (per-round drift) YOK. `splash_refine` bunları
 * kabul etmez (spec 20); oturum onları zaten pin'ledi.
 */
export interface SessionOptions {
  /** Verilmediyse dispatch seçeneklerinde tamamen yok (spec 34). */
  reasoningEffort?: ReasoningEffort;
  /** Açık bağlam kademesi (sembolik); verilmediyse adaptif seçim. */
  contextTier?: SelectedContextTier;
  /** Açık çıkış payı (token); verilmediyse adaptif müzakere. */
  outputReserveTokens?: number;
}

/**
 * Bir üretilmiş turun kalıcı kaydı (spec 67). `feedback` yalnız refine
 * ile üretilen turlarda var: `splash_task` 1. turunda YOK (spec 67); ilk
 * çağrısı `needs_split`/`inference_busy` dönen (tur 0) oturumun 1. turunu
 * `splash_refine` üretirse 1. turda da VAR. Worker sonucu NORMALIZE edilmiş,
 * parse edilmiş haldedir — ham model çıktısı / Markdown / HTTP gövdesi YOK
 * (spec 68). Birebir tam-ikame patch semantiği için deterministik veri.
 */
export interface PersistedRound {
  /** 1'den başlayan tur numarası. */
  round: number;
  /** Bu tur için sağlanan geri bildirim (yalnız refine; `splash_task` 1. turunda yok). */
  feedback?: string;
  /** Normalize parse edilmiş worker sonucu (birebir tam-ikame patch seti). */
  workerResult: WorkerResult;
  /** Workspace yapısal doğrulama sonucu. */
  validation: ValidationResult;
  /** Turun compact sonucu (token hakedişi + telemetri dahil, spec 332). */
  result: CompactResult;
}

/**
 * Kalıcı oturum (spec 10). Bir oturum: BİR görev + BİR immutable düzenlenebilir
 * taban + BİR pin'li kural çözümü + 0..n salt-okunur referans + N düzeltme turu.
 *
 * Kalıcı durum volatile in-memory alan gerektirmez (spec 10): yeniden kurulum
 * için gereken her şey buradadır. `workspaceRecovery` GitWorktreeWorkspace'in
 * BİREBİR yeniden kurulabilmesi için gereken immutable kurtarma durumudur
 * (spec 112-122); SessionManager bunu opak taşır (spec 113).
 */
export interface PersistedSession {
  schemaVersion: 1;

  /** Güvenli opak oturum kimliği — istenen kimlikle birebir eşit (spec 209). */
  sessionId: string;

  /** Kanonik mutlak repository kökü. */
  repoRoot: string;
  /** Deterministik repository kimliği — kökten türetilir, doğrulanır (spec 208). */
  repoId: string;

  /** Orijinal görev metni (assembler redakte eder; worker'a redakte formu gider). */
  task: string;

  /** Görev açılışında bir kez çözülüp pin'lenen kurallar (spec 22 — ASLA yeniden çözülmez). */
  rules: ResolvedRules;

  /** Refine boyunca değişmeyen istek-seviyesi seçenekleri (spec 21). */
  options: SessionOptions;

  /** Immutable düzenlenebilir yollar — refine BUZUNU genişletmez (spec 24). */
  editablePaths: string[];
  /** Yığışan salt-okunur referans yolları (refine.files, canonical + dedup, spec 26). */
  readonlyPaths: string[];

  /** Worktree'nin birebir yeniden kurulması için gereken immutable kurtarma durumu. */
  workspaceRecovery: WorkspaceRecoveryState;

  /** Tamamlanan (üretilmiş) tur sayısı — 1..N. */
  round: number;

  /** max_rounds guardrail onayı — restart onayı UNUTMAZ (spec 62). */
  maxRoundsAcknowledged: boolean;

  /** Üretilmiş turlar (birebir tam-ikame patch setleri). */
  rounds: PersistedRound[];

  /** Son compact sonuç — stale/max-round no-inference yanıtları için son-bilinen telemetri. */
  latestResult?: CompactResult;
  /** Son worker sonucu — kurtarma yeniden-uygulaması için (spec 119). */
  latestWorkerResult?: WorkerResult;

  /** Son doğrulanmış turda worker'ın oluşturduğu yollar (stale çakışma, spec 33). */
  currentCreatedPaths: string[];
  /** Son workspace state'inin içeriksiz SHA-256 parmak izi (spec 107/108). */
  latestWorkspaceStateHash?: string;
}

// ── Kapalı hata sözlüğü (spec 12) ───────────────────────────────────────────

/**
 * Küçük, tip'li oturum hata sözlüğü (spec 12). "Yakın-aynı" düzinelerce tür
 * YOK — yalnız bunlar:
 * - `session_not_found`         → istenen kimlik diskte yok / güvenli değil.
 * - `session_corrupt`           → bozuk kalıcı durum (spec 16 — hiçbir yeniden yapı).
 * - `session_persistence_failed`→ atomik yazım başaramadı (spec 328).
 * - `session_recovery_failed`   → workspace yeniden kurulamadı / doğrulanamadı (spec 111-121).
 * - `session_operation_failed`  → genel güvenli işletme hatası.
 * - `session_conflict`          → kimlik diskte zaten var (spec 324 — üst yazılmaz).
 */
export type SessionErrorKind =
  | "session_not_found"
  | "session_corrupt"
  | "session_persistence_failed"
  | "session_recovery_failed"
  | "session_operation_failed"
  | "session_conflict";

/** Tür başına SABİТ güvenli mesaj — hiçbir alan/yol/errno/içerik taşımaz. */
const SESSION_ERROR_MESSAGES: Record<SessionErrorKind, string> = {
  session_not_found: "The session was not found",
  session_corrupt: "The session state is corrupt and cannot be recovered",
  session_persistence_failed: "The session could not be persisted",
  session_recovery_failed: "The session could not be recovered",
  session_operation_failed: "The session operation failed",
  session_conflict: "A session with this id already exists",
};

/**
 * Güvenli oturum hatası. `message` her zaman SABİТtir (yukarıdaki sabit
 * küme); `cause` (geliştirici kanalı) teknik detay taşır ama `serializeToolError`
 * yalnız kind + message yüzeye taşır — cause/stack/yol/stderr/JSON ASLA gitmez
 * (spec 12/13).
 */
export class SessionError extends Error {
  constructor(
    readonly kind: SessionErrorKind,
    message: string = SESSION_ERROR_MESSAGES[kind],
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SessionError";
  }
}

/** `cause`'u teknik kanala bağlar (ES2022); güvenli yüzey ASLA kullanmaz. */
export function sessionError(kind: SessionErrorKind, cause?: unknown): SessionError {
  return new SessionError(kind, SESSION_ERROR_MESSAGES[kind], { cause });
}

// ── Kalıcılık denetim sözlüğü (bozukluk için — spec 16) ─────────────────────

/** Geçerli kural provenance kümesi (DESIGN.md §6) — bozukluk denetimi (spec 271). */
export const RULES_SOURCES: readonly RulesSource[] = [
  "hook",
  "CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.md + AGENTS.md",
  "none",
];

/** Geçerli compact durum kümesi (DESIGN.md §3) — bozukluk denetimi (spec 317). */
export const COMPACT_STATUSES: readonly string[] = [
  "applied",
  "partial",
  "failed",
  "stale_base",
  "needs_split",
  "max_rounds",
  "inference_busy",
];

// ── Kalıcılık dosya sistemi dikişi (spec 14-16, 337) ────────────────────────

/** Atomik yazım için dosya kolu — `node:fs/promises` `FileHandle` yapısal eşleşir. */
export interface SessionWriteHandle {
  /** Açılan kolu üzerinden izinleri zorlar (yol tekrar çözülmez). */
  chmod(mode: number): Promise<void>;
  /** Tüm veriyi yazar (handle exclusive/no-follow ile açıldı → truncate). */
  writeFile(data: string): Promise<void>;
  /** Dosya içeriğini depolamaya yansıtır (spec 14: fsync file). */
  sync(): Promise<void>;
  /** Kolu kapatır (her yolda, `finally`). */
  close(): Promise<void>;
}

/** Yetkili oturum dosyası için salt-okunur, no-follow kolu. */
export interface SessionReadHandle {
  /** Açılan kol üzerinden stat alır; symlink takibi `open` aşamasında reddedilir. */
  stat(): Promise<SessionStat>;
  /** Açılan kol üzerinden UTF-8 içerik okur. */
  readFile(): Promise<string>;
  /** Kolu kapatır (her yolda, `finally`). */
  close(): Promise<void>;
}

/** Dizin fsync/izin için no-follow kolu (spec 14: fsync directory where supported). */
export interface SessionDirHandle {
  /** Açılan dizin kolundan izinleri zorlar (yol tekrar çözülmez). */
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** `lstat`/handle-stat için minimal görünüm — `node:fs` `Stats` yapısal eşleşir. */
export interface SessionStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  /** `stat.st_mode` (izin bitleri alt 12 bit). */
  readonly mode: number;
}

/**
 * SessionStore'un tek I/O dikişi. Production varsayılan `node:fs/promises`
 * (SessionStore.ts'te gerçek adapter). Testler sahte bir implementasyon ile
 * her senaryoyu (atomik roundtrip, izin, bozuk, geçici-dosya, sürüm/id yol
 * bozma, yazım hatası — spec 337) deterministik olarak modeler.
 *
 * `readFile`/`stat`/`openWrite`/`removeFile`/`removeDir` I/O hatasını AYNEN atar
 * (errno korunur) — `SessionStore` hata KODUNA göre fail-closed sınıflandırır.
 */
export interface SessionStoreFs {
  /**
   * `dir`'ı oluşturur. `recursive` → atallarıyla (exists: no-op); `false` →
   * YALNIZ yaprak, mevcutsa `EEXIST` (özel oluşturma / çakışma, spec 324/327).
   * `mode` (0700) yaprağa uygulanır.
   */
  mkdir(dir: string, mode: number, recursive: boolean): Promise<void>;
  /** `path`'in son bileşenini stat'ler; symlink takip ETMEZ; yoksa hatayı aynen atar. */
  lstat(path: string): Promise<SessionStat>;
  /**
   * `path`'i salt-okunur ve `O_NOFOLLOW` ile açar; symlink/düzenli-dışı hedef
   * open'da reddedilir. İzin/okuma/tip denetimi açılan kol üzerinden yapılır.
   */
  openReadNoFollow(path: string): Promise<SessionReadHandle>;
  /**
   * `path`'i `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` + `mode` (0600) ile
   * exclusive açar; var olan dosya/dosya-dışı hedef izlenmez/ezilmez.
   */
  openWrite(path: string, mode: number): Promise<SessionWriteHandle>;
  /** `from`'ı `to`'ya atomik olarak yeniden adlandırır (spec 14: rename). */
  rename(from: string, to: string): Promise<void>;
  /** `path`'i `unlink` ile siler; yoksa (ENOENT) sessizce geçer, symlink takibi YOK. */
  removeFile(path: string): Promise<void>;
  /**
   * TEK bir dizini `rmdir` ile siler (Step 10 spec 18/19) — REKÜRSİF DEĞİL:
   * boş değilse `ENOTEMPTY`, yoksa `ENOENT`, symlink/dosya ise `ENOTDIR`;
   * errno AYNEN atılır (sınıflandırma çağıranındır).
   */
  removeDir(dir: string): Promise<void>;
  /** Dizin fsync/izin için `dir`'ı no-follow salt-okunur açar (spec 14). */
  openDir(dir: string): Promise<SessionDirHandle>;
}
