/**
 * Step 6+7: `SplashTaskService` entegrasyon testleri (spec 93-124 + Step 7).
 *
 * Gerçeklik karışımı (spec 5/121): GERÇEK `InferenceCoordinator` + GERÇEK
 * `ContextAssembler` + GERÇEK `GitWorktreeWorkspace` (gerçek git, hermetic)
 * + GERÇEK `WorkerContract` — SADECE backend sahtedir (model çağrısı YOK;
 * `run` + ölçüm yüzeyi scriptlenir).
 *
 * Her test kendi git repo + output fixture'ını kurar; teardown hepsini
 * kaldırır. Test sürecinin CWD'si test repo'suna bağlanır — asla testin
 * DİŞINDA bir repository keşfedilmez.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  InferenceCoordinator,
  type RuntimeLockLike,
} from "../dist/backend/InferenceCoordinator.js";
import type { LockAcquireResult } from "../dist/backend/RuntimeLock.js";
import {
  type InferenceBackend,
  type InferenceMessage,
  type InferenceResult,
  type InferenceRunOptions,
  type ReasoningEffort,
  type RuntimeInfo,
  type TokenizeResult,
} from "../dist/backend/InferenceBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import { createGitWorktreeWorkspace } from "../dist/workspace/GitWorktreeWorkspace.js";
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceCreateInput,
} from "../dist/workspace/Workspace.js";
import { WorkerContract } from "../dist/worker/WorkerContract.js";
import { WorkerContractError, type WorkerResult } from "../dist/worker/result.js";
import {
  SplashTaskError,
  SplashTaskService,
  type SplashTaskServiceDeps,
} from "../dist/task/SplashTaskService.js";
import {
  ContextAssembler,
  ABSENT_MARKER,
  BINARY_CONTENT_MARKER,
  SYMLINK_MARKER_PREFIX,
} from "../dist/context/ContextAssembler.js";
import { ContextAssemblyError } from "../dist/context/types.js";
import type { SplashConfig } from "../dist/config.js";
import { randomUUID } from "node:crypto";

// ── Hermetic git ortamı ─────────────────────────────────────────────────────

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

/** Test fixture: tmp kök + git repo (HEAD commit'li) + repo dışı outputRoot. */
interface Fixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  config: SplashConfig;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-step6-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const key of GIT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  // Git hermetiği: sistem/global config devre dışı; kimlik env'den; prompt yok.
  await writeFile(path.join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GIT_AUTHOR_NAME = "Splash Step6 Test";
  process.env.GIT_AUTHOR_EMAIL = "step6@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Step6 Test";
  process.env.GIT_COMMITTER_EMAIL = "step6@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Splash Step6 Test");
  git(repoRoot, "config", "user.email", "step6@splash.test");
  git(repoRoot, "config", "core.autocrlf", "false");

  // Bilinen taban içeriği: tam arama/değiştirme + partial/failed senaryoları.
  await writeFile(path.join(repoRoot, "src/a.ts"), "const value = 1;\n");
  await writeFile(path.join(repoRoot, "src/b.ts"), "const other = 10;\n");
  // CRLF + trailing boşluk + SON NEWLINE YOK — birebir bayt koruması için.
  await writeFile(path.join(repoRoot, "src/crlf.ts"), "a  \r\nb");
  // İlgili DEĞİL bir dosya — bağlam'a girmemeli (repository crawl yok, spec 18).
  await writeFile(path.join(repoRoot, "package.json"), '{"name":"fixture-only","secret":"NEVER_IN_CONTEXT"}\n');
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "base");

  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot);

  const config: SplashConfig = {
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
  };
  return { root, repoRoot, outputRoot, config };
}

// ── Sahte backend (model çağrısı YOK — spec 121) ────────────────────────────

interface RunCall {
  messages: InferenceMessage[];
  options: InferenceRunOptions | undefined;
  activeAtStart: number; // eşzamanlı `run` sayısı (FIFO kanıtı)
}

class FakeBackend implements InferenceBackend {
  #current: RuntimeInfo | null = null;
  /** Sonraki `refreshRuntimeInfo`'ın üreteceği bilgi; `null` → hata. */
  nextInfo: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 128_000,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  /** `run` davranışı (varsayılan: boş içerik — parse hatası üretir). */
  runBehavior: (call: RunCall) => Promise<InferenceResult> = async () => ({
    content: "not-a-json",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  #active = 0;
  maxActive = 0;
  runCalls: RunCall[] = [];
  refreshCount = 0;
  /** `countPromptTokens` davranışı (varsayılan: 64K'a sığan küçük sayı). */
  countBehavior: (messages: InferenceMessage[]) => number = () => 1_000;
  countCalls: InferenceMessage[][] = [];
  /** `tokenize` davranışı (pressure-files ipucu için; varsayılan 0). */
  tokenizeBehavior: (content: string) => number = () => 0;

  get runtimeInfo(): RuntimeInfo | null {
    return this.#current;
  }

  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    this.refreshCount++;
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
    this.runCalls.push({ messages, options, activeAtStart: this.#active });
    this.#active++;
    this.maxActive = Math.max(this.maxActive, this.#active);
    try {
      return await this.runBehavior({ messages, options, activeAtStart: this.#active });
    } finally {
      this.#active--;
    }
  }

  async tokenize(content: string): Promise<TokenizeResult> {
    return { tokens: [], count: this.tokenizeBehavior(content) };
  }
  async renderPrompt(): Promise<never> {
    throw new Error("FakeBackend.renderPrompt must not be called in Step 7");
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    this.countCalls.push([...messages]);
    return this.countBehavior(messages);
  }
}

// ── Sahte kilit + scanner (coordinator enjeksiyon dikişleri) ───────────────

class FakeLock implements RuntimeLockLike {
  acquireCount = 0;
  releaseCount = 0;
  /** `true` ise başka bir süreç kilidi tutuyormuş gibi davran. */
  busy = false;
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    this.acquireCount++;
    if (this.busy) {
      return { acquired: false, reason: "busy" };
    }
    return { acquired: true, token: `tok-${ownerId}` };
  }
  async release(_token: string): Promise<void> {
    this.releaseCount++;
  }
}

type ScannerProcesses = Array<{ pid: number; ppid: number; command: string }>;

function cleanScanner(): () => Promise<ScannerProcesses> {
  // İlgisiz host süreçleri — runtime imzalarının HİÇBİRİ.
  return async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
}

// ── Hizmet kurucu (test dikişleriyle) ───────────────────────────────────────

interface Harness {
  fixture: Fixture;
  service: SplashTaskService;
  coordinator: InferenceCoordinator;
  backend: FakeBackend;
  lock: FakeLock;
  scanner: () => Promise<ScannerProcesses>;
  sessionsDir: string;
}

async function makeHarness(
  t: TestContext,
  overrides: Partial<SplashTaskServiceDeps> = {},
  scanner: () => Promise<ScannerProcesses> = cleanScanner(),
): Promise<Harness> {
  const fixture = await makeFixture(t);
  const backend = new FakeBackend();
  const lock = new FakeLock();
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir: path.join(fixture.outputRoot, "runtime"),
    scanner,
    lock,
  });
  const service = new SplashTaskService({
    config: fixture.config,
    coordinator,
    contextAssembler: new ContextAssembler({ runtime: backend }),
    workerContract: new WorkerContract(),
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    newSessionId: overrides.newSessionId ?? randomUUID,
    processCwd: () => fixture.repoRoot,
    ...overrides,
  });
  t.after(async () => {
    await service.dispose().catch(() => undefined);
  });
  return {
    fixture,
    service,
    coordinator,
    backend,
    lock,
    scanner,
    sessionsDir: path.join(fixture.outputRoot, "sessions"),
  };
}

/**
 * Gerçek worktree + KIRIK `destroy` (imha başarısız modellemesi):
 * `#cleanupAfterFailure` yolunu gerçekten yürütür — sahte "başarılı imha"
 * iddiası test edilemez.
 */
async function brokenDestroyWorkspace(input: WorkspaceCreateInput): Promise<Workspace> {
  const real = await createGitWorktreeWorkspace(input);
  return {
    repoRoot: real.repoRoot,
    workspaceDir: real.workspaceDir,
    baseCommit: real.baseCommit,
    sessionId: real.sessionId,
    editablePaths: real.editablePaths,
    base: real.base,
    readBaseEntry: (p: string) => real.readBaseEntry(p),
    applyPatchSet: (result: WorkerResult) => real.applyPatchSet(result),
    resetToBase: () => real.resetToBase(),
    diff: (options) => real.diff(options),
    stat: () => real.stat(),
    exportPatch: (outputRoot: string) => real.exportPatch(outputRoot),
    destroy: async () => {
      throw new Error("worktree removal blocked");
    },
  };
}

/** Worker çıktısını (Step 4 şeması) JSON metnine çevirir. */
function workerJson(body: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 1, ...body });
}

/** `src/a.ts` içindeki bilinen satırı değiştiren geçerli worker çıktısı. */
function okWorkerJson(): string {
  return workerJson({
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

async function sessionIds(sessionsDir: string): Promise<string[]> {
  try {
    return await readdir(sessionsDir);
  } catch {
    return [];
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Koşul sağlanana kadar kısa periyotlarla bekle (race testleri için). */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Testler ─────────────────────────────────────────────────────────────────

test("93: end-to-end success — applied result, worktree written, MAIN CHECKOUT UNTOUCHED, registry retains", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async (call) => {
    await new Promise((r) => setTimeout(r, 10));
    return { content: okWorkerJson(), usage: { inputTokens: 1_234, outputTokens: 567 } };
  };
  // Tam preflight ölçüsü: `usage.in` (1_234) ile AYRI — telemetri dispatch
  // öncesi kesin olmalı; runtime hakedişi ayrı gerçektir (spec 31/32).
  h.backend.countBehavior = () => 777;

  const result = await h.service.executeTask({ task: "Change the value constant from 1 to 2", files: ["src/a.ts"] });

  // Compact result — güvenli metadata (spec 41-52):
  assert.equal(result.status, "applied");
  assert.equal(result.baseStatus, "fresh");
  assert.equal(result.rulesSource, "none");
  assert.match(result.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(result.round, 1);
  assert.equal(result.summary, "Changed value to 2.");
  assert.deepEqual(result.filesChanged, ["src/a.ts"]);
  assert.deepEqual(result.diffStats, { files: 1, insertions: 1, deletions: 1 });
  assert.deepEqual(result.validation, { editsRequested: 1, editsApplied: 1, rejected: [] });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.usage, { in: 1_234, out: 567 });
  assert.equal(result.context.runtimeMaxTokens, 128_000); // backend'in yetkili tavanı
  assert.equal(result.context.inputTokens, 777); // TAM preflight ölçüsü — usage.in (1_234) ASLA değil
  assert.equal(result.context.outputReserveTokens, 32_768); // config.minOutputReserve
  assert.equal(result.context.selectedContextTier, "64k"); // 65536'ya sığdı; 128K'a KALKMADI (inflation YOK)
  assert.equal(result.context.truncatedReadonlyContext, false);
  assert.ok(!("inference" in result) && !("splitHint" in result) && !("staleFiles" in result));

  // Worktree'ye yazıldı (izole) — spec 40:
  const workspaceDir = path.join(h.sessionsDir, result.sessionId, "workspace");
  const worktreeFile = await readFile(path.join(workspaceDir, "src/a.ts"), "utf8");
  assert.equal(worktreeFile, "const value = 2;\n");

  // ANA CHECKOUT DOKUNULMADI (spec 13):
  const mainFile = await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8");
  assert.equal(mainFile, "const value = 1;\n");

  // Kayıt defteri: görev canlı (refine/close Step 9'da kullanacak) — spec 64/66:
  assert.equal(h.service.activeTasks().length, 1);
  assert.equal(h.service.activeTasks()[0]?.latestResult.status, "applied");
  assert.ok(await pathExists(workspaceDir));

  // Tek dispatch; seçenekler (spec 34):
  assert.equal(h.backend.runCalls.length, 1);
  assert.equal(h.backend.runCalls[0]?.options?.maxOutputTokens, 32_768);
  assert.equal(h.backend.runCalls[0]?.options?.contextTier, 65_536); // seçilen kade metadata'sı
  assert.equal(h.backend.runCalls[0]?.options?.reasoningEffort, undefined); // verilmedi → YOK

  // Bağlam: exact taban içeriği + seçili DEĞİL dosya GİRMEDİ (spec 18/21):
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(userMessage.includes("===== EDITABLE BASE: src/a.ts ====="));
  assert.ok(userMessage.includes("const value = 1;")); // exact taban (worktree)
  assert.ok(userMessage.includes("Change the value constant from 1 to 2")); // orijinal task
  assert.ok(!userMessage.includes("NEVER_IN_CONTEXT"), "package.json içeriği bağlam'a sızdı (crawl!)");
  assert.ok(!userMessage.includes("const other = 10"), "seçilmemiş src/b.ts bağlam'a sızdı (crawl!)");
});

test("21: exact byte preservation — CRLF + trailing spaces + no final newline", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({ summary: "No changes needed.", edits: [] }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  const result = await h.service.executeTask({ task: "Inspect the file", files: ["src/crlf.ts"] });
  assert.equal(result.status, "applied"); // 0/0 no-op = geçerli tur (spec 43)
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  // Birebir: `a` + 2 boşluk + CRLF + `b` + SON NEWLINE YOK (blok bitiş \n'ı hariç).
  assert.ok(userMessage.includes("===== EDITABLE BASE: src/crlf.ts =====\na  \r\nb\n===== END EDITABLE BASE: src/crlf.ts ====="));
});

test("22: binary editable file → deterministic marker, no replacement characters", async (t) => {
  const h = await makeHarness(t);
  // Fixture'taki package.json'u binary'a çevir (tabanda geçersiz UTF-8).
  await writeFile(path.join(h.fixture.repoRoot, "package.json"), Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x42]));
  git(h.fixture.repoRoot, "add", "-A");
  git(h.fixture.repoRoot, "commit", "-m", "binary");
  h.backend.runBehavior = async () => ({
    content: workerJson({ summary: "Inspected.", edits: [] }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  await h.service.executeTask({ task: "Inspect", files: ["package.json"] });
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(userMessage.includes(BINARY_CONTENT_MARKER));
  assert.ok(!userMessage.includes("\uFFFD"), "U+FFFD ikame karakteri bağlam'a sızmamalı");
});

test("24: absent editable path → ABSENT marker; worker create applies", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Created the new file.",
      edits: [{ kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" }],
    }),
    usage: { inputTokens: 12, outputTokens: 30 },
  });

  const result = await h.service.executeTask({ task: "Create src/new.ts", files: ["src/new.ts"] });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.filesChanged, ["src/new.ts"]);
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(userMessage.includes(ABSENT_MARKER));
  const created = await readFile(path.join(h.sessionsDir, result.sessionId, "workspace/src/new.ts"), "utf8");
  assert.equal(created, "export const fresh = true;\n");
});

test("23: symlink editable path → link metadata, target content NOT followed", async (t) => {
  const h = await makeHarness(t);
  // Repo içi hedefli symlink (Step 5: iç hedef = kabul; dış hedef = red).
  await symlink("a.ts", path.join(h.fixture.repoRoot, "src/link.ts"));
  git(h.fixture.repoRoot, "add", "-A");
  git(h.fixture.repoRoot, "commit", "-m", "symlink");
  h.backend.runBehavior = async () => ({
    content: workerJson({ summary: "Nothing to do.", edits: [] }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  await h.service.executeTask({ task: "Inspect the link", files: ["src/link.ts"] });
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(userMessage.includes(`${SYMLINK_MARKER_PREFIX}a.ts]`));
  assert.ok(!userMessage.includes("const value = 1;"), "link hedefinin İÇERİĞİ bağlam'a sızdı");
});

test("97: empty / whitespace task → invalid_input; nothing created, no dispatch", async (t) => {
  const h = await makeHarness(t);
  await assert.rejects(
    h.service.executeTask({ task: "   \n\t ", files: [] }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "invalid_input",
  );
  assert.ok(!(await pathExists(h.sessionsDir)), "boş task'ta session dizini OLUŞMAMALI");
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(h.lock.acquireCount, 0);
});

test("10: non-git project root → invalid_repository; no session, no dispatch", async (t) => {
  const h = await makeHarness(t);
  const notGit = path.join(h.fixture.root, "not-git");
  await mkdir(notGit, { recursive: true });
  const service = new SplashTaskService({
    config: { ...h.fixture.config, repoRoot: notGit },
    coordinator: h.coordinator,
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    processCwd: () => notGit,
  });
  await assert.rejects(
    service.executeTask({ task: "Anything", files: [] }),
    (err: unknown) => err instanceof WorkspaceError && err.kind === "invalid_repository",
  );
  assert.ok(!(await pathExists(h.sessionsDir)));
  assert.equal(h.lock.acquireCount, 0);
});

test("102: outputRoot == repoRoot → output_root_unsafe BEFORE any mkdir", async (t) => {
  const h = await makeHarness(t);
  await assert.rejects(
    (() => {
      const service = new SplashTaskService({
        config: { ...h.fixture.config, outputRoot: h.fixture.repoRoot },
        coordinator: new InferenceCoordinator({
          backend: h.backend,
          runtimeDir: path.join(h.fixture.outputRoot, "runtime"),
          scanner: cleanScanner(),
          lock: h.lock,
        }),
        contextAssembler: new ContextAssembler({ runtime: h.backend }),
        processCwd: () => h.fixture.repoRoot,
      });
      return service.executeTask({ task: "Anything", files: [] });
    })(),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "output_root_unsafe",
  );
  // Kullanıcının repository'sinde `sessions` dizini ASLA oluşmaz (spec 13/102):
  assert.ok(!(await pathExists(path.join(h.fixture.repoRoot, "sessions"))));
  assert.equal(h.lock.acquireCount, 0);
});

test("102: outputRoot INSIDE repo → output_root_unsafe (no sessions dir in repo)", async (t) => {
  const h = await makeHarness(t);
  const inside = path.join(h.fixture.repoRoot, "scratch");
  await mkdir(inside, { recursive: true });
  const service = new SplashTaskService({
    config: { ...h.fixture.config, outputRoot: inside },
    coordinator: new InferenceCoordinator({
      backend: h.backend,
      runtimeDir: path.join(h.fixture.outputRoot, "runtime"),
      scanner: cleanScanner(),
      lock: h.lock,
    }),
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    processCwd: () => h.fixture.repoRoot,
  });
  await assert.rejects(
    service.executeTask({ task: "Anything", files: [] }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "output_root_unsafe",
  );
  assert.ok(!(await pathExists(path.join(inside, "sessions"))), "repo İÇİ outputRoot'ta sessions oluşmamalı");
});

test("102: repo inside outputRoot (reverse) is ACCEPTED — sessions/workspace stay outside the repo", async (t) => {
  const h = await makeHarness(t);
  // outputRoot = fixture KÖKÜ; repo onun İÇİNDE (root/repo) — ortak atal.
  // Ters yön tek başına güvensiz DEĞİLDİR: `root/sessions/<id>/workspace`
  // repository ağacına otomatik girmez.
  const service = new SplashTaskService({
    config: { ...h.fixture.config, outputRoot: h.fixture.root },
    coordinator: h.coordinator,
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    processCwd: () => h.fixture.repoRoot,
  });
  h.backend.runBehavior = async () => ({ content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } });

  const result = await service.executeTask({ task: "Change the value", files: ["src/a.ts"] });
  assert.equal(result.status, "applied");

  // Session + workspace dizinleri repo DIŞINDA (ortak atal altındaki kardeş ağaç):
  const sessionDir = path.join(h.fixture.root, "sessions", result.sessionId);
  const workspaceDir = path.join(sessionDir, "workspace");
  const relSession = path.relative(h.fixture.repoRoot, sessionDir);
  const relWorkspace = path.relative(h.fixture.repoRoot, workspaceDir);
  assert.ok(relSession.startsWith(".."), `session dizini repo dışında kalmalı: ${relSession}`);
  assert.ok(relWorkspace.startsWith(".."), `workspace repo dışında kalmalı: ${relWorkspace}`);
  assert.ok(await pathExists(workspaceDir));
  // Ana checkout yine dokunulmadı (spec 13):
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");
});

test("111/117: session id collision → session_conflict; no workspace, no dispatch", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "fixed-id" });
  h.backend.runBehavior = async () => ({ content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } });

  const first = await h.service.executeTask({ task: "First task", files: ["src/a.ts"] });
  assert.equal(first.sessionId, "fixed-id");

  await assert.rejects(
    h.service.executeTask({ task: "Second task", files: ["src/a.ts"] }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "session_conflict",
  );
  // Çakışan deneme workspace OLUŞTURMADI (spec 117): tek workspace dizini.
  assert.deepEqual(await sessionIds(h.sessionsDir), ["fixed-id"]);
  // Ve inference'a İNMEDİ:
  assert.equal(h.backend.runCalls.length, 1);
  assert.equal(h.lock.acquireCount, 1);
  // Kayıt defterinde hâlâ yalnızca ilk görev (sessiz ezip-yazma YOK):
  assert.equal(h.service.activeTasks().length, 1);
  assert.equal(h.service.activeTasks()[0]?.latestResult.summary, "Changed value to 2.");
});

test("112: semantic rejection → `failed` (0 applied) is a NORMAL result; workspace retained", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "failed-id" });
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Tried, but the base moved.",
      edits: [
        {
          kind: "modify",
          path: "src/a.ts",
          operations: [{ search: "a string that is not in the base at all", replace: "x" }],
        },
      ],
    }),
    usage: { inputTokens: 100, outputTokens: 40 },
  });

  const result = await h.service.executeTask({ task: "Change something", files: ["src/a.ts"] });
  assert.equal(result.status, "failed"); // semantik red — MCP hatası DEĞİL (spec 112)
  assert.equal(result.validation.editsRequested, 1);
  assert.equal(result.validation.editsApplied, 0);
  assert.equal(result.validation.rejected.length, 1);
  assert.equal(result.validation.rejected[0]?.file, "src/a.ts");
  assert.equal(result.validation.rejected[0]?.edit, 0);
  assert.ok(result.validation.rejected[0]?.reason.length > 0); // SABİТ sözlük; içerik YOK
  assert.deepEqual(result.filesChanged, []);
  // Workspace CANLI (refine edilebilir) — imha YOK:
  assert.equal(h.service.activeTasks().length, 1);
  assert.ok(await pathExists(path.join(h.sessionsDir, "failed-id", "workspace")));
});

test("112: mixed edits → `partial` (1 applied + 1 rejected)", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "One change landed.",
      edits: [
        {
          kind: "modify",
          path: "src/a.ts",
          operations: [{ search: "const value = 1;", replace: "const value = 2;" }],
        },
        {
          kind: "modify",
          path: "src/b.ts",
          operations: [{ search: "also not in the base", replace: "y" }],
        },
      ],
    }),
    usage: { inputTokens: 100, outputTokens: 60 },
  });

  const result = await h.service.executeTask({ task: "Change both", files: ["src/a.ts", "src/b.ts"] });
  assert.equal(result.status, "partial");
  assert.equal(result.validation.editsRequested, 2);
  assert.equal(result.validation.editsApplied, 1);
  assert.equal(result.validation.rejected.length, 1);
  assert.equal(result.validation.rejected[0]?.file, "src/b.ts");
  assert.deepEqual(result.filesChanged, ["src/a.ts"]);
  assert.equal(h.service.activeTasks().length, 1);
});

test("36/66: external runtime (mlx) → inference_busy; workspace retained; backend NOT called", async (t) => {
  const h = await makeHarness(t, {}, async () => [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 777, ppid: 1, command: "/opt/homebrew/bin/mlx_lm.server --port 8080" },
  ]);
  h.backend.runBehavior = async () => {
    throw new Error("backend.run must NOT be called when the host is busy");
  };

  const result = await h.service.executeTask({ task: "Anything", files: ["src/a.ts"] });
  assert.equal(result.status, "inference_busy");
  assert.equal(result.inference?.conflict, "mlx");
  assert.equal(result.baseStatus, "fresh");
  assert.deepEqual(result.usage, { in: 0, out: 0 });
  // Bağlam telemetrisi dispatch ÖNCESİ (assembler) tamamlandı — bütçe seçimi
  // busy sonuçta da raporlanır (spec 37):
  assert.equal(result.context.runtimeMaxTokens, 128_000);
  assert.equal(result.context.inputTokens, 0); // model çağrılmadı
  assert.equal(result.context.outputReserveTokens, 32_768);
  assert.equal(result.context.selectedContextTier, "64k");
  assert.deepEqual(result.filesChanged, []);
  assert.equal(result.validation.editsRequested, 0);
  assert.ok(result.summary.length > 0);
  // Workspace KORUNDU (refine/close Step 9'da kullanacak) — spec 66:
  assert.equal(h.service.activeTasks().length, 1);
  assert.ok(await pathExists(path.join(h.sessionsDir, result.sessionId, "workspace")));
  // Gerçek generation YOK:
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(h.lock.acquireCount, 1);
  assert.equal(h.lock.releaseCount, 1); // busy yolunda da kilit bırakıldı
});

test("36: another Splash process holds the lock → inference_busy/splash", async (t) => {
  const h = await makeHarness(t);
  h.lock.busy = true; // süreçler-arası kilit başka Splash sürecinde
  h.backend.runBehavior = async () => {
    throw new Error("backend.run must NOT be called when the cross-process lock is held");
  };

  const result = await h.service.executeTask({ task: "Anything", files: ["src/a.ts"] });
  assert.equal(result.status, "inference_busy");
  assert.equal(result.inference?.conflict, "splash");
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(h.service.activeTasks().length, 1); // workspace korundu
});

test("115: worker output unparseable → WorkerContractError(invalid_output) + workspace cleanup", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "parse-fail" });
  h.backend.runBehavior = async () => ({
    content: "Sure! Here is my patch:\n```json\n{...}\n```",
    usage: { inputTokens: 50, outputTokens: 25 },
  });

  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"] }),
    (err: unknown) => err instanceof WorkerContractError && err.kind === "invalid_output",
  );
  // Sonuç korunamadı → workspace imha + boş dizin temizliği (spec 73/115):
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "parse-fail"))), "boş session dizini kalmamalı");
});

test("118: backend failure after workspace creation → original typed error + cleanup", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "http-fail" });
  h.backend.runBehavior = async () => {
    throw new BackendError("http", "Inference request failed with HTTP status 500 (/v1/chat/completions)", {
      status: 500,
      cause: "RAW_RESPONSE_BODY_WITH_SECRETS",
    });
  };

  const err = await h.service
    .executeTask({ task: "Anything", files: ["src/a.ts"] })
    .then(() => {
      throw new Error("unreachable");
    })
    .catch((e: unknown) => e);
  assert.ok(err instanceof BackendError && err.kind === "http" && err.status === 500);
  // Orijinal hatanın `message`'i güvenli; `cause` (gövde fragmenti) taşınmaz:
  assert.ok(!String(err.message).includes("RAW_RESPONSE_BODY"));
  // Sonuç korunamadı → workspace imha + boş dizin temizliği (spec 73/118):
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "http-fail"))));
});

test("34: reasoning_effort pass-through — provided → forwarded; absent → ABSENT from options", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async (call) => ({
    content: okWorkerJson(),
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  await h.service.executeTask({ task: "One", files: ["src/a.ts"], reasoningEffort: "xhigh" });
  await h.service.executeTask({ task: "Two", files: ["src/a.ts"] });

  assert.equal(h.backend.runCalls[0]?.options?.reasoningEffort, "xhigh" as ReasoningEffort);
  assert.equal(h.backend.runCalls[1]?.options?.reasoningEffort, undefined);
  assert.ok(!("reasoningEffort" in (h.backend.runCalls[1]?.options ?? {})), "verilmeyen alan YOK olmalı");
});

test("4/124: process-wide shared coordinator serializes concurrent tasks (FIFO, never busy in-process)", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async (call) => {
    if (call === h.backend.runCalls[0]) {
      // İlk işi 100ms BLOKE et — ikinci istek bu sürede kuyruğa düşsün.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } };
  };

  // Eşzamanlı iki görev — aynı (süreç-tek) coordinator üzerinden:
  const [first, second] = await Promise.all([
    h.service.executeTask({ task: "Task A", files: ["src/a.ts"] }),
    h.service.executeTask({ task: "Task B", files: ["src/a.ts"] }),
  ]);
  // İkisi de NORMAL sonuç — in-process bekleyiş busy DEĞİLDİR (Step 3 kuralı):
  assert.equal(first.status, "applied");
  assert.equal(second.status, "applied");
  // Tam olarak BİR `run` eşzamanlıydı (FIFO kanıtı — asla paralel generation):
  assert.equal(h.backend.maxActive, 1);
  assert.equal(h.backend.runCalls.length, 2);
  // Her `run` başladığında BAŞKA aktif run YOKTU (paralel olsaydı ikincisi 1
  // görürdü) — ikincisi, ilkinin bitmesini BEKLEDİ:
  assert.deepEqual(h.backend.runCalls.map((c) => c.activeAtStart), [0, 0]);
});

test("69/119/120: dispose() — registry cleared, worktrees destroyed, session dirs removed, then shutting_down", async (t) => {
  let id = 0;
  const h = await makeHarness(t, { newSessionId: () => `dispose-${(id += 1)}` });
  h.backend.runBehavior = async () => ({ content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } });

  const a = await h.service.executeTask({ task: "A", files: ["src/a.ts"] });
  const b = await h.service.executeTask({ task: "B", files: ["src/a.ts"] });
  assert.equal(h.service.activeTasks().length, 2);
  assert.ok(await pathExists(path.join(h.sessionsDir, a.sessionId, "workspace")));
  assert.ok(await pathExists(path.join(h.sessionsDir, b.sessionId, "workspace")));

  await h.service.dispose();
  // Kayıt defteri boş; TÜM session dizinleri (boşalan) temizlendi (spec 69):
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, a.sessionId))));
  assert.ok(!(await pathExists(path.join(h.sessionsDir, b.sessionId))));
  // dispose IDEMPOTENT:
  await h.service.dispose();
  // Sonrası: yeni görev reddedilir (spec 69/71):
  await assert.rejects(
    h.service.executeTask({ task: "After dispose", files: [] }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "shutting_down",
  );
});

test("74: cleanup failure surfaces as safe task_cleanup_failed (no false 'clean' claim)", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => {
    throw new Error("sudden backend failure (arbitrary payload)");
  };
  // Gerçek worktree + KIRIK destroy: inference hatası (sonuç yok) →
  // #cleanupAfterFailure → imha başarısız → GÜVENLİ tip'li hata (spec 74):
  const service = new SplashTaskService({
    config: h.fixture.config,
    coordinator: h.coordinator,
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    createWorkspace: brokenDestroyWorkspace,
    processCwd: () => h.fixture.repoRoot,
    newSessionId: () => "cleanup-fail",
  });
  await assert.rejects(
    service.executeTask({ task: "Anything", files: ["src/a.ts"] }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "task_cleanup_failed",
  );
  // İmha edilemeyen dizin DOKUNULMAZ (rekürsif silme YOK — spec 75):
  assert.ok(
    await pathExists(path.join(h.sessionsDir, "cleanup-fail", "workspace")),
    "imha edilemeyen worktree silinemez",
  );
});

test("35: pre-aborted MCP signal → CoordinatorError(aborted) + cleanup; backend never runs", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "aborted-sig" });
  h.backend.runBehavior = async () => {
    throw new Error("backend.run must NOT run for an already-aborted request");
  };

  const controller = new AbortController();
  controller.abort("client cancelled"); // dispatch'ten ÖNCE iptal

  // Step 7: iptal sinyali ÖNCE assembler'ın `refreshRuntimeInfo`'una düşer —
  // tip'li backend hatası (network/aborted) aynen yayılır; dispatch'a inilmez.
  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"], signal: controller.signal }),
    (err: unknown) => err instanceof BackendError && err.kind === "network",
  );
  // İptal edilmiş istek: workspace imha + boş dizin temizliği; kayıt defteri boş:
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "aborted-sig"))));
  assert.equal(h.backend.runCalls.length, 0);
});

test("64/57: active registry exposes latestResult per session (diagnostic surface)", async (t) => {
  let id = 0;
  const h = await makeHarness(t, { newSessionId: () => `reg-${(id += 1)}` });
  h.backend.runBehavior = async () => ({ content: okWorkerJson(), usage: { inputTokens: 2, outputTokens: 2 } });
  const a = await h.service.executeTask({ task: "A", files: ["src/a.ts"] });
  const b = await h.service.executeTask({ task: "B", files: ["src/a.ts"] });
  const tasks = h.service.activeTasks();
  assert.equal(tasks.length, 2);
  const byId = new Map(tasks.map((task) => [task.workspace.sessionId, task]));
  assert.equal(byId.get(a.sessionId)?.latestResult.summary, "Changed value to 2.");
  assert.equal(byId.get(b.sessionId)?.latestResult.summary, "Changed value to 2.");
  // `latestResult` = compact result (wire'a birebir gider):
  assert.equal(byId.get(a.sessionId)?.latestResult.status, "applied");
});

test("69/120: dispose racing in-flight inference — awaited; task rejects shutting_down; no orphan worktree", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "race-1" });
  let releaseInference: (() => void) | undefined;
  h.backend.runBehavior = async () => {
    // inference BLOKE — tamamlanmayı test kontrol ediyor:
    await new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    return { content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } };
  };

  const task = h.service.executeTask({ task: "Racy", files: ["src/a.ts"] });
  // Workspace + bağlam hazır, inference gerçekten bloke:
  await waitFor(() => h.backend.runCalls.length === 1);

  let disposeSettled = false;
  let disposeRejected = false;
  const disposePromise = h.service
    .dispose()
    .then(
      () => {
        disposeSettled = true;
      },
      () => {
        disposeSettled = true;
        disposeRejected = true; // yutulmaz — sonda `false` olarak doğrulanır
      },
    );

  // dispose, A hâlâ inference'ta bekliyorken ÇÖZÜLMEZ (in-flight bekleniyor):
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.service.disposed, true);
  assert.equal(disposeSettled, false);

  releaseInference?.();
  // A, shutdown kazandığı için BAŞARI DÖNMEZ — güvenli tip'li red:
  await assert.rejects(
    task,
    (err: unknown) => err instanceof SplashTaskError && err.kind === "shutting_down",
  );
  // dispose, A'nın BEKLENEN (await'lenen) temizliğinden SONRA çözüldü:
  await disposePromise;
  assert.equal(disposeSettled, true);
  // Başarılı yarış → dispose BAŞARIyla çözüldü (cleanup hatası YOK):
  assert.equal(disposeRejected, false);
  // Kayıt defteri boş (A koruma yerine self-cleanup yaptı):
  assert.equal(h.service.activeTasks().length, 0);
  // Workspace imha + session dizini temiz:
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "race-1"))));
  // Orfan git worktree YOK — ana repo yalnız kendi worktree'sini listeler:
  const listed = execFileSync("git", ["worktree", "list"], { cwd: h.fixture.repoRoot, encoding: "utf8" });
  assert.equal(listed.split("\n").filter(Boolean).length, 1);
});

test("74/69: dispose racing in-flight task whose destroy fails — task_cleanup_failed (never swallowed)", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "race-2", createWorkspace: brokenDestroyWorkspace });
  let releaseInference: (() => void) | undefined;
  h.backend.runBehavior = async () => {
    await new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    return { content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } };
  };

  const task = h.service.executeTask({ task: "Racy", files: ["src/a.ts"] });
  await waitFor(() => h.backend.runCalls.length === 1);

  // `dispose()`'un redi DERHAL yakalanır (handler gecikmesinde unhandled
  // rejection tuzağı yok); neden sonda DOĞRULANIR — yutma YOK.
  let disposeRejected = false;
  let disposeReason: unknown;
  const disposeOutcome = h.service
    .dispose()
    .then(
      () => {
        disposeReason = undefined;
      },
      (err) => {
        disposeRejected = true;
        disposeReason = err;
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseInference?.();

  // İmha başarısız → görev `task_cleanup_failed` ile reddedilir (yutulmaz):
  await assert.rejects(
    task,
    (err: unknown) => err instanceof SplashTaskError && err.kind === "task_cleanup_failed",
  );
  // VE dispose AYNI temizlik hatasını yüzeye çıkarır — sahte "başarılı
  // shutdown" raporlanamaz (orhan workspace ile `process.exit` riski kapalı):
  await disposeOutcome;
  assert.equal(disposeRejected, true, "dispose cleanup hatasını red olarak YÜZEYE ÇIKARMALI");
  assert.ok(
    disposeReason instanceof SplashTaskError && disposeReason.kind === "task_cleanup_failed",
    `dispose red nedeni task_cleanup_failed olmalı: ${String(disposeReason)}`,
  );
  assert.equal(h.service.activeTasks().length, 0);
  // İmha edilemeyen workspace DOKUNULMAZ — sahte "temiz" raporu YOK:
  assert.ok(await pathExists(path.join(h.sessionsDir, "race-2", "workspace")));
});

test("69: multi-task shutdown — A cleanup fails, B cleanup succeeds; BOTH attempted; dispose rejects", async (t) => {
  let id = 0;
  const h = await makeHarness(t, {
    newSessionId: () => `mm-${(id += 1)}`,
    // İlk oluşturulan (mm-1) worktree'nin destroy'u KIRIK; ikincisi normal.
    createWorkspace: (input) =>
      input.sessionId === "mm-1" ? brokenDestroyWorkspace(input) : createGitWorktreeWorkspace(input),
  });
  let releaseFirst: (() => void) | undefined;
  h.backend.runBehavior = async (call) => {
    if (call === h.backend.runCalls[0]) {
      // İlk (A) run BLOKE — ikinci (B) coordinator kuyruğunda bekler.
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return { content: okWorkerJson(), usage: { inputTokens: 1, outputTokens: 1 } };
  };

  const a = h.service.executeTask({ task: "A", files: ["src/a.ts"] });
  // A: workspace + bağlam hazır, inference BLOKE (sıra garantili: B'den önce).
  await waitFor(() => h.backend.runCalls.length === 1);
  // B: başlatıldı — in-flight defterinde (kuyrukta).
  const b = h.service.executeTask({ task: "B", files: ["src/a.ts"] });

  // `dispose()`'un redi DERHAL yakalanır; neden sonda doğrulanır (yutma YOK).
  let disposeRejected = false;
  let disposeReason: unknown;
  const disposeOutcome = h.service
    .dispose()
    .then(
      () => {
        disposeReason = undefined;
      },
      (err) => {
        disposeRejected = true;
        disposeReason = err;
      },
    );
  releaseFirst?.();

  // A: destroy başarısız → `task_cleanup_failed` (yutulmaz):
  await assert.rejects(
    a,
    (err: unknown) => err instanceof SplashTaskError && err.kind === "task_cleanup_failed",
  );
  // B: destroy başarılı → `shutting_down` (shutdown kazandı, temizlik tamam):
  await assert.rejects(
    b,
    (err: unknown) => err instanceof SplashTaskError && err.kind === "shutting_down",
  );
  // A'nın cleanup hatası B'nin temizliğini KESMEZ — B'nin dizini temizlendi:
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "mm-2"))), "B session dizini temizlenmeli");
  // A'nın imha edilemeyen workspace'i DOKUNULMAZ (bilinen artık; sahte temizlik YOK):
  assert.ok(await pathExists(path.join(h.sessionsDir, "mm-1", "workspace")));
  // dispose: HER iki görevin terminal yolunu bekledi ve cleanup hatasını yüzeye çıkardı:
  await disposeOutcome;
  assert.equal(disposeRejected, true, "dispose cleanup hatasını red olarak YÜZEYE ÇIKARMALI");
  assert.ok(
    disposeReason instanceof SplashTaskError && disposeReason.kind === "task_cleanup_failed",
    `dispose red nedeni task_cleanup_failed olmalı: ${String(disposeReason)}`,
  );
  assert.equal(h.service.activeTasks().length, 0);
});

test("32: context assembly fails (fault-injected) → typed error propagates; no inference; cleanup", async (t) => {
  // Step 7: bağlam artık ContextAssembler'da — fs arıza sınıflandırması
  // (ENOENT ≠ EACCES/...) o modülün testlerinde (`context-assembler.test.ts`);
  // servis katmanı burada yalnız TÜP'li hatanın yayılım + temizlik yolunu
  // doğrular: bağlam kurulamazsa inference'a ASLA inilmez.
  const h = await makeHarness(t, {
    newSessionId: () => "assembly-fail",
    contextAssembler: {
      async assemble() {
        throw new ContextAssemblyError("assembly_failed", "Measuring the prompt failed", {
          cause: Object.assign(new Error("EACCES (fault-injected)"), { code: "EACCES" }),
        });
      },
    },
  });
  h.backend.runBehavior = async () => {
    throw new Error("inference must NOT run when the context cannot be built");
  };

  const err = await h.service
    .executeTask({ task: "Anything", files: ["src/a.ts"] })
    .then(() => {
      throw new Error("unreachable");
    })
    .catch((e: unknown) => e);
  assert.ok(err instanceof ContextAssemblyError && err.kind === "assembly_failed");
  // `cause` (fs errno) kamu yüzeyine taşınmaz — mesaj SABİТtir:
  assert.ok(!String(err.message).includes("EACCES"));
  // Bağlam kurulamadı → dispatch YOK:
  assert.equal(h.backend.runCalls.length, 0);
  // Temizlik: kayıt defteri boş + session dizini gitti (spec 73):
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "assembly-fail"))));
});

test("32: unsafe read-only path (fault-injected) → ContextAssemblyError(unsafe_path); cleanup", async (t) => {
  const h = await makeHarness(t, {
    newSessionId: () => "unsafe-ctx",
    contextAssembler: {
      async assemble() {
        throw new ContextAssemblyError("unsafe_path", "A selected path is unsafe");
      },
    },
  });
  h.backend.runBehavior = async () => {
    throw new Error("inference must NOT run when the context is unsafe");
  };

  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"] }),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "unsafe_path",
  );
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "unsafe-ctx"))));
});

// ── Step 7: bağlam katmanı (assembler) uçtan uca ────────────────────────────

test("32: required context + reserve > runtime max → needs_split; no model call; workspace RETAINED", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "split-1" });
  // required(100_000) + min pay(32_768) > runtime max(128_000): sığmaz.
  h.backend.countBehavior = () => 100_000;
  h.backend.tokenizeBehavior = () => 42; // pressure ipucu: içerik YOK, sayı var
  h.backend.runBehavior = async () => {
    throw new Error("inference must NOT run for needs_split");
  };

  const result = await h.service.executeTask({ task: "Touch everything", files: ["src/a.ts"] });

  assert.equal(result.status, "needs_split"); // NORMAL compact sonuç — hata DEĞİL (spec 32)
  assert.equal(result.baseStatus, "fresh");
  assert.equal(result.rulesSource, "none");
  assert.equal(result.round, 1);
  assert.deepEqual(result.usage, { in: 0, out: 0 }); // model çağrılmadı
  assert.deepEqual(result.filesChanged, []);
  assert.deepEqual(result.diffStats, { files: 0, insertions: 0, deletions: 0 });
  assert.deepEqual(result.validation, { editsRequested: 0, editsApplied: 0, rejected: [] });
  assert.ok(result.warnings.length > 0); // SABİТ needs_split uyarısı (kaynak içerik YOK)
  for (const warning of result.warnings) {
    assert.ok(!warning.includes("src/"), "uyarı yol taşımaz");
  }
  // Telemetri + split ipucı (kaynak içerik YOK — yalnız sayılar + yol adları):
  assert.equal(result.context.runtimeMaxTokens, 128_000);
  assert.equal(result.context.inputTokens, 0);
  assert.equal(result.context.outputReserveTokens, 32_768);
  assert.equal(result.context.selectedContextTier, "runtime_max");
  assert.ok("splitHint" in result);
  if ("splitHint" in result) {
    assert.equal(result.splitHint.requiredInputTokens, 100_000);
    assert.equal(result.splitHint.availableMaxTokens, 128_000);
    assert.equal(result.splitHint.outputReserveTokens, 32_768);
    assert.deepEqual(result.splitHint.pressureFiles, ["src/a.ts"]);
  }
  // Model çağrılmadı (dispatch YOK):
  assert.equal(h.backend.runCalls.length, 0);
  // Workspace KORUNDU (Step 9 refine/close kullanabilir) — imha YOK:
  assert.equal(h.service.activeTasks().length, 1);
  assert.ok(await pathExists(path.join(h.sessionsDir, "split-1", "workspace")));
});

test("31: explicit context tier above the runtime maximum → invalid_input + workspace destroyed", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "tier-over" });
  h.backend.runBehavior = async () => {
    throw new Error("inference must NOT run for an invalid tier");
  };

  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"], contextTier: "128k" }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "invalid_input",
  );
  // Sonuç korunamadı → workspace imha + session dizini temiz; dispatch YOK:
  assert.equal(h.service.activeTasks().length, 0);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, "tier-over"))));
  assert.equal(h.backend.runCalls.length, 0);
});

test("31: explicit output reserve below the configured minimum → invalid_input BEFORE workspace", async (t) => {
  const h = await makeHarness(t);
  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"], outputReserveTokens: 1_000 }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "invalid_input",
  );
  // Bütçe ön-doğrulanır: session dizini bile OLUŞMAZ (spec 13 sıralaması):
  assert.ok(!(await pathExists(h.sessionsDir)));
  assert.equal(h.backend.runCalls.length, 0);
});

test("31: explicit output reserve accepted → negotiated budget + dispatch metadata", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => ({
    content: okWorkerJson(),
    usage: { inputTokens: 999, outputTokens: 11 },
  });

  const result = await h.service.executeTask({
    task: "Change the value",
    files: ["src/a.ts"],
    outputReserveTokens: 40_000,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.context.outputReserveTokens, 40_000); // açık pay müzakere YOK
  // Kademe yine adaptif (64K'a sığan 128K'a KALKMAZ):
  assert.equal(result.context.selectedContextTier, "64k");
  assert.equal(h.backend.runCalls[0]?.options?.maxOutputTokens, 40_000);
});

// BLOCKER 4: açık "128k" (runtime ≥ 128K) → kade 131072 + etiket "128k".
test("BLOCKER 4: context_tier \"128k\" (runtime 131072) → selected 131072, label 128k", async (t) => {
  const h = await makeHarness(t);
  h.backend.nextInfo = {
    ready: true,
    maximumContextTokens: 131_072,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  h.backend.runBehavior = async () => ({
    content: okWorkerJson(),
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const result = await h.service.executeTask({
    task: "Change the value",
    files: ["src/a.ts"],
    contextTier: "128k",
  });
  assert.equal(result.status, "applied");
  assert.equal(result.context.selectedContextTier, "128k");
});

// BLOCKER 4: açık "runtime_max" (max 131072) → etiket "runtime_max" (128k DEĞİL).
test("BLOCKER 4: context_tier \"runtime_max\" (max 131072) → label runtime_max (provenance)", async (t) => {
  const h = await makeHarness(t);
  h.backend.nextInfo = {
    ready: true,
    maximumContextTokens: 131_072,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  h.backend.runBehavior = async () => ({
    content: okWorkerJson(),
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const result = await h.service.executeTask({
    task: "Change the value",
    files: ["src/a.ts"],
    contextTier: "runtime_max",
  });
  assert.equal(result.status, "applied");
  assert.equal(result.context.selectedContextTier, "runtime_max");
});

// BLOCKER 4: açık "192k" (max 131072) → invalid_input (sessizce sıkıştırılmaz); inference YOK.
test("BLOCKER 4: context_tier \"192k\" (max 131072) → invalid_input, no inference", async (t) => {
  const h = await makeHarness(t, { newSessionId: () => "tier-192" });
  h.backend.nextInfo = {
    ready: true,
    maximumContextTokens: 131_072,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  h.backend.runBehavior = async () => {
    throw new Error("inference must NOT run for an invalid tier");
  };
  await assert.rejects(
    h.service.executeTask({ task: "Anything", files: ["src/a.ts"], contextTier: "192k" }),
    (err: unknown) => err instanceof SplashTaskError && err.kind === "invalid_input",
  );
  assert.equal(h.backend.runCalls.length, 0);
});

test("26: secret in the task → redacted before the worker sees it; warning; never on the wire", async (t) => {
  const h = await makeHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({ summary: "Done.", edits: [] }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const rawSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const task = `Rotate the credential. Current: ${rawSecret}`;

  const result = await h.service.executeTask({ task, files: ["src/a.ts"] });
  assert.equal(result.status, "applied");
  assert.ok(result.warnings.length > 0, "redaksiyon uyarısı raporlanmalı");
  for (const warning of result.warnings) {
    assert.ok(!warning.includes(rawSecret), "uyarı secret taşımaz");
  }
  const userMessage = h.backend.runCalls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(!userMessage.includes(rawSecret), "ham secret model'e ASLA gitmez");
  assert.ok(userMessage.includes("[REDACTED_SECRET]"), "redakte placeholder yerini alır");
});
