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
 * (`rev-parse`, `diff`, `ls-files`) + dosya okumaları yapılır; `git worktree
 * add/remove` paylaşılan `.git/worktrees/` yönetim alanını doğal olarak
 * günceller — `.git`'in bayt-bayt dokunulmadığı iddia edilmez. Ana
 * working-tree dosyaları, index, dal referansları, tag'lar ve içerik
 * DEĞİŞMEZ (test: spec 75).
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
 *   7.  base SHA kaydedilir → immutable (spec 27); parmak izleri + base
 *       ağaç haritası base COMMIT'TEN yakalanır (tek doğruluk kaynağı)
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
import os from "node:os";
import path from "node:path";
import type { DiffStats, WorkerResult } from "../worker/result.js";
import type {
  PathFingerprint,
  Workspace,
  WorkspaceApplyResult,
  WorkspaceBaseInfo,
  WorkspaceCreateInput,
  WorkspaceDiffOptions,
} from "./Workspace.js";
import { WorkspaceError } from "./Workspace.js";
import {
  HOOKS_DISABLED_CONFIG,
  computeRepoId,
  literalPathspec,
  parseCatFileBatch,
  runGit,
  splitNul,
  type GitRunResult,
} from "./git.js";
import {
  canonicalizeOutside,
  hasSymlinkInPath,
  isPathInsideOrEqual,
  isSafeSessionId,
  normalizeRepoPath,
  resolveContained,
} from "./pathSafety.js";
import { captureLiveFingerprint, gitModeType, normalizeGitFileMode, sha256Hex } from "./fingerprint.js";
import { validateWorkerResult, type EditPlan, type WorkspaceBase } from "./validate.js";

/** Deterministik Splash commit kimliği (spec 25 — kullanıcının git kimliği GEREKMEZ). */
const SPLASH_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Splash",
  GIT_AUTHOR_EMAIL: "splash@local.invalid",
  GIT_COMMITTER_NAME: "Splash",
  GIT_COMMITTER_EMAIL: "splash@local.invalid",
};

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
  /** Son başarılı patch set'in kabul edilen create hedefleri (kapsamlı sıfırlama için, spec 59). */
  private workerCreatedPaths = new Set<string>();
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
  ) {
    this.repoRoot = repoRoot;
    this.workspaceDir = workspaceDir;
    this.baseCommit = baseCommit;
    this.sessionId = sessionId;
    this.editablePaths = editablePaths;
    this.base = base;
    this.validationBase = validationBase;
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
    options: { cwd?: string; config?: readonly string[]; stdin?: Buffer | string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<GitRunResult> {
    const config: string[] = [HOOKS_DISABLED_CONFIG, ...(options.config ?? [])];
    try {
      return await runGit(args, {
        cwd: options.cwd ?? this.workspaceDir,
        config,
        stdin: options.stdin,
        env: options.env,
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

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Worker sonucu uygular (spec 35 yaşam döngüsü):
   *   1) tracked durumu immutable base'e sıfırla
   *   2) ÖNCEKİ turun worker-oluşturduğu yolları KAPSAMLI kaldır (geniş
   *      `git clean` ASLA, spec 37)
   *   3) TÜM WorkerResult'ı immutable base'e karşı semantik doğrula
   *   4) yalnız kabul edilen düzenlemeleri uygula
   *   5) kabul edilen create'ları intent-to-add işaretle (spec 60)
   *   6) workerCreatedPaths = bu turun kabul edilen create'ları (spec 59)
   *   7) filesChanged/diffStats git'ten hesapla (worker beyanına güvenilmez, spec 62)
   *
   * Worker sonucu, önceki turun ÜZERİNE artımsal delta değil, immutable
   * base'e karşı TAM ikame patch set'idir (spec 35/88 — drift imkânsız).
   *
   * Atımlar sırasında beklenmeyen işletimsel hata (spec 58): workspace base
   * durumuna geri Restore edilir, güvenli tip'li `WorkspaceError` atılır —
   * yarım patch "başarı" olarak raporlanmaz; ana checkout'a DOKUNULMAZ.
   */
  async applyPatchSet(workerResult: WorkerResult): Promise<WorkspaceApplyResult> {
    this.assertUsable();

    // (1) Tracked durum → immutable base. (Asla main'e, asla main HEAD'e değil — spec 36.)
    await this.git(["reset", "--hard", this.baseCommit]);

    // (2) Önceki turun worker-oluşturduğu yollar — yalnız bilinen küme (spec 37/38).
    await this.removeWorkerCreatedPaths(this.workerCreatedPaths);
    this.workerCreatedPaths = new Set<string>();

    // (3) TÜM seti immutable base'e karşı doğrula — yazmadan ÖNCE (spec 39).
    const validation = validateWorkerResult(this.validationBase, workerResult);

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
      // (spec 58) işletimsel hata: base'e dön + bilinen create'ları temizle.
      try {
        await this.git(["reset", "--hard", this.baseCommit]);
        await this.removeWorkerCreatedPaths(new Set<string>(createdThisRound));
      } catch {
        // Geri alma bile başarısız → güvenli işletimsel hata (ana checkout'a dokunulmadı).
      }
      this.workerCreatedPaths = new Set<string>();
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw new WorkspaceError("workspace_operation_failed", "Applying the patch failed", { cause: err });
    }

    // (7) Sonuçlar git'ten — worker beyanına değil (spec 62).
    const filesChanged = await this.changedPaths();
    const diffStats = await this.statInternal();
    return { validation: validation.result, filesChanged, diffStats };
  }

  /** Tracked durumu base'e sıfırlar + önceki worker-oluşturulan yolları kapsamlı kaldırır. */
  async resetToBase(): Promise<void> {
    this.assertUsable();
    await this.git(["reset", "--hard", this.baseCommit]);
    await this.removeWorkerCreatedPaths(this.workerCreatedPaths);
    this.workerCreatedPaths = new Set<string>();
  }

  /**
   * Base → güncel workspace unified diff (spec 63): tüm workspace, 3 context
   * satırı, deterministik flag'ler (`--no-ext-diff --no-textconv --no-renames`).
   * `files` filtresi path-güvenliğinden geçmek zorundadır.
   */
  async diff(options: WorkspaceDiffOptions = {}): Promise<string> {
    this.assertUsable();
    const args: string[] = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-U3",
      this.baseCommit,
    ];
    if (options.files !== undefined && options.files.length > 0) {
      const paths: string[] = [];
      for (const raw of options.files) {
        const canonical = normalizeRepoPath(raw);
        if (canonical === null) {
          throw new WorkspaceError("unsafe_path", "The diff path filter is unsafe");
        }
        // `:(literal)`: filtre yolları pathspec magic'i olarak yorumlanamaz
        // (audit CRITICAL-1) — `*` glob/genleşme etkisi yapamaz.
        paths.push(literalPathspec(canonical));
      }
      args.push("--", ...paths);
    }
    const result = await this.git(args);
    return result.stdout.toString("utf8");
  }

  /** Base → güncel workspace yapısal istatistik (files/insertions/deletions, spec 65). */
  async stat(): Promise<DiffStats> {
    this.assertUsable();
    return this.statInternal();
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

    const repoId = computeRepoId(this.repoRoot);
    const patchDir = path.join(canonicalRoot, "patches", repoId);
    const patchPath = path.join(patchDir, `${this.sessionId}.patch`);
    const tempPath = `${patchPath}.tmp-${process.pid}`;

    try {
      await mkdir(patchDir, { recursive: true });
      await chmod(patchDir, 0o700).catch(() => undefined); // restrictive dizin (spec 71)

      const result = await this.git([
        "diff",
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
        // Dizin gitmişti; yönetim kaydını (admin metadata) temizle.
        try {
          await runGit(["worktree", "prune"], { cwd: this.repoRoot, config: [HOOKS_DISABLED_CONFIG] });
          this.destroyed = true;
          return;
        } catch {
          // prune da başarısız → aşağıdaki güvenli hata.
        }
      }
      throw new WorkspaceError("workspace_operation_failed", "Workspace destruction failed", { cause: err });
    }
    this.destroyed = true;
  }

  // ── iç yardımcıları ───────────────────────────────────────────────────────

  /**
   * Bilinen worker-oluşturulan yolları tek tek kaldırır (spec 37/38):
   * - yalnız O TAM yol `unlink` edilir (sembolik bağlantı TAKİP edilmez)
   * - dizin/özel nesne BIRAKILIR (biz dosya oluştururuz; geniş temizlik YOK)
   * - boş kalana atal dizinler sorun DEĞİL (git diff'i etkilemez)
   * - bilinmeyen/untracked hiçbir dosya dokunulmaz (spec 89 test'i)
   */
  private async removeWorkerCreatedPaths(paths: Iterable<string>): Promise<void> {
    for (const canonical of paths) {
      const abs = resolveContained(this.workspaceDir, canonical);
      if (abs === null) {
        continue; // defensive: yol doğrulaması oluşumda yapılmıştı
      }
      try {
        const stat = await lstat(abs);
        if (stat.isFile() || stat.isSymbolicLink()) {
          await unlink(abs);
        }
        // dizin/özel: dokunulmaz (geniş temizlik yasağı, spec 37)
      } catch {
        // zaten yok — sorun değil
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
   */
  private async statInternal(): Promise<DiffStats> {
    const result = await this.git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--numstat",
      "-z",
      this.baseCommit,
    ]);
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

// ── Oluşturma ───────────────────────────────────────────────────────────────

/** Seçili untracked dosyayı worktree'ye kopyalar (spec 21/50). */
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
 * Seçilen sembolik bağlantının hedefi repository İÇİNDE kalıyor mu?
 * (spec 50: mutlak dış hedefler host dosyalarını okuma/taşıma kanalı olamaz.)
 * Hedef zincir çözülebildiyse `realpath`, çözülmezse (kırık link)
 * sözdizimsel çözüm kullanılır; ikisi de kök dışına düşüyorsa red.
 */
async function symlinkTargetStaysInside(repoRoot: string, linkAbs: string, target: string): Promise<boolean> {
  const lexical = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(linkAbs), target);
  try {
    const resolved = await realpath(lexical);
    return isPathInsideOrEqual(repoRoot, resolved);
  } catch {
    return isPathInsideOrEqual(repoRoot, lexical);
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
  for (const selected of [...editable, ...readonly]) {
    const abs = resolveContained(repoRoot, selected);
    if (abs === null) {
      throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
    }
    const stat = await lstat(abs).catch(() => null);
    if (stat !== null && !stat.isFile() && !stat.isSymbolicLink()) {
      throw new WorkspaceError("invalid_input", "A selected path is not a file");
    }
  }

  // ── ana depo: HEAD commit'i zorunlu (v1 worktree tabanı, spec 7) ──────────
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

  // ── (1) tracked delta: staged + unstaged, binary, tam index (spec 19) ────
  // `git diff` (düz) KULLANILMAZ — yalnızca staged değişiklikleri kaçırır.
  let trackedDelta: Buffer;
  try {
    const diff = await runGit(
      ["diff", "HEAD", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"],
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
        await runGit(
          ["apply", "--index", "--binary"],
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
 * Base parmak izi + içerik yakalama (spec 29/30/31) — base COMMIT'TEN:
 * - seçili yollar: `git ls-tree -r -z <base> -- <yollar>` → mod/oid
 * - base ağacı:    `git ls-tree -r -z <base>`           → tam yol→mod haritası
 * - içerik:        `git cat-file --batch`               → blob baytları
 *
 * Düzenlenebilir düz dosyaların BİREBİR base baytları saklanır — arama/
 * değiştirme doğrulaması her zaman bu immutable içeriğe karşıdır
 * (spec 29: workspace'in mutable hali DEĞİL).
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

  // İçerik baytları: seçili düz dosya + sembolik bağlantı blob'ları.
  const oids = new Set<string>();
  for (const entry of selectedEntries) {
    const type = gitModeType(entry.mode);
    if (type === "file" || type === "symlink") {
      oids.add(entry.oid);
    }
  }
  let blobBytes: Map<string, Buffer> = new Map();
  if (oids.size > 0) {
    try {
      const payload = Buffer.from(`${[...oids].join("\n")}\n`, "utf8");
      const batch = await runGit(["cat-file", "--batch"], {
        cwd: workspaceDir,
        stdin: payload,
        config: [HOOKS_DISABLED_CONFIG],
      });
      blobBytes = parseCatFileBatch(batch.stdout);
    } catch (err) {
      throw new WorkspaceError("git_operation_failed", "Reading the base content failed", { cause: err });
    }
  }

  const fingerprints = new Map<string, PathFingerprint>();
  const editableFingerprints = new Map<string, PathFingerprint>();
  const editableContent = new Map<string, Buffer>();

  const fingerprintFor = (canonical: string): PathFingerprint => {
    const entry = entryByPath.get(canonical);
    if (entry === undefined) {
      return { exists: false };
    }
    const type = gitModeType(entry.mode);
    if (type === "symlink") {
      const bytes = blobBytes.get(entry.oid);
      return {
        exists: true,
        type: "symlink",
        mode: "120000",
        contentSha256: bytes === undefined ? undefined : sha256Hex(bytes),
      };
    }
    if (type === "file") {
      const bytes = blobBytes.get(entry.oid);
      return {
        exists: true,
        type: "file",
        mode: normalizeGitFileMode(entry.mode),
        contentSha256: bytes === undefined ? undefined : sha256Hex(bytes),
      };
    }
    // gitlink (160000) vb.: yalnız tip+mod (özet taşınmaz).
    return { exists: true, type: "other", mode: normalizeGitFileMode(entry.mode) };
  };

  for (const canonical of editable) {
    const fingerprint = fingerprintFor(canonical);
    editableFingerprints.set(canonical, fingerprint);
    fingerprints.set(canonical, fingerprint);
    // Birebir base içeriği: yalnız düz dosyalar (search/replace hedefi).
    if (fingerprint.exists && fingerprint.type === "file") {
      const entry = entryByPath.get(canonical);
      if (entry !== undefined) {
        const bytes = blobBytes.get(entry.oid);
        if (bytes !== undefined) {
          editableContent.set(canonical, bytes);
        }
      }
    }
  }
  for (const canonical of readonly) {
    if (!fingerprints.has(canonical)) {
      fingerprints.set(canonical, fingerprintFor(canonical));
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

/**
 * Base'teki bir yolun ANLIK (live) parmak izini yakalar — Step 9 stale-check
 * desteği için yeniden kullanılabilir (spec 31). Karşılaştırma mantığı YOK.
 */
export { captureLiveFingerprint };
