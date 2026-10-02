/**
 * Step 9: kalıcı oturum deposu — unit test (spec 337).
 *
 * İki seviye (mimari: store yalnız `SessionStoreFs` dikişinden I/O yapar):
 *
 * 1. **Gerçek dosya sistemi** (`node:fs/promises` default adapter): atomik
 *    roundtrip + izin (0600/0700) + bozuk/tamper senaryoları — `session.json`
 *    gerçekten diske yazılır, `FileHandle.sync()` + `rename` + dizin fsync'i
 *    gerçekten yürür.
 * 2. **Bellek-içi sahte fs** (`SessionStoreFs`): deterministik arıza enjeksiyonu
 *    (yazım hatası, geçici-dosya davranışı, sürüm/id/yol/kimlik tamperi, çakışma)
 *    — gerçek I/O olmadan her fail-closed yol deterministik.
 *
 * Bozukluk (spec 16): bozuk JSON / eksik alan / geçersiz tip / bilinmeyen sürüm /
 * güvensiz yol / id-uyumsuzluğu / kimlik-uyumsuzluğu / geçersiz kural provenance /
 * geçersiz worker sonucu → `session_corrupt` (best-effort yeniden yapı YOK).
 * No-log (spec 17): içerik loglanmaz; hatalar sabit güvenli mesaj + kısa neden etiketi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat as realStat, writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionStore } from "../dist/session/SessionStore.js";
import { SessionError, type PersistedSession, type SessionStoreFs } from "../dist/session/types.js";
import { computeRepoId } from "../dist/workspace/git.js";
import type { WorkspaceRecoveryState } from "../dist/workspace/Workspace.js";
import type { CompactResult, WorkerResult } from "../dist/worker/result.js";

// ── Yardımcılar ──────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const REPO_ROOT = "/tmp/splash-repo";

function err(code: string, msg?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(msg ?? `${code} (fault-injected)`), { code });
}

/** Tutarlı bir `applied` tur sonucu (tur `round`; kimlik oturum kimliğidir). */
function makeResult(round: number, summary: string): CompactResult {
  return {
    sessionId: SESSION_ID,
    round,
    status: "applied",
    baseStatus: "fresh",
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 128_000,
      inputTokens: 100,
      outputReserveTokens: 32_768,
      selectedContextTier: "64k",
      truncatedReadonlyContext: false,
    },
    summary,
    filesChanged: ["src/a.ts"],
    diffStats: { files: 1, insertions: 1, deletions: 1 },
    validation: { editsRequested: 1, editsApplied: 1, rejected: [] },
    warnings: [],
    usage: { in: 10, out: 20 },
  };
}

/**
 * Geçerli bir kalıcı oturum — bozukluk testleri bu baz üzerine tamper eder.
 * Tur tutarlılığı (spec 371-375): `round` = tamamlanmış tur sayısı = 1;
 * `rounds` 1..N sıkı dizilim; `round > 0` → `latestWorkerResult` +
 * `latestResult` zorunlu (kurtarma yeniden-uygulaması için).
 */
function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  const workerResult = { schemaVersion: 1, summary: "done", edits: [] } as WorkerResult;
  const result = makeResult(1, "done");
  const base: PersistedSession = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    repoRoot: REPO_ROOT,
    repoId: computeRepoId(REPO_ROOT),
    task: "do the thing",
    rules: { source: "none", documents: [] },
    options: {},
    editablePaths: ["src/a.ts"],
    readonlyPaths: [],
    workspaceRecovery: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      baseCommit: "c".repeat(40),
    } as unknown as WorkspaceRecoveryState,
    round: 1,
    maxRoundsAcknowledged: false,
    rounds: [
      {
        round: 1,
        workerResult,
        validation: { editsRequested: 1, editsApplied: 1, rejected: [] },
        result,
      },
    ],
    currentCreatedPaths: [],
    latestWorkerResult: workerResult,
    latestResult: result,
  };
  return { ...base, ...overrides };
}

/** Bellek-içi `SessionStoreFs` — her I/O operasyonunu deterministik modeler. */
class MemFs implements SessionStoreFs {
  files = new Map<string, { mode: number; content: string }>();
  dirs = new Set<string>();
  dirModes = new Map<string, number>();
  failOpenWrite = false;
  readFileCode: string | undefined;

  async mkdir(dir: string, mode: number, recursive: boolean): Promise<void> {
    if (this.dirs.has(dir)) {
      if (recursive) return;
      throw err("EEXIST", `mkdir ${dir}`);
    }
    if (recursive) {
      let cur = dir;
      for (;;) {
        if (this.dirs.has(cur)) break;
        this.dirs.add(cur);
        this.dirModes.set(cur, 0o700);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      this.dirModes.set(dir, mode);
      return;
    }
    // Exclusive (recursive=false): tüm atal VAR olmali, yaprak YOK.
    let cur = path.dirname(dir);
    for (;;) {
      if (!this.dirs.has(cur)) throw err("ENOENT", `mkdir ${dir}`);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    this.dirs.add(dir);
    this.dirModes.set(dir, mode);
  }

  async chmod(dir: string, mode: number): Promise<void> {
    if (!this.dirs.has(dir)) throw err("ENOENT", `chmod ${dir}`);
    this.dirModes.set(dir, mode);
  }

  async readFile(file: string): Promise<string> {
    const entry = this.files.get(file);
    if (!entry) throw err(this.readFileCode ?? "ENOENT", `readFile ${file}`);
    return entry.content;
  }

  async openWrite(file: string, mode: number) {
    if (this.failOpenWrite) throw err("EACCES", `openWrite ${file}`);
    const entry = { mode, content: "" };
    this.files.set(file, entry);
    return {
      writeFile: (data: string) => {
        entry.content = data;
        return Promise.resolve();
      },
      sync: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  }

  async rename(from: string, to: string): Promise<void> {
    const entry = this.files.get(from);
    if (!entry) throw err("ENOENT", `rename ${from}`);
    this.files.set(to, entry);
    this.files.delete(from);
  }

  async removeFile(file: string): Promise<void> {
    this.files.delete(file);
  }

  async stat(p: string) {
    const file = this.files.get(p);
    if (file) return { isFile: () => true, isDirectory: () => false, mode: file.mode };
    if (this.dirs.has(p)) {
      return { isFile: () => false, isDirectory: () => true, mode: this.dirModes.get(p) ?? 0o700 };
    }
    throw err("ENOENT", `stat ${p}`);
  }

  async openDir(dir: string) {
    if (!this.dirs.has(dir)) throw err("ENOENT", `openDir ${dir}`);
    return { sync: () => Promise.resolve(), close: () => Promise.resolve() };
  }
}

/** Sahte fs + store; testler `fs` üzerinden içeriği denetler/enjekte eder. */
function storeWith(mem: MemFs, outputRoot = "/tmp/splash-out") {
  return new SessionStore(outputRoot, { fs: mem });
}

/** Gerçek dosya sistemi ile geçici outputRoot; `fn` içinde kullanılır. */
async function withRealStore<T>(fn: (store: SessionStore, outputRoot: string) => Promise<T>): Promise<T> {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "splash-store-"));
  const store = new SessionStore(outputRoot);
  try {
    return await fn(store, outputRoot);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

/** Bir oturum dosyasını (ham JSON) doğrudan disk'e yazar — tamper testleri. */
async function writeRawSessionFile(store: SessionStore, outputRoot: string, obj: unknown): Promise<void> {
  const dir = path.join(outputRoot, "sessions", SESSION_ID);
  await realWriteFile(path.join(dir, "session.json"), JSON.stringify(obj, null, 2));
}

// ── Atomik roundtrip (spec 14/15, 337) ──────────────────────────────────────

test("roundtrip: save then load returns the identical persisted session (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession({
      latestWorkerResult: { schemaVersion: 1, summary: "done", edits: [] } as WorkerResult,
      latestWorkspaceStateHash: "deadbeef".repeat(8),
    });
    await store.save(session);
    const loaded = await store.load(SESSION_ID);
    assert.deepEqual(loaded, session);
    // Atomik yazım: yetkili dosya var, geçici iz KALMADI (spec 15).
    const file = path.join(outputRoot, "sessions", SESSION_ID, "session.json");
    const tmp = path.join(outputRoot, "sessions", SESSION_ID, "session.json.tmp");
    assert.equal((await realStat(file)).isFile(), true);
    await assert.rejects(realStat(tmp), { code: "ENOENT" });
  });
});

// ── İzin (spec 7, 337) ───────────────────────────────────────────────────────

test("permissions: session.json is 0600, session + sessions dirs are 0700 (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.save(makeSession());
    const sessionsDir = path.join(outputRoot, "sessions");
    const sessionDir = path.join(sessionsDir, SESSION_ID);
    const file = path.join(sessionDir, "session.json");
    assert.equal((await realStat(file)).mode & 0o777, 0o600);
    assert.equal((await realStat(sessionDir)).mode & 0o777, 0o700);
    assert.equal((await realStat(sessionsDir)).mode & 0o777, 0o700);
  });
});

// ── Bozuk JSON (spec 16, 337) ────────────────────────────────────────────────

test("corrupt: malformed JSON fails closed with session_corrupt (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    await realWriteFile(
      path.join(outputRoot, "sessions", SESSION_ID, "session.json"),
      "{ not valid json",
    );
    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  });
});

// ── Geçici dosya davranışı (spec 15, 337) ────────────────────────────────────

test("temp file: a leftover session.json.tmp is NOT authoritative (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  const good = makeSession();
  const goodContent = JSON.stringify(good, null, 2);
  // Yetkili dosya doğru; geçici dosya FARKLI (crash'ten kalıntı) içerik.
  mem.files.set(path.join(dir, "session.json"), { mode: 0o600, content: goodContent });
  mem.files.set(path.join(dir, "session.json.tmp"), {
    mode: 0o600,
    content: JSON.stringify(makeSession({ task: "tampered tmp" }), null, 2),
  });
  const loaded = await store.load(SESSION_ID);
  assert.equal(loaded.task, good.task); // tmp içeriği YOK — yetkili dosya okundu
  assert.notEqual(loaded.task, "tampered tmp");
});

// ── Sürüm uyuşmazlığı (spec 9/16, 337) ───────────────────────────────────────

test("version mismatch: unknown schema_version fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify({ ...makeSession(), schemaVersion: 2 }, null, 2),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

// ── id uyuşmazlığı (spec 16/209, 337) ────────────────────────────────────────

test("id mismatch: persisted sessionId != requested fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify({ ...makeSession(), sessionId: "other-id", workspaceRecovery: {
      schemaVersion: 1, sessionId: "other-id", baseCommit: "c".repeat(40),
    } as unknown as WorkspaceRecoveryState }, null, 2),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

// ── Yol tamperi (spec 11/16, 337) ───────────────────────────────────────────

test("path tampering: unsafe persisted path fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify({ ...makeSession(), editablePaths: ["../evil.ts"] }, null, 2),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

// ── Kimlik uyuşmazlığı (spec 16/208, 337) ────────────────────────────────────

test("repo identity mismatch: tampered repoId fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify({ ...makeSession(), repoId: "tampered-id" }, null, 2),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

// ── Geçersiz kural provenance + worker sonucu (spec 16, 337) ────────────────

test("invalid rules provenance fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify({ ...makeSession(), rules: { source: "impossible", documents: [] } }, null, 2),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

test("invalid worker result (bad schema_version) fails closed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "session.json"), {
    mode: 0o600,
    content: JSON.stringify(
      { ...makeSession(), latestWorkerResult: { schemaVersion: 2, summary: "x", edits: [] } },
      null,
      2,
    ),
  });
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
});

// ── Yazım hatası (spec 337) ──────────────────────────────────────────────────

test("write failure: save reds with session_persistence_failed, no partial session.json (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  mem.failOpenWrite = true;
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  await assert.rejects(store.save(makeSession()), (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed");
  // Yetkili dosya YOK; geçici iz temizlendi.
  assert.equal(mem.files.has(path.join(dir, "session.json")), false);
  assert.equal(mem.files.has(path.join(dir, "session.json.tmp")), false);
});

// ── Bulunamayan oturum (spec 337) ────────────────────────────────────────────

test("not found: loading an absent session reds with session_not_found (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_not_found");
});

test("unsafe id: a traversal id is rejected safely, never resolved (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await assert.rejects(store.load("../escape"), (e: unknown) => e instanceof SessionError && e.kind === "session_not_found");
  await assert.rejects(store.create("../escape"), (e: unknown) => e instanceof SessionError && e.kind === "session_not_found");
});

// ── Oluşturma çakışması (spec 324-327, 337) ──────────────────────────────────

test("create collision: a preexisting session dir reds with session_conflict, not overwritten (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  await store.save(makeSession());
  // İkinci create: mevcut dizin → EEXIST → session_conflict; mevcut içerik korunur.
  const before = mem.files.get(path.join("/tmp/splash-out", "sessions", SESSION_ID, "session.json"))?.content;
  await assert.rejects(store.create(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_conflict");
  assert.equal(mem.files.get(path.join("/tmp/splash-out", "sessions", SESSION_ID, "session.json"))?.content, before);
});

// ── İsteğe bağlı son-durum alanlarının roundtripti + tamperi ─────────────────

test("roundtrip preserves optional latestResult/latestWorkerResult (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const session = makeSession({
    latestWorkerResult: { schemaVersion: 1, summary: "done", edits: [] } as WorkerResult,
    latestWorkspaceStateHash: "cafebabe".repeat(8),
  });
    await store.save(session);
    const loaded = await store.load(SESSION_ID);
    assert.equal(loaded.latestWorkerResult?.summary, "done");
    assert.equal(loaded.latestWorkspaceStateHash, "cafebabe".repeat(8));
});

test("corrupt: round/result round mismatch fails closed (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    const persistedRound = session.rounds[0];
    if (persistedRound === undefined) {
      throw new Error("test fixture");
    }
    persistedRound.result.round = 99;
    await writeRawSessionFile(store, outputRoot, session);
    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  });
});

test("corrupt: invalid workspace state hash format fails closed (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    session.latestWorkspaceStateHash = "deadbeef";
    await writeRawSessionFile(store, outputRoot, session);
    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  });
});

// ── save ön koşulları ────────────────────────────────────────────────────────

test("save: unsupported schema version reds with session_operation_failed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await assert.rejects(
    store.save({ ...makeSession(), schemaVersion: 2 } as unknown as PersistedSession),
    (e: unknown) => e instanceof SessionError && e.kind === "session_operation_failed",
  );
});

test("save: unsafe session id reds with session_operation_failed (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await assert.rejects(
    store.save({ ...makeSession(), sessionId: "../escape" } as PersistedSession),
    (e: unknown) => e instanceof SessionError && e.kind === "session_operation_failed",
  );
});
