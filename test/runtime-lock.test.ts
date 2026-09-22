/**
 * RuntimeLock testleri (Step 3).
 *
 * Tüm testler geçici dizinlerde (os.tmpdir + mkdtemp) çalışır — gerçek
 * `~/.splash`'a YASAK. Saat ve PID canlılığı ENJEKTEDİR: testler ne
 * duvar saati yarışına ne de makinedeki gerçek PID'lere bağımlıdır.
 * "Yeni" vs "yaşlı" kilit ayırımı, dizin mtime'ının `utimes` ile
 * kontrol edilmesi + enjekte edilen `now` ile deterministik kılınır.
 *
 * Testler BUILT çıktıyı (dist/) import eder (bkz. package.json pretest).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INFERENCE_LOCK_DIR,
  LockError,
  OWNER_FILE_NAME,
  RuntimeLock,
  type PidLiveness,
} from "../dist/backend/RuntimeLock.js";

/** Her test için izole, otomatik temizlenen geçici runtime kökü. */
async function freshRuntimeDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "splash-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function lockDirOf(runtimeDir: string): string {
  return path.join(runtimeDir, INFERENCE_LOCK_DIR);
}

function ownerFileOf(runtimeDir: string): string {
  return path.join(lockDirOf(runtimeDir), OWNER_FILE_NAME);
}

/** Bir "yabancı" kilit ön-tesis eder (mkdir + owner.json). */
async function plantLock(
  runtimeDir: string,
  owner: Record<string, unknown>,
  ageMsAgo: number,
): Promise<void> {
  await mkdir(lockDirOf(runtimeDir), { recursive: true });
  await writeFile(ownerFileOf(runtimeDir), `${JSON.stringify(owner, null, 2)}\n`);
  // Dizini (ya da yalnızca dizini — dosya yazımı dizin mtime'ını
  // gunceller) `ageMsAgo` kadar "eski" yap: yaş kuralı deterministik.
  const base = Date.now() - ageMsAgo;
  await utimes(ownerFileOf(runtimeDir), base / 1000, base / 1000);
  await utimes(lockDirOf(runtimeDir), base / 1000, base / 1000);
}

// ── acquire ──────────────────────────────────────────────────────────────

test("acquire: creates the runtime dir, lock dir and owner record; returns the opaque token", async (t) => {
  const dir = await freshRuntimeDir(t);
  const NOW = 1_700_000_000_000;
  const lock = new RuntimeLock(dir, { now: () => NOW, liveness: () => "alive" });

  const result = await lock.acquire("session-1");

  assert.equal(result.acquired, true);
  if (!result.acquired) {
    throw new Error("unreachable");
  }
  // Token: opak, rastgele UUID biçiminde (UUID v4).
  assert.match(
    result.token,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  const raw = await readFile(ownerFileOf(dir), "utf8");
  const owner = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(owner.schema_version, 1);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.token, result.token);
  assert.equal(owner.owner_id, "session-1");
  assert.equal(owner.acquired_at, new Date(NOW).toISOString());
  // İçeriğe ASLA girmemesi gereken şeyler de yok:
  for (const forbidden of ["prompt", "apiKey", "message", "source"]) {
    assert.ok(!raw.includes(forbidden), `owner record must not contain "${forbidden}"`);
  }
});

test("acquire: restrictive modes — runtime dir 0700, lock dir 0700, owner file 0600", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  await lock.acquire("session-1");

  assert.equal((await stat(dir)).mode & 0o777, 0o700, "runtime dir");
  assert.equal((await stat(lockDirOf(dir))).mode & 0o777, 0o700, "lock dir");
  assert.equal((await stat(ownerFileOf(dir))).mode & 0o777, 0o600, "owner file");
});

test("acquire: a live foreign owner → busy; the foreign lock is untouched", async (t) => {
  const dir = await freshRuntimeDir(t);
  const FOREIGN = 999_001;
  await plantLock(
    dir,
    {
      schema_version: 1,
      pid: FOREIGN,
      token: "foreign-token",
      owner_id: "other-session",
      acquired_at: "2026-01-01T00:00:00.000Z",
    },
    1_000,
  );
  // "Yeni" bir saat: mevcut (1 sn önceki) mtime'ın çok yakını.
  const NOW = Date.now() + 1_000;
  const liveness: PidLiveness = (pid) => (pid === FOREIGN ? "alive" : "unknown");
  const lock = new RuntimeLock(dir, { now: () => NOW, liveness });

  const result = await lock.acquire("session-1");

  assert.deepEqual(result, { acquired: false, reason: "busy" });
  const raw = await readFile(ownerFileOf(dir), "utf8");
  assert.ok(raw.includes("foreign-token"), "the foreign lock must survive");
});

test("acquire: a stale lock with a definitely-dead owner is reclaimed and re-acquired", async (t) => {
  const dir = await freshRuntimeDir(t);
  const DEAD = 999_002;
  await plantLock(
    dir,
    {
      schema_version: 1,
      pid: DEAD,
      token: "stale-token",
      owner_id: "crashed-session",
      acquired_at: "2026-01-01T00:00:00.000Z",
    },
    60_000,
  );
  const liveness: PidLiveness = (pid) => (pid === DEAD ? "dead" : "alive");
  const lock = new RuntimeLock(dir, { now: () => Date.now(), liveness });

  const result = await lock.acquire("session-2");

  assert.equal(result.acquired, true);
  if (!result.acquired) {
    throw new Error("unreachable");
  }
  const raw = await readFile(ownerFileOf(dir), "utf8");
  const owner = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(owner.pid, process.pid, "the lock is now ours");
  assert.equal(owner.token, result.token);
  assert.ok(!raw.includes("stale-token"), "the stale token must be gone");
  // Mezar taşı kalıntısı kalmamalı.
  const entries = await readdir(dir);
  assert.deepEqual(entries, [INFERENCE_LOCK_DIR]);
});

test("acquire: while the same process already holds the lock, a second acquire reports busy (no re-entrancy)", async (t) => {
  const dir = await freshRuntimeDir(t);
  const liveness: PidLiveness = (pid) => (pid === process.pid ? "alive" : "unknown");
  const lock = new RuntimeLock(dir, { now: () => Date.now(), liveness });

  const first = await lock.acquire("session-1");
  assert.equal(first.acquired, true);
  const second = await lock.acquire("session-2");

  assert.deepEqual(second, { acquired: false, reason: "busy" });
});

test("acquire: a just-created incomplete lock (dir without owner record) is treated as busy, never deleted", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lockDir = lockDirOf(dir);
  await mkdir(lockDir, { mode: 0o700 }); // owner.json YOK (yarım kalmış)

  // Yaşı deterministik: gerçek mtime'ın 1 sn SONRASI — grace içinde.
  const realMtimeMs = (await stat(lockDir)).mtimeMs;
  const NOW = Math.ceil(realMtimeMs) + 1_000;
  const lock = new RuntimeLock(dir, { now: () => NOW, liveness: () => "unknown" });

  const result = await lock.acquire("session-1");

  assert.deepEqual(result, { acquired: false, reason: "busy" });
  assert.ok((await stat(lockDir)).isDirectory(), "the young lock must survive");
});

test("acquire: an old incomplete lock (beyond the grace period) is reclaimed", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lockDir = lockDirOf(dir);
  await mkdir(lockDir, { mode: 0o700 });
  // Yaş = enjekte saat − dizin mtime; deterministik için mtime, saatin
  // 60 sn ÖNÜNE yerleştirilir (grace (5 sn)ın çok ötesi).
  const base = Date.now();
  await utimes(lockDir, (base - 60_000) / 1000, (base - 60_000) / 1000);
  const lock = new RuntimeLock(dir, { now: () => base, liveness: () => "unknown" });

  const result = await lock.acquire("session-1");

  assert.equal(result.acquired, true, "an old ownerless lock must be reclaimable");
  if (result.acquired) {
    assert.ok((await stat(ownerFileOf(dir))).isFile(), "a fresh owner record is written");
  }
});

test("acquire: a malformed owner record follows the same grace gate (fresh → busy, old → reclaimed)", async (t) => {
  const malformed = "{ this is not json";
  for (const [name, ageMs] of [
    ["fresh", 1_000],
    ["old", 60_000],
  ] as const) {
    const dir = await freshRuntimeDir(t);
    await mkdir(lockDirOf(dir));
    await writeFile(ownerFileOf(dir), malformed);
    // Yaş = enjekte saat − mtime: mtime, saatin `ageMs` kadar ÖNÜNE konur.
    const base = Date.now();
    await utimes(ownerFileOf(dir), (base - ageMs) / 1000, (base - ageMs) / 1000);
    await utimes(lockDirOf(dir), (base - ageMs) / 1000, (base - ageMs) / 1000);
    const lock = new RuntimeLock(dir, { now: () => base, liveness: () => "unknown" });

    const result = await lock.acquire("session-1");
    const expected = name === "fresh" ? "busy" : "stale-reclaimed";
    if (name === "fresh") {
      assert.deepEqual(result, { acquired: false, reason: "busy" }, `${name}: must stay`);
      assert.ok((await stat(lockDirOf(dir))).isDirectory(), `${name}: must survive`);
    } else {
      assert.equal(result.acquired, true, `${name}: must be reclaimed`);
      assert.ok(expected);
    }
  }
});

test("acquire: an unverifiable owner (liveness unknown) fails closed as uncertain; nothing is deleted", async (t) => {
  const dir = await freshRuntimeDir(t);
  const UNKNOWN = 999_003;
  await plantLock(
    dir,
    {
      schema_version: 1,
      pid: UNKNOWN,
      token: "unverified-token",
      owner_id: "mystery-session",
      acquired_at: "2026-01-01T00:00:00.000Z",
    },
    60_000,
  );
  const lock = new RuntimeLock(dir, {
    now: () => Date.now(),
    liveness: () => "unknown",
  });

  const result = await lock.acquire("session-1");

  assert.deepEqual(result, { acquired: false, reason: "uncertain" });
  const raw = await readFile(ownerFileOf(dir), "utf8");
  assert.ok(raw.includes("unverified-token"), "an uncertain lock must survive");
});

test("acquire: a stored pid that is not a positive integer is untrusted (follows the malformed-record gate)", async (t) => {
  for (const [name, pid] of [
    ["string pid", "12345"],
    ["zero pid", 0],
    ["negative pid", -7],
  ] as const) {
    const dir = await freshRuntimeDir(t);
    await mkdir(lockDirOf(dir));
    await writeFile(
      ownerFileOf(dir),
      JSON.stringify({ schema_version: 1, pid, token: "tok", owner_id: "s", acquired_at: "t" }),
    );
    // Yaşlı kayıt: mtime, enjekte saatin 60 sn öncesine (canlılık
    // YİNE sorgulanmaz — bozuk kayıt yaş kuralıyla çözülür).
    const base = Date.now();
    await utimes(ownerFileOf(dir), (base - 60_000) / 1000, (base - 60_000) / 1000);
    await utimes(lockDirOf(dir), (base - 60_000) / 1000, (base - 60_000) / 1000);
    const lock = new RuntimeLock(dir, { now: () => base, liveness: () => "alive" });

    const result = await lock.acquire("session-1");
    // Geçersiz pid → bozuk kayıt → yaşlıysa kurtarılır (canlılık ASLA sorgulanmaz).
    assert.equal(result.acquired, true, `${name}: an old record with an unusable pid must be reclaimable`);
  }
});

test("acquire: an empty ownerId rejects with a typed LockError", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  await assert.rejects(
    lock.acquire(""),
    (err: unknown) => err instanceof LockError && err.kind === "owner_invalid",
  );
});

// ── release ──────────────────────────────────────────────────────────────

test("release: a matching token removes the lock entirely", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  const acquired = await lock.acquire("session-1");
  if (!acquired.acquired) {
    throw new Error("unreachable");
  }
  assert.ok((await stat(lockDirOf(dir))).isDirectory(), "precondition: the lock exists");

  await lock.release(acquired.token);

  let exists = true;
  try {
    await stat(lockDirOf(dir));
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "the lock dir must be gone");
});

test("release: a token mismatch refuses to remove the foreign lock (typed error; the dir survives)", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  const acquired = await lock.acquire("session-1");
  if (!acquired.acquired) {
    throw new Error("unreachable");
  }
  // Kilit, başka bir sürece "geçmiş" olsun (bizim kaydı ezildi).
  await writeFile(
    ownerFileOf(dir),
    JSON.stringify({ schema_version: 1, pid: 999_004, token: "someone-else", owner_id: "x", acquired_at: "t" }),
  );

  let caught: unknown = null;
  try {
    await lock.release(acquired.token);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LockError, `expected a LockError, got: ${String(caught)}`);
  assert.equal((caught as LockError).kind, "token_mismatch");
  // Güvenli mesaj: ne token ne de yol taşımaz.
  assert.ok(!String((caught as Error).message).includes("someone-else"), "no token in the message");
  assert.ok(!String((caught as Error).message).includes(dir), "no path in the message");
  // Yabancı kilit yerinde durur.
  const raw = await readFile(ownerFileOf(dir), "utf8");
  assert.ok(raw.includes("someone-else"), "the foreign lock must survive");
});

test("release: an unparseable owner record refuses removal with a typed error", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  const acquired = await lock.acquire("session-1");
  if (!acquired.acquired) {
    throw new Error("unreachable");
  }
  await writeFile(ownerFileOf(dir), "not-json-at-all");

  await assert.rejects(
    lock.release(acquired.token),
    (err: unknown) => err instanceof LockError && err.kind === "owner_invalid",
  );
  assert.ok((await stat(lockDirOf(dir))).isDirectory(), "the unverifiable lock must survive");
});

test("release: idempotent when the lock directory is already gone", async (t) => {
  const dir = await freshRuntimeDir(t);
  const lock = new RuntimeLock(dir, { now: () => 1, liveness: () => "alive" });
  const acquired = await lock.acquire("session-1");
  if (!acquired.acquired) {
    throw new Error("unreachable");
  }
  // Kilit, bir bayat kurtarma tarafından zaten kaldırılmış olsun.
  await rm(lockDirOf(dir), { recursive: true, force: true });

  await lock.release(acquired.token); // no-op: hata YOK.
});
