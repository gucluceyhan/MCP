/**
 * Step 6: MCP-level (wire) testleri (spec 121-125) — `InMemoryTransport`
 * üzerinden gerçek `McpServer` + `Client` konuşur.
 *
 * Gerçeklik karışımı: gerçek `createSplashRuntime` kompozisyonu (zod şema,
 * `splash_task`/`splash_ping`, runtime dispose) — backend SAHTE (model
 * çağrısı yok), coordinator GERÇEK (fake lock/scanner dikişleriyle).
 *
 * Çiviler:
 * - 121: `splash_task` (zod şemalı) + geçici `splash_ping` kayıtlı; başlangıç
 *   TEBEL (HTTP/dizin yok).
 * - 123/124: MCP yanıtı compact metadata — snake_case; source/diff/patch/
 *   context içeriği YOK; süreç-tek coordinator paylaşımlı.
 * - 125: güvenli hata serialization'ı + runtime dispose (shutdown davranışı).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSplashRuntime, SERVICE_NAME, SERVICE_VERSION, type SplashRuntime } from "../dist/server.js";
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

// ── Hermetic git fixture (service testleriyle aynı disiplin) ────────────────

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

interface McpFixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  config: SplashConfig;
  sessionsDir: string;
}

async function makeMcpFixture(t: TestContext): Promise<McpFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-step6-mcp-")));
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
  process.env.GIT_AUTHOR_NAME = "Splash Step6 MCP Test";
  process.env.GIT_AUTHOR_EMAIL = "mcp@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Step6 MCP Test";
  process.env.GIT_COMMITTER_EMAIL = "mcp@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Splash Step6 MCP Test");
  git(repoRoot, "config", "user.email", "mcp@splash.test");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(repoRoot, "src/a.ts"), "const value = 1;\n");
  // Bağlam'a ve wire'a SIZMAMASI gereken içerik (crawl/sızıntı kanıtı):
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

// ── Sahte backend + kilit (coordinator dikişleri) ──────────────────────────

class FakeBackend implements InferenceBackend {
  #current: RuntimeInfo | null = null;
  nextInfo: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 65_536,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  runBehavior: (call: { messages: InferenceMessage[]; options: InferenceRunOptions | undefined }) => Promise<InferenceResult> =
    async () => {
      throw new Error("FakeBackend.runBehavior not configured");
    };
  runCalls: Array<{ messages: InferenceMessage[]; options: InferenceRunOptions | undefined }> = [];

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
  /** `countPromptTokens` davranışı (varsayılan: 64K'a sığan küçük sayı). */
  countBehavior: (messages: InferenceMessage[]) => number = () => 1_000;
  countCalls: InferenceMessage[][] = [];
  async tokenize(content: string): Promise<{ tokens: number[]; count: number }> {
    return { tokens: [], count: 0 };
  }
  async renderPrompt(): Promise<never> {
    throw new Error("FakeBackend.renderPrompt must not be called in Step 7");
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    this.countCalls.push([...messages]);
    return this.countBehavior(messages);
  }
}

class FakeLock implements RuntimeLockLike {
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    return { acquired: true, token: `tok-${ownerId}` };
  }
  async release(_token: string): Promise<void> {
    // no-op
  }
}

const CLEAN_SCANNER = async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];

interface McpSession {
  client: Client;
  runtime: SplashRuntime;
  fixture: McpFixture;
  backend: FakeBackend;
}

/** MCP istemcisi + runtime (InMemoryTransport; server ÖNCE connect). */
async function makeMcpSession(t: TestContext, fixture: McpFixture): Promise<McpSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const backend = new FakeBackend();
  const runtime = createSplashRuntime(fixture.config, {
    backend,
    coordinator: new InferenceCoordinator({
      backend,
      runtimeDir: path.join(fixture.outputRoot, "runtime"),
      scanner: CLEAN_SCANNER,
      lock: new FakeLock(),
    }),
    processCwd: () => fixture.repoRoot,
  });
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: "splash-step6-test", version: "0.0.1" });
  await client.connect(clientTransport);
  t.after(async () => {
    try {
      await client.close();
    } catch {
      // kapanış zaten gerçekleşmiş olabilir
    }
    try {
      await runtime.server.close();
    } catch {
      // aynısı
    }
    await runtime.dispose().catch(() => undefined);
  });
  return { client, runtime, fixture, backend };
}

interface WireContent {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseWire(res: WireContent): Record<string, unknown> {
  const item = res.content?.[0];
  assert.ok(item !== undefined && item.type === "text" && typeof item.text === "string", "text content eksik");
  return JSON.parse(item.text as string) as Record<string, unknown>;
}

function workerOkJson(): string {
  return JSON.stringify({
    schema_version: 1,
    summary: "Changed value to 2.",
    edits: [
      {
        kind: "modify",
        path: "src/a.ts",
        operations: [{ search: "const value = 1;", replace: "const value = 2;" }],
      },
    ],
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, into);
    }
  }
  return into;
}

// ── Testler ─────────────────────────────────────────────────────────────────

test("121: splash_task + splash_ping registered; construction is LAZY (no I/O, no HTTP)", async (t) => {
  const fixture = await makeMcpFixture(t);
  // Başlangıç TEBEL (spec 84/85): hiçbir dizin/HTTP yok — yalnız kurulum.
  assert.ok(!(await pathExists(fixture.sessionsDir)), "başlangıçta sessions dizini OLUŞMAMALI");

  const session = await makeMcpSession(t, fixture);
  const tools = (await session.client.listTools()).tools;
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["splash_ping", "splash_task"]);

  const taskTool = tools.find((tool) => tool.name === "splash_task");
  assert.ok(taskTool !== undefined);
  // zod şema → JSON schema: `task` + `files` ZORUNLU (final sözleşme:
  // splash_task(task, files, options?)); `options` isteğe bağlı.
  const schema = taskTool?.inputSchema as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(schema.type, "object");
  assert.ok(Array.isArray(schema.required) && schema.required.includes("task"));
  assert.ok(Array.isArray(schema.required) && schema.required.includes("files"), "`files` zorunlu olmalı");
  assert.ok(!("required" in schema) || !(schema.required ?? []).includes("options"));
  // çağrı başına YASAK alanlar şemada YOK (spec 6/9) — `context_tier` artık
  // `options` altındadır (Step 7 override'ı):
  for (const forbidden of ["repo_root", "session_id", "output_root", "rules", "system_prompt"]) {
    assert.ok(!Object.hasOwn(schema.properties, forbidden), `yasak alan şemada: ${forbidden}`);
  }
  // Step 7: adaptif bütçe override'ları `options` altında:
  const optionsSchema = schema.properties.options as { properties: Record<string, unknown> } | undefined;
  assert.ok(optionsSchema !== undefined, "options şeması eksik");
  for (const option of ["reasoning_effort", "context_tier", "output_reserve_tokens"]) {
    assert.ok(Object.hasOwn(optionsSchema.properties, option), `options.${option} şemada olmalı`);
  }

  // `splash_ping` — hiçbir şeye dokunmaz:
  const ping = (await session.client.callTool({ name: "splash_ping", arguments: {} })) as WireContent;
  assert.ok(!ping.isError);
  assert.deepEqual(parseWire(ping), { service: SERVICE_NAME, version: SERVICE_VERSION, status: "ok" });
  // Ping repository/model ile etkileşmedi:
  assert.equal(session.backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)), "ping sessions dizini OLUŞTURMAMALI");
});

test("BLOCKER 4: MCP context_tier is a canonical enum (numeric / unknown rejected)", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  const tools = (await session.client.listTools()).tools;
  const schema = tools.find((tool) => tool.name === "splash_task")?.inputSchema as {
    properties: { options?: { properties: Record<string, { enum?: string[] }> } };
  };
  const tier = schema.properties.options?.properties.context_tier;
  assert.ok(tier !== undefined, "options.context_tier şemada olmalı");
  // Kanonik sembolik küme (sayısal değer şemada YOK):
  assert.deepEqual(tier.enum, ["64k", "128k", "192k", "runtime_max"]);

  // Sayısal değer (131072) MCP şeması tarafından REDDEDİLİR:
  const badNumeric = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "X", files: ["src/a.ts"], options: { context_tier: 131_072 } },
  })) as WireContent;
  assert.ok(badNumeric.isError, "sayısal context_tier şema tarafından reddedilmeli");

  // Bilinmeyen string ("80k") REDDEDİLİR:
  const badString = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "X", files: ["src/a.ts"], options: { context_tier: "80k" } },
  })) as WireContent;
  assert.ok(badString.isError, "bilinmeyen context_tier şema tarafından reddedilmeli");

  // Geçerli kanonik değer şemadan GEÇER + işlem ilerler (backend ok JSON):
  session.backend.nextInfo = {
    ready: true,
    maximumContextTokens: 196_608,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  session.backend.runBehavior = async () => ({
    content: workerOkJson(),
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const ok = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "X", files: ["src/a.ts"], options: { context_tier: "128k" } },
  })) as WireContent;
  assert.ok(!ok.isError, `kanonik context_tier kabul edilmeli: ${ok.content?.[0]?.text}`);
});

test("123/124: splash_task over MCP — compact snake_case wire; NO source/diff/patch/context content; shared coordinator", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({
    content: workerOkJson(),
    usage: { inputTokens: 777, outputTokens: 123 },
  });
  // Tam preflight ölçüsü `usage.in` (777) ile AYRI — telemetri dispatch
  // öncesi kesin olmalı (spec 31):
  session.backend.countBehavior = () => 1_234;

  const res = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value constant from 1 to 2", files: ["src/a.ts"] },
  })) as WireContent;

  assert.ok(!res.isError, `beklenmedik hata: ${res.content?.[0]?.text}`);
  const wire = parseWire(res);

  // snake_case wire (DESIGN §3) — camelCase SIZMADI:
  const keys = collectKeys(wire);
  for (const camel of ["sessionId", "baseStatus", "rulesSource", "filesChanged", "diffStats", "runtimeMaxTokens"]) {
    assert.ok(!keys.has(camel), `camelCase "${camel}" wire'a sızmış`);
  }
  assert.equal(wire.status, "applied");
  assert.equal(wire.base_status, "fresh");
  assert.equal(wire.rules_source, "none");
  assert.equal(wire.summary, "Changed value to 2.");
  assert.deepEqual(wire.files_changed, ["src/a.ts"]);
  assert.deepEqual(wire.diff_stats, { files: 1, insertions: 1, deletions: 1 });
  assert.equal((wire.usage as { in: number }).in, 777);
  assert.equal((wire.usage as { out: number }).out, 123);
  const context = wire.context as {
    runtime_max_tokens: number;
    input_tokens: number;
    output_reserve_tokens: number;
    selected_context_tier: string;
  };
  assert.equal(context.runtime_max_tokens, 65_536);
  assert.equal(context.input_tokens, 1_234); // tam preflight ölçüsü — usage.in (777) ASLA değil
  assert.equal(context.output_reserve_tokens, 32_768);
  assert.equal(context.selected_context_tier, "64k");
  // Koşullu alanlar BOŞTA (spec 55/108):
  assert.ok(!("inference" in wire) && !("split_hint" in wire) && !("stale_files" in wire));
  // Sıfır source sızıntısı (spec 50/123):
  const text = (res.content?.[0]?.text ?? "") as string;
  assert.ok(!text.includes("const value = 1;"), "source içeriği wire'a sızdı");
  assert.ok(!text.includes("NEVER_ON_WIRE"), "package.json içeriği wire'a sızdı (crawl!)");
  assert.ok(!text.includes("EDITABLE BASE"), "bağlam blokları wire'a sızdı");

  // SÜREÇ TEK coordinator: aynı runtime üzerinden ikinci çağrı — tek backend:
  const second = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Again", files: ["src/a.ts"] },
  })) as WireContent;
  assert.ok(!second.isError);
  assert.equal(session.backend.runCalls.length, 2);

  // Session kayıt defterinde (workspace canlı — refine/close Step 9):
  assert.ok(await pathExists(fixture.sessionsDir));
});

test("58/59/123: safe typed errors surface as MCP error results (no payload, no crash)", async (t) => {
  const fixture = await makeMcpFixture(t);

  // (a) non-git repo kökü → invalid_repository:
  {
    const notGit = path.join(fixture.root, "not-git");
    await mkdir(notGit, { recursive: true });
    const s = await makeMcpSession(t, { ...fixture, config: { ...fixture.config, repoRoot: notGit } });
    s.backend.runBehavior = async () => {
      throw new Error("must not run");
    };
    const res = (await s.client.callTool({
      name: "splash_task",
      arguments: { task: "Anything", files: [] },
    })) as WireContent;
    assert.ok(res.isError === true);
    assert.deepEqual(parseWire(res), { kind: "invalid_repository", message: "The project root is not a valid Git working tree" });
  }

  // (b) backend HTTP hatası → kind + status; gövde fragmenti YOK:
  {
    const s = await makeMcpSession(t, fixture);
    s.backend.runBehavior = async () => {
      throw new BackendError("http", "Inference request failed with HTTP status 502 (/v1/chat/completions)", {
        status: 502,
        cause: "RESPONSE_BODY_FRAGMENT_WITH_SECRETS",
      });
    };
    const res = (await s.client.callTool({
      name: "splash_task",
      arguments: { task: "Anything", files: ["src/a.ts"] },
    })) as WireContent;
    assert.ok(res.isError === true);
    const wire = parseWire(res);
    assert.equal(wire.kind, "http");
    assert.equal(wire.status, 502);
    assert.ok(typeof wire.message === "string" && !String(wire.message).includes("RESPONSE_BODY_FRAGMENT"));
  }

  // (c) bilinmeyen istisna → internal_error / sabit cümle (payload ASLA YOK):
  {
    const s = await makeMcpSession(t, fixture);
    s.backend.runBehavior = async () => {
      throw new Error("TOTALLY_UNEXPECTED_PAYLOAD_LEAK_ATTEMPT");
    };
    const res = (await s.client.callTool({
      name: "splash_task",
      arguments: { task: "Anything", files: ["src/a.ts"] },
    })) as WireContent;
    assert.ok(res.isError === true);
    assert.deepEqual(parseWire(res), { kind: "internal_error", message: "Internal Splash error" });
    assert.ok(!String(res.content?.[0]?.text).includes("TOTALLY_UNEXPECTED"));
  }
});

test("8: `files` missing → MCP schema rejection; task service NEVER called (no workspace/inference/session dir)", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => {
    throw new Error("inference must NOT run for a schema-invalid call");
  };

  const res = (await session.client.callTool({ name: "splash_task", arguments: { task: "Do something" } })) as WireContent;

  // Şema protokol seviyesinde reddeder:
  assert.ok(res.isError === true, `files eksik çağrı reddedilmeli: ${JSON.stringify(res)}`);
  // Görev servisine ASLA inemedi — workspace/inference/oturum YOK:
  assert.equal(session.backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)), "şema-geçersiz çağrıda sessions dizini OLUŞMAMALI");
  // Çalışma zamanı hâlâ ayakta (şema reddi runtime'ı bozmaz):
  const ping = (await session.client.callTool({ name: "splash_ping", arguments: {} })) as WireContent;
  assert.ok(!ping.isError);
});

test("8: `files: []` (explicit empty array, create-only task) is still accepted", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({
    content: JSON.stringify({ schema_version: 1, summary: "Nothing to do.", edits: [] }),
    usage: { inputTokens: 4, outputTokens: 4 },
  });

  const res = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Create a file", files: [] },
  })) as WireContent;

  assert.ok(!res.isError, `boş files dizi kabul edilmeli: ${res.content?.[0]?.text}`);
  const wire = parseWire(res);
  assert.equal(wire.status, "applied"); // 0/0 no-op = geçerli tur
  assert.equal(session.backend.runCalls.length, 1);
});

test("125: runtime.dispose() → session cleaned; subsequent task → shutting_down error result", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({ content: workerOkJson(), usage: { inputTokens: 1, outputTokens: 1 } });

  const res = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value", files: ["src/a.ts"] },
  })) as WireContent;
  assert.ok(!res.isError);
  const wire = parseWire(res);
  const sessionId = wire.session_id as string;
  assert.ok(await pathExists(path.join(fixture.sessionsDir, sessionId, "workspace")));

  // Kapatım: kayıt defteri boşalır, worktree imha edilir, session dizini temiz.
  await session.runtime.dispose();
  assert.ok(!(await pathExists(path.join(fixture.sessionsDir, sessionId))), "dispose session dizimini temizlemeli");

  // Sonrası: yeni görev güvenle reddedilir (spec 69/71):
  const after = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "After dispose", files: [] },
  })) as WireContent;
  assert.ok(after.isError === true);
  assert.equal(parseWire(after).kind, "shutting_down");
});
