/**
 * Step 5: Workspace Manager — kamuya açık sözleşme (DESIGN.md bölüm 2.4, 7, 11 madde 5).
 *
 * Bu dosya yalnızca tip'ler + tip'li hataları taşır; hiçbir I/O yoktur.
 * Tek v1 implementasyonu `GitWorktreeWorkspace`'tır (`GitWorktreeWorkspace.ts`).
 *
 * Ana depo güvenlik invarianti (DESIGN.md 7, Step 5 spec 4):
 * worker ürettiği kaynak değişiklikleri ASLA kullanıcının ana checkout'una
 * yazılmaz. Workspace Manager ana checkout'a yalnızca salt-okunur işlemler
 * yapabilir (rev-parse, diff, ls-files, lstat/readFile/readlink) ve git
 * worktree yönetimi — ki bu işlem paylaşılan `.git/worktrees/` + nesne
 * veritabanı yönetim alanını doğal olarak günceller. Ana working-tree dosyaları,
 * ana index, ana dal referansları, tag'lar ve proje içeriği değiştirilmez;
 * `.git`'in bayt-bayt dokunulmadığı iddia EDİLEMEZ (worktree yönetimi oraya yazar).
 *
 * Hata disiplini (Step 5 spec 8, DESIGN.md bölüm 9): `message` her zaman KISA
 * ve SABİТtir — kaynak dosya içeriği, search/replace metni, patch içeriği,
 * ham git stdout/stderr, worker çıktısı ASLA mesajda yer almaz. Teknik detay
 * (`cause`) yalnızca geliştirici kanalıdır ve gelecekteki MCP sonuçlarına
 * otomatik taşınmaz.
 */

import type { DiffStats, ValidationRejection, ValidationResult, WorkerResult } from "../worker/result.js";

// ── Tip'li workspace hatası ─────────────────────────────────────────────────

export type WorkspaceErrorKind =
  /** Keşif/girdi geçerli bir git working-tree değil (boş repo hariç). */
  | "invalid_repository"
  /** Çağrının kendi girdi sözleşmesine uymuyor (path/oturum kimliği ön koşulları). */
  | "invalid_input"
  /** Yol güvenliği ihlali (repo dışına kaçış, .git, sembolik bağlantı...). */
  | "unsafe_path"
  /** Bir git komutu beklendiği gibi çalışmadı. */
  | "git_operation_failed"
  /** Workspace yaşam döngüsü işlemi (oluşturma/uygulama/sıfırlama/imha) başarısız. */
  | "workspace_operation_failed"
  /** Patch export'u başarısız — workspace AMACEN korundu (yeniden denenmeli). */
  | "export_failed"
  /** İmha edilmiş workspace üzerinde işlem denendi. */
  | "workspace_destroyed";

export interface WorkspaceErrorOptions {
  /**
   * Teknik kanal: yalnızca geliştirici log'u. `message`'in parçası değil,
   * MCP sonuçlarına otomatik taşınmaz (DESIGN.md bölüm 9 `cause` kanalı).
   */
  cause?: unknown;
}

export class WorkspaceError extends Error {
  constructor(
    readonly kind: WorkspaceErrorKind,
    message: string,
    options: WorkspaceErrorOptions = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; alan yeniden declare edilmez
    // (boş deklarasyon, super()'ın kurduğu değeri `void 0` ile ezerdi).
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceError";
  }
}

// ── Parmak izi (immutable base kimliği; Step 9 stale-check için yeniden kullanılabilir) ──

/**
 * Bir yolun durumunun parmak izi (Step 5 spec 30):
 * varlık + tip + ilintili mod + içerik (kriptografik özet olarak).
 *
 * `mode`: git-ilintili dosya modu (`"100644"` düz, `"100755"` çalıştırılabilir,
 * `"120000"` sembolik bağlantı) — platform `stat.mode`'u ASLA saklanmaz
 * (ilgisiz bitler sahte stale üretir, spec 31). Dizin/özel nesnelerde
 * yalnız tip + `"040000"`/`"other"` taşınır (tip uyuşmazlığı denetimi içindir).
 *
 * `contentSha256`: düz dosyada birebir dosya baytları, sembolik bağlantıda
 * birebir hedef metin için SHA-256 hex.
 */
export type PathFingerprint =
  | { exists: false }
  | {
      exists: true;
      type: "file" | "symlink" | "directory" | "other";
      mode: string;
      contentSha256?: string;
    };

// ── Oluşturma girdisi ───────────────────────────────────────────────────────

export interface WorkspaceCreateInput {
  /** Kanonik mutlak repository kökü (`discoverRepoRoot` çıktısı). */
  repoRoot: string;
  /**
   * Mutlak worktree dizini — repository DIŞINDA olmalıdır (spec 10).
   * Dizin politikası (konum/atanım) bu adıma AİT DEĞİLDİR; Step 6/9 karar verir.
   */
  workspaceDir: string;
  /** Güvenli opak oturum kimliği (base commit mesajı + patch dosya adı olarak kullanılır). */
  sessionId: string;
  /**
   * Repository-göreceli DÜZENLENEBİLİR yollar — worker bunları
   * modify/delete edebilir; immutable düzenlenebilir taban bunlardır.
   */
  editablePaths: readonly string[];
  /** Repository-göreceli salt-okunur bağlam yolları — worker yazamaz. */
  readonlyPaths?: readonly string[];
}

// ── Diff seçenekleri / sonuçları ────────────────────────────────────────────

export interface WorkspaceDiffOptions {
  /** Repository-göreceli yol filtreleri (her biri path-güvenliğiyle doğrulanır). */
  files?: readonly string[];
}

/**
 * Base kimlik bilgileri — Step 9'un stale-base denetimi için güvenli tip'li API:
 * - `fingerprints`: seçilen (düzenlenebilir + salt-okunur) yolların immutable
 *   taban parmak izleri.
 * - `basePaths`: immutable base commit'te var olan TÜM dosya/sembolik-yol
 *   yolları → git modu (create "varlıksızlık" ve çakışma denetimleri için).
 */
export interface WorkspaceBaseInfo {
  fingerprints: ReadonlyMap<string, PathFingerprint>;
  basePaths: ReadonlyMap<string, string>;
}

/**
 * `applyPatchSet` sonucu (Step 5 spec 40) — kaynak kod taşımaz:
 * doğrulama kararı + git'ten hesaplanan değişen yollar + yapısal istatistik.
 */
export interface WorkspaceApplyResult {
  validation: ValidationResult;
  filesChanged: string[];
  diffStats: DiffStats;
}

/** Reddedilen düzenleme satırı — Step 4'ün compact tipini AYNEN kullanır. */
export type { ValidationRejection, ValidationResult };

// ── Workspace sözleşmesi ────────────────────────────────────────────────────

/**
 * İzole görev workspace'i — v1'de tek implementasyon `GitWorktreeWorkspace`.
 *
 * Yaşam döngüsü (DESIGN.md 7.3, Step 5 spec 35):
 * - `applyPatchSet`: worker sonucu immutable base'e KARŞI TAM ikame patch
 *   kümesidir; önce tracked durum base'e sıfırlanır, önceki turların
 *   worker-oluşturduğu yollar kapsamlı (scoped) olarak kaldırılır, TÜM
 *   düzenlemeler base'e karşı semantik olarak doğrulanır, yalnız kabul
 *   edilenler yazılır, oluşturulanlar intent-to-add ile işaretlenir.
 * - Tüm diff/stat/export çıktısı `baseCommit`'e görecelidir — asla main
 *   HEAD'e, main working-tree'ye veya önceki worker turuna değil (spec 64).
 * - `destroy` worktree'yi git ile kaldırır; export edilmiş patch dosyası
 *   diske KALIR.
 */
export interface Workspace {
  readonly repoRoot: string;
  readonly workspaceDir: string;
  /**
   * Geçici base commit SHA — oluşturulduktan sonra ASLA değişmez:
   * rebase edilmez, main'in ilerleyen HEAD'i ile değiştirilmez, main'den
   * hiçbir zaman yeniden senkronize edilmez (spec 27).
   */
  readonly baseCommit: string;
  readonly sessionId: string;
  /** Kanonik (normalize edilmiş) düzenlenebilir yollar. */
  readonly editablePaths: readonly string[];
  /** Immutable base parmak izleri + base ağaç haritası (Step 9 API'si). */
  readonly base: WorkspaceBaseInfo;

  /** Worker sonuç tablosunu uygular (tam ikame; yukarıdaki yaşam döngüsü). */
  applyPatchSet(result: WorkerResult): Promise<WorkspaceApplyResult>;

  /** Tracked durumu base'e sıfırlar + önceki worker-oluşturulan yolları kapsamlı kaldırır. */
  resetToBase(): Promise<void>;

  /**
   * Base → güncel workspace unified diff'i. Varsayılan: tüm workspace,
   * 3 context satırı, deterministik flag'ler. `files` → yol filtresi.
   */
  diff(options?: WorkspaceDiffOptions): Promise<string>;

  /** Base → güncel workspace yapısal istatistik (files/insertions/deletions). */
  stat(): Promise<DiffStats>;

  /**
   * Tamam patch export'u (`--binary --full-index`, base-göreceli) →
   * `<outputRoot>/patches/<repo-id>/<session-id>.patch`; mutlak yolu döner.
   * Başarısızsa workspace KORUNUR (spec 72).
   */
  exportPatch(outputRoot: string): Promise<string>;

  /** Worktree'yi git ile imha eder; sonraki mutasyon/diff/export güvenle reddedilir. */
  destroy(): Promise<void>;
}
