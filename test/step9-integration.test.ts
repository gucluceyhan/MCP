import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSplashRuntime, type SplashRuntime } from "../dist/server.js";
import { InferenceCoordinator, type RuntimeLockLike } from "../dist/backend/InferenceCoordinator.js";
import type { LockAcquireResult } from "../dist/backend/RuntimeLock.js";
import {
  type InferenceBackend,
  type InferenceMessage,
  type InferenceResult,
  type InferenceRunOptions,
  type RuntimeInfo,
} from "../dist/backend/InferenceBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import type { SplashConfig } from "../dist/config.js";

const GIT_ENV_KEYS = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

interface Fixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  sessionsDir: string;
  config: SplashConfig;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-step9-int-")));
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
  process.env.GIT_AUTHOR_NAME = "Splash Step9 Int";
  process.env.GIT_AUTHOR_EMAIL = "step9@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Step9 Int";
  process.env.GIT_COMMITTER_EMAIL = "step9@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Splash Step9 Int");
  git(repoRoot, "config", "user.email", "step9@splash.test");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(repoRoot, "src/a.ts"), "const value = 1;\n");
  await writeFile(path.join(repoRoot, "src/b.ts"), "const other = 10;\n");
  await writeFile(path.join(repoRoot, "package.json"), '{"name":"fixture-only","secret":"NEVER_ON_WIRE"}\n');
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
  nextInfo: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 128_000,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  runBehavior: (call: { messages: InferenceMessage[]; options: InferenceRunOptions | undefined }) => Promise<InferenceResult> =
    async () => {
      throw new Error("runBehavior not configured");
    };
  runCalls: Array<{ messages: InferenceMessage[]; options: InferenceRunOptions | undefined }> = [];
  busy = false;

  get runtimeInfo(): RuntimeInfo | null {
    return this.#current;
  }
  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    if (signal?.aborted) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    if (this.nextInfo === null) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    this.#current = this.nextInfo;
    return this.#current;
  }
  async run(messages: InferenceMessage[], options?: InferenceRunOptions): Promise<InferenceResult> {
    this.runCalls.push({ messages, options });
    return this.runBehavior({ messages, options });
  }
  countBehavior: (messages: InferenceMessage[]) => number = () => 1_000;
  async tokenize(content: string): Promise<{ tokens: number[]; count: number }> {
    return { tokens: [], count: 0 };
  }
  async renderPrompt(): Promise<never> {
    throw new Error("renderPrompt must not be called");
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    return this.countBehavior(messages);
  }
}

class FakeLock implements RuntimeLockLike {
  busy = false;
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    if (this.busy) {
      return { acquired: false, reason: "busy" };
    }
    return { acquired: true, token: `tok-${ownerId}` };
  }
  async release(_token: string): Promise<void> {}
}

interface RuntimeSession {
  client: Client;
  runtime: SplashRuntime;
  backend: FakeBackend;
  lock: FakeLock;
}

async function makeRuntimeSession(t: TestContext, fixture: Fixture, tag: string): Promise<RuntimeSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const backend = new FakeBackend();
  const lock = new FakeLock();
  const runtime = createSplashRuntime(fixture.config, {
    backend,
    coordinator: new InferenceCoordinator({
      backend,
      runtimeDir: path.join(fixture.outputRoot, `runtime-${tag}`),
      scanner: async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }],
      lock,
    }),
    processCwd: () => fixture.repoRoot,
  });
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: `splash-step9-${tag}`, version: "0.0.1" });
  await client.connect(clientTransport);
  t.after(async () => {
    try {
      await client.close();
    } catch {}
    try {
      await runtime.server.close();
    } catch {}
    await runtime.dispose().catch(() => undefined);
  });
  return { client, runtime, backend, lock };
}

interface WireContent {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseWire(res: WireContent): Record<string, unknown> {
  const item = res.content?.[0];
  assert.ok(item !== undefined && item.type === "text" && typeof item.text === "string", "text content eksik");
  return JSON.parse(item.text) as Record<string, unknown>;
}

function wireText(res: WireContent): string {
  return res.content?.[0]?.text ?? "";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function workerModify(search: string, replace: string, summary: string): string {
  return JSON.stringify({
    schema_version: 1,
    summary,
    edits: [{ kind: "modify", path: "src/a.ts", operations: [{ search, replace }] }],
  });
}

function assertNoLeak(text: string): void {
  assert.ok(!text.includes("const value = 1;"), "source content leaked");
  assert.ok(!text.includes("const value = 2;"), "source content leaked");
  assert.ok(!text.includes("const value = 3;"), "source content leaked");
  assert.ok(!text.includes("NEVER_ON_WIRE"), "secret content leaked");
  assert.ok(!text.includes("EDITABLE BASE"), "context marker leaked");
  assert.ok(!text.includes("READ-ONLY REFERENCE"), "context marker leaked");
  assert.ok(!text.includes("fatal:"), "git stderr leaked");
  assert.ok(!text.includes("error:"), "git stderr leaked");
}

test("455: restart persistence — runtime A task, dispose; runtime B refines the same session", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 10, outputTokens: 5 } });
  const taskRes = (await a.client.callTool({ name: "splash_task", arguments: { task: "Change the value", files: ["src/a.ts"] } })) as WireContent;
  assert.ok(!taskRes.isError, wireText(taskRes));
  const wire = parseWire(taskRes);
  const sessionId = wire.session_id as string;
  assert.equal(wire.status, "applied");

  await a.runtime.dispose();
  await a.client.close().catch(() => undefined);
  await a.runtime.server.close().catch(() => undefined);

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 3;", "Round 2."), usage: { inputTokens: 20, outputTokens: 10 } });
  const res = (await b.client.callTool({ name: "splash_refine", arguments: { session_id: sessionId, feedback: "continue" } })) as WireContent;
  assert.ok(!res.isError, wireText(res));
  const refined = parseWire(res);
  assert.equal(refined.session_id, sessionId);
  assert.equal(refined.round, 2);
  assert.equal(refined.status, "applied");
  assert.equal(b.backend.runCalls.length, 1);
  assert.equal(await readFile(path.join(fixture.sessionsDir, sessionId, "workspace/src/a.ts"), "utf8"), "const value = 3;\n");
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");
});

test("456: missing worktree after restart — recovery recreates it and refine completes", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 10, outputTokens: 5 } });
  const taskRes = (await a.client.callTool({ name: "splash_task", arguments: { task: "Change the value", files: ["src/a.ts"] } })) as WireContent;
  const wire = parseWire(taskRes);
  const sessionId = wire.session_id as string;
  const wsDir = path.join(fixture.sessionsDir, sessionId, "workspace");
  await writeFile(path.join(wsDir, "sentinel.txt"), "keep-me\n");
  git(fixture.repoRoot, "worktree", "remove", "--force", wsDir);
  git(fixture.repoRoot, "worktree", "prune");
  assert.ok(!(await pathExists(wsDir)));

  await a.runtime.dispose();
  await a.client.close().catch(() => undefined);
  await a.runtime.server.close().catch(() => undefined);

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 3;", "Round 2."), usage: { inputTokens: 20, outputTokens: 10 } });
  const res = (await b.client.callTool({ name: "splash_refine", arguments: { session_id: sessionId, feedback: "continue" } })) as WireContent;
  assert.ok(!res.isError, wireText(res));
  const refined = parseWire(res);
  assert.equal(refined.status, "applied");
  assert.equal(refined.round, 2);
  assert.ok(await pathExists(wsDir), "worktree recreated");
  assert.ok(!(await pathExists(path.join(wsDir, "sentinel.txt"))), "recreated worktree is clean");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 3;\n");
});

test("457: surviving worktree after restart — recovery reuses it (untracked sentinel survives)", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 10, outputTokens: 5 } });
  const taskRes = (await a.client.callTool({ name: "splash_task", arguments: { task: "Change the value", files: ["src/a.ts"] } })) as WireContent;
  const wire = parseWire(taskRes);
  const sessionId = wire.session_id as string;
  const sentinel = path.join(fixture.sessionsDir, sessionId, "workspace/sentinel.txt");
  await writeFile(sentinel, "keep-me\n");

  await a.runtime.dispose();
  await a.client.close().catch(() => undefined);
  await a.runtime.server.close().catch(() => undefined);

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 3;", "Round 2."), usage: { inputTokens: 20, outputTokens: 10 } });
  const res = (await b.client.callTool({ name: "splash_refine", arguments: { session_id: sessionId, feedback: "continue" } })) as WireContent;
  assert.ok(!res.isError, wireText(res));
  const refined = parseWire(res);
  assert.equal(refined.status, "applied");
  assert.equal(refined.round, 2);
  assert.ok(await pathExists(sentinel), "surviving worktree must be reused");
  assert.equal(await readFile(path.join(fixture.sessionsDir, sessionId, "workspace/src/a.ts"), "utf8"), "const value = 3;\n");
});

test("458: stale after restart — stale_base wire, no inference, session stays open", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 10, outputTokens: 5 } });
  const taskRes = (await a.client.callTool({ name: "splash_task", arguments: { task: "Change the value", files: ["src/a.ts"] } })) as WireContent;
  const wire = parseWire(taskRes);
  const sessionId = wire.session_id as string;

  await a.runtime.dispose();
  await a.client.close().catch(() => undefined);
  await a.runtime.server.close().catch(() => undefined);

  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\n// drifted\n");

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => {
    throw new Error("inference must not run for stale base");
  };
  const res = (await b.client.callTool({ name: "splash_refine", arguments: { session_id: sessionId, feedback: "fix it" } })) as WireContent;
  assert.ok(!res.isError, wireText(res));
  const stale = parseWire(res);
  assert.equal(stale.status, "stale_base");
  assert.equal(stale.base_status, "stale");
  assert.deepEqual(stale.stale_files, ["src/a.ts"]);
  assert.equal(stale.round, 2);
  assert.deepEqual(stale.usage, { in: 0, out: 0 });
  assert.equal((stale.context as { input_tokens: number }).input_tokens, 0);
  assert.ok(!("inference" in stale) && !("split_hint" in stale));
  assert.equal(b.backend.runCalls.length, 0);
  assertNoLeak(wireText(res));
  assert.ok(await pathExists(path.join(fixture.sessionsDir, sessionId, "workspace")), "stale session stays open");
  assert.equal(await readFile(path.join(fixture.sessionsDir, sessionId, "workspace/src/a.ts"), "utf8"), "const value = 2;\n");
});

test("459: concurrent sessions — distinct sessions proceed; same session is serialized FIFO", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "c");
  s.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 10, outputTokens: 5 } });

  const [left, right] = await Promise.all([
    s.client.callTool({ name: "splash_task", arguments: { task: "Left task", files: ["src/a.ts"] } }),
    s.client.callTool({ name: "splash_task", arguments: { task: "Right task", files: ["src/a.ts"] } }),
  ]);
  const leftWire = parseWire(left as WireContent);
  const rightWire = parseWire(right as WireContent);
  assert.equal(leftWire.status, "applied");
  assert.equal(rightWire.status, "applied");
  const leftId = leftWire.session_id as string;
  const rightId = rightWire.session_id as string;
  assert.notEqual(leftId, rightId);

  s.backend.runBehavior = async (call) => ({
    content: workerModify("const value = 1;", "const value = 3;", "Round 2."),
    usage: { inputTokens: 20 + call.messages.length, outputTokens: 10 },
  });
  const [first, second] = await Promise.all([
    s.client.callTool({ name: "splash_refine", arguments: { session_id: leftId, feedback: "first" } }),
    s.client.callTool({ name: "splash_refine", arguments: { session_id: leftId, feedback: "second" } }),
  ]);
  const firstWire = parseWire(first as WireContent);
  const secondWire = parseWire(second as WireContent);
  assert.equal(firstWire.round, 2);
  assert.equal(secondWire.round, 3);

  const [refineLeft, refineRight] = await Promise.all([
    s.client.callTool({ name: "splash_refine", arguments: { session_id: leftId, feedback: "again left" } }),
    s.client.callTool({ name: "splash_refine", arguments: { session_id: rightId, feedback: "again right" } }),
  ]);
  assert.equal(parseWire(refineLeft as WireContent).session_id, leftId);
  assert.equal(parseWire(refineRight as WireContent).session_id, rightId);
});

test("MCP wire — conditional fields, safe errors, and no source/stderr leakage", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "w");
  s.backend.runBehavior = async () => ({ content: workerModify("const value = 1;", "const value = 2;", "Round 1."), usage: { inputTokens: 11, outputTokens: 6 } });
  const taskRes = (await s.client.callTool({ name: "splash_task", arguments: { task: "Change the value", files: ["src/a.ts"] } })) as WireContent;
  const fresh = parseWire(taskRes);
  assert.equal(fresh.base_status, "fresh");
  assert.ok(!("stale_files" in fresh) && !("inference" in fresh) && !("split_hint" in fresh));
  assertNoLeak(wireText(taskRes));

  const missing = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: "00000000-0000-4000-8000-000000000000", feedback: "x" } })) as WireContent;
  assert.ok(missing.isError === true);
  assert.deepEqual(parseWire(missing), { kind: "session_not_found", message: "The session was not found" });
  assertNoLeak(wireText(missing));

  const unsafe = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: "../escape", feedback: "x" } })) as WireContent;
  assert.ok(unsafe.isError === true);
  assert.equal(parseWire(unsafe).kind, "invalid_input");
  assert.ok(!wireText(unsafe).includes("../escape"));

  const empty = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: fresh.session_id as string, feedback: "   " } })) as WireContent;
  assert.ok(empty.isError === true);
  assert.ok(!wireText(empty).includes("   "));

  const unsafeFile = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: fresh.session_id as string, feedback: "x", files: ["../../etc/passwd"] } })) as WireContent;
  assert.ok(unsafeFile.isError === true);
  assert.equal(parseWire(unsafeFile).kind, "invalid_input");
  assert.ok(!wireText(unsafeFile).includes("../../etc/passwd"));

  s.lock.busy = true;
  const busy = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: fresh.session_id as string, feedback: "again" } })) as WireContent;
  s.lock.busy = false;
  assert.ok(!busy.isError, wireText(busy));
  const busyWire = parseWire(busy);
  assert.equal(busyWire.status, "inference_busy");
  assert.equal(busyWire.base_status, "fresh");
  assert.ok("inference" in busyWire);
  assert.ok(!("stale_files" in busyWire) && !("split_hint" in busyWire));
  assertNoLeak(wireText(busy));

  s.backend.countBehavior = () => 999_999_999;
  const split = (await s.client.callTool({ name: "splash_refine", arguments: { session_id: fresh.session_id as string, feedback: "again" } })) as WireContent;
  assert.ok(!split.isError, wireText(split));
  const splitWire = parseWire(split);
  assert.equal(splitWire.status, "needs_split");
  assert.ok("split_hint" in splitWire);
  assert.ok(!("stale_files" in splitWire) && !("inference" in splitWire));
  assertNoLeak(wireText(split));
});
