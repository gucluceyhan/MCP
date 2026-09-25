/**
 * Step 5: git katmanı testleri (`src/workspace/git.ts`).
 *
 * Çiviler (spec 5/6/7/8, 78): repository keşfi (non-git red, bare red,
 * HEAD'sız red, override), deterministik repo kimliği, shell'siz yürütme +
 * GÜVENLİ hata mesajı (ham stderr asla mesajda değil — yalnız `cause`'ta).
 *
 * Hermetic git: testler global/system git config'ini KESER (kullanıcının
 * makine ayarları determinizmi bozmasın); her test kendi geçici repolarını
 * kurar.
 *
 * Testler BUILT çıktıyı (dist/) import eder.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceError,
  type WorkspaceErrorKind,
} from "../dist/workspace/Workspace.js";
import { computeRepoId, discoverRepoRoot, runGit } from "../dist/workspace/git.js";

let tmp: string;
let emptyConfigFile: string;

/**
 * Test süreci boyunca her git çağrısı (helper'in içi dahil) hermetic
 * çalışsın diye global env: system+global config yok, prompt yok.
 */
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "splash-workspace-git-"));
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

async function makeRepo(name: string, commit = true): Promise<string> {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  const run = (args: string[]) => runGit(args, { cwd: dir });
  await run(["init", "-b", "main"]);
  // LOKAL (repo) kimlik — global/system config kesik (hermetic). Base-commit
  // hijyen testi bunun YOKSAYLANDIĞINI (Splash kimliği) doğrulayacak.
  await run(["config", "user.name", "Test User"]);
  await run(["config", "user.email", "test-user@local.invalid"]);
  await writeFile(path.join(dir, "f.txt"), "hello\n");
  await run(["add", "f.txt"]);
  if (commit) {
    await run(["commit", "-m", "init"]);
  }
  return dir;
}

function expectWorkspaceError(kind: WorkspaceErrorKind, fn: () => Promise<unknown>): Promise<WorkspaceError> {
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

// ── discoverRepoRoot ────────────────────────────────────────────────────────

test("discoverRepoRoot: from inside a repo returns the canonical toplevel", async () => {
  const repo = await makeRepo("d1");
  const sub = path.join(repo, "src", "deep");
  await mkdir(sub, { recursive: true });
  const root = await discoverRepoRoot({ cwd: sub });
  assert.equal(root, await (await import("node:fs/promises")).realpath(repo));
});

test("discoverRepoRoot: a non-Git directory is rejected (no non-Git fallback, spec 7)", async () => {
  const dir = path.join(tmp, "notgit");
  await mkdir(dir, { recursive: true });
  const err = await expectWorkspaceError("invalid_repository", () => discoverRepoRoot({ cwd: dir }));
  assert.equal(err.message, "The project root is not a valid Git working tree");
});

test("discoverRepoRoot: a bare repository is rejected (not a working tree)", async () => {
  const repo = path.join(tmp, "bare");
  await mkdir(repo, { recursive: true });
  await runGit(["init", "--bare", repo], { cwd: tmp });
  const err = await expectWorkspaceError("invalid_repository", () => discoverRepoRoot({ cwd: repo }));
  assert.equal(err.message, "The project root is not a valid Git working tree");
});

test("discoverRepoRoot: a repo without commits (no HEAD) is rejected (spec 7)", async () => {
  const repo = await makeRepo("nohead", false);
  const err = await expectWorkspaceError("invalid_repository", () => discoverRepoRoot({ cwd: repo }));
  assert.equal(err.message, "The repository does not have a HEAD commit");
});

test("discoverRepoRoot: override starts discovery from the given directory", async () => {
  const repo = await makeRepo("ovr");
  const root = await discoverRepoRoot({ override: path.join(repo, "x", "y") });
  assert.equal(root, await (await import("node:fs/promises")).realpath(repo));
});

test("discoverRepoRoot: missing override directory falls back to CWD discovery", async () => {
  const repo = await makeRepo("cwd");
  const root = await discoverRepoRoot({ cwd: repo });
  assert.equal(root, await (await import("node:fs/promises")).realpath(repo));
});

// ── computeRepoId ───────────────────────────────────────────────────────────

test("computeRepoId: deterministic, 16 hex, no raw path (spec 70)", () => {
  const a = computeRepoId("/some/repo");
  const b = computeRepoId("/some/repo/"); // sonda slash normalize edilir
  const c = computeRepoId("/other/repo");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes("/"));
});

// ── runGit: güvenli hata kanalı (spec 8) ────────────────────────────────────

test("runGit: failed command → safe fixed message; raw stderr stays in cause only", async () => {
  const repo = await makeRepo("err");
  const err = await expectWorkspaceError("git_operation_failed", () =>
    runGit(["rev-parse", "--verify", "definitely-not-a-ref-xyz"], { cwd: repo }),
  );
  // Message SABİТ (git sürümünden bağımsız) — ham çıktı message'da ASLA yok.
  assert.equal(err.message, "A Git operation failed");
  assert.ok(!err.message.includes("fatal"), "raw git output must not leak into message");
  assert.ok(!err.message.includes("definitely-not-a-ref-xyz"), "raw git output must not leak into message");
  // Teknik kanal (cause) var: ham stderr + çıkış kodu yalnız `cause`'ta taşınır
  // (MCP yüzeyine çıkmaz, yalnız geliştirici log'u). Sürüm-bağımsız: metin içeriği
  // yerine "dolu ve message'dan farklı" denetimi yapılır.
  assert.ok(err.cause !== undefined);
  const stderrText = String((err.cause as { stderr?: unknown }).stderr ?? "");
  assert.ok(stderrText.length > 0, "technical detail belongs in cause");
  assert.ok(!err.message.includes(stderrText.slice(0, 10)), "stderr must not appear in message");
  assert.equal((err.cause as { exitCode?: number }).exitCode, 128);
});

test("runGit: stdout is a raw Buffer (binary-safe)", async () => {
  const repo = await makeRepo("bin");
  const res = await runGit(["rev-parse", "HEAD"], { cwd: repo });
  assert.ok(Buffer.isBuffer(res.stdout));
  assert.match(res.stdout.toString("utf8").trim(), /^[0-9a-f]{40}$/);
});

test("runGit: stdin payload is piped without a shell (git apply via stdin)", async () => {
  const repo = await makeRepo("stdin");
  await writeFile(path.join(repo, "patched.txt"), "before\n");
  await runGit(["add", "patched.txt"], { cwd: repo });
  await runGit(["commit", "-m", "p"], { cwd: repo });
  await writeFile(path.join(repo, "patched.txt"), "after\n");
  const diff = await runGit(["diff", "patched.txt"], { cwd: repo });
  assert.notEqual(diff.stdout.length, 0, "diff üretildi");
  // Dosyayı pre-image durumuna geri al, sonra patch'i STDIN üzerinden uygula
  // (shell pipeline YOK) — içerik gerçekten değişir.
  await runGit(["checkout", "--", "patched.txt"], { cwd: repo });
  const res = await runGit(["apply"], { cwd: repo, stdin: diff.stdout });
  assert.ok(Buffer.isBuffer(res.stdout));
  assert.equal((await readFile(path.join(repo, "patched.txt"))).toString("utf8"), "after\n");
});
