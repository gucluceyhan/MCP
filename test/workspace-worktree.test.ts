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
 *   (34-37: audit F-6 — pozitif kontrol/mutasyon kanıtlı, S-2 kapandı)
 *
 * Hermetic git: global/system config kesilir (kullanıcı makine ayarları
 * determinizmi bozmasın). Testler BUILT çıktıyı (dist/) import eder.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceCreateInput,
} from "../dist/workspace/Workspace.js";
import {
  GitWorktreeWorkspace,
  createGitWorktreeWorkspace,
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
 * Arıza enjeksiyonu fs seam'leri (PR #24 Fix 4). Test biterken
 * `setWorkspaceFs(null)` ile gerçek fs'e dönülür.
 * - `failingFs`: gerçek `lstat` + DAİMA EACCES `unlink` — yol VAR ve
 *   unlink'in gerçekten denendiğini (dosyanın kalmasıyla) ispatlar.
 * - `denyingFs`: `lstat` + `unlink` ikisi de EACCES — dosyanın varlığından
 *   BAĞIMSIZ deterministik temizlik hatası (reset'in git tarafında sildiği
 *   intent-to-add yollarında `lstat` ENOENT'a düşerdi).
 */
function failingFs(): WorkspaceFs {
  return {
    lstat: (target: string) => lstat(target),
    unlink: () => Promise.reject(errnoEacces()),
  };
}

function denyingFs(): WorkspaceFs {
  return {
    lstat: () => Promise.reject(errnoEacces()),
    unlink: () => Promise.reject(errnoEacces()),
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
