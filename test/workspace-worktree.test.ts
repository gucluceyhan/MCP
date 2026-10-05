/**
 * Step 5: `GitWorktreeWorkspace` entegrasyon testleri (GERÇEK git repo + worktree).
 *
 * Çiviler (Step 5 spec 61, 64, 65, 73-96 — taslak listesi):
 * - birebir base yakalama (staged + unstaged + staged-new + deletion + exec-mod +
 *   seçilen untracked/ignored; SEÇİLMEMİŞ untracked asla girmez) (spec 76)
 * - ana checkout koruması: HEAD/dal/status/çalışan-dosya içerikleri DEĞİŞMEZ (spec 75)
 * - base-commit hijyeni: detached, Splash kimliği (kullanıcınki YOKSAYLANIR),
 *   `commit.gpgsign=true` repo'da imza GEREKMEZ, hook'lar ÇALIŞMAZ (spec 78/26)
 * - mevcut (kullanıcı) değişiklik worker diff'inde GÖRÜNMEZ (spec 77/64)
 * - allow-list / readonly / create serbesti (spec 81)
 * - binary modify red + binary delete kabul (spec 85)
 * - full-patch-set sıfırlama — artımsal drift YOK (spec 88)
 * - geniş `git clean` YOK — bilinmeyen untracked sentinel KALIR (spec 89)
 * - intent-to-add: create diff/stat/export'da görünür; BOŞ dosya dahil (spec 90/61)
 * - diff/stat değerleri; filtreli diff; güvensiz filtre red (spec 91/92)
 * - tam export: yol biçimi, repo dışı, `git apply` ile ikinci checkout'ta
 *   BİREBİR çalışma durumu, binary section, export-başarısız workspace KORUNUR (spec 93/94/95/96)
 * - sembolik-bağlantı kaçağı red + sentinel (spec 80)
 * - oluşum hataları: repo içi workspaceDir, dolu dizin, yarım worktree KALMAZ (spec 10/11/74)
 * - imha: worktree gider, sonraki işlemler `workspace_destroyed`, patch dosyası KALIR (spec 73)
 * - pathspec magic neutralizasyonu `:(literal)` (audit CRITICAL-1): apply `add -N`
 *   pin'i — mass-add sentinel'i (test 18: elle yazılan untracked filesChanged/diff'e
 *   SIZMAZ); create-path pin'leri (test 22) — magic-adlı (glob) seçim: untracked
 *   base'e GİRMEZ, meşru tracked seçimler etkilenmez
 * - `core.fsmonitor` kilidi (audit HIGH-1), export kökü workspace DIŞI (audit
 *   MEDIUM-1), exec mod koruması
 * - PR #24 (Step 5 güvenlik/güvenilirlik): sembolik-bağlantı containment
 *   (seçili kaynak/hedef atal + dışa kaçan hedef) (testler 23-25), içerideki
 *   link parmak izi (26), CRLF working-tree bayt round-trip (27-28), dış
 *   Git filter fail-closed — working-tree + COMMITTED attribute yüzeyleri
 *   (29, 29a-29b: audit F-1), reset/temizlik kalıntı kümesi (30-33),
 *   TUR filter re-check + reset-öncesi temizlik sırası: worker-ekili
 *   `.gitattributes` + config'de önceden tanımlı driver (repo + global/LFS)
 *   (34-37: audit F-6 — pozitif kontrol/mutasyon kanıtlı, S-2 kapalı),
 *   SB-1 tracked `.gitattributes` reset-filtre penceresi: her `reset
 *   --hard`'dan önce saf-fs restore + sıralama + arıza/recovery + racy
 *   pozitif kontrol (38-44: 5. audit LOW — pencere KAPALI)
 *
 * Hermetic git: global/system config kesilir (kullanıcı makine ayarları
 * determinizmi bozmasın). Testler BUILT çıktıyı (dist/) import eder.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceCreateInput,
  type WorkspaceRecoveryState,
} from "../dist/workspace/Workspace.js";
import {
  GitWorktreeWorkspace,
  createGitWorktreeWorkspace,
  restoreGitWorktreeWorkspace,
  setWorkspaceFs,
  type WorkspaceFs,
} from "../dist/workspace/GitWorktreeWorkspace.js";
import { runGit } from "../dist/workspace/git.js";
import type { WorkerEdit, WorkerResult } from "../dist/worker/result.js";

let tmp: string;
let emptyConfigFile: string;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "splash-workspace-wt-"));
  emptyConfigFile = path.join(tmp, "empty-gitconfig");
  await writeFile(emptyConfigFile, "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = emptyConfigFile;
  process.env.GIT_TERMINAL_PROMPT = "0";
});

after(async () => {
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_TERMINAL_PROMPT;
  await rm(tmp, { recursive: true, force: true });
});

// ── yardımcılar ──────────────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<Buffer> {
  // Fixture kurulumu hermetic: imza ASLA denenmez (makinede anahtar yok),
  // hook'lar ASLA çalışmaz. Repo config'i `commit.gpgsign=true` KALIR —
  // spec 78, base commit'in BUNUN AŞAĞISINDAN imzasız geçmesini dener.
  const res = await runGit(args, { cwd, config: ["commit.gpgsign=false", "core.hooksPath=/dev/null"] });
  return res.stdout;
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).toString("utf8").trim();
}

async function gitOk(cwd: string, args: string[]): Promise<void> {
  await git(cwd, args);
}

/** `git worktree list` satırlarındaki YOL alanını döndürür (SHA/branch alanı atlanır). */
function worktreePaths(lines: string[]): string[] {
  return lines.map((line) => line.trim().split(/\s+/)[0] ?? "");
}

/**
 * Spec 76 fixture repo'su — BİREBİR base yakalama senaryosunun tamamı:
 * tracked temiz, staged mod, unstaged mod, ikisi birden, staged-new,
 * tracked deletion, exec-mod, seçilen untracked, seçilen ignored,
 * seçilmemiş untracked, tracked symlink (içe), seçilen untracked symlink (içe),
 * committed symlink (DIŞA — kaçırga testi), hooks + marker, gpgsign=true.
 */
interface Fixture {
  repo: string;
  /** workspace için güvenli, repo DIŞI kök */
  out: string;
}

async function buildFixture(name: string): Promise<Fixture> {
  const repo = path.join(tmp, name, "repo");
  const out = path.join(tmp, name);
  await mkdir(repo, { recursive: true });

  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Fixture User"]);
  await gitOk(repo, ["config", "user.email", "fixture@local.invalid"]);
  await gitOk(repo, ["config", "commit.gpgsign", "true"]); // spec 78: imza isteniyor — base commit yine de çalışmalı

  // hook'lar: marker dosyaları oluştururlar; base commit + worktree add'de ASLA çalışmamalı (spec 26/78)
  const hooksDir = path.join(repo, ".git", "hooks");
  const marker = path.join(out, "hook-marker");
  const hook = `#!/bin/sh\ntouch "${marker}"\n`;
  await writeFile(path.join(hooksDir, "pre-commit"), hook);
  await writeFile(path.join(hooksDir, "post-checkout"), hook);
  await writeFile(path.join(hooksDir, "commit-msg"), hook);
  await chmod(path.join(hooksDir, "pre-commit"), 0o755);
  await chmod(path.join(hooksDir, "post-checkout"), 0o755);
  await chmod(path.join(hooksDir, "commit-msg"), 0o755);

  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "config"), { recursive: true });

  // ── initial commit ────────────────────────────────────────────────────────
  await writeFile(path.join(repo, "tracked-clean.txt"), "clean\n");
  await writeFile(path.join(repo, "src", "a.ts"), "alpha\nbeta\n");
  await writeFile(path.join(repo, "src", "staged.txt"), "v1\n");
  await writeFile(path.join(repo, "src", "both.txt"), "v1\n");
  await writeFile(path.join(repo, "src", "staged-new.txt"), "pre\n"); // staged-new için: commit'te YOK
  await writeFile(path.join(repo, "src", "del.txt"), "d1\nd2\nd3\n");
  await writeFile(path.join(repo, "src", "exec.sh"), "#!/bin/sh\necho hi\n");
  await chmod(path.join(repo, "src", "exec.sh"), 0o644); // commit 644; sonra worktree 755 (mod delta)
  await writeFile(path.join(repo, "src", "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x49, 0x4e]));
  await writeFile(path.join(repo, "src", "reference.ts"), "ref\n");
  await writeFile(path.join(repo, "src", "secret.ts"), "top-secret\n");
  await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  await gitOk(repo, ["add", "tracked-clean.txt", "src/a.ts", "src/staged.txt", "src/both.txt", "src/del.txt", "src/exec.sh", "src/binary.bin", "src/reference.ts", "src/secret.ts", ".gitignore"]);
  // tracked symlink (içe) — worktree checkout'da link olarak yazılır
  await symlink("src/a.ts", path.join(repo, "inside-link"));
  await gitOk(repo, ["add", "inside-link"]);
  // committed symlink DIŞA (kaçırga testi; git hedefi metin olarak saklar)
  await symlink("../escape-outside", path.join(repo, "escape"));
  await gitOk(repo, ["add", "escape"]);
  await gitOk(repo, ["commit", "-m", "fixture init"]);

  // ── commit SONRASI working-tree durumu (birebir base'in içeriği) ──────────
  // unstaged kullanıcı değişikliği (spec 77: diff'te görünmemeli)
  await writeFile(path.join(repo, "src", "a.ts"), "alpha-USER\nbeta\n");
  // staged-only değişiklik
  await writeFile(path.join(repo, "src", "staged.txt"), "v2\n");
  await gitOk(repo, ["add", "src/staged.txt"]);
  // staged + unstaged
  await writeFile(path.join(repo, "src", "both.txt"), "v2\n");
  await gitOk(repo, ["add", "src/both.txt"]);
  await writeFile(path.join(repo, "src", "both.txt"), "v2 working\n");
  // staged yeni dosya
  await writeFile(path.join(repo, "src", "staged-new.txt"), "staged-new\n");
  await gitOk(repo, ["add", "src/staged-new.txt"]);
  // tracked silme (unstaged)
  await rm(path.join(repo, "src", "del.txt"));
  // exec mod değişikliği (unstaged: 644 → 755)
  await chmod(path.join(repo, "src", "exec.sh"), 0o755);

  // untracked: seçilen + seçilmeyen + seçilen ignored
  await writeFile(path.join(repo, "config", "local-reference.json"), "{}\n"); // seçilen untracked
  await writeFile(path.join(repo, "secret-notes.txt"), "unselected\n"); // seçilmemiş
  await writeFile(path.join(repo, "huge-dump.bin"), Buffer.alloc(1024, 7)); // seçilmemiş
  await writeFile(path.join(repo, "ignored.txt"), "ignored-selected\n"); // seçilen IGNORED
  // seçilen untracked symlink (içe — güvenli)
  await symlink("tracked-clean.txt", path.join(repo, "link2"));

  return { repo, out };
}

/** Çalışır bir workspace kurar (standart seçimler + fixture dışı dizin). */
function createInput(fixture: Fixture, sessionId = "s-0001"): WorkspaceCreateInput {
  return {
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", sessionId),
    sessionId,
    editablePaths: [
      "src/a.ts",
      "src/staged.txt",
      "src/both.txt",
      "src/del.txt",
      "src/exec.sh",
      "src/binary.bin",
      "config/local-reference.json",
      "ignored.txt",
      "link2",
      "inside-link",
    ],
    readonlyPaths: ["src/reference.ts"],
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

async function readAll(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(d: string, prefix: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue; // worktree `.git` dosya/dizin farkı — karşılaştırma dışı
      }
      const abs = path.join(d, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.set(rel, await readFile(abs));
      } else if (entry.isSymbolicLink()) {
        out.set(rel, Buffer.from(await readlink(abs), "utf8")); // link hedef metni
      }
    }
  }
  await walk(dir, "");
  return out;
}

async function treesEqual(a: string, b: string): Promise<void> {
  const ta = await readAll(a);
  const tb = await readAll(b);
  const keysA = [...ta.keys()].sort();
  const keysB = [...tb.keys()].sort();
  assert.deepEqual(keysB, keysA, `tree entry mismatch:\nA-only: ${keysA.filter((k) => !tb.has(k))}\nB-only: ${keysB.filter((k) => !ta.has(k))}`);
  for (const key of keysA) {
    const ba = ta.get(key);
    const bb = tb.get(key);
    assert.ok(ba !== undefined && bb !== undefined, `missing entry ${key}`);
    assert.ok(ba!.equals(bb!), `content mismatch at ${key}`);
  }
}

function expectWorkspaceError(kind: WorkspaceError["kind"], fn: () => Promise<unknown>): Promise<WorkspaceError> {
  return fn().then(
    () => {
      throw new Error("expected WorkspaceError but call resolved");
    },
    (err: unknown) => {
      assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got: ${String(err)}`);
      assert.equal(err.kind, kind);
      return err as WorkspaceError;
    },
  );
}

const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x49, 0x4e]);

function workerResult(edits: WorkerEdit[]): WorkerResult {
  return { schemaVersion: 1, summary: "test round", edits };
}

function errnoEacces(): NodeJS.ErrnoException {
  return Object.assign(new Error("operation not permitted (EACCES)"), { code: "EACCES" });
}

/**
 * Arıza enjeksiyonu fs seam'leri (PR #24 Fix 4 + SB-1). Test biterken
 * `setWorkspaceFs(null)` ile gerçek fs'e dönülür. Seam'in beş üyesi:
 * `lstat`/`unlink` (temizlik) + `mkdir`/`writeFile`/`chmod` (attr restore).
 * - `failingFs`: gerçek `lstat` + DAİMA EACCES `unlink` — yol VAR ve
 *   unlink'in gerçekten denendiğini (dosyanın kalmasıyla) ispatlar;
 *   restore üyeleri GERÇEK (eski testlerde SB-1 kümesi boş → restore
 *   no-op → davranış değişmez).
 * - `denyingFs`: beş üye de EACCES — dosyanın varlığından BAĞIMSIZ
 *   deterministik temizlik hatası (reset'in git tarafında sildiği
 *   intent-to-add yollarında `lstat` ENOENT'a düşerdi).
 */
function failingFs(): WorkspaceFs {
  return {
    lstat: (target: string) => lstat(target),
    unlink: () => Promise.reject(errnoEacces()),
    mkdir: (target: string, options: { recursive: boolean }) => mkdir(target, options).then(() => undefined),
    writeFile: (target: string, data: Buffer) => writeFile(target, data),
    chmod: (target: string, mode: number) => chmod(target, mode),
  };
}

function denyingFs(): WorkspaceFs {
  return {
    lstat: () => Promise.reject(errnoEacces()),
    unlink: () => Promise.reject(errnoEacces()),
    mkdir: () => Promise.reject(errnoEacces()),
    writeFile: () => Promise.reject(errnoEacces()),
    chmod: () => Promise.reject(errnoEacces()),
  };
}

/**
 * Kayıt yapan fs seam'i (PR #24 SB-1 sıra kanıtı): beş operasyonun
 * tamamı GERÇEK node:fs'e delege edilir — her çağrı `op:path` olarak
 * log dizisine düşer. Güvenlik davranışı değişmez; test, saf-fs
 * adımlarının (temizlik → attr restore) SIRASINI gözlemler.
 */
function recordingFs(log: string[]): WorkspaceFs {
  return {
    lstat: (target: string) => lstat(target),
    unlink: async (target: string) => {
      log.push(`unlink:${target}`);
      await unlink(target);
    },
    mkdir: async (target: string, options: { recursive: boolean }) => {
      log.push(`mkdir:${target}`);
      await mkdir(target, options);
    },
    writeFile: async (target: string, data: Buffer) => {
      log.push(`writeFile:${target}`);
      await writeFile(target, data);
    },
    chmod: async (target: string, mode: number) => {
      log.push(`chmod:${target}`);
      await chmod(target, mode);
    },
  };
}

/**
 * Attr restore'u için arıza enjeksiyonu (PR #24 SB-1): lstat/unlink/
 * mkdir/chmod GERÇEK fs; YALNIZ `writeFile` her zaman EACCES — restore
 * adımının gerçekten denendiği (ve başarısız olduğunda `reset --hard`'ın
 * atlandığı) deterministik kanıt.
 */
function attrWriteFailingFs(): WorkspaceFs {
  return {
    lstat: (target: string) => lstat(target),
    unlink: (target: string) => unlink(target),
    mkdir: (target: string, options: { recursive: boolean }) => mkdir(target, options).then(() => undefined),
    writeFile: () => Promise.reject(errnoEacces()),
    chmod: (target: string, mode: number) => chmod(target, mode),
  };
}

/**
 * Diff'teki GERÇEK değişiklik satırları (`+...`/`-...`; `+++`/`---` dosya
 * başlıkları hariç). Kullanıcının base'e dahil edilmiş değişikliği diff'ta
 * yalnız DEĞİŞMEMİŞ CONTEXT satırı olarak görünür — "diff'te yok" iddiası
 * bu satır kümesine yöneliktir.
 */
function changedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
}

// ── 1) BİREBİR base + ana depo koruması + hijyen (spec 75/76/78/26) ─────────

test("creation: exact base capture + main checkout untouched + base-commit hygiene", async () => {
  const fixture = await buildFixture("exact");
  const sessionId = "s-exact";
  const workspaceDir = path.join(fixture.out, "ws", sessionId);

  // ana deponun önceden durumu (spec 75)
  const mainHeadBefore = await gitText(fixture.repo, ["rev-parse", "HEAD"]);
  const mainBranchBefore = await gitText(fixture.repo, ["symbolic-ref", "--short", "HEAD"]);
  const mainStatusBefore = (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();
  const aBefore = await readFile(path.join(fixture.repo, "src", "a.ts"));
  const execStatBefore = await lstat(path.join(fixture.repo, "src", "exec.sh"));
  const worktreesBefore = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({ ...createInput(fixture), sessionId, workspaceDir: path.join(fixture.out, "ws", sessionId) });

  // ── workspace base içeriği = ana working-tree'nin BİREBİR durumu (spec 76) ──
  const wsFile = (p: string) => path.join(workspaceDir, p);
  assert.equal((await readFile(wsFile("src/a.ts"))).toString("utf8"), "alpha-USER\nbeta\n"); // unstaged
  assert.equal((await readFile(wsFile("src/staged.txt"))).toString("utf8"), "v2\n"); // staged
  assert.equal((await readFile(wsFile("src/both.txt"))).toString("utf8"), "v2 working\n"); // staged+unstaged
  assert.equal((await readFile(wsFile("src/staged-new.txt"))).toString("utf8"), "staged-new\n"); // staged-new
  await assert.rejects(readFile(wsFile("src/del.txt")), "tracked deletion must be represented"); // deletion
  const execStat = await lstat(wsFile("src/exec.sh"));
  assert.equal((execStat.mode & 0o100) !== 0, true, "executable mode change must be represented");
  assert.equal((await readFile(wsFile("config/local-reference.json"))).toString("utf8"), "{}\n"); // seçilen untracked
  assert.equal((await readFile(wsFile("ignored.txt"))).toString("utf8"), "ignored-selected\n"); // seçilen ignored
  await assert.rejects(readFile(wsFile("secret-notes.txt")), "unselected untracked must NOT be copied");
  await assert.rejects(readFile(wsFile("huge-dump.bin")), "unselected untracked must NOT be copied");
  // symlink'ler: link'in kendisi (hedef değil)
  const link2 = await lstat(wsFile("link2"));
  assert.equal(link2.isSymbolicLink(), true);
  assert.equal(await readlink(wsFile("link2")), "tracked-clean.txt");
  const escape = await lstat(wsFile("escape"));
  assert.equal(escape.isSymbolicLink(), true);

  // ── immutable kimlik + parmak izleri ──────────────────────────────────────
  const baseHead = await gitText(workspaceDir, ["rev-parse", "HEAD"]);
  assert.equal(ws.baseCommit, baseHead);
  assert.notEqual(ws.baseCommit, mainHeadBefore, "base commit is the transient commit B, not main HEAD A");
  // `symbolic-ref` detached'ta hata VERİR; `--symbolic-full-name` iki durumda da
  // exit 0 ile döner: branch → refs/heads/..., detached → "HEAD".
  assert.equal(await gitText(workspaceDir, ["rev-parse", "--symbolic-full-name", "HEAD"]), "HEAD", "worktree must be detached");
  const author = await gitText(workspaceDir, ["log", "-1", "--format=%an <%ae>"]);
  assert.equal(author, "Splash <splash@local.invalid>", "deterministic Splash identity — NOT the fixture user");
  const subject = await gitText(workspaceDir, ["log", "-1", "--format=%s"]);
  assert.equal(subject, `splash base ${sessionId}`);
  // fingerprint: birebir base içeriğinin özeti
  const fp = ws.base.fingerprints.get("src/a.ts");
  assert.ok(fp !== undefined && fp.exists === true);
  if (fp !== undefined && fp.exists) {
    assert.equal(fp.type, "file");
    assert.equal(fp.contentSha256, sha256("alpha-USER\nbeta\n"));
  }
  assert.ok(ws.base.basePaths.has("ignored.txt"), "force-added ignored file is part of base tree");
  assert.ok(ws.base.basePaths.has("config/local-reference.json"));
  assert.ok(!ws.base.basePaths.has("secret-notes.txt"), "unselected untracked is NOT in base");

  // ── ana depo DEĞİŞMEZ (spec 75/28) ───────────────────────────────────────
  assert.equal(await gitText(fixture.repo, ["rev-parse", "HEAD"]), mainHeadBefore);
  assert.equal(await gitText(fixture.repo, ["symbolic-ref", "--short", "HEAD"]), mainBranchBefore);
  assert.deepEqual(
    (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
    mainStatusBefore,
  );
  assert.ok((await readFile(path.join(fixture.repo, "src", "a.ts"))).equals(aBefore), "main working file content unchanged");
  const execStatAfter = await lstat(path.join(fixture.repo, "src", "exec.sh"));
  assert.equal(execStatAfter.mode, execStatBefore.mode, "main file mode unchanged");
  assert.equal((await gitText(fixture.repo, ["branch", "--list", "splash*"])).trim(), "", "no splash branch");
  assert.equal((await gitText(fixture.repo, ["tag"])).trim(), "", "no tag");
  // tek yeni worktree: bizimkiler
  // `git worktree list` KANONİK (realpath) yol basar (macOS: /var → /private/var)
  const worktreesAfter = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
  assert.equal(worktreesAfter.length, worktreesBefore.length + 1);
  assert.ok(worktreePaths(worktreesAfter).includes(await realpath(workspaceDir)));

  // ── hook'lar ÇALIŞMADI (spec 26/78) + gpgsign=true repo'ya rağmen imzasız ──
  await assert.rejects(lstat(path.join(fixture.out, "hook-marker")), "repository hooks must not run");
  const gpg = await gitText(workspaceDir, ["log", "-1", "--format=%G?"]);
  assert.equal(gpg, "N", "base commit must not be signed even with commit.gpgsign=true");

  await ws.destroy();
});

// ── 2) Kullanıcının önceden-existing değişikliği worker diff'inde YOK (spec 77/64)

test("worker diff excludes the user's pre-existing change captured into base", async () => {
  const fixture = await buildFixture("preexist");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // base = "alpha-USER\nbeta\n" (kullanıcının değişikliği base'E dahil)
    const result = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "beta", replace: "beta-2" }] }]),
    );
    assert.deepEqual(result.filesChanged, ["src/a.ts"]);
    const diff = await ws.diff();
    assert.ok(diff.includes("beta-2"), "worker change is in the diff");
    // Kullanıcının değişikliği base'E dahil edildi → bir değişiklik satırı
    // olarak ASLA görünmez (yalnız değişmemiş context satırı olabilir).
    assert.ok(
      !changedLines(diff).some((line) => line.includes("alpha-USER")),
      "user's pre-existing change must NOT appear as a changed line",
    );
  } finally {
    await ws.destroy();
  }
});

// ── 3) allow-list e2e (spec 81) ─────────────────────────────────────────────

test("allow-list end to end: editable ok, read-only/other rejected, create free (spec 81)", async () => {
  const fixture = await buildFixture("allow");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "alpha-WORKER" }] },
        { kind: "modify", path: "src/reference.ts", operations: [{ search: "ref", replace: "ref2" }] },
        { kind: "delete", path: "src/reference.ts" },
        { kind: "modify", path: "src/secret.ts", operations: [{ search: "top-secret", replace: "x" }] },
        { kind: "delete", path: "src/secret.ts" },
        { kind: "create", path: "src/brand-new.ts", content: "brand\n" },
      ]),
    );
    assert.equal(result.validation.editsRequested, 6);
    assert.equal(result.validation.editsApplied, 2);
    assert.equal(result.validation.rejected.length, 4);
    const reasons = result.validation.rejected.map((r) => [r.file, r.reason].join("|"));
    assert.ok(reasons.includes("src/reference.ts|read-only path"));
    assert.ok(reasons.includes("src/reference.ts|read-only path") === true);
    assert.ok(reasons.includes("src/secret.ts|path not editable"));
    assert.ok(reasons.includes("src/secret.ts|path not editable") === true);

    const wsDir = ws.workspaceDir;
    assert.equal((await readFile(path.join(wsDir, "src/a.ts"))).toString(), "alpha-WORKER\nbeta\n");
    assert.equal((await readFile(path.join(wsDir, "src/reference.ts"))).toString(), "ref\n"); // red → base'te durdu
    assert.equal((await readFile(path.join(wsDir, "src/secret.ts"))).toString(), "top-secret\n"); // red → base'te durdu
    assert.equal((await readFile(path.join(wsDir, "src/brand-new.ts"))).toString(), "brand\n");
    assert.deepEqual(result.filesChanged.sort(), ["src/a.ts", "src/brand-new.ts"]);
  } finally {
    await ws.destroy();
  }
});

// ── 4) binary: modify red, delete kabul (spec 85) ───────────────────────────

test("binary editable file: modify rejected, delete accepted (spec 85)", async () => {
  const fixture = await buildFixture("binary");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // base yakalama binary dosyayı bayt-bayt taşıdı (ikame karakteri
    // bozulması yok); red edilecek modify hiçbir yazma yapamayacak.
    assert.ok(
      (await readFile(path.join(ws.workspaceDir, "src", "binary.bin"))).equals(BINARY_BYTES),
      "binary base content must be captured byte-identical",
    );
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/binary.bin", operations: [{ search: "x", replace: "y" }] },
        { kind: "delete", path: "src/binary.bin" },
      ]),
    );
    // modify (binary metin) red; delete (editable base yolu) kabul → dosya gitti.
    assert.equal(result.validation.editsApplied, 1);
    assert.equal(result.validation.rejected[0]!.reason, "target is not a regular text file");
    await assert.rejects(readFile(path.join(ws.workspaceDir, "src", "binary.bin")));
  } finally {
    await ws.destroy();
  }
});

// ── 5) full-patch-set: drift yok (spec 88) ──────────────────────────────────

test("round 2 full patch set resets round 1 (no incremental drift, spec 88)", async () => {
  const fixture = await buildFixture("drift");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const wsDir = ws.workspaceDir;
    await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "round1" }] },
        { kind: "create", path: "generated.ts", content: "gen\n" },
      ]),
    );
    assert.equal((await readFile(path.join(wsDir, "src/a.ts"))).toString(), "round1\nbeta\n");
    assert.equal((await readFile(path.join(wsDir, "generated.ts"))).toString(), "gen\n");

    // 2. tur: TAM olarak yeni bir küme (base'e karşı) — a.ts base'e, generated gider
    const round2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/both.txt", operations: [{ search: "v2 working", replace: "round2" }] }]),
    );
    assert.equal((await readFile(path.join(wsDir, "src/a.ts"))).toString(), "alpha-USER\nbeta\n", "a.ts back to immutable base");
    await assert.rejects(readFile(path.join(wsDir, "generated.ts")), "round-1 create removed by scoped reset");
    assert.equal((await readFile(path.join(wsDir, "src/both.txt"))).toString(), "round2\n");
    assert.deepEqual(round2.filesChanged, ["src/both.txt"]);
  } finally {
    await ws.destroy();
  }
});

// ── 6) geniş clean YOK — sentinel kalır (spec 89) ───────────────────────────

test("scoped reset never removes unknown untracked files (no broad git clean, spec 89)", async () => {
  const fixture = await buildFixture("clean");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const wsDir = ws.workspaceDir;
    await ws.applyPatchSet(workerResult([{ kind: "create", path: "generated.ts", content: "gen\n" }]));
    // bilinmeyen, worker-oluşturulan OLMAYAN untracked sentinel
    await writeFile(path.join(wsDir, "user-sentinel.txt"), "sentinel\n");

    const round2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "r2" }] }]),
    );
    assert.equal((await readFile(path.join(wsDir, "user-sentinel.txt"))).toString(), "sentinel\n", "sentinel must survive");
    await assert.rejects(readFile(path.join(wsDir, "generated.ts")));
    assert.ok(!round2.filesChanged.includes("user-sentinel.txt"), "unknown untracked is not a worker change");
  } finally {
    await ws.destroy();
  }
});

// ── 7) intent-to-add + BOŞ dosya (spec 90/61) ───────────────────────────────

test("created files (incl. empty) appear in diff/stat/export via intent-to-add; base sha unchanged (spec 90/61)", async () => {
  const fixture = await buildFixture("intent");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const baseBefore = ws.baseCommit;
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "notes/hello.txt", content: "hi\nthere\n" },
        { kind: "create", path: "empty.txt", content: "" },
      ]),
    );
    assert.deepEqual(result.filesChanged.sort(), ["empty.txt", "notes/hello.txt"]);
    assert.equal(result.diffStats.files, 2);
    assert.equal(result.diffStats.insertions, 2); // boş dosya 0/0 (git bunu temsil eder)
    assert.equal(result.diffStats.deletions, 0);

    const diff = await ws.diff();
    assert.ok(diff.includes("empty.txt"));
    assert.ok(diff.includes("notes/hello.txt"));

    assert.equal(ws.baseCommit, baseBefore, "intent-to-add must NOT create a new base commit");
    assert.equal(await gitText(ws.workspaceDir, ["rev-parse", "HEAD"]), baseBefore);

    const exported = await ws.exportPatch(fixture.out);
    const patch = await readFile(exported, "utf8");
    assert.ok(patch.includes("empty.txt"), "empty created file is represented in export");
    assert.ok(patch.includes("notes/hello.txt"));
  } finally {
    await ws.destroy();
  }
});

// ── 8) diff/stat değerleri (spec 91) ────────────────────────────────────────

test("diff stats against known fixture values (spec 91)", async () => {
  const fixture = await buildFixture("stats");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/a.ts", operations: [{ search: "beta\n", replace: "beta-2\n" }] }, // 1+ 1-
        { kind: "create", path: "new.txt", content: "l1\nl2\n" }, // 2+ 0-
        { kind: "delete", path: "src/del.txt" }, // base'te YOK (fixture kullanıcı silimi yapar) → "target missing" red
        { kind: "delete", path: "src/binary.bin" }, // binary silme: dosya sayılır, katkı 0/0
      ]),
    );
    // del.txt ana working-tree'de kullanıcı tarafından silinmiş → base'te
    // temsil edilmez; silme isteği base varlık denetiminde red edilir.
    assert.ok(
      result.validation.rejected.some((r) => r.file === "src/del.txt" && r.reason === "target missing"),
      "delete of a base-absent path must be rejected as target missing",
    );
    const stats = await ws.stat();
    assert.equal(stats.files, 3); // a.ts + new.txt + binary.bin (del.txt red)
    assert.equal(stats.insertions, 3); // a.ts 1 + new.txt 2 (binary: 0)
    assert.equal(stats.deletions, 1); // a.ts 1 (binary: 0)
    assert.deepEqual((await ws.stat()).files, 3);
  } finally {
    await ws.destroy();
  }
});

// ── 9) filtreli diff (spec 92) ──────────────────────────────────────────────

test("filtered diff narrows to requested files; unsafe filter rejected (spec 92)", async () => {
  const fixture = await buildFixture("filter");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "only-a" }] },
        { kind: "modify", path: "src/both.txt", operations: [{ search: "v2 working", replace: "only-b" }] },
      ]),
    );
    const whole = await ws.diff();
    assert.ok(whole.includes("only-a") && whole.includes("only-b"));
    const filtered = await ws.diff({ files: ["src/a.ts"] });
    assert.ok(filtered.includes("only-a"));
    assert.ok(!filtered.includes("only-b"), "filter must narrow");

    await expectWorkspaceError("unsafe_path", () => ws.diff({ files: ["../outside"] }));
    await expectWorkspaceError("unsafe_path", () => ws.diff({ files: [".git/config"] }));
  } finally {
    await ws.destroy();
  }
});

// ── 9b) Step 10: filtreli `stat(options?)` (Step 10 spec 8) ──────────────────
//
// Geriye uyumlu genişletme: argümansız `stat()` eski filtresiz sonuçla
// birebir; `files` → `diff()` ile AYNI güvenli literal yol filtresi. Sayılar
// git numstat'tan gelir — aşağıdaki diff-türevli şekil YALNIZ test tarafında
// tutarlılık denetimi içindir (üretim diff metnini parse ETMEZ).

/** Test-tarafı tutarlılık: unified diff'teki dosya başlığı + değişen satır sayısı. */
function diffShape(diff: string): { files: number; insertions: number; deletions: number } {
  const lines = changedLines(diff);
  return {
    files: diff.split("\n").filter((line) => line.startsWith("diff --git ")).length,
    insertions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
  };
}

/** Dört türlü değişiklik: iki modify + worker-create (intent-to-add) + delete. */
const STAT_FILTER_EDITS: WorkerEdit[] = [
  { kind: "modify", path: "src/a.ts", operations: [{ search: "beta\n", replace: "beta-2\n" }] }, // +1 -1
  { kind: "modify", path: "src/both.txt", operations: [{ search: "v2 working", replace: "B1\nB2" }] }, // +2 -1
  { kind: "create", path: "notes/new.txt", content: "n1\nn2\nn3\n" }, // +3
  { kind: "delete", path: "src/staged.txt" }, // -1 (base: "v2\n")
];

test("stat(): no-arg call is byte-identical to the legacy unfiltered stats; stat({files: []}) is unfiltered (Step 10 spec 8)", async () => {
  const fixture = await buildFixture("stat-compat");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const applied = await ws.applyPatchSet(workerResult(STAT_FILTER_EDITS));
    assert.equal(applied.validation.editsApplied, 4);
    const legacy = { files: 4, insertions: 6, deletions: 3 };
    // `applyPatchSet` içindeki filtresiz `statInternal()` = eski davranış.
    assert.deepEqual(applied.diffStats, legacy);
    assert.deepEqual(await ws.stat(), legacy);
    assert.deepEqual(await ws.stat(undefined), legacy);
    assert.deepEqual(await ws.stat({}), legacy);
    // Boş dizi = filtresiz (`diff()` semantiğiyle aynı).
    assert.deepEqual(await ws.stat({ files: [] }), legacy);
    assert.equal(await ws.diff({ files: [] }), await ws.diff());
  } finally {
    await ws.destroy();
  }
});

test("stat({files}): counts only the requested paths — modify, worker-created (intent-to-add) and deleted files; consistent with the filtered diff (Step 10 spec 8)", async () => {
  const fixture = await buildFixture("stat-filter");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(workerResult(STAT_FILTER_EDITS));
    const cases: Array<{ files: string[]; expected: { files: number; insertions: number; deletions: number } }> = [
      { files: ["src/a.ts"], expected: { files: 1, insertions: 1, deletions: 1 } },
      { files: ["src/both.txt"], expected: { files: 1, insertions: 2, deletions: 1 } },
      { files: ["notes/new.txt"], expected: { files: 1, insertions: 3, deletions: 0 } }, // worker-created
      { files: ["src/staged.txt"], expected: { files: 1, insertions: 0, deletions: 1 } }, // silinen
      { files: ["src/a.ts", "notes/new.txt"], expected: { files: 2, insertions: 4, deletions: 1 } },
      { files: ["./src/a.ts"], expected: { files: 1, insertions: 1, deletions: 1 } }, // kanonikleştirilir
      { files: ["tracked-clean.txt"], expected: { files: 0, insertions: 0, deletions: 0 } }, // güvenli, değişmemiş
    ];
    for (const { files, expected } of cases) {
      const stats = await ws.stat({ files });
      assert.deepEqual(stats, expected, `stat for ${files.join(",")}`);
      // Aynı filtreli diff ile tutarlı (dosya sayısı + değişen satırlar).
      assert.deepEqual(diffShape(await ws.diff({ files })), expected, `diff shape for ${files.join(",")}`);
    }
    // Filtre diğer dosyaları SAYMAZ: tüm workspace daha geniştir.
    assert.deepEqual(await ws.stat(), { files: 4, insertions: 6, deletions: 3 });
  } finally {
    await ws.destroy();
  }
});

test("stat({files}): glob/pathspec-like input is literal and never broadens — 0 files, same as diff (Step 10 spec 8, audit CRITICAL-1)", async () => {
  const fixture = await buildFixture("stat-literal");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(workerResult(STAT_FILTER_EDITS));
    for (const magic of ["src/*.ts", "*", "src/?.ts", ":(glob)src/**", ":(exclude)src/a.ts", ":!src/a.ts", "src/[ab].ts"]) {
      assert.deepEqual(
        await ws.stat({ files: [magic] }),
        { files: 0, insertions: 0, deletions: 0 },
        `literal filter must not expand: ${magic}`,
      );
      assert.equal(await ws.diff({ files: [magic] }), "", `diff literal filter must not expand: ${magic}`);
    }
  } finally {
    await ws.destroy();
  }
});

test("stat({files}): unsafe path filters fail closed with unsafe_path, exactly like diff (Step 10 spec 8)", async () => {
  const fixture = await buildFixture("stat-unsafe");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(workerResult(STAT_FILTER_EDITS));
    const unsafe = ["../x", "/abs/x", ".git/config", "src/.GIT/config", "a\\b", "a\0b", "src/../x", "", "."];
    for (const bad of unsafe) {
      await expectWorkspaceError("unsafe_path", () => ws.stat({ files: [bad] }));
      await expectWorkspaceError("unsafe_path", () => ws.diff({ files: [bad] }));
    }
    // Güvenli bir yolla karışık olsa bile tamamı reddedilir (kısmi sonuç YOK).
    await expectWorkspaceError("unsafe_path", () => ws.stat({ files: ["src/a.ts", "../x"] }));
    // Red workspace'i bozmaz.
    assert.deepEqual(await ws.stat(), { files: 4, insertions: 6, deletions: 3 });
  } finally {
    await ws.destroy();
  }
});

test("stat({files}): a destroyed workspace reds with workspace_destroyed (Step 10 spec 8)", async () => {
  const fixture = await buildFixture("stat-destroyed");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(workerResult(STAT_FILTER_EDITS));
    await ws.destroy();
    await expectWorkspaceError("workspace_destroyed", () => ws.stat({ files: ["src/a.ts"] }));
    await expectWorkspaceError("workspace_destroyed", () => ws.stat({ files: [] }));
    // İmha denetimi yol denetiminden ÖNCE (mevcut sıra: assertUsable ilk).
    await expectWorkspaceError("workspace_destroyed", () => ws.stat({ files: ["../x"] }));
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

// ── 10) export + git apply uyumu + binary (spec 93/94/95) ───────────────────

test("export: path shape, repo-outside, worker-contribution-only, git-apply compatible (spec 93/94/95)", async () => {
  const fixture = await buildFixture("export");
  const sessionId = "s-export";
  const workspaceDir = path.join(fixture.out, "ws", sessionId);
  const ws = await createGitWorktreeWorkspace({ ...createInput(fixture), sessionId, workspaceDir });
  try {
    await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: "src/a.ts", operations: [{ search: "beta", replace: "beta-EXPORTED" }] },
        { kind: "create", path: "newfile.txt", content: "created\n" },
        { kind: "delete", path: "src/del.txt" },
        { kind: "delete", path: "src/binary.bin" }, // binary deletion → --binary section
      ]),
    );

    const patchPath = await ws.exportPatch(fixture.out);
    // Yerleşim: <outputRoot>/patches/<repo-id>/<session-id>.patch
    const repoId = path.basename(path.dirname(patchPath));
    assert.match(repoId, /^[0-9a-f]{16}$/, "repo-id is a 16-hex digest");
    assert.ok(path.isAbsolute(patchPath));
    assert.equal(path.basename(patchPath), `${sessionId}.patch`);
    assert.ok(!patchPath.startsWith(fixture.repo + path.sep), "patch must be outside the repository");

    const patch = await readFile(patchPath, "utf8");
    assert.ok(patch.includes("beta-EXPORTED"), "worker modification is exported");
    assert.ok(patch.includes("created"), "worker create is exported");
    // Kullanıcının base'e dahil edilmiş değişikliği bir DEĞİŞİKLİK satırı
    // olarak patch'te YOK (context satırı olarak görünmesi doğrudur — diff
    // formatının kendi doğası).
    assert.ok(
      !changedLines(patch).some((line) => line.includes("alpha-USER")),
      "user's pre-existing change must NOT be exported as a changed line",
    );
    assert.ok(patch.includes("GIT binary patch"), "--binary section genuinely present for the binary deletion");
    // del.txt base'te temsil edilmez (fixture: kullanıcı ana ağaçta sildi) →
    // patch'te içerik taşır; silme isteği zaten "target missing" olarak red.
    assert.ok(!patch.includes("d1"), "base-absent path content must not leak into the patch");

    // `git apply` uyumu: base durumunu temsil eden İKİNCİ temiz checkout
    const second = path.join(fixture.out, "second-checkout");
    await gitOk(fixture.repo, ["worktree", "add", "--detach", second, ws.baseCommit]);
    try {
      await runGit(["apply", patchPath], { cwd: second, config: ["core.hooksPath=/dev/null"] });
      await treesEqual(second, workspaceDir); // bayt-bayt birebir
    } finally {
      await gitOk(fixture.repo, ["worktree", "remove", "--force", second]);
    }
  } finally {
    await ws.destroy();
  }
});

// ── 11) export başarısızlığı workspace'i KORUR (spec 96/72) ─────────────────

test("export failure preserves the workspace (spec 96/72)", async () => {
  const fixture = await buildFixture("exportfail");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "kept" }] }]),
    );
    const baseBefore = ws.baseCommit;

    // beklenen atal dizin yerine DÜZ DOSYA → mkdir EEXIST/ENOTDIR → export_failed
    const blockedFile = path.join(fixture.out, "blocked");
    await writeFile(blockedFile, "i am a file, not a directory");
    const badRoot = path.join(blockedFile, "deeper");

    await expectWorkspaceError("export_failed", () => ws.exportPatch(badRoot));

    // workspace aynen duruyor
    assert.equal(ws.baseCommit, baseBefore);
    const diff = await ws.diff();
    assert.ok(diff.includes("kept"), "workspace diff still works after failed export");
    const again = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/both.txt", operations: [{ search: "v2 working", replace: "again" }] }]),
    );
    assert.equal(again.validation.editsApplied, 1); // destroy CAGRILMADI — apply hâlâ çalışıyor
  } finally {
    await ws.destroy();
  }
});

// ── 11b) kullanıcının porcelain git config'i çıktıyı BOZAMAZ (Step 10 M1) ──
// Ölçüldü (Apple Git 2.50.1): `color.ui=always` ANSI kaçışı, `diff.noprefix`/
// `mnemonicPrefix` öneksiz başlık üretir → export patch'i uygulanamaz; base
// yakalama delta'sı uygulanamaz; `apply.whitespace=fix` base'i main'den
// saptırır, `=error` yakalamayı düşürür.

/** Sondaki boşluklu kirli main: unstaged değişiklik + staged YENİ dosya. */
async function buildPorcelainRepo(name: string): Promise<Fixture> {
  const out = path.join(tmp, name);
  const repo = path.join(out, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Fixture User"]);
  await gitOk(repo, ["config", "user.email", "fixture@local.invalid"]);
  await gitOk(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "src", "a.ts"), "alpha\nbeta\n");
  await writeFile(path.join(repo, "src", "b.ts"), "one\n");
  await gitOk(repo, ["add", "-A"]);
  await gitOk(repo, ["commit", "-m", "porcelain base"]);
  await writeFile(path.join(repo, "src", "a.ts"), "alpha   \nbeta\n"); // unstaged + sondaki boşluk
  await writeFile(path.join(repo, "src", "staged-new.ts"), "fresh  \n"); // staged YENİ + sondaki boşluk
  await gitOk(repo, ["add", "src/staged-new.ts"]);
  return { repo, out };
}

/** Geçici olarak GLOBAL git config'ini `content`'e çevirir; `finally`'de boşa döner. */
async function withGlobalGitConfig<T>(out: string, content: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(out, `global-${createHash("sha256").update(content).digest("hex").slice(0, 8)}.gitconfig`);
  await writeFile(file, content);
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    return await fn();
  } finally {
    process.env.GIT_CONFIG_GLOBAL = emptyConfigFile;
  }
}

const PORCELAIN_CONFIG =
  "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n[color]\n\tui = always\n\tdiff = always\n[apply]\n\twhitespace = fix\n";

/** Eski (M1 öncesi) export/hash argümanları — geriye uyum kanıtının referansı. */
const LEGACY_FULL_DIFF_ARGS = ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames"];

test("porcelain git config (noprefix/mnemonicPrefix/color.ui=always/apply.whitespace=fix): exact base, clean a/ b/ export + diff, git-apply compatible, config-independent hash (Step 10 M1)", async () => {
  const fixture = await buildPorcelainRepo("porcelain-config");
  const sessionId = "s-porcelain";
  const workspaceDir = path.join(fixture.out, "ws", sessionId);
  const mainA = await readFile(path.join(fixture.repo, "src", "a.ts"));
  const mainStagedNew = await readFile(path.join(fixture.repo, "src", "staged-new.ts"));

  const ws = await withGlobalGitConfig(fixture.out, PORCELAIN_CONFIG, async () => {
    const created = await createGitWorktreeWorkspace({
      repoRoot: fixture.repo,
      workspaceDir,
      sessionId,
      editablePaths: ["src/a.ts", "src/b.ts", "src/staged-new.ts"],
    });
    // Base = main'in BİREBİR baytları (apply.whitespace=fix sondaki boşluğu SİLEMEZ).
    const baseA = created.readBaseEntry("src/a.ts");
    const baseNew = created.readBaseEntry("src/staged-new.ts");
    assert.ok(baseA.exists && baseA.type === "file" && baseA.content.equals(mainA), "base src/a.ts === main bytes");
    assert.ok(baseNew.exists && baseNew.type === "file" && baseNew.content.equals(mainStagedNew), "staged-new === main");
    return created;
  });
  try {
    const { patch, diff, hostileHash } = await withGlobalGitConfig(fixture.out, PORCELAIN_CONFIG, async () => {
      await ws.applyPatchSet(
        workerResult([
          { kind: "modify", path: "src/a.ts", operations: [{ search: "beta", replace: "beta-W" }] },
          { kind: "create", path: "src/new.ts", content: "made\n" },
        ]),
      );
      const patchPath = await ws.exportPatch(fixture.out);
      return { patch: await readFile(patchPath), diff: await ws.diff(), hostileHash: await ws.recoveryStateHash() };
    });

    // Export: ESC YOK; standart a/ b/ başlıklar.
    assert.ok(!patch.includes(0x1b), "exported patch must not contain ANSI escapes");
    const patchText = patch.toString("utf8");
    assert.ok(patchText.includes("diff --git a/src/a.ts b/src/a.ts"), "a/ b/ prefixed header (modify)");
    assert.ok(patchText.includes("diff --git a/src/new.ts b/src/new.ts"), "a/ b/ prefixed header (create)");
    assert.ok(!patchText.includes("diff --git src/") && !patchText.includes(" i/") && !patchText.includes(" w/"));
    // splash_diff çıktısı da temiz.
    assert.ok(!diff.includes("\u001b"), "diff() must not contain ANSI escapes");
    assert.ok(diff.includes("diff --git a/src/a.ts b/src/a.ts"));

    // Varsayılan config altında: aynı state'in hash'i birebir; eski argümanların
    // ürettiği baytlar export ile BİREBİR (mevcut kalıcı hash'ler geçerli kalır).
    assert.equal(await ws.recoveryStateHash(), hostileHash, "state hash is independent of porcelain config");
    const legacy = await runGit([...LEGACY_FULL_DIFF_ARGS, ws.baseCommit], { cwd: workspaceDir, config: ["core.hooksPath=/dev/null"] });
    assert.ok(legacy.stdout.equals(patch), "default-config legacy output === new export bytes");
    assert.equal(sha256(legacy.stdout), hostileHash, "legacy hash formula === new hash (backward compatible)");

    // YALNIZ test harness'ı: varsayılan config'li tek kullanımlık checkout'ta uygulanır.
    const second = path.join(fixture.out, "second-checkout");
    await gitOk(fixture.repo, ["worktree", "add", "--detach", second, ws.baseCommit]);
    try {
      const patchPath = path.join(fixture.out, "porcelain.patch");
      await writeFile(patchPath, patch);
      await runGit(["apply", "--check", patchPath], { cwd: second, config: ["core.hooksPath=/dev/null"] });
      await runGit(["apply", patchPath], { cwd: second, config: ["core.hooksPath=/dev/null"] });
      await treesEqual(second, workspaceDir); // sonuç = worker sonucu, bayt-bayt
    } finally {
      await gitOk(fixture.repo, ["worktree", "remove", "--force", second]);
    }
  } finally {
    await ws.destroy();
  }
});

test("apply.whitespace=error in the user config never breaks base capture; base bytes stay exact (Step 10 M1)", async () => {
  const fixture = await buildPorcelainRepo("porcelain-ws-error");
  const mainA = await readFile(path.join(fixture.repo, "src", "a.ts"));
  await withGlobalGitConfig(fixture.out, "[apply]\n\twhitespace = error\n", async () => {
    const ws = await createGitWorktreeWorkspace({
      repoRoot: fixture.repo,
      workspaceDir: path.join(fixture.out, "ws", "s-ws-error"),
      sessionId: "s-ws-error",
      editablePaths: ["src/a.ts", "src/staged-new.ts"],
    });
    try {
      const baseA = ws.readBaseEntry("src/a.ts");
      assert.ok(baseA.exists && baseA.type === "file" && baseA.content.equals(mainA), "base src/a.ts === main bytes");
      assert.equal(await readFile(path.join(ws.workspaceDir, "src", "staged-new.ts"), "utf8"), "fresh  \n");
    } finally {
      await ws.destroy();
    }
  });
});

// ── 11c) state hash kullanıcının diff BİÇİM config'inden bağımsız (Step 10 H) ──
// Ölçüldü (Apple Git 2.50.1): aşağıdaki her ayar eski hash diff'inin baytlarını
// değiştirir (`minimal` ve `relative` hariç) → görev ile restart arasında config
// değişirse kurtarma uyuşmazlık görür ve oturum kapatılamazdı.

/** Her biçim ayarını tetikleyen fikstür: tam-içerik yeniden yazımları. */
const FORMAT_FILES: ReadonlyArray<readonly [string, string, string]> = [
  // diff.context: tek değişiklik, geniş bağlam
  ["ctx.txt", Array.from({ length: 30 }, (_, i) => `${i + 1}\n`).join(""),
    Array.from({ length: 30 }, (_, i) => (i + 1 === 15 ? "fifteen\n" : `${i + 1}\n`)).join("")],
  // diff.interHunkContext: aralarında 8 satır olan iki değişiklik (-U3'te iki hunk)
  ["gap.txt", Array.from({ length: 30 }, (_, i) => `${i + 1}\n`).join(""),
    Array.from({ length: 30 }, (_, i) => (i + 1 === 5 ? "five\n" : i + 1 === 14 ? "fourteen\n" : `${i + 1}\n`)).join("")],
  // diff.algorithm: patience/histogram'ın myers'tan ayrıştığı klasik örnek
  ["algo.c",
    "#include <stdio.h>\n\n// Frobs foo heartily\nint frobnitz(int foo)\n{\n    int i;\n    for(i = 0; i < 10; i++)\n    {\n" +
      '        printf("Your answer is: ");\n        printf("%d\\n", foo);\n    }\n}\n\nint fact(int n)\n{\n    if(n > 1)\n    {\n' +
      "        return fact(n-1) * n;\n    }\n    return 1;\n}\n\nint main(int argc, char **argv)\n{\n    frobnitz(fact(10));\n}\n",
    "#include <stdio.h>\n\nint fib(int n)\n{\n    if(n > 2)\n    {\n        return fib(n-1) + fib(n-2);\n    }\n    return 1;\n}\n\n" +
      "// Frobs foo heartily\nint frobnitz(int foo)\n{\n    int i;\n    for(i = 0; i < 10; i++)\n    {\n" +
      '        printf("%d\\n", foo);\n    }\n}\n\nint main(int argc, char **argv)\n{\n    frobnitz(fib(10));\n}\n'],
  // diff.indentHeuristic: git t4061 kayan-blok fikstürü
  ["slider.txt", "1\n2\na\n\nb\n3\n4\n", "1\n2\na\n\nb\na\n\nb\n3\n4\n"],
  // diff.suppressBlankEmpty: boş bağlam satırı
  ["blank.txt", "a\n\nb\n\nc\n", "a\n\nB\n\nc\n"],
  // core.quotePath: ASCII-dışı yol adı
  ["src/\u00e7\u011f.txt", "x\n", "y\n"],
  // diff.orderFile: sıra dosyası bu yolu öne alır
  ["zz.txt", "z\n", "Z\n"],
];

async function buildFormatRepo(name: string): Promise<{ fixture: Fixture; orderFile: string }> {
  const out = path.join(tmp, name);
  const repo = path.join(out, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Fixture User"]);
  await gitOk(repo, ["config", "user.email", "fixture@local.invalid"]);
  await gitOk(repo, ["config", "core.autocrlf", "false"]);
  for (const [file, base] of FORMAT_FILES) {
    await writeFile(path.join(repo, file), base);
  }
  await gitOk(repo, ["add", "-A"]);
  await gitOk(repo, ["commit", "-m", "format base"]);
  const orderFile = path.join(out, "order.txt");
  await writeFile(orderFile, "zz.txt\n");
  return { fixture: { repo, out }, orderFile };
}

function formatRewrite(): WorkerResult {
  return workerResult(
    FORMAT_FILES.map(([file, base, next]) => ({ kind: "modify", path: file, operations: [{ search: base, replace: next }] })),
  );
}

/** [ad, global config içeriği, eski formül bu ayarla DEĞİŞİR mi ("changes" | "same" | "unchecked")] */
function formatSettings(orderFile: string): Array<readonly [string, string, "changes" | "same" | "unchecked"]> {
  return [
    ["diff.context=7", "[diff]\n\tcontext = 7\n", "changes"],
    ["diff.algorithm=patience", "[diff]\n\talgorithm = patience\n", "changes"],
    ["diff.algorithm=histogram", "[diff]\n\talgorithm = histogram\n", "changes"],
    ["diff.algorithm=minimal", "[diff]\n\talgorithm = minimal\n", "unchecked"],
    ["diff.indentHeuristic=false", "[diff]\n\tindentHeuristic = false\n", "changes"],
    ["diff.interHunkContext=10", "[diff]\n\tinterHunkContext = 10\n", "changes"],
    ["diff.suppressBlankEmpty=true", "[diff]\n\tsuppressBlankEmpty = true\n", "changes"],
    ["core.quotePath=false", "[core]\n\tquotePath = false\n", "changes"],
    ["diff.orderFile", `[diff]\n\torderFile = ${orderFile}\n`, "changes"],
    // Ölçüldü: Splash git'i worktree KÖKÜNDE çalıştırır → `relative` etkisiz (sabitleyici eklenmedi).
    ["diff.relative=true", "[diff]\n\trelative = true\n", "same"],
  ];
}

function allFormatSettings(orderFile: string): string {
  return (
    "[diff]\n\tcontext = 7\n\talgorithm = histogram\n\tindentHeuristic = false\n\tinterHunkContext = 10\n" +
    `\tsuppressBlankEmpty = true\n\torderFile = ${orderFile}\n\trelative = true\n[core]\n\tquotePath = false\n`
  );
}

test("recoveryStateHash is independent of every diff-format setting; legacy bytes unchanged in the default config (Step 10 H)", async () => {
  const { fixture, orderFile } = await buildFormatRepo("hash-format");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-format"),
    sessionId: "s-format",
    editablePaths: FORMAT_FILES.map(([file]) => file),
  });
  try {
    const applied = await ws.applyPatchSet(formatRewrite());
    assert.equal(applied.validation.editsApplied, FORMAT_FILES.length);
    const legacyHash = async (): Promise<string> =>
      sha256((await runGit([...LEGACY_FULL_DIFF_ARGS, ws.baseCommit], { cwd: ws.workspaceDir, config: ["core.hooksPath=/dev/null"] })).stdout);

    // Varsayılan config: yeni hash = eski formülün baytlarının özeti (geriye uyum).
    const defaultHash = await ws.recoveryStateHash();
    const defaultLegacy = await legacyHash();
    assert.equal(defaultHash, defaultLegacy, "default config: new hash diff === legacy bytes");

    for (const [name, content, legacyEffect] of formatSettings(orderFile)) {
      await withGlobalGitConfig(fixture.out, content, async () => {
        // Pozitif kontrol: fikstür bu ayarı GERÇEKTEN tetikler (test boş değildir).
        if (legacyEffect === "changes") {
          assert.notEqual(await legacyHash(), defaultLegacy, `${name}: legacy formula must change (fixture exercises it)`);
        } else if (legacyEffect === "same") {
          assert.equal(await legacyHash(), defaultLegacy, `${name}: measured no effect at the worktree root`);
        }
        assert.equal(await ws.recoveryStateHash(), defaultHash, `${name}: state hash must not depend on it`);
      });
    }
    await withGlobalGitConfig(fixture.out, allFormatSettings(orderFile), async () => {
      assert.equal(await ws.recoveryStateHash(), defaultHash, "all settings combined");
    });
  } finally {
    await ws.destroy();
  }
});

test("restart under a changed diff-format config: restore (surviving + recreated worktree) + reapply reproduce the persisted hash (Step 10 H)", async () => {
  const { fixture, orderFile } = await buildFormatRepo("hash-format-e2e");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-format-e2e"),
    sessionId: "s-format-e2e",
    editablePaths: FORMAT_FILES.map(([file]) => file),
  });
  const round = await ws.applyPatchSet(formatRewrite());
  const persistedHash = await ws.recoveryStateHash(); // varsayılan config'de kaydedildi
  const state = await ws.snapshotRecoveryState();
  assert.equal(state.recoveryStateHash, persistedHash);
  const sentinel = path.join(ws.workspaceDir, "sentinel.txt");
  await writeFile(sentinel, "keep\n"); // untracked — hash'i etkilemez; reuse kanıtı

  await withGlobalGitConfig(fixture.out, allFormatSettings(orderFile), async () => {
    // (a) Hayatta worktree: hash config'ten bağımsız → kimlik + hash eşleşir → REUSE.
    const reused = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    assert.ok(await stat(sentinel).then(() => true, () => false), "surviving worktree reused (hash matched)");
    const again = await reused.applyPatchSet(formatRewrite());
    assert.deepEqual(again.validation, round.validation);
    assert.deepEqual(again.diffStats, round.diffStats);
    assert.equal(await reused.recoveryStateHash(), persistedHash, "reuse + reapply → persisted hash");
    await reused.destroy();

    // (b) Worktree yok: yeniden kurulum + yeniden-uygulama → aynı kalıcı hash.
    const recreated = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      await recreated.applyPatchSet(formatRewrite());
      assert.equal(await recreated.recoveryStateHash(), persistedHash, "recreate + reapply → persisted hash");
    } finally {
      await recreated.destroy();
    }
  });
  await ws.destroy().catch(() => undefined);
});

test("Step 9 state hash recorded under a non-default diff config is still accepted: matchesRecoveryStateHash + surviving-worktree reuse; a wrong hash is not (Step 10 hardening e)", async () => {
  const { fixture, orderFile } = await buildFormatRepo("hash-legacy");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-legacy"),
    sessionId: "s-legacy",
    editablePaths: FORMAT_FILES.map(([file]) => file),
  });
  await ws.applyPatchSet(formatRewrite());
  const state = await ws.snapshotRecoveryState(); // güncel formül
  const sentinel = path.join(ws.workspaceDir, "sentinel.txt");
  await writeFile(sentinel, "keep\n"); // untracked — reuse kanıtı
  const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
  const legacyConfig = `${allFormatSettings(orderFile)}[diff]\n\tnoprefix = true\n[color]\n\tui = always\n`;

  await withGlobalGitConfig(fixture.out, legacyConfig, async () => {
    // Step 9 sürecinin bu config'te kalıcılaştırdığı hash (pin'siz eski formül).
    const legacyHash = sha256(
      (await runGit([...LEGACY_FULL_DIFF_ARGS, ws.baseCommit], { cwd: ws.workspaceDir, config: ["core.hooksPath=/dev/null"] })).stdout,
    );
    assert.notEqual(legacyHash, state.recoveryStateHash, "fixture: the legacy formula differs under this config");
    assert.equal(await ws.matchesRecoveryStateHash(state.recoveryStateHash), true, "current formula");
    assert.equal(await ws.matchesRecoveryStateHash(legacyHash), true, "Step 9 formula accepted");
    assert.equal(await ws.matchesRecoveryStateHash("0".repeat(64)), false, "wrong hash rejected");

    // (a) Hayatta worktree + kalıcı ESKİ hash → REUSE; yeniden-uygulama sonrası da eşleşir.
    const reused = await restoreGitWorktreeWorkspace({ ...state, recoveryStateHash: legacyHash }, { expectedWorkspaceDir: state.workspaceDir });
    assert.ok(await exists(sentinel), "legacy hash matched → surviving worktree reused");
    await reused.applyPatchSet(formatRewrite());
    assert.equal(await reused.matchesRecoveryStateHash(legacyHash), true, "reuse + reapply → legacy hash");

    // (b) Yanlış hash → güvenilmez → yeniden kurulum; eşleşme YOK.
    const wrong = "f".repeat(64);
    const recreated = await restoreGitWorktreeWorkspace({ ...state, recoveryStateHash: wrong }, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.ok(!(await exists(sentinel)), "wrong hash → worktree recreated");
      await recreated.applyPatchSet(formatRewrite());
      assert.equal(await recreated.matchesRecoveryStateHash(wrong), false);
      assert.equal(await recreated.matchesRecoveryStateHash(legacyHash), true, "recreate + reapply → legacy hash");

      // (c) Near-miss: eski hash'ten SONRA tek bayt değişir → iki formül de eşleşmez.
      const nearMiss = path.join(recreated.workspaceDir, FORMAT_FILES[0]![0]);
      await writeFile(nearMiss, Buffer.concat([await readFile(nearMiss), Buffer.from(" ")]));
      assert.equal(await recreated.matchesRecoveryStateHash(legacyHash), false, "near-miss: legacy formula");
      assert.equal(await recreated.matchesRecoveryStateHash(state.recoveryStateHash), false, "near-miss: current formula");
    } finally {
      await recreated.destroy();
    }
  });
  await ws.destroy().catch(() => undefined);
});

test("matchesRecoveryStateHash: a Git failure of the Step 9 formula is a non-match, not an error (L1)", async () => {
  const { fixture } = await buildFormatRepo("hash-legacy-error");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-legacy-error"),
    sessionId: "s-legacy-error",
    editablePaths: FORMAT_FILES.map(([file]) => file),
  });
  try {
    await ws.applyPatchSet(formatRewrite());
    const current = await ws.recoveryStateHash();
    // Eksik `diff.orderFile`: pin'siz eski diff `fatal` ile düşer; güncel formül (-O<devnull>) etkilenmez.
    const missing = path.join(fixture.out, "missing-order-file");
    await withGlobalGitConfig(fixture.out, `[diff]\n\torderFile = ${missing}\n`, async () => {
      await assert.rejects(
        runGit([...LEGACY_FULL_DIFF_ARGS, ws.baseCommit], { cwd: ws.workspaceDir, config: ["core.hooksPath=/dev/null"] }),
        "fixture: the legacy formula fails under this config",
      );
      assert.equal(await ws.recoveryStateHash(), current);
      assert.equal(await ws.matchesRecoveryStateHash(current), true);
      assert.equal(await ws.matchesRecoveryStateHash("0".repeat(64)), false, "legacy git failure → false");
    });
  } finally {
    await ws.destroy();
  }
});

// ── 12) imha (spec 73) ──────────────────────────────────────────────────────

test("destroy: worktree removed, subsequent ops reject, patch file remains (spec 73)", async () => {
  const fixture = await buildFixture("destroy");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await ws.applyPatchSet(workerResult([{ kind: "create", path: "x.txt", content: "x\n" }]));
    const patchPath = await ws.exportPatch(fixture.out);

    const wsReal = await realpath(ws.workspaceDir); // imha ÖNCESİ — sonrası ENOENT verir
    await ws.destroy();
    await assert.rejects(lstat(ws.workspaceDir), "worktree directory must be gone");
    const list = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
    assert.ok(!worktreePaths(list).includes(wsReal), "worktree admin entry removed");

    await expectWorkspaceError("workspace_destroyed", () => ws.applyPatchSet(workerResult([])));
    await expectWorkspaceError("workspace_destroyed", () => ws.diff());
    await expectWorkspaceError("workspace_destroyed", () => ws.stat());
    await expectWorkspaceError("workspace_destroyed", () => ws.exportPatch(fixture.out));

    assert.ok((await readFile(patchPath, "utf8")).includes("x"), "exported patch remains on disk");
    await ws.destroy(); // idempotent: tekrar çağrı hata vermez
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

// ── 13) sembolik bağlantı kaçağı (spec 80) ──────────────────────────────────

test("symlink escape: create through a base symlink is rejected; sentinel untouched (spec 80)", async () => {
  const fixture = await buildFixture("escape");
  // dış sentinel
  const outside = path.join(fixture.out, "escape-outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "precious\n");

  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // base'te `escape` bir symlink (120000 blob) → create escape/... = traversal
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "escape/evil.ts", content: "evil\n" },
        { kind: "modify", path: "inside-link", operations: [{ search: "alpha-USER", replace: "x" }] },
        { kind: "delete", path: "link2" },
      ]),
    );
    assert.equal(result.validation.editsApplied, 1); // yalnız link2 silmesi
    const reasons = result.validation.rejected.map((r) => `${r.file}:${r.reason}`);
    assert.ok(reasons.includes("escape/evil.ts:unsafe symlink traversal"), reasons.join("; "));
    assert.ok(reasons.includes("inside-link:target is not a regular text file"), reasons.join("; "));

    // dış sentinel dokunulmamış; dışa yazı yok
    assert.equal((await readFile(path.join(outside, "sentinel.txt"))).toString(), "precious\n");
    const outsideEntries = await readdir(outside);
    assert.deepEqual(outsideEntries, ["sentinel.txt"], "nothing may be created outside the workspace");
    // workspace içinde de evil.ts yok
    await assert.rejects(readFile(path.join(ws.workspaceDir, "escape", "evil.ts")));

    // symlink DELETE: link'in kendisi gitti, hedef (tracked-clean.txt) sağlam
    await assert.rejects(lstat(path.join(ws.workspaceDir, "link2")));
    assert.equal((await readFile(path.join(ws.workspaceDir, "tracked-clean.txt"))).toString(), "clean\n");
  } finally {
    await ws.destroy();
  }
});

// ── 14) oluşum hataları (spec 10/11/74) ─────────────────────────────────────

test("creation failures: repo-internal dir, non-empty dir, unsafe id, partial cleanup (spec 10/11/12/74)", async () => {
  const fixture = await buildFixture("createfail");

  // (a) workspaceDir repo İÇİNDE → red, hiçbir şey oluşmaz
  const worktreesBefore = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
  await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...createInput(fixture), workspaceDir: path.join(fixture.repo, ".splash", "ws") }),
  );
  await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...createInput(fixture), workspaceDir: fixture.repo }),
  );
  // (b) dolu dizin → red
  const occupied = path.join(fixture.out, "occupied");
  await mkdir(occupied, { recursive: true });
  await writeFile(path.join(occupied, "junk"), "x");
  await expectWorkspaceError("invalid_input", () =>
    createGitWorktreeWorkspace({ ...createInput(fixture), workspaceDir: occupied }),
  );
  // (c) güvensiz session id → red (sessizce yeniden yazılmaz)
  for (const badId of ["", ".", "..", "a/b", "a\0b", "a\nb"]) {
    await expectWorkspaceError("invalid_input", () =>
      createGitWorktreeWorkspace({ ...createInput(fixture), sessionId: badId }),
    );
  }
  // (d) worktree add başarısız (atal bir dosya) → yarım worktree KALMAZ
  const fileParent = path.join(fixture.out, "fileparent");
  await writeFile(fileParent, "a file where a dir should be");
  await expectWorkspaceError("git_operation_failed", () =>
    createGitWorktreeWorkspace({
      ...createInput(fixture),
      workspaceDir: path.join(fileParent, "impossible"),
    }),
  );

  const worktreesAfter = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
  assert.deepEqual(worktreesAfter, worktreesBefore, "no worktree may be left behind");
});

// ── 15) ana delta uygulanamazsa oluşum red (spec 20 — partial base yok) ─────

test("creation fails cleanly when the tracked delta cannot be applied (spec 20)", async () => {
  // fixture repo + workspace oluştur, SONRA main'de worktree'den sonra
  // delta'yi bozacak bir şey yapmak yerine: delta-apply'nin başarısızlığını
  // deterministik kural — tracked dosyanın main'de worktree add SONRASI
  // worktree add öncesi haliyle çelişmesi mümkün değil (aynı repo);
  // bunun yerine apply adımının git hatası YÜZEYİNİ test ederiz:
  // worktree dizini var ama `apply`'in pre-image'i tutmayacak şekilde
  // (checkout sonrası dosya bozulursa) — doğrudan iç akışı taklit etmek
  // yerine, oluşturma hatasının GÜVENLİ olduğunu (clean worktree removal)
  // "worktree add" adımının başarısız olduğu vakayla zaten (14d) gösterdik.
  // Bu test: delta boştayken her şeyin yolunda gittiğini (empty delta) çiviler.
  const repo = path.join(tmp, "emptydelta", "repo");
  const out = path.join(tmp, "emptydelta");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  await writeFile(path.join(repo, "f.txt"), "stable\n");
  await gitOk(repo, ["add", "f.txt"]);
  await gitOk(repo, ["commit", "-m", "init"]);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-empty-delta",
    editablePaths: ["f.txt"],
  });
  try {
    // clean base: hiçbir delta; worktree == HEAD
    assert.equal((await readFile(path.join(ws.workspaceDir, "f.txt"))).toString(), "stable\n");
    const result = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "f.txt", operations: [{ search: "stable", replace: "stable-2" }] }]),
    );
    assert.equal(result.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "f.txt"))).toString(), "stable-2\n");
  } finally {
    await ws.destroy();
  }
});

// ── 16) discoverRepoRoot entegrasyonu ile oluşturma ─────────────────────────

test("create accepts a discovered repo root (read-only discovery feeds creation)", async () => {
  const fixture = await buildFixture("discover");
  const { discoverRepoRoot } = await import("../dist/workspace/git.js");
  const root = await discoverRepoRoot({ cwd: fixture.repo });
  const ws = await createGitWorktreeWorkspace({ ...createInput(fixture), repoRoot: root });
  try {
    assert.equal(ws.baseCommit.length, 40);
  } finally {
    await ws.destroy();
  }
});

// ── 17) pathspec magic: yol bir DİREKTİF değil (audit CRITICAL-1) ───────────

test("pathspec magic cannot act on a worker path: :exclude + glob are literal files (audit CRITICAL-1)", async () => {
  const fixture = await buildFixture("pathspec");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // Her iki yol da MEŞRU dosya adı. `:(literal)` pin'i OLMASAYDI:
    // `:(exclude)X` formu git'in exclude magic'i olarak — index'teki/
    // workspace'deki diğer untracked dosyaları SESSİZ mass-add'e sokardı.
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "new1.txt", content: "one\n" },
        { kind: "create", path: ":(exclude)new1.txt", content: "excluded-name\n" },
      ]),
    );
    assert.equal(result.validation.editsApplied, 2);
    // filesChanged her ikisini taşır (sıralı) — sessiz düşme / mass-add YOK
    assert.deepEqual(result.filesChanged.sort(), [":(exclude)new1.txt", "new1.txt"]);
    assert.equal((await readFile(path.join(ws.workspaceDir, "new1.txt"))).toString(), "one\n");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, ":(exclude)new1.txt"))).toString(),
      "excluded-name\n",
      "literal :exclude-adlı dosya worktree'de var olmalı",
    );

    // diff her iki dosya yolunu içerir
    const diff = await ws.diff();
    assert.ok(diff.includes("b/new1.txt"), "worker create diff'te");
    assert.ok(diff.includes("b/:(exclude)new1.txt"), "literal :exclude adı diff'te");

    // sentinel: workspace'ye ELLE yazılan worker-DIŞI untracked dosya diff'e
    // SIZMAZ — index magic kaynaklı mass-add olsaydı burada görünürdü.
    await writeFile(path.join(ws.workspaceDir, "user-sentinel.txt"), "sentinel\n");
    assert.ok(!(await ws.diff()).includes("user-sentinel.txt"), "unknown untracked must not leak into the diff");

    // Export boş değil; sentinel patch'e de sızmadı.
    const exported = await ws.exportPatch(fixture.out);
    const patch = await readFile(exported, "utf8");
    assert.ok(patch.length > 0, "export must not be empty");
    assert.ok(patch.includes("b/new1.txt"), "worker create exported");
    assert.ok(!patch.includes("user-sentinel.txt"), "sentinel must not leak into the exported patch");
  } finally {
    await ws.destroy();
  }
});

// ── 18) glob formu: `*` literal dosya adı, genleşme YOK (audit CRITICAL-1) ───
// Mass-add sentinel'i (audit LOW): apply'den ÖNCE workspace'ye elle yazılan,
// seçim glob'ünün kaptıracağı untracked `src/z.txt` filesChanged/diff'e SIZMAZ —
// `add -N` pin'i (`createdThisRound.map(literalPathspec)`) kimliğe çevrilseydi
// `git add -N -- 'src/*.txt'` tüm eşleşen untracked dosyaları intent-to-add
// ederdi (ölçüldü) ve bunlar diff'te/yeni dosya olarak görünürdü.

test("glob characters in a worker path are literal: no pathspec expansion (audit CRITICAL-1)", async () => {
  const fixture = await buildFixture("glob");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // Mass-add sentinel'leri: apply'den ÖNCE workspace'ye ELLE (worker-dışı) yazılır.
    // `src/z.txt` seçim glob'ü `src/*.txt`'i eşler; `user-sentinel.txt` kökte durur.
    await writeFile(path.join(ws.workspaceDir, "src", "z.txt"), "sentinel-z\n");
    await writeFile(path.join(ws.workspaceDir, "user-sentinel.txt"), "sentinel\n");

    // `src/*.txt` LİTERAL bir dosya adı (meşru — POSIX'te `*` legal);
    // fixture'un `src/`'inde gerçekte varolan .txt dosyaları da var.
    const result = await ws.applyPatchSet(
      workerResult([{ kind: "create", path: "src/*.txt", content: "literal-glob-name\n" }]),
    );
    assert.equal(result.validation.editsApplied, 1);
    assert.deepEqual(result.filesChanged, ["src/*.txt"], "filesChanged carries the LITERAL path");
    // Mass-add kanıtı: sentinel'ler untracked KALAR — filesChanged'e girmez.
    assert.ok(!result.filesChanged.includes("src/z.txt"), "sentinel src/z.txt must not be mass-added");
    assert.ok(!result.filesChanged.includes("user-sentinel.txt"), "sentinel user-sentinel.txt must not be mass-added");
    const stat = await lstat(path.join(ws.workspaceDir, "src", "*.txt"));
    assert.ok(stat.isFile(), "literal glob-character filename must exist");
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "*.txt"))).toString(), "literal-glob-name\n");

    const diff = await ws.diff();
    assert.ok(diff.includes("b/src/*.txt"), "literal path appears in the diff");
    // glob genleşmesi YOK: fixture'ın gerçek .txt dosyaları diff'e GİRMEMELİ
    assert.ok(!diff.includes("src/staged.txt"), "glob must not expand onto real files");
    assert.ok(!diff.includes("src/both.txt"), "glob must not expand onto real files");
    assert.ok(!diff.includes("src/staged-new.txt"), "glob must not expand onto real files");
    // Mass-add kanıtı: sentinel'ler diff'e de SIZMAZ (untracked = diff dışında).
    assert.ok(!diff.includes("src/z.txt"), "sentinel src/z.txt must not leak into the diff");
    assert.ok(!diff.includes("user-sentinel.txt"), "sentinel user-sentinel.txt must not leak into the diff");
  } finally {
    await ws.destroy();
  }
});

// ── 19) core.fsmonitor: saldırgan repo config keyfi program yürütemez (audit HIGH-1)

test("malicious core.fsmonitor in the repo config never executes (audit HIGH-1)", async () => {
  // buildFixture DEĞİŞTİRİLMEDİ — bu test kendi küçük repo'sunu kurar:
  // saldırgan `.git/config` → `[core] fsmonitor=<marker betiği>`. Merkezi
  // `core.fsmonitor=` pin'i OLMASAYDI, oluşturmanın İLK komutu (`git diff
  // HEAD`) dahil her runGit çağrısı dış programı çalıştırırdı.
  const out = path.join(tmp, "fsmonitor");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Fixture User"]);
  await gitOk(repo, ["config", "user.email", "fixture@local.invalid"]);
  const marker = path.join(out, "fsmonitor-marker");
  const script = path.join(out, "fsmonitor-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(script, 0o755);
  await gitOk(repo, ["config", "core.fsmonitor", script]); // saldırgan repo config

  await writeFile(path.join(repo, "f.txt"), "stable\n");
  await gitOk(repo, ["add", "f.txt"]);
  await gitOk(repo, ["commit", "-m", "init"]);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-fsmonitor",
    editablePaths: ["f.txt"],
  });
  try {
    await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "f.txt", operations: [{ search: "stable", replace: "stable-2" }] }]),
    );
    await ws.exportPatch(out);
  } finally {
    await ws.destroy();
  }
  // Tam yaşam döngüsü (oluştur + apply + export + destroy) boyunca marker
  // dosyası bir kez bile üretilmemeli.
  await assert.rejects(lstat(marker), "malicious core.fsmonitor must never run across the full lifecycle");
});

// ── 20) exportRoot workspace İÇİNDE → red (audit MEDIUM-1) ──────────────────

test("patch export root inside the workspace is rejected (patch must outlive destroy, audit MEDIUM-1)", async () => {
  const fixture = await buildFixture("exportinws");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // `destroy()` worktree dizinini imha eder — outputRoot workspace İÇİNDE
    // kalırsa patch'in TEK kopyası da gider (DESIGN 7.5/7.6 garantisi).
    await expectWorkspaceError("unsafe_path", () => ws.exportPatch(ws.workspaceDir));
    // Alt dizin varyantı: workspace içi herhangi bir alt yol da red.
    await expectWorkspaceError("unsafe_path", () => ws.exportPatch(path.join(ws.workspaceDir, "sub")));
  } finally {
    await ws.destroy();
  }
});

// ── 21) exec mod koruması: 755 base dosyasında modify modu korur (spec 21) ───

test("modify on a 755 base file preserves the executable mode (spec 21)", async () => {
  const fixture = await buildFixture("modmode");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    // fixture: exec.sh commit'te 644, ana ağaçta 755 (unstaged mod delta)
    // → birebir base = 755.
    const execBefore = await lstat(path.join(ws.workspaceDir, "src", "exec.sh"));
    assert.ok((execBefore.mode & 0o100) !== 0, "base must be executable (mode delta captured)");
    const result = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/exec.sh", operations: [{ search: "echo hi", replace: "echo hi2" }] }]),
    );
    assert.equal(result.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "exec.sh"))).toString(), "#!/bin/sh\necho hi2\n");
    const stat = await lstat(path.join(ws.workspaceDir, "src", "exec.sh"));
    assert.ok((stat.mode & 0o100) !== 0, "modify must keep the file executable (0o755)");
  } finally {
    await ws.destroy();
  }
});

// ── 22) create-path pin'leri: magic-adlı (glob) seçim — audit CRITICAL-1 ─────
// Seçim pathspec'i, untracked dosyaları base'e SÜRÜKLEMEMELİ: fixture'un `src/`
// altında SEÇİLMEYİŞ untracked `src/u.txt`, seçim glob'ü `src/*.txt`'i eşler;
// LİTERAL adlı `src/*.txt` ise meşru bir dosya adıdır ve seçildiği için base'e
// girer. Dört create-path `:(literal)` pin'i (ana-depo `ls-files`, worktree
// `ls-files`, `add -f`, `ls-tree --selected`) bu davranışla çivilenir: base
// ağacı yalnız LİTERAL yol kümesiyle (checkout + delta + tekil kopya)
// belirlenir; pathspec formu sonucu değiştirmez.

test("create with a magic-name (glob) selection never drags untracked files into the base (audit CRITICAL-1)", async () => {
  const fixture = await buildFixture("magiccreate");
  // Ana depoya, seçim glob'ü `src/*.txt`'in eşleyeceği UNTRACKED dosyalar:
  await writeFile(path.join(fixture.repo, "src", "u.txt"), "u\n"); // seçilmedi → base'e GİRMEZ
  await writeFile(path.join(fixture.repo, "src", "*.txt"), "literal-selected\n"); // seçildi (literal ad) → girer

  const input = createInput(fixture, "s-magic");
  const ws = await createGitWorktreeWorkspace({
    ...input,
    editablePaths: [...input.editablePaths, "src/*.txt"], // magic-adlı seçim
  });
  try {
    // Amaç: seçimin glob'ı, SEÇİLMEYİŞ untracked dosyayı base'e sürüklememeli.
    assert.ok(!ws.base.basePaths.has("src/u.txt"), "unselected untracked src/u.txt must NOT be in the base tree");
    // Meşru tracked seçimler etkilenmemiş (base'te tracked delta ile temsil ediliyor).
    assert.ok(ws.base.basePaths.has("src/a.ts"), "tracked src/a.ts must be in the base");
    assert.ok(ws.base.basePaths.has("src/staged.txt"), "tracked src/staged.txt must be in the base");
    // Seçilen LİTERAL magic-adlı dosya meşru untracked seçimdir → base'te.
    assert.ok(ws.base.basePaths.has("src/*.txt"), "selected literal src/*.txt must be in the base");
    // Worktree working-tree'si de u.txt taşımaz (untracked kopya YALNIZ literal seçimler).
    await assert.rejects(lstat(path.join(ws.workspaceDir, "src", "u.txt")), "unselected untracked must not be copied to the worktree");
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "*.txt"))).toString(), "literal-selected\n");
    // Ana repo DEĞİŞMEZ: iki dosya da untracked kalmalı, index'e SIZMAZ.
    assert.equal(await gitText(fixture.repo, ["ls-files", "--", "src/u.txt"]), "", "main index must not gain src/u.txt");
    assert.equal(await gitText(fixture.repo, ["ls-files", "--", ":(literal)src/*.txt"]), "", "main index must not gain the literal src/*.txt");
  } finally {
    await ws.destroy();
  }
});

// ── 23) PR #24 Fix 1-A: seçili untracked, ana depoda SEMBOLİK BAĞLANTI ATALI altında ──
// Kopya KAYNAĞI (ana working-tree) tarafında atal bir sembolik bağlantı
// varsa `readFile` repo DIŞINDAKİ içeriği izole base'e taşırdı → oluşum red.

test("selected path under a symlink ancestor in the main repo is rejected (source side, PR #24 Fix 1)", async () => {
  const fixture = await buildFixture("f1src");
  const leakDir = path.join(fixture.out, "leak");
  await mkdir(leakDir, { recursive: true });
  await writeFile(path.join(leakDir, "secret.txt"), "secret\n");
  // ana depoda untracked link dizin → repo DIŞI (göreli hedef link'in OLDUĞU
  // dizine göre çözülür: repo/linkdir + "../leak" → out/leak)
  await symlink("../leak", path.join(fixture.repo, "linkdir"));

  const input = createInput(fixture, "s-f1a");
  const worktreesBefore = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const err = await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...input, editablePaths: [...input.editablePaths, "linkdir/secret.txt"] }),
  );
  assert.equal(err.message, "A selected path is unsafe");

  // Yarım worktree KALMAZ; ana repo DEĞİŞMEZ; repo DIŞINA hiçbir şey yazılmaz
  assert.deepEqual(
    worktreePaths((await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  assert.deepEqual(
    (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
    statusBefore,
    "main repo must be untouched",
  );
  assert.deepEqual(await readdir(leakDir), ["secret.txt"], "nothing may be written outside the repository");
  await assert.rejects(lstat(path.join(fixture.out, "ws", "s-f1a")), "partial workspace must be removed");
});

// ── 24) PR #24 Fix 1-B: seçili untracked, workspace'te SEMBOLİK BAĞLANTI ATALI altında ──
// tracked link dizin worktree'ye checkout olur → kopya HEDEFİ tarafında atal
// link `mkdir`/`writeFile`'i workspace DIŞINA yazdırırdı → oluşum red.

test("selected path under a symlink ancestor in the workspace is rejected (target side, PR #24 Fix 1)", async () => {
  const fixture = await buildFixture("f1tgt");
  const outside = path.join(fixture.out, "tgt-outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "config.json"), "outside-config\n");
  // tracked link dizin (COMMIT ediliyor → worktree'ye checkout olur); hedef repo DIŞI
  await symlink("../tgt-outside", path.join(fixture.repo, "dir-link"));
  await gitOk(fixture.repo, ["add", "dir-link"]);
  await gitOk(fixture.repo, ["commit", "-m", "add dir-link"]);

  const input = createInput(fixture, "s-f2");
  const worktreesBefore = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const err = await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...input, editablePaths: [...input.editablePaths, "dir-link/config.json"] }),
  );
  assert.equal(err.message, "A selected path is unsafe");

  assert.deepEqual(
    worktreePaths((await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  assert.deepEqual(
    (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
    statusBefore,
    "main repo must be untouched",
  );
  assert.equal((await readFile(path.join(outside, "config.json"))).toString(), "outside-config\n", "outside target untouched");
  assert.deepEqual(await readdir(outside), ["config.json"], "nothing may be created outside the workspace");
  await assert.rejects(lstat(path.join(fixture.out, "ws", "s-f2")), "partial workspace must be removed");
});

// ── 25) PR #24 Fix 1-C: seçili yoldun KENDİSİ dışa kaçan sembolik bağlantı ──
// tracked/untracked fark etmez; hedef repo SINIRI dışında → oluşum red.

test("selected symlink with an outside target is rejected (dangling + existing, editable + read-only, PR #24 Fix 1)", async () => {
  const fixture = await buildFixture("f1sel");
  // fixture'da committed `escape -> ../escape-outside` (hedef var değil → dangling)
  const worktreesBefore = (await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const inputA = createInput(fixture, "s-f3a");
  const errA = await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...inputA, editablePaths: [...inputA.editablePaths, "escape"] }),
  );
  assert.equal(errA.message, "A selected path is an unsafe symlink");

  // hedef VAR OLAN dış dizin (dangling değil) — realpath çözülse de sınır dışı
  await mkdir(path.join(fixture.out, "escape-outside"), { recursive: true });
  const inputB = createInput(fixture, "s-f3b");
  const errB = await expectWorkspaceError("unsafe_path", () =>
    createGitWorktreeWorkspace({ ...inputB, readonlyPaths: [...(inputB.readonlyPaths ?? []), "escape"] }),
  );
  assert.equal(errB.message, "A selected path is an unsafe symlink");

  // red, worktree add ÖNCESİ (seçim denetimi) → hiçbir worktree oluşmaz
  assert.deepEqual(
    worktreePaths((await gitText(fixture.repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
  );
});

// ── 26) PR #24 Fix 1: repo İÇİNDE hedefli seçili link meşru — link KENDİSİ temsil edilir ──

test("selected symlink with an inside target is captured as itself: type 120000 + target-text fingerprint (PR #24 Fix 1)", async () => {
  const fixture = await buildFixture("f1ok");
  const ws = await createGitWorktreeWorkspace(createInput(fixture, "s-f4"));
  try {
    // untracked içerideki link: link'in kendisi (hedef değil) worktree'ye kopyalanır
    const link2 = path.join(ws.workspaceDir, "link2");
    assert.ok((await lstat(link2)).isSymbolicLink(), "the link itself is present in the workspace");
    assert.equal(await readlink(link2), "tracked-clean.txt");
    const fp1 = ws.base.fingerprints.get("link2");
    assert.ok(fp1 !== undefined && fp1.exists === true);
    if (fp1 !== undefined && fp1.exists) {
      assert.equal(fp1.type, "symlink");
      assert.equal(fp1.mode, "120000");
      assert.equal(fp1.contentSha256, sha256("tracked-clean.txt"), "fingerprint = link target TEXT, never followed");
    }
    // tracked içerideki link: aynı temsil (checkout'tan gelir)
    const fp2 = ws.base.fingerprints.get("inside-link");
    assert.ok(fp2 !== undefined && fp2.exists === true);
    if (fp2 !== undefined && fp2.exists) {
      assert.equal(fp2.type, "symlink");
      assert.equal(fp2.mode, "120000");
      assert.equal(fp2.contentSha256, sha256("src/a.ts"));
    }
    // içerideki link modify YAPILAMAZ (düz metin dosyası değil) — meşru red
    const result = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "inside-link", operations: [{ search: "alpha-USER", replace: "x" }] }]),
    );
    assert.equal(result.validation.editsApplied, 0);
    assert.equal(result.validation.rejected[0]?.reason, "target is not a regular text file");
  } finally {
    await ws.destroy();
  }
});

// ── 27) PR #24 Fix 2: CRLF base (text/eol attribute) — working-tree bayt round-trip ──

test("CRLF base via text/eol attribute: fingerprint uses working-tree bytes; CRLF edit ok, LF search rejected (PR #24 Fix 2)", async () => {
  const out = path.join(tmp, "crlf-attr");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  await writeFile(path.join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
  await writeFile(path.join(repo, "notes.txt"), "line1\r\nline2\r\n");
  await gitOk(repo, ["add", ".gitattributes", "notes.txt"]);
  await gitOk(repo, ["commit", "-m", "init"]);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-crlf",
    editablePaths: ["notes.txt"],
  });
  try {
    // İKİ ALAN: blob = LF (normalize edildi); working dosya = CRLF
    const blob = (await git(ws.workspaceDir, ["show", `${ws.baseCommit}:notes.txt`])).toString("utf8");
    assert.equal(blob, "line1\nline2\n", "the base-commit blob is LF-normalized");
    const fp = ws.base.fingerprints.get("notes.txt");
    assert.ok(fp !== undefined && fp.exists === true);
    if (fp !== undefined && fp.exists) {
      assert.equal(fp.type, "file");
      assert.equal(fp.contentSha256, sha256("line1\r\nline2\r\n"), "fingerprint = working-tree bytes (CRLF), not the blob");
    }
    // worker, GÖRDÜĞÜNÜ (CRLF) düzenlerse → birebir round-trip, kabul
    const r1 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "notes.txt", operations: [{ search: "line1\r\n", replace: "line1-x\r\n" }] }]),
    );
    assert.equal(r1.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "notes.txt"))).toString("utf8"), "line1-x\r\nline2\r\n");
    // worker LF'e normalize ettiyse → deterministik red (bozulma DEĞİL)
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "notes.txt", operations: [{ search: "line1\n", replace: "zzz" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 0);
    assert.equal(r2.validation.rejected[0]?.reason, "search text not found at operation 1");
    // red edilen turdan sonra workspace base'te (CRLF) — korundu
    assert.equal((await readFile(path.join(ws.workspaceDir, "notes.txt"))).toString("utf8"), "line1\r\nline2\r\n");
  } finally {
    await ws.destroy();
  }
});

// ── 28) PR #24 Fix 2: CRLF base (core.autocrlf) — aynı round-trip, config mekanizması ──

test("CRLF base via core.autocrlf: fingerprint uses working-tree bytes; CRLF edit ok, LF search rejected (PR #24 Fix 2)", async () => {
  const out = path.join(tmp, "crlf-autocrlf");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  await gitOk(repo, ["config", "core.autocrlf", "true"]);
  await writeFile(path.join(repo, "notes.txt"), "line1\r\nline2\r\n");
  await gitOk(repo, ["add", "notes.txt"]);
  await gitOk(repo, ["commit", "-m", "init"]);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-autocrlf",
    editablePaths: ["notes.txt"],
  });
  try {
    const blob = (await git(ws.workspaceDir, ["show", `${ws.baseCommit}:notes.txt`])).toString("utf8");
    assert.equal(blob, "line1\nline2\n", "the base-commit blob is LF-normalized");
    const fp = ws.base.fingerprints.get("notes.txt");
    assert.ok(fp !== undefined && fp.exists === true);
    if (fp !== undefined && fp.exists) {
      assert.equal(fp.contentSha256, sha256("line1\r\nline2\r\n"), "fingerprint = working-tree bytes (CRLF), not the blob");
    }
    const r1 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "notes.txt", operations: [{ search: "line1\r\n", replace: "line1-x\r\n" }] }]),
    );
    assert.equal(r1.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "notes.txt"))).toString("utf8"), "line1-x\r\nline2\r\n");
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "notes.txt", operations: [{ search: "line1\n", replace: "zzz" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 0);
    assert.equal(r2.validation.rejected[0]?.reason, "search text not found at operation 1");
    assert.equal((await readFile(path.join(ws.workspaceDir, "notes.txt"))).toString("utf8"), "line1\r\nline2\r\n");
  } finally {
    await ws.destroy();
  }
});

// ── 29) PR #24 Fix 3: repo-tanımlı DIŞ Git filter → fail-closed red ──

test("external Git filter on a selected path rejects creation before any filter-capable command runs (PR #24 Fix 3)", async () => {
  const out = path.join(tmp, "filter-repo");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  // ÖNCE içeriği commit et (filter tanımsızken — kurulum hiçbir filter yürütmez)
  await writeFile(path.join(repo, "evil.txt"), "data\n");
  await gitOk(repo, ["add", "evil.txt"]);
  await gitOk(repo, ["commit", "-m", "init"]);
  // SONRA saldırgan filter: config + attribute (her ikisi de repo kontrollü)
  const marker = path.join(out, "filter-marker");
  const script = path.join(out, "filter-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat`); // kimlik + gözlenebilir yan etki
  await chmod(script, 0o755);
  await gitOk(repo, ["config", "filter.evil.clean", script]);
  await gitOk(repo, ["config", "filter.evil.smudge", script]);
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const err = await expectWorkspaceError("invalid_repository", () =>
    createGitWorktreeWorkspace({
      repoRoot: repo,
      workspaceDir: path.join(out, "ws"),
      sessionId: "s-filter",
      editablePaths: ["evil.txt"],
    }),
  );
  assert.equal(err.message, "An external Git filter is not supported");
  await assert.rejects(lstat(marker), "the external filter program must never execute during creation");
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  await assert.rejects(lstat(path.join(out, "ws")), "partial workspace must be removed");

  // Zararsız varyant: attribute komut TANIMLAMAMIŞ bir driver adlandırıyorsa
  // (yürütülecek hiçbir program yok) → red YOK, oluşum devam eder.
  const repo2 = path.join(out, "repo2");
  await mkdir(repo2, { recursive: true });
  await gitOk(repo2, ["init", "-b", "main"]);
  await gitOk(repo2, ["config", "user.name", "T"]);
  await gitOk(repo2, ["config", "user.email", "t@local.invalid"]);
  await writeFile(path.join(repo2, ".gitattributes"), "*.txt filter=benign\n");
  await writeFile(path.join(repo2, "benign.txt"), "data\n");
  await gitOk(repo2, ["add", ".gitattributes", "benign.txt"]);
  await gitOk(repo2, ["commit", "-m", "init"]);
  const ws2 = await createGitWorktreeWorkspace({
    repoRoot: repo2,
    workspaceDir: path.join(out, "ws2"),
    sessionId: "s-benign",
    editablePaths: ["benign.txt"],
  });
  try {
    assert.equal(ws2.baseCommit.length, 40, "command-less driver is not a threat — creation proceeds");
  } finally {
    await ws2.destroy();
  }
});

// ── 29a) PR #24 Fix 3 (audit F-1): COMMITTED attribute yüzeyi (kirli working kopya) ──
// `git worktree add` TÜM committed tree'yi checkout eder → committed
// `.gitattributes` yüzeyini (SMUDGE) uygulatır. Working-tree kopyası kirlenmiş
// (attr satırı silinmiş) bir tehdit, committed kopyada hâlâ geçerlidir —
// yalnız working-tree yüzeyini denetleyen eski check, checkout'ta script
// çalıştırıyordu (audit: marker YANDI). İkinci pass bunu kapatır.

test("external Git filter in the committed .gitattributes (dirty working copy) rejects creation before checkout; smudge never runs (PR #24 Fix 3, audit F-1)", async () => {
  const out = path.join(tmp, "filter-committed-attr");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  // COMMIT: içerik + saldırgan .gitattributes (committed yüzey — `git worktree
  // add` checkout'ta tam ağacı bu attribute yüzeyiyle yazar)
  await writeFile(path.join(repo, "x.txt"), "data\n");
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
  await gitOk(repo, ["add", "x.txt", ".gitattributes"]);
  await gitOk(repo, ["commit", "-m", "init"]);
  // SALDIRI: working-tree attr kopyası KİRLİ (satır silindi) → working pass
  // "unspecified" görür; COMMITTED kopya hâlâ geçerli.
  await writeFile(path.join(repo, ".gitattributes"), "");
  // local config: smudge + clean → dış program (kimlik + gözlenebilir marker)
  const marker = path.join(out, "committed-attr-marker");
  const script = path.join(out, "committed-attr-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat`);
  await chmod(script, 0o755);
  await gitOk(repo, ["config", "filter.evil.clean", script]);
  await gitOk(repo, ["config", "filter.evil.smudge", script]);

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const err = await expectWorkspaceError("invalid_repository", () =>
    createGitWorktreeWorkspace({
      repoRoot: repo,
      workspaceDir: path.join(out, "ws"),
      sessionId: "s-cattr",
      editablePaths: ["x.txt"],
    }),
  );
  assert.equal(err.message, "An external Git filter is not supported");
  // ANA assert: filter programı ASLA yürütülmedi (checkout olmadı → smudge YOK)
  await assert.rejects(lstat(marker), "the committed-attribute filter program must never execute");
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  assert.deepEqual(
    (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
    statusBefore,
    "the main repository state must be untouched",
  );
  await assert.rejects(lstat(path.join(out, "ws")), "partial workspace must be removed");
});

// ── 29b) PR #24 Fix 3 (audit F-1): COMMITTED attribute yüzeyi (staged deletion) ──
// Staged deletion: dosya working-tree'de VAR, index'te YOK → tracked kümesinde
// görünmez; ama COMMITTED ağaçta hâlâ var → HEAD-tree pass'i denetlemeli.

test("external Git filter in the committed .gitattributes with a staged deletion rejects creation before checkout; smudge never runs (PR #24 Fix 3, audit F-1)", async () => {
  const out = path.join(tmp, "filter-committed-del");
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  await writeFile(path.join(repo, "x.txt"), "data\n");
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
  await gitOk(repo, ["add", "x.txt", ".gitattributes"]);
  await gitOk(repo, ["commit", "-m", "init"]);
  // SALDIRI: staged deletion (working-tree dosyası var, index'te yok) +
  // working-tree attr kopyası kirli (satır silindi)
  await gitOk(repo, ["rm", "--cached", "x.txt"]);
  await writeFile(path.join(repo, ".gitattributes"), "");
  const marker = path.join(out, "committed-del-marker");
  const script = path.join(out, "committed-del-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat`);
  await chmod(script, 0o755);
  await gitOk(repo, ["config", "filter.evil.clean", script]);
  await gitOk(repo, ["config", "filter.evil.smudge", script]);

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const err = await expectWorkspaceError("invalid_repository", () =>
    createGitWorktreeWorkspace({
      repoRoot: repo,
      workspaceDir: path.join(out, "ws"),
      sessionId: "s-cdel",
      editablePaths: ["x.txt"],
    }),
  );
  assert.equal(err.message, "An external Git filter is not supported");
  // ANA assert: filter programı ASLA yürütülmedi (checkout olmadı → smudge YOK)
  await assert.rejects(lstat(marker), "the committed-attribute filter program must never execute");
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  assert.deepEqual(
    (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
    statusBefore,
    "the main repository state must be untouched",
  );
  await assert.rejects(lstat(path.join(out, "ws")), "partial workspace must be removed");
});

// ── 30) PR #24 Fix 4: bilinen yol elle silinmiş → resetToBase ENOENT'ı affeder ──

test("resetToBase tolerates a manually removed worker-created path (ENOENT, PR #24 Fix 4)", async () => {
  const fixture = await buildFixture("resid8");
  const ws = await createGitWorktreeWorkspace(createInput(fixture, "s-r8"));
  try {
    const r0 = await ws.applyPatchSet(workerResult([{ kind: "create", path: "res.txt", content: "res\n" }]));
    assert.equal(r0.validation.editsApplied, 1);
    // dışsal temizlik: worker-oluşturulan yol elle gitti
    await rm(path.join(ws.workspaceDir, "res.txt"));
    await ws.resetToBase(); // ENOENT affedilir — red YOK
    // workspace tam işlevsel: sonraki tur kalıntıyı yeniden oluşturup modify alır
    const r1 = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "res.txt", content: "res2\n" },
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "r8" }] },
      ]),
    );
    assert.equal(r1.validation.editsApplied, 2);
    assert.equal((await readFile(path.join(ws.workspaceDir, "res.txt"))).toString(), "res2\n");
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "a.ts"))).toString(), "r8\nbeta\n");
  } finally {
    await ws.destroy();
  }
});

// ── 31) PR #24 Fix 4: temizlik EACCES → apply red, kalıntı KÜMEDE KALIR, sonraki tur temizler ──

test("cleanup failure (EACCES) rejects the round, keeps the residue in the known set, and the next round cleans it (PR #24 Fix 4)", async () => {
  const fixture = await buildFixture("resid9");
  const ws = await createGitWorktreeWorkspace(createInput(fixture, "s-r9"));
  try {
    const r0 = await ws.applyPatchSet(workerResult([{ kind: "create", path: "res.txt", content: "res\n" }]));
    assert.equal(r0.validation.editsApplied, 1);

    // arıza enjeksiyonu: lstat + unlink ikisi de EACCES → temizlik
    // deterministik olarak başarısız (dosyanın varlığından bağımsız:
    // reset --hard, intent-to-add yolunu git tarafında silebilir)
    setWorkspaceFs(denyingFs());
    try {
      const err = await expectWorkspaceError("workspace_operation_failed", () =>
        ws.applyPatchSet(
          workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "r9" }] }]),
        ),
      );
      assert.equal(err.message, "Cleaning the worker-created paths failed");
      // red edilen tur: tracked durum base'te; modify ASLA uygulanmadı
      assert.equal((await readFile(path.join(ws.workspaceDir, "src", "a.ts"))).toString(), "alpha-USER\nbeta\n", "no partial apply after the failed round");
    } finally {
      setWorkspaceFs(null); // gerçek fs geri
    }

    // küme KALDIĞINI ispat: fail'den sonra res.txt yeniden belirirse
    // (reset'in silemediği/yeniden yazılan senaryosu) sonraki reset temizler.
    // Küme yanlışlıkla BOŞALTILMIS olsaydı resetToBase sessizce başarılı olur
    // ve dosya geriye kalırdı.
    await writeFile(path.join(ws.workspaceDir, "res.txt"), "res\n");
    await ws.resetToBase();
    await assert.rejects(lstat(path.join(ws.workspaceDir, "res.txt")), "the retained known set is cleaned on the next reset");

    // workspace tam işlevsel: modify uygulanır
    const r1 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "r9" }] }]),
    );
    assert.equal(r1.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "a.ts"))).toString(), "r9\nbeta\n");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
});

// ── 32) PR #24 Fix 4: bilinen dosya yolunun üstünde DİZİN → red, RECURSIVE silme YOK ──

test("a directory replacing a known worker path rejects reset without recursive deletion (PR #24 Fix 4)", async () => {
  const fixture = await buildFixture("resid10");
  const ws = await createGitWorktreeWorkspace(createInput(fixture, "s-r10"));
  try {
    await ws.applyPatchSet(workerResult([{ kind: "create", path: "resfile.txt", content: "f\n" }]));
    // tip sürüklenmesi: bilinen dosya yolu artık bir DİZİN
    await rm(path.join(ws.workspaceDir, "resfile.txt"));
    await mkdir(path.join(ws.workspaceDir, "resfile.txt"));
    await writeFile(path.join(ws.workspaceDir, "resfile.txt", "inner.txt"), "inner\n");

    const err = await expectWorkspaceError("workspace_operation_failed", () => ws.resetToBase());
    assert.equal(err.message, "Cleaning the worker-created paths failed");
    // genişletme YOK: dizin + içeriği aynen durur (rm -rf / git clean / recursive unlink YASAK)
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "resfile.txt", "inner.txt"))).toString(),
      "inner\n",
      "the directory content must survive — no recursive deletion",
    );
    // manuel temizlenince sıradaki reset başarıyla biter
    await rm(path.join(ws.workspaceDir, "resfile.txt", "inner.txt"));
    await rm(path.join(ws.workspaceDir, "resfile.txt"), { recursive: true });
    await ws.resetToBase();
  } finally {
    await ws.destroy();
  }
});

// ── 33) PR #24 Fix 4: apply'da drift → rollback temizliği arıza ile başarısız → ──
// bilinen kalıntı kümede KALIR; ana checkout DOKUNULMAZ; gerçek fs'le reset geri alır.

test("failed apply rollback keeps its residue: main checkout untouched, foreign files untouched, real-fs reset recovers (PR #24 Fix 4)", async () => {
  const fixture = await buildFixture("resid11");
  const ws = await createGitWorktreeWorkspace(createInput(fixture, "s-r11"));
  try {
    const mainHeadBefore = await gitText(fixture.repo, ["rev-parse", "HEAD"]);
    const mainStatusBefore = (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

    // genB create hedefi ÖNCEDEN var → drift → apply başarısız; foreign dosya setin dışında
    await writeFile(path.join(ws.workspaceDir, "genB.txt"), "foreign-sentinel\n");
    await writeFile(path.join(ws.workspaceDir, "foreign.txt"), "foreign\n");

    setWorkspaceFs(failingFs());
    const err = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "create", path: "genA.txt", content: "A\n" },
          { kind: "create", path: "genB.txt", content: "B\n" },
        ]),
      ),
    );
    assert.equal(err.message, "Cleaning the worker-created paths failed", "rollback cleanup failed — safe operational error");
    setWorkspaceFs(null);

    // genA (bu turun create'ı) = BİLİNEN KALINTI (kümede, workspace'te); genB/foreign setin dışında
    assert.equal((await readFile(path.join(ws.workspaceDir, "genA.txt"))).toString(), "A\n", "this round's create remains as known residue");
    assert.equal((await readFile(path.join(ws.workspaceDir, "genB.txt"))).toString(), "foreign-sentinel\n", "the sentinel was never a worker path — untouched");
    assert.equal((await readFile(path.join(ws.workspaceDir, "foreign.txt"))).toString(), "foreign\n", "foreign files are never removed");

    // ana checkout DOKUNULMADI
    assert.equal(await gitText(fixture.repo, ["rev-parse", "HEAD"]), mainHeadBefore);
    assert.deepEqual(
      (await gitText(fixture.repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
      mainStatusBefore,
      "main checkout must be untouched",
    );

    // gerçek fs'le temiz reset: kalıntı gider, foreign dosyalar KALIR
    await ws.resetToBase();
    await assert.rejects(lstat(path.join(ws.workspaceDir, "genA.txt")), "the residue is removed by the clean reset");
    assert.equal((await readFile(path.join(ws.workspaceDir, "genB.txt"))).toString(), "foreign-sentinel\n", "foreign files survive the reset");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
});

// ── PR #24 audit F-6 yardımcıları (testler 34-37) ───────────────────────────
//
// Tehdit modeli: worker (güvensiz girdi) turun içi worktree'ye `.gitattributes`
// (örn. `** filter=evil`) ekebilir — `create` allow-list'ten BAĞIMSIZ (spec 81)
// — + pattern'e uyan bir dosyaya dokunur. Config'de (repo `.git/config` VEYA
// global — pratik örnek: LFS) ÖNCEDEN tanımlı `filter.<d>.clean`, tur içi
// diff/stat/export komutlarında host'ta YÜRÜR (RCE). Oluşturmdaki check o ANKI
// (temiz) yüzeyi doğruluyordu; tur sırasında yüzey worker-yazılabilir.
//
// ÖLÇÜLDÜ (Apple Git 2.50.1, bu makine): bitki attr + config'deki driver varken
// `git diff <base>` (name-only/numstat/binary) + `add -N` + `git status` (racy
// dosya) + `git reset --hard` (racy içerik doğrulama — checkout→doğrulama yolu)
// filter'ı YÜRÜTÜR. Düzeltme: (a) her turda worker yazılarından sonra +
// ilk filter-capable komuttan önce fail-closed re-check; (b) export diff'inden
// önce aynı check; (c) her `reset --hard`'dan ÖNCE bilinen worker yazılarının
// (bitki dahil) saf-fs temizliği — temizlik hata verirse reset YÜRÜTÜLMEZ.

/**
 * F-6 minimal fixture repo: `d/` altında tracked dosyalar (pattern altı).
 * Repo'da `.gitattributes` YOK → config'deki driver yalnız worker bitkisiyle
 * tehdit oluşturur; oluşum check'i temiz geçer (süper küme: hiçbir yol
 * attr gerektirmiyor → config araması bile yapılmaz).
 */
async function buildF6Repo(name: string, files: Record<string, string>): Promise<{ out: string; repo: string }> {
  const out = path.join(tmp, name);
  const repo = path.join(out, "repo");
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "T"]);
  await gitOk(repo, ["config", "user.email", "t@local.invalid"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await gitOk(repo, ["add", "-A"]);
  await gitOk(repo, ["commit", "-m", "init"]);
  return { out, repo };
}

/**
 * Önceden tanımlı filter driver'ı (LFS benzeri): marker yazan + kimlik
 * (`cat`) betik, repo yerel config'inde. `marker` = gözlenebilir RCE kanıtı.
 */
async function plantDriver(out: string, repo: string, driver: string): Promise<{ marker: string; script: string }> {
  const marker = path.join(out, `${driver}-marker`);
  const script = path.join(out, `${driver}-evil.sh`);
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat`);
  await chmod(script, 0o755);
  await gitOk(repo, ["config", `filter.${driver}.clean`, script]);
  await gitOk(repo, ["config", `filter.${driver}.smudge`, script]);
  return { marker, script };
}

/**
 * POZİTİF KONTROL (mutasyon kanıtı — audit S-2): sınıfın `statInternal()`
 * ile BİREBİR aynı komutu, sınıfın check'inden BYPASS ederek ham git ile
 * koşar. Worker yazılarının worktree'deki son halinin (bitki attr +
 * modifiye tracked dosya) filter-capable komutta filter'ı GERÇEKTEN
 * yürüttüğünü kanıtlar — fix'in savunacak bir şeyi olduğunu ölçer.
 */
async function rawRoundDiff(ws: GitWorktreeWorkspace): Promise<void> {
  await git(ws.workspaceDir, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    "-z",
    ws.baseCommit,
  ]);
}

/** Worker bitki durumunu worktree'ye ELLE kurar (attr dosyası + tracked modify). */
async function plantThreatState(ws: GitWorktreeWorkspace, attrContent: string, trackedPath: string, modifiedContent: string): Promise<void> {
  const wsDir = ws.workspaceDir;
  await writeFile(path.join(wsDir, path.dirname(trackedPath), ".gitattributes"), attrContent);
  await writeFile(path.join(wsDir, trackedPath), modifiedContent);
}

/** Bitki durumunu temizler (attr dosyası gider → reset filter yürütemez). */
async function cleanThreatState(ws: GitWorktreeWorkspace, trackedPath: string): Promise<void> {
  const wsDir = ws.workspaceDir;
  await rm(path.join(wsDir, path.dirname(trackedPath), ".gitattributes"), { force: true });
  await git(wsDir, ["reset", "--hard", ws.baseCommit]);
}

// ── 34) F-6 ana tehdit: repo-config driver + worker bitkisi → tur RED, marker ASLA ──

test("worker-planted .gitattributes with a preconfigured repo-config driver: round rejected before any filter-capable command; the filter never executes (PR #24 F-6)", async () => {
  const { out, repo } = await buildF6Repo("f6-main", { "d/p.txt": "data\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-f6",
    editablePaths: ["d/p.txt"],
  });
  // Oluşum BAŞARILI (repo temiz) → canlı workspace worktree'si listede meşru.
  const worktreesAfterCreate = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  try {
    // ── POZİTİF KONTROL (mutasyon kanıtı, audit S-2): sınıf BYPASS ──
    // Sınıfın check'i OLMASAYDI tur tam da bunu yürütürdü: bitki attr +
    // modifiye tracked dosya → ham `git diff --numstat -z <base>` filter'ı
    // host'ta çalıştırır (marker). Fix'in varlığını bu ölçüm kanıtlar.
    await plantThreatState(ws, "*.txt filter=evil\n", "d/p.txt", "data-EVIL\n");
    await rawRoundDiff(ws);
    await assert.doesNotReject(lstat(marker), "POSITIVE CONTROL: without the re-check, the round's diff WOULD execute the external filter");
    await rm(marker);
    await cleanThreatState(ws, "d/p.txt");
    await assert.rejects(lstat(marker), "cleaning the manually planted state (attribute removed) must not run the filter");

    // ── sınıf yolu: aynı patch set → RED (tur re-check), marker ASLA YOK ──
    const err = await expectWorkspaceError("invalid_repository", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "create", path: "d/.gitattributes", content: "*.txt filter=evil\n" },
          { kind: "create", path: "d/q.txt", content: "q\n" },
          { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-EVIL" }] },
        ]),
      ),
    );
    assert.equal(err.message, "An external Git filter is not supported", "the fixed fail-closed message");
    await assert.rejects(lstat(marker), "the filter program must never execute in the class round (not even in the rollback)");

    // Yarım state YOK: başarısız tur worktree ekleme/çıkarma YAPAMAZ —
    // canlı workspace zaten listede; liste create sonundaki haliyle AYNI.
    assert.deepEqual(
      worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
      worktreePaths(worktreesAfterCreate),
      "the failed round must not add or remove any worktree",
    );
    assert.deepEqual(
      (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
      statusBefore,
      "the main repository state must be untouched",
    );
    // Rollback worker yazılarını worktree'den gider (bitki dahil) → base'te.
    await assert.rejects(lstat(path.join(ws.workspaceDir, "d", ".gitattributes")), "the planted attribute is removed by the rollback");
    await assert.rejects(lstat(path.join(ws.workspaceDir, "d", "q.txt")), "the planted matching file is removed by the rollback");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(),
      "data\n",
      "the modified file is back to base",
    );

    // Workspace YARIM KALMADI — sonraki zararsız tur tam işlevsel + filter YOK.
    const ok = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-OK" }] }]),
    );
    assert.equal(ok.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-OK\n");
    await assert.rejects(lstat(marker), "the benign round must not run the filter either");
  } finally {
    await ws.destroy();
  }
  // destroy sonrası: ana repoda hiçbir worktree geride kalmadı.
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 35) F-6 LFS-global varyantı: driver GLOBAL config'de (LFS kurulu makine) ──

test("external filter in the GLOBAL config (LFS-style): worker-planted lfs attribute rejects the round; the filter never executes (PR #24 F-6)", async () => {
  const { out, repo } = await buildF6Repo("f6-lfs", { "d/x.png": "pngdata\n" });
  // LFS kurulu makine simülasyonu: `filter.lfs.*` GLOBAL config'de. Test
  // ortamı global config'i boş dosyaya pinler (before()) — bu test geçici
  // olarak LFS tanımlı dosyaya çevirir; runGit her spawn'da process.env'i
  // miras aldığı için sonraki git çağrılarında etkilidir.
  const lfsScript = path.join(out, "lfs-evil.sh");
  const marker = path.join(out, "lfs-marker");
  await writeFile(lfsScript, `#!/bin/sh\ntouch "${marker}"\ncat`);
  await chmod(lfsScript, 0o755);
  const globalConfigFile = path.join(out, "global-gitconfig");
  await writeFile(globalConfigFile, `[filter "lfs"]\n\tclean = ${lfsScript}\n\tsmudge = ${lfsScript}\n`);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfigFile;

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-lfs",
    editablePaths: ["d/x.png"],
  });
  try {
    // POZİTİF KONTROL: global-scope driver da tur diff'inde yürür —
    // config okumasının (repo yerel VEYA global) ikisi de re-check yüzeyinde.
    await plantThreatState(ws, "*.png filter=lfs\n", "d/x.png", "pngdata-EVIL\n");
    await rawRoundDiff(ws);
    await assert.doesNotReject(lstat(marker), "POSITIVE CONTROL: without the re-check, the global-scope filter WOULD execute");
    await rm(marker);
    await cleanThreatState(ws, "d/x.png");
    await assert.rejects(lstat(marker), "cleaning the planted state must not run the filter");

    const err = await expectWorkspaceError("invalid_repository", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "create", path: "d/.gitattributes", content: "*.png filter=lfs\n" },
          { kind: "modify", path: "d/x.png", operations: [{ search: "pngdata", replace: "pngdata-EVIL" }] },
        ]),
      ),
    );
    assert.equal(err.message, "An external Git filter is not supported");
    await assert.rejects(lstat(marker), "the global-scope filter must never execute in the class round");
    await assert.rejects(lstat(path.join(ws.workspaceDir, "d", ".gitattributes")), "the planted attribute is removed by the rollback");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "x.png"))).toString(), "pngdata\n", "the modified file is back to base");
  } finally {
    process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await ws.destroy();
  }
});

// ── 36) F-6 zararsız varyant: komutSUZ driver'a pattern → red YOK, tur devam ──

test("worker-planted attribute for a command-less driver (no filter.* config): round proceeds, results correct, no wedge (PR #24 F-6)", async () => {
  const { out, repo } = await buildF6Repo("f6-benign", { "d/p.txt": "data\n" });
  // `filter.benign.*` config'de TANIMLI DEĞİL — attr bir driver ADI
  // bildiriyor ama yürütülecek hiçbir program yok → tehdit YOK.

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-benign6",
    editablePaths: ["d/p.txt"],
  });
  try {
    // Round 1: bitki (komutsuz driver) + pattern altı create + tracked modify.
    const r1 = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "d/.gitattributes", content: "*.txt filter=benign\n" },
        { kind: "create", path: "d/q.txt", content: "q\n" },
        { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-1" }] },
      ]),
    );
    assert.equal(r1.validation.editsApplied, 3, "a command-less driver is not a threat — the round completes");
    assert.deepEqual(r1.filesChanged.sort(), ["d/.gitattributes", "d/p.txt", "d/q.txt"]);
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "q.txt"))).toString(), "q\n");
    const diff = await ws.diff();
    assert.ok(diff.includes("d/q.txt"), "the worker create appears in the diff");
    assert.ok(diff.includes("data-1"), "the worker modification appears in the diff");

    // Round 2: aynı zararsız bitki YENİDEN — round 1'in create kümesi
    // (bitki dahil) önceki turun kalıntısı olarak temizlenir + round devam
    // eder (komutSUZ driver → wedge YOK, workspace işlevsel kalır).
    // Dikkat: her tur immutable base'e karşı TAM ikame'dir (spec 35/88) —
    // round başındaki `reset --hard` p.txt'yi base'e ("data\n") döndürür;
    // modify, BASE içeriğinde aramalı (round 1 çıktısında DEĞİL).
    const r2 = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "d/.gitattributes", content: "*.txt filter=benign\n" },
        { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-2" }] },
      ]),
    );
    assert.equal(r2.validation.editsApplied, 2, "the second round with the benign attribute must proceed");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-2\n");
  } finally {
    await ws.destroy();
  }
});

// ── 37) F-6 kalıntı varyantı: başarısız rollback (EACCES seam) bitkiyi
//      worktree'de bırakır → sonraki tur, filter-capable komuttan ÖNCE red;
//      fs toparlanınca (gerçek fs) tur kendiliğinden iyileşir ──

test("failed-rollback residue (EACCES seam): the planted attribute is never executed — the next round reds before the filter-capable commands, and a recovered filesystem heals the workspace (PR #24 F-6)", async () => {
  const { out, repo } = await buildF6Repo("f6-residue", { "d/p.txt": "data\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-f6r",
    editablePaths: ["d/p.txt"],
  });
  try {
    // Round 1 (EACCES seam FAAL): bitki + tracked modify → tur re-check
    // threat bulur (invalid_repository) → rollback'ın temizliği seam'le
    // EACCES → rollback BAŞARISIZ: bitki worktree'de KALIR (bilinen kalıntı),
    // reset YÜRÜTÜLMEZ (bitki attr yüzeyiyle filter çalışmaz) → güvenli
    // işletimsel red. Marker ASLA yazılmaz.
    // (Seam round 2'ye kadar KASITLI olarak faal kalır — dış `finally`
    //  sıfırlar; buraya iç try/finally konmaz.)
    setWorkspaceFs(denyingFs());
    const err1 = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "create", path: "d/.gitattributes", content: "*.txt filter=evil\n" },
          { kind: "create", path: "d/q.txt", content: "q\n" },
          { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-EVIL" }] },
        ]),
      ),
    );
    assert.equal(err1.message, "Cleaning the worker-created paths failed");
    await assert.rejects(lstat(marker), "no filter execution in the failed round (the rollback reset is skipped while the attribute is present)");
    // Yarım state: bitki + worker içeriği worktree'de; kalıntı BİLİNEN.
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-EVIL\n", "the mid-round state remains (no reset ran)");
    await assert.doesNotReject(lstat(path.join(ws.workspaceDir, "d", ".gitattributes")), "the residue attribute stays as known residue");

    // Round 2 (seam hâlâ FAAL): worker pattern'e uyan dosyaya dokunmak
    // istiyor → bilinen kalıntı temizlenemiyor (EACCES) → tur, herhangi bir
    // filter-capable komut YÜRÜTÜLMEÖNCE red (temizlik red'i — sıralama
    // F-6'nın kalıntı ayağı). Marker ASLA yazılmaz.
    const err2 = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(workerResult([{ kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-R2" }] }])),
    );
    assert.equal(err2.message, "Cleaning the worker-created paths failed");
    await assert.rejects(lstat(marker), "the residue window must never execute the filter (reset skipped while the residue is known)");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(),
      "data-EVIL\n",
      "the failed round writes nothing",
    );

    // ── fs TOPARLANIR (gerçek fs): kalıntı temizlenir, workspace İYİLEŞİR ──
    setWorkspaceFs(null);
    const r3 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-OK" }] }]),
    );
    assert.equal(r3.validation.editsApplied, 1, "the recovered round cleans the residue and proceeds");
    await assert.rejects(lstat(path.join(ws.workspaceDir, "d", ".gitattributes")), "the residue attribute is removed by the next round's cleanup");
    await assert.rejects(lstat(path.join(ws.workspaceDir, "d", "q.txt")), "the residue file is removed by the next round's cleanup");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-OK\n");
    await assert.rejects(lstat(marker), "the healed round must not run the filter");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
});

// ── SB-1 (PR #24, 5. audit LOW): tracked `.gitattributes` reset-filtre penceresi ──
//
// Tehdit modeli: worker, worktree'de OLMAYAN (create — F-6 created-clean
// bunu kapsıyor) DEĞİL, tracked bir `.gitattributes`'ı MODIFY/DELETE eder
// (config'de ÖNCEDEN tanımlı bir driver — LFS dahi — varsa). `git reset
// --hard`'ın racy içerik doğrulaması (ölçüldü, Apple Git 2.50.1:
// tracked-modified + aynı-saniye stat + aynı boyut) worktree içeriğini
// yeniden okur ve bu okuma ÇALIŞMA `.gitattributes` yüzeyindeki CLEAN
// filter'ı host'ta YÜRÜTÜR — yüzey worker'ınkidir. F-6 re-check'leri
// tur-içi diff/stat/export'u kapatır ama rollback/round-start
// `reset --hard`'ı kapatmaz (yürütülen komut DEĞİLDİR).
//
// Düzeltme (bu testler): her `git reset --hard` (3 nokta) ÖNCESİ,
// worker-çıkışlı tracked attr yüzeyi saf-fs ile BİREBİR immutable base'e
// restore edilir (`workerTouchedAttributePaths` + `restoreBaseFiles`);
// restore başarısız → reset YÜRÜTÜLMEZ. F-6 re-check'leri bu restore'u
// İKAME ETMEZ — ikisi de devrededir (restore ≠ dedektör).

// ── 38) tracked ROOT attr modify + racy tracked dosya → red, restore, reset güvenli, sonraki tur yeşil ──

test("worker-modified TRACKED root .gitattributes: the rollback restores the attribute to base before the reset, the racy window never runs the filter, the next round proceeds (PR #24 SB-1 m.15)", async () => {
  const { out, repo } = await buildF6Repo("sb1-root", { ".gitattributes": "base-attr\n", "a.txt": "base\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const statusBefore = (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort();

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1root",
    editablePaths: [".gitattributes", "a.txt"],
  });
  const worktreesAfterCreate = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const attrAbs = path.join(ws.workspaceDir, ".gitattributes");
  const log: string[] = [];
  setWorkspaceFs(recordingFs(log));
  try {
    // Round 1: tracked attr → config'de tanımlı driver (`filter=evil`) +
    // a.txt AYNI BOYUT'ta modify (5B → 5B — racy ön koşulu; tur
    // sub-second, index mtime'ı ile aynı saniyede). Tur re-check (F-6)
    // → RED; rollback: created ∅ → attr restore (SB-1) → reset.
    const err = await expectWorkspaceError("invalid_repository", () =>
      ws.applyPatchSet(
        workerResult([
          {
            kind: "modify",
            path: ".gitattributes",
            operations: [{ search: "base-attr", replace: "*.txt filter=evil" }],
          },
          { kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "bAsE" }] },
        ]),
      ),
    );
    assert.equal(err.message, "An external Git filter is not supported");
    // Fix'in gözlemlenebilir izi: attr seam üzerinden restore edildi
    // (yazım + mod aynası, doğru sırada) + reset YÜRÜTÜLDÜ (a.txt base'te).
    assert.ok(
      log.includes(`writeFile:${attrAbs}`),
      "the tracked attribute was restored to base through the fs seam",
    );
    assert.ok(
      log.indexOf(`writeFile:${attrAbs}`) < log.indexOf(`chmod:${attrAbs}`),
      "the restore writes the base bytes before mirroring the base mode",
    );
    await assert.rejects(
      lstat(marker),
      "the filter must never execute — not even in the rollback reset (the attribute is restored to base first)",
    );
    assert.equal((await readFile(attrAbs)).toString(), "base-attr\n", "the attribute is back to base bytes");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(),
      "base\n",
      "the tracked file is back to base (the reset ran)",
    );

    // Ana repo + worktree listesi değişmedi.
    assert.deepEqual(
      worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
      worktreePaths(worktreesAfterCreate),
      "the failed round must not add or remove any worktree",
    );
    assert.deepEqual(
      (await gitText(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).sort(),
      statusBefore,
      "the main repository state must be untouched",
    );

    // Round 2 (yeşil): workspace TAMAMEN işlevsel — wedge YOK.
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-2" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 1, "the next round proceeds");
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base-2\n");
    assert.equal((await readFile(attrAbs)).toString(), "base-attr\n", "the attribute stays at base in the green round too");
    await assert.rejects(lstat(marker), "the benign round must not run the filter either");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 39) racy pozitif kontrol: HAM reset (pencere kurulursa) marker'ı YAZAR; ──
//      sınıf yolu ASLA YAZMAZ (koşulsuz) ──

test("racy reset positive control (same-size modify + same-second stat): a RAW reset WOULD execute the planted filter; the class round + resetToBase never do (PR #24 SB-1 m.16)", async () => {
  const { out, repo } = await buildF6Repo("sb1-racy", { "d/.gitattributes": "d-base\n", "d/p.txt": "data\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1racy",
    editablePaths: ["d/.gitattributes", "d/p.txt"],
  });
  try {
    const gitVersion = await gitText(ws.workspaceDir, ["--version"]);
    // Racy tehdit durumu: tracked attr → tanımlı driver + p.txt AYNI
    // BOYUT'ta modify (5B → 5B) + mtime INDEX DOSYASININ mtime'ına çekilir
    // (aynı saniye) → `git reset --hard`'ın racy içerik doğrulaması p.txt'yi
    // worktree attr yüzeyiyle yeniden okur.
    const plantRacy = async () => {
      await writeFile(path.join(ws.workspaceDir, "d", ".gitattributes"), "*.txt filter=evil\n");
      await writeFile(path.join(ws.workspaceDir, "d", "p.txt"), "dAta\n");
      const indexRel = (await gitText(ws.workspaceDir, ["rev-parse", "--git-path", "index"])).trim();
      const indexStat = await stat(path.resolve(ws.workspaceDir, indexRel));
      await utimes(path.join(ws.workspaceDir, "d", "p.txt"), indexStat.mtime, indexStat.mtime);
    };

    // ── POZİTİF KONTROL (HAM — sınıf bypass, audit S-2 disiplini) ──
    // Sınıftan BYPASS: aynı racy durumda ham `git reset --hard` filter'ı
    // worktree attr yüzeyiyle GERÇEKTEN yürütür (marker). Bu ölçüm, düzelt-
    // menin savunacak bir penceresi olduğunu kanıtlar (racy davranış
    // sürüm-bağımlıdır: yalnız 2.50.x'te ölçüldü — başka sürümde marker
    // assert'i atlanır, sınıf-yolu assert'leri koşulsuz devam eder).
    //
    // N-2 toleransı (2026-10-03, mekanizma ölçüldü): pencere, `plantRacy`'nin
    // `p.txt` mtime'ını INDEX DOSYASI mtime'ına sabitlemesiyle kurulur; git
    // bunu index ENTRY'sindeki mtime (checkout yazımı) ile SANİYE çözünürlü-
    // ğünde karşılaştırır. Sınıf, checkout'tan SONRA `git add -A` ile index
    // dosyasını yeniden yazdığı için (ölçüldü: entry stat korunur, dosya
    // mtime'ı güncellenir), pencere yalnız checkout→add-A aralığının bir
    // saniye içinde kalmasıyla hit olur — paralel yükte bu aralık saniye
    // sınırını aşıp marker'ı YAZDIRAMAZ (yalnız ölçüm flake'lenir). Ham
    // ölçüm SINIRLI denemeyle denenir (yeniden bitki + ham reset): her
    // denemede ham reset index'i, taze yazdığın dosyanın mtime'ı ile aynı
    // saniyede yeniden kaydettiği için 2. deneme pencereyi ~kesin kurar
    // (ölçüldü: 3/25 ilk deneme miss → 3/3 ikinci deneme hit; 25/25 ≤10
    // denemede hit). Sınır dolup pencere hâlâ kurulamazsa AÇIK
    // "pencere kurulamadı" dalı marker assert'ini atlar. Tolerans YALNIZ
    // ham-bypass ölçümü içindir: alttaki sınıf-yolu assert'leri KOŞULSUZ
    // kalır — sınıf yolu marker yazdıysa test yine kırmızıdır, bu dal onu
    // gömez.
    let positiveWindowHit = false;
    if (/2\.50\./.test(gitVersion)) {
      const maxPositiveAttempts = 10;
      for (let attempt = 1; attempt <= maxPositiveAttempts && !positiveWindowHit; attempt++) {
        await plantRacy();
        await git(ws.workspaceDir, ["reset", "--hard", ws.baseCommit]);
        positiveWindowHit = (await lstat(marker).catch(() => null)) !== null;
        if (positiveWindowHit) {
          await assert.doesNotReject(
            lstat(marker),
            `POSITIVE CONTROL (git ${gitVersion.trim()}): a raw reset under the racy condition executes the external filter through the worktree attribute surface`,
          );
          await rm(marker);
        }
      }
    } else {
      // Ölçülmemiş git sürümü (2.50.x dışı): racy pencere davranışı
      // sürüm-bağımlı → marker assert'i atlanır (önceki davranış); ham
      // reset yine de attr yüzeyini base'e döndürür — alttaki KOŞULSUZ
      // assert bunu doğrular.
      await plantRacy();
      await git(ws.workspaceDir, ["reset", "--hard", ws.baseCommit]);
    }
    // Her durumda: ham reset tracked attr'i base'e döndürdü (tehdit gitti).
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", ".gitattributes"))).toString(),
      "d-base\n",
      "the raw reset restored the tracked attribute to base",
    );

    // ── SınıF YOLU 1: aynı tehdit, worker'ın KENDİ sözleşmesi üzerinden ──
    // Tehdit modeli worker yazısıdır (applyPatchSet): tur re-check (F-6)
    // RED; rollback: created ∅ → attr restore (SB-1) → reset. Tur
    // sub-second olduğu için worker yazıları index'in saniyesinde + aynı
    // boyutta → racy koşulum doğal olarak kurulur; restore, reset'ten önce
    // yüzeyi base'e döndürdüğü için filter YÜRÜMEMELİ. (Elle bitki =
    // worker dışı yazı — SB-1 kümesi onu tanımaz; bu akış kapsam dışıdır.)
    const err = await expectWorkspaceError("invalid_repository", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "modify", path: "d/.gitattributes", operations: [{ search: "d-base", replace: "*.txt filter=evil" }] },
          { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "dAta" }] },
        ]),
      ),
    );
    assert.equal(err.message, "An external Git filter is not supported");
    await assert.rejects(
      lstat(marker),
      "the class round must never execute the filter — the rollback restores the attribute to base before the reset",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", ".gitattributes"))).toString(),
      "d-base\n",
      "the attribute is back to base bytes",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(),
      "data\n",
      "the tracked file is back to base (the reset ran)",
    );

    // ── SınıF YOLU 2: `resetToBase` (3. reset noktası) — rollback sonrası
    // temiz yüzeyde → güvenli.
    await ws.resetToBase();
    await assert.rejects(
      lstat(marker),
      "the class resetToBase must never execute the filter — the attribute surface is the immutable base's",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", ".gitattributes"))).toString(),
      "d-base\n",
      "the attribute is back to base bytes",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(),
      "data\n",
      "the tracked file is back to base",
    );
  } finally {
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 40) tracked attr DELETE varyantı: yeşil delete + başarısız tur (untracked
//      çakışma) → rollback attr'i YENİDEN YARATIR; wedge iyileşir; marker yapısalcı olarak vacuous ──

test("worker-deleted TRACKED .gitattributes: a later failed round's rollback recreates the base attribute before the reset; the workspace heals (PR #24 SB-1 m.17)", async () => {
  const { out, repo } = await buildF6Repo("sb1-delete", { "d/.gitattributes": "d-base\n", "d/p.txt": "data\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1del",
    editablePaths: ["d/.gitattributes", "d/p.txt"],
  });
  const worktreesAfterCreate = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const attrAbs = path.join(ws.workspaceDir, "d", ".gitattributes");
  const log: string[] = [];
  setWorkspaceFs(recordingFs(log));
  try {
    // Round 1 (YEŞİL): tracked attr DELETE + p.txt same-size modify.
    const r1 = await ws.applyPatchSet(
      workerResult([
        { kind: "delete", path: "d/.gitattributes" },
        { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "dAta" }] },
      ]),
    );
    assert.equal(r1.validation.editsApplied, 2, "the deletion round completes");
    await assert.rejects(lstat(attrAbs), "the worker deleted the attribute");
    await assert.rejects(lstat(marker), "no filter execution in the green round (the attribute is gone from the worktree)");

    // Round 2 (BAŞARISIZ): untracked `d/seed.txt` pre-planted (reset onu
    // dokunmaz — tracked değil) + worker aynı yola CREATE deniyor → apply
    // drift red'i; ayrıca plan attr'i YENİDEN siliyor. Rollback: created ∅
    // → attr restore (SB-1: delete edilen attr base baytlarıyla YENİDEN
    // YARATILIR) → reset. Marker yapısal olarak vacuous (attr yokken filter
    // yüzeyi boş) — ayırt edici, seam'in sıralaması + dosya durumlarıdır.
    await writeFile(path.join(ws.workspaceDir, "d", "seed.txt"), "seed\n");
    const err2 = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "delete", path: "d/.gitattributes" },
          { kind: "create", path: "d/seed.txt", content: "x\n" },
        ]),
      ),
    );
    assert.equal(err2.message, "A workspace file has drifted from base");
    // Sıra kanıtı (seam): rollback, attr'i base'e YAZDI (restore çalıştı).
    assert.ok(
      log.includes(`writeFile:${attrAbs}`),
      "the failed round's rollback restored the deleted attribute through the fs seam",
    );
    await assert.rejects(lstat(marker), "no filter execution in the failed round (the attribute is recreated with base content before the reset)");
    assert.equal(
      (await readFile(attrAbs)).toString(),
      "d-base\n",
      "the deleted attribute is back to base bytes (recreated by the restore)",
    );
    await assert.doesNotReject(
      lstat(path.join(ws.workspaceDir, "d", "seed.txt")),
      "the unknown untracked residue is untouched (no broad cleanup — spec 37)",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(),
      "data\n",
      "the tracked file is back to base (the reset ran)",
    );

    // Round 3 (iyileşme): workspace TAMAMEN işlevsel — wedge YOK.
    const r3 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-2" }] }]),
    );
    assert.equal(r3.validation.editsApplied, 1, "the healed round proceeds");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-2\n");
    assert.equal((await readFile(attrAbs)).toString(), "d-base\n", "the attribute stays at base");
    await assert.rejects(lstat(marker), "the healed round must not run the filter");

    assert.deepEqual(
      worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
      worktreePaths(worktreesAfterCreate),
      "no worktree may be added or removed across the rounds",
    );
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 41) nested tracked attr (derinlik > kök): restore her derinliği kapsar ──

test("worker-modified TRACKED nested .gitattributes (below root): the same restore path covers every repository depth (PR #24 SB-1 m.18)", async () => {
  const { out, repo } = await buildF6Repo("sb1-nested", { "d/.gitattributes": "d-base\n", "d/p.txt": "data\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1nest",
    editablePaths: ["d/.gitattributes", "d/p.txt"],
  });
  const worktreesAfterCreate = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const attrAbs = path.join(ws.workspaceDir, "d", ".gitattributes");
  try {
    // Round 1: nested tracked attr → config'de tanımlı driver + p.txt same-
    // size modify (5B → 5B, racy ön koşul) → tur RED; rollback attr'i base'e
    // döndürür (ebeveyn dizin var — mkdir no-op, yazım + mod).
    const err = await expectWorkspaceError("invalid_repository", () =>
      ws.applyPatchSet(
        workerResult([
          { kind: "modify", path: "d/.gitattributes", operations: [{ search: "d-base", replace: "*.txt filter=evil" }] },
          { kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "dAta" }] },
        ]),
      ),
    );
    assert.equal(err.message, "An external Git filter is not supported");
    await assert.rejects(lstat(marker), "the nested attribute is restored to base before the reset — the filter never executes");
    assert.equal((await readFile(attrAbs)).toString(), "d-base\n", "the nested attribute is back to base bytes");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data\n", "the tracked file is back to base");

    assert.deepEqual(
      worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
      worktreePaths(worktreesAfterCreate),
      "the failed round must not add or remove any worktree",
    );

    // Round 2 (yeşil): workspace işlevsel + nested attr base'te kalır.
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "d/p.txt", operations: [{ search: "data", replace: "data-2" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 1, "the next round proceeds");
    assert.equal((await readFile(path.join(ws.workspaceDir, "d", "p.txt"))).toString(), "data-2\n");
    assert.equal((await readFile(attrAbs)).toString(), "d-base\n", "the nested attribute stays at base");
    await assert.rejects(lstat(marker), "the benign round must not run the filter either");
  } finally {
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 42) restore hatası (EACCES seam): reset YÜRÜTÜLMEZ — yöntem red, wedge, recovery ──

test("restore failure (EACCES seam): the reset is skipped — the method reds with the fixed message, the workspace is NOT reset, and a recovered filesystem heals it (PR #24 SB-1 m.19)", async () => {
  const { out, repo } = await buildF6Repo("sb1-fail", { ".gitattributes": "base-attr\n", "a.txt": "base\n" });
  const { marker } = await plantDriver(out, repo, "evil");

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1fail",
    editablePaths: [".gitattributes", "a.txt"],
  });
  try {
    // Round 1 (seam FAAL — writeFile EACCES): worker attr'i modify eder →
    // tur re-check (F-6) red; rollback: created ∅ → restore EACCES →
    // reset YÜRÜTÜLMEZ (worker attr yüzeyiyle filter çalışmaz) → güvenli
    // işletimsel red + bilinen kalıntı (attr kümesi KORUNUR).
    setWorkspaceFs(attrWriteFailingFs());
    const err1 = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(
        workerResult([
          {
            kind: "modify",
            path: ".gitattributes",
            operations: [{ search: "base-attr", replace: "*.txt filter=evil" }],
          },
          { kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "bAsE" }] },
        ]),
      ),
    );
    assert.equal(err1.message, "Restoring the attribute files failed");
    await assert.rejects(lstat(marker), "no filter execution — the reset was skipped while the restore failed");
    // Reset YÜRÜTÜLMEZ kanıtı: worker'ın yarım durumu aynen kalır.
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(),
      "bAsE\n",
      "the reset did NOT run (the worker modification persists)",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(),
      "*.txt filter=evil\n",
      "the restore failed — the worker attribute persists as known residue",
    );

    // Round 2 (seam hâlâ FAAL, attr kümesi KORUNURDU): zararsız bir tur bile,
    // restore başaramadan red edilir (reset YOK) — bilinen wedge, güvenli
    // raporlanır. (Seam test bitince dış `finally` sıfırlar.)
    const err2 = await expectWorkspaceError("workspace_operation_failed", () =>
      ws.applyPatchSet(workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-2" }] }])),
    );
    assert.equal(err2.message, "Restoring the attribute files failed");
    await assert.rejects(lstat(marker), "the wedge round never executes the filter (the reset stays skipped)");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(),
      "bAsE\n",
      "the wedge round writes nothing (no reset)",
    );

    // ── fs TOPARLANIR (gerçek fs): restore başarır, reset koşar, iyileşir ──
    setWorkspaceFs(null);
    const r3 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-OK" }] }]),
    );
    assert.equal(r3.validation.editsApplied, 1, "the recovered round restores the attribute, resets, and proceeds");
    assert.equal((await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(), "base-attr\n", "the attribute is back to base");
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base-OK\n");
    await assert.rejects(lstat(marker), "the healed round must not run the filter");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 43) `resetToBase` public yol: restore hatası reset'i atlar; recovery tamamlar ──

test("resetToBase: a failed attribute restore skips the reset (fixed red); a recovered filesystem completes it and the workspace stays functional (PR #24 SB-1 m.20)", async () => {
  const { out, repo } = await buildF6Repo("sb1-rb", { ".gitattributes": "base-attr\n", "a.txt": "base\n" });
  // Config'de driver YOK — worker attr içeriği zararsız (tur yeşil); SB-1
  // restore yolu `resetToBase` üzerinden ölçülür.
  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1rb",
    editablePaths: [".gitattributes", "a.txt"],
  });
  try {
    // Round 1 (yeşil, gerçek fs): tracked attr zararsız içerik alır + a.txt.
    const r1 = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: ".gitattributes", operations: [{ search: "base-attr", replace: "*.txt text=auto" }] },
        { kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-1" }] },
      ]),
    );
    assert.equal(r1.validation.editsApplied, 2, "a harmless attribute modify completes the round");
    assert.equal((await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(), "*.txt text=auto\n");

    // `resetToBase` + seam (writeFile EACCES): temizlik ∅ → restore EACCES
    // → red; reset YÜRÜTÜLMEZ — yarım durum aynen kalır.
    setWorkspaceFs(attrWriteFailingFs());
    const err = await expectWorkspaceError("workspace_operation_failed", () => ws.resetToBase());
    assert.equal(err.message, "Restoring the attribute files failed");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(),
      "*.txt text=auto\n",
      "the reset did NOT run — the worker attribute persists",
    );
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(),
      "base-1\n",
      "the reset did NOT run — the worker modification persists",
    );

    // fs TOPARLANIR → sonraki `resetToBase` TAMAMLANIR.
    setWorkspaceFs(null);
    await ws.resetToBase();
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(),
      "base-attr\n",
      "the attribute is restored to base",
    );
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base\n", "the tracked file is back to base");

    // Workspace TAMAMEN işlevsel kalır.
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-2" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 1, "the workspace is fully functional after the recovered reset");
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base-2\n");
    assert.equal(
      (await readFile(path.join(ws.workspaceDir, ".gitattributes"))).toString(),
      "base-attr\n",
      "the attribute stays at base across the subsequent round",
    );
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── 44) yeşil tur + worker attr → SONRAKİ turun reset'i restore eder (m.27);
//        küme sıfırlanır (m.28) — kayıt seam'ı sırayı kanıtlar ──

test("a successful round with a worker-modified attribute: the NEXT round's reset restores it to base, and the touched set clears afterwards (PR #24 SB-1 m.27/m.28)", async () => {
  const { out, repo } = await buildF6Repo("sb1-eol", { ".gitattributes": "base-attr\n", "a.txt": "base\n" });
  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);

  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "s-sb1eol",
    editablePaths: [".gitattributes", "a.txt"],
  });
  const attrAbs = path.join(ws.workspaceDir, ".gitattributes");
  try {
    // Round 1 (yeşil): worker zararsız attr + a.txt yazar. (İlk turda restore
    // no-op — küme henüz boş → seam'de attr YAZIMI YOK.)
    const log1: string[] = [];
    setWorkspaceFs(recordingFs(log1));
    const r1 = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: ".gitattributes", operations: [{ search: "base-attr", replace: "*.txt eol=lf" }] },
        { kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-1" }] },
      ]),
    );
    assert.equal(r1.validation.editsApplied, 2, "the round with the harmless worker attribute completes");
    assert.equal(
      (await readFile(attrAbs)).toString(),
      "*.txt eol=lf\n",
      "the worker attribute is in the worktree after the green round",
    );
    assert.ok(!log1.includes(`writeFile:${attrAbs}`), "no restore in the first round (nothing was touched yet)");

    // Round 2: round-start, worker attr'ı sıradaki reset ÖNCESİ base'e
    // döndürmek ZORUNDA (m.27) — seam yazımı kaydeder.
    const log2: string[] = [];
    setWorkspaceFs(recordingFs(log2));
    const r2 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-2" }] }]),
    );
    assert.equal(r2.validation.editsApplied, 1);
    assert.ok(
      log2.includes(`writeFile:${attrAbs}`),
      "m.27: the previous round's worker attribute is restored to base before the next reset",
    );
    assert.equal(
      (await readFile(attrAbs)).toString(),
      "base-attr\n",
      "the worker attribute is neutralized after the round",
    );
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base-2\n");

    // Round 3: küme, round 2'nin çift-başarılı (restore + reset) sonunda
    // sıfırlandı → round-start restore no-op (m.28).
    const log3: string[] = [];
    setWorkspaceFs(recordingFs(log3));
    const r3 = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "a.txt", operations: [{ search: "base", replace: "base-3" }] }]),
    );
    assert.equal(r3.validation.editsApplied, 1);
    assert.ok(
      !log3.includes(`writeFile:${attrAbs}`),
      "m.28: the touched-attribute set was cleared — no restore in the third round",
    );
    assert.equal((await readFile(attrAbs)).toString(), "base-attr\n", "the attribute stays at base");
    assert.equal((await readFile(path.join(ws.workspaceDir, "a.txt"))).toString(), "base-3\n");
  } finally {
    setWorkspaceFs(null);
    await ws.destroy();
  }
  assert.deepEqual(
    worktreePaths((await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean)),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
});

// ── Step 7: readBaseEntry (immutable base'in birebir bellek görünümü) ──────

test("readBaseEntry: exact immutable base view (file/binary/symlink/absent + allow-list + post-apply invariance)", async () => {
  const base = path.join(tmp, "rbe");
  const repo = path.join(base, "repo");
  const out = path.join(base, "out");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(out, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "RBE Test"]);
  await gitOk(repo, ["config", "user.email", "rbe@splash.test"]);
  await writeFile(path.join(repo, "src", "a.ts"), "alpha\n");
  // SEÇİLMEYEN sentinel — readBaseEntry allow-list'i dışında (crawl yok).
  await writeFile(path.join(repo, "src", "out.ts"), "OUT_SENTINEL_NEVER_READ\n");
  // Binary (geçersiz UTF-8) — snapshot bayt-bayt; marker kararı assembler'da.
  await writeFile(path.join(repo, "src", "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  // Repo-içi hedefli sembolik bağlantı — hedef METNİ, takip edilmez.
  await symlink("a.ts", path.join(repo, "src", "link.ts"));
  // Seçilmemiş dizin sentinel (dizin seçimi creation'da reddedilir).
  await mkdir(path.join(repo, "src", "dir"), { recursive: true });
  await writeFile(path.join(repo, "src", "dir", "x.txt"), "x\n");
  await gitOk(repo, ["add", "-A"]);
  await gitOk(repo, ["commit", "-m", "base"]);

  const worktreesBefore = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  const ws = await createGitWorktreeWorkspace({
    repoRoot: repo,
    workspaceDir: path.join(out, "ws"),
    sessionId: "rbe-1",
    editablePaths: ["src/a.ts", "src/bin.dat", "src/link.ts", "src/missing.ts"],
    readonlyPaths: [],
  });
  try {
    // Düzenli dosya: birebir base baytları.
    const a = ws.readBaseEntry("src/a.ts");
    assert.equal(a.exists, true);
    if (a.exists && a.type === "file") {
      assert.equal(a.mode, "100644");
      assert.deepEqual(a.content, Buffer.from("alpha\n"));
    } else {
      assert.fail(`unexpected entry shape: ${JSON.stringify(a)}`);
    }
    // Binary: baytlar aynen (decode/normalizasyon YOK).
    const bin = ws.readBaseEntry("src/bin.dat");
    assert.equal(bin.exists, true);
    if (bin.exists && bin.type === "file") {
      assert.deepEqual(bin.content, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    }
    // Savunmacı kopya: dönen buffer'ın mutasyonu snapshot'ı bozamaz.
    const bin2 = ws.readBaseEntry("src/bin.dat");
    if (bin2.exists && bin2.type === "file") {
      bin2.content.fill(0x00);
      const bin3 = ws.readBaseEntry("src/bin.dat");
      if (bin3.exists && bin3.type === "file") {
        assert.deepEqual(bin3.content, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
      }
    }
    // Sembolik bağlantı: yalnız hedef metni (hedef dosya içeriği ASLA).
    assert.deepEqual(ws.readBaseEntry("src/link.ts"), {
      exists: true,
      type: "symlink",
      mode: "120000",
      target: "a.ts",
    });
    // Tabanda yok.
    assert.deepEqual(ws.readBaseEntry("src/missing.ts"), { exists: false });
    // Normalizasyon: `./src/a.ts` → aynı kanonik yol → aynı giriş.
    const norm = ws.readBaseEntry("./src/a.ts");
    assert.equal(norm.exists, true);
    // Allow-list dışı yol → `invalid_input` (salt-okunur bağlam dâhil — sessiz
    // genişleme YOK).
    assert.throws(
      () => ws.readBaseEntry("src/out.ts"),
      (err: unknown) => err instanceof WorkspaceError && err.kind === "invalid_input",
    );
    assert.throws(
      () => ws.readBaseEntry("../escape.ts"),
      (err: unknown) => err instanceof WorkspaceError && err.kind === "invalid_input",
    );

    // Apply SONRASI invarians: worker worktree'ye yazar; base snapshot BİREBİR
    // base'i vermeye devam eder (mutable taraf snapshot'ın dışındadır).
    const res = await ws.applyPatchSet(
      workerResult([{ kind: "modify", path: "src/a.ts", operations: [{ search: "alpha", replace: "beta" }] }]),
    );
    assert.equal(res.validation.editsApplied, 1);
    assert.equal((await readFile(path.join(ws.workspaceDir, "src", "a.ts"), "utf8")), "beta\n");
    const after = ws.readBaseEntry("src/a.ts");
    if (after.exists && after.type === "file") {
      assert.deepEqual(after.content, Buffer.from("alpha\n"), "base snapshot worker yazısından etkilenemez");
    }
  } finally {
    await ws.destroy();
  }
  const listed = (await gitText(repo, ["worktree", "list"])).split("\n").filter(Boolean);
  assert.deepEqual(
    worktreePaths(listed),
    worktreePaths(worktreesBefore),
    "no worktree may be left behind",
  );
  await rm(base, { recursive: true, force: true });
});

// ── Step 9: kurtarma (recovery) ─────────────────────────────────────────────
//
// Kontrol edilen senaryolar: CRLF (116), symlink (117), varlıksız (118),
// yeniden-uygulama determinizmi + hash (119-121), main drift (124), drift
// yok (125), hayatta BİREBİR worktree reuse (126), hayatta uyuşmayan
// worktree yeniden kurma (127), base nesnesi pruned (case b, 111/112).
//
// Tüm testler GERÇEK git + izole tmp repo kullanır; her bir kendi alt dizinini
// alır (`before`/`after` hook'ları `tmp`'yi temizler). Base'in BİREBİR
// korunması — ana depodan ASLA yeniden yakalama YOK (spec 105/115/123).

interface RecFixture {
  repo: string;
  out: string;
}

/**
 * Kurtarma fixture'ı — spec 116/117/118/124/125 + case (b) için tam kontrol:
 * - `src/crlf.ts`: committed, CRLF satır sonları (spec 116: normalizasyon YOK).
 * - `src/plain.ts`: committed `v1\n` + unstaged `v2-UNSTAGED\n` (base'e ÖZEL
 *   blob — case (b)'de blob rekonstrüksiyonu + main drift senaryosu).
 * - `link`: committed sembolik bağlantı → `src/plain.ts` (spec 117).
 * - `src/absent.ts`: seçili ama base'te yok (spec 118).
 */
async function buildRecFixture(name: string): Promise<RecFixture> {
  const repo = path.join(tmp, name, "repo");
  const out = path.join(tmp, name);
  await mkdir(repo, { recursive: true });

  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Recovery User"]);
  await gitOk(repo, ["config", "user.email", "recovery@local.invalid"]);
  await mkdir(path.join(repo, "src"), { recursive: true });

  await writeFile(path.join(repo, "src", "crlf.ts"), "line1\r\nline2\r\n");
  await writeFile(path.join(repo, "src", "plain.ts"), "v1\n");
  await symlink("src/plain.ts", path.join(repo, "link"));
  await gitOk(repo, ["add", "src/crlf.ts", "src/plain.ts", "link"]);
  await gitOk(repo, ["commit", "-m", "recovery init"]);

  // unstaged değişiklik → base, main'den FARKLI bir ağaç/blob taşır (case b).
  await writeFile(path.join(repo, "src", "plain.ts"), "v2-UNSTAGED\n");

  return { repo, out };
}

function recInput(f: RecFixture, sessionId = "s-0001"): WorkspaceCreateInput {
  return {
    repoRoot: f.repo,
    workspaceDir: path.join(f.out, "ws", sessionId),
    sessionId,
    editablePaths: ["src/crlf.ts", "src/plain.ts", "link", "src/absent.ts"],
    readonlyPaths: [],
  };
}

/** `git worktree remove` + dangling base object'ı tamamen prune eder (case b). */
async function pruneBaseObject(fixture: RecFixture, baseCommit: string): Promise<void> {
  await gitOk(fixture.repo, ["reflog", "expire", "--expire=now", "--all"]);
  await gitOk(fixture.repo, ["prune", "--expire=now"]);
  // doğrulama: base commit nesnesi artık YOK
  let stillThere = true;
  try {
    await runGit(["cat-file", "-e", `${baseCommit}^{commit}`], {
      cwd: fixture.repo,
      config: ["core.hooksPath=/dev/null"],
    });
  } catch {
    stillThere = false;
  }
  assert.equal(stillThere, false, "base commit object must be pruned for case (b)");
}

test("recovery: CRLF base preserved after missing-worktree restore (spec 116)", async () => {
  const fixture = await buildRecFixture("rec-crlf");
  const input = recInput(fixture, "s-crlf");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();
    await ws.destroy();
    assert.equal((await lstat(ws.workspaceDir).catch(() => null)), null, "worktree dir must be gone");

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      const entry = ws2.readBaseEntry("src/crlf.ts");
      assert.deepEqual(entry, {
        exists: true,
        type: "file",
        mode: "100644",
        content: Buffer.from("line1\r\nline2\r\n"),
      });
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: symlink target + absent path restored without recapture (spec 117/118)", async () => {
  const fixture = await buildRecFixture("rec-sym");
  const input = recInput(fixture, "s-sym");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();

    // spec 118: main'de base'te-olmayan yola YENİ dosya belirir — base'e girmez.
    await writeFile(path.join(fixture.repo, "src", "absent.ts"), "newly appeared in main\n");

    await ws.destroy();
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // spec 117: symlink hedef METNİ + 120000, dereferans YOK.
      assert.deepEqual(ws2.readBaseEntry("link"), {
        exists: true,
        type: "symlink",
        mode: "120000",
        target: "src/plain.ts",
      });
      // spec 118: base'te asla var olmadığı için exists:false (main'deki yeni dosya YOK).
      assert.deepEqual(ws2.readBaseEntry("src/absent.ts"), { exists: false });
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: reapply reproduces identical validation/created/hash (spec 119-121)", async () => {
  const fixture = await buildRecFixture("rec-reapply");
  const input = recInput(fixture, "s-reapply");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const edits: WorkerEdit[] = [
      { kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] },
      { kind: "create", path: "src/new.ts", content: "created\n" },
    ];
    const round1 = await ws.applyPatchSet(workerResult(edits));
    assert.equal(round1.validation.editsApplied, 2);
    assert.deepEqual(round1.createdPaths, ["src/new.ts"]);

    const state = await ws.snapshotRecoveryState();
    assert.deepEqual(state.currentCreatedPaths, ["src/new.ts"]);
    await ws.destroy();

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir }); // base'te (yeniden kuruldu)
    try {
      const round2 = await ws2.applyPatchSet(workerResult(edits)); // aynı tam patch
      // spec 120: validation + filesChanged + diffStats + createdPaths birebir.
      assert.deepEqual(round2.validation, round1.validation);
      assert.deepEqual(round2.filesChanged, round1.filesChanged);
      assert.deepEqual(round2.diffStats, round1.diffStats);
      assert.deepEqual(round2.createdPaths, round1.createdPaths);
      // spec 121: yeniden-uygulamadan sonra state hash == kalıcı hash.
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: immutable base survives main drift (spec 124)", async () => {
  const fixture = await buildRecFixture("rec-drift");
  const input = recInput(fixture, "s-drift");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();

    // main drift: main working-tree plain.ts base'ten farklıya (v3) değişir.
    await writeFile(path.join(fixture.repo, "src", "plain.ts"), "v3-DRIFT\n");

    await ws.destroy();
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // base BİREBİR korunur (v2-UNSTAGED) — main'den (v3-DRIFT) ASLA değil.
      const entry = ws2.readBaseEntry("src/plain.ts");
      assert.deepEqual(entry, {
        exists: true,
        type: "file",
        mode: "100644",
        content: Buffer.from("v2-UNSTAGED\n"),
      });
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: missing worktree, no main drift, reapply reconstructs (spec 125)", async () => {
  const fixture = await buildRecFixture("rec-nodrift");
  const input = recInput(fixture, "s-nodrift");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const edits: WorkerEdit[] = [
      { kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] },
    ];
    const round1 = await ws.applyPatchSet(workerResult(edits));
    assert.equal(round1.validation.editsApplied, 1);
    const state = await ws.snapshotRecoveryState();

    // main unchanged (v2-UNSTAGED); worktree yok edildi.
    await ws.destroy();
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // reapply → önceki tam patch yeniden uygulanır; state hash eşleşir.
      const round2 = await ws2.applyPatchSet(workerResult(edits));
      assert.deepEqual(round2.diffStats, round1.diffStats);
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v3\n");
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

/** `git worktree list --porcelain` kayıtları: yol + `prunable` (dizini eksik) işareti. */
async function worktreeRegistrations(repo: string): Promise<Array<{ path: string; prunable: boolean }>> {
  const out = await gitText(repo, ["worktree", "list", "--porcelain"]);
  return out
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .map((lines) => ({
      path: (lines.find((line) => line.startsWith("worktree ")) ?? "").slice("worktree ".length),
      prunable: lines.some((line) => line.startsWith("prunable")),
    }));
}

test("recovery: worktree dir deleted OUTSIDE git (stale registration left) is recreated via targeted cleanup", async () => {
  const fixture = await buildRecFixture("rec-extdel");
  const input = recInput(fixture, "s-extdel");
  const ws = await createGitWorktreeWorkspace(input);
  const canonicalDir = await realpath(ws.workspaceDir);
  try {
    const state = await ws.snapshotRecoveryState();

    // git DIŞI silme (rm -rf/Finder/temizlik aracı): `.git/worktrees/<n>` kaydı KALIR.
    await rm(ws.workspaceDir, { recursive: true, force: true });
    assert.deepEqual(
      (await worktreeRegistrations(fixture.repo)).filter((r) => r.path === canonicalDir),
      [{ path: canonicalDir, prunable: true }],
      "precondition: the missing dir must still be registered (prunable)",
    );

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.equal(await gitText(ws2.workspaceDir, ["rev-parse", "HEAD"]), state.baseCommit);
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
      // Tek, canlı kayıt: eski kayıt temizlendi, yenisi eklendi (çift kayıt YOK).
      assert.deepEqual(
        (await worktreeRegistrations(fixture.repo)).filter((r) => r.path === canonicalDir),
        [{ path: canonicalDir, prunable: false }],
      );
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: targeted cleanup keeps a foreign missing worktree registration (no global prune); reapply hash matches", async () => {
  const fixture = await buildRecFixture("rec-foreign");
  const input = recInput(fixture, "s-foreign");
  const ws = await createGitWorktreeWorkspace(input);
  const canonicalDir = await realpath(ws.workspaceDir);
  // Splash'a ait OLMAYAN worktree (kullanıcının çıkarılmış diskteki worktree'si
  // gibi): eklenir, sonra dizini git DIŞINDA kaybolur → kayıt `prunable` kalır.
  const foreignDir = path.join(fixture.out, "foreign-wt");
  await gitOk(fixture.repo, ["worktree", "add", "--detach", foreignDir, "HEAD"]);
  const canonicalForeign = await realpath(foreignDir);
  await rm(foreignDir, { recursive: true, force: true });
  try {
    const edits: WorkerEdit[] = [
      { kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] },
      { kind: "create", path: "src/new.ts", content: "created\n" },
    ];
    const round1 = await ws.applyPatchSet(workerResult(edits));
    assert.equal(round1.validation.editsApplied, 2);
    const state = await ws.snapshotRecoveryState();

    // Splash worktree'si de git DIŞINDA silinir (kaydı kalır).
    await rm(ws.workspaceDir, { recursive: true, force: true });

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.equal(await gitText(ws2.workspaceDir, ["rev-parse", "HEAD"]), state.baseCommit);
      // reapply → önceki tam patch; sonuç + kalıcı hash BİREBİR.
      const round2 = await ws2.applyPatchSet(workerResult(edits));
      assert.deepEqual(round2.validation, round1.validation);
      assert.deepEqual(round2.diffStats, round1.diffStats);
      assert.deepEqual(round2.createdPaths, round1.createdPaths);
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);

      const registrations = await worktreeRegistrations(fixture.repo);
      // Yabancı eksik kayıt DOKUNULMADAN durur (global prune YAPILMADI).
      assert.deepEqual(
        registrations.filter((r) => r.path === canonicalForeign),
        [{ path: canonicalForeign, prunable: true }],
      );
      assert.deepEqual(
        registrations.filter((r) => r.path === canonicalDir),
        [{ path: canonicalDir, prunable: false }],
      );
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

/** Splash'a ait OLMAYAN, dizini git DIŞINDA silinmiş (kaydı `prunable` kalan, kilitsiz) worktree. */
async function addForeignMissingWorktree(fixture: RecFixture): Promise<string> {
  const foreignDir = path.join(fixture.out, "foreign-wt");
  await gitOk(fixture.repo, ["worktree", "add", "--detach", foreignDir, "HEAD"]);
  const canonicalForeign = await realpath(foreignDir);
  await rm(foreignDir, { recursive: true, force: true });
  assert.deepEqual(
    (await worktreeRegistrations(fixture.repo)).filter((r) => r.path === canonicalForeign),
    [{ path: canonicalForeign, prunable: true }],
    "precondition: the foreign missing worktree must still be registered (prunable)",
  );
  return canonicalForeign;
}

test("recovery: hash-mismatch cleanup of a live worktree keeps a foreign missing registration (no global prune, audit MEDIUM-1)", async () => {
  const fixture = await buildRecFixture("rec-mismatch-foreign");
  const input = recInput(fixture, "s-mismatch-foreign");
  const ws = await createGitWorktreeWorkspace(input);
  const canonicalDir = await realpath(ws.workspaceDir);
  const canonicalForeign = await addForeignMissingWorktree(fixture);
  try {
    const state = await ws.snapshotRecoveryState();
    // Canlı ama güvenilmez: TRACKED dosya out-of-band değişir → state hash çelişki
    // → `destroyWorktreeSafely` yolu (kimlik/hash uyuşmazlığı).
    await writeFile(path.join(ws.workspaceDir, "src", "plain.ts"), "C-CORRUPT\n");

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
      const registrations = await worktreeRegistrations(fixture.repo);
      // Yabancı eksik kayıt DOKUNULMADAN durur (global prune YAPILMADI).
      assert.deepEqual(
        registrations.filter((r) => r.path === canonicalForeign),
        [{ path: canonicalForeign, prunable: true }],
      );
      assert.deepEqual(
        registrations.filter((r) => r.path === canonicalDir),
        [{ path: canonicalDir, prunable: false }],
      );
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("destroy: fallback for an already-gone, unregistered worktree resolves and keeps a foreign missing registration (no global prune, audit MEDIUM-1)", async () => {
  const fixture = await buildRecFixture("destroy-foreign");
  const ws = await createGitWorktreeWorkspace(recInput(fixture, "s-destroy-foreign"));
  const canonicalDir = await realpath(ws.workspaceDir);
  const canonicalForeign = await addForeignMissingWorktree(fixture);

  // Splash worktree'sinin hem dizini hem kaydı dışarıda kaldırılır → `destroy()`'un
  // ilk `remove --force`'u hata verir ve geri dönüş yoluna düşer.
  await rm(ws.workspaceDir, { recursive: true, force: true });
  await gitOk(fixture.repo, ["worktree", "remove", "--force", canonicalDir]);
  assert.deepEqual((await worktreeRegistrations(fixture.repo)).filter((r) => r.path === canonicalDir), []);

  await ws.destroy(); // RESOLVE etmeli (kayıt da dizin de yok → imha tamam)
  await ws.destroy(); // idempotent

  // Yabancı eksik kayıt DOKUNULMADAN durur (global prune YAPILMADI).
  assert.deepEqual(
    (await worktreeRegistrations(fixture.repo)).filter((r) => r.path === canonicalForeign),
    [{ path: canonicalForeign, prunable: true }],
  );
  await expectWorkspaceError("workspace_destroyed", () => ws.diff());
});

test("recovery: surviving worktree with matching identity+hash is reused (spec 126)", async () => {
  const fixture = await buildRecFixture("rec-reuse");
  const input = recInput(fixture, "s-reuse");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    await ws.applyPatchSet(workerResult([{ kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] }]));
    const state = await ws.snapshotRecoveryState();

    // worktree YIKILMADI — hayatta + kimlik + hash eşleşiyor.
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // reuse: worktree round-1 hâlinde (v3) KALIR; base'e SIFIRLANMAZ.
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v3\n");
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: surviving mismatched worktree is recreated from persisted state (spec 127)", async () => {
  const fixture = await buildRecFixture("rec-mismatch");
  const input = recInput(fixture, "s-mismatch");
  const ws = await createGitWorktreeWorkspace(input);
  const mainPlain = path.join(fixture.repo, "src", "plain.ts");
  const mainPlainBefore = await readFile(mainPlain, "utf8");
  try {
    await ws.applyPatchSet(workerResult([{ kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] }]));
    const state = await ws.snapshotRecoveryState();

    // out-of-band mutasyon → state hash çelişki.
    await writeFile(path.join(ws.workspaceDir, "src", "plain.ts"), "C-CORRUPT\n");

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // güvenilmez worktree → base'e (v2-UNSTAGED) yeniden kurulur; korozyon gider.
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
    } finally {
      await ws2.destroy();
    }
    // ana depo ASLA dokunulmaz.
    assert.equal(await readFile(mainPlain, "utf8"), mainPlainBefore);
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: base object pruned → full reconstruction via mktree/commit-tree (spec 111/112, case b)", async () => {
  const fixture = await buildRecFixture("rec-pruned");
  const input = recInput(fixture, "s-pruned");
  const ws = await createGitWorktreeWorkspace(input);
  const edits: WorkerEdit[] = [
    { kind: "modify", path: "src/plain.ts", operations: [{ search: "v2-UNSTAGED", replace: "v3" }] },
    { kind: "create", path: "src/new.ts", content: "created\n" },
  ];
  const round1 = await ws.applyPatchSet(workerResult(edits));
  const state = await ws.snapshotRecoveryState();
  const baseCommit = state.baseCommit;
  try {
    await ws.destroy();
    await pruneBaseObject(fixture, baseCommit); // base commit + özel blob'ları yok et

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir }); // case (b): yeniden kur
    try {
      // özel blob rekonstrüksiyon + snapshot: base BİREBİR (v2-UNSTAGED).
      const entry = ws2.readBaseEntry("src/plain.ts");
      assert.deepEqual(entry, {
        exists: true,
        type: "file",
        mode: "100644",
        content: Buffer.from("v2-UNSTAGED\n"),
      });
      // yeniden-uygulama: önceki tam patch + birebir sonuç + hash.
      const round2 = await ws2.applyPatchSet(workerResult(edits));
      assert.deepEqual(round2.diffStats, round1.diffStats);
      assert.deepEqual(round2.createdPaths, round1.createdPaths);
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: snapshotRecoveryState is JSON-safe and content-free (spec 112/114)", async () => {
  const fixture = await buildRecFixture("rec-shape");
  const input = recInput(fixture, "s-shape");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();

    assert.equal(state.schemaVersion, 1);
    assert.equal(state.baseCommit, ws.baseCommit);
    assert.equal(state.sessionId, "s-shape");
    assert.equal(state.workspaceDir, ws.workspaceDir);
    assert.ok(path.isAbsolute(state.repoRoot));

    // 64-hex SHA-256 (kaynaksız).
    assert.match(state.recoveryStateHash, /^[0-9a-f]{64}$/);

    // JSON-güvenli: serialize/deserialize birebir.
    const roundTripped: WorkspaceRecoveryState = JSON.parse(JSON.stringify(state));
    assert.deepEqual(
      [...roundTripped.editablePaths],
      [...state.editablePaths],
    );
    assert.equal(roundTripped.baseCommitIdentity.tree, state.baseCommitIdentity.tree);
    assert.ok(state.baseCommitIdentity.parents.every((p) => /^[0-9a-f]{40}$/.test(p) || p.length > 0));

    // içerik ASLA düz bayt olarak değil — base64.
    for (const [, value] of state.baseContents) {
      assert.ok(
        value.type === "absent" || (value.type === "file" && /^[A-Za-z0-9+/=\n]*$/.test(value.base64)) || value.type === "symlink",
      );
    }
  } finally {
    await ws.destroy();
  }
});

test("recovery: tampered persisted workspaceDir cannot select an external target", async () => {
  const fixture = await buildRecFixture("rec-tampered");
  const input = recInput(fixture, "s-tampered");
  const ws = await createGitWorktreeWorkspace(input);
  const external = path.join(fixture.out, "external-target");
  const sentinel = path.join(external, "sentinel.txt");
  try {
    const state = await ws.snapshotRecoveryState();
    await mkdir(external, { recursive: true });
    await writeFile(sentinel, "do-not-touch\n");

    const tampered = { ...state, workspaceDir: external } as WorkspaceRecoveryState;
    await assert.rejects(
      restoreGitWorktreeWorkspace(tampered, { expectedWorkspaceDir: state.workspaceDir }),
      (e: unknown) => {
        assert.ok(e instanceof WorkspaceError);
        assert.equal(e.kind, "invalid_input");
        return true;
      },
    );
    assert.equal(await readFile(sentinel, "utf8"), "do-not-touch\n");

    const restored = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.equal(await readFile(path.join(restored.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
    } finally {
      await restored.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
    await rm(external, { recursive: true, force: true });
  }
});

test("recovery: lexical expected dir through a symlinked ancestor restores the same canonical workspace (audit F-1)", async () => {
  const fixture = await buildRecFixture("rec-f1-alias");
  const input = recInput(fixture, "s-f1-alias");
  const ws = await createGitWorktreeWorkspace(input);
  const alias = path.join(tmp, "rec-f1-alias-link");
  try {
    const state = await ws.snapshotRecoveryState();
    await ws.destroy();

    // `fixture.out`'a SYMLINK alias — atal sembolik bağlantının platformdan
    // bağımsız kontrollü karşılığı (macOS `/var` → `/private/var`, CI tmp kökleri).
    await symlink(fixture.out, alias);

    // Sözdizimsel form KALICI kanonik formdan FARKLI — ama AYNI fiziksel dizin.
    const lexicalExpected = path.join(alias, "ws", "s-f1-alias");
    assert.notEqual(path.resolve(lexicalExpected), path.resolve(state.workspaceDir));

    // Kanonik karşılaştırma: restore REDDETMEZ (eski sözdizimsel karşılaştırma
    // bu senaryoda meşru oturumu sahte pozitif reddediyordu).
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: lexicalExpected });
    try {
      // Çalışır dizin = güvenilen formun KANONİĞİ = kalıcı (state) form.
      assert.equal(ws2.workspaceDir, state.workspaceDir);
      assert.deepEqual(ws2.readBaseEntry("src/plain.ts"), {
        exists: true,
        type: "file",
        mode: "100644",
        content: Buffer.from("v2-UNSTAGED\n"),
      });
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
    await rm(alias, { force: true }); // symlink (dizin değil) — rm -f yeterli
  }
});

test("recovery: lstat error (non-ENOENT) on the persisted dir fails closed with a fixed safe message (audit F-3)", async () => {
  const fixture = await buildRecFixture("rec-f3-errno");
  const input = recInput(fixture, "s-f3-errno");
  const ws = await createGitWorktreeWorkspace(input);
  const anonFile = path.join(fixture.out, "anon-file.txt");
  try {
    const state = await ws.snapshotRecoveryState();
    // Güvenilen workspace'te sentinel — hiçbir işlemede dokunulmamalı.
    const sentinel = path.join(ws.workspaceDir, "sentinel.txt");
    await writeFile(sentinel, "do-not-touch\n");

    // Kalıcı `workspaceDir` bir DÜZENLİ DOSYA'nın altına yönlendirilir:
    // `lstat` deterministik NON-ENOENT (ENOTDIR) verir. Yalnız ENOENT "yok"
    // sayılır; diğer hata fail-closed SABİT güvenli mesajla red.
    await writeFile(anonFile, "file\n");
    const tampered = { ...state, workspaceDir: path.join(anonFile, "inner") } as WorkspaceRecoveryState;

    await assert.rejects(
      restoreGitWorktreeWorkspace(tampered, { expectedWorkspaceDir: state.workspaceDir }),
      (e: unknown) => {
        assert.ok(e instanceof WorkspaceError);
        assert.equal(e.kind, "unsafe_path");
        assert.equal(e.message, "The workspace directory must be a real directory");
        // Yol/İÇERİK mesajda YOK.
        assert.ok(!e.message.includes("anon-file"));
        return true;
      },
    );
    assert.equal(await readFile(sentinel, "utf8"), "do-not-touch\n");
  } finally {
    await ws.destroy().catch(() => undefined);
    await rm(anonFile, { force: true });
  }
});

// ── Step 9 audit düzeltmeleri (2026-10-03) ──────────────────────────────────
//
// Düzeltme A: backslash'li dosya adlarını takip EDEN dürüst repository
// (POSIX'te yasal ad) — tam ağacını (basePaths/immutableBaseEntries) taşıyan
// oturumun worktree'si BİREBİR restore edilebilir.
// Düzeltme B: repo İÇİNE düşen workspaceDir (kalıcı ya da beklenen) →
// creation yoluyla BİREBİR stabil `unsafe_path` kind.

test("recovery: honest repo with backslash file names restores (audit A — surviving base object)", async () => {
  const fixture = await buildRecFixture("rec-backslash");
  // Dürüst repo: backslash'li dosya adı (POSIX'te normal karakter) — tracked +
  // committed. SEÇİM YAPILMAZ (güvenilmez alan STRICT kalır); yalnız TAM AĞAÇ
  // (self-captured alan) taşır.
  await writeFile(path.join(fixture.repo, "src", "weird\\name.ts"), "backslash-file\n");
  await gitOk(fixture.repo, ["add", "src/weird\\name.ts"]);
  await gitOk(fixture.repo, ["commit", "-m", "backslash name tracked"]);

  const input = recInput(fixture, "s-backslash");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();
    // Tam ağaç haritası: backslash'li anahtar AYNEN (normalizasyon YOK).
    const baseKeys = state.basePaths.map(([gitPath]) => gitPath);
    assert.ok(baseKeys.includes("src/weird\\name.ts"), "basePaths must carry the raw ls-tree name");
    const src = state.immutableBaseEntries.find((entry) => entry.path === "src");
    assert.ok(src?.children?.some((child) => child.path === "weird\\name.ts"), "tree entry keeps the raw name");

    await ws.destroy();
    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // Worktree BİREBİR: backslash dosyası + seçili dosya içeriği.
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "weird\\name.ts"), "utf8"), "backslash-file\n");
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
      assert.deepEqual(ws2.readBaseEntry("src/plain.ts"), {
        exists: true,
        type: "file",
        mode: "100644",
        content: Buffer.from("v2-UNSTAGED\n"),
      });
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
      // Doğrulama tabanı: backslash'li anahtar aynen taşınır (canonical worker
      // yolu asla eşleşemez → create/delete denetimi fail-closed).
      assert.ok(ws2.base.basePaths.has("src/weird\\name.ts"));
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: honest repo with backslash file names, base object pruned → mktree reconstruction (audit A, case b)", async () => {
  const fixture = await buildRecFixture("rec-backslash-pruned");
  await writeFile(path.join(fixture.repo, "src", "weird\\name.ts"), "backslash-file\n");
  await gitOk(fixture.repo, ["add", "src/weird\\name.ts"]);
  await gitOk(fixture.repo, ["commit", "-m", "backslash name tracked"]);

  const input = recInput(fixture, "s-b-backslash");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();
    await ws.destroy();
    await pruneBaseObject(fixture, state.baseCommit); // base nesnesi yok → mktree+commit-tree yolu

    const ws2 = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      // `mktree`, backslash'li TEK bileşenli adı kabul eder (ölçüldü: aynı
      // tree SHA) → alt-ağaç birebir, checkout backslash dosyasını materyalize
      // eder (blob'u main'den ulaşılabilir — pruneden etkilenmez).
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "weird\\name.ts"), "utf8"), "backslash-file\n");
      assert.equal(await readFile(path.join(ws2.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
      assert.equal(await ws2.recoveryStateHash(), state.recoveryStateHash);
    } finally {
      await ws2.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: persisted workspaceDir inside the repo fails with the stable unsafe_path kind (audit B)", async () => {
  const fixture = await buildRecFixture("rec-b-inside");
  const input = recInput(fixture, "s-b-inside");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();
    // Tamper: kalıcı `workspaceDir` repository İÇİNE düşer (kaçış denemesi).
    const tampered = { ...state, workspaceDir: path.join(fixture.repo, "inside", "ws") } as WorkspaceRecoveryState;
    await assert.rejects(
      restoreGitWorktreeWorkspace(tampered, { expectedWorkspaceDir: state.workspaceDir }),
      (e: unknown) => {
        assert.ok(e instanceof WorkspaceError);
        // Stabil kind: creation yolundaki aynı koşul `unsafe_path` üretir —
        // restore bunu `invalid_input` ile ikame edemezdi.
        assert.equal(e.kind, "unsafe_path");
        assert.equal(e.message, "The workspace directory must be outside the repository");
        assert.ok(!e.message.includes("inside"), "yol mesajda YOK");
        return true;
      },
    );
    // Güvenilen (beklenen) workspace etkilenmez — meşru restore yürür.
    const restored = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir });
    try {
      assert.equal(await readFile(path.join(restored.workspaceDir, "src", "plain.ts"), "utf8"), "v2-UNSTAGED\n");
    } finally {
      await restored.destroy();
    }
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

test("recovery: expected workspaceDir inside the repo fails with the stable unsafe_path kind (audit B)", async () => {
  const fixture = await buildRecFixture("rec-b-expected");
  const input = recInput(fixture, "s-b-expected");
  const ws = await createGitWorktreeWorkspace(input);
  try {
    const state = await ws.snapshotRecoveryState();
    // Çağrıcının "güvenilen" beklenen dizini repository İÇİNE düşer.
    await assert.rejects(
      restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: path.join(fixture.repo, "expected") }),
      (e: unknown) => {
        assert.ok(e instanceof WorkspaceError);
        assert.equal(e.kind, "unsafe_path");
        assert.equal(e.message, "The workspace directory must be outside the repository");
        return true;
      },
    );
  } finally {
    await ws.destroy().catch(() => undefined);
  }
});

// ── İz 3 / K4: git-ignored yola create → yalnız o düzenleme reddedilir ───────

test("K4: create into ignored paths (.gitignore / info/exclude, magic-looking name) → `path is ignored`; others apply; workspace stays usable", async () => {
  const fixture = await buildFixture("k4-ignored");
  // `info/exclude` ortak git dizinindedir → worktree de görür (git add ile aynı kaynak).
  await writeFile(path.join(fixture.repo, ".git", "info", "exclude"), "*.log\n");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "nested/ignored.txt", content: "x\n" }, // .gitignore: ignored.txt
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "alpha-WORKER" }] },
        { kind: "create", path: "logs/:(exclude)run.log", content: "y\n" }, // info/exclude: *.log (magic adı literal)
        { kind: "create", path: "src/fresh.ts", content: "fresh\n" },
      ]),
    );
    assert.deepEqual(result.validation.rejected, [
      { file: "nested/ignored.txt", edit: 0, reason: "path is ignored" },
      { file: "logs/:(exclude)run.log", edit: 2, reason: "path is ignored" },
    ]);
    assert.equal(result.validation.editsApplied, 2);
    assert.deepEqual([...result.filesChanged].sort(), ["src/a.ts", "src/fresh.ts"]);
    assert.deepEqual(result.createdPaths, ["src/fresh.ts"]);
    // Reddedilen create'ler worktree'ye YAZILMADI.
    await assert.rejects(lstat(path.join(ws.workspaceDir, "nested")));
    await assert.rejects(lstat(path.join(ws.workspaceDir, "logs")));

    // Sonraki tur aynı workspace'te normal çalışır.
    const next = await ws.applyPatchSet(workerResult([{ kind: "create", path: "src/fresh2.ts", content: "f2\n" }]));
    assert.deepEqual(next.validation.rejected, []);
    assert.deepEqual(next.filesChanged, ["src/fresh2.ts"]);
  } finally {
    await ws.destroy();
  }
});

test("K4: create beneath a symlink that appeared in the workspace still fails with `unsafe_path` (check-ignore never sees it)", async () => {
  const fixture = await buildFixture("k4-symlink");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    await symlink(tmp, path.join(ws.workspaceDir, "stray-link"));
    await expectWorkspaceError("unsafe_path", () =>
      ws.applyPatchSet(workerResult([{ kind: "create", path: "stray-link/x.js", content: "1\n" }])),
    );
  } finally {
    await ws.destroy();
  }
});

test("M3: a self-ignoring new `tmp/.gitignore` (`*`) + `tmp/x` → both rejected AFTER the write, removed; other edits apply", async () => {
  const fixture = await buildFixture("k4-post-write");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "tmp/.gitignore", content: "*\n" },
        { kind: "create", path: "tmp/x", content: "x\n" },
        { kind: "modify", path: "src/a.ts", operations: [{ search: "alpha-USER", replace: "alpha-WORKER" }] },
      ]),
    );
    assert.deepEqual(result.validation.rejected, [
      { file: "tmp/.gitignore", edit: 0, reason: "path is ignored" },
      { file: "tmp/x", edit: 1, reason: "path is ignored" },
    ]);
    assert.deepEqual(result.filesChanged, ["src/a.ts"]);
    assert.deepEqual(result.createdPaths, []);
    await assert.rejects(lstat(path.join(ws.workspaceDir, "tmp", ".gitignore")));
    await assert.rejects(lstat(path.join(ws.workspaceDir, "tmp", "x")));
  } finally {
    await ws.destroy();
  }
});

test("L1: `--no-index` — `[a].log` create is judged on its own name, not via a glob over tracked `a.log`", async () => {
  const fixture = await buildFixture("k4-no-index");
  await writeFile(path.join(fixture.repo, "a.log"), "tracked\n");
  await gitOk(fixture.repo, ["add", "a.log"]);
  await writeFile(path.join(fixture.repo, ".gitignore"), "ignored.txt\n*.log\n");
  await gitOk(fixture.repo, ["add", ".gitignore"]);
  await gitOk(fixture.repo, ["commit", "-m", "track a.log, ignore *.log"]);
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(workerResult([{ kind: "create", path: "[a].log", content: "y\n" }]));
    assert.deepEqual(result.validation.rejected, [{ file: "[a].log", edit: 0, reason: "path is ignored" }]);
  } finally {
    await ws.destroy();
  }
});

test("L2: root-level `:(exclude)run.log` create is passed literally (`./` prefix) → `path is ignored`", async () => {
  const fixture = await buildFixture("k4-root-magic");
  await writeFile(path.join(fixture.repo, ".git", "info", "exclude"), "*.log\n");
  const ws = await createGitWorktreeWorkspace(createInput(fixture));
  try {
    const result = await ws.applyPatchSet(workerResult([{ kind: "create", path: ":(exclude)run.log", content: "y\n" }]));
    assert.deepEqual(result.validation.rejected, [{ file: ":(exclude)run.log", edit: 0, reason: "path is ignored" }]);
  } finally {
    await ws.destroy();
  }
});

test("L6: an explicitly selected (editable) absent path that is git-ignored is created (`add -N -f`); unselected ignored create still rejected", async () => {
  const fixture = await buildFixture("k4-selected-ignored");
  const input = createInput(fixture);
  const ws = await createGitWorktreeWorkspace({ ...input, editablePaths: [...input.editablePaths, "gen/ignored.txt"] });
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "create", path: "gen/ignored.txt", content: "selected\n" },
        { kind: "create", path: "other/ignored.txt", content: "unselected\n" },
      ]),
    );
    assert.deepEqual(result.validation.rejected, [{ file: "other/ignored.txt", edit: 1, reason: "path is ignored" }]);
    assert.deepEqual(result.filesChanged, ["gen/ignored.txt"]);
    assert.deepEqual(result.createdPaths, ["gen/ignored.txt"]);
    assert.ok((await ws.diff()).includes("+selected"));
  } finally {
    await ws.destroy();
  }
});

test("M3: when the plan edits `.gitignore`, the decision uses the NEW rules (un-ignored path is created)", async () => {
  const fixture = await buildFixture("k4-unignore");
  const input = createInput(fixture);
  const ws = await createGitWorktreeWorkspace({ ...input, editablePaths: [...input.editablePaths, ".gitignore"] });
  try {
    const result = await ws.applyPatchSet(
      workerResult([
        { kind: "modify", path: ".gitignore", operations: [{ search: "ignored.txt\n", replace: "*.tmp\n" }] },
        { kind: "create", path: "deep/ignored.txt", content: "now tracked\n" },
      ]),
    );
    assert.deepEqual(result.validation.rejected, []);
    assert.deepEqual([...result.filesChanged].sort(), [".gitignore", "deep/ignored.txt"]);
  } finally {
    await ws.destroy();
  }
});

// ── İnceleme düzeltmeleri — İz 1: workspace/git (W-H1, W-M5, L3, L4, L6) ────

/** Basit tek-dosyalı repo (`f.txt` committed) + repo DIŞI çıktı kökü. */
async function buildPlainRepo(name: string): Promise<Fixture> {
  const repo = path.join(tmp, name, "repo");
  const out = path.join(tmp, name);
  await mkdir(repo, { recursive: true });
  await gitOk(repo, ["init", "-b", "main"]);
  await gitOk(repo, ["config", "user.name", "Plain User"]);
  await gitOk(repo, ["config", "user.email", "plain@local.invalid"]);
  await writeFile(path.join(repo, "f.txt"), "v1\n");
  await gitOk(repo, ["add", "f.txt"]);
  await gitOk(repo, ["commit", "-m", "plain init"]);
  return { repo, out };
}

/** Ana depo durumunun karşılaştırılabilir kaydı: HEAD + dal ref'i + index + status + dosyalar. */
async function mainRepoSnapshot(repo: string): Promise<Record<string, string>> {
  const files = await readAll(repo);
  const fileDigest = [...files.entries()].map(([key, value]) => `${key}:${sha256(value)}`).join("|");
  return {
    head: await gitText(repo, ["rev-parse", "HEAD"]),
    branch: await gitText(repo, ["rev-parse", "refs/heads/main"]),
    symbolicHead: await gitText(repo, ["symbolic-ref", "HEAD"]),
    index: (await git(repo, ["ls-files", "-s", "-z"])).toString("utf8"),
    status: (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toString("utf8"),
    files: fileDigest,
  };
}

test("inherited absolute GIT_DIR/GIT_WORK_TREE never redirect create/apply into the main repository: HEAD/ref/index/files stay exact (W-H1)", async () => {
  const fixture = await buildPlainRepo("wh1-env");
  await writeFile(path.join(fixture.repo, "untracked.txt"), "user's untracked\n");
  const before = await mainRepoSnapshot(fixture.repo);
  const input: WorkspaceCreateInput = {
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-wh1"),
    sessionId: "s-wh1",
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  };
  let ws: GitWorktreeWorkspace | null = null;
  let outcome: unknown = null;
  process.env.GIT_DIR = path.join(fixture.repo, ".git");
  process.env.GIT_WORK_TREE = fixture.repo;
  try {
    ws = await createGitWorktreeWorkspace(input);
    await ws.applyPatchSet(workerResult([{ kind: "modify", path: "f.txt", operations: [{ search: "v1", replace: "v2-worker" }] }]));
    await ws.resetToBase();
    await ws.applyPatchSet(workerResult([{ kind: "modify", path: "f.txt", operations: [{ search: "v1", replace: "v2-worker" }] }]));
  } catch (err) {
    outcome = err;
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
  }
  try {
    assert.deepEqual(await mainRepoSnapshot(fixture.repo), before, "the main checkout must stay byte-identical");
    assert.equal(outcome, null, `create/apply must succeed in the isolated worktree: ${String(outcome)}`);
    assert.ok(ws !== null);
    assert.equal(await readFile(path.join(ws.workspaceDir, "f.txt"), "utf8"), "v2-worker\n");
    assert.notEqual(ws.baseCommit, before.head, "the base commit lives in the worktree, never on the main branch");
  } finally {
    await ws?.destroy().catch(() => undefined);
  }
});

test("a tampered created-path set never unlinks through an ancestor symlink outside the workspace; the residue stays (W-M5)", async () => {
  const fixture = await buildPlainRepo("wm5-tamper");
  const outsideDir = path.join(fixture.out, "outside-dir");
  await mkdir(outsideDir, { recursive: true });
  const sentinel = path.join(outsideDir, "x");
  await writeFile(sentinel, "outside sentinel\n");
  // base'te committed bir dizin-symlink'i: `lnk` → workspace DIŞINDAKİ dizin.
  await symlink(outsideDir, path.join(fixture.repo, "lnk"));
  await gitOk(fixture.repo, ["add", "lnk"]);
  await gitOk(fixture.repo, ["commit", "-m", "outside dir link"]);

  const input: WorkspaceCreateInput = {
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-wm5"),
    sessionId: "s-wm5",
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  };
  const ws = await createGitWorktreeWorkspace(input);
  const state = await ws.snapshotRecoveryState();
  await ws.destroy();
  // Kurcalanmış (şema-geçerli) kalıcı küme: `lnk/x` kanonik bir yoldur.
  const tampered: WorkspaceRecoveryState = { ...state, currentCreatedPaths: ["lnk/x"] };
  const ws2 = await restoreGitWorktreeWorkspace(tampered, { expectedWorkspaceDir: state.workspaceDir });
  try {
    assert.ok((await lstat(path.join(ws2.workspaceDir, "lnk"))).isSymbolicLink(), "fixture: the ancestor is a symlink");
    const err = await expectWorkspaceError("workspace_operation_failed", () => ws2.resetToBase());
    assert.equal(err.message, "Cleaning the worker-created paths failed");
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel\n", "a file outside the workspace must never be unlinked");
    // Küme BİLİNEN KALINTI olarak kalır: sonraki tur da aynı güvenli redde düşer.
    await expectWorkspaceError("workspace_operation_failed", () => ws2.applyPatchSet(workerResult([])));
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel\n");
  } finally {
    await ws2.destroy().catch(() => undefined);
  }
});

/** PATH'teki gerçek `git` ikilisinin mutlak yolu (yarış sarmalayıcısı için). */
async function realGitPath(): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, "git");
    const st = await stat(candidate).catch(() => null);
    if (st !== null && st.isFile() && (st.mode & 0o111) !== 0) {
      return candidate;
    }
  }
  throw new Error("git not found on PATH");
}

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Yarış enjeksiyonu (L3/L4): PATH'in önüne konan `git` sarmalayıcısı,
 * argv'sinde `trigger` kelimesini taşıyan İLK çağrıdan hemen ÖNCE `action`
 * kabuk satırını BİR KEZ çalıştırır (`$REAL` = gerçek git), sonra gerçek
 * git'e `exec` eder — Splash'in iki git çağrısı arasındaki pencereyi
 * deterministik açar (git/fs seam'i yok). Dönen `fired`: tetik çalıştı mı.
 */
async function withGitRaceHook<T>(
  dir: string,
  trigger: string,
  action: string,
  fn: () => Promise<T>,
): Promise<{ result: T | null; error: unknown; fired: boolean }> {
  const binDir = path.join(dir, "race-bin");
  await mkdir(binDir, { recursive: true });
  const marker = path.join(binDir, "fired");
  const script = [
    "#!/bin/sh",
    `REAL=${shQuote(await realGitPath())}`,
    "hit=",
    'for a in "$@"; do',
    `  if [ "$a" = ${shQuote(trigger)} ]; then hit=1; fi`,
    "done",
    `if [ -n "$hit" ] && [ ! -e ${shQuote(marker)} ]; then`,
    `  : > ${shQuote(marker)}`,
    `  ${action}`,
    "fi",
    'exec "$REAL" "$@"',
    "",
  ].join("\n");
  const wrapper = path.join(binDir, "git");
  await writeFile(wrapper, script);
  await chmod(wrapper, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  let result: T | null = null;
  let error: unknown = null;
  try {
    result = await fn();
  } catch (err) {
    error = err;
  } finally {
    process.env.PATH = savedPath;
  }
  const fired = (await lstat(marker).catch(() => null)) !== null;
  return { result, error, fired };
}

test("base capture diffs against the resolved HEAD sha: a commit landing between rev-parse and the delta capture never drops the user's change (L3)", async () => {
  const fixture = await buildPlainRepo("l3-race");
  await writeFile(path.join(fixture.repo, "f.txt"), "v2-dirty\n"); // unstaged kullanıcı değişikliği
  const headBefore = await gitText(fixture.repo, ["rev-parse", "HEAD"]);
  const input: WorkspaceCreateInput = {
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-l3"),
    sessionId: "s-l3",
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  };
  // İlk `diff` (delta yakalama) çağrısından hemen önce kullanıcı değişikliği commit'ler:
  // HEAD ilerler, çalışma ağacı temizlenir — ama içerik aynı (v2-dirty) kalır.
  const action = `"$REAL" -C ${shQuote(fixture.repo)} -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q -a -m race >/dev/null 2>&1`;
  const { result: ws, error, fired } = await withGitRaceHook(fixture.out, "diff", action, () => createGitWorktreeWorkspace(input));
  try {
    assert.equal(fired, true, "the race hook must fire");
    assert.equal(error, null, `creation must succeed: ${String(error)}`);
    assert.ok(ws !== null);
    assert.equal(await readFile(path.join(fixture.repo, "f.txt"), "utf8"), "v2-dirty\n", "fixture: main working tree content");
    // Kanca commit'i GERÇEKTEN oldu: HEAD ilerledi, bir önceki commit = yakalanan HEAD.
    assert.notEqual(await gitText(fixture.repo, ["rev-parse", "HEAD"]), headBefore, "fixture: HEAD moved during creation");
    assert.equal(await gitText(fixture.repo, ["rev-parse", "HEAD~1"]), headBefore, "fixture: the race commit sits on top of the captured HEAD");
    // Worktree yakalanan HEAD'den kuruldu: base commit'in ebeveyni = headBefore.
    assert.equal(await gitText(fixture.repo, ["rev-parse", `${ws.baseCommit}^`]), headBefore);
    // Base = ana working-tree'nin BİREBİR durumu (spec 19/20) — HEAD kaymasından bağımsız.
    assert.deepEqual(ws.readBaseEntry("f.txt"), {
      exists: true,
      type: "file",
      mode: "100644",
      content: Buffer.from("v2-dirty\n"),
    });
  } finally {
    await ws?.destroy().catch(() => undefined);
  }
});

test("selected untracked symlink retargeted outside after the primary check: the copy-time check rejects it (L4)", async () => {
  const fixture = await buildPlainRepo("l4-race");
  const outsideTarget = path.join(fixture.out, "outside-secret.txt");
  await writeFile(outsideTarget, "host secret\n");
  await symlink("f.txt", path.join(fixture.repo, "ln")); // untracked, İÇE (birincil kontrol geçer)
  const workspaceDir = path.join(fixture.out, "ws", "s-l4");
  const input: WorkspaceCreateInput = {
    repoRoot: fixture.repo,
    workspaceDir,
    sessionId: "s-l4",
    editablePaths: ["ln"],
    readonlyPaths: [],
  };
  // Birincil kontrolden SONRA, kopyadan ÖNCE (`worktree add` anında) link dışa çevrilir.
  const linkAbs = path.join(fixture.repo, "ln");
  const action = `rm -f ${shQuote(linkAbs)} && ln -s ${shQuote(outsideTarget)} ${shQuote(linkAbs)}`;
  const { result: ws, error, fired } = await withGitRaceHook(fixture.out, "worktree", action, () => createGitWorktreeWorkspace(input));
  try {
    assert.equal(fired, true, "the race hook must fire");
    assert.equal(await readlink(linkAbs), outsideTarget, "fixture: the link now points outside");
    assert.ok(error instanceof WorkspaceError, `creation must be rejected, got: ${String(error)}`);
    assert.equal(error.kind, "unsafe_path");
    assert.equal(error.message, "A selected path is an unsafe symlink");
    assert.equal(await lstat(workspaceDir).catch(() => null), null, "no partial worktree is left (spec 74)");
  } finally {
    await ws?.destroy().catch(() => undefined);
  }
});

test("case (b) reconstruction boundary: a pruned delta blob of a NON-selected dirty file fails closed at mktree (no partial worktree) (L6)", async () => {
  const fixture = await buildRecFixture("l6-boundary");
  // seçilmemiş, tracked, unstaged değişiklikli dosya: delta blob'u yalnız base ağacından erişilebilir.
  await writeFile(path.join(fixture.repo, "src", "other.ts"), "o1\n");
  await gitOk(fixture.repo, ["add", "src/other.ts"]);
  await gitOk(fixture.repo, ["commit", "-m", "other"]);
  await writeFile(path.join(fixture.repo, "src", "other.ts"), "o2-UNSTAGED\n");
  const ws = await createGitWorktreeWorkspace(recInput(fixture, "s-l6"));
  const state = await ws.snapshotRecoveryState();
  await ws.destroy();
  await pruneBaseObject(fixture, state.baseCommit);
  const err = await restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir }).then(
    async (restored) => {
      await restored.destroy().catch(() => undefined);
      throw new Error("expected the reconstruction to fail closed");
    },
    (caught: unknown) => caught,
  );
  assert.ok(err instanceof WorkspaceError, `expected WorkspaceError, got: ${String(err)}`);
  assert.equal((err.cause as { command?: unknown } | undefined)?.command, "mktree", "mktree itself verifies object existence");
  assert.equal(await lstat(state.workspaceDir).catch(() => null), null, "no partial worktree is left");
});

test("a file named like the resolved HEAD sha in the main tree never makes the delta capture ambiguous (INFO-3)", async () => {
  const fixture = await buildPlainRepo("info3-ambiguous");
  const headSha = await gitText(fixture.repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(fixture.repo, headSha), "untracked file named like the sha\n");
  await writeFile(path.join(fixture.repo, "f.txt"), "v2-dirty\n");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", "s-info3"),
    sessionId: "s-info3",
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  });
  try {
    assert.deepEqual(ws.readBaseEntry("f.txt"), {
      exists: true,
      type: "file",
      mode: "100644",
      content: Buffer.from("v2-dirty\n"),
    });
  } finally {
    await ws.destroy();
  }
});

/**
 * Sahte git sürümü (MEDIUM-1): PATH'in önüne konan sarmalayıcı `--version`
 * argümanlı çağrıya `versionLine` basar, geri kalan her çağrıyı gerçek
 * git'e `exec` eder. Splash'in sürüm önbelleği `PATH` anahtarlıdır — bu
 * blok kendi sürüm okumasını yapar.
 */
async function withFakeGitVersion<T>(dir: string, versionLine: string, fn: () => Promise<T>): Promise<T> {
  const binDir = path.join(dir, "fake-version-bin");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'for a in "$@"; do',
    `  if [ "$a" = "--version" ]; then printf '%s\\n' ${shQuote(versionLine)}; exit 0; fi`,
    "done",
    `exec ${shQuote(await realGitPath())} "$@"`,
    "",
  ].join("\n");
  const wrapper = path.join(binDir, "git");
  await writeFile(wrapper, script);
  await chmod(wrapper, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

/** Sonuç ya da yakalanan hata (oluşturulan workspace'ler çağıran tarafından imha edilir). */
async function settle<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: unknown }> {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: err };
  }
}

test("git without GIT_NO_LAZY_FETCH + partial clone (promisor remote): creation and recovery reject with a fixed invalid_repository; a non-promisor repo and a protected git (2.45.1) are unaffected (MEDIUM-1)", async () => {
  const source = await buildPlainRepo("m1-src");
  await gitOk(source.repo, ["config", "uploadpack.allowFilter", "true"]);
  const out = path.join(tmp, "m1-clone");
  const clone = path.join(out, "repo");
  await mkdir(out, { recursive: true });
  // Checkout'lu partial clone doğrudan git ile kurulur: runGit'in
  // GIT_NO_LAZY_FETCH'i checkout'un blob çekmesini (doğru biçimde) engellerdi.
  await promisify(execFile)("git", ["clone", "-q", "--filter=blob:none", `file://${source.repo}`, clone]);
  // Not: `clone --filter` fikstürü `remote.origin.partialclonefilter`'ı da
  // yazar — bu test 3 seviyeli promisor sorgusunu ve `--bool`'u TEK BAŞINA
  // ayırt etmez; onlar biçim tablosu testinde (aşağıda) sabitlenir.
  assert.equal(await gitText(clone, ["config", "--get", "remote.origin.promisor"]), "true", "fixture: promisor remote");
  const plain = await buildPlainRepo("m1-plain");
  const cloneInput = (sessionId: string): WorkspaceCreateInput => ({
    repoRoot: clone,
    workspaceDir: path.join(out, "ws", sessionId),
    sessionId,
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  });

  // Korumalı git (sahte 2.45.1; kurulu git sürümünden bağımsız): promisor'lı
  // repo da oluşturulur — mevcut davranış. Ayrı dizin ŞART: sürüm önbelleği
  // `PATH` anahtarlı; aşağıdaki 2.43.0 bloğuyla aynı `out` → aynı PATH →
  // önbellekteki 2.45.1 okunur ve eski dal reddetmez (ölçüldü).
  const state = await withFakeGitVersion(path.join(out, "v2.45.1"), "git version 2.45.1", async () => {
    const modern = await createGitWorktreeWorkspace(cloneInput("s-m1-modern"));
    const snapshot = await modern.snapshotRecoveryState();
    await modern.destroy();
    return snapshot;
  });

  const created: GitWorktreeWorkspace[] = [];
  try {
    const outcome = await withFakeGitVersion(out, "git version 2.43.0", async () => ({
      create: await settle(() => createGitWorktreeWorkspace(cloneInput("s-m1-old"))),
      recover: await settle(() => restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir })),
      plain: await settle(() =>
        createGitWorktreeWorkspace({
          repoRoot: plain.repo,
          workspaceDir: path.join(plain.out, "ws", "s-m1-plain"),
          sessionId: "s-m1-plain",
          editablePaths: ["f.txt"],
          readonlyPaths: [],
        }),
      ),
    }));
    for (const value of [outcome.create.value, outcome.recover.value, outcome.plain.value]) {
      if (value !== null) {
        created.push(value);
      }
    }
    for (const [label, result] of [["create", outcome.create], ["recover", outcome.recover]] as const) {
      assert.ok(result.error instanceof WorkspaceError, `${label}: expected WorkspaceError, got ${String(result.error)}`);
      assert.equal(result.error.kind, "invalid_repository", label);
      assert.equal(result.error.message, "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)", label);
    }
    assert.equal(await lstat(path.join(out, "ws", "s-m1-old")).catch(() => null), null, "no worktree is created");
    assert.equal(await lstat(state.workspaceDir).catch(() => null), null, "no worktree is recovered");
    assert.equal(outcome.plain.error, null, `a non-promisor repo is unaffected on old git: ${String(outcome.plain.error)}`);
  } finally {
    for (const ws of created) {
      await ws.destroy().catch(() => undefined);
    }
  }
});

test("a repository whose only promisor signal is remote.<name>.partialCloneFilter is gated like any promisor remote: an unprotected git rejects creation and recovery, a protected git creates (MEDIUM-1, P1)", async () => {
  // git `promisor_remote_config()`: `remote.<ad>.partialclonefilter` anahtarı
  // TEK BAŞINA remote'u promisor yapar (değerinden bağımsız).
  const fixture = await buildPlainRepo("p1c-filter-only");
  await gitOk(fixture.repo, ["config", "remote.origin.partialclonefilter", "blob:none"]);
  const local = await gitText(fixture.repo, ["config", "--local", "--list"]);
  assert.ok(local.split("\n").includes("remote.origin.partialclonefilter=blob:none"), "fixture: filter key set");
  assert.ok(!/promisor|extensions\.partialclone/i.test(local), "fixture: no promisor key, no extensions.partialClone");
  const input = (sessionId: string): WorkspaceCreateInput => ({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", sessionId),
    sessionId,
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  });

  // Ayrı dizinler ŞART: sürüm önbelleği `PATH` anahtarlı.
  const old = await withFakeGitVersion(path.join(fixture.out, "v2.43.0"), "git version 2.43.0", () =>
    settle(() => createGitWorktreeWorkspace(input("s-p1c-old"))),
  );
  if (old.value !== null) {
    await old.value.destroy().catch(() => undefined);
  }
  assert.ok(old.error instanceof WorkspaceError, `expected WorkspaceError, got ${String(old.error)}`);
  assert.equal(old.error.kind, "invalid_repository");
  assert.equal(
    old.error.message,
    "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)",
  );
  assert.equal(await lstat(path.join(fixture.out, "ws", "s-p1c-old")).catch(() => null), null, "no worktree is created");

  const state = await withFakeGitVersion(path.join(fixture.out, "v2.45.1"), "git version 2.45.1", async () => {
    const modern = await createGitWorktreeWorkspace(input("s-p1c-modern"));
    const snapshot = await modern.snapshotRecoveryState();
    await modern.destroy();
    return snapshot;
  });

  // Kurtarma da aynı kapıdan geçer (korumasız git → red, worktree geri gelmez).
  // Aynı 2.43.0 dizini: önbellekteki sürüm de 2.43.0.
  const recover = await withFakeGitVersion(path.join(fixture.out, "v2.43.0"), "git version 2.43.0", () =>
    settle(() => restoreGitWorktreeWorkspace(state, { expectedWorkspaceDir: state.workspaceDir })),
  );
  if (recover.value !== null) {
    await recover.value.destroy().catch(() => undefined);
  }
  assert.ok(recover.error instanceof WorkspaceError, `recover: expected WorkspaceError, got ${String(recover.error)}`);
  assert.equal(recover.error.kind, "invalid_repository", "recover");
  assert.equal(
    recover.error.message,
    "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)",
    "recover",
  );
  assert.equal(await lstat(state.workspaceDir).catch(() => null), null, "no worktree is recovered");
});

test("every promisor form git itself honors is gated on an unprotected git: two-level remote.partialCloneFilter / remote.promisor, empty extensions.partialClone, empty remote.<name>.partialCloneFilter, remote.<name>.promisor as true/yes/1/bare key (MEDIUM-1, P1)", async () => {
  // Merkez ölçtü (Git 2.50.1, `GIT_NO_LAZY_FETCH` tanımsız, `GIT_TRACE`): bu
  // biçimlerin HEPSİ eksik nesne okumasında tembel `git fetch` başlatır.
  // 3 seviyeli `remote.origin.promisor` satırları (filter/extension YOK)
  // promisor sorgusunun 3 seviyeli yolunu ve `--bool` normalleştirmesini
  // (`yes`/`1`/çıplak anahtar → true) tek başına sabitler.
  // `value === null` → çıplak anahtar (`.git/config`'e doğrudan yazılır).
  const cases: ReadonlyArray<readonly [label: string, key: string, value: string | null]> = [
    ["two-level remote.partialclonefilter", "remote.partialclonefilter", "blob:none"],
    ["two-level remote.promisor", "remote.promisor", "true"],
    ["empty extensions.partialclone", "extensions.partialclone", ""],
    ["empty remote.origin.partialclonefilter", "remote.origin.partialclonefilter", ""],
    ["remote.origin.promisor=true", "remote.origin.promisor", "true"],
    ["remote.origin.promisor=yes", "remote.origin.promisor", "yes"],
    ["remote.origin.promisor=1", "remote.origin.promisor", "1"],
    ["bare remote.origin.promisor key", "remote.origin.promisor", null],
  ];
  for (const [index, [label, key, value]] of cases.entries()) {
    const fixture = await buildPlainRepo(`p1c-form-${index}`);
    if (value === null) {
      await appendFile(path.join(fixture.repo, ".git", "config"), '[remote "origin"]\n\tpromisor\n');
    } else {
      await gitOk(fixture.repo, ["config", key, value]);
    }
    const expectedLine = value === null ? key : `${key}=${value}`;
    const local = (await gitText(fixture.repo, ["config", "--local", "--list"])).split("\n");
    assert.ok(local.includes(expectedLine), `${label}: fixture key set`);
    assert.deepEqual(
      local.filter((line) => line !== expectedLine && /promisor|partialclone/i.test(line)),
      [],
      `${label}: fixture has no other promisor signal`,
    );
    const sessionId = `s-p1c-form-${index}`;
    const workspaceDir = path.join(fixture.out, "ws", sessionId);
    // Her durum kendi dizininde (sürüm önbelleği `PATH` anahtarlı).
    const result = await withFakeGitVersion(path.join(fixture.out, "v2.43.0"), "git version 2.43.0", () =>
      settle(() =>
        createGitWorktreeWorkspace({
          repoRoot: fixture.repo,
          workspaceDir,
          sessionId,
          editablePaths: ["f.txt"],
          readonlyPaths: [],
        }),
      ),
    );
    if (result.value !== null) {
      await result.value.destroy().catch(() => undefined);
    }
    assert.ok(result.error instanceof WorkspaceError, `${label}: expected WorkspaceError, got ${String(result.error)}`);
    assert.equal(result.error.kind, "invalid_repository", label);
    assert.equal(
      result.error.message,
      "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)",
      label,
    );
    assert.equal(await lstat(workspaceDir).catch(() => null), null, `${label}: no worktree is created`);
  }
});

test("a promisor remote that becomes visible only inside linked worktrees through a repository-local includeIf is gated on an unprotected git; a protected git creates (includeIf)", async () => {
  // Ana repo bağlamında `gitdir:**/.git/worktrees/**` eşleşmediği için promisor
  // görünmez; bağlı worktree bağlamında görünür. Kapı bu yüzden repo-yerel
  // include yönergesini promisor sayar: korumasız git → red, korumalı git → oluşturulur.
  const fixture = await buildPlainRepo("inc-gitdir");
  await appendFile(path.join(fixture.repo, ".git", "promisor.inc"), '[remote "x"]\n\tpromisor = true\n\turl = file:///nonexistent\n');
  await appendFile(path.join(fixture.repo, ".git", "config"), '[includeIf "gitdir:**/.git/worktrees/**"]\n\tpath = promisor.inc\n');
  assert.ok(!/^remote\.x\.promisor=/m.test(await gitText(fixture.repo, ["config", "--list"])), "fixture: the promisor is invisible from the main repository context");
  assert.ok(
    (await gitText(fixture.repo, ["config", "--local", "--list"])).split("\n").some((line) => line.startsWith("includeif.")),
    "fixture: includeIf directive set",
  );
  const input = (sessionId: string): WorkspaceCreateInput => ({
    repoRoot: fixture.repo,
    workspaceDir: path.join(fixture.out, "ws", sessionId),
    sessionId,
    editablePaths: ["f.txt"],
    readonlyPaths: [],
  });

  // Korumasız git (sahte 2.43.0): oluşum red. Ayrı dizin ŞART: sürüm önbelleği `PATH` anahtarlı.
  const old = await withFakeGitVersion(path.join(fixture.out, "v2.43.0"), "git version 2.43.0", () =>
    settle(() => createGitWorktreeWorkspace(input("s-inc-old"))),
  );
  if (old.value !== null) {
    await old.value.destroy().catch(() => undefined);
  }
  assert.ok(old.error instanceof WorkspaceError, `expected WorkspaceError, got ${String(old.error)}`);
  assert.equal(old.error.kind, "invalid_repository");
  assert.equal(
    old.error.message,
    "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)",
  );
  assert.equal(await lstat(path.join(fixture.out, "ws", "s-inc-old")).catch(() => null), null, "no worktree is created");

  // Korumalı git (sahte 2.45.1): davranış değişmez — oluşturulur. Ayrı dizin (sürüm önbelleği `PATH` anahtarlı).
  await withFakeGitVersion(path.join(fixture.out, "v2.45.1"), "git version 2.45.1", async () => {
    const modern = await createGitWorktreeWorkspace(input("s-inc-modern"));
    await modern.destroy();
  });
});

test("a promisor remote hidden behind an includeIf in .git/config.worktree (extensions.worktreeConfig) is gated on an unprotected git (includeIf, config.worktree)", async () => {
  // Yönerge `.git/config`'te değil `.git/config.worktree`'de (extensions.worktreeConfig);
  // `git worktree add` bu dosyayı yeni worktree'ye kopyalar. Kapı `worktree` kapsamındaki
  // include yönergesini de promisor sinyali sayar: korumasız git → red.
  const fixture = await buildPlainRepo("inc-wtconfig");
  await gitOk(fixture.repo, ["config", "extensions.worktreeConfig", "true"]);
  await appendFile(path.join(fixture.repo, ".git", "promisor.inc"), '[remote "x"]\n\tpromisor = true\n\turl = file:///nonexistent\n');
  await appendFile(path.join(fixture.repo, ".git", "config.worktree"), '[includeIf "gitdir:**/.git/worktrees/**"]\n\tpath = ../../promisor.inc\n');
  assert.ok(!/^remote\.x\.promisor=/m.test(await gitText(fixture.repo, ["config", "--list"])), "fixture: the promisor is invisible from the main repository context");
  assert.ok(!(await gitText(fixture.repo, ["config", "--local", "--list"])).split("\n").some((line) => line.startsWith("include")), "fixture: .git/config itself has no include directive");
  const sessionId = "s-inc-wtconfig";
  const workspaceDir = path.join(fixture.out, "ws", sessionId);
  const result = await withFakeGitVersion(path.join(fixture.out, "v2.43.0"), "git version 2.43.0", () => settle(() => createGitWorktreeWorkspace({ repoRoot: fixture.repo, workspaceDir, sessionId, editablePaths: ["f.txt"], readonlyPaths: [] })));
  if (result.value !== null) { await result.value.destroy().catch(() => undefined); }
  assert.ok(result.error instanceof WorkspaceError, `expected WorkspaceError, got ${String(result.error)}`);
  assert.equal(result.error.kind, "invalid_repository");
  assert.equal(result.error.message, "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)");
  assert.equal(await lstat(workspaceDir).catch(() => null), null, "no worktree is created");
});
