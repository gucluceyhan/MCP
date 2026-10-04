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
 *
 * Step 10 (D/E): `diff` (salt-inceleme) + `close` (stale → metadata →
 * export → imha → yetkili durum silme → RAM silme) yaşam döngüsü testleri
 * aynı harness'i kullanır; ek dikişler: `wrapWorkspace` (imha arızası),
 * `wrapStore` (silme arızası), `liveBaseGate` (deferred `captureLiveBase`).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
import { WorkerContractError } from "../dist/worker/result.js";
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
import { WorkspaceError } from "../dist/workspace/Workspace.js";
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
  delete(sessionId: string): Promise<void> {
    return this.inner.delete(sessionId);
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
  delete(sessionId: string): Promise<void> {
    return this.inner.delete(sessionId);
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
  /**
   * Step 10 dikişi: create + restore çıktısı bu sarmalayıcıdan geçer (ör.
   * `destroy` arızası). Restore sarmalayıcısı paylaşıldığı için ikinci
   * manager da aynı sarmalayıcıyı görür.
   */
  wrapWorkspace?: (workspace: Workspace) => Workspace;
  /** Step 10 dikişi: manager'a verilen store bu sarmalayıcıdan geçer (ör. `delete` arızası). */
  wrapStore?: (store: SessionStoreLike) => SessionStoreLike;
}

/**
 * `captureLiveBase` kapısı (Step 10 eşzamanlılık kanıtları): `wait` doluysa
 * yakalama ona kadar BEKLER (deferred); `calls` = toplam yakalama sayısı
 * (stale denetiminin çağrıldığının/çağrılmadığının kanıtı).
 */
interface LiveBaseGate {
  wait: Promise<void> | null;
  calls: number;
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
  restoreWorkspace: (state: WorkspaceRecoveryState, options: { expectedWorkspaceDir: string }) => Promise<Workspace>;
  /** Manager'ın assembler'ındaki `captureLiveBase` kapısı/sayacı. */
  liveBaseGate: LiveBaseGate;
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
  const baseStore: SessionStoreLike = options.failSaveAt !== undefined ? new FailingStore(rec, options.failSaveAt) : rec;
  const store: SessionStoreLike = options.wrapStore !== undefined ? options.wrapStore(baseStore) : baseStore;
  const resolver = new CountingRulesResolver(new RulesResolver());

  const wrap = options.wrapWorkspace ?? ((workspace: Workspace) => workspace);
  const restoreCalls = { count: 0 };
  const restoreWorkspace = async (
    state: WorkspaceRecoveryState,
    restoreOptions: { expectedWorkspaceDir: string },
  ): Promise<Workspace> => {
    restoreCalls.count++;
    return wrap(await restoreGitWorktreeWorkspace(state, restoreOptions));
  };
  const cwdCalls = { count: 0 };
  const processCwd = (): string => {
    cwdCalls.count++;
    return fixture.repoRoot;
  };

  const assembler = new ContextAssembler({ runtime: backend });
  const liveBaseGate: LiveBaseGate = { wait: null, calls: 0 };
  const manager = new SessionManager({
    config,
    coordinator,
    contextAssembler: {
      assemble: (input) => assembler.assemble(input),
      captureLiveBase: async (input) => {
        liveBaseGate.calls++;
        if (liveBaseGate.wait !== null) {
          await liveBaseGate.wait;
        }
        return assembler.captureLiveBase(input);
      },
    },
    workerContract: new WorkerContract(),
    rulesResolver: resolver,
    createWorkspace: async (input) => wrap(await createGitWorktreeWorkspace(input)),
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
    liveBaseGate,
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

// ── Step 10: ortak yardımcılar ───────────────────────────────────────────────

/** Elle çözülen söz (deferred backend / kapı). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Sözün yerleşip yerleşmediğini (yutmadan) izler — sıralama kanıtı için. */
function trackSettled(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gerçek workspace'e delege eden sarmalayıcı (yalnız `overrides` farklı). */
function delegatingWorkspace(real: Workspace, overrides: Partial<Workspace> = {}): Workspace {
  return {
    repoRoot: real.repoRoot,
    workspaceDir: real.workspaceDir,
    baseCommit: real.baseCommit,
    sessionId: real.sessionId,
    editablePaths: real.editablePaths,
    base: real.base,
    readBaseEntry: (p: string) => real.readBaseEntry(p),
    snapshotRecoveryState: () => real.snapshotRecoveryState(),
    recoveryStateHash: () => real.recoveryStateHash(),
    matchesRecoveryStateHash: (expected: string) => real.matchesRecoveryStateHash(expected),
    currentCreatedPaths: () => real.currentCreatedPaths(),
    setReadonlyPaths: (p: readonly string[]) => real.setReadonlyPaths(p),
    applyPatchSet: (result) => real.applyPatchSet(result),
    resetToBase: () => real.resetToBase(),
    diff: (options) => real.diff(options),
    stat: (options) => real.stat(options),
    exportPatch: (outputRoot: string) => real.exportPatch(outputRoot),
    destroy: () => real.destroy(),
    ...overrides,
  };
}

/** Beklenen patch yolu: `<outputRoot>/patches/<repo-id>/<session-id>.patch`. */
function expectedPatchPath(h: ManagerHarness, sessionId: string): string {
  return path.join(h.fixture.outputRoot, "patches", computeRepoId(h.fixture.repoRoot), `${sessionId}.patch`);
}

/** `child` (mutlak) `parent`'ın içinde mi (ya da kendisi mi)? */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Ana checkout'un `.git` DIŞINDAKİ tüm dosyalarının bayt anlık görüntüsü. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        out.set(path.relative(root, abs), (await readFile(abs)).toString("base64"));
      }
    }
  };
  await walk(root);
  return out;
}

/** YALNIZ test harness'ı: patch'in eşleşen tabana uygulanabildiğini tek kullanımlık klonda doğrular. */
function assertPatchAppliesToBase(h: ManagerHarness, patchPath: string): void {
  const clone = path.join(h.fixture.root, `clone-${randomUUID()}`);
  execFileSync("git", ["clone", "-q", h.fixture.repoRoot, clone], { stdio: "ignore" });
  execFileSync("git", ["apply", "--check", patchPath], { cwd: clone, stdio: "ignore" });
}

/** İki dosyayı değiştiren 1. tur (`src/a.ts` 1→2, `src/b.ts` 10→20). */
async function twoFileRound1(h: ManagerHarness) {
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Changed both constants.",
      edits: [
        { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace: "const value = 2;" }] },
        { kind: "modify", path: "src/b.ts", operations: [{ search: "const other = 10;", replace: "const other = 20;" }] },
      ],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  return h.manager.createTask({ task: "Change both constants", files: ["src/a.ts", "src/b.ts"] });
}

/** Token sayımı (count + tokenize) sayacını backend'e bağlar. */
function countTokenCalls(backend: FakeBackend): { count: number } {
  const counter = { count: 0 };
  const count = backend.countBehavior;
  const tokenize = backend.tokenizeBehavior;
  backend.countBehavior = (messages) => {
    counter.count++;
    return count(messages);
  };
  backend.tokenizeBehavior = (content) => {
    counter.count++;
    return tokenize(content);
  };
  return counter;
}

// ── Step 10 (D): splash_diff ─────────────────────────────────────────────────

test("D1: tüm workspace diff'i — -U3 (3 bağlam satırı) + workspace.diff() ile BİREBİR", async (t) => {
  const h = await makeManagerHarness(t);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await writeFile(path.join(h.fixture.repoRoot, "src/long.ts"), `${lines.join("\n")}\n`);
  git(h.fixture.repoRoot, "add", "-A");
  git(h.fixture.repoRoot, "commit", "-m", "long file");
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Renamed line ten.",
      edits: [{ kind: "modify", path: "src/long.ts", operations: [{ search: "line 10\n", replace: "line ten\n" }] }],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await h.manager.createTask({ task: "Rename line ten", files: ["src/long.ts"] });

  const result = await h.manager.diff({ sessionId: first.sessionId });
  assert.equal(result.mode, "diff");
  assert.ok(result.mode === "diff");
  const diffLines = result.diff.split("\n");
  // (git'in varsayılan funcname başlığı `@@ ... @@`'den sonra bir bağlam satırı ekleyebilir.)
  const hunks = diffLines.filter((line) => line.startsWith("@@ "));
  assert.equal(hunks.length, 1, `tek hunk beklenir: ${JSON.stringify(hunks)}`);
  assert.ok(hunks[0]?.startsWith("@@ -7,7 +7,7 @@"), `hunk = 3 bağlam + değişiklik + 3 bağlam: ${hunks[0]}`);
  assert.ok(diffLines.includes(" line 7") && diffLines.includes(" line 13"), "3 bağlam satırı her iki yanda");
  assert.ok(!diffLines.includes(" line 6") && !diffLines.includes(" line 14"), "3'ten fazla bağlam YOK (-U3)");
  assert.ok(diffLines.includes("-line 10") && diffLines.includes("+line ten"));

  // Workspace otoriter: manager diff'i = varsayılan `workspace.diff()` BİREBİR.
  const workspace = h.manager.activeSessions()[0]?.workspace;
  assert.ok(workspace !== undefined);
  assert.equal(result.diff, await workspace.diff());
});

test("D2: dosya filtresi — iki değişmiş dosyadan istenen YALNIZ o döner", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await twoFileRound1(h);

  const whole = await h.manager.diff({ sessionId: first.sessionId });
  assert.ok(whole.mode === "diff");
  assert.ok(whole.diff.includes("diff --git a/src/a.ts b/src/a.ts") && whole.diff.includes("diff --git a/src/b.ts b/src/b.ts"));

  const only = await h.manager.diff({ sessionId: first.sessionId, files: ["src/b.ts"] });
  assert.ok(only.mode === "diff");
  assert.ok(only.diff.includes("diff --git a/src/b.ts b/src/b.ts"));
  assert.ok(only.diff.includes("+const other = 20;"));
  assert.ok(!only.diff.includes("src/a.ts"), "istenmeyen dosya diff'te OLMAMALI");
  assert.ok(!only.diff.includes("const value"), "istenmeyen dosyanın içeriği OLMAMALI");
});

test("D3: literal filtre genişlemez; güvensiz yol / kötü girdi → invalid_input (disk/kurtarma YOK)", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await twoFileRound1(h);

  // Glob/pathspec-benzeri girdiler LİTERAL yorumlanır — eşleşen dosya yok → boş.
  for (const pattern of ["src/*.ts", "src/?.ts", ":(glob)src/*", "*"]) {
    const res = await h.manager.diff({ sessionId: first.sessionId, files: [pattern] });
    assert.deepEqual(res, { mode: "diff", diff: "" }, `literal olmalı: ${pattern}`);
    const st = await h.manager.diff({ sessionId: first.sessionId, files: [pattern], stat: true });
    assert.deepEqual(st, { mode: "stat", diffStats: { files: 0, insertions: 0, deletions: 0 } });
  }

  // Güvensiz girdi: önbelleği BOŞ ikinci manager — red kurtarmadan ÖNCE olmalı.
  const { manager: second } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  const restoreBefore = h.restoreCalls.count;
  const invalid = (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input";
  for (const unsafe of ["../x", "/abs/path", ".git/config", "src/.GIT/x", "src\\a.ts", "src/\0a.ts", ""]) {
    await assert.rejects(second.diff({ sessionId: first.sessionId, files: [unsafe] }), invalid, `güvensiz: ${JSON.stringify(unsafe)}`);
    await assert.rejects(second.diff({ sessionId: first.sessionId, files: [unsafe], stat: true }), invalid);
  }
  await assert.rejects(second.diff({ sessionId: first.sessionId, files: [42] as never }), invalid);
  await assert.rejects(second.diff({ sessionId: first.sessionId, files: "src/a.ts" as never }), invalid);
  await assert.rejects(second.diff({ sessionId: first.sessionId, stat: "yes" as never }), invalid);
  await assert.rejects(second.diff({ sessionId: "../escape" }), invalid);
  assert.equal(h.restoreCalls.count, restoreBefore, "red disk load/kurtarma ÖNCESİ olmalı");
  assert.equal(second.activeSessions().length, 0);
});

test("D4: tur-0 oturum (needs_split) → boş diff \"\" + 0/0/0 istatistik", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.countBehavior = () => 999_999_999;
  const first = await h.manager.createTask({ task: "Huge", files: ["src/a.ts"] });
  assert.equal(first.status, "needs_split");

  assert.deepEqual(await h.manager.diff({ sessionId: first.sessionId }), { mode: "diff", diff: "" });
  assert.deepEqual(await h.manager.diff({ sessionId: first.sessionId, stat: true }), {
    mode: "stat",
    diffStats: { files: 0, insertions: 0, deletions: 0 },
  });
});

test("D5/D6: stat:true → YALNIZ sayılar (kaynak YOK); files + stat → filtreli sayılar", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await twoFileRound1(h);

  const whole = await h.manager.diff({ sessionId: first.sessionId, stat: true });
  assert.deepEqual(whole, { mode: "stat", diffStats: { files: 2, insertions: 2, deletions: 2 } });
  assert.ok(!JSON.stringify(whole).includes("const"), "istatistik kaynak içeriği taşımaz");

  const filtered = await h.manager.diff({ sessionId: first.sessionId, files: ["src/b.ts"], stat: true });
  assert.deepEqual(filtered, { mode: "stat", diffStats: { files: 1, insertions: 1, deletions: 1 } });

  // Değişmemiş güvenli dosya → sıfır (hata DEĞİL).
  await writeFile(path.join(h.fixture.repoRoot, "src/c.ts"), "untouched\n");
  const unchanged = await h.manager.diff({ sessionId: first.sessionId, files: ["src/c.ts"], stat: true });
  assert.deepEqual(unchanged, { mode: "stat", diffStats: { files: 0, insertions: 0, deletions: 0 } });

  // stat:false → diff modu (varsayılanla aynı).
  const explicitFalse = await h.manager.diff({ sessionId: first.sessionId, stat: false });
  assert.equal(explicitFalse.mode, "diff");
});

test("D7: yeniden başlatma — yeni manager birebir AYNI diff/stat; inference YOK; kurtarma bir kez", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await twoFileRound1(h);
  const before = await h.manager.diff({ sessionId: first.sessionId });
  const beforeStat = await h.manager.diff({ sessionId: first.sessionId, stat: true });
  const restoreBefore = h.restoreCalls.count;

  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  const after = await second.diff({ sessionId: first.sessionId });
  const afterStat = await second.diff({ sessionId: first.sessionId, stat: true });

  assert.deepEqual(after, before, "restart sonrası diff BİREBİR aynı");
  assert.deepEqual(afterStat, beforeStat);
  assert.equal(b2.runCalls.length, 0, "kurtarma + diff model-free");
  assert.equal(h.restoreCalls.count, restoreBefore + 1, "lazy kurtarma BİR kez");
  assert.equal(second.activeSessions()[0]?.round, 1);
});

test("D8: ana ağaç sürüklendi (stale) → diff yine workspace katkısını döner (stale guard DEĞİL)", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  await writeFile(path.join(h.fixture.repoRoot, "src/a.ts"), "const value = 1;\n// drifted\n");
  const gateBefore = h.liveBaseGate.calls;

  const result = await h.manager.diff({ sessionId: first.sessionId });
  assert.ok(result.mode === "diff");
  assert.ok(result.diff.includes("-const value = 1;") && result.diff.includes("+const value = 2;"));
  assert.ok(!result.diff.includes("drifted"), "diff ana ağaca DEĞİL immutable base'e görecelidir");
  assert.equal(h.liveBaseGate.calls, gateBefore, "diff stale ölçümü YAPMAZ");
});

test("D9: diff inference/kalıcılık/durum mutasyonu YAPMAZ — sayaçlar + session.json baytları aynen", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await twoFileRound1(h);
  const tokens = countTokenCalls(h.backend);
  const sessionFile = path.join(h.sessionsDir, first.sessionId, "session.json");
  const bytesBefore = await readFile(sessionFile);
  const counters = () => ({
    runCalls: h.backend.runCalls.length,
    tokens: tokens.count,
    saves: h.store.saves.length,
    resolves: h.resolver.resolveCount,
    cwd: h.cwdCalls.count,
    liveBase: h.liveBaseGate.calls,
    round: h.manager.activeSessions()[0]?.round,
  });
  const before = counters();

  await h.manager.diff({ sessionId: first.sessionId });
  await h.manager.diff({ sessionId: first.sessionId, stat: true });
  await h.manager.diff({ sessionId: first.sessionId, files: ["src/a.ts"] });
  await h.manager.diff({ sessionId: first.sessionId, files: ["src/a.ts"], stat: true });

  assert.deepEqual(counters(), before, "diff: inference/token/save/kural/keşif/stale/tur YOK");
  assert.deepEqual(await readFile(sessionFile), bytesBefore, "session.json BAYT-BAYT aynı");
});

test("D10: kapanmış oturum → diff session_not_found (RAM'den diriltme YOK)", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  await h.manager.close({ sessionId: first.sessionId });
  await assert.rejects(
    h.manager.diff({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_not_found",
  );
  await assert.rejects(
    h.manager.diff({ sessionId: first.sessionId, stat: true }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_not_found",
  );
});

test("D11: in-flight refine sırasında diff — refine BİTMEDEN çözülmez; refine'ın commit ettiği turu döner", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const gate = deferred();
  h.backend.runBehavior = async () => {
    await gate.promise;
    return {
      content: modifyWorkerJson("const value = 1;", "const value = 3;", "Changed value to 3."),
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  };

  const refinePromise = h.manager.refine({ sessionId: first.sessionId, feedback: "again", files: [] });
  let diffPromise: ReturnType<SessionManager["diff"]>;
  try {
    await waitFor(() => h.backend.runCalls.length >= 2); // refine dispatch'te (in-flight)
    diffPromise = h.manager.diff({ sessionId: first.sessionId });
    const diffSettled = trackSettled(diffPromise);
    await sleep(50);
    assert.equal(diffSettled(), false, "aynı oturumun diff'i in-flight refine'ı BEKLER (FIFO)");
  } finally {
    gate.resolve(); // hata yolunda da: takılı iş dispose'u (after-hook) kilitlemesin
  }
  const refined = await refinePromise;
  const result = await diffPromise;
  assert.equal(refined.round, 2);
  assert.ok(result.mode === "diff");
  assert.ok(result.diff.includes("+const value = 3;"), "diff refine'ın commit ettiği turu görür");
  assert.ok(!result.diff.includes("+const value = 2;"));
});

// ── Step 10 (E): splash_close ────────────────────────────────────────────────

test("C0: close girdi doğrulaması — güvensiz id → invalid_input; dispose sonrası shutting_down (fs YOK)", async (t) => {
  const h = await makeManagerHarness(t);
  for (const bad of ["../escape", "a/b", "", "..", "x\0y"]) {
    await assert.rejects(
      h.manager.close({ sessionId: bad }),
      (e: unknown) => e instanceof SplashTaskError && e.kind === "invalid_input" && !e.message.includes("escape"),
    );
  }
  await assert.rejects(
    h.manager.close({ sessionId: randomUUID() }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_not_found",
  );
  assert.ok(!(await pathExists(h.sessionsDir)), "close hiçbir dizin OLUŞTURMAZ");
  assert.ok(!(await pathExists(path.join(h.fixture.outputRoot, "patches"))), "bilinmeyen oturum patch ÜRETMEZ");
});

test("C1: fresh close — mutlak patch (repo+workspace DIŞI, --full-index), workspace/session.json/RAM gider, patch KALIR", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Modified a, deleted b, created new.",
      edits: [
        { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace: "const value = 2;" }] },
        { kind: "delete", path: "src/b.ts" },
        { kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" },
      ],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const first = await h.manager.createTask({ task: "Mixed change", files: ["src/a.ts", "src/b.ts", "src/new.ts"] });
  assert.equal(first.status, "applied");
  const sessionDir = path.join(h.sessionsDir, first.sessionId);
  const wsDir = path.join(sessionDir, "workspace");
  const mainBefore = await snapshotTree(h.fixture.repoRoot);

  const result = await h.manager.close({ sessionId: first.sessionId });

  // Sonuç: içerik YOK; metadata kalıcı son sonuçtan + canlı stat'tan.
  assert.equal(result.baseStatus, "fresh");
  assert.ok(!("staleFiles" in result), "fresh sonuçta stale_files YOK");
  assert.equal(result.patchPath, expectedPatchPath(h, first.sessionId));
  assert.ok(path.isAbsolute(result.patchPath));
  assert.ok(!isInside(h.fixture.repoRoot, result.patchPath), "patch repo DIŞINDA");
  assert.ok(!isInside(wsDir, result.patchPath), "patch workspace DIŞINDA");
  assert.deepEqual(result.filesChanged, first.filesChanged);
  assert.deepEqual(result.diffStats, first.diffStats);
  assert.equal(result.summary, first.summary);
  assert.deepEqual(Object.keys(result).sort(), ["baseStatus", "diffStats", "filesChanged", "patchPath", "summary"]);

  // Yaşam döngüsü: workspace + yetkili durum + RAM gitti.
  assert.ok(!(await pathExists(wsDir)), "workspace imha edildi");
  assert.ok(!(await pathExists(path.join(sessionDir, "session.json"))), "yetkili durum silindi");
  assert.ok(!(await pathExists(sessionDir)), "boş oturum dizini dar rmdir ile gitti");
  assert.equal(h.manager.activeSessions().length, 0);

  // Patch kapanıştan SONRA okunur: tam (--binary --full-index), base-göreceli.
  const patch = await readFile(result.patchPath, "utf8");
  assert.match(patch, /^index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}/m, "--full-index");
  assert.ok(patch.includes("+const value = 2;"), "modifikasyon");
  assert.ok(patch.includes("deleted file mode") && patch.includes("-const other = 10;"), "silme");
  assert.ok(patch.includes("new file mode") && patch.includes("+export const fresh = true;"), "worker create");
  assertPatchAppliesToBase(h, result.patchPath);

  // Splash ana checkout'a HİÇBİR ŞEY yazmadı / uygulamadı.
  assert.deepEqual(await snapshotTree(h.fixture.repoRoot), mainBefore, "ana checkout BAYT-BAYT aynı");
});

test("C2: stale close (editable dosya sürüklendi) → export ENGELLENMEZ; stale + staleFiles; ana dosya AYNEN; patch base→worker", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const drifted = "const value = 1;\n// drifted by the user\n";
  await writeFile(path.join(h.fixture.repoRoot, "src/a.ts"), drifted);
  const sessionDir = path.join(h.sessionsDir, first.sessionId);

  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(result.baseStatus, "stale");
  assert.ok(result.baseStatus === "stale");
  assert.deepEqual(result.staleFiles, ["src/a.ts"]);
  assert.equal(result.patchPath, expectedPatchPath(h, first.sessionId));
  assert.deepEqual(result.filesChanged, ["src/a.ts"]);

  // Stale close oturumu YİNE kapatır (açık bırakmak yasak).
  assert.ok(!(await pathExists(sessionDir)));
  assert.equal(h.manager.activeSessions().length, 0);

  // Ana dosya testin yazdığı haliyle BİREBİR — otomatik uygulama YOK.
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/a.ts"), "utf8"), drifted);
  // Patch immutable base → worker (sürüklenmiş içerik YOK) + tabana uygulanabilir.
  const patch = await readFile(result.patchPath, "utf8");
  assert.ok(patch.includes("-const value = 1;") && patch.includes("+const value = 2;"));
  assert.ok(!patch.includes("drifted"), "sürüklenmiş ana ağaç içeriği patch'e GİRMEZ");
  assertPatchAppliesToBase(h, result.patchPath);
});

test("C3: created-path çakışması → stale + src/new.ts; patch export edilir; ana src/new.ts AYNEN", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Added the new file.",
      edits: [{ kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" }],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  // Create-only görev (`files: []`): `src/new.ts` düzenlenebilir taban DEĞİL —
  // böylece stale kararını YALNIZ created-path çakışma kuralı verebilir
  // (editable olsaydı yok→var parmak izi farkı kuralı maskelerdi).
  const first = await h.manager.createTask({ task: "Add a new file", files: [] });
  assert.equal(first.status, "applied");
  await writeFile(path.join(h.fixture.repoRoot, "src/new.ts"), "my own content\n");

  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.ok(result.baseStatus === "stale", "worker-create yolu ana ağaçta belirdi → stale");
  assert.deepEqual(result.staleFiles, ["src/new.ts"]);
  assert.deepEqual(result.filesChanged, ["src/new.ts"]);
  assert.equal(await readFile(path.join(h.fixture.repoRoot, "src/new.ts"), "utf8"), "my own content\n");
  const patch = await readFile(result.patchPath, "utf8");
  assert.ok(patch.includes("new file mode") && patch.includes("+export const fresh = true;"));
  assert.ok(!(await pathExists(path.join(h.sessionsDir, first.sessionId))), "oturum başarıyla kapandı");
});

test("C4: tur-0 close — 0 baytlık patch, [], 0/0/0; özet kalıcı needs_split özeti ya da (latestResult yoksa) sabit özet", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.countBehavior = () => 999_999_999;
  h.backend.runBehavior = async () => {
    throw new Error("tur-0 close'da model ÇAĞRILMAMALI");
  };

  // (a) needs_split ilk tur: latestResult kalıcı (needs_split özeti).
  const first = await h.manager.createTask({ task: "Huge", files: ["src/a.ts"] });
  assert.equal(first.status, "needs_split");
  const closed = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(closed.baseStatus, "fresh");
  assert.deepEqual(closed.filesChanged, []);
  assert.deepEqual(closed.diffStats, { files: 0, insertions: 0, deletions: 0 });
  assert.equal(closed.summary, first.summary, "kalıcı compact özet");
  assert.equal((await stat(closed.patchPath)).size, 0, "değişiklik yok → 0 baytlık geçerli patch");
  assert.ok(!(await pathExists(path.join(h.sessionsDir, first.sessionId))));

  // (b) latestResult HİÇ olmayan tur-0 oturum (şema geçerli) → sabit güvenli özet.
  const bare = await h.manager.createTask({ task: "Huge again", files: ["src/a.ts"] });
  const sessionFile = path.join(h.sessionsDir, bare.sessionId, "session.json");
  const persisted = (await readSessionJson(bare.sessionId, h.sessionsDir)) as PersistedSession & { latestResult?: unknown };
  delete persisted.latestResult;
  await writeFile(sessionFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });
  const bareClosed = await second.close({ sessionId: bare.sessionId });
  assert.equal(bareClosed.summary, "The session was closed without a generated worker result.");
  assert.deepEqual(bareClosed.filesChanged, []);
  assert.deepEqual(bareClosed.diffStats, { files: 0, insertions: 0, deletions: 0 });
  assert.equal((await stat(bareClosed.patchPath)).size, 0);
  assert.equal(b2.runCalls.length + h.backend.runCalls.length, 0);
});

test("C5: yeniden başlatma close — yeni manager kurtarır + kapatır; inference YOK", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const restoreBefore = h.restoreCalls.count;
  const { manager: second, backend: b2 } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });

  const result = await second.close({ sessionId: first.sessionId });
  assert.equal(result.baseStatus, "fresh");
  assert.deepEqual(result.filesChanged, ["src/a.ts"]);
  assert.equal(result.summary, first.summary);
  assert.equal(b2.runCalls.length, 0, "kurtarma + close model-free");
  assert.equal(h.restoreCalls.count, restoreBefore + 1);
  assert.ok((await readFile(result.patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(path.join(h.sessionsDir, first.sessionId))));
});

test("C6: export hatası (gerçek fs) → export_failed; workspace + session.json + RAM KORUNUR; düzeltince retry başarılı", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sessionDir = path.join(h.sessionsDir, first.sessionId);
  const blocker = path.join(h.fixture.outputRoot, "patches");
  await writeFile(blocker, "not a directory\n"); // `patches/<repo-id>` mkdir'ı ENOTDIR

  await assert.rejects(
    h.manager.close({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof WorkspaceError && e.kind === "export_failed" && e.message === "Patch export failed",
  );
  // Hiçbir şey silinmedi; oturum geçerli + kullanılabilir.
  assert.ok(await pathExists(path.join(sessionDir, "workspace")), "workspace KORUNUR");
  assert.ok(await pathExists(path.join(sessionDir, "session.json")), "session.json KORUNUR");
  assert.deepEqual(
    h.manager.activeSessions().map((s) => s.sessionId),
    [first.sessionId],
    "RAM girdisi geçerli kalır",
  );
  const diff = await h.manager.diff({ sessionId: first.sessionId });
  assert.ok(diff.mode === "diff" && diff.diff.includes("+const value = 2;"), "oturum hâlâ kullanılabilir");

  // Arıza kaldırılır → aynı close başarılı.
  await rm(blocker);
  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(result.patchPath, expectedPatchPath(h, first.sessionId));
  assert.ok((await readFile(result.patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(sessionDir)));
  assert.equal(h.manager.activeSessions().length, 0);
});

test("C7: imha arızası (export SONRASI) → hata; patch + session.json KALIR; RAM düşer; retry kurtarır + kapatır", async (t) => {
  const fault = { destroyFailuresLeft: 1 };
  const h = await makeManagerHarness(t, {
    wrapWorkspace: (real) =>
      delegatingWorkspace(real, {
        destroy: async () => {
          if (fault.destroyFailuresLeft > 0) {
            fault.destroyFailuresLeft--;
            throw new WorkspaceError("workspace_operation_failed", "Workspace destruction failed");
          }
          await real.destroy();
        },
      }),
  });
  const first = await taskRound1(h);
  const sessionDir = path.join(h.sessionsDir, first.sessionId);
  const patchPath = expectedPatchPath(h, first.sessionId);

  await assert.rejects(
    h.manager.close({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof WorkspaceError && e.kind === "workspace_operation_failed",
  );
  assert.ok(await pathExists(patchPath), "export başarılıydı → patch dayanıklı artifact olarak KALIR");
  assert.ok(await pathExists(path.join(sessionDir, "session.json")), "imha başarısız → yetkili durum SİLİNMEZ");
  assert.equal(h.manager.activeSessions().length, 0, "canlılığı belirsiz workspace RAM'de tutulmaz");

  const restoreBefore = h.restoreCalls.count;
  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(h.restoreCalls.count, restoreBefore + 1, "retry diskten lazy kurtarır");
  assert.equal(result.patchPath, patchPath);
  assert.ok((await readFile(patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(path.join(sessionDir, "workspace"))));
  assert.ok(!(await pathExists(path.join(sessionDir, "session.json"))));
  assert.equal(h.manager.activeSessions().length, 0);
});

test("C8: yetkili durum silme arızası (unlink ÖNCESİ) → hata; session.json KALIR, workspace YOK, RAM düşer; retry yeniden kurar", async (t) => {
  const fault = { deleteFailuresLeft: 1 };
  const h = await makeManagerHarness(t, {
    wrapStore: (inner) => ({
      get sessionsDir() {
        return inner.sessionsDir;
      },
      sessionDirFor: (id: string) => inner.sessionDirFor(id),
      create: (id: string) => inner.create(id),
      load: (id: string) => inner.load(id),
      save: (session: PersistedSession) => inner.save(session),
      delete: async (id: string) => {
        if (fault.deleteFailuresLeft > 0) {
          fault.deleteFailuresLeft--;
          throw new SessionError("session_operation_failed");
        }
        await inner.delete(id);
      },
    }),
  });
  const first = await taskRound1(h);
  const sessionDir = path.join(h.sessionsDir, first.sessionId);

  await assert.rejects(
    h.manager.close({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_operation_failed",
  );
  assert.ok(await pathExists(path.join(sessionDir, "session.json")), "yetkili durum KALIR");
  assert.ok(!(await pathExists(path.join(sessionDir, "workspace"))), "workspace zaten imha edildi");
  assert.equal(h.manager.activeSessions().length, 0, "imha edilmiş workspace RAM'de bırakılmaz");
  assert.ok(await pathExists(expectedPatchPath(h, first.sessionId)));

  const restoreBefore = h.restoreCalls.count;
  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(h.restoreCalls.count, restoreBefore + 1, "retry workspace'i diskten yeniden kurar");
  assert.equal(result.baseStatus, "fresh");
  assert.ok((await readFile(result.patchPath, "utf8")).includes("+const value = 2;"), "export deterministik tekrar");
  assert.ok(!(await pathExists(sessionDir)));
});

test("C9: iki close (eşzamanlı) → ilki kazanır, ikincisi session_not_found; sonra her çağrı not_found", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);

  const [a, b] = await Promise.allSettled([
    h.manager.close({ sessionId: first.sessionId }),
    h.manager.close({ sessionId: first.sessionId }),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.ok(b.status === "rejected" && b.reason instanceof SessionError && b.reason.kind === "session_not_found");

  const notFound = (e: unknown) => e instanceof SessionError && e.kind === "session_not_found";
  await assert.rejects(h.manager.close({ sessionId: first.sessionId }), notFound);
  await assert.rejects(h.manager.refine({ sessionId: first.sessionId, feedback: "x", files: [] }), notFound);
});

test("C10: close+refine sıralanır — refine-önce: close yeni turu export eder; close-önce: refine not_found, backend YOK", async (t) => {
  // (a) refine ÖNCE (deferred backend): close refine'ın commit ettiği turu görür.
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h, ["src/a.ts", "src/new.ts"]);
  const gate = deferred();
  h.backend.runBehavior = async () => {
    await gate.promise;
    return {
      content: workerJson({
        summary: "Changed value to 3 and added the file.",
        edits: [
          { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace: "const value = 3;" }] },
          { kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" },
        ],
      }),
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  };
  const refinePromise = h.manager.refine({ sessionId: first.sessionId, feedback: "more", files: [] });
  let closePromise: ReturnType<SessionManager["close"]>;
  try {
    await waitFor(() => h.backend.runCalls.length >= 2);
    closePromise = h.manager.close({ sessionId: first.sessionId });
    const closeSettled = trackSettled(closePromise);
    await sleep(50);
    assert.equal(closeSettled(), false, "close in-flight refine'ı BEKLER");
  } finally {
    gate.resolve();
  }
  const refined = await refinePromise;
  const closed = await closePromise;
  assert.equal(refined.round, 2);
  assert.deepEqual(closed.filesChanged, refined.filesChanged, "close tur 2'nin dosyalarını raporlar");
  assert.deepEqual(closed.filesChanged, ["src/a.ts", "src/new.ts"]);
  assert.deepEqual(closed.diffStats, refined.diffStats);
  const patch = await readFile(closed.patchPath, "utf8");
  assert.ok(patch.includes("+const value = 3;") && patch.includes("+export const fresh = true;"));

  // (b) close ÖNCE (deferred captureLiveBase): kuyruktaki refine uyanır → not_found.
  const h2 = await makeManagerHarness(t);
  const second = await taskRound1(h2);
  const runsBefore = h2.backend.runCalls.length;
  const liveGate = deferred();
  h2.liveBaseGate.wait = liveGate.promise;
  const closeFirst = h2.manager.close({ sessionId: second.sessionId });
  let queuedRefine: ReturnType<SessionManager["refine"]>;
  try {
    await waitFor(() => h2.liveBaseGate.calls >= 1);
    queuedRefine = h2.manager.refine({ sessionId: second.sessionId, feedback: "late", files: [] });
    const refineSettled = trackSettled(queuedRefine);
    await sleep(50);
    assert.equal(refineSettled(), false, "refine close'u BEKLER");
  } finally {
    h2.liveBaseGate.wait = null;
    liveGate.resolve();
  }
  await closeFirst;
  await assert.rejects(queuedRefine, (e: unknown) => e instanceof SessionError && e.kind === "session_not_found");
  assert.equal(h2.backend.runCalls.length, runsBefore, "kapanmış oturum için backend ÇAĞRILMAZ");
});

test("C11: close+diff sıralanır — diff-önce tam diff döner; close-önce kuyruktaki diff not_found", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const [diff, closed] = await Promise.all([
    h.manager.diff({ sessionId: first.sessionId }),
    h.manager.close({ sessionId: first.sessionId }),
  ]);
  assert.ok(diff.mode === "diff" && diff.diff.includes("+const value = 2;"), "diff close'dan ÖNCE canlı workspace'i gördü");
  assert.equal(closed.baseStatus, "fresh");

  const second = await taskRound1(h);
  const liveGate = deferred();
  h.liveBaseGate.wait = liveGate.promise;
  const closeFirst = h.manager.close({ sessionId: second.sessionId });
  let queuedDiff: ReturnType<SessionManager["diff"]>;
  try {
    await waitFor(() => h.liveBaseGate.calls >= 1);
    queuedDiff = h.manager.diff({ sessionId: second.sessionId });
    const diffSettled = trackSettled(queuedDiff);
    await sleep(50);
    assert.equal(diffSettled(), false, "diff in-flight close'u BEKLER (imha edilen workspace gözlemlenmez)");
  } finally {
    h.liveBaseGate.wait = null;
    liveGate.resolve();
  }
  await closeFirst;
  await assert.rejects(queuedDiff, (e: unknown) => e instanceof SessionError && e.kind === "session_not_found");
});

test("C12: close inference YAPMAZ — backend/token/kural/keşif/kalıcılık sayaçları aynen; stale ölçümü BİR kez", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const tokens = countTokenCalls(h.backend);
  const before = {
    runCalls: h.backend.runCalls.length,
    tokens: tokens.count,
    saves: h.store.saves.length,
    resolves: h.resolver.resolveCount,
    cwd: h.cwdCalls.count,
  };
  const liveBefore = h.liveBaseGate.calls;

  await h.manager.close({ sessionId: first.sessionId });
  assert.deepEqual(
    {
      runCalls: h.backend.runCalls.length,
      tokens: tokens.count,
      saves: h.store.saves.length,
      resolves: h.resolver.resolveCount,
      cwd: h.cwdCalls.count,
    },
    before,
  );
  assert.equal(h.liveBaseGate.calls, liveBefore + 1, "close stale denetimini (export ÖNCESİ) BİR kez yapar");
});

test("C13: max_rounds'taki oturum normal kapanır (guard tetiklenmez, ack yazılmaz)", async (t) => {
  const h = await makeManagerHarness(t, { config: { maxRounds: 1 } });
  const first = await taskRound1(h); // round 1 == maxRounds
  const savesBefore = h.store.saves.length;
  const runsBefore = h.backend.runCalls.length;

  const result = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(result.baseStatus, "fresh");
  assert.deepEqual(result.filesChanged, ["src/a.ts"]);
  assert.equal(result.summary, first.summary);
  assert.equal(h.store.saves.length, savesBefore, "max_rounds ack kalıcılığı YOK");
  assert.equal(h.backend.runCalls.length, runsBefore);
  assert.ok(!(await pathExists(path.join(h.sessionsDir, first.sessionId))));
});

test("C14: dispose in-flight close'u BEKLER; kapanan kapalı kalır; export-hatalı close'un oturumu diskte KALIR", async (t) => {
  // (a) başarılı close in-flight iken dispose.
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const liveGate = deferred();
  h.liveBaseGate.wait = liveGate.promise;
  const closePromise = h.manager.close({ sessionId: first.sessionId });
  let disposePromise: Promise<void>;
  try {
    await waitFor(() => h.liveBaseGate.calls >= 1);
    disposePromise = h.manager.dispose();
    const disposeSettled = trackSettled(disposePromise);
    await sleep(50);
    assert.equal(disposeSettled(), false, "dispose in-flight close'u BEKLER");
  } finally {
    h.liveBaseGate.wait = null;
    liveGate.resolve();
  }
  const closed = await closePromise;
  await disposePromise;
  assert.ok(await pathExists(closed.patchPath));
  assert.ok(!(await pathExists(path.join(h.sessionsDir, first.sessionId))), "başarıyla kapanan KAPALI kalır");
  const shuttingDown = (e: unknown) => e instanceof SplashTaskError && e.kind === "shutting_down";
  await assert.rejects(h.manager.close({ sessionId: first.sessionId }), shuttingDown);
  await assert.rejects(h.manager.diff({ sessionId: first.sessionId }), shuttingDown);

  // (b) export'u başarısız close in-flight iken dispose: güvenli (task_cleanup_failed YOK); oturum dayanıklı.
  const h2 = await makeManagerHarness(t);
  const second = await taskRound1(h2);
  const blocker = path.join(h2.fixture.outputRoot, "patches");
  await writeFile(blocker, "not a directory\n");
  const gate2 = deferred();
  h2.liveBaseGate.wait = gate2.promise;
  const failingClose = h2.manager.close({ sessionId: second.sessionId });
  let dispose2: Promise<void>;
  try {
    await waitFor(() => h2.liveBaseGate.calls >= 1);
    dispose2 = h2.manager.dispose();
  } finally {
    h2.liveBaseGate.wait = null;
    gate2.resolve();
  }
  await assert.rejects(failingClose, (e: unknown) => e instanceof WorkspaceError && e.kind === "export_failed");
  await dispose2; // export_failed güvenli sınıfta — dispose REDDETMEZ
  const sessionDir = path.join(h2.sessionsDir, second.sessionId);
  assert.ok(await pathExists(path.join(sessionDir, "session.json")), "export-hatalı close'un oturumu diskte KALIR");
  assert.ok(await pathExists(path.join(sessionDir, "workspace")));

  // Sonraki süreç aynı oturumu kapatabilir (dayanıklılık kanıtı).
  await rm(blocker);
  const { manager: next } = await makeSecondManager(h2);
  t.after(async () => {
    await next.dispose().catch(() => undefined);
  });
  const reclosed = await next.close({ sessionId: second.sessionId });
  assert.ok((await readFile(reclosed.patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(sessionDir)));
});

// ── Step 10 ek düzeltme S#2: başarısız refine geri yüklemesi ────────────────
// Geri yükleme YALNIZ commit edilmiş salt-okunur kümeyle yapılır ve kurtarma
// ile AYNI BİREBİR doğrulamadan geçer; uyuşmazlıkta RAM girdisi düşer.

test("S2a: başarısız refine (geçersiz JSON) aday salt-okunur kümeyle geri YÜKLEMEZ — worker-create korunur; close TAM patch", async (t) => {
  const h = await makeManagerHarness(t);
  h.backend.runBehavior = async () => ({
    content: workerJson({
      summary: "Added the new file.",
      edits: [{ kind: "create", path: "src/new.ts", content: "export const fresh = true;\n" }],
    }),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  // Create-only görev: `src/new.ts` düzenlenebilir DEĞİL — refine onu salt-okunur referans olarak verebilir.
  const first = await h.manager.createTask({ task: "Add a new file", files: [] });
  assert.equal(first.status, "applied");
  assert.deepEqual(first.filesChanged, ["src/new.ts"]);
  const wsFile = path.join(h.sessionsDir, first.sessionId, "workspace", "src/new.ts");

  // Refine: önceki turun oluşturduğu yol salt-okunur referans; worker GEÇERSİZ JSON döner.
  h.backend.runBehavior = async () => ({ content: "not-a-json", usage: { inputTokens: 1, outputTokens: 1 } });
  await assert.rejects(
    h.manager.refine({ sessionId: first.sessionId, feedback: "Look at the new file", files: ["src/new.ts"] }),
    (e: unknown) => e instanceof WorkerContractError,
    "geri yükleme başarılı → özgün tur hatası yayılır",
  );

  // Workspace kalıcı tur-1 durumunda: dosya VAR + hash = kalıcı hash; oturum RAM'de.
  assert.equal(await readFile(wsFile, "utf8"), "export const fresh = true;\n");
  const persisted = await readSessionJson(first.sessionId, h.sessionsDir);
  const live = h.manager.activeSessions()[0];
  assert.ok(live !== undefined, "geri yükleme doğrulandı → RAM girdisi geçerli kalır");
  assert.equal(await live.workspace.recoveryStateHash(), persisted.latestWorkspaceStateHash);
  const statBeforeClose = await live.workspace.stat();

  // close: eksik patch FRESH export EDİLMEZ — dosya patch'te, metadata tutarlı.
  const closed = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(closed.baseStatus, "fresh");
  assert.deepEqual(closed.filesChanged, ["src/new.ts"]);
  assert.deepEqual(closed.diffStats, statBeforeClose);
  assert.deepEqual(closed.diffStats, { files: 1, insertions: 1, deletions: 0 });
  const patch = await readFile(closed.patchPath, "utf8");
  assert.ok(patch.includes("new file mode") && patch.includes("+export const fresh = true;"), "worker-create patch'te");
});

test("S2b: geri yüklemede yeniden-uygulama sapması → session_recovery_failed; RAM girdisi DÜŞER; diff diskten kurtarır", async (t) => {
  const fault = { tamperNextApply: false };
  const h = await makeManagerHarness(t, {
    wrapWorkspace: (real) =>
      delegatingWorkspace(real, {
        applyPatchSet: async (result) => {
          const applied = await real.applyPatchSet(result);
          if (fault.tamperNextApply) {
            fault.tamperNextApply = false;
            return { ...applied, filesChanged: [...applied.filesChanged, "src/ghost.ts"] };
          }
          return applied;
        },
      }),
  });
  const first = await taskRound1(h);
  const restoreBefore = h.restoreCalls.count;

  // Geçersiz JSON → tur parse'ta düşer (tur içinde apply YOK) → TEK applyPatchSet = geri yükleme.
  h.backend.runBehavior = async () => ({ content: "not-a-json", usage: { inputTokens: 1, outputTokens: 1 } });
  fault.tamperNextApply = true;
  await assert.rejects(
    h.manager.refine({ sessionId: first.sessionId, feedback: "again", files: [] }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_recovery_failed",
  );
  assert.equal(fault.tamperNextApply, false, "sapma geri yüklemenin applyPatchSet'inde üretildi");
  assert.equal(h.manager.activeSessions().length, 0, "belirsiz workspace RAM'de tutulmaz");

  // Sonraki çağrı diskten (hash doğrulamalı) kurtarır ve doğru diff'i döner.
  const diff = await h.manager.diff({ sessionId: first.sessionId });
  assert.equal(h.restoreCalls.count, restoreBefore + 1, "diff lazy kurtarma ile yeniden kurdu");
  assert.ok(diff.mode === "diff" && diff.diff.includes("+const value = 2;"));
  assert.ok(!diff.diff.includes("ghost"));
  assert.equal(h.manager.activeSessions()[0]?.round, 1);
});

test("S2c: üretilmemiş refine turları (needs_split / inference_busy) aday salt-okunur kümeyi COMMIT edilmiş kümeye geri alır", async (t) => {
  const readonlyCalls: string[][] = [];
  const h = await makeManagerHarness(t, {
    wrapWorkspace: (real) =>
      delegatingWorkspace(real, {
        setReadonlyPaths: (paths: readonly string[]) => {
          readonlyCalls.push([...paths]);
          real.setReadonlyPaths(paths);
        },
      }),
  });
  const first = await taskRound1(h); // commit edilmiş salt-okunur küme = []

  h.backend.countBehavior = () => 999_999_999; // → needs_split
  const split = await h.manager.refine({ sessionId: first.sessionId, feedback: "x", files: ["src/b.ts"] });
  assert.equal(split.status, "needs_split");
  assert.deepEqual(readonlyCalls.at(-2), ["src/b.ts"], "tur aday kümeyle doğrulanır");
  assert.deepEqual(readonlyCalls.at(-1), [], "üretilmemiş tur sonrası commit edilmiş küme");

  h.backend.countBehavior = () => 1_000;
  h.lock.busy = true; // → inference_busy
  const busy = await h.manager.refine({ sessionId: first.sessionId, feedback: "y", files: ["src/b.ts"] });
  assert.equal(busy.status, "inference_busy");
  assert.deepEqual(readonlyCalls.at(-1), [], "busy sonrası commit edilmiş küme");
  assert.deepEqual((await readSessionJson(first.sessionId, h.sessionsDir)).readonlyPaths, []);
});

// ── Codex P2 (PR #34): commit edilmiş state doğrulaması + Step 9 hash kabulü ──

/** Son turdan SONRA worktree'deki tracked dosyaları dışarıdan (editör/araç) değiştirir. */
async function driftWorktree(h: ManagerHarness, sessionId: string): Promise<string> {
  const wsDir = path.join(h.sessionsDir, sessionId, "workspace");
  await writeFile(path.join(wsDir, "src/a.ts"), "const value = 999;\n"); // worker'ın dosyası
  await writeFile(path.join(wsDir, "src/b.ts"), "const other = 'external';\n"); // dokunmadığı dosya
  return wsDir;
}

test("E1: RAM'deki worktree dışarıdan değişti → close YALNIZ worker sonucunu export eder; diffStats tutarlı", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const committedStats = (await readSessionJson(first.sessionId, h.sessionsDir)).latestResult?.diffStats;
  await driftWorktree(h, first.sessionId);
  const restoreBefore = h.restoreCalls.count;

  const closed = await h.manager.close({ sessionId: first.sessionId });
  assert.equal(h.restoreCalls.count, restoreBefore, "RAM yolu: lazy kurtarma YOK");
  const patch = await readFile(closed.patchPath, "utf8");
  assert.ok(patch.includes("+const value = 2;"), "worker sonucu patch'te");
  assert.ok(!patch.includes("999") && !patch.includes("external") && !patch.includes("src/b.ts"), "dış değişiklik patch'e GİRMEZ");
  assert.deepEqual(closed.filesChanged, ["src/a.ts"]);
  assert.deepEqual(closed.diffStats, committedStats);
  assert.equal(closed.baseStatus, "fresh");
});

test("E2: RAM'deki worktree dışarıdan değişti → diff YALNIZ worker sonucunu gösterir; kalıcılık YOK", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sessionFile = path.join(h.sessionsDir, first.sessionId, "session.json");
  const persistedBefore = await readFile(sessionFile, "utf8");
  const committedStats = (await readSessionJson(first.sessionId, h.sessionsDir)).latestResult?.diffStats;
  const wsDir = await driftWorktree(h, first.sessionId);
  const restoreBefore = h.restoreCalls.count;

  const diff = await h.manager.diff({ sessionId: first.sessionId });
  assert.ok(diff.mode === "diff" && diff.diff.includes("+const value = 2;"));
  assert.ok(!diff.diff.includes("999") && !diff.diff.includes("external"), "dış değişiklik görünmez");
  await driftWorktree(h, first.sessionId);
  assert.deepEqual(await h.manager.diff({ sessionId: first.sessionId, stat: true }), {
    mode: "stat",
    diffStats: committedStats,
  });
  assert.equal(await readFile(path.join(wsDir, "src/b.ts"), "utf8"), "const other = 10;\n", "worktree commit edilmiş duruma döndü");
  assert.equal(await readFile(sessionFile, "utf8"), persistedBefore, "diff kalıcılık YAPMAZ");
  assert.equal(h.restoreCalls.count, restoreBefore, "RAM yolu: lazy kurtarma YOK");
  assert.equal(h.manager.activeSessions()[0]?.round, 1);
});

test("E3: dış değişiklik + yeniden-uygulama doğrulaması başarısız → close session_recovery_failed; patch YOK, session.json KALIR, RAM düşer", async (t) => {
  const fault = { tamperNextApply: false };
  const h = await makeManagerHarness(t, {
    wrapWorkspace: (real) =>
      delegatingWorkspace(real, {
        applyPatchSet: async (result) => {
          const applied = await real.applyPatchSet(result);
          if (fault.tamperNextApply) {
            fault.tamperNextApply = false;
            return { ...applied, filesChanged: [...applied.filesChanged, "src/ghost.ts"] };
          }
          return applied;
        },
      }),
  });
  const first = await taskRound1(h);
  const sessionFile = path.join(h.sessionsDir, first.sessionId, "session.json");
  await driftWorktree(h, first.sessionId);
  fault.tamperNextApply = true;

  await assert.rejects(
    h.manager.close({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_recovery_failed",
  );
  assert.equal(fault.tamperNextApply, false, "sapma doğrulamanın yeniden-uygulamasında üretildi");
  assert.ok(!(await pathExists(expectedPatchPath(h, first.sessionId))), "export YAPILMAZ");
  assert.ok(await pathExists(sessionFile), "yetkili durum SİLİNMEZ");
  assert.equal(h.manager.activeSessions().length, 0, "doğrulanamayan workspace RAM'de tutulmaz");

  // Retry diskten kurtarır ve YALNIZ worker sonucunu export eder.
  const closed = await h.manager.close({ sessionId: first.sessionId });
  const patch = await readFile(closed.patchPath, "utf8");
  assert.ok(patch.includes("+const value = 2;") && !patch.includes("999") && !patch.includes("external"));
});

test("V8: Step 9 formülüyle (varsayılan-DIŞI config) kaydedilmiş hash → yeniden başlatmada kurtarma BAŞARILI; yanlış hash session_recovery_failed", async (t) => {
  const h = await makeManagerHarness(t);
  const first = await taskRound1(h);
  const sessionFile = path.join(h.sessionsDir, first.sessionId, "session.json");
  const wsDir = path.join(h.sessionsDir, first.sessionId, "workspace");
  const persisted = await readSessionJson(first.sessionId, h.sessionsDir);
  // Step 9 sürecindeki kullanıcı config'i (biçim ayarları) + o sürümün pin'siz formülü.
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  assert.ok(globalConfig !== undefined);
  await writeFile(globalConfig, "[diff]\n\tnoprefix = true\n\talgorithm = histogram\n\tcontext = 7\n[color]\n\tui = always\n");
  const legacyHash = createHash("sha256")
    .update(
      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", persisted.workspaceRecovery.baseCommit],
        { cwd: wsDir },
      ),
    )
    .digest("hex");
  assert.notEqual(legacyHash, persisted.latestWorkspaceStateHash, "fikstür: eski formül bu config'te farklı");
  const writeHash = async (hash: string): Promise<void> => {
    const session = await readSessionJson(first.sessionId, h.sessionsDir);
    session.latestWorkspaceStateHash = hash;
    session.workspaceRecovery = { ...session.workspaceRecovery, recoveryStateHash: hash };
    await writeFile(sessionFile, JSON.stringify(session, null, 2), { mode: 0o600 });
  };
  const { manager: second } = await makeSecondManager(h);
  t.after(async () => {
    await second.dispose().catch(() => undefined);
  });

  // Yanlış hash: hâlâ fail-closed.
  await writeHash("0".repeat(64));
  await assert.rejects(
    second.diff({ sessionId: first.sessionId }),
    (e: unknown) => e instanceof SessionError && e.kind === "session_recovery_failed",
  );

  // Step 9 hash'i: kurtarma + diff + close BAŞARILI; kalıcı durum YENİDEN YAZILMAZ.
  await writeHash(legacyHash);
  const diff = await second.diff({ sessionId: first.sessionId });
  assert.ok(diff.mode === "diff" && diff.diff.includes("+const value = 2;"));
  assert.equal((await readSessionJson(first.sessionId, h.sessionsDir)).latestWorkspaceStateHash, legacyHash);
  const closed = await second.close({ sessionId: first.sessionId });
  assert.ok((await readFile(closed.patchPath, "utf8")).includes("+const value = 2;"));
  assert.ok(!(await pathExists(sessionFile)));
});
