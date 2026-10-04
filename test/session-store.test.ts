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
import {
  mkdir as realMkdir,
  mkdtemp,
  readFile as realReadFile,
  rm,
  stat as realStat,
  symlink as realSymlink,
  writeFile as realWriteFile,
} from "node:fs/promises";
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

/** Geçerli, derinlik doğrulamasından geçen bir kurtarma durumu. */
function makeWorkspaceRecovery(overrides: Partial<WorkspaceRecoveryState> = {}): WorkspaceRecoveryState {
  const base = {
    schemaVersion: 1,
    repoRoot: REPO_ROOT,
    workspaceDir: "/tmp/splash-workspace",
    sessionId: SESSION_ID,
    baseCommit: "c".repeat(40),
    editablePaths: ["src/a.ts"],
    readonlyPaths: [],
    baseFingerprints: [
      ["src/a.ts", { exists: true, type: "file", mode: "100644", contentSha256: "d".repeat(64) }],
    ],
    basePaths: [["src/a.ts", "100644"]],
    immutableBaseEntries: [
      {
        mode: "040000",
        oid: "e".repeat(40),
        path: "src",
        children: [{ mode: "100644", oid: "f".repeat(40), path: "a.ts" }],
      },
    ],
    baseCommitIdentity: {
      tree: "e".repeat(40),
      parents: [],
      authorName: "Test",
      authorEmail: "test@example.com",
      authorDate: "0 +0000",
      committerName: "Test",
      committerEmail: "test@example.com",
      committerDate: "0 +0000",
      message: "base",
    },
    baseContents: [["src/a.ts", { type: "file", base64: "aGk=" }]],
    currentCreatedPaths: [],
    recoveryStateHash: "a".repeat(64),
  } as WorkspaceRecoveryState;
  return { ...base, ...overrides };
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
    workspaceRecovery: makeWorkspaceRecovery(),
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

/** Bellek-içi `SessionStoreFs` — no-follow I/O'yu deterministik modeler. */
class MemFs implements SessionStoreFs {
  files = new Map<string, { mode: number; content: string }>();
  dirs = new Set<string>();
  dirModes = new Map<string, number>();
  symlinks = new Map<string, string>();
  failOpenWrite = false;
  failOpenReadNoFollow = false;
  readFileCode: string | undefined;

  async mkdir(dir: string, mode: number, recursive: boolean): Promise<void> {
    if (this.symlinks.has(dir)) throw err("EEXIST", `mkdir ${dir}`);
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

  async lstat(p: string) {
    if (this.symlinks.has(p)) {
      return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, mode: 0o777 };
    }
    const file = this.files.get(p);
    if (file) return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: file.mode };
    if (this.dirs.has(p)) {
      return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: this.dirModes.get(p) ?? 0o700 };
    }
    throw err("ENOENT", `lstat ${p}`);
  }

  async openReadNoFollow(file: string) {
    if (this.failOpenReadNoFollow) throw err("EACCES", `openReadNoFollow ${file}`);
    if (this.symlinks.has(file)) throw err("ELOOP", `openReadNoFollow ${file}`);
    const entry = this.files.get(file);
    if (!entry) throw err(this.readFileCode ?? "ENOENT", `openReadNoFollow ${file}`);
    return {
      stat: () =>
        Promise.resolve({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: entry.mode }),
      readFile: () => Promise.resolve(entry.content),
      close: () => Promise.resolve(),
    };
  }

  async openWrite(file: string, mode: number) {
    if (this.failOpenWrite) throw err("EACCES", `openWrite ${file}`);
    if (this.symlinks.has(file)) throw err("ELOOP", `openWrite ${file}`);
    if (this.files.has(file) || this.dirs.has(file)) throw err("EEXIST", `openWrite ${file}`);
    const entry = { mode, content: "" };
    this.files.set(file, entry);
    return {
      chmod: (nextMode: number) => {
        entry.mode = nextMode;
        return Promise.resolve();
      },
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
    this.symlinks.delete(to);
  }

  async removeFile(file: string): Promise<void> {
    if (this.symlinks.has(file)) {
      this.symlinks.delete(file);
      return;
    }
    if (this.dirs.has(file)) throw err("EISDIR", `removeFile ${file}`);
    this.files.delete(file);
  }

  async openDir(dir: string) {
    if (this.symlinks.has(dir)) throw err("ELOOP", `openDir ${dir}`);
    if (!this.dirs.has(dir)) throw err("ENOENT", `openDir ${dir}`);
    return {
      chmod: (mode: number) => {
        this.dirModes.set(dir, mode);
        return Promise.resolve();
      },
      sync: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
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
    content: JSON.stringify({ ...makeSession(), sessionId: "other-id", workspaceRecovery: makeWorkspaceRecovery({ sessionId: "other-id" }) }, null, 2),
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

// ── No-follow / symlink (spec 15-16, 337) ───────────────────────────────────

test("no-follow: symlink session.json is rejected on load, target untouched (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const external = path.join(outputRoot, "external-session.txt");
    const marker = "VERY_SECRET_SESSION_FILE_MARKER_7F3C\n";
    await realWriteFile(external, marker);
    const file = path.join(outputRoot, "sessions", SESSION_ID, "session.json");
    await realSymlink(external, file);

    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
    assert.equal(await realReadFile(external, "utf8"), marker);
  });
});

test("no-follow: symlink session.json.tmp is rejected on save, target untouched (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const external = path.join(outputRoot, "external-tmp.txt");
    const marker = "VERY_SECRET_SESSION_TMP_MARKER_8A4D\n";
    await realWriteFile(external, marker);
    const tmp = path.join(outputRoot, "sessions", SESSION_ID, "session.json.tmp");
    await realSymlink(external, tmp);

    await assert.rejects(store.save(makeSession()), (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed");
    assert.equal(await realReadFile(external, "utf8"), marker);
    await assert.rejects(realStat(path.join(outputRoot, "sessions", SESSION_ID, "session.json")), { code: "ENOENT" });
  });
});

test("no-follow: symlink session directory is rejected for load/save (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    const externalDir = path.join(outputRoot, "external-session-dir");
    await realMkdir(externalDir, { recursive: true });
    await realWriteFile(path.join(externalDir, "sentinel.txt"), "do-not-touch\n");
    await realMkdir(path.join(outputRoot, "sessions"), { recursive: true });
    const sessionDir = path.join(outputRoot, "sessions", SESSION_ID);
    await realSymlink(externalDir, sessionDir);

    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
    await assert.rejects(store.save(makeSession()), (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed");
    assert.equal(await realReadFile(path.join(externalDir, "sentinel.txt"), "utf8"), "do-not-touch\n");
  });
});

test("no-follow: symlink session.json is rejected on load (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  await store.create(SESSION_ID);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.files.set(path.join(dir, "external.txt"), { mode: 0o600, content: "external" });
  mem.symlinks.set(path.join(dir, "session.json"), path.join(dir, "external.txt"));
  await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  assert.equal(mem.files.get(path.join(dir, "external.txt"))?.content, "external");
});

test("no-follow: symlink session directory is rejected on save (fake fs)", async () => {
  const mem = new MemFs();
  const store = storeWith(mem);
  const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
  mem.dirs.add(path.join("/tmp/splash-out", "external-dir"));
  mem.symlinks.set(dir, path.join("/tmp/splash-out", "external-dir"));
  await assert.rejects(store.save(makeSession()), (e: unknown) => e instanceof SessionError && e.kind === "session_persistence_failed");
  assert.equal(mem.dirs.has(path.join("/tmp/splash-out", "external-dir")), true);
});

// ── Derin kalıcı şema doğrulaması (spec 16, 337) ────────────────────────────

test("deep validation: unsupported worker edit kind fails closed without content leak (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    const marker = "VERY_SECRET_PERSISTED_MARKER_9F3C";
    const tampered = {
      schemaVersion: 1,
      summary: marker,
      edits: [{ kind: "shell", path: "src/a.ts", command: "id" }],
    };
    session.latestWorkerResult = tampered as unknown as WorkerResult;
    const round = session.rounds[0];
    if (round === undefined) {
      throw new Error("test fixture");
    }
    round.workerResult = tampered as unknown as WorkerResult;
    await writeRawSessionFile(store, outputRoot, session);

    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => {
        assert.ok(e instanceof SessionError);
        assert.equal(e.kind, "session_corrupt");
        assert.ok(!e.message.includes(marker));
        return true;
      },
    );
  });
});

test("deep validation: malformed compact result usage fails closed without content leak (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    const marker = "VERY_SECRET_RESULT_MARKER_1C2E";
    session.latestResult = { ...session.latestResult!, summary: marker, usage: { in: -1, out: 20 } } as CompactResult;
    await writeRawSessionFile(store, outputRoot, session);

    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => {
        assert.ok(e instanceof SessionError);
        assert.equal(e.kind, "session_corrupt");
        assert.ok(!e.message.includes(marker));
        return true;
      },
    );
  });
});

test("deep validation: workspace recovery missing nested identity fails closed (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    session.workspaceRecovery = {
      ...session.workspaceRecovery,
      baseCommitIdentity: {
        tree: "e".repeat(40),
        parents: [],
        authorName: "Test",
        authorEmail: "test@example.com",
        authorDate: "0 +0000",
        committerName: "Test",
        committerEmail: "test@example.com",
        committerDate: "0 +0000",
      },
    } as unknown as WorkspaceRecoveryState;
    await writeRawSessionFile(store, outputRoot, session);
    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  });
});

test("deep validation: workspace recovery malformed tree entry fails closed (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    session.workspaceRecovery = {
      ...session.workspaceRecovery,
      immutableBaseEntries: [{ mode: "040000", oid: "e".repeat(40), path: "src" }],
    } as unknown as WorkspaceRecoveryState;
    await writeRawSessionFile(store, outputRoot, session);
    await assert.rejects(store.load(SESSION_ID), (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt");
  });
});

// ── BaseCommitIdentity runtime-tip doğrulaması (spec 16, 337) ───────────────
//
// Kalıcı `baseCommitIdentity` typed state olmadan ÖNCE açık çalışma-zamanı
// tip denetiminden geçer: altı kimlik alanı string + boş-değil; `message`
// string (boş KABUL — Git commit sözleşmesi). String OLMAYAN kalıcı değer
// (123 / null / false / [] / {}) fail-closed `session_corrupt` ile
// yüklenemez; public mesaj SABİT güvenli metindir ve yerleştirilen kalıcı
// içeriği taşımaz. (Yalnız `=== ""` denetimi bu değerleri YAKALAYAMAZDI —
// `null === ""` false; tip denetimi KAST'tan önce zorunlu.)

const MALFORMED_IDENTITY_FIELDS = [
  { field: "authorName", value: 123 },
  { field: "authorEmail", value: null },
  { field: "authorDate", value: {} },
  { field: "committerName", value: [] },
  { field: "committerEmail", value: false },
  { field: "committerDate", value: 123 },
  { field: "message", value: 123 },
  { field: "message", value: null },
] as const;

test("deep validation: malformed baseCommitIdentity values fail closed without content leak (real fs)", async () => {
  for (const [index, { field, value }] of MALFORMED_IDENTITY_FIELDS.entries()) {
    await withRealStore(async (store, outputRoot) => {
      await store.create(SESSION_ID);
      const session = makeSession();
      const recovery = { ...session.workspaceRecovery } as Record<string, unknown>;
      const identity = { ...session.workspaceRecovery.baseCommitIdentity } as Record<string, unknown>;
      identity[field] = value;
      // Yerleştirilen kalıcı içerik — public mesajda ASLA görünmemeli.
      // Tamper edilen alan string ise marker oraya; değilse sağlam string
      // bir alana yerleştirilir (denetim tamper edilen alanda red eder).
      const marker = `VERY_SECRET_IDENTITY_MARKER_${index}`;
      if (field === "message") {
        identity.authorName = `Test ${marker}`;
      } else {
        identity.message = `base ${marker}`;
      }
      recovery.baseCommitIdentity = identity;
      session.workspaceRecovery = recovery as unknown as WorkspaceRecoveryState;
      await writeRawSessionFile(store, outputRoot, session);
      // Yerleştirilen içeriğin gerçekte disk'te doğrulanabilir olduğundan emin ol.
      const raw = await realReadFile(path.join(outputRoot, "sessions", SESSION_ID, "session.json"), "utf8");
      assert.ok(raw.includes(marker), "planted marker must be persisted");

      await assert.rejects(
        store.load(SESSION_ID),
        (e: unknown) => {
          assert.ok(e instanceof SessionError);
          assert.equal(e.kind, "session_corrupt");
          // SABİT güvenli mesaj — ne yol, ne alan, ne yerleştirilen içerik.
          assert.equal(e.message, "The session state is corrupt and cannot be recovered");
          assert.ok(!e.message.includes(marker));
          // `load` red ediyorsa bozuk değer typed state OLMADI (fail-closed).
          return true;
        },
      );
    });
  }
});

test("deep validation: valid baseCommitIdentity (incl. empty message) loads successfully (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession();
    const recovery = { ...session.workspaceRecovery } as Record<string, unknown>;
    // Boş `message` sözleşmeye uygun (Git commit/parser kabul eder) — yüklenir;
    // kimlik alanları birebir korunur.
    recovery.baseCommitIdentity = { ...session.workspaceRecovery.baseCommitIdentity, message: "" };
    session.workspaceRecovery = recovery as unknown as WorkspaceRecoveryState;
    await writeRawSessionFile(store, outputRoot, session);
    const loaded = await store.load(SESSION_ID);
    assert.deepEqual(loaded, session);
    assert.equal(loaded.workspaceRecovery.baseCommitIdentity.message, "");
    assert.equal(loaded.workspaceRecovery.baseCommitIdentity.authorName, "Test");
    assert.equal(loaded.workspaceRecovery.baseCommitIdentity.authorEmail, "test@example.com");
  });
});

// ── Repo-root tutarlılığı (audit F-2, spec 16, 337) ─────────────────────────

test("audit F-2: non-absolute session repo_root fails closed with a fixed safe message (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const marker = "VERY_SECRET_RELATIVE_REPO_ROOT_MARKER_2B7D";
    const session = makeSession({ repoRoot: marker });
    await writeRawSessionFile(store, outputRoot, session);

    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => {
        assert.ok(e instanceof SessionError);
        assert.equal(e.kind, "session_corrupt");
        assert.equal(e.message, "The session state is corrupt and cannot be recovered");
        // Yol/İÇERİK mesajda YOK — yalnız sabit güvenli metin.
        assert.ok(!e.message.includes(marker));
        return true;
      },
    );
  });
});

test("audit F-2: workspaceRecovery repo_root diverging from the session root fails closed (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const marker = "VERY_SECRET_OTHER_REPO_MARKER_4E1F";
    const session = makeSession({
      workspaceRecovery: makeWorkspaceRecovery({ repoRoot: `/${marker}` }),
    });
    await writeRawSessionFile(store, outputRoot, session);

    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => {
        assert.ok(e instanceof SessionError);
        assert.equal(e.kind, "session_corrupt");
        assert.equal(e.message, "The session state is corrupt and cannot be recovered");
        // Yol/İÇERİK mesajda YOK — yalnız sabit güvenli metin.
        assert.ok(!e.message.includes(marker));
        return true;
      },
    );
  });
});

// ── Güvenli (self-captured) ağaç yolları — Step 9 audit düzeltme A ─────────
//
// İki güven alanı (spec 16, 337): `basePaths` (tam `git ls-tree -r -z`) +
// `immutableBaseEntries.path` KULLANICI girdisi DEĞİLDİR → YAPISEL kural
// (backslash'li yasal adlar kabul); seçili/worker alanları STRICT kuralda
// kalır. Dürüst repository'nin backslash'li dosya adını takip EDEN oturumu
// yüklenemez KILINAMAZ; kaçış/`.git` formları yine fail-closed.

const UNSAFE_TREE_PATHS = [
  "", // boş
  "a\0b.ts", // NUL
  "/absolute/evil.ts", // mutlak
  "..", // bare traversal
  "../evil.ts",
  "a/../b.ts", // ortadaki `..`
  ".git", // TAM yönetim alanı adı
  ".git/config",
  "a/.git",
];

test("audit A: honest repo — backslash base tree paths round-trip without corruption (real fs)", async () => {
  await withRealStore(async (store, outputRoot) => {
    await store.create(SESSION_ID);
    const session = makeSession({
      workspaceRecovery: makeWorkspaceRecovery({
        basePaths: [
          ["src/a.ts", "100644"],
          ["src/weird\\name.ts", "100644"], // POSIX'te yasal dosya adı — git aynen takip eder
        ],
        immutableBaseEntries: [
          {
            mode: "040000",
            oid: "e".repeat(40),
            path: "src",
            children: [
              { mode: "100644", oid: "f".repeat(40), path: "a.ts" },
              { mode: "100644", oid: "0".repeat(40), path: "weird\\name.ts" },
            ],
          },
        ],
      }),
    });
    await writeRawSessionFile(store, outputRoot, session);

    // ÖNCEKİ bug: `normalizeRepoPath` karakter kümesi → `session_corrupt`.
    // Şimdi: aynen round-trip (backslash'li anahtar AYNEN korunur — alias
    // normalizasyonu YOK).
    const loaded = await store.load(SESSION_ID);
    assert.deepEqual(loaded, session);
    assert.deepEqual(
      loaded.workspaceRecovery.basePaths.map(([gitPath]) => gitPath),
      ["src/a.ts", "src/weird\\name.ts"],
    );
    assert.equal(loaded.workspaceRecovery.immutableBaseEntries[0]?.children?.[1]?.path, "weird\\name.ts");
  });
});

test("audit A: unsafe base tree paths fail closed with session_corrupt (fake fs)", async () => {
  for (const bad of UNSAFE_TREE_PATHS) {
    const mem = new MemFs();
    const store = storeWith(mem);
    await store.create(SESSION_ID);
    const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
    mem.files.set(path.join(dir, "session.json"), {
      mode: 0o600,
      content: JSON.stringify(
        { ...makeSession(), workspaceRecovery: makeWorkspaceRecovery({ basePaths: [[bad, "100644"]] }) },
        null,
        2,
      ),
    });
    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => {
        assert.ok(e instanceof SessionError);
        assert.equal(e.kind, "session_corrupt");
        assert.equal(e.message, "The session state is corrupt and cannot be recovered");
        // İçerik mesajda YOK — neden etiketi yalnız `cause` kanalı.
        assert.ok(!e.message.includes("evil"));
        return true;
      },
    );
  }
});

test("audit A: unsafe tree-entry paths (top-level + nested) fail closed (fake fs)", async () => {
  for (const bad of UNSAFE_TREE_PATHS) {
    const entryShapes: Array<Array<{ mode: string; oid: string; path: string; children?: Array<{ mode: string; oid: string; path: string }> }>> = [
      [{ mode: "100644", oid: "f".repeat(40), path: bad }], // kök dosya
      [
        {
          mode: "040000",
          oid: "e".repeat(40),
          path: "src",
          children: [{ mode: "100644", oid: "f".repeat(40), path: bad }], // içe gömülü
        },
      ],
    ];
    for (const immutableBaseEntries of entryShapes) {
      const mem = new MemFs();
      const store = storeWith(mem);
      await store.create(SESSION_ID);
      const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
      mem.files.set(path.join(dir, "session.json"), {
        mode: 0o600,
        content: JSON.stringify(
          { ...makeSession(), workspaceRecovery: makeWorkspaceRecovery({ immutableBaseEntries }) },
          null,
          2,
        ),
      });
      await assert.rejects(
        store.load(SESSION_ID),
        (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt",
      );
    }
  }
});

test("audit A: backslash stays REJECTED in untrusted (selected) fields — two trust domains (fake fs)", async () => {
  // Asimetri çivi: aynı dize güvenli alanda kabul, güvenilmez alanda red.
  const cases = [
    // session-level seçim (worker/seçili yol — STRICT karakter kümesi kuralı).
    { editablePaths: ["src/weird\\name.ts"] },
    // recovery'nin seçili-yol türevi alanları da STRICT:
    {
      workspaceRecovery: makeWorkspaceRecovery({
        baseFingerprints: [
          ["src/weird\\name.ts", { exists: true, type: "file", mode: "100644", contentSha256: "d".repeat(64) }],
        ],
      }),
    },
  ];
  for (const patch of cases) {
    const mem = new MemFs();
    const store = storeWith(mem);
    await store.create(SESSION_ID);
    const dir = path.join("/tmp/splash-out", "sessions", SESSION_ID);
    mem.files.set(path.join(dir, "session.json"), {
      mode: 0o600,
      content: JSON.stringify({ ...makeSession(), ...patch }, null, 2),
    });
    await assert.rejects(
      store.load(SESSION_ID),
      (e: unknown) => e instanceof SessionError && e.kind === "session_corrupt",
    );
  }
});
