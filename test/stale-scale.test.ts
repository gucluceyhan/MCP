/**
 * İz 5 — stale ÖLÇEĞİ (kullanıcı kararı K1) + EOL asimetrisi.
 *
 * Gerçek git + gerçek MCP runtime (sahte backend/kilit). Her senaryo
 * task → refine → close zincirini koşar ve şunu doğrular: ana working
 * tree'de HİÇBİR ŞEY değişmediyse taban `fresh` kalır. Kök neden: taban
 * parmak izi eskiden worktree dosyasından alınıyordu (git'in yazdığı
 * bayt/mod), canlı ölçüm ise ana dosyadan — `core.fileMode=false`,
 * `text=auto`/`autocrlf=input` ve `skip-worktree`/`assume-unchanged`
 * iki tarafı kalıcı olarak ayırır (sahte `stale_base`).
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSplashRuntime, type SplashRuntime } from "../dist/server.js";
import { InferenceCoordinator, type RuntimeLockLike } from "../dist/backend/InferenceCoordinator.js";
import type { LockAcquireResult } from "../dist/backend/RuntimeLock.js";
import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
  RuntimeInfo,
} from "../dist/backend/InferenceBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import type { SplashConfig } from "../dist/config.js";
import { createGitWorktreeWorkspace, setLiveCaptureSeams, setWorkspaceFs } from "../dist/workspace/GitWorktreeWorkspace.js";
import { noFollowReadFile } from "../dist/workspace/SafeRepoReader.js";
import { WorkspaceError, type Workspace, type WorkspaceCreateInput } from "../dist/workspace/Workspace.js";

const GIT_ENV_KEYS = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

interface Fixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  sessionsDir: string;
  config: SplashConfig;
}

/** `src/a.ts` (LF) commit'li minimal repo; senaryo kendi ayarını üstüne ekler. */
async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-stale-scale-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const key of GIT_ENV_KEYS) {
      delete process.env[key];
    }
  });
  await writeFile(path.join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GIT_AUTHOR_NAME = "Splash Stale Scale";
  process.env.GIT_AUTHOR_EMAIL = "stale@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Stale Scale";
  process.env.GIT_COMMITTER_EMAIL = "stale@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(repoRoot, "src/a.ts"), "const value = 1;\nconst tail = 0;\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "base");

  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot);
  return {
    root,
    repoRoot,
    outputRoot,
    sessionsDir: path.join(outputRoot, "sessions"),
    config: {
      backend: { baseUrl: "http://127.0.0.1:8123", model: "fixture-model" },
      repoRoot,
      outputRoot,
      maxRounds: 10,
      context: {
        tiers: [65_536, 131_072, 196_608],
        minOutputReserve: 32_768,
        preferredOutputReserve: 65_536,
        rulesSoftBudget: 8_192,
      },
    },
  };
}

class FakeBackend implements InferenceBackend {
  #current: RuntimeInfo | null = null;
  runBehavior: () => Promise<InferenceResult> = async () => {
    throw new Error("runBehavior not configured");
  };
  runCalls = 0;
  get runtimeInfo(): RuntimeInfo | null {
    return this.#current;
  }
  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    if (signal?.aborted) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    this.#current = { ready: true, maximumContextTokens: 128_000, servedModel: "fixture-model", runtimeProcessId: 4242 };
    return this.#current;
  }
  lastMessages: InferenceMessage[] = [];
  async run(messages: InferenceMessage[], _options?: InferenceRunOptions): Promise<InferenceResult> {
    this.runCalls += 1;
    this.lastMessages = messages;
    return this.runBehavior();
  }
  async tokenize(): Promise<{ tokens: number[]; count: number }> {
    return { tokens: [], count: 0 };
  }
  async renderPrompt(): Promise<never> {
    throw new Error("renderPrompt must not be called");
  }
  async countPromptTokens(): Promise<number> {
    return 1_000;
  }
}

class FakeLock implements RuntimeLockLike {
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    return { acquired: true, token: `tok-${ownerId}` };
  }
  async release(_token: string): Promise<void> {}
}

interface Runtime {
  client: Client;
  runtime: SplashRuntime;
  backend: FakeBackend;
}

async function makeRuntime(
  t: TestContext,
  fixture: Fixture,
  createWorkspace?: (input: WorkspaceCreateInput) => Promise<Workspace>,
): Promise<Runtime> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const backend = new FakeBackend();
  const runtime = createSplashRuntime(fixture.config, {
    backend,
    coordinator: new InferenceCoordinator({
      backend,
      runtimeDir: path.join(fixture.outputRoot, "runtime"),
      scanner: async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }],
      lock: new FakeLock(),
    }),
    processCwd: () => fixture.repoRoot,
    ...(createWorkspace !== undefined ? { createWorkspace } : {}),
  });
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: "splash-stale-scale", version: "0.0.1" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await runtime.server.close().catch(() => undefined);
    await runtime.dispose().catch(() => undefined);
  });
  return { client, runtime, backend };
}

interface WireContent {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface CallResult {
  isError: boolean;
  json: Record<string, unknown>;
}

async function call(rt: Runtime, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = (await rt.client.callTool({ name, arguments: args })) as WireContent;
  const text = res.content?.[0]?.text ?? "";
  return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

function modify(filePath: string, search: string, replace: string): () => Promise<InferenceResult> {
  return async () => ({
    content: JSON.stringify({
      schema_version: 1,
      summary: "Edit.",
      edits: [{ kind: "modify", path: filePath, operations: [{ search, replace }] }],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

/** task → refine → close; ana working tree adımlar arasında DEĞİŞMEZ. */
async function taskRefineClose(
  t: TestContext,
  fixture: Fixture,
  filePath: string,
): Promise<{ refine: CallResult; close: Record<string, unknown>; rt: Runtime }> {
  const rt = await makeRuntime(t, fixture);
  rt.backend.runBehavior = modify(filePath, "const value = 1;", "const value = 2;");
  const task = await call(rt, "splash_task", { task: "Change the value", files: [filePath] });
  assert.equal(task.isError, false, JSON.stringify(task.json));
  assert.equal(task.json.status, "applied", JSON.stringify(task.json));
  const sessionId = task.json.session_id as string;

  rt.backend.runBehavior = modify(filePath, "const value = 1;", "const value = 3;");
  const refine = await call(rt, "splash_refine", { session_id: sessionId, feedback: "again" });

  const close = await call(rt, "splash_close", { session_id: sessionId });
  assert.equal(close.isError, false, JSON.stringify(close.json));
  return { refine, close: close.json, rt };
}

function assertFreshChain(result: { refine: CallResult; close: Record<string, unknown> }): void {
  assert.equal(result.refine.isError, false, JSON.stringify(result.refine.json));
  assert.equal(result.refine.json.status, "applied", JSON.stringify(result.refine.json));
  assert.equal(result.refine.json.base_status, "fresh");
  assert.equal(result.close.base_status, "fresh", JSON.stringify(result.close));
}

// ── (a) core.fileMode=false + chmod +x (blob 100644) ────────────────────────

test("İz5 (a): core.fileMode=false + tracked chmod +x — unchanged main stays fresh (refine applies, close fresh)", async (t) => {
  const fixture = await makeFixture(t);
  git(fixture.repoRoot, "config", "core.fileMode", "false");
  await chmod(path.join(fixture.repoRoot, "src/a.ts"), 0o755);
  // Git açısından temiz (fileMode=false): mod farkı delta'ya GİRMEZ.
  assert.equal(git(fixture.repoRoot, "status", "--porcelain"), "");
  assertFreshChain(await taskRefineClose(t, fixture, "src/a.ts"));
});

// ── (b) text=auto / autocrlf=input + CRLF working copy (blob LF) ─────────────

async function crlfTrackedFixture(t: TestContext, variant: "text=auto" | "autocrlf=input"): Promise<Fixture> {
  const fixture = await makeFixture(t);
  if (variant === "text=auto") {
    await writeFile(path.join(fixture.repoRoot, ".gitattributes"), "* text=auto\n");
    git(fixture.repoRoot, "add", ".gitattributes");
    git(fixture.repoRoot, "commit", "-m", "attrs");
  } else {
    git(fixture.repoRoot, "config", "core.autocrlf", "input");
  }
  // Blob LF; working kopya CRLF (Windows editörü / kopyalanmış dosya).
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\r\nconst tail = 0;\r\n");
  return fixture;
}

for (const variant of ["text=auto", "autocrlf=input"] as const) {
  test(`İz5 (b): ${variant} + tracked CRLF working copy (blob LF) — unchanged main stays fresh`, async (t) => {
    const fixture = await crlfTrackedFixture(t, variant);
    assertFreshChain(await taskRefineClose(t, fixture, "src/a.ts"));
  });
}

test("İz5 (b) kontrol: text=auto CRLF main — REAL drift (content edit after task) is still stale", async (t) => {
  const fixture = await crlfTrackedFixture(t, "text=auto");
  const rt = await makeRuntime(t, fixture);
  rt.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
  const task = await call(rt, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
  assert.equal(task.json.status, "applied");
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\r\nconst tail = 9;\r\n");
  rt.backend.runBehavior = async () => {
    throw new Error("inference must not run for a stale base");
  };
  const refine = await call(rt, "splash_refine", { session_id: task.json.session_id, feedback: "again" });
  assert.equal(refine.json.status, "stale_base", JSON.stringify(refine.json));
  assert.deepEqual(refine.json.stale_files, ["src/a.ts"]);
  assert.equal(rt.backend.runCalls, 1);
});

test("İz5 (b) kontrol: text=auto CRLF main — EOL-only drift (CRLF → LF) is stale (working-file bytes are the scale)", async (t) => {
  const fixture = await crlfTrackedFixture(t, "text=auto");
  const rt = await makeRuntime(t, fixture);
  rt.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
  const task = await call(rt, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
  assert.equal(task.json.status, "applied");
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\nconst tail = 0;\n");
  const refine = await call(rt, "splash_refine", { session_id: task.json.session_id, feedback: "again" });
  assert.equal(refine.json.status, "stale_base", JSON.stringify(refine.json));
});

// ── (c) assume-unchanged / skip-worktree + local change (HIGH-1) ─────────────
//
// Git yerel değişikliği gizler (`git diff HEAD` boş) → K1 öncesi taban HEAD
// içeriğiydi (worker main'in gerçek hâlini görmüyordu). DESIGN §7.3
// invariantı: taban = ana working tree → yerel baytlar tabana alınır.

/** Ana repo KOPYASINA (varsayılan config) patch'i uygular; sonucu döner. */
async function applyToMainCopy(fixture: Fixture, patchPath: string, file: string): Promise<{ applied: boolean; content: string }> {
  const copy = path.join(fixture.root, "copy");
  await cp(fixture.repoRoot, copy, { recursive: true, verbatimSymlinks: true });
  let applied = true;
  try {
    git(copy, "apply", patchPath);
  } catch {
    applied = false;
  }
  return { applied, content: await readFile(path.join(copy, file), "utf8") };
}

for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
  test(`İz5 (c): ${flag} + overlapping local change — base = MAIN bytes (worker sees them), fresh, patch applies cleanly to main`, async (t) => {
    const fixture = await makeFixture(t);
    git(fixture.repoRoot, "update-index", flag, "src/a.ts");
    const local = "const value = 1; // local\nconst tail = 0;\n";
    await writeFile(path.join(fixture.repoRoot, "src/a.ts"), local);
    assert.equal(git(fixture.repoRoot, "diff", "HEAD", "--name-only"), "", "git does not see the local change");

    // Taban (worker görünümü) yerel baytları taşır.
    const ws = await createGitWorktreeWorkspace({
      repoRoot: fixture.repoRoot,
      workspaceDir: path.join(fixture.root, "ws-view"),
      sessionId: "view-1",
      editablePaths: ["src/a.ts"],
    });
    const entry = ws.readBaseEntry("src/a.ts");
    assert.ok(entry.exists && entry.type === "file");
    assert.equal(entry.content.toString("utf8"), local);
    await ws.destroy();

    const result = await taskRefineClose(t, fixture, "src/a.ts");
    assertFreshChain(result);
    assert.ok(JSON.stringify(result.rt.backend.lastMessages).includes("// local"), "worker prompt carries the local change");
    const outcome = await applyToMainCopy(fixture, result.close.patch_path as string, "src/a.ts");
    assert.equal(outcome.applied, true, "patch applies cleanly to the main working file");
    assert.equal(outcome.content, "const value = 3; // local\nconst tail = 0;\n");
  });
}

for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
  test(`İz5 (c) MEDIUM-A: ${flag} + mode-only local change (fileMode=true, chmod +x) — base mode = MAIN mode; patch applies to main without a mode mismatch`, async (t) => {
    const fixture = await makeFixture(t);
    git(fixture.repoRoot, "config", "core.fileMode", "true");
    git(fixture.repoRoot, "update-index", flag, "src/a.ts");
    await chmod(path.join(fixture.repoRoot, "src/a.ts"), 0o755);
    assert.equal(git(fixture.repoRoot, "diff", "HEAD", "--name-only"), "", "git does not see the mode change");

    const ws = await createGitWorktreeWorkspace({
      repoRoot: fixture.repoRoot,
      workspaceDir: path.join(fixture.root, "ws-view"),
      sessionId: "mode-1",
      editablePaths: ["src/a.ts"],
    });
    const entry = ws.readBaseEntry("src/a.ts");
    assert.ok(entry.exists && entry.type === "file");
    assert.equal(entry.mode, "100755", "base mode follows the MAIN file");
    await ws.destroy();

    const result = await taskRefineClose(t, fixture, "src/a.ts");
    assertFreshChain(result);
    const patchPath = result.close.patch_path as string;
    const patch = await readFile(patchPath, "utf8");
    t.diagnostic(`patch header: ${JSON.stringify(patch.split("\n").slice(0, 3))}`);
    const copy = path.join(fixture.root, "copy");
    await cp(fixture.repoRoot, copy, { recursive: true, verbatimSymlinks: true });
    const applied = spawnSync("git", ["apply", patchPath], { cwd: copy, encoding: "utf8" });
    t.diagnostic(`git apply exit=${applied.status} stderr=${JSON.stringify(applied.stderr)}`);
    assert.equal(applied.status, 0);
    assert.equal(applied.stderr, "", "no 'has type 100755, expected 100644' mismatch");
    assert.match(patch, /^index [0-9a-f]+\.\.[0-9a-f]+ 100755$/m, "patch records the main file's mode");
    assert.equal((await lstat(path.join(copy, "src/a.ts"))).mode & 0o777, 0o755);
    assert.equal(await readFile(path.join(copy, "src/a.ts"), "utf8"), "const value = 3;\nconst tail = 0;\n");
  });
}

test("İz5 (c) sparse benzeri: skip-worktree path ABSENT in main but present in HEAD → creation rejected (fixed message), no worktree left", async (t) => {
  const fixture = await makeFixture(t);
  git(fixture.repoRoot, "update-index", "--skip-worktree", "src/a.ts");
  await unlink(path.join(fixture.repoRoot, "src/a.ts"));
  assert.equal(git(fixture.repoRoot, "diff", "HEAD", "--name-only"), "", "git does not see the deletion");
  await assert.rejects(
    createGitWorktreeWorkspace({
      repoRoot: fixture.repoRoot,
      workspaceDir: path.join(fixture.root, "ws"),
      sessionId: "sparse-1",
      editablePaths: ["src/a.ts"],
    }),
    (e: unknown) =>
      e instanceof WorkspaceError && e.kind === "invalid_repository" && e.message === "A selected file differs from Git's view of it",
  );
  assert.equal(await worktreeCount(fixture.repoRoot), 1, "half-built worktree removed");
});

// ── W-M6: text=auto + UNTRACKED CRLF editable → 2. tur reset --hard LF yazar ─

test("İz5 W-M6: text=auto + untracked CRLF editable — later rounds must not fail with drift (session survives)", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.repoRoot, ".gitattributes"), "* text=auto\n");
  git(fixture.repoRoot, "add", ".gitattributes");
  git(fixture.repoRoot, "commit", "-m", "attrs");
  await writeFile(path.join(fixture.repoRoot, "src/new.ts"), "const value = 1;\r\nconst tail = 0;\r\n");

  const rt = await makeRuntime(t, fixture);
  rt.backend.runBehavior = modify("src/new.ts", "const value = 1;", "const value = 2;");
  const task = await call(rt, "splash_task", { task: "Change the value", files: ["src/new.ts"] });
  assert.equal(task.isError, false, JSON.stringify(task.json));
  assert.equal(task.json.status, "applied", JSON.stringify(task.json));
  const sessionId = task.json.session_id as string;
  const wsFile = path.join(fixture.sessionsDir, sessionId, "workspace/src/new.ts");
  assert.equal(await readFile(wsFile, "utf8"), "const value = 2;\r\nconst tail = 0;\r\n");

  rt.backend.runBehavior = modify("src/new.ts", "const value = 1;", "const value = 3;");
  const refine = await call(rt, "splash_refine", { session_id: sessionId, feedback: "again" });
  assert.equal(refine.isError, false, JSON.stringify(refine.json));
  assert.equal(refine.json.status, "applied", JSON.stringify(refine.json));
  assert.equal(refine.json.base_status, "fresh");
  // Worker'ın gördüğü (CRLF) baytlar korunur: tam ikame CRLF tabana uygulanır.
  assert.equal(await readFile(wsFile, "utf8"), "const value = 3;\r\nconst tail = 0;\r\n");

  // Restart sonrası kurtarma (hayatta worktree reuse) + bir tur daha.
  await rt.runtime.dispose();
  const rt2 = await makeRuntime(t, fixture);
  rt2.backend.runBehavior = modify("src/new.ts", "const value = 1;", "const value = 4;");
  const again = await call(rt2, "splash_refine", { session_id: sessionId, feedback: "once more" });
  assert.equal(again.isError, false, JSON.stringify(again.json));
  assert.equal(again.json.status, "applied", JSON.stringify(again.json));
  assert.equal(await readFile(wsFile, "utf8"), "const value = 4;\r\nconst tail = 0;\r\n");
});

// ── 4: CRLF main'e export patch'inin `git apply` ile uygulanması (ÖLÇÜM) ─────

test("İz5 ölçüm 4: exported patch vs CRLF main working copy (text=auto, blob LF) — `git apply` on a copy", async (t) => {
  const fixture = await crlfTrackedFixture(t, "text=auto");
  const { close } = await taskRefineClose(t, fixture, "src/a.ts");
  const patchPath = close.patch_path as string;
  const patch = await readFile(patchPath, "utf8");
  assert.ok(!patch.includes("\r"), "export patch is in the blob (LF) scale");

  // Ana repoya DOKUNMADAN kopyada uygula.
  const copy = path.join(fixture.root, "copy");
  await cp(fixture.repoRoot, copy, { recursive: true, verbatimSymlinks: true });
  let applied = true;
  try {
    git(copy, "apply", patchPath);
  } catch {
    applied = false;
  }
  const after = await readFile(path.join(copy, "src/a.ts"), "utf8");
  t.diagnostic(`git apply → ${applied ? "applied" : "rejected"}; result=${JSON.stringify(after)}`);
  assert.equal(applied, true, "git apply renormalizes the CRLF working copy (text=auto) and applies");
  assert.equal(after, "const value = 3;\nconst tail = 0;\n", "result is written in the checkout EOL (LF): whole-file EOL churn");
  // Ana working tree aynen kaldı.
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\r\nconst tail = 0;\r\n");
});

// ── K1 mekanizması: oluşturmada ana dosyadan iki okuma ─────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function worktreeCount(repoRoot: string): Promise<number> {
  return git(repoRoot, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
}

test("İz5 K1 ölçek: liveFingerprints = MAIN working file (CRLF bytes, 100755); worker/validation view stays the worktree bytes", async (t) => {
  const fixture = await crlfTrackedFixture(t, "text=auto");
  git(fixture.repoRoot, "config", "core.fileMode", "false");
  await chmod(path.join(fixture.repoRoot, "src/a.ts"), 0o755);
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repoRoot,
    workspaceDir: path.join(fixture.root, "ws"),
    sessionId: "scale-1",
    editablePaths: ["src/a.ts"],
  });
  t.after(() => ws.destroy().catch(() => undefined));
  assert.deepEqual(ws.base.liveFingerprints?.get("src/a.ts"), {
    exists: true,
    type: "file",
    mode: "100755",
    contentSha256: sha256("const value = 1;\r\nconst tail = 0;\r\n"),
  });
  // Worktree ölçeği (worker görünümü + doğrulama): içerik git'in yazdığı LF —
  // uzlaştırma blob oid'leri eşit (yalnız normalizasyon) gördüğü için baytı
  // KOPYALAMAZ; mod içerikten bağımsız ana dosyaya aynalanır (MEDIUM-A).
  assert.deepEqual(ws.base.fingerprints.get("src/a.ts"), {
    exists: true,
    type: "file",
    mode: "100755",
    contentSha256: sha256("const value = 1;\nconst tail = 0;\n"),
  });
  const entry = ws.readBaseEntry("src/a.ts");
  assert.ok(entry.exists && entry.type === "file");
  assert.equal(entry.content.toString("utf8"), "const value = 1;\nconst tail = 0;\n");
});

test("İz5 K1 yarış: main changes between the two creation reads → creation rejected (fixed message), worktree removed, main untouched", async (t) => {
  const fixture = await makeFixture(t);
  let reads = 0;
  t.after(() => setLiveCaptureSeams(null));
  setLiveCaptureSeams({
    readFile: async (target) => {
      reads += 1;
      const bytes = await noFollowReadFile(target);
      return reads === 1 ? bytes : Buffer.concat([bytes, Buffer.from("// raced\n")]);
    },
  });
  const wsDir = path.join(fixture.root, "ws");
  await assert.rejects(
    createGitWorktreeWorkspace({ repoRoot: fixture.repoRoot, workspaceDir: wsDir, sessionId: "race-1", editablePaths: ["src/a.ts"] }),
    (e: unknown) =>
      e instanceof WorkspaceError &&
      e.kind === "workspace_operation_failed" &&
      e.message === "The repository changed while the session base was being captured",
  );
  assert.equal(reads, 2, "one read before the working-tree delta, one after the base commit");
  assert.equal(await worktreeCount(fixture.repoRoot), 1, "half-built worktree removed");
  assert.deepEqual(await readdir(fixture.root).then((entries) => entries.includes("ws")), false);
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\nconst tail = 0;\n");
  assert.equal(git(fixture.repoRoot, "status", "--porcelain"), "");
});

test("İz5 K1 sıralama (okuma 2): the second read runs after the base commit", async (t) => {
  const fixture = await makeFixture(t);
  const headSha = git(fixture.repoRoot, "rev-parse", "HEAD").trim();
  const wsDir = path.join(fixture.root, "ws");
  let reads = 0;
  let headAtRead2: string | null = null;
  t.after(() => setLiveCaptureSeams(null));
  setLiveCaptureSeams({
    readFile: async (target) => {
      reads += 1;
      if (reads === 2) {
        headAtRead2 = git(wsDir, "rev-parse", "HEAD").trim();
      }
      return noFollowReadFile(target);
    },
  });
  const ws = await createGitWorktreeWorkspace({ repoRoot: fixture.repoRoot, workspaceDir: wsDir, sessionId: "order-1", editablePaths: ["src/a.ts"] });
  t.after(() => ws.destroy().catch(() => undefined));
  assert.equal(reads, 2);
  assert.notEqual(headAtRead2, headSha, "read 2 runs after the base commit");
  assert.equal(headAtRead2, ws.baseCommit);
});

// Okuma 1'in delta'dan ÖNCE olduğu: okuma 1'den HEMEN sonraki değişikliği
// delta yakalar → uzlaştırma (okuma 2'den ÖNCE) referanstan sapmayı ve taze
// ana hâlin de saptığını görür → yarış reddi `reads === 1` ile gelir. Okuma 1
// delta'dan sonra olsaydı delta referansı taşır, red ancak okuma 2'de gelirdi.
for (const kind of ["content", "mode"] as const) {
  test(`İz5 K1 sıralama (okuma 1, ${kind}): a change right after read 1 is caught by the reconcile step (read 1 precedes the delta) — creation rejected`, async (t) => {
    const fixture = await makeFixture(t);
    git(fixture.repoRoot, "config", "core.fileMode", "true");
    const mainFile = path.join(fixture.repoRoot, "src/a.ts");
    const wsDir = path.join(fixture.root, "ws");
    let reads = 0;
    t.after(() => setLiveCaptureSeams(null));
    setLiveCaptureSeams({
      readFile: async (target) => {
        reads += 1;
        const bytes = await noFollowReadFile(target);
        if (reads === 1) {
          if (kind === "content") {
            await writeFile(mainFile, "const value = 7;\nconst tail = 0;\n");
          } else {
            await chmod(mainFile, 0o755);
          }
        }
        return bytes;
      },
    });
    await assert.rejects(
      createGitWorktreeWorkspace({ repoRoot: fixture.repoRoot, workspaceDir: wsDir, sessionId: `order-${kind}`, editablePaths: ["src/a.ts"] }),
      (e: unknown) =>
        e instanceof WorkspaceError &&
        e.kind === "workspace_operation_failed" &&
        e.message === "The repository changed while the session base was being captured",
    );
    assert.equal(reads, 1, "rejected by the reconcile step, before read 2");
    assert.equal(await worktreeCount(fixture.repoRoot), 1, "half-built worktree removed");
  });
}

test("İz5 K1 yakalama hatası: unreadable main file → workspace_operation_failed before any worktree exists", async (t) => {
  const fixture = await makeFixture(t);
  t.after(() => setLiveCaptureSeams(null));
  setLiveCaptureSeams({
    readFile: async () => {
      throw Object.assign(new Error("EACCES (fault-injected)"), { code: "EACCES" });
    },
  });
  await assert.rejects(
    createGitWorktreeWorkspace({
      repoRoot: fixture.repoRoot,
      workspaceDir: path.join(fixture.root, "ws"),
      sessionId: "eacces-1",
      editablePaths: ["src/a.ts"],
    }),
    (e: unknown) =>
      e instanceof WorkspaceError && e.kind === "workspace_operation_failed" && e.message === "Capturing the repository state failed",
  );
  assert.equal(await worktreeCount(fixture.repoRoot), 1);
});

test("İz5 K1: absent editable path under a symlinked ancestor is rejected at creation (live capture would be the sentinel)", async (t) => {
  const fixture = await makeFixture(t);
  await symlink("src", path.join(fixture.repoRoot, "lnk"));
  git(fixture.repoRoot, "add", "lnk");
  git(fixture.repoRoot, "commit", "-m", "link");
  // Önceden var olan BOŞ workspace dizini: red worktree kurulmadan ÖNCE
  // gelirse dizin olduğu gibi kalır (kurulmuş worktree'nin temizliği onu siler).
  const wsDir = path.join(fixture.root, "ws");
  await mkdir(wsDir);
  await assert.rejects(
    createGitWorktreeWorkspace({
      repoRoot: fixture.repoRoot,
      workspaceDir: wsDir,
      sessionId: "lnk-1",
      editablePaths: ["lnk/new.ts"],
    }),
    (e: unknown) => e instanceof WorkspaceError && e.kind === "unsafe_path" && e.message === "A selected path is unsafe",
  );
  assert.equal(await worktreeCount(fixture.repoRoot), 1);
  assert.deepEqual(await readdir(wsDir), [], "rejected at the live capture — no worktree was ever created");
});

// ── K1 kalıcılık: v2 alanı + v1 okuma uyumu (uçtan uca) ─────────────────────

async function readSession(fixture: Fixture, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(fixture.sessionsDir, sessionId, "session.json"), "utf8")) as Record<string, unknown>;
}

test("İz5 K1: splash_task persists schemaVersion 2 + liveBaseFingerprints from the MAIN file", async (t) => {
  const fixture = await crlfTrackedFixture(t, "text=auto");
  const rt = await makeRuntime(t, fixture);
  rt.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
  const task = await call(rt, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
  assert.equal(task.json.status, "applied");
  const persisted = await readSession(fixture, task.json.session_id as string);
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.liveBaseFingerprints, [
    ["src/a.ts", { exists: true, type: "file", mode: "100644", contentSha256: sha256("const value = 1;\r\nconst tail = 0;\r\n") }],
  ]);
});

/** Kalıcı v2 oturumu Step 9/10 (v1) biçimine indirger — eski diskteki oturum. */
async function downgradeToV1(fixture: Fixture, sessionId: string): Promise<void> {
  const file = path.join(fixture.sessionsDir, sessionId, "session.json");
  const persisted = await readSession(fixture, sessionId);
  persisted.schemaVersion = 1;
  delete persisted.liveBaseFingerprints;
  await writeFile(file, JSON.stringify(persisted, null, 2), { mode: 0o600 });
}

test("İz5 K1 v1 uyumu: a v1 session (no live field) stays readable and keeps the OLD worktree-scale stale reference", async (t) => {
  // (1) Sapmasız repo: v1 oturumu yüklenir, refine + close normal çalışır, v1 kalır.
  const plain = await makeFixture(t);
  const a = await makeRuntime(t, plain);
  a.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
  const task = await call(a, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
  const sessionId = task.json.session_id as string;
  await a.runtime.dispose();
  await downgradeToV1(plain, sessionId);
  const b = await makeRuntime(t, plain);
  b.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 3;");
  const refine = await call(b, "splash_refine", { session_id: sessionId, feedback: "again" });
  assert.equal(refine.isError, false, JSON.stringify(refine.json));
  assert.equal(refine.json.status, "applied", JSON.stringify(refine.json));
  const after = await readSession(plain, sessionId);
  assert.equal(after.schemaVersion, 1, "a v1 session is re-saved as v1");
  assert.ok(!("liveBaseFingerprints" in after));
  const close = await call(b, "splash_close", { session_id: sessionId });
  assert.equal(close.json.base_status, "fresh", JSON.stringify(close.json));

  // (2) CRLF repo: v1 referansı worktree parmak izi → eski (sahte) stale aynen.
  const crlf = await crlfTrackedFixture(t, "text=auto");
  const c = await makeRuntime(t, crlf);
  c.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
  const task2 = await call(c, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
  const sessionId2 = task2.json.session_id as string;
  await c.runtime.dispose();
  await downgradeToV1(crlf, sessionId2);
  const d = await makeRuntime(t, crlf);
  const stale = await call(d, "splash_refine", { session_id: sessionId2, feedback: "again" });
  assert.equal(stale.json.status, "stale_base", "v1 keeps the legacy reference (documented limitation)");
});

for (const variant of ["missing", "path-set-mismatch"] as const) {
  test(`İz5 K1: a workspace factory with ${variant} liveFingerprints fails the task closed (session_operation_failed, no orphan)`, async (t) => {
    const fixture = await makeFixture(t);
    const stripped = async (input: WorkspaceCreateInput): Promise<Workspace> => {
      const real = await createGitWorktreeWorkspace(input);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "base") {
            const base = { fingerprints: target.base.fingerprints, basePaths: target.base.basePaths };
            return variant === "missing" ? base : { ...base, liveFingerprints: new Map() };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as Workspace;
    };
    const rt = await makeRuntime(t, fixture, stripped);
    rt.backend.runBehavior = modify("src/a.ts", "const value = 1;", "const value = 2;");
    const res = await call(rt, "splash_task", { task: "Change the value", files: ["src/a.ts"] });
    assert.equal(res.isError, true);
    assert.deepEqual(res.json, { kind: "session_operation_failed", message: "The session operation failed" });
    assert.equal(rt.backend.runCalls, 0);
    assert.equal(await worktreeCount(fixture.repoRoot), 1, "workspace destroyed");
    const sessions = await readdir(fixture.sessionsDir).catch(() => [] as string[]);
    assert.deepEqual(sessions, [], "no orphan session");
  });
}

// ── LOW-4: normalize olmayan repoda W-M6 restore'u HİÇ yazmaz ──────────────

test("İz5 W-M6 sınırı: in a non-normalized repo the post-reset restore writes nothing across rounds", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.repoRoot, "src/new.ts"), "const value = 1;\nconst tail = 0;\n"); // untracked editable
  let writes = 0;
  t.after(() => setWorkspaceFs(null));
  setWorkspaceFs({
    lstat,
    unlink,
    mkdir: (target, options) => mkdir(target, options).then(() => undefined),
    writeFile: async (target, data) => {
      writes += 1;
      await writeFile(target, data);
    },
    chmod,
  });
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repoRoot,
    workspaceDir: path.join(fixture.root, "ws"),
    sessionId: "count-1",
    editablePaths: ["src/a.ts", "src/new.ts"],
  });
  t.after(() => ws.destroy().catch(() => undefined));
  for (const value of ["2", "3", "4"]) {
    const result = await ws.applyPatchSet({
      schemaVersion: 1,
      summary: "Edit.",
      edits: [
        { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace: `const value = ${value};` }] },
        { kind: "modify", path: "src/new.ts", operations: [{ search: "const value = 1;", replace: `const value = ${value};` }] },
      ],
    });
    assert.equal(result.validation.editsApplied, 2);
  }
  assert.equal(writes, 0, "restore is a no-op when git did not normalize anything");
});

// ── LOW-2 ÖLÇÜMÜ: `diff.autoRefreshIndex=false` + W-M6 restore → stat-dirty ──

test("İz5 LOW-2 (ölçüldü → düzeltildi): diff.autoRefreshIndex=false — a restored (unmodified this round) CRLF file is not reported as changed", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.repoRoot, ".gitattributes"), "* text=auto\n");
  git(fixture.repoRoot, "add", ".gitattributes");
  git(fixture.repoRoot, "commit", "-m", "attrs");
  git(fixture.repoRoot, "config", "diff.autoRefreshIndex", "false");
  await writeFile(path.join(fixture.repoRoot, "src/new.ts"), "const value = 1;\r\nconst tail = 0;\r\n");
  await writeFile(path.join(fixture.repoRoot, "src/other.ts"), "const other = 1;\r\n");
  const ws = await createGitWorktreeWorkspace({
    repoRoot: fixture.repoRoot,
    workspaceDir: path.join(fixture.root, "ws"),
    sessionId: "refresh-1",
    editablePaths: ["src/new.ts", "src/other.ts"],
  });
  t.after(() => ws.destroy().catch(() => undefined));
  // Tur 1: other.ts değişir. Tur 2: yalnız new.ts — reset other.ts'i LF yazar, restore CRLF'ye döndürür.
  await ws.applyPatchSet({
    schemaVersion: 1,
    summary: "r1",
    edits: [{ kind: "modify", path: "src/other.ts", operations: [{ search: "const other = 1;", replace: "const other = 2;" }] }],
  });
  const round2 = await ws.applyPatchSet({
    schemaVersion: 1,
    summary: "r2",
    edits: [{ kind: "modify", path: "src/new.ts", operations: [{ search: "const value = 1;", replace: "const value = 2;" }] }],
  });
  t.diagnostic(`filesChanged=${JSON.stringify(round2.filesChanged)} diffStats=${JSON.stringify(round2.diffStats)}`);
  assert.deepEqual(round2.filesChanged, ["src/new.ts"]);
  assert.deepEqual(round2.diffStats, { files: 1, insertions: 1, deletions: 1 });
  assert.equal(await readFile(path.join(fixture.root, "ws/src/other.ts"), "utf8"), "const other = 1;\r\n", "restored to base bytes");
});
