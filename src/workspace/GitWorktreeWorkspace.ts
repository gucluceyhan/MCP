/**
 * Step 5: Workspace Manager — `GitWorktreeWorkspace` (DESIGN.md 2.4, 7.1-7.3,
 * 11 madde 5). v1'in TEK workspace implementasyonu (git-only; dizin kopyası /
 * bellek workspace'i / shell sarmalayıcı YOK — spec 1).
 *
 * Sorumluluk sınırı (spec 3): repo kökü keşfi, worktree oluşturma, BİREBİR
 * base yakalama, allow-list, yol güvenliği, immutable base parmak izleri,
 * tam arama doğrulaması, örtüşme, deterministik uygulama, worker-oluşturulan
 * yol takibi, kapsamlı sıfırlama, diff/stat, tam patch export, imha.
 * Worker JSON parseı (Step 4), model inference, oturum yaşam döngüsü, bağlam,
 * kurallar, stale-base KARARI ve MCP araçları BU ADIMDA YOKTUR.
 *
 * ANA DEPO invarianti (spec 4): worker kaynak değişiklikleri asla ana
 * checkout'a yazılmaz. Ana depoda yalnızca salt-okunur git sorguları
 * (`rev-parse`, `diff`, `ls-files`, `ls-tree`, `check-attr`, `config --get`)
 * + dosya okumaları yapılır; `git worktree add/remove` paylaşılan
 * `.git/worktrees/`
 * yönetim alanını doğal olarak günceller — `.git`'in bayt-bayt dokunulmadığı
 * iddia edilmez. Ana working-tree dosyaları, index, dal referansları,
 * tag'lar ve içerik DEĞİŞMEZ (test: spec 75).
 *
 * Base'in BİREBİR yakalanması (spec 18, DESIGN.md 7.3) — zorunlu sıra:
 *   1.  ana depodan tracked delta: `git diff HEAD --binary --full-index`
 *       (düz `git diff` KULLANILMAZ — staged değişiklikleri kaçırır, spec 19)
 *   2.  `git worktree add --detach <dir> HEAD` (hook'lar devre dışı)
 *   3.  delta, worktree içine `git apply --index --binary` ile uygulanır
 *   4.  yalnız SEÇİLEN untracked dosyalar kopyalanır (crawl YOK, spec 17/23)
 *   5.  `git add -A` (+ seçilen ignored yollar için tekil `git add -f`)
 *   6.  geçici base commit: hook yok, imza yok, deterministik Splash kimliği,
 *       detached, `--allow-empty` — branch/tag/ref YOK (spec 24/25/26)
 *   7.  base SHA kaydedilir → immutable (spec 27); base AĞAÇ HARİTASI
 *       (`basePaths`) base commit'in `ls-tree`'inden; parmak izlerinin
 *       tip/mod/içeriği worktree'nin ÇALIŞMA DOSYALARINDAN (lstat +
 *       dosya baytları / link hedef metni) — canlı parmak iziyle BİREBİR
 *       aynı alan (PR #24: `text`/`eol` normalizasyonu blob ile working
 *       tree'yi farklı baytlara sokabilir; iki alan karıştırılmaz)
 *
 * v1 güvenlik politikası (PR #24 — tamamı SABİT mesajlı fail-closed red):
 * - seçili yol, sembolik-bağlantı ATALI üzerinden izlenemez — ne ana
 *   depoda (kopya kaynağı) ne workspace'te (kopya hedefi);
 * - seçili sembolik bağlantının (tracked VEYA untracked) hedefi repo
 *   SINIRI içinde olmalı; dış/kaçan hedef → oluşum red;
 * - repo-tanımlı DIŞ Git filter'ları (`filter.<d>.clean/smudge/process`)
 *   v1'de YÜRÜTÜLMEZ — İKİ attribute yüzeyi denetlenir: working-tree
 *   (delta/clean) + HEAD ağacı (checkout/smudge — `git worktree add`
 *   committed attribute yüzeyini TAM ağaca uygular); ilksel
 *   filter-yürütebilecek komuttan ÖNCE fail-closed red (builtin
 *   `text`/`eol` normalizasyonu filter DEĞİLDİR).
 * - Aynı fail-closed filter check HER TURDA worktree yüzeyinde yeniden
 *   koşular (PR #24 audit F-6): worker yazıları UYGULANDIKTAN, turun ilk
 *   filter-capable komutundan (add -N / diff) ÖNCE + export diff'inden
 *   önce — worktree'nin attribute yüzeyi worker-YAZILABİLİR (worker
 *   `.gitattributes` eker; config'de önceden tanımlı driver — LFS dahi —
 *   tur içi diff/stat/export komutlarında host'ta yürütülürdü).
 * - Her `git reset --hard` (ÜÇ nokta: round-start housekeeping, apply
 *   catch-rollback, `resetToBase`) ÖNCESİ worker-çıkışlı attribute yüzeyi
 *   saf-fs ile BİREBİR immutable base'e döndürülür (PR #24 SB-1): worker'ın
 *   modify/delete ettiği TRACKED `.gitattributes`'lar (repo'nun her
 *   derinliği) base'in working-tree baytları + moduyla yazılır; worker-
 *   OLUŞTURDUĞU attr'lar ise bilinen kümeden saf-fs silinir. `git reset
 *   --hard`'ın racy içerik doğrulaması (ölçüldü, Apple Git 2.50.1:
 *   tracked-modified + aynı-saniye stat + aynı boyut) CLEAN filter'ı
 *   attribute yüzeyiyle host'ta yürütür — yüzey worker'ınkİ değil,
 *   immutable base'in olmalı. Sanitasyon (sılma VEYA restore) başarısız
 *   olursa reset YÜRÜTÜLMEZ; re-check'ler bu restore'u İKAME ETMEZ
 *   (restore ≠ dedektör) — her ikisi de devrede kalır.
 *
 * Her diff/stat/export `baseCommit`'e görecelidir (spec 64) — main'in
 * mevcut değişiklikleri base'e dahil edildiği için worker diff'inde
 * GÖRÜNMEZ (test: spec 77).
 */

import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DiffStats, WorkerResult } from "../worker/result.js";
import type {
  BaseCommitIdentity,
  BaseContentValue,
  BaseTreeEntry,
  PathFingerprint,
  Workspace,
  WorkspaceApplyResult,
  WorkspaceBaseEntry,
  WorkspaceBaseInfo,
  WorkspaceCreateInput,
  WorkspaceDiffOptions,
  WorkspaceRecoveryState,
} from "./Workspace.js";
import { WorkspaceError } from "./Workspace.js";
import {
  HOOKS_DISABLED_CONFIG,
  computeRepoId,
  literalPathspec,
  runGit,
  splitNul,
  type GitRunResult,
} from "./git.js";
import {
  canonicalizeOutside,
  hasSymlinkInPath,
  isSafeSessionId,
  normalizeRepoPath,
  resolveContained,
  symlinkTargetStaysInside,
} from "./pathSafety.js";
import { errnoIs } from "./SafeRepoReader.js";
import { captureLiveFingerprint, gitModeType, normalizeGitFileMode, sha256Hex } from "./fingerprint.js";
import {
  REJECTION_REASONS,
  rejectCreatePlans,
  validateWorkerResult,
  type EditPlan,
  type WorkspaceBase,
} from "./validate.js";

/** Deterministik Splash commit kimliği (spec 25 — kullanıcının git kimliği GEREKMEZ). */
const SPLASH_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Splash",
  GIT_AUTHOR_EMAIL: "splash@local.invalid",
  GIT_COMMITTER_NAME: "Splash",
  GIT_COMMITTER_EMAIL: "splash@local.invalid",
};

// ── fs seam (PR #24 Fix 4 — küçük test enjeksiyonu noktası; DI framework YOK) ──

/**
 * Worker-oluşturulan yol temizliğinin (PR #24 Fix 4) + worker-takmış
 * `.gitattributes` restore'unun (PR #24 SB-1) fs arayüzü: `lstat` +
 * `unlink` (temizlik) ve `mkdir` + `writeFile` + `chmod` (restore).
 * `removeWorkerCreatedPaths` ve `restoreBaseAttributeFiles` bu aktif fs
 * üzerinden çalışır — testler `setWorkspaceFs` ile arıza senaryoları
 * (ENOENT/EACCES/...) enjekte eder; `null` gerçek fs'e döner. Modülün geri
 * kalanı node:fs'i doğrudan kullanır.
 */
export interface WorkspaceFs {
  lstat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

// `mkdir`'in `recursive: true` overload'i `Promise<string | undefined>`
// döndürür (ilk oluşturulan dizin) — seam sözleşmesi `Promise<void>`'tir;
// içerik atılır. Geri kalan üyelerin imzaları birebir uyuşur.
const realFs: WorkspaceFs = {
  lstat,
  unlink,
  mkdir: (target, options) => mkdir(target, options).then(() => undefined),
  writeFile,
  chmod,
};
let activeFs: WorkspaceFs = realFs;

/** Test enjeksiyonu seam'i: `null` → gerçek node:fs. */
export function setWorkspaceFs(ops: WorkspaceFs | null): void {
  activeFs = ops === null ? realFs : ops;
}

/**
 * Patch/diff ÇIKTI biçimi kilidi (Step 10 M1). Kullanıcının porcelain git
 * config'i ham diff baytlarını değiştirir (ölçüldü, Apple Git 2.50.1):
 * `color.ui=always` ANSI kaçışı ekler; `diff.noprefix` / `diff.mnemonicPrefix`
 * / `diff.srcPrefix`+`dstPrefix` başlık öneklerini değiştirir → export patch'i
 * `git apply` ile uygulanamaz ya da dosyalar yanlış yere düşer; base-capture
 * delta'sı uygulanamaz; state hash'i config'e bağlanır. Bu argümanlar renksiz
 * + standart `a/`/`b/` çıktıyı zorlar — VARSAYILAN config'de çıktı BAYT-BAYT
 * aynıdır (mevcut kalıcı `recoveryStateHash` değerleri geçerli kalır).
 * Yalnız tam diff metni üreten çağrılara eklenir; `--numstat -z`,
 * `--name-only -z`, `ls-files`, `ls-tree`, `cat-file`, `check-attr` bu
 * config'lerden etkilenmez (ölçüldü). `diff.context` bilinçli olarak serbest
 * bırakılır: export "configured context" kullanır (DESIGN §7.6).
 */
const PATCH_FORMAT_ARGS: readonly string[] = ["--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * `recoveryStateHash` diff'inin BİÇİM kilidi (Step 10 H). Hash kalıcı oturum
 * durumunun kimliğidir: görev ile restart arasında kullanıcının diff biçim
 * config'i değişirse aynı state farklı hash üretir → kurtarma uyuşmazlık
 * görür (`session_recovery_failed`) ve oturum KAPATILAMAZ. Ölçüldü (Apple Git
 * 2.50.1) — çıktıyı DEĞİŞTİREN ayar → sabitleyici:
 * `diff.context` → `-U3`; `diff.algorithm` (patience/histogram) →
 * `--diff-algorithm=myers`; `diff.indentHeuristic=false` →
 * `--indent-heuristic`; `diff.interHunkContext` → `--inter-hunk-context=0`;
 * `diff.orderFile` → boş sıra dosyası (`-O<devnull>`);
 * `diff.suppressBlankEmpty` / `core.quotePath` → `-c` ile git varsayılanı.
 * Hepsi git varsayılanıdır: VARSAYILAN config'de çıktı eski formülle
 * BAYT-BAYT aynı (mevcut kalıcı hash'ler geçerli kalır). `diff.relative`
 * worktree kökünde etkisiz (ölçüldü) — eklenmez. YALNIZ hash'e uygulanır:
 * export "configured context" kullanır (DESIGN §7.6), `diff()` aynen kalır.
 */
const STATE_HASH_DIFF_ARGS: readonly string[] = [
  "-U3",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--inter-hunk-context=0",
  `-O${os.devNull}`,
];
/** `STATE_HASH_DIFF_ARGS`'ın bayrağı olmayan ayarları (komut-bazlı `-c`). */
const STATE_HASH_DIFF_CONFIG: readonly string[] = ["core.quotePath=true", "diff.suppressBlankEmpty=false"];

/** `err`'ın `NodeJS.ErrnoException.code`'u verilen errno'ya eşit mi? */
function isErrnoCode(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  return (err as NodeJS.ErrnoException).code === code;
}

interface LsTreeEntry {
  mode: string;
  oid: string;
  filePath: string;
}

/**
 * `git ls-tree -r -z` kayıtlarını çözer. Kayıt formatı:
 * `<mode> <objectType> <objectName>\t<path>\0` — örn.
 * `100644 blob e69de29b...\tfile.ts`. (Type alanı YOK sayılırsa oid
 * "blob <oid>" olarak bozuk okunur ve cat-file "missing" der.)
 */
function parseLsTree(data: Buffer): LsTreeEntry[] {
  const entries: LsTreeEntry[] = [];
  for (const record of splitNul(data)) {
    if (record === "") {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue; // bozuk kayıt — atla (asla dışarı sızdırılmaz)
    }
    const parts = record.slice(0, tab).split(" ");
    if (parts.length < 3) {
      continue;
    }
    const mode = parts[0];
    const oid = parts[2];
    if (mode === undefined || oid === undefined) {
      continue;
    }
    entries.push({ mode, oid, filePath: record.slice(tab + 1) });
  }
  return entries;
}

export class GitWorktreeWorkspace implements Workspace {
  readonly repoRoot: string;
  readonly workspaceDir: string;
  readonly baseCommit: string;
  readonly sessionId: string;
  readonly editablePaths: readonly string[];
  readonly base: WorkspaceBaseInfo;

  private destroyed = false;
  /**
   * Bilinen worker-oluşturulan yollar (kapsamlı sıfırlama için, spec 59):
   * son başarılı turun create'ları; başarısız rollback/temizlik sonrası
   * BİLİNEN KALINTI kümesi (bir sonraki temizlik yeniden dener —
   * küme yalnız temizlik BAŞARILI bitince temizlenir, PR #24 Fix 4).
   */
  private workerCreatedPaths = new Set<string>();
  /**
   * Bu turda worker tarafından modify/delete edilen ve base'te TRACKED olan
   * `.gitattributes` yolları (PR #24 SB-1): her `git reset --hard` (3 nokta)
   * ÖNCESİ, base'in yakalanma anındaki working-tree baytları + moduyla
   * saf-fs ile geri yazılır — `git reset --hard`'ın racy içerik
   * doğrulaması (ölçüldü, Apple Git 2.50.1: tracked-modified +
   * aynı-saniye stat + aynı boyut) CLEAN filter'ı yalnız immutable base'in
   * attribute yüzeyiyle yürütebilsin.
   *
   * Yaşam döngüsü: `applyPatchSet`'te doğrulama SONRASI (yazımdan ÖNCE)
   * doldurulur → hem yeşil tur hem apply-ortası hata (rollback), her ikisi
   * de sıradaki `git reset --hard`'tan önce bu yüzeyi döndürür. Yalnız
   * restore BAŞARILI VE `reset --hard` BAŞARILI ise temizlenir;
   * restore/temizlik hatasında KALIR (bir sonraki reset/apply yeniden
   * dener — "temiz" asla raporlanmaz). Worker'ın OLUŞTURDUĞU attr'lar
   * buraya girmez (onlar `workerCreatedPaths`'te `unlink` ile gider).
   */
  private workerTouchedAttributePaths = new Set<string>();
  /** Doğrulamanın immutable base girdisi (kamuya açık `base`'in genişlemesi). */
  private validationBase: WorkspaceBase;

  constructor(
    repoRoot: string,
    workspaceDir: string,
    baseCommit: string,
    sessionId: string,
    editablePaths: readonly string[],
    base: WorkspaceBaseInfo,
    validationBase: WorkspaceBase,
    /**
     * Bilinen worker-oluşturulan yol başlangıç kümesi (Step 9 kurtarma).
     * `createGitWorktreeWorkspace` YOK sayar (taze base → boş);
     * `restoreGitWorktreeWorkspace` kalıcı `currentCreatedPaths`'i verir.
     */
    initialCreatedPaths: readonly string[] = [],
  ) {
    this.repoRoot = repoRoot;
    this.workspaceDir = workspaceDir;
    this.baseCommit = baseCommit;
    this.sessionId = sessionId;
    this.editablePaths = editablePaths;
    this.base = base;
    this.validationBase = validationBase;
    this.workerCreatedPaths = new Set<string>(initialCreatedPaths);
  }

  // ── iç git yardımcıları ───────────────────────────────────────────────────

  /**
   * Worktree içinde (veya belirtilen cwd'de) shell'siz git yürütür.
   * Tüm çağrılara `core.hooksPath=<devnull>` verilir (spec 26: repo-tanımı
   * hook'lar asla çalışmaz); yerel `-c` config repo config'ini DEĞİŞTİRMEZ
   * (spec 25). Hatalar güvenli tip'li `WorkspaceError`'a çevrilir.
   */
  private async git(
    args: readonly string[],
    options: {
      cwd?: string;
      config?: readonly string[];
      stdin?: Buffer | string;
      env?: NodeJS.ProcessEnv;
      allowedExitCodes?: readonly number[];
    } = {},
  ): Promise<GitRunResult> {
    const config: string[] = [HOOKS_DISABLED_CONFIG, ...(options.config ?? [])];
    try {
      return await runGit(args, {
        cwd: options.cwd ?? this.workspaceDir,
        config,
        stdin: options.stdin,
        env: options.env,
        allowedExitCodes: options.allowedExitCodes,
      });
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("git_operation_failed", "A Git operation failed", { cause: err });
    }
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new WorkspaceError("workspace_destroyed", "The workspace has been destroyed");
    }
  }

  /**
   * Immutable base'in tek yolunu BİREBİR döndürür (sözleşme: `Workspace.readBaseEntry`).
   *
   * Kaynak = base yakalama anında belleğe alınan snapshot:
   * - varlık/tip/mod: `validationBase.editable` parmak izi (git modu ölçeği);
   * - içerik: `validationBase.editableContent` (düzenli dosya baytları /
   *   link hedef metni) — worktree'nin MUTABLE dosyaları ASLA okunmaz.
   *   Bu, apply SONRASI bir çağrının bile base durumunu vermesinin
   *   garantisidir (worker yazıları snapshot'ın dışındadır).
   *
   * Güvenlik: yol `normalizeRepoPath` ile kanonikleştirilir; YALNIZCA
   * `editablePaths` üyesi kabul edilir (allow-list dışı yol — salt-okunur
   * bağlam dâhil — `invalid_input`). Dönen Buffer/str yapıları savunmacı
   * kopyalardır; içerik asla snapshot referansı olarak kaçmaz.
   */
  readBaseEntry(repoRelativePath: string): WorkspaceBaseEntry {
    this.assertUsable();
    if (typeof repoRelativePath !== "string") {
      throw new WorkspaceError("invalid_input", "A selected path must be a string");
    }
    const canonical = normalizeRepoPath(repoRelativePath);
    if (canonical === null || !this.editablePaths.includes(canonical)) {
      // Allow-list dışı (salt-okunur bağlam / repository içeriği) — bu API
      // editable base'e aittir; derin savunma, sessiz genişleme YOK.
      throw new WorkspaceError("invalid_input", "Only editable base paths can be read");
    }

    const fingerprint = this.validationBase.editable.get(canonical);
    if (fingerprint === undefined) {
      // Yapısal invariant: her editable yol yakalamada kaydedilir
      // (varsa parmak izi, yoksa `{exists:false}`). Ulaşılmaz; yine de
      // fail-closed (snapshot eksik = güvenli temsil imkânsız).
      throw new WorkspaceError(
        "workspace_operation_failed",
        "The captured editable base could not be represented safely",
      );
    }
    if (!fingerprint.exists) {
      return { exists: false };
    }
    if (fingerprint.type === "file") {
      const bytes = this.validationBase.editableContent.get(canonical);
      if (bytes === undefined) {
        throw new WorkspaceError(
          "workspace_operation_failed",
          "The captured editable base could not be represented safely",
        );
      }
      // Parmak izi modu git ölçeğindedir: `"100644"` / `"100755"`.
      return {
        exists: true,
        type: "file",
        mode: fingerprint.mode === "100755" ? "100755" : "100644",
        content: Buffer.from(bytes), // savunmacı kopya
      };
    }
    if (fingerprint.type === "symlink") {
      const bytes = this.validationBase.editableContent.get(canonical);
      if (bytes === undefined) {
        throw new WorkspaceError(
          "workspace_operation_failed",
          "The captured editable base could not be represented safely",
        );
      }
      return { exists: true, type: "symlink", mode: "120000", target: bytes.toString("utf8") };
    }
    return { exists: true, type: fingerprint.type, mode: fingerprint.mode };
  }

  /** Son başarılı turda worker-oluşturulan yollar (Step 9; spec 59). */
  currentCreatedPaths(): readonly string[] {
    this.assertUsable();
    return [...this.workerCreatedPaths];
  }

  /**
   * Salt-okunur bağlam yol setini günceller (Step 9, spec 24-28/166-168):
   * refine'in BİRİKEN salt-okunur kümesi doğrulamaya taşınır — modify/delete
   * bu yollara `readOnlyPath` ile reddedilir. Düzenlenebilir allow-list +
   * immutable base snapshot'ı ASLA değişmez. Saf bellek mutasyonu (git/I/O
   * YOK). İmha → red.
   */
  setReadonlyPaths(paths: readonly string[]): void {
    this.assertUsable();
    this.validationBase = {
      ...this.validationBase,
      readonly: new Set(paths),
    };
  }

  /**
   * Güncel base-göreceli TAM state'in içeriksiz parmak izi (Step 9 spec
   * 107/108): `git diff --binary --full-index <base>` (Step 5 fail-closed
   * filter re-check SONRASI) SHA-256'sı. Worker-oluşturulan dosyaları
   * (intent-to-add) içerir; kaynak/diff içeriği ASLA dönmEZ. İmha → red.
   * Çıktı biçimi kullanıcının diff config'inden bağımsızdır
   * (`PATCH_FORMAT_ARGS` + `STATE_HASH_DIFF_ARGS`/`_CONFIG` — Step 10 M1/H).
   */
  async recoveryStateHash(): Promise<string> {
    this.assertUsable();
    // filter re-check (PR #24 audit F-6): diff, içerik değiştirmiş tracked
    // dosyaları worktree attribute yüzeyiyle okur → içerikten ÖNCE.
    await assertNoExternalFilters(this.workspaceDir, [...this.workerCreatedPaths], this.baseCommit);
    const result = await this.git(
      [
        "diff",
        ...PATCH_FORMAT_ARGS,
        ...STATE_HASH_DIFF_ARGS,
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        this.baseCommit,
      ],
      { config: STATE_HASH_DIFF_CONFIG },
    );
    return createHash("sha256").update(result.stdout).digest("hex");
  }

  /**
   * Bu workspace'in BİREBİR yeniden kurulabilmesi için immutable kurtarma
   * durumunu yakalar (Step 9 spec 112-115). Saf-okunur: base'in bellekteki
   * immutable snapshot'ı (`validationBase`/`base`) + salt-okunur git sorguları
   * (`ls-tree`, `cat-file`, `diff`). Worker'ın MUTABLE yazıları kurtarma
   * durumuna girmEZ (base içeriği + state hash ölçülür; spec 105: main'den
   * yeniden yakalama YOK). Ürün JSON-güvenli (Buffer'lar base64) + içerik
   * ASLA MCP/model yüzeyine taşınmaz (spec 114). İmha → red.
   */
  async snapshotRecoveryState(): Promise<WorkspaceRecoveryState> {
    this.assertUsable();

    const baseFingerprints: Array<readonly [string, PathFingerprint]> =
      [...this.base.fingerprints.entries()].map(([k, v]) => [k, v] as const);
    const basePaths: Array<readonly [string, string]> =
      [...this.base.basePaths.entries()].map(([k, v]) => [k, v] as const);

    // Düzenlenebilir yolların base içeriği (JSON-güvenli) — `readBaseEntry`'nin
    // yeniden kurulması (spec 115/116/117/118) + (varsa) blob rekonstrüksiyonu.
    const baseContents: Array<readonly [string, BaseContentValue]> = [];
    for (const canonical of this.editablePaths) {
      const fingerprint = this.validationBase.editable.get(canonical);
      let value: BaseContentValue;
      if (fingerprint === undefined || !fingerprint.exists) {
        value = { type: "absent" };
      } else if (fingerprint.type === "symlink") {
        const bytes = this.validationBase.editableContent.get(canonical);
        if (bytes === undefined) {
          throw new WorkspaceError(
            "workspace_operation_failed",
            "The captured editable base could not be represented safely",
          );
        }
        value = { type: "symlink", target: bytes.toString("utf8") };
      } else if (fingerprint.type === "file") {
        const bytes = this.validationBase.editableContent.get(canonical);
        if (bytes === undefined) {
          throw new WorkspaceError(
            "workspace_operation_failed",
            "The captured editable base could not be represented safely",
          );
        }
        value = { type: "file", base64: bytes.toString("base64") };
      } else {
        // directory/other: içerik temsil edilemez — parmak izi tip+modu taşır.
        value = { type: "absent" };
      }
      baseContents.push([canonical, value]);
    }

    const immutableBaseEntries = await this.captureBaseTree();
    const baseCommitIdentity = await this.captureBaseCommitIdentity();
    const recoveryStateHash = await this.recoveryStateHash();

    return {
      schemaVersion: 1,
      repoRoot: this.repoRoot,
      workspaceDir: this.workspaceDir,
      sessionId: this.sessionId,
      baseCommit: this.baseCommit,
      editablePaths: [...this.editablePaths],
      readonlyPaths: [...this.validationBase.readonly],
      baseFingerprints,
      basePaths,
      immutableBaseEntries,
      baseCommitIdentity,
      baseContents,
      currentCreatedPaths: [...this.workerCreatedPaths],
      recoveryStateHash,
    };
  }

  // ── recovery yakalama yardımcıları (salt-okunur) ──────────────────────────

  /**
   * Base commit'in TAM ağacını alttan-üst yakalar (spec 112): kök `ls-tree`'den
   * başlayıp her alt-ağacı özyinelemeli `ls-tree -z <tree>` ile açar. `git`'in
   * KENDİ sırası korunur — böylece `mktree` BİREBİR (aynı `tree` SHA'sı) ağacı
   * yeniden kurar. İçerik YOK (yalnız mode/oid/path metadata).
   */
  private async captureBaseTree(): Promise<BaseTreeEntry[]> {
    let rootTree: string;
    try {
      const result = await this.git(["rev-parse", `${this.baseCommit}^{tree}`]);
      rootTree = result.stdout.toString("utf8").trim();
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Reading the base state failed", { cause: err });
    }
    if (rootTree === "") {
      throw new WorkspaceError("git_operation_failed", "Reading the base state failed");
    }
    return this.captureTreeEntries(rootTree);
  }

  private async captureTreeEntries(treeOid: string): Promise<BaseTreeEntry[]> {
    let data: Buffer;
    try {
      const result = await this.git(["ls-tree", "-z", treeOid]);
      data = result.stdout;
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Reading the base state failed", { cause: err });
    }
    const entries: BaseTreeEntry[] = [];
    for (const record of splitNul(data)) {
      if (record === "") {
        continue;
      }
      const tab = record.indexOf("\t");
      if (tab === -1) {
        continue; // bozuk kayıt — atla (asla dışarı sızdırılmaz)
      }
      const parts = record.slice(0, tab).split(" ");
      const mode = parts[0];
      const type = parts[1];
      const oid = parts[2];
      if (mode === undefined || type === undefined || oid === undefined) {
        continue;
      }
      const entry: BaseTreeEntry = { mode, oid, path: record.slice(tab + 1) };
      if (type === "tree" || mode === "040000") {
        entry.children = await this.captureTreeEntries(oid);
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Base commit'in kimlik alanlarını ham `git cat-file commit <sha>`'ten çözümler
   * (spec 112/122): `commit-tree`'e aynen verilecek tree/parent/author/committer/
   * message. `authorDate`/`committerDate` git'in ham tarih dizgisidir (`"<unix> <tz>"`).
   */
  private async captureBaseCommitIdentity(): Promise<BaseCommitIdentity> {
    let text: string;
    try {
      const result = await this.git(["cat-file", "commit", this.baseCommit]);
      text = result.stdout.toString("utf8");
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed", { cause: err });
    }

    const lines = text.split("\n");
    let index = 0;
    let tree = "";
    const parents: string[] = [];
    let authorName = "";
    let authorEmail = "";
    let authorDate = "";
    let committerName = "";
    let committerEmail = "";
    let committerDate = "";

    for (;;) {
      const line = lines[index];
      if (line === undefined) {
        break; // header bitti (boş satır yok — anormalsiz)
      }
      if (line === "") {
        index += 1; // header'dan message'ı ayıran boş satır
        break;
      }
      if (line.startsWith("tree ")) {
        tree = line.slice(5).trim();
      } else if (line.startsWith("parent ")) {
        parents.push(line.slice(7).trim());
      } else {
        const author = /^author\s+(.*)\s+<(.*)>\s+(.*)$/.exec(line);
        const committer = /^committer\s+(.*)\s+<(.*)>\s+(.*)$/.exec(line);
        if (author !== null) {
          authorName = author[1] ?? "";
          authorEmail = author[2] ?? "";
          authorDate = author[3] ?? "";
        } else if (committer !== null) {
          committerName = committer[1] ?? "";
          committerEmail = committer[2] ?? "";
          committerDate = committer[3] ?? "";
        }
        // beklenmeyen header alanı — aynen atla (aşağıda zorunlu alanlar doğrulanır)
      }
      index += 1;
    }
    const message = lines.slice(index).join("\n");

    // Fail-closed: zorunlu alan eksik = base güvenli temsil edilemez.
    if (tree === "") {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed", {
        cause: "malformed commit object: missing tree",
      });
    }
    if (authorName === "" || authorEmail === "" || authorDate === "") {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed", {
        cause: "malformed commit object: missing author",
      });
    }
    if (committerName === "" || committerEmail === "" || committerDate === "") {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed", {
        cause: "malformed commit object: missing committer",
      });
    }

    return {
      tree,
      parents,
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      committerDate,
      message,
    };
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Worker sonucu uygular (spec 35 yaşam döngüsü):
   *   1) ÖNCEKİ turun worker-oluşturduğu yolları KAPSAMLI kaldır (geniş
   *      `git clean` ASLA, spec 37) — sıfırlamadan ÖNCE (audit F-6:
   *      worker bitkisi `reset --hard`'ın racy doğrulamasında filter
   *      yürütebilir) — temizlik hatası → yöntem RED; küme eski (bilinen
   *      kalıntı) setiyle KALIR, başarı raporlanmaz
   *   1b) önceki turda worker'ın modify/delete ettiği TRACKED
   *      `.gitattributes`'ları saf-fs ile immutable base'e döndür (PR #24
   *      SB-1) — hata → yöntem RED, sıfırlama YÜRÜTÜLMEZ
   *   2) tracked durumu immutable base'e sıfırla — işletimsel hata →
   *      `workspace_operation_failed` (ana checkout'a asla dokunulmaz)
   *   3) TÜM WorkerResult'ı immutable base'e karşı semantik doğrula
   *   3b) bu turda worker'ın modify/delete ettiği tracked attr yollarını
   *      SB-1 kümesine yaz (sıradaki sıfırlama onları restore etsin)
   *   4) yalnız kabul edilen düzenlemeleri uygula
   *   4b) fail-closed filter re-check (PR #24 audit F-6): worker yazıları
   *       worktree'de UYGULANDIKTAN, turun ilk filter-capable komutundan
   *       (add -N / diff) ÖNCE — worker-ekli `.gitattributes` + config'de
   *       önceden tanımlı driver (LFS dahi) → `invalid_repository` red;
   *       rollback (bu turun create temizliği → reset, audit F-6 sırası)
   *       devreye girer
   *   5) kabul edilen create'ları intent-to-add işaretle (spec 60)
   *   6) workerCreatedPaths = bu turun kabul edilen create'ları (spec 59)
   *   7) filesChanged/diffStats git'ten hesapla (worker beyanına güvenilmez, spec 62)
   *
   * Worker sonucu, önceki turun ÜZERİNE artımsal delta değil, immutable
   * base'e karşı TAM ikame patch set'idir (spec 35/88 — drift imkânsız).
   *
   * Atımlar sırasında beklenmeyen işletimsel hata (spec 58): workspace base
   * durumuna geri Restore edilir + bu turun kalıntıları temizlenir, güvenli
   * tip'li `WorkspaceError` atılır — yarım patch "başarı" olarak raporlanmaz;
   * ana checkout'a DOKUNULMAZ. Rollback SIRASI (audit F-6 + SB-1): önce bu
   * turun worker-oluşturdukları (bitki attr dahil) saf fs ile kaldırılır,
   * SONRA bu turda worker'ın modify/delete ettiği tracked attr yüzeyi
   * base'e saf-fs ile restore edilir (SB-1), SONRA `reset --hard` — bir
   * adım hata verirse reset YÜRÜTÜLMEZ (attr yüzeyiyle filter çalışmaz).
   * Rollback'in kendisi başarısız olursa (temizlik/restore/reset): bilinen
   * kalıntı `workerCreatedPaths`'a KAYDEDİLİR (union — unutulmaz, sonraki
   * reset/apply yeniden dener), attr kümesi aynen KALIR ve güvenli
   * işletimsel hata atılır (PR #24 Fix 4 + SB-1).
   */
  async applyPatchSet(workerResult: WorkerResult): Promise<WorkspaceApplyResult> {
    this.assertUsable();

    // (1) Önceki turun worker-oluşturduğu yollar — yalnız bilinen küme (spec 37/38).
    // Sıfırlamadan ÖNCE (PR #24 audit F-6): worktree'de worker-ekili bir
    // attribute dosyası (örn. `.gitattributes`) kalıntısı varsa `git reset
    // --hard`'ın racy içerik doğrulaması (ölçüldü, Apple Git 2.50:
    // checkout → stat-aynı-saniye → içerik yeniden doğrulama) o yüzeydeki
    // CLEAN filter'ı host'ta yürütür. Worker yazıları (saf fs, `activeFs`
    // seam'i) git komutundan ÖNCE kaldırılır; temizlik hatası → yöntem RED —
    // reset YÜRÜTÜLMEZ, küme bilinen kalıntı olarak KALIR.
    const previousCreated = this.workerCreatedPaths;
    try {
      await this.removeWorkerCreatedPaths(previousCreated);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("workspace_operation_failed", "Cleaning the worker-created paths failed", {
        cause: err,
      });
    }

    // (1b) PR #24 SB-1: önceki turda worker'ın modify/delete ettiği TRACKED
    // `.gitattributes`'ları saf-fs ile immutable base'e döndür — `git reset
    // --hard`'ın racy içerik doğrulaması (ölçüldü, Apple Git 2.50.1:
    // tracked-modified + aynı-saniye stat + aynı boyut) o yüzeydeki CLEAN
    // filter'ı host'ta yürütür; yüzey git komutundan ÖNCE base'in birebir
    // attribute haliyle geri yazılır. Hata → yöntem RED, reset YÜRÜTÜLMEZ.
    try {
      await this.restoreBaseAttributeFiles(this.workerTouchedAttributePaths);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed", {
        cause: err,
      });
    }

    // (2) Tracked durum → immutable base. (Asla main'e, asla main HEAD'e değil — spec 36.)
    // (1) yalnızca bilinen worker yollarını (untracked) kaldırdığı için tracked
    // durum hâlâ bu adımda sıfırlanır; worker bitkisi git'in önünde gitmiş
    // olmalı (yukarıdaki gerekçe). İşletimsel hata → güvenli tip'li red
    // (ana checkout'a asla dokunulmaz); küme temizlenMEZ (kalıntı unutulmaz).
    try {
      await this.git(["reset", "--hard", this.baseCommit]);
    } catch (err) {
      throw new WorkspaceError("workspace_operation_failed", "Resetting the workspace to base failed", {
        cause: err,
      });
    }
    // Kümeler yalnız temizlik + restore + sıfırlama TAMAMEN başarılı bitince
    // temizlenir.
    this.workerCreatedPaths = new Set<string>();
    this.workerTouchedAttributePaths = new Set<string>();

    // (3) TÜM seti immutable base'e karşı doğrula — yazmadan ÖNCE (spec 39).
    // (3a) K4: git-ignored yola create → `git add -N` exit 1 ile TÜM turu
    // düşürürdü. Karar YAZMADAN önce worktree'de (base durumu) alınır;
    // eşleşen create'ler sabit nedenle reddedilir, diğer düzenlemeler sürer.
    const validated = validateWorkerResult(this.validationBase, workerResult);
    const validation = rejectCreatePlans(
      validated,
      await this.ignoredCreatePaths(validated.plan),
      REJECTION_REASONS.pathIgnored,
    );

    // (3b) PR #24 SB-1: bu turda worker'ın modify/delete ettiği ve base'te
    // TRACKED olan `.gitattributes` yollarını SB-1 kümesine yaz — turun
    // SONUNDA (yeşil) VEYA yarıda kalmasında (rollback), sıradaki
    // `git reset --hard`'tan ÖNCE bu yüzey base'in birebir haliyle geri
    // yazılmalıdır. `validate` modify/delete → `editable` zorlar ve attr
    // base'te tracked → base baytları `editableContent`'te, mod parmak
    // izinde zaten yakalanmıştır (F-2 alanı — `captureBase` değişmez).
    this.workerTouchedAttributePaths = new Set<string>();
    for (const plan of validation.plan) {
      if (
        (plan.action === "modify" || plan.action === "delete") &&
        path.basename(plan.canonical) === ".gitattributes" &&
        this.validationBase.basePaths.has(plan.canonical)
      ) {
        this.workerTouchedAttributePaths.add(plan.canonical);
      }
    }

    // (4) Yalnız kabul edilenleri uygula.
    const createdThisRound: string[] = [];
    try {
      for (const plan of validation.plan) {
        const abs = resolveContained(this.workspaceDir, plan.canonical);
        if (abs === null) {
          // Doğrulama bunu zaten engeller; derin savunma (spec 13).
          throw new WorkspaceError("unsafe_path", "A worker path is unsafe");
        }
        // v1 yazma güvenliği (spec 48): workspace'de (base dışında, örn.
        // orchestrator tarafından) beliren sembolik bağlantı bileşeni YOK
        // olmalı. delete'ta hedefin kendisi bağlantı OLABİLİR (link kaldırılır).
        const includeTarget = plan.action !== "delete";
        if (await hasSymlinkInPath(abs, this.workspaceDir, { includeTarget })) {
          throw new WorkspaceError("unsafe_path", "A worker path is unsafe");
        }

        const live = await lstat(abs).catch(() => null);

        if (plan.action === "delete") {
          if (live === null) {
            // Base'te vardı, worktree'de yok — durum sürüklenmiş; yarım başarı yok.
            throw new WorkspaceError("workspace_operation_failed", "A workspace file is missing");
          }
          if (!live.isFile() && !live.isSymbolicLink()) {
            throw new WorkspaceError("workspace_operation_failed", "A workspace file has an unexpected type");
          }
          // `unlink` sembolik bağlantıyı TAKİP ETMEZ — link'in kendisini kaldırır (spec 56/49).
          await unlink(abs);
        } else if (plan.action === "modify") {
          // `reset --hard base` sonrası dosya base durumundadır: VAR OLMALI ve
          // düz dosya olmalı (symlink/tip değişimi = drift). İçerik base ile
          // birebir değilse (defansif — reset bunu zaten garanti eder) drift.
          if (live === null) {
            throw new WorkspaceError("workspace_operation_failed", "A workspace file is missing");
          }
          if (!live.isFile()) {
            throw new WorkspaceError("workspace_operation_failed", "A workspace file has an unexpected type");
          }
          const baseContent = this.validationBase.editableContent.get(plan.canonical);
          if (baseContent !== undefined) {
            const liveBytes = await readFile(abs);
            if (!liveBytes.equals(baseContent)) {
              throw new WorkspaceError("workspace_operation_failed", "A workspace file has drifted from base");
            }
          }
          if (plan.content === undefined) {
            throw new WorkspaceError("workspace_operation_failed", "Invalid patch plan");
          }
          // Sonuç içeriği base'ten hesaplandı (validate.ts) — mevcut dosyanın
          // ÜZERİNE yazılır; `writeFile` var olan dosyada modu (örn.
          // çalıştırılabilir bit) korur, dolayısıyla 755'li base dosyası 755
          // olarak kalır (spec 21).
          await writeFile(abs, plan.content);
        } else {
          // create: base'te yoktu, worktree'de belirirse drift → overwrite YASAK.
          if (live !== null) {
            throw new WorkspaceError("workspace_operation_failed", "A workspace file has drifted from base");
          }
          if (plan.content === undefined) {
            throw new WorkspaceError("workspace_operation_failed", "Invalid patch plan");
          }
          // Çalıştırılabilir bit YOK: Worker Contract'ta chmod alanı yok (spec 55).
          // (modify'de dosya zaten base'ten geldiği modda durur — `writeFile`
          // mevcut dosyanın modunu korur; `mode` yalnız oluşturmada etkilidir.)
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, plan.content, { mode: 0o644 });
          if (plan.action === "create") {
            createdThisRound.push(plan.canonical);
          }
        }
      }

      // (4b) PR #24 audit F-6 — fail-closed filter re-check, TEK çağrı:
      // worker yazıları (create/modify/delete) worktree'de UYGULANDI; buradan
      // sonraki her filter-capable komut (add -N, diff --name-only/--numstat)
      // worktree attribute yüzeyiyle içerik okur. Worker o yüzeyi YAZABİLİR
      // (`.gitattributes` create/modify — `create` allow-list'ten BAĞIMSIZ,
      // spec 81): config'de önceden tanımlı driver'ın (LFS dahi)
      // clean/smudge komutu tur içinde host'ta yürütülürdü (RCE). Yüzey:
      // worktree'nin `ls-files`'i ∪ bu turun plan yolları (create+modify+
      // delete) ∪ bilinen kalıntı kümesi (`workerCreatedPaths` — başarısız
      // cleanup'tan arta kalan worker yazıları; round'lar arası fail-closed).
      // Tehdit → `invalid_repository` (SABİT); doğrulanamayan yüzey →
      // `git_operation_failed` — ikisi de filter-capable komuttan ÖNCE.
      // Buradaki `throw`, mevcut rollback yoluna düşer (aşağıdaki sırayla):
      // bu turun worker yazıları (bitki dahil) saf fs ile KALDIRILIR, SONRA
      // `reset --hard` — worker yazıları worktree'den gider, yarım state
      // KALMAZ, filter hiçbir git komutunda yürümez.
      await assertNoExternalFilters(
        this.workspaceDir,
        [...validation.plan.map((plan) => plan.canonical), ...this.workerCreatedPaths],
        this.baseCommit,
      );

      // (5) intent-to-add: worker içerik index'e TAMAMLANMIŞ değişiklik olarak
      // DEĞİL, görünürlük için işaretlenir (spec 60) — diff/stat/export
      // create'ları içerir; base commit DEĞİŞMEZ. `:(literal)` pin'i:
      // worker yol dizgeleri pathspec magic'i olarak ASLA yorumlanamaz
      // (audit CRITICAL-1) — yoksa `:(exclude)X` gibi bir ad index'i
      // SESSİZ mass-add'e sokar.
      if (createdThisRound.length > 0) {
        await this.git(["add", "-N", "--", ...createdThisRound.map(literalPathspec)]);
      }
      // (6) Bilinen küme = bu turun kabul edilen create'ları (spec 59).
      this.workerCreatedPaths = new Set<string>(createdThisRound);
    } catch (err) {
      // (spec 58) işletimsel hata: bu turun kalıntılarını temizle + attr
      // yüzeyini base'e döndür + base'e dön. Rollback SIRASI (audit F-6 +
      // SB-1): ÖNCE bu turun worker-oluşturdukları (bitki `.gitattributes`
      // dahil) saf fs ile kaldırılır, SONRA bu turda modify/delete edilen
      // tracked attr yüzeyi base'e saf-fs ile restore edilir, SONRA
      // `reset --hard` — `git reset --hard`'ın racy içerik doğrulaması
      // (ölçüldü, Apple Git 2.50) worker attr yüzeyiyle CLEAN filter'ı
      // host'ta yürütür; her iki attr yüzeyi git'in önünde, base'in haliyle
      // olmalıdır. Adımlardan biri hata verirse reset YÜRÜTÜLMEZ.
      // Rollback adım hatası → güvenli işletimsel hata; BİLİNEN KALINTI
      // unutulmaz: küme = önceki set ∪ bu turun create'ları, attr kümesi
      // aynen kalır (bir sonraki reset/apply yeniden dener; workspace
      // "temiz" olarak ASLA raporlanmaz).
      let rollback: { error: unknown; message: string } | null = null;
      try {
        await this.removeWorkerCreatedPaths(new Set<string>(createdThisRound));
      } catch (cleanupErr) {
        rollback = { error: cleanupErr, message: "Cleaning the worker-created paths failed" };
      }
      if (rollback === null) {
        // PR #24 SB-1: bu turda worker'ın modify/delete ettiği TRACKED
        // `.gitattributes`'ları base'e saf-fs ile döndür — `git reset
        // --hard`'ın racy içerik doğrulaması bu yüzeyi CLEAN filter'la
        // yürütür; yüzey worker'ınki değil, base'in olmalı.
        try {
          await this.restoreBaseAttributeFiles(this.workerTouchedAttributePaths);
        } catch (restoreErr) {
          rollback = { error: restoreErr, message: "Restoring the attribute files failed" };
        }
      }
      if (rollback === null) {
        try {
          await this.git(["reset", "--hard", this.baseCommit]);
        } catch (resetErr) {
          rollback = { error: resetErr, message: "Resetting the workspace to base failed" };
        }
      }
      if (rollback === null) {
        // Rollback TAMAMEN başarılı: kalıntılar giderildi + attr yüzeyi
        // base'te + workspace base'te → kümeler BOŞ + orijinal hata atılır.
        this.workerCreatedPaths = new Set<string>();
        this.workerTouchedAttributePaths = new Set<string>();
        if (err instanceof WorkspaceError) {
          throw err;
        }
        throw new WorkspaceError("workspace_operation_failed", "Applying the patch failed", { cause: err });
      }
      // Rollback tamamlanamadı: bilinen kalıntı kaydedilir (union); attr
      // kümesi DEĞİŞTİRİLMEZ (kalıntı unutulmaz — sonraki reset yeniden
      // restore'u dener).
      this.workerCreatedPaths = new Set<string>([...previousCreated, ...createdThisRound]);
      throw new WorkspaceError("workspace_operation_failed", rollback.message, { cause: rollback.error });
    }

    // (7) Sonuçlar git'ten — worker beyanına değil (spec 62).
    const filesChanged = await this.changedPaths();
    const diffStats = await this.statInternal();
    // (8) Bilinen worker-oluşturulan küme (spec 59) — Step 9 kalıcılık +
    // kurtarma yeniden-uygulaması + kapsamlı sıfırlama için döndürülür.
    return { validation: validation.result, filesChanged, diffStats, createdPaths: [...this.workerCreatedPaths] };
  }

  /**
   * K4: kabul edilen create yollarından git'in yoksaydıkları (.gitignore,
   * `info/exclude`, `core.excludesFile` — `git add`'in kullandığı aynı
   * kaynaklar). `check-ignore` `:(literal)`/`--literal-pathspecs`'i
   * desteklemez (ölçüldü, Git 2.50: "pathspec magic not supported");
   * `./` öneki `:(…)`/`:x` adlarının magic yorumlanmasını engeller, glob
   * karakterleri zaten literaldir. Çıkış 1 = hiçbiri yoksayılmıyor.
   * Yolunda sembolik bağlantı olan create sorulmaz (`check-ignore` onda
   * 128 ile ölür); uygulama döngüsü onu `unsafe_path` ile reddeder.
   */
  private async ignoredCreatePaths(plan: readonly EditPlan[]): Promise<Set<string>> {
    const creates: string[] = [];
    for (const entry of plan) {
      if (entry.action !== "create") {
        continue;
      }
      const abs = resolveContained(this.workspaceDir, entry.canonical);
      if (abs !== null && !(await hasSymlinkInPath(abs, this.workspaceDir, { includeTarget: true }))) {
        creates.push(entry.canonical);
      }
    }
    if (creates.length === 0) {
      return new Set<string>();
    }
    const result = await this.git(["check-ignore", "--stdin", "-z"], {
      stdin: creates.map((p) => `./${p}\0`).join(""),
      allowedExitCodes: [1],
    });
    const ignored = new Set<string>();
    for (const entry of result.stdout.toString("utf8").split("\0")) {
      if (entry.startsWith("./")) {
        ignored.add(entry.slice(2));
      }
    }
    return ignored;
  }

  /**
   * Önceki worker-oluşturulan yolları kapsamlı kaldırır (geniş `git clean`
   * ASLA) + worker-takmış tracked `.gitattributes` yüzeyini base'e döndürür
   * (PR #24 SB-1) + tracked durumu base'e sıfırlar. SIRASI (audit F-6 +
   * SB-1): temizlik ÖNCE, attr restore ORTA, `reset --hard` SONRA —
   * worktree'de worker-ekili/modify'li bir attribute yüzeyi varsa `git
   * reset --hard`'ın racy içerik doğrulaması (ölçüldü, Apple Git 2.50.1)
   * o yüzeydeki CLEAN filter'ı host'ta yürütür; her iki attr yüzeyi git
   * komutundan önce, saf fs ile, base'in birebir haliyle olmalıdır.
   * Kümeler yalnız temizlik + restore + sıfırlama BAŞARILI bitince
   * temizlenir; herhangi bir adım hata verirse yöntem red edilir, reset
   * YÜRÜTÜLMEZ ve kümeler BİLİNEN KALINTI olarak kalır ("başarılı reset"
   * asla raporlanmaz, PR #24 Fix 4 + SB-1).
   */
  async resetToBase(): Promise<void> {
    this.assertUsable();
    try {
      await this.removeWorkerCreatedPaths(this.workerCreatedPaths);
    } catch (err) {
      // Hata küme üzerinde yutulmaz: küme eski setiyle kalır (kalıntı
      // unutulmaz) + güvenli tip'li red. Temizlik başarısızsa reset
      // YÜRÜTÜLMEZ — bitki attr yüzeyiyle filter çalışmaz.
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("workspace_operation_failed", "Cleaning the worker-created paths failed", {
        cause: err,
      });
    }
    // PR #24 SB-1: worker'ın modify/delete ettiği TRACKED `.gitattributes`'ları
    // saf-fs ile immutable base'e döndür — `reset --hard`'dan ÖNCE
    // (yukarıdaki gerekçe). Hata → güvenli tip'li red, reset YÜRÜTÜLMEZ;
    // attr kümesi aynen kalır (kalıntı unutulmaz — sonraki çağrı yeniden
    // restore'u dener).
    try {
      await this.restoreBaseAttributeFiles(this.workerTouchedAttributePaths);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed", {
        cause: err,
      });
    }
    try {
      await this.git(["reset", "--hard", this.baseCommit]);
    } catch (err) {
      // Hata küme üzerinde yutulmaz: kümeler eski halleriyle kalırlar
      // (kalıntı unutulmaz — sonraki çağrı yeniden temizler/restore eder)
      // + güvenli tip'li red.
      throw new WorkspaceError("workspace_operation_failed", "Resetting the workspace to base failed", {
        cause: err,
      });
    }
    this.workerCreatedPaths = new Set<string>();
    this.workerTouchedAttributePaths = new Set<string>();
  }

  /**
   * Base → güncel workspace unified diff (spec 63): tüm workspace, 3 context
   * satırı, deterministik flag'ler (`--no-ext-diff --no-textconv --no-renames`).
   * `files` filtresi path-güvenliğinden geçmek zorundadır.
   *
   * fail-closed filter re-check (PR #24 audit F-6): diff, içerik değiştirmiş
   * tracked dosyaları worktree attribute yüzeyiyle OKUR (ölçüldü: planted
   * `.gitattributes` + config'deki driver'ın clean komutu `git diff <base>`
   * içinde yürür — `--no-textconv` yalnız textconv'u kapatır, clean
   * filter'ı değil). Başarısız rollback'ten kalan bitki + worker-modifiye
   * dosya penceresinde bu bir RCE kanalidir → diff'ten ÖNCE re-check.
   */
  async diff(options: WorkspaceDiffOptions = {}): Promise<string> {
    this.assertUsable();
    await assertNoExternalFilters(this.workspaceDir, [...this.workerCreatedPaths], this.baseCommit);
    const args: string[] = [
      "diff",
      ...PATCH_FORMAT_ARGS,
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-U3",
      this.baseCommit,
    ];
    const paths = this.literalPathFilter(options.files);
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    const result = await this.git(args);
    return result.stdout.toString("utf8");
  }

  /**
   * Base → güncel workspace yapısal istatistik (files/insertions/deletions,
   * spec 65). fail-closed filter re-check (PR #24 audit F-6): numstat,
   * içerik değiştirmiş tracked dosyaları worktree attribute yüzeyiyle okur
   * (`diff()` ile aynı gerekçe) → istatistikten ÖNCE re-check.
   * (`applyPatchSet` içindeki `statInternal` çağrısı 4b re-check'iyle
   * aynı turdur — ara yazar YOK; ikinci çağrı gerekmez.)
   *
   * Step 10 spec 8: `files` → `diff()` ile AYNI yol-filtre yardımcısı
   * (`literalPathFilter`: kanonik güvenli yol + `:(literal)`); boş/yok =
   * filtresiz. Sayılar git numstat'tan — diff metni parse edilmez.
   */
  async stat(options: WorkspaceDiffOptions = {}): Promise<DiffStats> {
    this.assertUsable();
    await assertNoExternalFilters(this.workspaceDir, [...this.workerCreatedPaths], this.baseCommit);
    return this.statInternal(this.literalPathFilter(options.files));
  }

  /**
   * `diff()`/`stat()` ortak yol filtresi: her girdi `normalizeRepoPath` ile
   * kanonikleştirilir (güvensiz → `unsafe_path`), `:(literal)` pathspec'e
   * çevrilir. Yok/boş dizi → `[]` (filtresiz).
   */
  private literalPathFilter(files: readonly string[] | undefined): string[] {
    if (files === undefined || files.length === 0) {
      return [];
    }
    const paths: string[] = [];
    for (const raw of files) {
      const canonical = normalizeRepoPath(raw);
      if (canonical === null) {
        throw new WorkspaceError("unsafe_path", "The diff path filter is unsafe");
      }
      // `:(literal)`: filtre yolları pathspec magic'i olarak yorumlanamaz
      // (audit CRITICAL-1) — `*` glob/genleşme etkisi yapamaz.
      paths.push(literalPathspec(canonical));
    }
    return paths;
  }

  /**
   * Tamam patch export'u (spec 68/69/71/72):
   * `<outputRoot>/patches/<repo-id>/<session-id>.patch` ←
   * `git diff --binary --full-index <base>` (modifikasyon + silme + worker
   * create'ları (intent-to-add) + binary; `--no-renames` deterministik).
   *
   * - outputRoot hem repo hem workspace DIŞINDA olmalı (defense-in-depth
   *   yeniden denetlenir; workspace İÇİ ise `destroy()` patch'in TEK
   *   kopyasını da imha eder — audit MEDIUM-1).
   * - Yazım atomik: geçici dosya + fsync + rename; 0600 dosya / 0700 dizin.
   * - BAŞARISIZ export workspace'yi imha ETMEZ (spec 72): `export_failed`
   *   atılır; workspace/base/worker sonucu aynen kalır.
   * - Patch içeriği metadata'da ASLA taşınmaz; yalnız mutlak yol döner.
   * - fail-closed filter re-check (PR #24 audit F-6): diff komutundan
   *   ÖNCE, `applyPatchSet` ile aynı yüzey/parametle — round sonu ile
   *   export arasında yazar YOK ama fail-closed simetrisi korunur
   *   (ucuz: 2 check-attr + config get). Tehdit → `invalid_repository`
   *   (mevcut `export_failed` yolu DEĞİL — hata tipi korunur).
   */
  async exportPatch(outputRoot: string): Promise<string> {
    this.assertUsable();
    if (typeof outputRoot !== "string" || outputRoot.length === 0) {
      throw new WorkspaceError("invalid_input", "The patch output root must be a non-empty path");
    }

    const canonicalRoot = await canonicalizeOutside(path.resolve(outputRoot), this.repoRoot);
    if (canonicalRoot === null) {
      throw new WorkspaceError("unsafe_path", "The patch output path is unsafe");
    }

    // Workspace DIŞI denetimi (audit MEDIUM-1): `destroy()` worktree
    // dizinini `git worktree remove --force` ile imha eder — outputRoot
    // workspace İÇİNDEyse patch'in TEK kopyası da gider (DESIGN 7.5/7.6
    // "patch remains on disk" garantisi). `this.workspaceDir` sözdizimsel
    // kalabilir; `canonicalizeOutside` derin VAR OLAN atalı realpath ile
    // kanonikleştirir — iki kök de aynı helper'dan geçtiği için içerme
    // kararı tutarlı kalır.
    const outsideWorkspace = await canonicalizeOutside(path.resolve(outputRoot), this.workspaceDir);
    if (outsideWorkspace === null) {
      throw new WorkspaceError("unsafe_path", "The patch output path is unsafe");
    }

    // PR #24 audit F-6 — fail-closed filter re-check: export diff'inden
    // ÖNCE. Round sonu ile export arasında worktree değişmez (yazar yok);
    // check fail-closed simetrisi için korunur (ucuz — 2 check-attr +
    // config get). Yüzey/parametre `applyPatchSet` re-check'iyle aynı:
    // worktree `ls-files` ∪ bilinen kalıntı + `--source <baseCommit>`.
    // `try` bloğunun DIŞINDA: tehdit `invalid_repository` olarak aynen
    // yayılır (aşağıdaki catch yalnız yazım hatalarını `export_failed`'a
    // çevirir — hata tipi korunur).
    await assertNoExternalFilters(this.workspaceDir, [...this.workerCreatedPaths], this.baseCommit);

    const repoId = computeRepoId(this.repoRoot);
    const patchDir = path.join(canonicalRoot, "patches", repoId);
    const patchPath = path.join(patchDir, `${this.sessionId}.patch`);
    const tempPath = `${patchPath}.tmp-${process.pid}`;

    try {
      await mkdir(patchDir, { recursive: true });
      await chmod(patchDir, 0o700).catch(() => undefined); // restrictive dizin (spec 71)

      const result = await this.git([
        "diff",
        ...PATCH_FORMAT_ARGS,
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        this.baseCommit,
      ]);

      const handle = await open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(result.stdout);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, patchPath);
      return path.resolve(patchPath);
    } catch (err) {
      // Geçici dosyanın izini sil (patch içeriği asla yarıda kalmaz).
      await rm(tempPath, { force: true }).catch(() => undefined);
      // Workspace AMACEN korunur — Step 10 export → (başarıda) destroy sırasını kurar.
      throw new WorkspaceError("export_failed", "Patch export failed", { cause: err });
    }
  }

  /**
   * Worktree'yi `git worktree remove --force` ile imha eder (spec 73).
   * Rastgele dizin `rm -rf` YAPILMAZ — git, git'inin worktree'sini kaldırır.
   * İmha sonrası mutasyon/diff/export `workspace_destroyed` ile reddedilir;
   * export edilmiş patch dosyaları diskte KALIR. Tekrar çağrım: idempotent
   * (önceki yarım imha varsa yeniden dener).
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      const stillThere = await lstat(this.workspaceDir).catch(() => null);
      if (stillThere === null) {
        return;
      }
      // Önceki imha yarım kaldı → aşağıda yeniden denenecek.
    }
    try {
      await runGit(
        ["worktree", "remove", "--force", this.workspaceDir],
        { cwd: this.repoRoot, config: [HOOKS_DISABLED_CONFIG] },
      );
    } catch (err) {
      const stillThere = await lstat(this.workspaceDir).catch(() => null);
      if (stillThere === null) {
        // Dizin gitmiş. Global `git worktree prune` KULLANILMAZ: aynı repodaki
        // başka eksik-ama-kayıtlı, kilitsiz worktree'lerin (ör. kullanıcının
        // takılı olmayan diskteki worktree'si) `.git/worktrees/<id>/` kaydını
        // (HEAD+index) da silerdi. Yalnız BU yolun kaydına bakılır.
        const registered = await isWorktreeRegistered(this.repoRoot, this.workspaceDir).catch(() => null);
        if (registered === false) {
          // Ne dizin ne kayıt var → imha zaten tamam.
          this.destroyed = true;
          return;
        }
        if (registered === true) {
          // Kayıt kaldı → bir kez daha HEDEFLİ temizlik (eksik-ama-kayıtlı
          // yolda `remove --force` yalnız o kaydı siler — ölçüldü, Git 2.50.1).
          const retried = await runGit(["worktree", "remove", "--force", this.workspaceDir], {
            cwd: this.repoRoot,
            config: [HOOKS_DISABLED_CONFIG],
          }).then(
            () => true,
            () => false,
          );
          if (retried) {
            this.destroyed = true;
            return;
          }
        }
        // Liste okunamadı (null) VEYA yeniden deneme başarısız → güvenli hata.
      }
      throw new WorkspaceError("workspace_operation_failed", "Workspace destruction failed", { cause: err });
    }
    this.destroyed = true;
  }

  // ── iç yardımcıları ───────────────────────────────────────────────────────

  /**
   * Bilinen worker-oluşturulan yolları tek tek kaldırır (spec 37/38 +
   * PR #24 Fix 4 — `activeFs` seam'i üzerinden):
   * - yalnız O TAM yol `unlink` edilir (sembolik bağlantı TAKİP edilmez)
   * - `lstat` ENOENT → yol zaten temiz → devam (race affedilir)
   * - `lstat` başka hata / `unlink` başka hata (örn. EACCES) → tip'li
   *   `workspace_operation_failed` ATILIR — çağrıya yayılır; yol BİLİNEN
   *   KALINTI olarak kümede kalır (çağrı tarafı kümeyi temizlemez)
   * - yolun üstünde DİZİN/özel nesne → aynı tip'li hata: RECURSIVE silme
   *   YOK, `rm -rf` YOK, `git clean` YOK (geniş temizlik yasağı, spec 37)
   * - kümeyi kapsamayan hiçbir dosya dokunulmaz (spec 89 test'i)
   */
  private async removeWorkerCreatedPaths(paths: Iterable<string>): Promise<void> {
    for (const canonical of paths) {
      const abs = resolveContained(this.workspaceDir, canonical);
      if (abs === null) {
        continue; // defensive: yol doğrulaması oluşumda yapılmıştı
      }
      let stat: Stats;
      try {
        stat = await activeFs.lstat(abs);
      } catch (err) {
        if (isErrnoCode(err, "ENOENT")) {
          continue; // zaten yok — temiz.
        }
        throw new WorkspaceError("workspace_operation_failed", "Cleaning the worker-created paths failed", {
          cause: err,
        });
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        // Bilinen dosya yolunun üstünde dizin/özel nesne belirseydi →
        // genişletmeden güvenli hata (içerik aynen kalır; kalıntı kümede).
        throw new WorkspaceError("workspace_operation_failed", "Cleaning the worker-created paths failed");
      }
      try {
        await activeFs.unlink(abs);
      } catch (err) {
        if (isErrnoCode(err, "ENOENT")) {
          continue; // race: lstat ile unlink arasında kaldırıldı — affedilir.
        }
        throw new WorkspaceError("workspace_operation_failed", "Cleaning the worker-created paths failed", {
          cause: err,
        });
      }
    }
  }

  /**
   * Worker'ın modify/delete ettiği tracked `.gitattributes` yollarını
   * (PR #24 SB-1) saf-fs ile BİREBİR immutable base haliyle geri yazar:
   * base'in yakalanma anındaki working-tree baytları + git modu.
   *
   * GEREKÇE (ölçüldü, Apple Git 2.50.1): `git reset --hard <base>` bir
   * tracked dosyanın stat'ı (boyut + mtime saniyesi) index'le "aynı"
   * göründüğünde (racy koşulum: tracked-modified + aynı saniye + aynı
   * boyut) içerik doğrulamasını yeniden çalıştırır; bu yeniden doğrulama
   * ÇALIŞMA dosyasındaki `.gitattributes` yüzeyindeki CLEAN filter'ı
   * host'ta yürütür. Worker o yüzeyi yazabilir (tracked attr modify/
   * delete — config'de önceden tanımlı driver, LFS dahi, yürütülürdü).
   * Yüzey, git komutundan ÖNCE, base'in birebir haliyle geri yazılmalıdır.
   *
   * Restore ≠ dedektör: her turdaki fail-closed filter re-check'lerinin
   * (audit F-6) ikamesi DEĞİLDİR — ikisi de devrededir (re-check = tur
   * içi yürütme kanıtı; restore = racy pencerede güvenli yüzey).
   *
   * Her yol için kontrol sırası (ilk başarısızlık → yöntem BÜTÜNÜ red,
   * `reset --hard` YÜRÜTÜLMEZ — fail-closed; mesaj SABİT, yol/içerik
   * taşınmaz):
   *   1. yol workspace içinde (containment — defansif; validate geçirmişti)
   *   2. base'te var + tip DÜZENLİ DOSYA (symlink/gitlink → fail-closed:
   *      link hedefi / submodule kimliği bayt-yazımı + mod aynasıyla
   *      BİREBİR geri yazılamaz)
   *   3. base baytları yakalanmış (`editableContent` — validate,
   *      modify/delete → `editable` zorlar; yapısal olarak daima var)
   *   4. atallarda/hedefte sembolik bağlantı yok (GERÇEK fs ile — yazım
   *      workspace dışına kanaldır; seam yalnız yazım arızası enjekte
   *      eder, atal güvenliği gerçeğe dayanır)
   *   5. ebeveyn dizin yoksa oluşturulur (worker dizini silebilmiştir)
   *   6. base baytları `writeFile` ile yazılır
   *   7. mod base'in git moduyla birebir aynalanır (`chmod`)
   *
   * Adım 5–7 `activeFs` seam'i üzerinden (test: arıza/enjeksiyonu).
   */
  private async restoreBaseAttributeFiles(paths: Iterable<string>): Promise<void> {
    for (const canonical of paths) {
      const abs = resolveContained(this.workspaceDir, canonical);
      if (abs === null) {
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
      }
      const fingerprint = this.validationBase.editable.get(canonical);
      if (fingerprint === undefined || !fingerprint.exists) {
        // Restore edilecek base hali temsil edilemiyor → fail-closed.
        // (validate modify/delete → `editable` zorlar; yapısal olarak
        // beklenmez — bilinmeyen hal git'ten asla geçirilmez.)
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
      }
      if (fingerprint.type !== "file") {
        // symlink (120000) / gitlink (160000): base'in link hedef metni /
        // submodule kimliği, düz bayt-yazımı + chmod ile BİREBİR geri
        // yazılamaz (link'in kendisi `unlink` + `symlink` ister; mod
        // aynası anlamsız). Fail-closed: reset YÜRÜTÜLMEZ (PR #24 SB-1
        // kararı).
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
      }
      const baseContent = this.validationBase.editableContent.get(canonical);
      if (baseContent === undefined) {
        // Parmak izi "file" diyor ama içerik yakalanmamış — tutarsızlık.
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
      }
      if (await hasSymlinkInPath(abs, this.workspaceDir, { includeTarget: true })) {
        // Atal/hedef link → bayt-yazımı workspace dışına kaçar (Fix 1-B
        // ile aynı gerekçe). Denetim GERÇEK fs'tir (yukarıda).
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
      }
      try {
        await activeFs.mkdir(path.dirname(abs), { recursive: true });
        await activeFs.writeFile(abs, baseContent);
        await activeFs.chmod(abs, attributeBaseMode(fingerprint.mode));
      } catch (err) {
        if (err instanceof WorkspaceError) {
          throw err;
        }
        throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed", {
          cause: err,
        });
      }
    }
  }

  /** `git diff --name-only -z <base>` → repository-göreceli değişen yollar (spec 62). */
  private async changedPaths(): Promise<string[]> {
    const result = await this.git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      this.baseCommit,
    ]);
    return splitNul(result.stdout).filter((entry) => entry !== "");
  }

  /**
   * `git diff --numstat -z <base>` → { files, insertions, deletions } (spec 65).
   * Binary girdiler (`-`) dosya sayısına dahildir, sayısal katkıları 0'dır.
   * `--no-renames`: worker şemasında rename primitive'i yok (delete + create)
   * — kullanıcının rename config'i sonuç semantiğini değiştiremez (spec 66).
   * `paths`: önceden doğrulanmış `:(literal)` pathspec'leri (`literalPathFilter`);
   * boş → filtresiz (`applyPatchSet` çağrısı daima filtresiz).
   */
  private async statInternal(paths: string[] = []): Promise<DiffStats> {
    const args: string[] = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--numstat",
      "-z",
      this.baseCommit,
    ];
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    const result = await this.git(args);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const record of splitNul(result.stdout)) {
      if (record === "") {
        continue;
      }
      const firstTab = record.indexOf("\t");
      if (firstTab === -1) {
        continue; // bozuk kayıt — sayılmaz (dışarı sızdırılmaz)
      }
      const secondTab = record.indexOf("\t", firstTab + 1);
      const insertionsText = record.slice(0, firstTab);
      const deletionsText =
        secondTab === -1 ? record.slice(firstTab + 1) : record.slice(firstTab + 1, secondTab);
      files += 1;
      if (insertionsText !== "-") {
        insertions += Number(insertionsText);
      }
      if (deletionsText !== "-") {
        deletions += Number(deletionsText);
      }
    }
    return { files, insertions, deletions };
  }
}

/**
 * Base parmak izindeki git modunu (yalnız düzenli dosya modları) `chmod`
 * moduna çevirir: `100755` → 0755, `100644` → 0644. Başka mod yapısal
 * olarak beklenmez (`file` tipi yalnız bu ikisini taşır) → fail-closed:
 * restore, bilinmeyen modda yürütülmez.
 */
function attributeBaseMode(mode: string): number {
  if (mode === "100755") {
    return 0o755;
  }
  if (mode === "100644") {
    return 0o644;
  }
  throw new WorkspaceError("workspace_operation_failed", "Restoring the attribute files failed");
}

// ── Oluşturma ───────────────────────────────────────────────────────────────

/**
 * Seçili untracked dosyayı worktree'ye kopyalar (spec 21/50 + PR #24 Fix 1):
 * - HEDEF tarafı: workspace'teki atal bileşenler arasında sembolik bağlantı
 *   varsa `mkdir`/`writeFile`/`symlink`/`rename`/`chmod` link'i TAKİP edip
 *   izole workspace DIŞINA yazabilir → `unsafe_path` (mesaj SABİT).
 * - KAYNAK tarafı: ana working-tree'deki atal bileşenler arasında sembolik
 *   bağlantı varsa `readFile`/`readlink` repo DIŞINDAKİ içeriği okuyup
 *   izole base'e kopyalayabilir → `unsafe_path`.
 * Seçili yolun KENDİSİ link ise meşrudur (mevcut hedef-içeride kontrolü
 * derin savunma olarak kalır).
 */
async function copySelectedUntrackedFile(
  repoRoot: string,
  workspaceDir: string,
  canonical: string,
): Promise<void> {
  const mainAbs = resolveContained(repoRoot, canonical);
  const wsAbs = resolveContained(workspaceDir, canonical);
  if (mainAbs === null || wsAbs === null) {
    throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
  }

  const stat = await lstat(mainAbs).catch(() => null);
  if (stat === null) {
    return; // ana depoda yok → base'te yok; kopyalanacak şey yok
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new WorkspaceError("invalid_input", "A selected path is not a file");
  }

  // Fix 1-B (hedef): workspace'teki ATALLARDA link → yazım workspace dışına
  // kaçar. Son bileşen (kopyalanacak link'in kendisi) denetlenmez.
  if (await hasSymlinkInPath(wsAbs, workspaceDir, { includeTarget: false })) {
    throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
  }
  // Fix 1-A (kaynak): ana depodaki ATALLARDA link → okuma repo dışından
  // içerik taşır. Son bileşen denetlenmez (link ise hedef kontrolü aşağıda).
  if (await hasSymlinkInPath(mainAbs, repoRoot, { includeTarget: false })) {
    throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
  }

  await mkdir(path.dirname(wsAbs), { recursive: true });

  if (stat.isSymbolicLink()) {
    // Link'in KENDİSİ kopyalanır; hedef İÇERİK okunmaz/takip edilmez (spec 21/50).
    const target = await readlink(mainAbs);
    if (!symlinkTargetStaysInside(repoRoot, mainAbs, target)) {
      throw new WorkspaceError("unsafe_path", "A selected path is an unsafe symlink");
    }
    // Taze checkout: yol zaten yok; yine de üstü üstüne yazmaya karşı atomik ol.
    const tempLink = `${wsAbs}.splash-tmp-${process.pid}`;
    await symlink(target, tempLink).catch(() => undefined);
    await rm(wsAbs, { force: true }).catch(() => undefined);
    await rename(tempLink, wsAbs);
    return;
  }

  const bytes = await readFile(mainAbs);
  await writeFile(wsAbs, bytes);
  // İlgili çalıştırılabilir mod korunur (spec 21).
  const mode = (stat.mode & 0o100) !== 0 ? 0o755 : 0o644;
  await chmod(wsAbs, mode);
}

/**
 * v1 politikası (fail-closed, PR #24 Fix 3 + audit F-6): verilen git kökü
 * (`gitRoot`) altındaki tracked yollar + ek yollar arasında herhangi biri
 * bir DIŞ Git filter'ı (`filter.<driver>.clean/smudge/process`)
 * gerektiriyorsa `invalid_repository` güven hatası ile red. Komut
 * YÜRÜTÜLMEZ, config değiştirilmez/silinmez.
 *
 * İKİ çağrı noktası (aynı mekanizma, farklı yüzey):
 * - **oluşturma** (`gitRoot` = ana repo kökü, `sourceSha` = HEAD):
 *   1. **working-tree** (`--source` YOK): tracked (`ls-files`) ∪ seçili
 *      yollar — delta yakalayan komut (`git diff HEAD`) CLEAN filter'ı
 *      bu yüzeyle çalıştırır;
 *   2. **HEAD ağacı** (`--source <sourceSha>`): TAM HEAD ağacı
 *      (`ls-tree -r -z --name-only`) ∪ tracked ∪ seçili — çünkü
 *      `git worktree add --detach <headSha>` TÜM committed tree'yi
 *      checkout eder ve COMMITTED `.gitattributes` yüzeyini (SMUDGE
 *      filter) uygulatır: working-tree kopyası kirlenmiş (örn. attr
 *      satırı silinmiş) bir tehdit, committed kopyada HÂLÂ geçerlidir
 *      (ölçüldü, Apple Git 2.50: `--source` ağaç attribute'larını, ağaçta
 *      olmayan yol adları için bile pattern eşleşmesiyle raporlar).
 * - **her tur** (`gitRoot` = worktree, `sourceSha` = immutable base
 *   commit, PR #24 audit F-6): worker yazıları worktree'de
 *   UYGULANDIKTAN, turun ilk filter-capable komutundan (add -N / diff)
 *   ÖNCE — worker, worktree'nin attribute yüzeyini YAZABİLİR (ör.
 *   `d/.gitattributes` = `** filter=evil`); config'de ÖNCEDEN tanımlı
 *   driver'ın (LFS dahi) komutu, tur içi diff/stat/export'ta bu
 *   yüzeyle host'ta yürütülürdü. Yüzey: worktree'nin `ls-files`'i ∪
 *   turun plan yolları ∪ bilinen kalıntı (`workerCreatedPaths`);
 *   2. pass = base commit ağacı (`--source <baseCommit>` — fail-closed
 *   simetrisi). export diff'inden önce aynı check yeniden koşar.
 *
 * Adımlar (tamamı salt-okunur; `runGit`'in hook+fsmonitor kilidi devrede):
 *   a. `git ls-files -z` (tracked yollar)
 *   b. `git ls-tree -r -z --name-only <sourceSha>` (committed ağaç =
 *      `git worktree add`'in yazacağı / turun diff tabanı kümesi)
 *   c. her yüzey için TEK çağrıda `git check-attr filter ... -z --stdin`
 *      (`collectFilterDrivers` — tek merkezi parse)
 *   d. her driver için `git config --get filter.<d>.clean/.smudge/.process`
 *      — herhangi bir scope'ta tanımlı VE BOŞ DEĞİL → tehdit.
 *
 * Herhangi bir yüzeyde tehdit → AYNI red: `invalid_repository` + SABİT
 * mesaj (yeni mesaj YOK; driver adı/komut/path taşınmaz). Herhangi bir
 * pass'te git-seviyesi hata (örn. `--source` desteklemeyen eski git) →
 * `git_operation_failed` fail-closed: doğrulanamayan attribute yüzeyi =
 * repo çalıştırılmaz (bilinçli — DESIGN.md §7.2 notu).
 *
 * LFS (`filter.lfs`) da dış filter olduğundan v1'de desteklenmez — aynı red
 * (PR/issue notu). Builtin `text`/`eol` normalizasyonu filter DEĞİLDİR —
 * bu denetimin konusu değildir (çalışmaya devam eder).
 */
async function assertNoExternalFilters(
  gitRoot: string,
  paths: readonly string[],
  sourceSha: string,
): Promise<void> {
  let tracked: string[];
  try {
    const ls = await runGit(["ls-files", "-z"], { cwd: gitRoot, config: [HOOKS_DISABLED_CONFIG] });
    tracked = splitNul(ls.stdout).filter((entry) => entry !== "");
  } catch (err) {
    throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", { cause: err });
  }

  let sourceTree: string[];
  try {
    const ls = await runGit(["ls-tree", "-r", "-z", "--name-only", sourceSha], {
      cwd: gitRoot,
      config: [HOOKS_DISABLED_CONFIG],
    });
    sourceTree = splitNul(ls.stdout).filter((entry) => entry !== "");
  } catch (err) {
    // Committed ağaç sayılamıyor → checkout/diff yüzeyi doğrulanamıyor → fail-closed.
    throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", { cause: err });
  }

  // İki yüzey, tek parse mantığı: working-tree (delta/clean) +
  // committed ağaç (checkout/smudge).
  const worktreeSurface = [...new Set([...tracked, ...paths])];
  const sourceSurface = [...new Set([...sourceTree, ...tracked, ...paths])];
  const drivers = new Set<string>();
  for (const driver of await collectFilterDrivers(gitRoot, worktreeSurface, [])) {
    drivers.add(driver);
  }
  for (const driver of await collectFilterDrivers(gitRoot, sourceSurface, ["--source", sourceSha])) {
    drivers.add(driver);
  }

  for (const driver of [...drivers].sort()) {
    for (const kind of ["clean", "smudge", "process"]) {
      const value = await readConfigValue(gitRoot, `filter.${driver}.${kind}`);
      if (value !== null && value.trim().length > 0) {
        // Tehdit: config (herhangi bir scope'ta) bir dış program
        // tanımlamış. SABİT mesaj — driver adı/komut/path taşınmaz.
        throw new WorkspaceError("invalid_repository", "An external Git filter is not supported");
      }
    }
  }
}

/**
 * Verilen yollar için TEK `git check-attr filter` çağrısı (salt-okunur —
 * check-attr yalnız attr DEĞERİNİ raporlar, filter'ı asla YÜRÜTMEZ) +
 * paylaşılan çıktı parse'ı; bulunan driver adlarını döndürür (boş olabilir).
 *
 * `extraArgs`: committed-ağaç yüzeyi için `["--source", sourceSha]` —
 * attribute'lar ÇALIŞMA ağacı yerine COMMITTED ağaçtan okunur.
 *
 * Parse = TEK MERKEZİ mantık (ölçüldü, Apple Git 2.50): kayıt formatı
 * `path\0filter\0value\0` (yol içinde NUL olamaz); çıktı NUL ile BİTİR
 * (`a.txt\0filter\0unspecified\0...`) → `splitNul`'in koruduğu tek sondaki
 * "" düşülür. `unset`/`unspecified`/boş değer yalancı driver DEĞİLdir;
 * geriye kalan her değer bir driver ADI'dır (komut araması yukarıda).
 * Format/kayıt beklentimizi sağlamıyorsa (sürüm farklılığı) VEYA git
 * seviyesinde hata olursa (örn. `--source` desteklemeyen eski git) →
 * fail-closed `git_operation_failed`: filter durumu doğrulanamayan
 * yüzey/repo çalıştırılmaz (güvenli taraf).
 */
async function collectFilterDrivers(
  repoRoot: string,
  paths: readonly string[],
  extraArgs: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) {
    return []; // bu yüzeyde denetlenecek yol yok → filter yürütemez.
  }

  let output: Buffer;
  try {
    const result = await runGit(
      ["check-attr", "filter", ...extraArgs, "-z", "--stdin"],
      {
        cwd: repoRoot,
        config: [HOOKS_DISABLED_CONFIG],
        stdin: Buffer.from(`${paths.join("\0")}\0`, "utf8"),
      },
    );
    output = result.stdout;
  } catch (err) {
    throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", { cause: err });
  }

  const records = splitNul(output);
  if (records.length > 0 && records[records.length - 1] === "") {
    records.pop();
  }
  if (records.length % 3 !== 0) {
    throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", {
      cause: "malformed check-attr output",
    });
  }
  const drivers = new Set<string>();
  for (let i = 0; i < records.length; i += 3) {
    const attr = records[i + 1];
    const value = records[i + 2];
    if (attr !== "filter" || value === undefined) {
      throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", {
        cause: "malformed check-attr record",
      });
    }
    // "unset"/"unspecified" = filter attribute'i tanımlı değil (yalancı
    // driver değil); boş değer = komut yok. Geriye kalan her değer bir
    // driver ADI'dır → config'de komut araması `assertNoExternalFilters`'ta.
    if (value !== "unset" && value !== "unspecified" && value.length > 0) {
      drivers.add(value);
    }
  }
  return [...drivers];
}

/**
 * `git config --get <key>` salt okuma:
 * - tanımlı → değer (boş olabilir — boş DEĞER tehdit sayılmaz);
 * - tanımsız (exit 1, çıktı YOK — git'in belgeli davranışı) → `null`;
 * - başka git hatası → mevcut `git_operation_failed` kalıbı.
 */
async function readConfigValue(repoRoot: string, key: string): Promise<string | null> {
  try {
    const result = await runGit(["config", "--get", key], {
      cwd: repoRoot,
      config: [HOOKS_DISABLED_CONFIG],
    });
    return result.stdout.toString("utf8").trim();
  } catch (err) {
    const cause =
      err instanceof WorkspaceError ? (err.cause as { exitCode?: number | null; stderr?: string } | undefined) : undefined;
    if (cause !== undefined && cause.exitCode === 1 && (cause.stderr ?? "") === "") {
      return null; // key tanımsız — tehdit yok.
    }
    throw new WorkspaceError("git_operation_failed", "A Git operation failed", { cause: err });
  }
}

/**
 * `GitWorktreeWorkspace` oluşturur (spec 18 zorunlu sırası — dosya başlığı).
 * Başarısız bir oluşum, yarım worktree BIRAKMAZ (spec 74): `git worktree add`
 * sonrasında her hatada worktree güvenli biçimde kaldırılır; ana depoya
 * DOKUNULMAZ.
 */
export async function createGitWorktreeWorkspace(input: WorkspaceCreateInput): Promise<GitWorktreeWorkspace> {
  // ── girdi doğrulaması ─────────────────────────────────────────────────────
  if (typeof input.repoRoot !== "string" || !path.isAbsolute(input.repoRoot)) {
    throw new WorkspaceError("invalid_input", "The repository root must be an absolute path");
  }
  if (typeof input.workspaceDir !== "string" || !path.isAbsolute(input.workspaceDir)) {
    throw new WorkspaceError("invalid_input", "The workspace directory must be an absolute path");
  }
  if (typeof input.sessionId !== "string" || !isSafeSessionId(input.sessionId)) {
    // Spec 12: güvenSİZ kimlik sessizce YENİDEN YAZILMAZ — oluşum reddedilir.
    throw new WorkspaceError("invalid_input", "The session id is not a safe identifier");
  }
  if (!Array.isArray(input.editablePaths)) {
    throw new WorkspaceError("invalid_input", "The editable paths must be an array");
  }

  const repoRoot = await canonicalRepoRoot(input.repoRoot);

  // ── workspaceDir repo DIŞINDA olmalı (spec 10; kanonik atal çözümleme) ───
  const workspaceDir = await canonicalizeOutside(path.resolve(input.workspaceDir), repoRoot);
  if (workspaceDir === null) {
    throw new WorkspaceError("unsafe_path", "The workspace directory must be outside the repository");
  }

  // ── dizin ön koşulu: var değil VEYA boş dizin (spec 11; force YOK) ───────
  const existing = await lstat(workspaceDir).catch(() => null);
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new WorkspaceError("invalid_input", "The workspace directory must not exist");
    }
    const entries = await readdir(workspaceDir);
    if (entries.length > 0) {
      throw new WorkspaceError("invalid_input", "The workspace directory must be empty");
    }
  }

  // ── seçili yollar: normalize + kanonik (alias'lar tek kimliğe düşer) ─────
  const editable = canonicalizeSelection(input.editablePaths);
  const readonly = canonicalizeSelection(input.readonlyPaths ?? []);
  for (const selected of readonly) {
    if (editable.has(selected)) {
      throw new WorkspaceError("invalid_input", "A path cannot be both editable and read-only");
    }
  }
  // Spec 16: seçili bağlam girdileri DOSYA benzeri olmalı (dizin/FIFO/socket/
  // cihaz red) — ana working-tree'de var olanlar için denetlenir.
  // Fix 1-C: seçili yola SEMBOLİK BAĞLANTI gelirse (tracked VEYA untracked —
  // base commit'ten gelen tracked dış link dahil) hedefi repo SINIRI içinde
  // olmalı; mutlak dış hedef / dışa kaçan link zinciri → oluşum red.
  // (copySelectedUntrackedFile'deki aynı kontrol derin savunma olarak kalır.)
  for (const selected of [...editable, ...readonly]) {
    const abs = resolveContained(repoRoot, selected);
    if (abs === null) {
      throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
    }
    const stat = await lstat(abs).catch(() => null);
    if (stat === null) {
      continue; // ana working-tree'de yok (örn. tracked silme) — denetlenecek hâl yok
    }
    if (stat.isSymbolicLink()) {
      let target: string | null;
      try {
        target = await readlink(abs);
      } catch {
        target = null; // race: link anında değişti — doğrulanamaz → fail-closed
      }
      if (target === null || !(await symlinkTargetStaysInside(repoRoot, abs, target))) {
        throw new WorkspaceError("unsafe_path", "A selected path is an unsafe symlink");
      }
      continue;
    }
    if (!stat.isFile()) {
      throw new WorkspaceError("invalid_input", "A selected path is not a file");
    }
  }

  // ── ana depo: HEAD commit'i zorunlu (v1 worktree tabanı, spec 7) ──────────
  // Çözümleme F3 denetiminden ÖNCE: HEAD-ağacı attribute pass'i bu SHA'yı
  // `check-attr --source` değeri olarak kullanır.
  let headSha: string;
  try {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG] });
    headSha = head.stdout.toString("utf8").trim();
  } catch (err) {
    throw new WorkspaceError("invalid_repository", "The repository does not have a HEAD commit", { cause: err });
  }
  if (headSha === "") {
    throw new WorkspaceError("invalid_repository", "The repository does not have a HEAD commit");
  }

  // ── (F3) repo-tanımlı DIŞ Git filter'ları v1'de YÜRÜTÜLMEZ (fail-closed) ────
  // `filter.<driver>.clean/smudge/process` = repo tanımlı dış programlar
  // (LFS vb.). İlgili yollar böyle bir filter gerektiriyorsa oluşum GÜVENLİ
  // HATA ile reddedilir: komut YÜRÜTÜLMEZ, config DEĞİŞTİRİLMEZ/silinmez.
  // İKİ attribute yüzeyi denetlenir (audit F-1):
  //   1. working-tree (`--source` yok): delta yakalayan `git diff HEAD`
  //      CLEAN filter'ı tracked ∪ seçili yollarla çalıştırır;
  //   2. HEAD ağacı (`--source <headSha>`): `git worktree add` TÜM
  //      committed tree'yi checkout eder ve COMMITTED `.gitattributes`
  //      yüzeyini (SMUDGE) uygulatır — working-tree kopyası silinmiş/kirli
  //      bir attr, committed kopyada hâlâ geçerlidir → aynı red.
  // Konum: delta yakalama ADIMINDAN ÖNCE — ilk filter yürütebilecek
  // komutlar `git diff HEAD` (clean) ve `git worktree add` (smudge)'tir.
  // `check-attr` yalnız attr DEĞERİNİ raporlar (filter yürütmez);
  // `config --get` salt okumadır. `text`/`eol` BUILTIN normalizasyonu
  // filter DEĞİLDİR (çalışır, yasak değil). Worktree henüz oluşturulmadı
  // → temiz çıkış, geriye hiçbir şey kalmaz.
  await assertNoExternalFilters(repoRoot, [...editable, ...readonly], headSha);

  // ── (1) tracked delta: staged + unstaged, binary, tam index (spec 19) ────
  // `git diff` (düz) KULLANILMAZ — yalnızca staged değişiklikleri kaçırır.
  let trackedDelta: Buffer;
  try {
    const diff = await runGit(
      ["diff", "HEAD", ...PATCH_FORMAT_ARGS, "--binary", "--full-index", "--no-ext-diff", "--no-textconv"],
      { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG] },
    );
    trackedDelta = diff.stdout;
  } catch (err) {
    throw new WorkspaceError("git_operation_failed", "Capturing the repository state failed", { cause: err });
  }

  // ── (2) detached worktree (hook'lar devre dışı; branch YOK — spec 24/26) ─
  try {
    await runGit(
      ["worktree", "add", "--detach", workspaceDir, headSha],
      { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG] },
    );
  } catch (err) {
    throw new WorkspaceError("git_operation_failed", "Git workspace creation failed", { cause: err });
  }

  // Bundan sonra her hata: yarım worktree KALDIRILIR (spec 74) — ana depoya
  // dokunulmaz.
  try {
    // ── (3) delta yalnız worktree içine uygulanır ───────────────────────────
    if (trackedDelta.length > 0) {
      try {
        // `--whitespace=nowarn`: kullanıcının `apply.whitespace=fix` config'i
        // delta'yı "düzelterek" base'i main'den SAPTIRIR, `=error` yakalamayı
        // düşürür (ölçüldü) — base, main'in BİREBİR baytları olmalı (spec 19/20).
        await runGit(
          ["apply", "--index", "--binary", "--whitespace=nowarn"],
          { cwd: workspaceDir, stdin: trackedDelta, config: [HOOKS_DISABLED_CONFIG] },
        );
      } catch (err) {
        // Birebir base kurulamadı → devam YOK (spec 20: partial base asla).
        throw new WorkspaceError("git_operation_failed", "Applying the captured repository state failed", {
          cause: err,
        });
      }
    }

    // ── (4) yalnız SEÇİLEN untracked bağlam kopyalanır (crawl YOK — spec 17/23) ──
    const selectedAll = [...new Set([...editable, ...readonly])];
    const presentInMain: string[] = [];
    for (const selected of selectedAll) {
      const abs = resolveContained(repoRoot, selected);
      if (abs === null) {
        continue;
      }
      const stat = await lstat(abs).catch(() => null);
      if (stat !== null) {
        presentInMain.push(selected);
      }
    }
    if (presentInMain.length > 0) {
      // tracked olanları ayırt et (tracked → delta ile zaten temsil edilir).
      // `:(literal)`: seçili yollar pathspec magic'i olarak yorumlanamaz
      // (audit CRITICAL-1) — `:(exclude)` gibi bir ad küme dışı düşüremez.
      let trackedInIndex: Set<string>;
      try {
        const ls = await runGit(["ls-files", "-z", "--", ...presentInMain.map(literalPathspec)], {
          cwd: repoRoot,
          config: [HOOKS_DISABLED_CONFIG],
        });
        trackedInIndex = new Set(splitNul(ls.stdout).filter((entry) => entry !== ""));
      } catch (err) {
        throw new WorkspaceError("git_operation_failed", "Reading the repository state failed", { cause: err });
      }
      for (const selected of presentInMain) {
        if (trackedInIndex.has(selected)) {
          continue; // tracked: delta step'inde temsil ediliyor
        }
        try {
          await copySelectedUntrackedFile(repoRoot, workspaceDir, selected);
        } catch (err) {
          if (err instanceof WorkspaceError) {
            throw err;
          }
          throw new WorkspaceError("workspace_operation_failed", "Copying the selected context failed", {
            cause: err,
          });
        }
      }
    }

    // ── (5/6) base'i stage'le: add -A + seçilen ignored tekil -f (spec 22/24) ──
    try {
      await runGit(["add", "-A"], { cwd: workspaceDir, config: [HOOKS_DISABLED_CONFIG] });
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Staging the base state failed", { cause: err });
    }
    // `add -A` ignore kurallarına uyar → seçilen ignored dosyalar stage'lenmez.
    // Yalnız seçilen untracked yollar arasında index'e GİRMEMEŞLERİ olanlar
    // (ignored) TEKİL `git add -f -- <yol>` ile alınır; `git add -f .` ASLA.
    if (presentInMain.length > 0) {
      // `:(literal)` pin'i (audit CRITICAL-1) — ana depodaki çağrıyla aynı
      // gerekçe; `add -f` altındaki `unstaged` kümesi magic'e kaydırılamaz.
      let unstaged: string[];
      try {
        const ls = await runGit(["ls-files", "-z", "--", ...presentInMain.map(literalPathspec)], {
          cwd: workspaceDir,
          config: [HOOKS_DISABLED_CONFIG],
        });
        const staged = new Set(splitNul(ls.stdout).filter((entry) => entry !== ""));
        unstaged = presentInMain.filter((selected) => !staged.has(selected));
      } catch (err) {
        throw new WorkspaceError("git_operation_failed", "Reading the base state failed", { cause: err });
      }
      if (unstaged.length > 0) {
        // `:(literal)` pin'i (audit CRITICAL-1): force-add tekil ve literal
        // yollarla — magic'li bir ad küme dışı dosyaları sürükleyemez.
        try {
          await runGit(["add", "-f", "--", ...unstaged.map(literalPathspec)], {
            cwd: workspaceDir,
            config: [HOOKS_DISABLED_CONFIG],
          });
        } catch (err) {
          throw new WorkspaceError("git_operation_failed", "Staging the selected ignored files failed", {
            cause: err,
          });
        }
      }
    }

    // ── (7) geçici base commit — hijyen (spec 24/25/26): ───────────────────
    // hook yok · imza yok · deterministik Splash kimliği (kullanıcının
    // user.name/email GEREKMEZ) · detached · --allow-empty · branch/tag/ref YOK.
    try {
      await runGit(
        ["commit", "--allow-empty", "-m", `splash base ${input.sessionId}`],
        {
          cwd: workspaceDir,
          config: [`commit.gpgsign=false`, HOOKS_DISABLED_CONFIG],
          env: SPLASH_GIT_IDENTITY,
        },
      );
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Creating the base commit failed", { cause: err });
    }

    // ── (8) base SHA → immutable kimlik (spec 27) ──────────────────────────
    let baseCommit: string;
    try {
      const base = await runGit(["rev-parse", "HEAD"], { cwd: workspaceDir, config: [HOOKS_DISABLED_CONFIG] });
      baseCommit = base.stdout.toString("utf8").trim();
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed", { cause: err });
    }
    if (baseCommit === "") {
      throw new WorkspaceError("git_operation_failed", "Reading the base commit failed");
    }

    // ── (9) immutable parmak izleri + base ağaç haritası (spec 29/30) ──────
    // KAYNAK = base commit (tek doğruluk kaynağı): ls-tree + cat-file.
    const { validationBase, publicBase } = await captureBase(
      workspaceDir,
      baseCommit,
      editable,
      readonly,
    );

    return new GitWorktreeWorkspace(
      repoRoot,
      workspaceDir,
      baseCommit,
      input.sessionId,
      [...editable],
      publicBase,
      validationBase,
    );
  } catch (err) {
    // Spec 74: yarım worktree güvenli biçimde kaldırılır; ana depoya dokunulmaz.
    try {
      await runGit(["worktree", "remove", "--force", workspaceDir], {
        cwd: repoRoot,
        config: [HOOKS_DISABLED_CONFIG],
      });
    } catch {
      // Kaldırma da başarısız → güvenli işletimsel hata (dizin kalabilir,
      // kullanıcı inceleyebilir; ana checkout bütünlüğü etkilenmez).
    }
    if (err instanceof WorkspaceError) {
      throw err;
    }
    throw new WorkspaceError("workspace_operation_failed", "Workspace creation failed", { cause: err });
  }
}

/** Seçili yolu normalize eder; güvenSİZ girdi → oluşum red (sessiz yazım YOK). */
function canonicalizeSelection(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") {
      throw new WorkspaceError("invalid_input", "A selected path must be a string");
    }
    const canonical = normalizeRepoPath(raw);
    if (canonical === null) {
      throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
    }
    out.add(canonical);
  }
  return out;
}

async function canonicalRepoRoot(raw: string): Promise<string> {
  try {
    return await realpath(raw);
  } catch {
    return path.resolve(raw);
  }
}

/**
 * `git ls-tree` yolunu workspace kökü altında mutlak yola çözer; içerme
 * ihlali → `null`. Git tree yolları yapısal olarak göreceli + `..`/mutlak
 * içeremez; bu denetim saf invariant korumasıdır (hasarlı/bozuk çıktı
 * workspace dışına kanal olamaz).
 */
function workspaceEntryPath(workspaceDir: string, gitPath: string): string | null {
  const abs = path.resolve(workspaceDir, gitPath);
  const rel = path.relative(workspaceDir, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/**
 * Base parmak izi + içerik yakalama (spec 29/30/31 + PR #24 Fix 2):
 * - seçili yollar: `git ls-tree -r -z <base> -- <yollar>` → varlık + git modu
 * - base ağacı:    `git ls-tree -r -z <base>` → tam yol→mod haritası
 *   (`basePaths` — create/delete denetimlerinin yapısal kaynağı; aynen)
 * - tip/mod:       worktree ÇALIŞMA DOSYASININ `lstat`'ı — `captureLiveFingerprint`
 *   ile BİREBİR aynı alan (`0o100` bit → `100755`/`100644`; link → `120000`)
 * - içerik:        çalışma dosyasının BİREBİR baytları (düzenli dosya) /
 *   link hedef metni (sembolik bağlantı) → SHA-256 — git blob baytları DEĞİL
 *
 * İKİ ALAN KARIŞTIRILMAZ: parmak izi/tam-eşleşme içeriği = working-tree
 * baytları (worker'a gösterilen); geçici base commit = diff/reset/export
 * tabanı. `text`/`eol` normalizasyonu blob ile working tree'yi farklı
 * baytlara sokabilir (ör. CRLF vs LF) — bu beklenen; base parmak izi
 * working-tree tarafında kaldığı için tam eşleşme ve Step 9'un
 * canlı↔base karşılaştırması aynı ölçekte çalışır.
 *
 * Çalışan dosya okunamıyorsa (commit ile yakalama arasındaki race/izin —
 * yapısal olarak neredeyse imkânsız) → güvenli işletimsel hata (capture
 * adımı işletimseldir: `git_operation_failed`).
 *
 * Düzenlenebilir dosya/link içeriği BİREBİR saklanır — arama/değiştirme
 * doğrulaması her zaman bu immutable içeriğe karşıdır (spec 29: workspace'in
 * mutable hali DEĞİL).
 */
async function captureBase(
  workspaceDir: string,
  baseCommit: string,
  editable: Set<string>,
  readonly: Set<string>,
): Promise<{ validationBase: WorkspaceBase; publicBase: WorkspaceBaseInfo }> {
  const selected = [...new Set([...editable, ...readonly])];

  let selectedEntries: LsTreeEntry[];
  let fullEntries: LsTreeEntry[];
  try {
    // `:(literal)` pin'i (audit CRITICAL-1): seçili yollar pathspec
    // magic'i olarak yorumlanamaz — tam-ağaç çağrısı (`--` YOK) etkilenmez.
    const selectedTree = await runGit(
      selected.length > 0
        ? ["ls-tree", "-r", "-z", baseCommit, "--", ...selected.map(literalPathspec)]
        : ["ls-tree", "-r", "-z", baseCommit],
      { cwd: workspaceDir, config: [HOOKS_DISABLED_CONFIG] },
    );
    selectedEntries = selected.length > 0 ? parseLsTree(selectedTree.stdout) : [];
    const fullTree = await runGit(["ls-tree", "-r", "-z", baseCommit], {
      cwd: workspaceDir,
      config: [HOOKS_DISABLED_CONFIG],
    });
    fullEntries = parseLsTree(fullTree.stdout);
  } catch (err) {
    throw new WorkspaceError("git_operation_failed", "Reading the base state failed", { cause: err });
  }

  const entryByPath = new Map<string, LsTreeEntry>();
  for (const entry of selectedEntries) {
    entryByPath.set(entry.filePath, entry);
  }

  const basePaths = new Map<string, string>();
  for (const entry of fullEntries) {
    basePaths.set(entry.filePath, normalizeGitFileMode(entry.mode));
  }

  const fingerprints = new Map<string, PathFingerprint>();
  const editableFingerprints = new Map<string, PathFingerprint>();
  const editableContent = new Map<string, Buffer>();

  const unsafeBase = (): WorkspaceError =>
    new WorkspaceError("git_operation_failed", "The captured editable base could not be represented safely");

  for (const canonical of selected) {
    const entry = entryByPath.get(canonical);
    if (entry === undefined) {
      // Base ağacında yok (ana working-tree'de de olmayan seçili yol).
      fingerprints.set(canonical, { exists: false });
      if (editable.has(canonical)) {
        editableFingerprints.set(canonical, { exists: false });
      }
      continue;
    }

    const gitType = gitModeType(entry.mode);
    if (gitType === "other") {
      // gitlink (160000) vb.: git-tabanlı tip+mod korunur (içerik YOK).
      fingerprints.set(canonical, { exists: true, type: "other", mode: normalizeGitFileMode(entry.mode) });
      continue;
    }

    // file/symlink: worktree'deki çalışma dosyası — canlı parmak iziyle aynı alan.
    const abs = workspaceEntryPath(workspaceDir, entry.filePath);
    if (abs === null) {
      // İnvariant bozuldu (bozuk ls-tree çıktısı) — güvenli taraf: red.
      throw new WorkspaceError("unsafe_path", "A base path is unsafe");
    }
    let stat: Stats;
    try {
      stat = await lstat(abs);
    } catch (err) {
      // Base commit ile yakalama arasındaki race/izin: base güvenli
      // biçimde temsil edilemez → işletimsel hata (oluşum red).
      throw new WorkspaceError("git_operation_failed", "The captured editable base could not be represented safely", {
        cause: err,
      });
    }

    let fingerprint: PathFingerprint;
    if (gitType === "symlink") {
      if (!stat.isSymbolicLink()) {
        // Base ağacı link diyor, worktree dosya diyor — tutarsızlık.
        throw unsafeBase();
      }
      let target: string;
      try {
        target = await readlink(abs);
      } catch (err) {
        // lstat "link" dedi, readlink okuyamadı (race/izin) → base güvenli
        // biçimde temsil edilemez → işletimsel hata (oluşum red).
        throw new WorkspaceError("git_operation_failed", "The captured editable base could not be represented safely", {
          cause: err,
        });
      }
      const bytes = Buffer.from(target, "utf8");
      fingerprint = { exists: true, type: "symlink", mode: "120000", contentSha256: sha256Hex(bytes) };
      if (editable.has(canonical)) {
        editableContent.set(canonical, bytes);
      }
    } else {
      // Düzenli dosya: git tree 100644/100755; worktree'de düz dosya olmalı.
      if (!stat.isFile()) {
        throw unsafeBase();
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (err) {
        throw new WorkspaceError("git_operation_failed", "The captured editable base could not be represented safely", {
          cause: err,
        });
      }
      const executable = (stat.mode & 0o100) !== 0;
      fingerprint = {
        exists: true,
        type: "file",
        mode: executable ? "100755" : "100644",
        contentSha256: sha256Hex(bytes),
      };
      if (editable.has(canonical)) {
        editableContent.set(canonical, bytes);
      }
    }

    fingerprints.set(canonical, fingerprint);
    if (editable.has(canonical)) {
      editableFingerprints.set(canonical, fingerprint);
    }
  }

  return {
    validationBase: {
      editable: editableFingerprints,
      editableContent,
      readonly: new Set(readonly),
      basePaths,
    },
    publicBase: { fingerprints, basePaths },
  };
}

// ── Kurtarma (Step 9) ───────────────────────────────────────────────────────

/**
 * Kalıcı bir `WorkspaceRecoveryState`'ten worktree'yi BİREBİR yeniden kurar
 * (Step 9 spec 103-127) ve yeniden kurulmuş `GitWorktreeWorkspace`'i döndürür.
 *
 * Disiplin (spec 105/115/123): immutable base ASLA mevcut main içeriğinden
 * yeniden yakalanmaz — `readBaseEntry` snapshot'ı + base ağacı + kimlik,
 * PERSISTED state'ten BİREBİR yeniden kurulur. SessionManager bu API'nin
 * git iç mantığını bilmez (spec 113); yalnız state'i verir/geri alır.
 *
 * Maddelendirme (spec 109-111, 126, 127):
 * - worktree HAYATTA + kimlik (HEAD==base) + state hash == kalıcı hash →
 *   REUSE (imha/yeniden kurma YOK — spec 126).
 * - worktree HAYATTA ama kimlik uyuşmaz VEYA state hash çelişki → güvenilmez:
 *   güvenli imha + yeniden kur (spec 110/127); ana depoya dokunulmaz.
 * - worktree YOK (restart) → PERSISTED state'ten yeniden kur (spec 111):
 *   - base commit nesnesi object DB'de → `worktree add --detach` (byte-birebir);
 *   - nesne yok → `mktree`+`commit-tree` (aynı tree/commit SHA) + `worktree add`;
 *   - eksik blob/nesne → fail-closed `workspace_operation_failed` (kısmi
 *     rekonstrüksiyon YOK, spec 275).
 *
 * Dönen workspace: yeniden kurulduysa immutable base'tedir; hayatta reuse'ta
 * kalıcının kendisidir. SessionManager `recoveryStateHash()`'ı kalıcı hash'le
 * karşılaştırıp (spec 120/121) gerekirse son worker sonucunu yeniden uygular.
 */
export async function restoreGitWorktreeWorkspace(
  state: WorkspaceRecoveryState,
  options: { expectedWorkspaceDir: string },
): Promise<GitWorktreeWorkspace> {
  // ── kimlik + yol güvenliği (spec 106/190) ─────────────────────────────────
  if (state.schemaVersion !== 1) {
    throw new WorkspaceError("invalid_input", "The recovery state has an unsupported schema version");
  }
  if (typeof state.repoRoot !== "string" || !path.isAbsolute(state.repoRoot)) {
    throw new WorkspaceError("invalid_input", "The repository root must be an absolute path");
  }
  if (typeof state.workspaceDir !== "string" || !path.isAbsolute(state.workspaceDir)) {
    throw new WorkspaceError("invalid_input", "The workspace directory must be an absolute path");
  }
  if (typeof options.expectedWorkspaceDir !== "string" || !path.isAbsolute(options.expectedWorkspaceDir)) {
    throw new WorkspaceError("invalid_input", "The expected workspace directory must be an absolute path");
  }
  if (!isSafeSessionId(state.sessionId)) {
    throw new WorkspaceError("invalid_input", "The session id is not a safe identifier");
  }
  const repoRoot = path.resolve(state.repoRoot);
  const persistedWorkspaceDir = path.resolve(state.workspaceDir);
  const expectedWorkspaceDir = path.resolve(options.expectedWorkspaceDir);
  const persistedStat = await lstatWorkspaceDirectory(persistedWorkspaceDir);
  if (persistedStat !== null && (persistedStat.isSymbolicLink() || !persistedStat.isDirectory())) {
    throw new WorkspaceError("unsafe_path", "The workspace directory must be a real directory");
  }
  // F-1: KANONIK (realpath) karşılaştırma. Sözdizimsel karşılaştırma, bir
  // `outputRoot` atalı sembolik bağlantı olduğunda (macOS `/var` →
  // `/private/var`, CI tmp kökleri) AYNI fiziksel dizinin kalıcı (kanonik)
  // formunu güvenilen (sözdizimsel) formundan farklı görürdü ve meşru
  // oturumu sahte pozitif REDDEDİYORDU. İki form da `canonicalizeOutside`
  // ile kanonikleştirilir; kanonik formlar EŞİT olmalı.
  // Step 9 audit düzeltme B: `canonicalizeOutside`'in `null` sonucu BİR
  // YOL GÜVENLİĞİ İHLALİDİR (repo içine/üstüne düşen dizin) — creation
  // yolundaki (bkz. `createGitWorktreeWorkspace`) ile BİREBİR aynı
  // `unsafe_path` kind'ı. Stabil kind: "girdi sözleşmesine uymuyor"
  // (`invalid_input`) ile "güvenlik sınırı aşıldı" (`unsafe_path`)
  // ayrımı — aynı ihlal, iki çağrı yolunda iki farklı kind üretmemeli.
  const canonicalPersisted = await canonicalizeOutside(persistedWorkspaceDir, repoRoot);
  if (canonicalPersisted === null) {
    throw new WorkspaceError("unsafe_path", "The workspace directory must be outside the repository");
  }
  const canonicalExpected = await canonicalizeOutside(expectedWorkspaceDir, repoRoot);
  if (canonicalExpected === null) {
    throw new WorkspaceError("unsafe_path", "The workspace directory must be outside the repository");
  }
  // Kanonik formlar farklı → kimlik uyuşmazlığı (güvenlik ihlali DEĞİL —
  // her iki yol da repo dışında, yalnız farklı dizinler) → `invalid_input`.
  if (canonicalPersisted !== canonicalExpected) {
    throw new WorkspaceError("invalid_input", "The recovery state does not match the trusted workspace path");
  }
  // Güvenilen (trusted) tarafın kanonik formu çalışır dizindir: sonraki
  // tüm kontrol/operasyon (materialize/destroy/recreate) bunu kullanır.
  const workspaceDir = canonicalExpected;

  // ── immutable snapshot yeniden kurulumu (spec 105/115: main'den YOK) ──────
  const baseFingerprints = new Map<string, PathFingerprint>(state.baseFingerprints);
  const basePathsMap = new Map<string, string>(state.basePaths);
  const baseContentsMap = new Map<string, BaseContentValue>(state.baseContents);

  const editableFingerprints = new Map<string, PathFingerprint>();
  const editableContent = new Map<string, Buffer>();
  for (const canonical of state.editablePaths) {
    const fingerprint = baseFingerprints.get(canonical);
    if (fingerprint === undefined) {
      // Her editable yol parmak izi taşır; yoksa base güvenli temsil edilemez.
      throw new WorkspaceError(
        "workspace_operation_failed",
        "The captured editable base could not be represented safely",
      );
    }
    editableFingerprints.set(canonical, fingerprint);
    if (fingerprint.exists && fingerprint.type === "file") {
      const value = baseContentsMap.get(canonical);
      if (value === undefined || value.type !== "file") {
        throw new WorkspaceError(
          "workspace_operation_failed",
          "The captured editable base could not be represented safely",
        );
      }
      editableContent.set(canonical, Buffer.from(value.base64, "base64"));
    } else if (fingerprint.exists && fingerprint.type === "symlink") {
      const value = baseContentsMap.get(canonical);
      if (value === undefined || value.type !== "symlink") {
        throw new WorkspaceError(
          "workspace_operation_failed",
          "The captured editable base could not be represented safely",
        );
      }
      editableContent.set(canonical, Buffer.from(value.target, "utf8"));
    }
    // absent / directory / other → içerik yok (fingerprint tip+modu yeterli).
  }

  const validationBase: WorkspaceBase = {
    editable: editableFingerprints,
    editableContent,
    readonly: new Set(state.readonlyPaths),
    basePaths: basePathsMap,
  };
  const publicBase: WorkspaceBaseInfo = { fingerprints: baseFingerprints, basePaths: basePathsMap };

  const workspace = new GitWorktreeWorkspace(
    repoRoot,
    workspaceDir,
    state.baseCommit,
    state.sessionId,
    state.editablePaths,
    publicBase,
    validationBase,
    state.currentCreatedPaths,
  );

  await materializeWorkspace(workspace, state, repoRoot, workspaceDir);
  return workspace;
}

/**
 * Worktree'yi kalıcı state'e göre maddelendirir (spec 109-111/126/127).
 * Ana depoya ASLA yazmaz; yalnız `git worktree add/remove` (paylaşılan
 * `.git/worktrees/` yönetim alanı) + izolö worktree dizini.
 */
/**
 * `lstat` için errno sınıflaması (F-3): YALNIZ `ENOENT` "yok" (null) sayılır.
 * Diğer her hata (EACCES/EIO/ELOOP/ENOTDIR/...) "bilinmeyen durum"dur ve
 * fail-closed: durum doğrulanamayan dizin ASLA yokmuş gibi işlenemez — yok
 * saymak, sonradaki yıkıcı işlemleri (remove/rm/recreate) doğrulanmamış bir
 * hedefe yürütürdü. Hata SABİТ güvenli mesajla WorkspaceError'a çevrilir
 * (yol/errno/İÇERİK mesajda YOK).
 */
async function lstatWorkspaceDirectory(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if (errnoIs(err, "ENOENT")) {
      return null;
    }
    throw new WorkspaceError("unsafe_path", "The workspace directory must be a real directory");
  }
}

async function assertRealWorkspaceDirectory(workspaceDir: string): Promise<void> {
  const dirStat = await lstatWorkspaceDirectory(workspaceDir);
  if (dirStat !== null && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
    throw new WorkspaceError("unsafe_path", "The workspace directory must be a real directory");
  }
}

async function materializeWorkspace(
  workspace: GitWorktreeWorkspace,
  state: WorkspaceRecoveryState,
  repoRoot: string,
  workspaceDir: string,
): Promise<void> {
  await assertRealWorkspaceDirectory(workspaceDir);
  const dirStat = await lstat(workspaceDir).catch(() => null);
  const dirExists = dirStat !== null && dirStat.isDirectory();

  if (dirExists) {
    // Hayatta worktree: kimlik (HEAD==base + toplevel) + state hash.
    if (await worktreeIdentityMatches(workspaceDir, state.baseCommit)) {
      const hash = await workspace.recoveryStateHash().catch(() => null);
      if (hash !== null && hash === state.recoveryStateHash) {
        // spec 109/126: BİREBİR eşleşme → REUSE (imha/yeniden kurma YOK).
        return;
      }
    }
    // Kimlik uyuşmaz VEYA state hash çelişki (spec 110/127) → güvenilmez.
    await destroyWorktreeSafely(repoRoot, workspaceDir);
  }

  // Yok (restart) VEYA uyuşmaz → PERSISTED state'ten yeniden kur (spec 111).
  await recreateWorktree(state, repoRoot, workspaceDir);
}

/** Worktree'nin bu base'e ait, sağlam bir worktree olduğunu doğrular. */
async function worktreeIdentityMatches(workspaceDir: string, baseCommit: string): Promise<boolean> {
  try {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: workspaceDir, config: [HOOKS_DISABLED_CONFIG] });
    if (head.stdout.toString("utf8").trim() !== baseCommit) {
      return false;
    }
    const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: workspaceDir, config: [HOOKS_DISABLED_CONFIG] });
    return path.resolve(top.stdout.toString("utf8").trim()) === path.resolve(workspaceDir);
  } catch {
    return false;
  }
}

/**
 * Güvenli imha (spec 192): HEDEFLİ `git worktree remove --force <yol>` +
 * kalan izole dizini `rm`. Bu, SPLASH'ın kendi repo-DIŞI worktree dizinidir —
 * kullanıcı verisi DEĞİLDİR. Global `git worktree prune` KULLANILMAZ: aynı
 * repodaki başka eksik-ama-kayıtlı, kilitsiz worktree'lerin (ör. kullanıcının
 * takılı olmayan diskteki worktree'si) kaydını da silerdi. `remove` başarısız
 * olup kendi kaydımız kalırsa, ardından gelen `recreateWorktree` `add` öncesi
 * aynı hedefli `remove --force` ile onu temizler.
 */
async function destroyWorktreeSafely(repoRoot: string, workspaceDir: string): Promise<void> {
  await assertRealWorkspaceDirectory(workspaceDir);
  await runGit(["worktree", "remove", "--force", workspaceDir], { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG] }).catch(
    () => undefined,
  );
  await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * `workspaceDir` bu repoda kayıtlı bir worktree mi (`git worktree list
 * --porcelain -z`; `-z` yoldaki satır sonlarını da güvenle ayırır)?
 * Dizin artık YOK olabildiği için kendi yolumuz `realpath` ile çözülemez;
 * karşılaştırma iki adayla yapılır: (1) `path.resolve(workspaceDir)` — Splash
 * yolu oluştururken zaten kanonik (`canonicalizeOutside`) verir ve `worktree
 * add`'e bu biçim geçer; (2) var olan ebeveynin `realpath`'i + son ad (ör.
 * macOS `/var` → `/private/var` farkına karşı). Git'in listelediği yollar da
 * `path.resolve` ile normalize edilir. Liste okunamazsa hata YAYILIR (çağıran
 * güvenli hataya düşer — kayıt "yok" varsayılmaz).
 */
async function isWorktreeRegistered(repoRoot: string, workspaceDir: string): Promise<boolean> {
  const own = path.resolve(workspaceDir);
  const candidates = new Set<string>([own]);
  const parent = await realpath(path.dirname(own)).catch(() => null);
  if (parent !== null) {
    candidates.add(path.join(parent, path.basename(own)));
  }
  const listed = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: repoRoot,
    config: [HOOKS_DISABLED_CONFIG],
  });
  return listed.stdout
    .toString("utf8")
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .some((field) => candidates.has(path.resolve(field.slice("worktree ".length))));
}

/**
 * Worktree'yi PERSISTED state'ten yeniden kurar (spec 111): hedef dizini
 * temizler, sonra base commit'i maddelendirir. Base nesnesi object DB'de
 * değilse `mktree`+`commit-tree` ile BİREBİR yeniden kurar (aynı SHA);
 * tamamlanamazsa fail-closed (kısmi rekonstrüksiyon YOK, spec 275).
 */
async function recreateWorktree(state: WorkspaceRecoveryState, repoRoot: string, workspaceDir: string): Promise<void> {
  await assertRealWorkspaceDirectory(workspaceDir);
  // `git worktree add` hedef dizinin yok/boş olmasını şart koşar.
  await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  // Dizin git DIŞINDA silindiyse (rm -rf/Finder/temizlik aracı) kaydı
  // `.git/worktrees/<n>` altında kalır; aynı yola `worktree add` "missing but
  // already registered worktree" ile reddeder (exit 128 — ölçüldü, Git 2.50.1)
  // ve kurtarma HER denemede başarısız olurdu. Her iki dal için (a/b) `add`
  // ÖNCESİ, YALNIZ güvenilen kanonik `workspaceDir` kaydı hedefli temizlenir:
  // eksik-ama-kayıtlı yolda `remove --force` yalnız o kaydı siler (ölçüldü).
  // Global `git worktree prune` KULLANILMAZ — aynı repodaki başka eksik
  // kayıtları (ör. kullanıcının çıkarılmış diskteki worktree'si) da silerdi.
  // Kayıt yoksa git hata verir (beklenen) → yutulur.
  await runGit(["worktree", "remove", "--force", workspaceDir], {
    cwd: repoRoot,
    config: [HOOKS_DISABLED_CONFIG],
  }).catch(() => undefined);

  if (await baseObjectPresent(repoRoot, state.baseCommit)) {
    // case (a): base commit object DB'de → doğrudan checkout (byte-birebir).
    try {
      await runGit(["worktree", "add", "--detach", workspaceDir, state.baseCommit], {
        cwd: repoRoot,
        config: [HOOKS_DISABLED_CONFIG],
      });
    } catch (err) {
      throw new WorkspaceError("workspace_operation_failed", "Workspace recovery failed", { cause: err });
    }
    return;
  }

  // case (b): base nesnesi yok → PERSISTED state'ten BİREBİR yeniden kur.
  try {
    await recreateBaseBlobs(repoRoot, state);
    const treeOid = await mktreeFromEntries(repoRoot, state.immutableBaseEntries);
    if (treeOid !== state.baseCommitIdentity.tree) {
      throw new Error("reconstructed tree sha mismatch");
    }
    const commitOid = await commitTreeRebuild(repoRoot, state.baseCommitIdentity, treeOid);
    if (commitOid !== state.baseCommit) {
      throw new Error("reconstructed commit sha mismatch");
    }
    await runGit(["worktree", "add", "--detach", workspaceDir, state.baseCommit], {
      cwd: repoRoot,
      config: [HOOKS_DISABLED_CONFIG],
    });
  } catch (err) {
    if (err instanceof WorkspaceError) {
      throw err;
    }
    // eksik blob/nesne veya SHA çelişki → fail-closed (ana depoya dokunulmaz).
    throw new WorkspaceError("workspace_operation_failed", "Workspace recovery failed", { cause: err });
  }
}

/** Base commit nesnesi object DB'de var mı? (`git cat-file -e <sha>^{commit}`) */
async function baseObjectPresent(repoRoot: string, sha: string): Promise<boolean> {
  try {
    await runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Seçili yolların base içerik blob'larını object DB'ye geri yazar
 * (`git hash-object -w --stdin`). `mktree` blob'ların VAR olmasını gerektirmez
 * (yalnız oid referansı); ancak `worktree add` checkout'u blob'ları gerektirir.
 * `absent` yol için yazılacak şey yok.
 */
async function recreateBaseBlobs(repoRoot: string, state: WorkspaceRecoveryState): Promise<void> {
  for (const [, value] of state.baseContents) {
    if (value.type === "absent") {
      continue;
    }
    const bytes = value.type === "file" ? Buffer.from(value.base64, "base64") : Buffer.from(value.target, "utf8");
    await runGit(["hash-object", "-w", "--stdin"], { cwd: repoRoot, config: [HOOKS_DISABLED_CONFIG], stdin: bytes });
  }
}

/**
 * Kalıcı base ağacını alttan-üst `git mktree` ile yeniden kurar ve üretic
 * `tree` SHA'sını döndürür. Alt-ağaçlar ÖNCE kurulur (orijinal oid ile aynı
 * olmalı — değilse fail-closed); `-z` NUL-bölümlü girdi yol güvenliğini korur.
 * Girdi sırası `git ls-tree` (kanonik) sırasındadır → aynı `tree` SHA'sı.
 */
async function mktreeFromEntries(repoRoot: string, entries: BaseTreeEntry[]): Promise<string> {
  const parts: string[] = [];
  for (const entry of entries) {
    let oid = entry.oid;
    if (entry.children !== undefined) {
      const built = await mktreeFromEntries(repoRoot, entry.children);
      if (built !== entry.oid) {
        throw new Error("subtree sha mismatch during recovery");
      }
      oid = built;
    }
    // `git mktree -z` girdi biçimi (ölçüldü, Apple Git 2.50):
    // `<mode> <type> <oid>\t<path>\0` — meta TAB ile, path YALNIZ NUL ile.
    parts.push(`${entry.mode} ${treeEntryType(entry.mode)} ${oid}\t${entry.path}\u0000`);
  }
  const result = await runGit(["mktree", "-z"], {
    cwd: repoRoot,
    config: [HOOKS_DISABLED_CONFIG],
    stdin: Buffer.from(parts.join(""), "utf8"),
  });
  return result.stdout.toString("utf8").trim();
}

/** git dosya modundan `mktree` için nesne tipi. */
function treeEntryType(mode: string): string {
  if (mode === "100644" || mode === "100755" || mode === "120000") {
    return "blob";
  }
  if (mode === "160000") {
    return "commit";
  }
  if (mode === "040000") {
    return "tree";
  }
  return "blob";
}

/**
 * Kalıcı kimlik alanlarıyla `git commit-tree` → (birebir eşleşmede) AYNI commit
 * SHA'sı. Author/committer tarihleri + kimlik + message aynen verilir
 * (spec 122: tree/fingerprint/birebir aynı; yeni SHA ancak metadata kaybında,
 * o durumda çağrı tarafı fail-closed yapar).
 */
async function commitTreeRebuild(repoRoot: string, identity: BaseCommitIdentity, treeOid: string): Promise<string> {
  const args: string[] = ["commit-tree", treeOid];
  for (const parent of identity.parents) {
    args.push("-p", parent);
  }
  const result = await runGit(args, {
    cwd: repoRoot,
    config: [HOOKS_DISABLED_CONFIG, "commit.gpgsign=false"],
    env: {
      GIT_AUTHOR_NAME: identity.authorName,
      GIT_AUTHOR_EMAIL: identity.authorEmail,
      GIT_AUTHOR_DATE: identity.authorDate,
      GIT_COMMITTER_NAME: identity.committerName,
      GIT_COMMITTER_EMAIL: identity.committerEmail,
      GIT_COMMITTER_DATE: identity.committerDate,
    },
    stdin: Buffer.from(identity.message, "utf8"),
  });
  return result.stdout.toString("utf8").trim();
}

/**
 * Base'teki bir yolun ANLIK (live) parmak izini yakalar — Step 9 stale-check
 * desteği için yeniden kullanılabilir (spec 31). Karşılaştırma mantığı YOK.
 */
export { captureLiveFingerprint };
