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
import {
  buildGitEnv,
  computeRepoId,
  discoverRepoRoot,
  parseCatFileBatch,
  parseGitVersion,
  partialCloneUnsupported,
  runGit,
} from "../dist/workspace/git.js";

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
  // Message SABİT (git sürümünden bağımsız) — ham çıktı message'da ASLA yok.
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

// ── parseCatFileBatch ───────────────────────────────────────────────────────

test("parseCatFileBatch: size-framed records (incl. newline-filled blobs); malformed/truncated/separator-missing rejected", () => {
  const oidA = "a".repeat(40);
  const oidB = "b".repeat(40);
  const oidC = "c".repeat(40);
  const hello = Buffer.from("hello");
  const abc = Buffer.from("abc");
  const newlines = Buffer.from([0x0a, 0x0a, 0x0a]); // ayracı ANDA içeren binary

  const good = Buffer.concat([
    Buffer.from(`${oidA} blob ${hello.length}\n`, "utf8"),
    hello,
    Buffer.from("\n", "utf8"),
    Buffer.from(`${oidB} blob ${abc.length}\n`, "utf8"),
    abc,
    Buffer.from("\n", "utf8"),
    Buffer.from(`${oidC} blob ${newlines.length}\n`, "utf8"),
    newlines,
    Buffer.from("\n", "utf8"),
  ]);
  const map = parseCatFileBatch(good);
  assert.equal(map.size, 3);
  assert.deepEqual(map.get(oidA), hello);
  assert.deepEqual(map.get(oidB), abc);
  assert.deepEqual(map.get(oidC), newlines, "newline-filled content is framed by the header size, not by separators");

  // kesik gövde (header 10 bayt diyor, 2 bayt var) → güvenli hata
  assert.throws(
    () => parseCatFileBatch(Buffer.concat([Buffer.from(`${oidA} blob 10\n`, "utf8"), Buffer.from("hi")])),
    WorkspaceError,
  );
  // bozuk header → güvenli hata
  assert.throws(() => parseCatFileBatch(Buffer.from("garbage\nxxxx\n")), WorkspaceError);
  // kayıt ayracı eksik (ikisi de olmayan bir bayt) → güvenli hata
  const noSeparator = Buffer.concat([
    Buffer.from(`${oidA} blob ${hello.length}\n`, "utf8"),
    hello,
    Buffer.from("x", "utf8"), // ne \n ne \0
    Buffer.from(`${oidB} blob ${abc.length}\n`, "utf8"),
    abc,
  ]);
  assert.throws(() => parseCatFileBatch(noSeparator), WorkspaceError);
  // boş girdi → boş harita (hata YOK)
  assert.equal(parseCatFileBatch(Buffer.alloc(0)).size, 0);
});

test("parseCatFileBatch: real git cat-file --batch round-trip", async () => {
  const repo = await makeRepo("catbatch");
  const oid = (await runGit(["rev-parse", "HEAD:f.txt"], { cwd: repo })).stdout.toString("utf8").trim();
  assert.match(oid, /^[0-9a-f]{40}$/);
  const res = await runGit(["cat-file", "--batch"], { cwd: repo, stdin: `${oid}\n` });
  const map = parseCatFileBatch(res.stdout);
  assert.deepEqual(map.get(oid), Buffer.from("hello\n"), "blob bytes round-trip exactly");
});

// ── runGit: ortam yalıtımı (inceleme W-H1 / W-M2) ──────────────────────────

test("runGit: inherited repo-local GIT_* variables never redirect a command to another repository; GIT_CONFIG_GLOBAL is kept (W-H1)", async () => {
  const target = await makeRepo("env-target");
  const other = await makeRepo("env-other");
  await runGit(["config", "user.name", "Other User"], { cwd: other });
  const globalFile = path.join(tmp, "env-global-gitconfig");
  await writeFile(globalFile, "[splash]\n\tprobe = kept\n");
  // MCP sürecinin miras alabileceği repo-konumlandırıcı/config değişkenleri
  // (`git rev-parse --local-env-vars` ailesi): hepsi BAŞKA bir repoyu işaret eder.
  const injected: Record<string, string> = {
    GIT_DIR: path.join(other, ".git"),
    GIT_WORK_TREE: other,
    GIT_COMMON_DIR: path.join(other, ".git"),
    GIT_INDEX_FILE: path.join(tmp, "env-no-such-index"),
    GIT_OBJECT_DIRECTORY: path.join(other, ".git", "objects"),
    GIT_CONFIG_PARAMETERS: "'user.name'='Injected Parameters'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Injected Count",
  };
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  let top: string;
  let files: string;
  let userName: string;
  let probe: string;
  try {
    Object.assign(process.env, injected);
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    top = (await runGit(["rev-parse", "--show-toplevel"], { cwd: target })).stdout.toString("utf8").trim();
    files = (await runGit(["ls-files", "-z"], { cwd: target })).stdout.toString("utf8");
    userName = (await runGit(["config", "--get", "user.name"], { cwd: target })).stdout.toString("utf8").trim();
    probe = (await runGit(["config", "--get", "splash.probe"], { cwd: target })).stdout.toString("utf8").trim();
  } finally {
    for (const key of Object.keys(injected)) {
      delete process.env[key];
    }
    process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  }
  const { realpath } = await import("node:fs/promises");
  assert.equal(await realpath(top), await realpath(target), "discovery follows cwd, not an inherited GIT_DIR/GIT_WORK_TREE");
  assert.equal(files, "f.txt\0", "the repository's own index is read (GIT_INDEX_FILE ignored)");
  assert.equal(userName, "Test User", "inherited GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT never inject config");
  assert.equal(probe, "kept", "GIT_CONFIG_GLOBAL stays in effect (hermetic test setups rely on it)");
});

test("runGit: a partial clone never lazy-fetches a missing object from its promisor remote (W-M2)", async (t) => {
  // `GIT_NO_LAZY_FETCH` yalnız onu denetleyen git'te etkili (2.45.1+ ya da
  // yamalı bakım sürümü) — korumasız git'te koruma oluşturma/kurtarma
  // reddidir (MEDIUM-1), bu test o sürümde anlamsız.
  const versionText = (await runGit(["--version"], { cwd: tmp })).stdout.toString("utf8");
  if (partialCloneUnsupported(versionText, true)) {
    t.skip("this git does not honor GIT_NO_LAZY_FETCH");
    return;
  }
  const src = await makeRepo("lazy-src");
  await runGit(["config", "uploadpack.allowFilter", "true"], { cwd: src });
  const dst = path.join(tmp, "lazy-dst");
  await runGit(["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${src}`, dst], { cwd: tmp });
  // Ağaç yerel (blob:none yalnız blob'ları dışarıda bırakır) — blob'un kendisi YOK.
  const oid = (await runGit(["rev-parse", "HEAD:f.txt"], { cwd: dst })).stdout.toString("utf8").trim();
  assert.match(oid, /^[0-9a-f]{40}$/);
  const missingBefore = (await runGit(["rev-list", "--objects", "--all", "--missing=print"], { cwd: dst })).stdout.toString("utf8");
  assert.ok(missingBefore.split("\n").includes(`?${oid}`), "fixture: the clone is really partial (blob missing before the read)");
  // Eksik nesne okuması promisor remote'tan TEMBEL çekme YAPMAZ → güvenli hata.
  await expectWorkspaceError("git_operation_failed", () => runGit(["cat-file", "-e", oid], { cwd: dst }));
  // Nesne hâlâ eksik (`--missing=print` kendisi çekme yapmaz) — ağ/transport çağrısı olmadı.
  const listing = (await runGit(["rev-list", "--objects", "--all", "--missing=print"], { cwd: dst })).stdout.toString("utf8");
  assert.ok(listing.split("\n").includes(`?${oid}`), "the blob must still be missing (no lazy fetch happened)");
});

// ── buildGitEnv / partialCloneUnsupported (inceleme LOW-3 / MEDIUM-1) ─────────

/** `git rev-parse --local-env-vars` (Git 2.50.1) — süzülmesi gereken 15 değişken. */
const LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

test("buildGitEnv: strips the repo-local variables + GIT_CONFIG_KEY_n/VALUE_n, keeps user/system config, fixed safety values beat extra; base is not mutated (LOW-3)", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GIT_CONFIG_GLOBAL: "/g/config",
    GIT_CONFIG_SYSTEM: "/s/config",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Kept Author",
    GIT_CONFIG_KEY_3: "core.worktree",
    GIT_CONFIG_VALUE_3: "/elsewhere",
  };
  for (const name of LOCAL_ENV_VARS) {
    base[name] = "x";
  }
  const env = buildGitEnv(base, {
    GIT_COMMITTER_NAME: "Splash",
    GIT_TERMINAL_PROMPT: "1",
    GIT_NO_LAZY_FETCH: "0",
    LC_ALL: "tr_TR.UTF-8",
  });
  for (const name of [...LOCAL_ENV_VARS, "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_3"]) {
    assert.equal(name in env, false, `${name} must be stripped`);
  }
  for (const name of ["PATH", "HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME"]) {
    assert.equal(env[name], base[name], `${name} must be kept`);
  }
  assert.equal(env.GIT_COMMITTER_NAME, "Splash", "call-site extra is applied");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "fixed value beats extra");
  assert.equal(env.GIT_NO_LAZY_FETCH, "1", "fixed value beats extra");
  assert.equal(env.LC_ALL, "C", "fixed value beats extra");
  assert.equal(base.GIT_DIR, "x", "base must not be mutated");
});

test("buildGitEnv: every variable the live `git rev-parse --local-env-vars` reports is stripped (LOW-3)", async () => {
  const names = (await runGit(["rev-parse", "--local-env-vars"], { cwd: tmp })).stdout
    .toString("utf8")
    .split("\n")
    .filter((name) => name !== "");
  assert.ok(names.includes("GIT_DIR") && names.includes("GIT_WORK_TREE"), "fixture: live list read");
  const env = buildGitEnv(Object.fromEntries(names.map((name) => [name, "x"])));
  for (const name of names) {
    assert.equal(name in env, false, `${name} must be stripped`);
  }
});

test("buildGitEnv: mixed-case repo-local / GIT_CONFIG_KEY_n names are stripped and every safety value is a single upper-case copy (Windows env names are case-insensitive, P1)", () => {
  // Windows'ta `Git_Dir` = `GIT_DIR` (Node child_process belgesi): her harf
  // varyantı süzülmeli; güvenlik sabitlerinin varyantı (base ya da extra'dan)
  // yan yana kalırsa hangisinin kazanacağı belirsiz → sabit TEK kopya olmalı.
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    Git_Dir: "/other/.git",
    git_work_tree: "/other",
    Git_Index_File: "/tmp/no-such-index",
    git_config_count: "1",
    Git_Config_Key_0: "core.worktree",
    git_config_value_0: "/elsewhere",
    Git_Config_Parameters: "'user.name'='Injected'",
    Git_No_Lazy_Fetch: "0",
    git_terminal_prompt: "1",
    Lc_All: "tr_TR.UTF-8",
    Git_Config_Global: "/g/config",
  };
  const env = buildGitEnv(base, {
    git_no_lazy_fetch: "0",
    LC_all: "tr_TR.UTF-8",
    Git_Terminal_Prompt: "1",
    Git_Committer_Name: "Splash",
  });
  const upper = Object.keys(env).map((key) => key.toUpperCase());
  for (const name of LOCAL_ENV_VARS) {
    assert.equal(upper.includes(name), false, `no case variant of ${name} survives`);
  }
  assert.equal(
    upper.some((name) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)),
    false,
    "no case variant of GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n survives",
  );
  for (const [name, value] of [
    ["GIT_TERMINAL_PROMPT", "0"],
    ["LC_ALL", "C"],
    ["GIT_NO_LAZY_FETCH", "1"],
  ] as const) {
    assert.deepEqual(
      Object.keys(env).filter((key) => key.toUpperCase() === name),
      [name],
      `${name}: exactly one (upper-case) copy`,
    );
    assert.equal(env[name], value, `${name}: fixed value`);
  }
  assert.equal(env.Git_Config_Global, "/g/config", "a mixed-case name that is not repo-local is kept as-is");
  assert.equal(env.Git_Committer_Name, "Splash", "call-site extra is applied");
  assert.equal(base.Git_Dir, "/other/.git", "base must not be mutated");
});

test("partialCloneUnsupported: only Git releases whose lazy-fetch path checks GIT_NO_LAZY_FETCH (2.45.1+, patched maintenance releases) allow a promisor repo; unparseable → reject; no promisor → allow (MEDIUM-1, P1)", () => {
  // Sınırlar git etiketlerinden ölçüldü (`promisor-remote.c` `fetch_objects()`):
  // her bakım serisinde ilk yamalı patch kabul, bir öncesi red.
  const cases: Array<readonly [string, boolean, boolean]> = [
    ["git version 1.9.5", true, true],
    ["git version 2.20.1", true, true],
    ["git version 2.38.5", true, true],
    ["git version 2.39.3", true, true],
    ["git version 2.39.4", true, false],
    ["git version 2.39.5 (Apple Git-154)", true, false],
    ["git version 2.40.1", true, true],
    ["git version 2.40.2", true, false],
    ["git version 2.41.0", true, true],
    ["git version 2.41.1", true, false],
    ["git version 2.42.1", true, true],
    ["git version 2.42.2", true, false],
    ["git version 2.43.0", true, true],
    ["git version 2.43.3", true, true],
    ["git version 2.43.4", true, false],
    ["git version 2.44", true, true],
    ["git version 2.44.0", true, true],
    ["git version 2.44.0.windows.1", true, true],
    ["git version 2.44.1", true, false],
    ["git version 2.45.0", true, true],
    ["git version 2.45.1", true, false],
    ["git version 2.45.1.windows.1", true, false],
    ["git version 2.46.0", true, false],
    ["git version 2.50.1 (Apple Git-155)", true, false],
    ["git version 3.0.0", true, false],
    ["", true, true],
    ["not git at all", true, true],
    ["git version 2.38.5", false, false],
    ["git version 2.45.0", false, false],
    ["", false, false],
    ["git version 2.50.1", false, false],
  ];
  for (const [version, promisor, expected] of cases) {
    assert.equal(partialCloneUnsupported(version, promisor), expected, `${JSON.stringify(version)} promisor=${promisor}`);
  }
  // Apple Git ön eki: sayısal sürüm parantez öncesinden okunur.
  assert.deepEqual(parseGitVersion("git version 2.39.5 (Apple Git-154)"), [2, 39, 5]);
  assert.deepEqual(parseGitVersion("git version 2.44"), [2, 44, 0]);
  assert.equal(parseGitVersion("not git at all"), null);
});
