/**
 * InferenceCoordinator testleri (Step 3).
 *
 * Kompozisyon: FAKE InferenceBackend + GERÇEK FIFO (coordinator) +
 * GERÇEK RuntimeLock (geçici outputRoot; release-failure senaryoları
 * `lock` dikişiyle FAKE kilit) + ENJEKTE scanner/liveness/now.
 * Gerçek model runtime'ına, gerçek `ps` tablosuna ya da duvar saati
 * yarışlarına BAĞIMLI DEĞİL: tüm testler deterministiktir (2-3 sn
 * güvenlik ceketi yalnızca takılma korumasıdır).
 *
 * Tüm runtime durumları `os.tmpdir()` + `mkdtemp` altındadır — gerçek
 * `~/.splash`'a YASAK.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CoordinatorError,
  InferenceCoordinator,
  type CoordinatedInferenceRequest,
  type CoordinatedInferenceResult,
  type RuntimeLockLike,
} from "../dist/backend/InferenceCoordinator.js";
import { BackendError } from "../dist/backend/errors.js";
import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
  PromptRenderOptions,
  RuntimeInfo,
  TokenizeOptions,
  TokenizeResult,
} from "../dist/backend/InferenceBackend.js";
import {
  INFERENCE_LOCK_DIR,
  LockError,
  OWNER_FILE_NAME,
  type LockAcquireResult,
  type PidLiveness,
} from "../dist/backend/RuntimeLock.js";
import type { ProcessInfo, ProcessScanner } from "../dist/backend/RuntimeConflictDetector.js";

// ── sahte backend ────────────────────────────────────────────────────────

interface RunLatch {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Test backend'i: `run()` başlar, testin `releaseRun` çağrısına kadar
 * BEKLER (kaynak kapalı tutulur) — böylece FIFO/örtüşme/bırakma
 * davranışları deterministik gözlemlenebilir. Kimlik, mesaj içeriğinden
 * ("A"/"B"/"C") elde edilir; kilit dosyalarına ASLA yazılmaz.
 */
class FakeBackend implements InferenceBackend {
  #info: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 1000,
    servedModel: "test/model",
    runtimeProcessId: 500,
  };
  refreshCalls = 0;
  runStartOrder: string[] = [];
  #activeRuns = 0;
  maxConcurrentRuns = 0;
  #latches = new Map<string, RunLatch>();
  #signals = new Map<string, AbortSignal | undefined>();
  /** Bu kimlikte `run` BackendError ile reddedilir. */
  failingOwner: string | null = null;
  /** Ayarlıysa `refreshRuntimeInfo` bu hata ile reddedilir. */
  refreshFailure: BackendError | null = null;

  get runtimeInfo(): RuntimeInfo | null {
    return this.#info;
  }

  setInfo(info: RuntimeInfo | null): void {
    this.#info = info;
  }

  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    this.refreshCalls += 1;
    if (signal?.aborted) {
      throw new BackendError("network", "Request aborted (/status)", {
        cause: new Error("aborted"),
      });
    }
    if (this.refreshFailure !== null) {
      throw this.refreshFailure;
    }
    if (this.#info === null) {
      throw new BackendError("invalid_status", "Inference runtime is not ready (/status)");
    }
    return this.#info;
  }

  async run(
    messages: InferenceMessage[],
    options: InferenceRunOptions = {},
  ): Promise<InferenceResult> {
    const identity = messages[0]?.content ?? "?";
    this.runStartOrder.push(identity);
    this.#signals.set(identity, options.signal);
    this.#activeRuns += 1;
    this.maxConcurrentRuns = Math.max(this.maxConcurrentRuns, this.#activeRuns);
    try {
      if (this.failingOwner === identity) {
        throw new BackendError(
          "http",
          "Inference runtime returned HTTP 500 from /v1/chat/completions",
          { status: 500 },
        );
      }
      const latch: RunLatch = { resolve: () => {}, reject: () => {} };
      this.#latches.set(identity, latch);
      await new Promise<void>((resolve, reject) => {
        latch.resolve = resolve;
        latch.reject = reject;
        const signal = options.signal;
        if (signal === undefined) {
          return; // Test manuel olarak releaseRun ile çözer.
        }
        if (signal.aborted) {
          reject(this.#abortError());
          return;
        }
        signal.addEventListener("abort", () => reject(this.#abortError()), { once: true });
      });
      return { content: `done-${identity}`, usage: { inputTokens: 1, outputTokens: 2 } };
    } finally {
      this.#activeRuns -= 1;
      this.#latches.delete(identity);
    }
  }

  releaseRun(identity: string): void {
    this.#latches.get(identity)?.resolve();
  }

  getSignal(identity: string): AbortSignal | undefined {
    return this.#signals.get(identity);
  }

  /** Henüz çözülmüş latch'ların kimlikleri (test güvenlik ağı için). */
  latched(): string[] {
    return [...this.#latches.keys()];
  }

  #abortError(): BackendError {
    return new BackendError("network", "Request aborted (/v1/chat/completions)", {
      cause: new Error("aborted"),
    });
  }

  // Step 3 coordinator tokenizer/şablon uçlarını ASLA çağırmaz.
  async tokenize(_content: string, _options?: TokenizeOptions): Promise<TokenizeResult> {
    throw new Error("tokenize() must not be called by the coordinator");
  }

  async renderPrompt(
    _messages: InferenceMessage[],
    _options?: PromptRenderOptions,
  ): Promise<string> {
    throw new Error("renderPrompt() must not be called by the coordinator");
  }

  async countPromptTokens(
    _messages: InferenceMessage[],
    _options?: PromptRenderOptions,
  ): Promise<number> {
    throw new Error("countPromptTokens() must not be called by the coordinator");
  }
}

// ── sahte kilit (release-failure dikişi) ─────────────────────────────────

/**
 * Release hatası senaryoları için sahte kilit: `lock` enjeksiyon dikişi
 * üzerinden coordinator'a verilir; hiçbir fs işlemi yapmaz.
 * `failReleases` kadar `release` çağrısı tip'li `LockError` fırlatır.
 */
class FakeLock implements RuntimeLockLike {
  acquireCalls = 0;
  releaseCalls: string[] = [];
  /** Bu kadar `release` çağrısını reddet (geri kalanı başarılı). */
  failReleases = 0;
  /** `release`'ın fırlattığı en son hata (`cause` doğrulaması için). */
  lastReleaseError: Error | null = null;

  async acquire(ownerId: string): Promise<LockAcquireResult> {
    this.acquireCalls += 1;
    return { acquired: true, token: `tok-${this.acquireCalls}-${ownerId}` };
  }

  async release(token: string): Promise<void> {
    this.releaseCalls.push(token);
    if (this.failReleases > 0) {
      this.failReleases -= 1;
      const err = new LockError(
        "token_mismatch",
        "The inference lock is owned by another session; refusing to remove it",
      );
      this.lastReleaseError = err;
      throw err;
    }
  }
}

// ── test takımı (harness) ───────────────────────────────────────────────

/** Yapılandırılmış Splash runtime'ın tipik süreç ağacı (temiz host). */
const CONFIGURED_TREE: ProcessInfo[] = [
  { pid: 500, ppid: 1, command: "splash serve --port 8000" },
  { pid: 501, ppid: 500, command: "python3 -m splash serve-native --model incoai/Qwen3.8-27B-Splash" },
];

interface Harness {
  coordinator: InferenceCoordinator;
  backend: FakeBackend;
  runtimeDir: string;
  scannerCounts: { count: number };
}

interface HarnessOptions {
  scanner?: ProcessScanner;
  liveness?: PidLiveness;
  now?: () => number;
  /** `lock` enjeksiyon dikişi (release-failure senaryoları). */
  lock?: RuntimeLockLike;
}

async function makeHarness(
  t: TestContext,
  opts: HarnessOptions = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "splash-coord-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const scannerCounts = { count: 0 };
  const inner: ProcessScanner =
    opts.scanner ?? (() => Promise.resolve([...CONFIGURED_TREE]));
  const scanner: ProcessScanner = () => {
    scannerCounts.count += 1;
    return inner();
  };
  const backend = new FakeBackend();
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir,
    scanner,
    liveness: opts.liveness,
    now: opts.now,
    lock: opts.lock,
  });
  // Güvenlik ağı: test bitiminde henüz çözülmüş latch'ları bırak —
  // bekleyen promise'ler olay döngüsünü (ve diğer testleri) asla
  // açıkta bırakmasın.
  t.after(() => {
    for (const identity of backend.latched()) {
      backend.releaseRun(identity);
    }
  });
  return { coordinator, backend, runtimeDir, scannerCounts };
}

function request(ownerId: string, options?: InferenceRunOptions): CoordinatedInferenceRequest {
  return {
    ownerId,
    messages: [{ role: "user", content: ownerId }],
    options,
  };
}

async function lockDirExists(runtimeDir: string): Promise<boolean> {
  try {
    const info = await stat(path.join(runtimeDir, INFERENCE_LOCK_DIR));
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Belirli bir kimliğin run'ı başlayana kadar bekle + kaynak kapansın. */
async function runToCompletion(
  h: Harness,
  promise: Promise<CoordinatedInferenceResult>,
  identity: string,
): Promise<CoordinatedInferenceResult> {
  await waitFor(() => h.backend.runStartOrder.includes(identity), `${identity} to start`);
  h.backend.releaseRun(identity);
  return promise;
}

/**
 * Dispatch promise'ı çözüldükten SONRAKİ temizlik penceresini bekler:
 * `finally` bloğu kilit bırakmayı + sahipliği temizlemeyi promise çözümünden
 * SONRA yaptığında, anlık okuma yarışı olur. Burası "koordinatör tamamen
 * boşta" durumunu (sahiplik temiz, kuyruk boş, kilit yok) garanti eder.
 */
async function waitForIdle(h: Harness): Promise<void> {
  await waitFor(
    async () =>
      h.coordinator.activeOwnerId === null &&
      h.coordinator.queueDepth === 0 &&
      !(await lockDirExists(h.runtimeDir)),
    "the coordinator to become fully idle",
  );
}

/** Takılma koruması: koşul sağlanana kadar (2 sn tavan) 5 ms'de bir bekle. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Kilit dizinine "yabancı" bir sahiplik ön-tesis eder. */
async function plantForeignLock(h: Harness, pid: number, token: string, ownerId: string): Promise<void> {
  const lockDir = path.join(h.runtimeDir, INFERENCE_LOCK_DIR);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockDir, OWNER_FILE_NAME),
    `${JSON.stringify(
      { schema_version: 1, pid, token, owner_id: ownerId, acquired_at: "2026-01-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  );
}

// ── FIFO (madde 28) ──────────────────────────────────────────────────────

test("FIFO: three concurrent dispatches run strictly A→B→C, at most one backend.run at a time", async (t) => {
  const h = await makeHarness(t);
  const pa = h.coordinator.dispatch(request("A"));
  const pb = h.coordinator.dispatch(request("B"));
  const pc = h.coordinator.dispatch(request("C"));

  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");
  assert.deepEqual(h.backend.runStartOrder, ["A"], "B and C must not run while A runs");
  assert.equal(h.coordinator.activeOwnerId, "A");
  assert.equal(h.coordinator.queueDepth, 2, "B and C wait behind A");

  h.backend.releaseRun("A");
  await waitFor(() => h.backend.runStartOrder.length === 2, "B to start");
  assert.deepEqual(h.backend.runStartOrder, ["A", "B"], "strict FIFO order");
  assert.equal(h.coordinator.activeOwnerId, "B");
  assert.equal(h.coordinator.queueDepth, 1);

  h.backend.releaseRun("B");
  await waitFor(() => h.backend.runStartOrder.length === 3, "C to start");
  h.backend.releaseRun("C");

  const [ra, rb, rc] = await Promise.all([pa, pb, pc]);
  assert.deepEqual(ra, {
    status: "completed",
    result: { content: "done-A", usage: { inputTokens: 1, outputTokens: 2 } },
  });
  assert.equal(rb.status, "completed");
  assert.equal(rc.status, "completed");

  assert.equal(h.backend.maxConcurrentRuns, 1, "never two generations at once");
  // Çözülmeden SONRAKİ temizlik (kilit bırakma + sahiplik) bir kaç tick
  // sürer — boşta duruma bekleyip ardından kesin durumu doğrula.
  await waitForIdle(h);
  assert.equal(h.coordinator.activeOwnerId, null, "ownership cleared after the queue drains");
  assert.equal(h.coordinator.queueDepth, 0);
  assert.equal(await lockDirExists(h.runtimeDir), false, "no lock remains after completion");
});

test("same-process wait: B behind A is an ordinary FIFO wait — not busy, not resolved — until A finishes", async (t) => {
  const h = await makeHarness(t);
  const pa = h.coordinator.dispatch(request("A"));
  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");

  const pb = h.coordinator.dispatch(request("B"));
  let bSettled = false;
  void pb.then(
    () => {
      bSettled = true;
    },
    () => {
      bSettled = true;
    },
  );
  // Busy sayılsaydı B mikro-görevlerde (ms'ler içinde) çözülürdü.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bSettled, false, "B must still be WAITING, not resolved busy");
  assert.equal(h.coordinator.queueDepth, 1);
  assert.equal(h.backend.runStartOrder.length, 1, "B must not have reached the backend");

  h.backend.releaseRun("A");
  await pa;
  const rb = await runToCompletion(h, pb, "B");
  if (rb.status !== "completed") {
    throw new Error(`B must complete normally, got: ${JSON.stringify(rb)}`);
  }
  assert.equal(rb.result.content, "done-B");
  await waitForIdle(h);
});

test("a failed inference rejects with its typed error and does NOT poison the queue", async (t) => {
  const h = await makeHarness(t);
  h.backend.failingOwner = "A";
  const pa = h.coordinator.dispatch(request("A"));
  const pb = h.coordinator.dispatch(request("B"));

  let caught: unknown = null;
  await pa.then(
    () => {
      throw new Error("A was supposed to fail");
    },
    (err: unknown) => {
      caught = err;
    },
  );
  assert.ok(caught instanceof BackendError, `expected a BackendError, got: ${String(caught)}`);
  assert.equal((caught as BackendError).kind, "http");
  assert.equal((caught as BackendError).status, 500);

  // Kuyruk zehirlenmedi: B normal devam etti.
  const rb = await runToCompletion(h, pb, "B");
  assert.deepEqual(h.backend.runStartOrder, ["A", "B"]);
  assert.equal(rb.status, "completed");

  // Hatalı işin kilidi B'ye geçmeden bırakıldı; uçta tamamen boşta.
  await waitForIdle(h);
  assert.equal(h.coordinator.activeOwnerId, null);
  assert.equal(h.coordinator.queueDepth, 0);
  assert.equal(await lockDirExists(h.runtimeDir), false, "the failed job's lock was released");
});

test("aborting a QUEUED request: it is removed and rejected; the backend never sees it; A and later C are unaffected", async (t) => {
  const h = await makeHarness(t);
  const pa = h.coordinator.dispatch(request("A"));
  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");

  const controller = new AbortController();
  const pb = h.coordinator.dispatch(request("B", { signal: controller.signal }));
  assert.equal(h.coordinator.queueDepth, 1, "B is queued behind A");

  controller.abort();

  await assert.rejects(
    pb,
    (err: unknown) => err instanceof CoordinatorError && err.kind === "aborted",
  );
  assert.deepEqual(h.backend.runStartOrder, ["A"], "aborted B must never reach the backend");
  assert.equal(h.coordinator.queueDepth, 0, "aborted B was removed from the queue");

  // A etkilenmez:
  h.backend.releaseRun("A");
  const ra = await pa;
  assert.equal(ra.status, "completed");

  // Kuyruk sağlıklı: C sorunsuz koşar.
  const pc = h.coordinator.dispatch(request("C"));
  const rc = await runToCompletion(h, pc, "C");
  assert.equal(rc.status, "completed");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false);
});

test("aborting the ACTIVE request: the signal passes through, the lock is released, the queue continues", async (t) => {
  const h = await makeHarness(t);
  const controller = new AbortController();
  const pa = h.coordinator.dispatch(request("A", { signal: controller.signal }));
  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");

  assert.equal(
    h.backend.getSignal("A"),
    controller.signal,
    "the caller's signal must reach the backend verbatim",
  );
  assert.equal(await lockDirExists(h.runtimeDir), true, "the active job holds the lock");

  controller.abort();

  await assert.rejects(
    pa,
    (err: unknown) => err instanceof BackendError && err.kind === "network",
  );
  // İptal edilmiş işin kilidi finally'de bırakılır; uçta tamamen boşta.
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false, "an aborted job must never leave the lock");
  assert.equal(h.coordinator.activeOwnerId, null);

  const pb = h.coordinator.dispatch(request("B"));
  const rb = await runToCompletion(h, pb, "B");
  assert.equal(rb.status, "completed");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false);
});

// ── kilit yaşam döngüsü (madde 29/38) ───────────────────────────────────

test("constructing a coordinator acquires NOTHING — the lock dir appears only during dispatch and is gone after", async (t) => {
  const h = await makeHarness(t);
  // Konstrüksiyon <outputRoot>/runtime DİZİNİNİN KENDİNİ bile
  // oluşturmaz (yalnız kilit dizininin yokluğu, constructor'da
  // `mkdir(runtimeDir)` regresyonunu ayırt edemezdi — dizin var ama
  // kilit yok halini de yakalar).
  await assert.rejects(
    stat(h.runtimeDir),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
    "the constructor must not create the runtime dir at all",
  );
  assert.equal(await lockDirExists(h.runtimeDir), false, "no lock before the first dispatch");

  const p = h.coordinator.dispatch(request("A"));
  await waitFor(() => lockDirExists(h.runtimeDir), "the lock dir to appear during dispatch");
  h.backend.releaseRun("A");
  const result = await p;
  assert.equal(result.status, "completed");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false, "no lock after the dispatch settles");
});

test("a foreign LIVE lock owner → immediate inference_busy/splash; no refresh, no scan, no run; the foreign lock is untouched", async (t) => {
  const FOREIGN = 999_001;
  const h = await makeHarness(t, {
    liveness: (pid) => (pid === FOREIGN ? "alive" : "unknown"),
  });
  await plantForeignLock(h, FOREIGN, "foreign-token", "other-session");

  const result = await h.coordinator.dispatch(request("A"));

  // Halka açık busy metadata'sı BİREBİR {status, conflict}'tir —
  // PID, komut, yol, içerik ASLA taşınmaz.
  assert.deepEqual(result, { status: "inference_busy", conflict: "splash" });
  assert.equal(h.backend.refreshCalls, 0, "no runtime refresh behind a foreign lock");
  assert.equal(h.backend.runStartOrder.length, 0, "the backend must never be called");
  assert.equal(h.scannerCounts.count, 0, "no host scan behind a foreign lock");
  const raw = await readFile(
    path.join(h.runtimeDir, INFERENCE_LOCK_DIR, OWNER_FILE_NAME),
    "utf8",
  );
  assert.ok(raw.includes("foreign-token"), "the foreign lock must survive");
});

test("an UNVERIFIABLE lock owner (liveness unknown) → inference_busy/unknown (fail closed); no backend", async (t) => {
  const MYSTERY = 999_002;
  const h = await makeHarness(t, {
    liveness: (pid) => (pid === MYSTERY ? "unknown" : "alive"),
  });
  await plantForeignLock(h, MYSTERY, "unverified-token", "mystery-session");

  const result = await h.coordinator.dispatch(request("A"));

  assert.deepEqual(result, { status: "inference_busy", conflict: "unknown" });
  assert.equal(h.backend.refreshCalls, 0);
  assert.equal(h.backend.runStartOrder.length, 0);
  const raw = await readFile(
    path.join(h.runtimeDir, INFERENCE_LOCK_DIR, OWNER_FILE_NAME),
    "utf8",
  );
  assert.ok(raw.includes("unverified-token"), "an uncertain lock must survive");
});

test("a stale lock (dead owner) is reclaimed: dispatch proceeds, the old record is replaced, the lock is released after", async (t) => {
  const DEAD = 999_003;
  const h = await makeHarness(t, {
    liveness: (pid) => (pid === DEAD ? "dead" : "alive"),
  });
  await plantForeignLock(h, DEAD, "stale-token", "crashed-session");

  const p = h.coordinator.dispatch(request("A"));
  // İş aktifken (kilit henüz bırakılmadan) oku — deterministik an.
  await waitFor(
    async () =>
      h.backend.runStartOrder.length === 1 && (await lockDirExists(h.runtimeDir)),
    "the run to start under the re-acquired lock",
  );
  const raw = await readFile(
    path.join(h.runtimeDir, INFERENCE_LOCK_DIR, OWNER_FILE_NAME),
    "utf8",
  );
  assert.ok(!raw.includes("stale-token"), "the stale record is replaced during the run");
  assert.ok(raw.includes(String(process.pid)), "the re-acquired lock is ours");

  h.backend.releaseRun("A");
  const result = await p;
  assert.equal(result.status, "completed");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false, "released after the run");
});

// ── release hatası asla yutulmaz (öncelik A-D) ───────────────────────────

test("successful inference + failed release → dispatch rejects with lock_release_failed (never a false 'completed')", async (t) => {
  const lock = new FakeLock();
  lock.failReleases = 1;
  const h = await makeHarness(t, { lock });

  const p = h.coordinator.dispatch(request("A"));
  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");
  h.backend.releaseRun("A");

  const caught = await p.then(
    () => {
      throw new Error(
        "dispatch must REJECT — a failed release is never a false 'completed'",
      );
    },
    (err: unknown) => err,
  );
  assert.ok(
    caught instanceof CoordinatorError,
    `expected a CoordinatorError, got: ${String(caught)}`,
  );
  assert.equal((caught as CoordinatorError).kind, "lock_release_failed");
  // Mesaj KISA ve güvenlidir: token, yol, istek içeriği YOK.
  const msg = (caught as CoordinatorError).message;
  assert.ok(!msg.includes("tok-"), "no lock token in the message");
  assert.ok(!msg.includes(h.runtimeDir), "no runtime path in the message");
  assert.equal(lock.releaseCalls.length, 1, "release was attempted");
  // `cause`'ta kilit katmanının kendi tip'li hatası (güvenli mesaj).
  assert.equal((caught as CoordinatorError).cause, lock.lastReleaseError);

  await waitForIdle(h);
  assert.equal(h.coordinator.activeOwnerId, null);
  assert.equal(h.coordinator.queueDepth, 0);
});

test("failed inference + successful release → the original BackendError propagates verbatim (release-ok path unchanged)", async (t) => {
  const h = await makeHarness(t, { lock: new FakeLock() });
  h.backend.failingOwner = "A";
  const pa = h.coordinator.dispatch(request("A"));
  const pb = h.coordinator.dispatch(request("B"));

  let caught: unknown = null;
  await pa.then(
    () => {
      throw new Error("A was supposed to fail");
    },
    (err: unknown) => {
      caught = err;
    },
  );
  assert.ok(
    caught instanceof BackendError,
    `expected the original BackendError, got: ${String(caught)}`,
  );
  assert.equal((caught as BackendError).kind, "http");
  assert.equal((caught as BackendError).status, 500);

  // Kuyruk zehirlenmedi: B normal devam etti ve tamamladı.
  const rb = await runToCompletion(h, pb, "B");
  assert.equal(rb.status, "completed");
  await waitForIdle(h);
});

test("failed inference + failed release → lock_release_failed surfaces; the original error is only in cause", async (t) => {
  const lock = new FakeLock();
  lock.failReleases = 1;
  const h = await makeHarness(t, { lock });
  h.backend.failingOwner = "A";

  const pa = h.coordinator.dispatch(request("A"));

  const caught = await pa.then(
    () => {
      throw new Error("A was supposed to fail");
    },
    (err: unknown) => err,
  );
  assert.ok(
    caught instanceof CoordinatorError,
    `expected a CoordinatorError, got: ${String(caught)}`,
  );
  assert.equal((caught as CoordinatorError).kind, "lock_release_failed");
  // Orijinal inference hatası YALNIZ `cause`'ta (tek red — çift hata yok).
  assert.ok(
    (caught as CoordinatorError).cause instanceof BackendError,
    "the original inference error is preserved in cause",
  );
  assert.equal(((caught as CoordinatorError).cause as BackendError).kind, "http");

  await waitForIdle(h);
});

test("host conflict (mlx) + failed release → the cleanup error surfaces instead of a clean inference_busy/mlx", async (t) => {
  const lock = new FakeLock();
  lock.failReleases = 1;
  const h = await makeHarness(t, {
    scanner: () =>
      Promise.resolve([
        ...CONFIGURED_TREE,
        { pid: 700, ppid: 1, command: "python3 -m mlx_lm.server --port 8080" },
      ]),
    lock,
  });

  const p = h.coordinator.dispatch(request("A"));

  const caught = await p.then(
    () => {
      throw new Error("a failed release must surface — no clean inference_busy");
    },
    (err: unknown) => err,
  );
  assert.ok(
    caught instanceof CoordinatorError,
    `expected a CoordinatorError, got: ${String(caught)}`,
  );
  assert.equal((caught as CoordinatorError).kind, "lock_release_failed");
  assert.equal(h.backend.runStartOrder.length, 0, "no generation under a host conflict");
  assert.equal(h.scannerCounts.count, 1, "the scan ran");
  assert.equal(lock.releaseCalls.length, 1, "release was attempted after the conflict decision");

  await waitForIdle(h);
});

test("aborted active inference + failed release → the cleanup error surfaces (typed)", async (t) => {
  const lock = new FakeLock();
  lock.failReleases = 1;
  const h = await makeHarness(t, { lock });
  const controller = new AbortController();
  const pa = h.coordinator.dispatch(request("A", { signal: controller.signal }));
  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");

  controller.abort();

  const caught = await pa.then(
    () => {
      throw new Error("a failed release must surface — not reported as success");
    },
    (err: unknown) => err,
  );
  assert.ok(
    caught instanceof CoordinatorError,
    `expected a CoordinatorError, got: ${String(caught)}`,
  );
  assert.equal((caught as CoordinatorError).kind, "lock_release_failed");
  // Orijinal iptal hatası (tip'li BackendError) `cause`'ta korunur.
  assert.ok(
    (caught as CoordinatorError).cause instanceof BackendError,
    "the original abort error is preserved in cause",
  );
  assert.equal(((caught as CoordinatorError).cause as BackendError).kind, "network");

  await waitForIdle(h);
});

test("a release failure does not poison the FIFO: the next job acquires fresh and completes normally", async (t) => {
  const lock = new FakeLock();
  lock.failReleases = 1; // yalnız ilk `release` çağrısı başarısız
  const h = await makeHarness(t, { lock });

  const pa = h.coordinator.dispatch(request("A"));
  const pb = h.coordinator.dispatch(request("B"));

  await waitFor(() => h.backend.runStartOrder.length === 1, "A to start");
  h.backend.releaseRun("A");

  // A tip'li cleanup hatasıyla reddedilir…
  const caught = await pa.then(
    () => {
      throw new Error("A must reject");
    },
    (err: unknown) => err,
  );
  assert.ok(
    caught instanceof CoordinatorError && (caught as CoordinatorError).kind === "lock_release_failed",
    `expected lock_release_failed, got: ${String(caught)}`,
  );

  // …ve kuyruk devam eder: B kendi acquire'ını yapar, normal tamamlanır.
  const rb = await runToCompletion(h, pb, "B");
  assert.deepEqual(h.backend.runStartOrder, ["A", "B"], "strict FIFO after the failure");
  assert.equal(rb.status, "completed");
  assert.equal(lock.acquireCalls, 2, "the next job acquires the lock fresh");
  assert.equal(lock.releaseCalls.length, 2, "both jobs attempted release");

  await waitForIdle(h);
  assert.equal(h.coordinator.activeOwnerId, null);
  assert.equal(h.coordinator.queueDepth, 0);
});

// ── dispatch sırası (madde 19/20/30) ────────────────────────────────────

test("no usable runtime identity (instance.pid missing) → inference_busy/unknown; run never called; lock released", async (t) => {
  const h = await makeHarness(t);
  // Kimliksız (bozuk /status.instance) runtime bilgisi.
  h.backend.setInfo({ ready: true, maximumContextTokens: 1000, servedModel: "test/model" });

  const result = await h.coordinator.dispatch(request("A"));

  assert.deepEqual(result, { status: "inference_busy", conflict: "unknown" });
  assert.equal(h.backend.refreshCalls, 1, "the refresh happened (step 4)");
  assert.equal(h.backend.runStartOrder.length, 0, "generation must not run without identity");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false, "the lock must be released");
});

test("a refresh failure propagates as the typed BackendError (never inference_busy); the queue continues; no lock left", async (t) => {
  const h = await makeHarness(t);
  h.backend.refreshFailure = new BackendError(
    "network",
    "Could not reach the inference runtime (/status)",
  );
  const pa = h.coordinator.dispatch(request("A"));
  const pb = h.coordinator.dispatch(request("B"));

  let caught: unknown = null;
  await pa.then(
    () => {
      throw new Error("A was supposed to fail");
    },
    (err: unknown) => {
      caught = err;
    },
  );
  assert.ok(caught instanceof BackendError, `expected a BackendError, got: ${String(caught)}`);
  assert.equal((caught as BackendError).kind, "network");
  // backend sorunu inference_busy'a çevrilmez — tip'li hata yayılır.
  h.backend.refreshFailure = null; // runtime geri geldi.

  const rb = await runToCompletion(h, pb, "B");
  assert.equal(rb.status, "completed");
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false);
  assert.equal(h.coordinator.activeOwnerId, null);
});

test("an external MLX runtime at dispatch → inference_busy/mlx; refresh ran, run never did; lock released", async (t) => {
  const h = await makeHarness(t, {
    scanner: () =>
      Promise.resolve([
        ...CONFIGURED_TREE,
        { pid: 700, ppid: 1, command: "python3 -m mlx_lm.server --port 8080" },
      ]),
  });

  const result = await h.coordinator.dispatch(request("A"));

  assert.deepEqual(result, { status: "inference_busy", conflict: "mlx" });
  assert.equal(h.backend.refreshCalls, 1, "the refresh precedes the scan");
  assert.equal(h.backend.runStartOrder.length, 0, "no generation under a host conflict");
  assert.equal(h.scannerCounts.count, 1);
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false, "the lock is released even on conflict");
});

test("a failing scanner → inference_busy/unknown (fail closed); no run; lock released", async (t) => {
  const h = await makeHarness(t, {
    scanner: () => Promise.reject(new Error("ps unavailable")),
  });

  const result = await h.coordinator.dispatch(request("A"));

  assert.deepEqual(result, { status: "inference_busy", conflict: "unknown" });
  assert.equal(h.backend.refreshCalls, 1);
  assert.equal(h.backend.runStartOrder.length, 0);
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false);
});

test("integration: the conflict check runs on EVERY dispatch — a clean host then an Ollama host (no cached 'clear')", async (t) => {
  let scans = 0;
  const h = await makeHarness(t, {
    scanner: () => {
      scans += 1;
      const table = [...CONFIGURED_TREE];
      if (scans >= 2) {
        table.push({ pid: 800, ppid: 1, command: "ollama serve" });
      }
      return Promise.resolve(table);
    },
  });

  const r1 = await runToCompletion(h, h.coordinator.dispatch(request("A")), "A");
  assert.equal(r1.status, "completed", "first dispatch: clean host → generation");

  const r2 = await h.coordinator.dispatch(request("B"));
  assert.deepEqual(r2, { status: "inference_busy", conflict: "ollama" });
  assert.equal(scans, 2, "a FRESH scan per dispatch — no caching across generations");
  assert.deepEqual(h.backend.runStartOrder, ["A"], "the second generation must not run");
  assert.equal(h.scannerCounts.count, 2);
  await waitForIdle(h);
  assert.equal(await lockDirExists(h.runtimeDir), false);
});

// ── istek sözleşmesi ─────────────────────────────────────────────────────

test("dispatch: an empty ownerId rejects with a typed CoordinatorError and is never queued", async (t) => {
  const h = await makeHarness(t);
  await assert.rejects(
    h.coordinator.dispatch({ ownerId: "", messages: [{ role: "user", content: "x" }] }),
    (err: unknown) => err instanceof CoordinatorError && err.kind === "invalid_request",
  );
  assert.equal(h.coordinator.queueDepth, 0);
  assert.equal(await lockDirExists(h.runtimeDir), false);
});
