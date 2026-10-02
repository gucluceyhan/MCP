/**
 * Step 9: `SessionManager` yaşam döngüsü testleri (spec 338: "Cover
 * lifecycle/concurrency/recovery"; spec 1-13, 29-79, 103-135, 255-272).
 *
 * Gerçeklik karışımı: GERÇEK `InferenceCoordinator` + GERÇEK `ContextAssembler`
 * + GERÇEK `SessionStore` (gerçek fs: 0600/0700, atomik yazım) + GERÇEK
 * `GitWorktreeWorkspace` (gerçek git, hermetic) + GERÇEK `WorkerContract` +
 * GERÇEK `RulesResolver` — YALNIZ backend sahtedir (model çağrısı YOK).
 * İki dikiş: `store` kayıt sarmalayıcısıyla (kalıcılık SIRASI + yazım hatası),
 * `rulesResolver` sayaç sarmalayıcısıyla (pin kanıtı: refine/kurtarmada
 * yeniden çözülmez).
 *
 * Her test kendi git repo + output fixture'ını kurar; teardown hepsini
 * kaldırır. Test sürecinin CWD'si test repo'suna bağlanır.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { InferenceCoordinator, type RuntimeLockLike } from "../dist/backend/InferenceCoordinator.js";
import type { LockAcquireResult } from "../dist/backend/RuntimeLock.js";
import {
  type InferenceBackend,
  type InferenceMessage,
  type InferenceResult,
  type InferenceRunOptions,
  type RuntimeInfo,
  type TokenizeResult,
} from "../dist/backend/InferenceBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import { WorkerContract } from "../dist/worker/WorkerContract.js";
import { ContextAssembler } from "../dist/context/ContextAssembler.js";
import {
  RulesResolutionError,
  RULES_RESOLUTION_FAILED_MESSAGE,
  type ResolvedRules,
  type RulesResolverInput,
  type RulesResolverLike,
} from "../dist/rules/types.js";
import { RulesResolver } from "../dist/rules/RulesResolver.js";
import { computeRepoId } from "../dist/workspace/git.js";
import { createGitWorktreeWorkspace, restoreGitWorktreeWorkspace } from "../dist/workspace/GitWorktreeWorkspace.js";
import type { Workspace, WorkspaceCreateInput, WorkspaceRecoveryState } from "../dist/workspace/Workspace.js";
import { SessionStore } from "../dist/session/SessionStore.js";
import { SessionManager, type SessionStoreLike } from "../dist/session/SessionManager.js";
import { SessionError, type PersistedSession } from "../dist/session/types.js";
import { SplashTaskError } from "../dist/task/errors.js";
import type { SplashConfig } from "../dist/config.js";

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

interface Fixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  config: SplashConfig;
}

interface FixtureOptions {
  /** Repo köküne `CLAUDE.md` olarak yazılıp commit'lenir (kural pin kanıtı). */
  rulesFile?: string;
}

async function makeFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-step9-")));
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
  process.env.GIT_AUTHOR_NAME = "Splash Step9 Test";
  process.env.GIT_AUTHOR_EMAIL = "step9@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Step9 Test";
  process.env.GIT_COMMITTER_EMAIL = "step9@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Splash Step9 Test");
  git(repoRoot, "config", "user.email", "step9@splash.test");
  git(repoRoot, "config", "core.autocrlf", "false");

  await writeFile(path.join(repoRoot, "src/a.ts"), "const value = 1;\n");
  await writeFile(path.join(repoRoot, "src/b.ts"), "const other = 10;\n");
  if (options.rulesFile !== undefined) {
    await writeFile(path.join(repoRoot, "CLAUDE.md"), options.rulesFile);
  }
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

// ── Sahte backend (model çağrısı YOK) ───────────────────────────────────────

interface RunCall {
  messages: InferenceMessage[];
  options: InferenceRunOptions | undefined;
  activeAtStart: number; // eşzamanlı `run` sayısı (FIFO/paralel kanıtı)
}

class FakeBackend implements InferenceBackend {
  #current: RuntimeInfo | null = null;
  nextInfo: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 128_000,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  runBehavior: (call: RunCall) => Promise<InferenceResult> = async () => ({
    content: "not-a-json",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  #active = 0;
  maxActive = 0;
  runCalls: RunCall[] = [];
  countBehavior: (messages: InferenceMessage[]) => number = () => 1_000;
  tokenizeBehavior: (content: string) => number = () => 0;

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
    throw new Error("FakeBackend.renderPrompt must not be called in Step 9");
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    return this.countBehavior(messages);
  }
}

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

const cleanScanner = async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];

// ── Store sarmalayıcıları (dikişler) ───────────────────────────────────────

/** Kalıcılık olayı kaydı (turu doğrulamak için minimal, içeriksiz alanlar). */
export interface SaveSnapshot {
  round: number;
  maxRoundsAcknowledged: boolean;
  readonlyPaths: string[];
  currentCreatedPaths: string[];
  stateHash: string | undefined;
  roundCount: number;
  lastStatus: string | undefined;
}

/** Atomik `save` çağrılarını SIRASIYLA kaydeder (içeriği taşımaz). */
export class RecordingStore implements SessionStoreLike {
  saves: SaveSnapshot[] = [];
  constructor(private inner: SessionStoreLike) {}
  get sessionsDir(): string {
    return this.inner.sessionsDir;
  }
  sessionDirFor(sessionId: string): string {
    return this.inner.sessionDirFor(sessionId);
  }
  create(sessionId: string): Promise<string> {
    return this.inner.create(sessionId);
  }
  load(sessionId: string): Promise<PersistedSession> {
    return this.inner.load(sessionId);
  }
  async save(session: PersistedSession): Promise<void> {
    this.saves.push({
      round: session.round,
      maxRoundsAcknowledged: session.maxRoundsAcknowledged,
      readonlyPaths: [...session.readonlyPaths],
      currentCreatedPaths: [...session.currentCreatedPaths],
      stateHash: session.latestWorkspaceStateHash,
      roundCount: session.rounds.length,
      lastStatus: session.latestResult?.status,
    });
    await this.inner.save(session);
  }
}

/** `n`'inci (1-tabanlı) `save`'i `session_persistence_failed` ile reddeder. */
class FailingStore implements SessionStoreLike {
  #failAt: number;
  #saveCount = 0;
  constructor(private inner: SessionStoreLike, failAt: number) {
    this.#failAt = failAt;
  }
  get sessionsDir(): string {
    return this.inner.sessionsDir;
  }
  sessionDirFor(sessionId: string): string {
    return this.inner.sessionDirFor(sessionId);
  }
  create(sessionId: string): Promise<string> {
    return this.inner.create(sessionId);
  }
  load(sessionId: string): Promise<PersistedSession> {
    return this.inner.load(sessionId);
  }
  async save(session: PersistedSession): Promise<void> {
    this.#saveCount++;
    if (this.#saveCount === this.#failAt) {
      throw new SessionError("session_persistence_failed");
    }
    await this.inner.save(session);
  }
}

/** Kural çözme sayaçlı sarmalayıcı (pin kanıtı: refine/kurtarma yeniden çözmez). */
class CountingRulesResolver implements RulesResolverLike {
  resolveCount = 0;
  constructor(private inner: RulesResolverLike) {}
  async resolve(input: RulesResolverInput): Promise<ResolvedRules> {
    this.resolveCount++;
    return this.inner.resolve(input);
  }
}

// ── Hizmet kurucu (test dikişleriyle) ───────────────────────────────────────

interface ManagerHarnessOptions {
  /** Config eşi (örn. `maxRounds: 1`). */
  config?: Partial<SplashConfig>;
  /** `true` ise outputRoot = repoRoot (containment red'i için — L3). */
  unsafeOutputRoot?: boolean;
  /** Repo köküne commit'lenen `CLAUDE.md` içeriği. */
  rulesFile?: string;
  /** 1-tabanlı: bu `save` numarası `session_persistence_failed` ile reddedilir. */
  failSaveAt?: number;
  /** Session ID fabrikası (çakışma/kötü kimlik senaryoları). */
  newSessionId?: () => string;
}

interface ManagerHarness {
  fixture: Fixture;
  manager: SessionManager;
  backend: FakeBackend;
  lock: FakeLock;
  /** Kalıcılık kayıtları (tüm `save` çağrıları, sırayla). */
  store: RecordingStore;
  /** Kural çözme sayaçlı resolver (paylaşılan instance — pin kanıtı). */
  resolver: CountingRulesResolver;
  /** Worktree kurtarma çağrı sayacı (paylaşılan wrapper — reuse/recreate kanıtı). */
  restoreCalls: { count: number };
  /** Repository keşfi CWD çağrı sayacı (refine/kurtarma yeniden keşfetmez). */
  cwdCalls: { count: number };
  sessionsDir: string;
  processCwd: () => string;
  restoreWorkspace: (state: WorkspaceRecoveryState) => Promise<Workspace>;
}

async function makeManagerHarness(t: TestContext, options: ManagerHarnessOptions = {}): Promise<ManagerHarness> {
  const fixture = await makeFixture(t, options);
  const config: SplashConfig = {
    ...fixture.config,
    ...options.config,
    // L3: outputRoot'u repo KÖKÜ yap — containment red'i için.
    ...(options.unsafeOutputRoot !== undefined ? { outputRoot: fixture.repoRoot } : {}),
  };

  const backend = new FakeBackend();
  const lock = new FakeLock();
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir: path.join(config.outputRoot, "runtime"),
    scanner: cleanScanner,
    lock,
  });

  const rec = new RecordingStore(new SessionStore(config.outputRoot, { repoIdentity: computeRepoId }));
  const store: SessionStoreLike = options.failSaveAt !== undefined ? new FailingStore(rec, options.failSaveAt) : rec;
  const resolver = new CountingRulesResolver(new RulesResolver());

  const restoreCalls = { count: 0 };
  const restoreWorkspace = (state: WorkspaceRecoveryState): Promise<Workspace> => {
    restoreCalls.count++;
    return restoreGitWorktreeWorkspace(state);
  };
  const cwdCalls = { count: 0 };
  const processCwd = (): string => {
    cwdCalls.count++;
    return fixture.repoRoot;
  };

  const manager = new SessionManager({
    config,
    coordinator,
    contextAssembler: new ContextAssembler({ runtime: backend }),
    workerContract: new WorkerContract(),
    rulesResolver: resolver,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace,
    store,
    repoIdentity: computeRepoId,
    newSessionId: options.newSessionId ?? randomUUID,
    processCwd,
  });
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
  });

  return {
    fixture,
    manager,
    backend,
    lock,
    store: rec,
    resolver,
    restoreCalls,
    cwdCalls,
    sessionsDir: path.join(config.outputRoot, "sessions"),
    processCwd,
    restoreWorkspace,
  };
}

/**
 * İKİNCİ manager instance'ı (süreç yeniden başlatma simülasyonu): AYNI
 * outputRoot/store/resolver/cwd-öyküsü — YENI backend+coordinator+assembler.
 * Pin kanıtları (resolver/cwd sayaçları) iki instance arası PAYLAŞILIR.
 */
async function makeSecondManager(h: ManagerHarness): Promise<{ manager: SessionManager; backend: FakeBackend; lock: FakeLock }> {
  const backend = new FakeBackend();
  const lock = new FakeLock();
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir: path.join(h.fixture.outputRoot, "runtime-b"),
    scanner: cleanScanner,
    lock,
  });
  const manager = new SessionManager({
    config: h.fixture.config,
    coordinator,
    contextAssembler: new ContextAssembler({ runtime: backend }),
    workerContract: new WorkerContract(),
    rulesResolver: h.resolver,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: h.restoreWorkspace,
    store: h.store,
    repoIdentity: computeRepoId,
    processCwd: h.processCwd,
  });
  return { manager, backend, lock };
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

/** Worker çıktısını (Step 4 şeması) JSON metnine çevirir. */
function workerJson(body: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 1, ...body });
}

/** `src/a.ts` içinde tam arama/değiştirme yapan worker çıktısı. */
function modifyWorkerJson(search: string, replace: string, summary: string): string {
  return workerJson({
    summary,
    edits: [{ kind: "modify", path: "src/a.ts", operations: [{ search, replace }] }],
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

/** Diskteki yetkili `session.json`'ı okur. */
async function readSessionJson(sessionId: string, sessionsDir: string): Promise<PersistedSession> {
  return JSON.parse(await readFile(path.join(sessionsDir, sessionId, "session.json"), "utf8")) as PersistedSession;
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

// ── Yaşam döngüsü: createTask (1. tur) ──────────────────────────────────────

test("L1: round 1 applied — disk+RAM oturum, işleme SIRASI, worktree yazıldı, MAIN DOKUNULMADI", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Changed value to 2; added the new file.",
      edits: [
        { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace: "const value = 2;" }] },
        { kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" },
      ],
    }),
    usage: { inputTokens: 1_234, outputTokens: 567 },
  });

  const result = await h.manager.createTask({ task: "Change the value and add a file", files: ["src/a.ts", "src/new.ts"] });

  // Compact sonuç:
  assert.equal(result.status, "applied");
  assert.equal(result.round, 1);
  assert.equal(result.baseStatus, "fresh");
  assert.deepEqual(result.filesChanged.sort(), ["src/a.ts", "src/new.ts"]);
  assert.deepEqual(result.usage, { in: 1_234, out: 567 });

  // İşleme SIRASI (spec 157/336): ÖNCE round 0 kalıcılık, SONRA 1. tur commit'i.
  assert.equal(h.store.saves.length, 2);
  assert.equal(h.store.saves[0]?.round, 0, "ilk kalıcılık = tur 0 (iş başından önce disk)");
  assert.equal(h.store.saves[1]?.round, 1, "ikinci kalıcılık = tamamlanan 1. tur");
  assert.equal(h.store.saves[0]?.roundCount, 0);
  assert.equal(h.store.saves[1]?.roundCount, 1);
  assert.deepEqual(h.store.saves[1]?.currentCreatedPaths, ["src/new.ts"]);

  // Diskteki yetkili oturum:
  const session = await readSessionJson(result.sessionId, h.sessionsDir);
  assert.equal(session.round, 1);
  assert.equal(session.rounds[0]?.feedback, undefined, "1. turda feedback YOK (spec 67)");
  assert.deepEqual(session.currentCreatedPaths, ["src/new.ts"]);
  assert.ok(session.latestWorkspaceStateHash !== undefined, "son workspace state hash'i kalıcı");

  // Worktree yazıldı; MAIN DOKUNULMADI (spec 13):
  const wsDir = path.join(h.sessionsDir, result.sessionId, "workspace");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 2;\n");
  assert.equal(await readFile(path.join(wsDir, "src/new.ts"), "utf8"), "export const fresh = true;\n");
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");
  assert.ok(!(await pathExists(path.join(h.fixture.repoRoot, "src/new.ts"))), "worker dosyası ana checkout'a yazılamaz");

  // RAM önbellek + tek dispatch:
  assert.equal(h.manager.activeSessions().length, 1);
  assert.equal(h.backend.runCalls.length, 1);
});

test("L2: girdi doğrulaması — task/files/reserve/tier/rules redleri; hiçbir şey OLUŞTURULMAZ", async (t) => {
  const h = await makeManagerHarness(t);
  const rejects: Array<[Record<string, unknown>, (e: unknown) => boolean]> = [
    [{ task: "   ", files: [] }, (e) => e instanceof SplashTaskError && e.kind === "invalid_input"],
    [{ task: "x", files: [42] }, (e) => e instanceof SplashTaskError && e.kind === "invalid_input"],
    [{ task: "x", files: [], outputReserveTokens: 1 }, (e) => e instanceof SplashTaskError && e.kind === "invalid_input"],
    [{ task: "x", files: [], contextTier: "512k" }, (e) => e instanceof SplashTaskError && e.kind === "invalid_input"],
    [{ task: "x", files: [], rules: 42 }, (e) => e instanceof SplashTaskError && e.kind === "invalid_input"],
  ];
  for (const [input, isInvalid] of rejects) {
    await assert.rejects(h.manager.createTask(input as never), isInvalid);
  }
  // Hiçbir yan etki yok: sessions dizisi bile açılmadı, dispatch yok.
  assert.ok(!(await pathExists(h.sessionsDir)));
  assert.equal(h.backend.runCalls.length, 0);
});

test("L3: outputRoot == repoRoot → output_root_unsafe (session dizini repo içine düşemez)", async (t) => {
  const h = await makeManagerHarness(t, { unsafeOutputRoot: true });
  await assert.rejects(
    h.manager.createTask({ task: "x", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "output_root_unsafe",
  );
  assert.ok(!(await pathExists(path.join(h.fixture.repoRoot, "sessions"))), "repo içinde sessions dizini OLUŞMAMALI");
  assert.equal(h.backend.runCalls.length, 0);
});

test("L4: kural çözme hatası → tip'li hata yayılır; session dizisi/workspace OLUŞTURULMAZ", async (t) => {
  const throwing: RulesResolverLike = {
    resolve: async () => {
      throw new RulesResolutionError("rules_resolution_failed", RULES_RESOLUTION_FAILED_MESSAGE);
    },
  };
  const h = await makeManagerHarness(t);
  const manager = new SessionManager({
    config: h.fixture.config,
    coordinator: new InferenceCoordinator({
      backend: h.backend,
      runtimeDir: path.join(h.fixture.outputRoot, "runtime"),
      scanner: cleanScanner,
      lock: h.lock,
    }),
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    workerContract: new WorkerContract(),
    rulesResolver: throwing,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: h.restoreWorkspace,
    store: h.store,
    repoIdentity: computeRepoId,
    processCwd: h.processCwd,
  });
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
  });

  await assert.rejects(
    manager.createTask({ task: "x", files: [] }),
    (e: unknown) => e instanceof RulesResolutionError,
  );
  assert.ok(!(await pathExists(h.sessionsDir)), "kural hatasında session dizisi OLUŞMAMALI");
  assert.equal(h.backend.runCalls.length, 0);
});

test("L5: session çakışması — RAM ve DİSK şubeleri; mevcut oturum ASLA üst yazılmaz", async (t) => {
  const fixedId = () => "fixed-id-1";
  const h = await makeManagerHarness(t, { newSessionId: fixedId });
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await h.manager.createTask({ task: "Change the value", files: ["src/a.ts"] });
  assert.equal(first.sessionId, "fixed-id-1");

  // RAM şubesi: aynı kimlik önbellekte → session_conflict (disk'e ULAŞILMADAN).
  await assert.rejects(
    h.manager.createTask({ task: "again", files: [] }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_conflict",
  );

  // Disk şubesi: RAM'i BOŞ yeni manager + aynı kimlik → exclusive mkdir EEXIST.
  const diskClash = new SessionManager({
    config: h.fixture.config,
    coordinator: new InferenceCoordinator({
      backend: h.backend,
      runtimeDir: path.join(h.fixture.outputRoot, "runtime-c"),
      scanner: cleanScanner,
      lock: h.lock,
    }),
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    workerContract: new WorkerContract(),
    rulesResolver: h.resolver,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: h.restoreWorkspace,
    store: h.store,
    repoIdentity: computeRepoId,
    newSessionId: fixedId,
    processCwd: h.processCwd,
  });
  t.after(async () => {
    await diskClash.dispose().catch(() => undefined);
  });
  await assert.rejects(
    diskClash.createTask({ task: "again 2", files: [] }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_conflict",
  );

  // Mevcut oturum bozulmadı:
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 1);
});

test("L6: güvenli olmayan session ID fabrikası → invalid_input (kimlik mesaja yansıtılmaz)", async (t) => {
  const h = await makeManagerHarness(t, { newSessionId: () => "../../escape" });
  await assert.rejects(
    h.manager.createTask({ task: "x", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input" && !e.message.includes("escape"),
  );
  assert.ok(!(await pathExists(h.sessionsDir)));
});

test("L7: 1. tur needs_split — oturum round 0 + latestResult olarak KALICI; dispatch YOK; worktree base'te", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.countBehavior = () => 999_999_999; // tüm kademelere sığmaz → needs_split
  h.backend.runBehavior = async () => {
    throw new Error("needs_split'te model ÇAĞRILMAMALI");
  };

  const result = await h.manager.createTask({ task: "Huge", files: ["src/a.ts"] });
  assert.equal(result.status, "needs_split");
  assert.equal(result.baseStatus, "fresh");
  assert.equal(result.round, 1);

  // Kalıcılık (spec 133): sonuç dönmeden ÖNCE disk — tur 0 kalır.
  assert.equal(h.store.saves.length, 2);
  assert.equal(h.store.saves[1]?.round, 0);
  assert.equal(h.store.saves[1]?.lastStatus, "needs_split");
  assert.ok(await pathExists(path.join(h.sessionsDir, result.sessionId, "session.json")));

  // Model çağrısı YOK; worktree base'te; oturum AÇIK (refine edilebilir).
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(await readFile(path.join(h.sessionsDir, result.sessionId, "workspace/src/a.ts"), "utf8"), "const value = 1;\n");
  assert.equal(h.manager.activeSessions().length, 1);
});

test("L8: 1. tur inference_busy — oturum round 0 + latestResult olarak KALICI; worktree base'te", async (t) => {
  const h = await makeManagerHarness(t);
  h.lock.busy = true; // başka bir runtime kilidi tutuyor
  h.backend.runBehavior = async () => {
    throw new Error("busy'de model ÇAĞRILMAMALI");
  };

  const result = await h.manager.createTask({ task: "x", files: ["src/a.ts"] });
  assert.equal(result.status, "inference_busy");
  assert.ok(result.inference !== undefined);
  assert.equal(h.store.saves[1]?.round, 0);
  assert.equal(h.store.saves[1]?.lastStatus, "inference_busy");
  assert.equal(h.backend.runCalls.length, 0);
  assert.equal(h.manager.activeSessions().length, 1, "oturum açık — sonra refine edilebilir");
});

test("L9: 1. tur backend arızası → OTURUM + WORKSPACE TEMİZLENİR (orfan YOK); hata yayılır", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => {
    throw new BackendError("network", "Could not reach the inference runtime");
  };

  await assert.rejects(
    h.manager.createTask({ task: "x", files: ["src/a.ts"] }),
    (e: unknown) => e instanceof BackendError,
  );
  // Temizlik (spec 132/234/439): session dizisi + workspace giderildi.
  assert.ok(!(await pathExists(h.sessionsDir)), "orfan session dizisi KALMAMALI");
  assert.equal(h.manager.activeSessions().length, 0);
});

// ── Yaşam döngüsü: refine (N. tur) ──────────────────────────────────────────

/** Ortak kurulum: round 1 applied oturum (value 1→2) + helper'lar. */
async function taskRound1(h: ManagerHarness, files: readonly string[] = ["src/a.ts"]) {
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  return h.manager.createTask({ task: "Change the value constant", files });
}

test("R1: olmayan oturum → SessionError session_not_found (sabit mesaj; fs detayı YOK)", async (t) => {
  const h = await makeManagerHarness(t);
  await assert.rejects(
    h.manager.refine({ sessionId: randomUUID(), feedback: "fix it", files: [] }),
    (e: unknown) =>
      e instanceof SessionError &&
      e.kind === "session_not_found" &&
      e.message === "The session was not found",
  );
});

test("R2: refine girdi doğrulaması — güvensiz id / boş feedback / güvensiz dosya → invalid_input", async (t) => {
  const h = await makeManagerHarness(t);
  const sid = randomUUID();
  await assert.rejects(
    h.manager.refine({ sessionId: "../escape", feedback: "x", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input",
  );
  await assert.rejects(
    h.manager.refine({ sessionId: sid, feedback: "   ", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input",
  );
  await assert.rejects(
    h.manager.refine({ sessionId: sid, feedback: "x", files: ["../../etc/passwd"] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input",
  );
  assert.ok(!(await pathExists(h.sessionsDir)));
});

test("R3: stale refine — inference YOK, tur YOK, oturum AÇIK; ana ağaç geri gelince rafine yürür", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const before = h.backend.runCalls.length;
  const sessionDir = path.join(h.sessionsDir, first.sessionId);

  // Ana ağaç sürüklendi (base yakalama anından farklı):
  await writeFile(path.join(h.fixture.repoRoot, "src/a.ts"), "const value = 1;\n// drifted\n");

  const stale = await h.manager.refine({ sessionId: first.sessionId, feedback: "fix it", files: [] });
  assert.equal(stale.status, "stale_base");
  assert.equal(stale.baseStatus, "stale");
  assert.deepEqual(stale.staleFiles, ["src/a.ts"]);
  assert.equal(stale.round, 2, "display tur = son tamamlanan + 1 (spec 58)");
  assert.equal(stale.usage.in, 0, "stale'de model çağrısı YOK — hakediş SIFIR");
  assert.equal(stale.context.inputTokens, 0, "bu turda prompt GÖNDERİLMEDİ (spec 41/334)");
  assert.equal(h.backend.runCalls.length, before, "stale'de inference YOK");

  // Oturum durumu DEĞİŞMEDİ (spec 330): disk round 1, RAM round 1, kalıcılık YAZILMADI.
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 1);
  assert.equal(h.manager.activeSessions()[0]?.round, 1);
  assert.ok(await pathExists(sessionDir), "stale oturum AÇIK kalır (destroy/sil YOK)");

  // Ana ağaç base ile yeniden birebir → aynı oturum refine edilebilir (oturum korunur):
  await writeFile(path.join(h.fixture.repoRoot, "src/a.ts"), "const value = 1;\n");
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 20, outputTokens: 10 },
  });
  const resumed = await h.manager.refine({ sessionId: first.sessionId, feedback: "now fix", files: [] });
  assert.equal(resumed.status, "applied");
  assert.equal(resumed.round, 2);
  assert.equal((await readSessionJson(first.sessionId, h.sessionsDir)).round, 2, "oturum AÇIK kalır, tur ilerler");
});

test("R4: worker-oluşturulan yol ana ağaçta belirdi → stale (içerik okunmadan, varlık yeter)", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Added the new file.",
      edits: [{ kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" }],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await h.manager.createTask({ task: "Add a new file", files: ["src/new.ts"] });
  const before = h.backend.runCalls.length;

  // Kullanıcı ana ağaçta AYNI yola dosya koydu (içerik farklı olsun):
  await writeFile(path.join(h.fixture.repoRoot, "src/new.ts"), "my own content\n");

  const stale = await h.manager.refine({ sessionId: first.sessionId, feedback: "fix", files: [] });
  assert.equal(stale.status, "stale_base");
  assert.deepEqual(stale.staleFiles, ["src/new.ts"]);
  assert.equal(h.backend.runCalls.length, before, "inference YOK");
});

test("R5: max_rounds guardraili — guard + ack kalıcılığı + bilinçli yeniden çağrıyla devam", async (t) => {
  const h = await makeManagerHarness(t, { config: { maxRounds: 1 } });
  const first = await taskRound1(h); // round 1 == maxRounds
  const before = h.backend.runCalls.length;

  // 1. refine: guard → inference YOK; ack KALICILAŞIR (spec 61/62).
  const guard = await h.manager.refine({ sessionId: first.sessionId, feedback: "fix", files: [] });
  assert.equal(guard.status, "max_rounds");
  assert.equal(guard.baseStatus, "fresh");
  assert.equal(guard.usage.in, 0);
  assert.equal(guard.warnings.length, 1);
  assert.equal(h.backend.runCalls.length, before, "guard'da inference YOK");

  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 1, "guard turu round'u ARTIRMAZ");
  assert.equal(session.maxRoundsAcknowledged, true, "ack diskte — restart unutmaz");

  // 2. refine: ack edilmiş → guard aşılar, tur YÜRÜR.
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 20, outputTokens: 10 },
  });
  const next = await h.manager.refine({ sessionId: first.sessionId, feedback: "continue", files: [] });
  assert.equal(next.status, "applied");
  assert.equal(next.round, 2);
  assert.equal((await readSessionJson(first.sessionId, h.sessionsDir)).round, 2);
});

test("R6: refine üretilmiş tur — tam ikame, salt-okunur BİRİKİMİ, created kalıcılığı, feedback diskte", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sessionDir = path.join(h.sessionsDir, first.sessionId);
  const wsDir = path.join(sessionDir, "workspace");

  // Round 2: tam-ikame seti (base 1 → 3) + `src/b.ts` salt-okunur referans.
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });
  const second = await h.manager.refine({
    sessionId: first.sessionId,
    feedback: "Change the value again",
    files: ["src/b.ts"],
  });
  assert.equal(second.status, "applied");
  assert.equal(second.round, 2);

  // Salt-okunur referans + orijinal görev + feedback, prompt'un BİREBİR mesajlarında:
  const secondMessages = h.backend.runCalls[1]?.messages.map((m) => m.content).join("\n") ?? "";
  assert.ok(secondMessages.includes("const other = 10;"), "salt-okunur referans içeriği bağlam'da olmalı");
  assert.ok(secondMessages.includes("Change the value constant"), "orijinal görev korunur — feedback görevin YERİNE geçmez");
  assert.ok(secondMessages.includes("Change the value again"), "geçmiş'te geri bildirim var");

  // Workspace: round 1'in create'ı tam-ikame ile sürdü; ana ağaç DOKUNULMADI.
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 3;\n");
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");

  // Disk kalıcılığı: round 2, feedback, BİRİKEN salt-okunur kümesi.
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 2);
  assert.equal(session.rounds[1]?.feedback, "Change the value again");
  assert.deepEqual(session.readonlyPaths, ["src/b.ts"]);
  assert.equal(session.rounds[0]?.feedback, undefined, "1. turda feedback YOK");
});

test("R7: refine kalıcılık hatası → workspace ÖNCEKİ state'e; RAM disk'i yansıtır; SessionError", async (t) => {
  // Kalıcılık olayları: 1) tur 0, 2) round 1, 3) round 2 → ÜÇÜNCÜSÜ FAIL.
  const h = await makeManagerHarness(t, { failSaveAt: 3 });
  const first = await taskRound1(h);
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 2;\n");

  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 2;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });

  await assert.rejects(
    h.manager.refine({ sessionId: first.sessionId, feedback: "third", files: [] }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed",
  );

  // Transactional (spec 152-156): workspace round 1 state'ine GERİ; RAM + disk round 1.
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 2;\n");
  assert.equal(h.manager.activeSessions()[0]?.round, 1);
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 1);
  assert.equal(session.rounds.length, 1);
});

test("R8: refine tur arızası (backend) → tip'li hata; oturum + workspace KORUNUR", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");
  // Round 2'de backend arızasın:
  h.backend.runBehavior = async (call) => {
    if (call.activeAtStart >= 1 && h.backend.runCalls.length >= 2) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    return { content: modifyWorkerJson("const value = 2;", "const value = 3;", "Changed value to 3."), usage: { inputTokens: 30, outputTokens: 15 } };
  };

  await assert.rejects(
    h.manager.refine({ sessionId: first.sessionId, feedback: "third", files: [] }),
    (e: unknown) => e instanceof BackendError,
  );

  // Oturum KORUNUR (spec 75): workspace round 1 state'inde; disk round 1.
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 2;\n");
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  assert.equal(session.round, 1);
  assert.equal(h.manager.activeSessions().length, 1, "oturum AÇIK kalır");
});

test("R9: pin'li kurallar + seçenekler — refine ASLA yeniden çözmez; dispatch pin değerleriyle", async (t) => {
  const h = await makeManagerHarness(t, { rulesFile: "# Project rules\nRULES_PINNED_MARKER — use precise search strings.\n" });
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await h.manager.createTask({
    task: "Change the value",
    files: ["src/a.ts"],
    contextTier: "64k",
    reasoningEffort: "low",
  });
  assert.equal(first.rulesSource, "CLAUDE.md");
  assert.equal(h.resolver.resolveCount, 1, "task açılışında BİR KERE çöz");

  // Pin kanıtları öncesinde:
  const resolveAfterTask = h.resolver.resolveCount;
  const cwdAfterTask = h.cwdCalls.count;

  // Refine: kurallar YENİDEN ÇÖZÜLMEZ, repo YENİDEN KEŞFEDİLMEZ (spec 22/258):
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });
  await h.manager.refine({ sessionId: first.sessionId, feedback: "again", files: [] });
  assert.equal(h.resolver.resolveCount, resolveAfterTask, "refine'de kural çözümü YOK");
  assert.equal(h.cwdCalls.count, cwdAfterTask, "refine'de repo keşfi YOK");

  // Pin'li seçenekler dispatch'e gider (tur sürüklenmesi YOK):
  const dispatch = h.backend.runCalls[1]?.options;
  assert.equal(dispatch?.maxOutputTokens, 32_768);
  assert.equal(dispatch?.contextTier, 65_536); // "64k" kanonik kademeye
  assert.equal(dispatch?.reasoningEffort, "low");

  // Pin'li KURALLAR prompt'ta (system bölümü; içerik korunur — secret değil):
  const refineMessages = h.backend.runCalls[1]?.messages.map((m) => m.content).join("\n") ?? "";
  assert.ok(refineMessages.includes("RULES_PINNED_MARKER"), "pin'li kural içeriği rafine turunda prompt'ta");
});

// ── Eşzamanlılık ─────────────────────────────────────────────────────────────

/**
 * Manager-kilit kanıtı için SAHTE koordinatör: `dispatch`'i izler ama
 * KENDİSİ serialize ETMEZ (global FIFO gerçek koordinatörün testlerinde
 * örtülüdür). Böylece YALNIZCA manager'ın per-session FIFO kiliti ölçülür:
 * aynı oturum sıralanır, farklı oturumlar paralel yürür.
 */
class FakeCoordinator {
  dispatchCalls: number[] = [];
  #inFlight = 0;
  maxInFlight = 0;
  /** dispatch gecikmesi (ms) — paralel/sıralı kanıtı için. */
  delayMs = 100;
  behavior: (index: number) => Promise<InferenceResult> = async (index) => ({
    // Her tam-ikame seti immutable base'ten (1) başlar — artımsal delta YOK.
    content: modifyWorkerJson(`const value = 1;`, `const value = ${index};`, `Changed value to ${index}.`),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  async dispatch(request: { ownerId: string }): Promise<{ status: "completed"; result: InferenceResult }> {
    this.dispatchCalls.push(request.ownerId.length);
    this.#inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
      return { status: "completed", result: await this.behavior(this.dispatchCalls.length) };
    } finally {
      this.#inFlight--;
    }
  }
}

test("C1: aynı oturumun eşzamanlı işlemleri FIFO sıralanır (spec 76/78); farklı oturumlar paralel", async (t) => {
  // ── aynı oturum: iki refine eşzamanlı → KİLİT sıralar (maxInFlight 1) ──
  const h = await makeManagerHarness(t);
  const fake = new FakeCoordinator();
  const locked = new SessionManager({
    config: h.fixture.config,
    coordinator: fake,
    contextAssembler: new ContextAssembler({ runtime: h.backend }),
    workerContract: new WorkerContract(),
    rulesResolver: h.resolver,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: h.restoreWorkspace,
    store: h.store,
    repoIdentity: computeRepoId,
    processCwd: h.processCwd,
  });
  t.after(async () => {
    await locked.dispose().catch(() => undefined);
  });
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await locked.createTask({ task: "Change the value", files: ["src/a.ts"] });
  fake.dispatchCalls = [];

  const [r2, r3] = await Promise.all([
    locked.refine({ sessionId: first.sessionId, feedback: "second", files: [] }),
    locked.refine({ sessionId: first.sessionId, feedback: "third", files: [] }),
  ]);
  assert.equal(r2.round, 2);
  assert.equal(r3.round, 3, "FIFO: çağrı sırası = tur sırası");
  assert.equal(fake.maxInFlight, 1, "aynı oturum asla iki dispatch'te bir arada olamaz");

  // ── farklı oturumlar: manager sıralama YAPMAZ (paralel) ──────────────────
  const p = await makeManagerHarness(t);
  const fakeP = new FakeCoordinator();
  const parallel = new SessionManager({
    config: p.fixture.config,
    coordinator: fakeP,
    contextAssembler: new ContextAssembler({ runtime: p.backend }),
    workerContract: new WorkerContract(),
    rulesResolver: p.resolver,
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: p.restoreWorkspace,
    store: p.store,
    repoIdentity: computeRepoId,
    processCwd: p.processCwd,
  });
  t.after(async () => {
    await parallel.dispose().catch(() => undefined);
  });
  p.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const [sa, sb] = await Promise.all([
    parallel.createTask({ task: "A", files: ["src/a.ts"] }),
    parallel.createTask({ task: "B", files: ["src/a.ts"] }),
  ]);
  assert.notEqual(sa.sessionId, sb.sessionId);
  fakeP.dispatchCalls = [];
  await Promise.all([
    parallel.refine({ sessionId: sa.sessionId, feedback: "refine A", files: [] }),
    parallel.refine({ sessionId: sb.sessionId, feedback: "refine B", files: [] }),
  ]);
  assert.equal(fakeP.maxInFlight, 2, "farklı oturumlar manager tarafından SIRA'LANMAZ (spec 77)");
});

// ── Kurtarma (lazy load + worktree restore + determinizm) ───────────────────

/** Worktree'ye untracked sentinel dosyası (reuse/recreate ayrımı — diff hash'ini bozmaz). */
async function plantSentinel(h: ManagerHarness, sessionId: string): Promise<string> {
  const wsDir = path.join(h.sessionsDir, sessionId, "workspace");
  await writeFile(path.join(wsDir, "sentinel.txt"), "keep-me\n");
  return path.join(wsDir, "sentinel.txt");
}

test("V1: süreç yeniden başlatma — aynı oturum: disk load + worktree REUSE + deterministik reapply; kurallar YENİDEN ÇÖZÜLMEZ", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sentinel = await plantSentinel(h, first.sessionId);

  const resolveAfterTask = h.resolver.resolveCount;
  const cwdAfterTask = h.cwdCalls.count;
  const restoreBefore = h.restoreCalls.count;

  // "Yeni süreç": aynı outputRoot/store/resolver — YENI coordinator/backend.
  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  b2.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });

  const refined = await second.refine({ sessionId: first.sessionId, feedback: "continue", files: [] });
  assert.equal(refined.status, "applied");
  assert.equal(refined.round, 2);
  assert.equal(b2.runCalls.length, 1, "kurtarma model-free — yalnız rafine turu dispatch");

  // Worktree REUSE (kimlik + hash birebir): sentinel HAYATTA — yeniden kurulum YOK.
  assert.ok(await pathExists(sentinel), "birebir worktree reuse edildi — sentinel korundu");
  assert.equal(h.restoreCalls.count, restoreBefore + 1, "kurtarma BİR kez tetiklendi (lazy load)");

  // Reapply deterministik: round 1 state + round 2 patch; MAIN DOKUNULMADI.
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 3;\n");
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8"), "const value = 1;\n");

  // PIN (spec 104/258/395/396): kurallar yeniden çözülmedi, repo yeniden keşfedilmedi.
  assert.equal(h.resolver.resolveCount, resolveAfterTask, "kurtarma/rafine kural çözümünü YOK");
  assert.equal(h.cwdCalls.count, cwdAfterTask, "kurtarma/rafine repo keşfini YOK");

  // RAM commit: ikinci instance'ın cache'i doğruladıktan sonra doldu.
  assert.equal(second.activeSessions()[0]?.round, 2);
});

test("V2: worktree YOK (temiz imha) → yeniden kurulum; refine tamamlanır", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sentinel = await plantSentinel(h, first.sessionId);
  const wsInfo = h.manager.activeSessions()[0];
  assert.ok(wsInfo !== undefined);
  await wsInfo.workspace.destroy(); // `git worktree remove` — dizin + kayıt gider
  assert.ok(!(await pathExists(sentinel)));

  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  b2.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });

  const refined = await second.refine({ sessionId: first.sessionId, feedback: "continue", files: [] });
  assert.equal(refined.status, "applied");
  assert.equal(refined.round, 2);

  // Yeniden kurulan worktree: sentinel YOK (recreate — temiz kurulum), içerik round 2.
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");
  assert.ok(await pathExists(wsDir), "worktree yeniden kuruldu");
  assert.ok(!(await pathExists(sentinel)), "recreate: eski untracked dosya taşınmaz");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 3;\n");
});

test("V3: hayatta AMA UYUŞMAYAN worktree (hash mismatch) → güvenilmez → PERSISTED state'ten yeniden kurulum", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sentinel = await plantSentinel(h, first.sessionId);
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");

  // Worktree dosyasını elle boz → state hash != persisted hash (uyuşmazlık).
  await writeFile(path.join(wsDir, "src/a.ts"), "const value = 777; // tampered\n");

  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  b2.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
    usage: { inputTokens: 30, outputTokens: 15 },
  });

  const refined = await second.refine({ sessionId: first.sessionId, feedback: "continue", files: [] });
  assert.equal(refined.status, "applied");
  assert.equal(refined.round, 2);

  // Uyuşmayan worktree GÜVENİLMEDİ: yeniden kurulum → tampered içerik GİTTİ,
  // round 1 state'inden (persisted) yeniden kuruldu, sonra round 2 uygulandı.
  assert.ok(!(await pathExists(sentinel)), "recreate: sentinel gitmeli");
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), "const value = 3;\n");
});

test("V4: bozulmuş kurtarma durumu (hash sahtesi) → session_recovery_failed; artifact KALIR", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);

  // Persisted state hash'ini sahtele (store doğrulaması geçmez — serbest alan).
  const session = await readSessionJson(first.sessionId, h.sessionsDir);
  session.latestWorkspaceStateHash = "0".repeat(64);
  await writeFile(
    path.join(h.sessionsDir, first.sessionId, "session.json"),
    JSON.stringify(session, null, 2),
    { mode: 0o600 },
  );

  const { manager: second } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });

  await assert.rejects(
    second.refine({ sessionId: first.sessionId, feedback: "continue", files: [] }),
    (e: unknown) =>
      e instanceof SessionError &&
      e.kind === "session_recovery_failed" &&
      e.message === "The session could not be recovered",
  );
  // Bozuk oturum dosyası otomatik silinmez (spec 164):
  assert.ok(await pathExists(path.join(h.sessionsDir, first.sessionId, "session.json")));
});

test("V5: bozuk session.json (geçersiz JSON) → session_corrupt (fail-closed; hiçbir yeniden yapı YOK)", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  await writeFile(path.join(h.sessionsDir, first.sessionId, "session.json"), "{ this is not json");

  const { manager: second } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  await assert.rejects(
    second.refine({ sessionId: first.sessionId, feedback: "continue", files: [] }),
    (e: unknown) =>
      e instanceof SessionError &&
      e.kind === "session_corrupt" &&
      e.message === "The session state is corrupt and cannot be recovered",
  );
  // Bozuk dosya dokunulmadı (kullanıcının incelemesine):
  assert.equal(await readFile(path.join(h.sessionsDir, first.sessionId, "session.json"), "utf8"), "{ this is not json");
});

// ── Shutdown (dispose) ───────────────────────────────────────────────────────

test("V6: dispose — in-flight BEKLENİR; KALICI OTURUM KORUNUR; idempotent; sonrası shutting_down", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."),
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  // Senaryo A: görev dispose'dan ÖNCE tamamlanır → oturum KORUNUR (Step 9).
  const first = await h.manager.createTask({ task: "Change the value", files: ["src/a.ts"] });
  const sessionDir = path.join(h.sessionsDir, first.sessionId);
  const wsDir = path.join(sessionDir, "workspace");
  assert.ok(await pathExists(wsDir));

  await h.manager.dispose();
  // Step 9 (spec 128-130): RAM temiz; kalıcılara DOKUNULMAZ.
  assert.equal(h.manager.activeSessions().length, 0);
  assert.ok(await pathExists(sessionDir), "session dizisi KALIR");
  assert.ok(await pathExists(wsDir), "worktree KALIR (imha Step 10'a aittir)");
  // Idempotent:
  await h.manager.dispose();
  // Sonrası: yeni iş reddedilir (spec 69/71).
  await assert.rejects(
    h.manager.createTask({ task: "After dispose", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "shutting_down",
  );
  await assert.rejects(
    h.manager.refine({ sessionId: first.sessionId, feedback: "x", files: [] }),
    (e: unknown) => e instanceof SplashTaskError && e.kind === "shutting_down",
  );
});

test("V7: dispose + in-flight kalıcılık hatası → task_cleanup_failed (yutma YOK)", async (t) => {
  // Kalıcılık: 1) tur 0, 2) round 1, 3) refine round 2 → ÜÇÜNCÜSÜ fail.
  const h = await makeManagerHarness(t, { failSaveAt: 3 });
  h.backend.runBehavior = async (call) => {
    if (h.backend.runCalls.length <= 1) {
      return { content: modifyWorkerJson("const value = 1;", "const value = 2;", "Changed value to 2."), usage: { inputTokens: 10, outputTokens: 5 } };
    }
    return { content: modifyWorkerJson("const value = 2;", "const value = 3;", "Changed value to 3."), usage: { inputTokens: 30, outputTokens: 15 } };
  };
  const first = await h.manager.createTask({ task: "Change the value", files: ["src/a.ts"] });

  // Refine in-flight başlar (kalıcılık hatası verecek); dispose derhal çağrılır.
  const refinePromise = h.manager.refine({ sessionId: first.sessionId, feedback: "third", files: [] });
  await waitFor(() => h.backend.runCalls.length >= 2); // dispatch'e girdi (in-flight)
  const disposePromise = h.manager.dispose();

  await assert.rejects(
    refinePromise,
    (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed",
  );
  // Kalıcılık hatası shutdown'a YAYILIR (spec 131 — fire-and-forget YOK):
  await assert.rejects(
    disposePromise,
    (e: unknown) => e instanceof SplashTaskError && e.kind === "task_cleanup_failed",
  );
});
