/**
 * Step 6: MCP-level (wire) testleri (spec 121-125) — `InMemoryTransport`
 * üzerinden gerçek `McpServer` + `Client` konuşur.
 *
 * Gerçeklik karışımı: gerçek `createSplashRuntime` kompozisyonu (zod şema,
 * `splash_task`/`splash_refine`/`splash_diff`/`splash_close`, runtime
 * dispose) — backend SAHTE (model çağrısı yok), coordinator GERÇEK (fake
 * lock/scanner dikişleriyle).
 *
 * Çiviler:
 * - 121: yayın yüzeyi TAM OLARAK dört araç (`splash_task`, `splash_refine`,
 *   `splash_diff`, `splash_close`; geçici `splash_ping` KALDIRILDI);
 *   başlangıç TEBEL (HTTP/dizin yok).
 * - 123/124: MCP yanıtı compact metadata — snake_case; source/diff/patch/
 *   context içeriği YOK; süreç-tek coordinator paylaşımlı.
 * - 125: güvenli hata serialization'ı + Step 9 runtime dispose (kapatım
 *   kalıcı oturumlara DOKUNULMAZ: worktree/sessions korunur).
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
import { RulesResolutionError } from "../dist/rules/types.js";

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

test("121: exactly the four production tools are registered (no splash_ping); construction is LAZY (no I/O, no HTTP)", async (t) => {
  const fixture = await makeMcpFixture(t);
  // Başlangıç TEBEL (spec 84/85): hiçbir dizin/HTTP yok — yalnız kurulum.
  assert.ok(!(await pathExists(fixture.sessionsDir)), "başlangıçta sessions dizini OLUŞMAMALI");

  const session = await makeMcpSession(t, fixture);
  const tools = (await session.client.listTools()).tools;
  const names = tools.map((tool) => tool.name).sort();
  // Step 10: final v1 yayın yüzeyi TAM OLARAK dört araç — geçici dev ping YOK.
  assert.deepEqual(names, ["splash_close", "splash_diff", "splash_refine", "splash_task"]);
  // Sunucu kimliği (eski ping'in doğruladığı servis adı/sürümü) `initialize`'da:
  assert.deepEqual(session.client.getServerVersion(), { name: SERVICE_NAME, version: SERVICE_VERSION });

  // `splash_diff` şeması: `session_id` zorunlu; `files`/`stat` isteğe bağlı;
  // bilinmeyen alan YOK (`.strict()` → additionalProperties: false).
  const diffSchema = tools.find((tool) => tool.name === "splash_diff")?.inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(diffSchema.properties).sort(), ["files", "session_id", "stat"]);
  assert.deepEqual(diffSchema.required, ["session_id"]);
  assert.equal(diffSchema.additionalProperties, false);
  // `splash_close` şeması: YALNIZ `session_id` (apply/force/output_path YOK).
  const closeSchema = tools.find((tool) => tool.name === "splash_close")?.inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(closeSchema.properties), ["session_id"]);
  assert.deepEqual(closeSchema.required, ["session_id"]);
  assert.equal(closeSchema.additionalProperties, false);

  // `splash_refine` şeması (spec 19-20): `session_id` + `feedback` ZORUNLU;
  // `files` (salt-okunur referans) İSTEKLİ.
  const refineTool = tools.find((tool) => tool.name === "splash_refine");
  assert.ok(refineTool !== undefined, "splash_refine kayıtlı olmalı");
  const refineSchema = refineTool.inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(refineSchema.required?.includes("session_id"), "`session_id` zorunlu olmalı");
  assert.ok(refineSchema.required?.includes("feedback"), "`feedback` zorunlu olmalı");
  assert.ok(!refineSchema.required?.includes("files"), "`files` isteğe bağlı olmalı");

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
  // Step 7: adaptif bütçe override'ları `options` altında; Step 8: hook
  // kuralları da `options` altında (top-level `rules` hâlâ YASAK — yukarıda):
  const optionsSchema = schema.properties.options as { properties: Record<string, unknown> } | undefined;
  assert.ok(optionsSchema !== undefined, "options şeması eksik");
  for (const option of ["reasoning_effort", "context_tier", "output_reserve_tokens", "rules"]) {
    assert.ok(Object.hasOwn(optionsSchema.properties, option), `options.${option} şemada olmalı`);
  }

  // Kaldırılan `splash_ping` artık bilinmeyen araç → hata sonucu:
  const ping = (await session.client.callTool({ name: "splash_ping", arguments: {} })) as WireContent;
  assert.equal(ping.isError, true, "splash_ping must no longer be callable");
  assert.ok(String(ping.content?.[0]?.text).includes("not found"));
  // Hiçbir şeye dokunulmadı (repository/model/oturum yok):
  assert.equal(session.backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)), "başlangıç sessions dizini OLUŞTURMAMALI");
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
  // Çalışma zamanı hâlâ ayakta (şema reddi runtime'ı bozmaz) — yan-etkisiz
  // kanıt: protokol isteği yanıtlanır VE bir araç çağrısı servise kadar iner
  // (bilinmeyen oturum → güvenli tip'li `session_not_found`; dizin/inference YOK).
  const names = (await session.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["splash_close", "splash_diff", "splash_refine", "splash_task"]);
  const probe = (await session.client.callTool({
    name: "splash_diff",
    arguments: { session_id: "00000000-0000-4000-8000-000000000000" },
  })) as WireContent;
  assert.equal(probe.isError, true);
  assert.deepEqual(parseWire(probe), { kind: "session_not_found", message: "The session was not found" });
  assert.equal(session.backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)), "yan-etkisiz kanıt sessions dizini OLUŞTURMAMALI");
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

test("125: runtime.dispose() → persistent session preserved (Step 9); subsequent task → shutting_down", async (t) => {
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

  // Kapatım (Step 9, spec 128-130): RAM kayıt defteri boşalır; KALICI
  // OTURUMLARA DOKUNULMAZ — worktree imha EDİLMEZ, session dizini KALIR
  // (süreç kapanışı implicit close DEĞİL; imha Step 10 `splash_close`).
  await session.runtime.dispose();
  assert.ok(await pathExists(path.join(fixture.sessionsDir, sessionId)), "dispose session dizimini KORUMALI");
  assert.ok(
    await pathExists(path.join(fixture.sessionsDir, sessionId, "workspace")),
    "dispose worktree'i KORUMALI (sonraki süreç reuse eder)",
  );

  // Sonrası: yeni görev güvenle reddedilir (spec 69/71):
  const after = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "After dispose", files: [] },
  })) as WireContent;
  assert.ok(after.isError === true);
  assert.equal(parseWire(after).kind, "shutting_down");
});

// ── Step 8: kurallar MCP seviyesinde ─────────────────────────────────────────

test("Step 8: options.rules over MCP → rules_source `hook`; worker sees it; content NEVER returns on the wire", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({
    content: workerOkJson(),
    usage: { inputTokens: 5, outputTokens: 5 },
  });

  const ruleText = "HOOKE_SPECIAL_RULE_MARKER use tabs everywhere.";
  const res = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value", files: ["src/a.ts"], options: { rules: ruleText } },
  })) as WireContent;

  assert.ok(!res.isError, `beklenmedik hata: ${res.content?.[0]?.text}`);
  const wire = parseWire(res);
  assert.equal(wire.rules_source, "hook");
  // Worker kuralları GÖRDÜ (prompt'ta) — ama wire'a ASLA dönmedi:
  const prompt = session.backend.runCalls[0]?.messages[0]?.content ?? "";
  assert.ok(prompt.includes(ruleText), "hook rules must reach the worker prompt");
  const text = (res.content?.[0]?.text ?? "") as string;
  assert.ok(!text.includes("HOOKE_SPECIAL_RULE_MARKER"), "rules content must not return on the wire");
  assert.ok(!text.includes("use tabs everywhere"), "rules content must not return on the wire");
});

test("Step 8: repository CLAUDE.md over MCP → rules_source `CLAUDE.md`; content NEVER returns on the wire", async (t) => {
  const fixture = await makeMcpFixture(t);
  await writeFile(
    path.join(fixture.repoRoot, "CLAUDE.md"),
    "CLAUDE_SPECIAL_RULE_MARKER never log credentials.\n",
  );
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({
    content: workerOkJson(),
    usage: { inputTokens: 5, outputTokens: 5 },
  });

  const res = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value", files: ["src/a.ts"] },
  })) as WireContent;

  assert.ok(!res.isError, `beklenmedik hata: ${res.content?.[0]?.text}`);
  const wire = parseWire(res);
  assert.equal(wire.rules_source, "CLAUDE.md");
  const prompt = session.backend.runCalls[0]?.messages[0]?.content ?? "";
  assert.ok(prompt.includes("CLAUDE_SPECIAL_RULE_MARKER"), "repository rules must reach the worker prompt");
  const text = (res.content?.[0]?.text ?? "") as string;
  assert.ok(!text.includes("CLAUDE_SPECIAL_RULE_MARKER"), "rules content must not return on the wire");
  assert.ok(!text.includes("never log credentials"), "rules content must not return on the wire");
  // Resolver salt-okunurdur: ana checkout'taki dosya görev sonrasında aynen:
  assert.equal(await readFile(path.join(fixture.repoRoot, "CLAUDE.md"), "utf8"), "CLAUDE_SPECIAL_RULE_MARKER never log credentials.\n");
});

test("Step 8: rules resolution failure over MCP → safe typed error; no session dir, no inference", async (t) => {
  const fixture = await makeMcpFixture(t);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const backend = new FakeBackend();
  backend.runBehavior = async () => {
    throw new Error("inference must NOT run for a rules resolution failure");
  };
  const runtime = createSplashRuntime(fixture.config, {
    backend,
    coordinator: new InferenceCoordinator({
      backend,
      runtimeDir: path.join(fixture.outputRoot, "runtime"),
      scanner: CLEAN_SCANNER,
      lock: new FakeLock(),
    }),
    rulesResolver: {
      async resolve() {
        throw new RulesResolutionError(
          "rules_resolution_failed",
          "Project rules could not be resolved safely",
          { cause: new Error("EACCES /repo/CLAUDE.md") },
        );
      },
    },
    processCwd: () => fixture.repoRoot,
  });
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: "splash-step8-test", version: "0.0.1" });
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

  const res = (await client.callTool({
    name: "splash_task",
    arguments: { task: "Anything", files: ["src/a.ts"] },
  })) as WireContent;

  assert.ok(res.isError === true);
  assert.deepEqual(parseWire(res), {
    kind: "rules_resolution_failed",
    message: "Project rules could not be resolved safely",
  });
  assert.ok(!String(res.content?.[0]?.text).includes("EACCES"), "fs detail must not surface");
  // Resolution workspace/session ÖNCESİ düşer — hiçbir iz kalmamalı:
  assert.equal(backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)), "no session directory must be created");
});

// ── Step 10: splash_diff / splash_close MCP seviyesinde ──────────────────────

test("Step 10: diff/close schema rejections (missing session_id, unknown fields) keep the session OPEN", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({ content: workerOkJson(), usage: { inputTokens: 1, outputTokens: 1 } });
  const task = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value", files: ["src/a.ts"] },
  })) as WireContent;
  assert.ok(!task.isError, `beklenmedik hata: ${task.content?.[0]?.text}`);
  const sessionId = parseWire(task).session_id as string;
  const sessionDir = path.join(fixture.sessionsDir, sessionId);

  const rejected: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "splash_diff", arguments: {} },
    { name: "splash_diff", arguments: { session_id: "" } },
    { name: "splash_diff", arguments: { session_id: sessionId, force: true } },
    { name: "splash_diff", arguments: { session_id: sessionId, stat: "yes" } },
    { name: "splash_close", arguments: {} },
    { name: "splash_close", arguments: { session_id: sessionId, apply: true } },
    { name: "splash_close", arguments: { session_id: sessionId, output_path: path.join(fixture.root, "evil.patch") } },
    { name: "splash_close", arguments: { session_id: sessionId, force: true } },
  ];
  for (const call of rejected) {
    const res = (await session.client.callTool(call)) as WireContent;
    assert.equal(res.isError, true, `şema reddi beklenir: ${JSON.stringify(call)}`);
  }
  // Oturum AÇIK: workspace + yetkili durum yerinde; hiçbir patch export edilmedi.
  assert.ok(await pathExists(path.join(sessionDir, "session.json")), "reddedilen close oturumu KAPATMAMALI");
  assert.ok(await pathExists(path.join(sessionDir, "workspace")));
  assert.ok(!(await pathExists(path.join(fixture.outputRoot, "patches"))), "reddedilen close patch ÜRETMEMELİ");
  assert.ok(!(await pathExists(path.join(fixture.root, "evil.patch"))), "çağıran patch yolunu SEÇEMEZ");
  assert.equal(session.runtime.server.isConnected(), true);
});

test("Step 10: unknown / unsafe session over MCP → safe typed errors (no path, no payload)", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  for (const name of ["splash_diff", "splash_close"]) {
    const missing = (await session.client.callTool({
      name,
      arguments: { session_id: "11111111-1111-4111-8111-111111111111" },
    })) as WireContent;
    assert.equal(missing.isError, true);
    assert.deepEqual(parseWire(missing), { kind: "session_not_found", message: "The session was not found" });

    const unsafe = (await session.client.callTool({ name, arguments: { session_id: "../../etc" } })) as WireContent;
    assert.equal(unsafe.isError, true);
    assert.deepEqual(parseWire(unsafe), { kind: "invalid_input", message: "The session id is not a safe identifier" });
  }
  const badPath = (await session.client.callTool({
    name: "splash_diff",
    arguments: { session_id: "11111111-1111-4111-8111-111111111111", files: ["../outside.ts"] },
  })) as WireContent;
  assert.equal(badPath.isError, true);
  assert.deepEqual(parseWire(badPath), {
    kind: "invalid_input",
    message: "The diff files must be safe repository-relative paths",
  });
  assert.equal(session.backend.runCalls.length, 0);
  assert.ok(!(await pathExists(fixture.sessionsDir)));
});

test("Step 10: handler wiring — diff returns raw text / stat JSON; close returns compact metadata only", async (t) => {
  const fixture = await makeMcpFixture(t);
  const session = await makeMcpSession(t, fixture);
  session.backend.runBehavior = async () => ({ content: workerOkJson(), usage: { inputTokens: 1, outputTokens: 1 } });
  const task = (await session.client.callTool({
    name: "splash_task",
    arguments: { task: "Change the value", files: ["src/a.ts"] },
  })) as WireContent;
  const sessionId = parseWire(task).session_id as string;

  // splash_diff (varsayılan): ham unified diff metni — sarmalayıcı JSON YOK.
  const diff = (await session.client.callTool({ name: "splash_diff", arguments: { session_id: sessionId } })) as WireContent;
  assert.ok(!diff.isError);
  const diffText = String(diff.content?.[0]?.text);
  assert.ok(diffText.startsWith("diff --git a/src/a.ts b/src/a.ts"), diffText);
  assert.ok(diffText.includes("+const value = 2;"));

  // stat:true → YALNIZ yapısal istatistik.
  const stat = (await session.client.callTool({
    name: "splash_diff",
    arguments: { session_id: sessionId, stat: true },
  })) as WireContent;
  assert.ok(!stat.isError);
  assert.equal(stat.content?.[0]?.text, '{"diff_stats":{"files":1,"insertions":1,"deletions":1}}');

  // splash_close → compact metadata (içerik YOK); patch diskte; oturum kapandı.
  const close = (await session.client.callTool({ name: "splash_close", arguments: { session_id: sessionId } })) as WireContent;
  assert.ok(!close.isError, `beklenmedik hata: ${close.content?.[0]?.text}`);
  const wire = parseWire(close);
  assert.deepEqual(Object.keys(wire).sort(), ["base_status", "diff_stats", "files_changed", "patch_path", "summary"]);
  assert.equal(wire.base_status, "fresh");
  assert.deepEqual(wire.files_changed, ["src/a.ts"]);
  assert.deepEqual(wire.diff_stats, { files: 1, insertions: 1, deletions: 1 });
  assert.equal(wire.summary, "Changed value to 2.");
  const closeText = String(close.content?.[0]?.text);
  assert.ok(!closeText.includes("const value"), "close yanıtı kaynak/diff içeriği TAŞIMAZ");
  assert.ok(!closeText.includes("NEVER_ON_WIRE"));
  const patchPath = wire.patch_path as string;
  assert.ok(path.isAbsolute(patchPath) && (await readFile(patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(path.join(fixture.sessionsDir, sessionId))), "oturum kapandı");
  // Ana checkout dokunulmadı (Splash patch'i ASLA uygulamaz):
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");

  const after = (await session.client.callTool({ name: "splash_diff", arguments: { session_id: sessionId } })) as WireContent;
  assert.equal(after.isError, true);
  assert.equal(parseWire(after).kind, "session_not_found");
});
