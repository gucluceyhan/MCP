/**
 * Step 9: shared no-follow repository reader — unit tests (spec 48, 194-196).
 *
 * Two levels:
 * 1. Real filesystem: `open(O_RDONLY | O_NOFOLLOW)` kernel semantics on macOS —
 *    symlink → ELOOP (never followed), regular → bytes, directory → non-regular,
 *    absent → ENOENT. This is the actual hardening the Step 8 review carried.
 * 2. Scripted seam (`SafeFileHandle` / `SafeOpenFn` fakes): model the race and
 *    pin the handle-close discipline (the handle is closed on EVERY path —
 *    success, read failure, stat failure — spec 299-301).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { noFollowReadFile, type SafeFileHandle, type SafeOpenFn } from "../dist/workspace/SafeRepoReader.js";

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code} (fault-injected)`), { code });

function statOf(kind: "file" | "dir" | "symlink"): Stats {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  } as unknown as Stats;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "splash-srr-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── real filesystem: O_NOFOLLOW kernel semantics ─────────────────────────────

test("regular file → its bytes (O_NOFOLLOW is a no-op on a real regular file)", async () => {
  await withTmpDir(async (dir) => {
    const p = path.join(dir, "f.txt");
    await writeFile(p, "regular-content");
    const bytes = await noFollowReadFile(p);
    assert.equal(bytes.toString("utf8"), "regular-content");
  });
});

test("symlink → ELOOP; the outside target content is NEVER read", async () => {
  await withTmpDir(async (dir) => {
    const outside = path.join(dir, "outside-secret.txt");
    await writeFile(outside, "TOP-SECRET");
    const link = path.join(dir, "link.txt");
    await symlink(outside, link);
    await assert.rejects(noFollowReadFile(link), (err: NodeJS.ErrnoException) => err.code === "ELOOP");
  });
});

test("directory → non-regular failure (EISDIR), no content", async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(noFollowReadFile(dir), (err: NodeJS.ErrnoException) => err.code === "EISDIR");
  });
});

test("absent path → ENOENT (the only 'absent')", async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(noFollowReadFile(path.join(dir, "nope")), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  });
});

// ── scripted seam: race + handle-close discipline ────────────────────────────

interface Counters {
  close: number;
  read: number;
}

function fakeOpen(spec: {
  openError?: string;
  kind?: "file" | "dir" | "symlink";
  content?: Buffer;
  readError?: string;
  statError?: string;
}, counters: Counters): SafeOpenFn {
  return async () => {
    if (spec.openError !== undefined) {
      throw errno(spec.openError);
    }
    return {
      stat: async () => {
        if (spec.statError !== undefined) {
          throw errno(spec.statError);
        }
        return statOf(spec.kind ?? "file");
      },
      readFile: async () => {
        counters.read += 1;
        if (spec.readError !== undefined) {
          throw errno(spec.readError);
        }
        if (spec.content === undefined) {
          throw errno("ENOENT");
        }
        return spec.content;
      },
      close: async () => {
        counters.close += 1;
      },
    } satisfies SafeFileHandle;
  };
}

test("open fails ELOOP (a symlink at open time) → propagates; nothing is read", async () => {
  const counters: Counters = { close: 0, read: 0 };
  await assert.rejects(noFollowReadFile("/x", fakeOpen({ openError: "ELOOP" }, counters)), (e: NodeJS.ErrnoException) => e.code === "ELOOP");
  assert.equal(counters.read, 0, "the target content is never read");
  assert.equal(counters.close, 0, "no handle was obtained → nothing to close");
});

test("open fails ENOENT → propagates absent", async () => {
  await assert.rejects(noFollowReadFile("/x", fakeOpen({ openError: "ENOENT" }, { close: 0, read: 0 })), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
});

test("handle obtained but stat says directory → EISDIR; the handle is still closed", async () => {
  const counters: Counters = { close: 0, read: 0 };
  await assert.rejects(noFollowReadFile("/x", fakeOpen({ kind: "dir" }, counters)), (e: NodeJS.ErrnoException) => e.code === "EISDIR");
  assert.equal(counters.close, 1, "the handle must be closed even on a non-regular failure");
  assert.equal(counters.read, 0);
});

test("handle obtained, stat regular, but read fails (EIO) → propagates; the handle is closed (spec 299-301)", async () => {
  const counters: Counters = { close: 0, read: 0 };
  await assert.rejects(noFollowReadFile("/x", fakeOpen({ kind: "file", content: Buffer.from("x"), readError: "EIO" }, counters)), (e: NodeJS.ErrnoException) => e.code === "EIO");
  assert.equal(counters.close, 1, "a failed read must still close the handle");
});

test("happy path: regular handle → bytes; the handle is closed exactly once", async () => {
  const counters: Counters = { close: 0, read: 0 };
  const bytes = await noFollowReadFile("/x", fakeOpen({ kind: "file", content: Buffer.from("the-rules") }, counters));
  assert.equal(bytes.toString("utf8"), "the-rules");
  assert.equal(counters.close, 1);
  assert.equal(counters.read, 1);
});
