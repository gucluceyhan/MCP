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

/**
 * Immutable base'in tek bir seçili yolunun BİREBİR girişi (Step 7 —
 * Context Assembler'ın salt-okunur kaynağı).
 *
 * `PathFingerprint`'ın içerik taşıyan ikiziyle aynı ölçek (DESIGN.md 7.5):
 * tip + git-ilişkili mod + içerik. İçerik ALANLARI bu tipin kendisindedir —
 * parmak izi (hash) değil: worker'a gösterilecek / redakte edilecek
 * bayt'lar veya link hedef metni. Dönen Buffer'lar savunmacı KOPIYAlardır
 * (yalnızca okunur kullansan da çağrı tarafının mutasyonu immutable
 * snapshot'ı bozamaz).
 *
 * `mode` git dosya modudur (`"100644"`, `"100755"`, `"120000"`, `"040000"`,
 * `"160000"`...) — platform `stat.mode`'u ASLA taşınmaz (Step 5 spec 31).
 */
export type WorkspaceBaseEntry =
  /** Base'te yok (GERÇEK yokluk — worker `create` kullanabilir). */
  | { exists: false }
  /** Düzenli dosya: birebir base baytları (defansif kopya). */
  | { exists: true; type: "file"; mode: "100644" | "100755"; content: Buffer }
  /** Sembolik bağlantı: hedef METNİ (takip edilmez; hedef dosya okunmaz). */
  | { exists: true; type: "symlink"; mode: "120000"; target: string }
  /** Dizin / gitlink / özel nesne: içerik temsil edilemez (tip+mod meta). */
  | { exists: true; type: "directory" | "other"; mode: string };

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
 * doğrulama kararı + git'ten hesaplanan değişen yollar + yapısal istatistik +
 * bu turda kabul edilen worker-oluşturulan yollar (Step 9: kalıcılık +
 * kapsamlı sıfırlama + kurtarma yeniden-uygulama için).
 */
export interface WorkspaceApplyResult {
  validation: ValidationResult;
  filesChanged: string[];
  diffStats: DiffStats;
  /** Bu turda worker tarafından oluşturulan (create) kabul edilen yollar. */
  createdPaths: string[];
}

/** Reddedilen düzenleme satırı — Step 4'ün compact tipini AYNEN kullanır. */
export type { ValidationRejection, ValidationResult };

// ── Kurtarma durumu (Step 9) ────────────────────────────────────────────────

/**
 * Immutable base ağacının tek `git ls-tree` girişi (Step 9 spec 112).
 * `path` PARENT ağaca görecelidir. Giriş bir alt-ağaç (`mode "040000"`) ise
 * `children` o alt-ağacın kendi `ls-tree` girişlerini (git sırasıyla) taşır —
 * böylece base nesnesi yok sayıldığında ağaç `git mktree` ile alttan-üst
 * BİREBİR (aynı `tree` SHA'sı) yeniden kurulur. İçerik YOK (yalnız git
 * metadata) — session.json'ı boyut olarak dosya sayısı sınırlı tutar.
 *
 * `path` git'in KENDİ ürettiği bir adımdır (self-captured) — kalıcılık
 * doğrulaması (SessionStore) YAPISEL güven alanı kuralıyla denetlenir
 * (Step 9 audit düzeltme A): backslash'li yasal adlar kabul, yalnız
 * kaçış/`.git` formları red.
 */
export interface BaseTreeEntry {
  mode: string;
  oid: string;
  path: string;
  /** Yalnız alt-ağaç girişlerinde (`040000`): alt-ağacın kendi girişleri. */
  children?: BaseTreeEntry[];
}

/**
 * Base commit'in kimlik alanları (Step 9 spec 112/122): `git commit-tree`
 * ile AYNI SHA'nın yeniden kurulması için gereken tüm alanlar.
 * `authorDate`/`committerDate` git'in ham tarih dizgisi (`"<unix-s> <tz>"`) —
 * `git commit-tree`'e `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` olarak aynen
 * verilir; deterministik commit SHA'sı bu alanlardan türetilir.
 */
export interface BaseCommitIdentity {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

/**
 * Bir seçili yolun immutable base içeriğinin BİREBİR, JSON-güvenli temsili
 * (Step 9 spec 114/115/116/117):
 * - `file` → base baytları base64 (working-tree ölçüsü; CRLF korur, spec 116).
 * - `symlink` → hedef METNİ (dereferans YOK, spec 117) + 120000 modu.
 * - `absent` → base'te yok (varlıksız seçili yol, spec 118).
 *
 * Bu alan `readBaseEntry`'nin yeniden kurulması + base blob'larının
 * (varsa) `git hash-object` ile aynı OID'de yeniden yazılması için tek kaynak.
 * Asla model/MCP yüzeyine taşınmaz — özel 0600 kalıcılık verisi.
 */
export type BaseContentValue =
  | { type: "file"; base64: string }
  | { type: "symlink"; target: string }
  | { type: "absent" };

/**
 * Bir oturumun worktree'sinin BİREBİR yeniden kurulabilmesi için gereken
 * immutable kurtarma durumu (Step 9 spec 112-122). `snapshotRecoveryState`
 * üretilir; `restoreGitWorktreeWorkspace` tüketir. SessionManager bu
 * yapıyı opak olarak taşır (spec 113: Git iç mantığını bilmez).
 *
 * İçerik (base64) özel kalıcılık verisidir; MCP/model yüzeyine ASLA gitmez
 * (spec 114). `recoveryStateHash` = güncel base-göreceli tam diff'in SHA-256'ı
 * (kaynaksız, spec 107/108).
 */
export interface WorkspaceRecoveryState {
  readonly schemaVersion: 1;
  /** Kanonik mutlak repository kökü — kimlik (spec 106: correct repo). */
  readonly repoRoot: string;
  /** Mutlak worktree dizini — kimlik (spec 106: correct workspace path). */
  readonly workspaceDir: string;
  /** Güvenli opak oturum kimliği — kimlik (spec 106: correct session). */
  readonly sessionId: string;
  /** Immutable base commit SHA (ASLA değişmez, spec 27) — kimlik (spec 106). */
  readonly baseCommit: string;
  /** Kanonik düzenlenebilir yollar. */
  readonly editablePaths: string[];
  /** Kanonik salt-okunur yollar. */
  readonly readonlyPaths: string[];
  /** Seçili yolların immutable base parmak izleri (path → fingerprint). */
  readonly baseFingerprints: ReadonlyArray<readonly [string, PathFingerprint]>;
  /**
   * Base ağacının TAM yol → git modu haritası (create/varlık denetimi).
   * Yollar `git ls-tree` çıktısıdır (self-captured) — kalıcılık doğrulaması
   * yapısal güven alanı kuralıyla (Step 9 audit düzeltme A).
   */
  readonly basePaths: ReadonlyArray<readonly [string, string]>;
  /** Base commit'in TAM ağacı (mode/oid/path) — `mktree` için. */
  readonly immutableBaseEntries: BaseTreeEntry[];
  /** Base commit kimlik alanları — `commit-tree` için (aynı SHA). */
  readonly baseCommitIdentity: BaseCommitIdentity;
  /** Düzenlenebilir yolların base içeriği (base64/hedef/yok) — JSON-güvenli. */
  readonly baseContents: ReadonlyArray<readonly [string, BaseContentValue]>;
  /** Son turun worker-oluşturulan yolları (kapsamlı sıfırlama + yeniden-uygulama). */
  readonly currentCreatedPaths: string[];
  /** Güncel base-göreceli tam diff'in SHA-256'ı (kaynaksız doğrulama). */
  readonly recoveryStateHash: string;
}

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

  /**
   * Bir düzenlenebilir yolun IMMUTABLE BASE'indeki BİREBİR durumunu döndürür
   * (Step 7 — Context Assembler'ın editable-side okuma API'si).
   *
   * - Senkron ve saf-okunur: base yakalama anında bellekte tutulan snapshot'tan
   *   (working-tree baytları / link hedef metni) yanıt verir — worktree'nin
   *   MUTABLE hali, ana checkout ve git ASLA okunmaz/tetiklenmez; apply
   *   SONRASI çağrılsa bile aynı base baytları döner.
   * - Girdi repository-göreceli yoldur; normalize edilir ve YALNIZCA
   *   `editablePaths` üyesi (kanonik form) kabul edilir — başka her yol
   *   `invalid_input` ile reddedilir.
   * - İmha edilmiş workspace → `workspace_destroyed`.
   */
   readBaseEntry(repoRelativePath: string): WorkspaceBaseEntry;

   /**
    * Bu workspace'in BİREBİR yeniden kurulabilmesi için immutable kurtarma
    * durumunu yakalar (Step 9 spec 112-115): base commit kimliği + tam
    * ağaç + seçili yolların base içeriği + parmak izleri + güncel state hash.
    *
    * - Saf-okunur: base'in bellekteki immutable snapshot'ı + salt-okunur git
    *   sorguları (ls-tree, cat-file, diff). Worker'ın MUTABLE yazıları, ana
    *   checkout ve içerik asla kurtarma durumuna girmEZ (base + hash ölçülür).
    * - İmha edilmiş workspace → `workspace_destroyed`.
    * - Ürün JSON-güvenlidir (Buffer'lar base64) — özel 0600 kalıcığa yazılır.
    */
   snapshotRecoveryState(): Promise<WorkspaceRecoveryState>;

   /**
    * Güncel base-göreceli TAM state'in içeriksiz parmak izi (Step 9
    * spec 107/108): `git diff --binary --full-index <base>` (filter re-check
    * sonrası) SHA-256'sı. Kaynak/diff içeriği ASLA dönmEZ — yalnız hash.
    * Worker-oluşturulan dosyaları içerir (intent-to-add). İmha → red.
    */
   recoveryStateHash(): Promise<string>;

    /**
     * Son başarılı turda worker tarafından oluşturulan yollar (Step 9:
     * kapsamlı sıfırlama + kurtarma yeniden-uygulaması için bilinen küme).
     * İmha → red.
     */
    currentCreatedPaths(): readonly string[];

    /**
     * Salt-okunur bağlam yol SETİNİ günceller (Step 9, spec 24-28/166-168).
     *
     * Step 6/7'de salt-okunur referans production v1'de her zaman `[]`'dı;
     * Step 9 refine'ı BİRİKEN (cumulative) salt-okunur yollar taşır — bunlar
     * worker'a READ-ONLY REFERENCE olarak gösterilir VE düzenleme denetiminde
     * (modify/delete) `readOnlyPath` ile reddedilir. Bu mutator, refine
     * turunun BİLENMİŞ salt-okunur kümesini doğrulamaya taşır; düzenlenebilir
     * allow-list'i (immutable base) ASLA değişmez (spec 24/28).
     *
     * Saf bellek mutasyonu: git YOK, I/O YOK, immutable base snapshot'ına
     * dokunmaz. Kanonik (normalize) yollarla çağrılır. İmha → red.
     */
    setReadonlyPaths(paths: readonly string[]): void;

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
