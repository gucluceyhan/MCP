/**
 * Step 9: `fingerprintsEqual` — pure comparison matrix (spec 267).
 *
 * No filesystem, no clock inside the comparison. The matrix pins every
 * distinguishing field: existence, type, mode, and contentSha256 (both absent
 * vs. present-but-different vs. byte-identical). `mtime`/volatile stat fields
 * are NOT part of a fingerprint (spec 31), so they never enter the comparison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintsEqual } from "../dist/workspace/fingerprint.js";
import type { PathFingerprint } from "../dist/workspace/Workspace.js";

const absent: PathFingerprint = { exists: false };
const file = (contentSha256?: string, mode = "100644"): PathFingerprint => ({
  exists: true,
  type: "file",
  mode,
  contentSha256,
});
const symlink = (targetSha256?: string): PathFingerprint => ({
  exists: true,
  type: "symlink",
  mode: "120000",
  contentSha256: targetSha256,
});
const dir = (): PathFingerprint => ({ exists: true, type: "directory", mode: "040000" });
const other = (): PathFingerprint => ({ exists: true, type: "other", mode: "other" });

test("both absent → equal", () => {
  assert.equal(fingerprintsEqual(absent, absent), true);
});

test("one absent, one present → not equal (in either order)", () => {
  assert.equal(fingerprintsEqual(absent, file("h1")), false);
  assert.equal(fingerprintsEqual(file("h1"), absent), false);
});

test("identical files (mode + content) → equal", () => {
  assert.equal(fingerprintsEqual(file("abc", "100644"), file("abc", "100644")), true);
});

test("mode drift (100644 vs 100755) → not equal even with identical content", () => {
  assert.equal(fingerprintsEqual(file("abc", "100644"), file("abc", "100755")), false);
});

test("content drift (same type/mode, different bytes) → not equal", () => {
  assert.equal(fingerprintsEqual(file("abc"), file("def")), false);
});

test("content present on one side only → not equal", () => {
  assert.equal(fingerprintsEqual(file("abc"), file()), false);
  assert.equal(fingerprintsEqual(file(), file("abc")), false);
});

test("both files, same mode, both without content → equal", () => {
  assert.equal(fingerprintsEqual(file(), file()), true);
});

test("type mismatch file vs symlink → not equal", () => {
  assert.equal(fingerprintsEqual(file("abc"), symlink("abc")), false);
});

test("type mismatch file vs directory → not equal", () => {
  assert.equal(fingerprintsEqual(file("abc"), dir()), false);
});

test("type mismatch file vs other → not equal", () => {
  assert.equal(fingerprintsEqual(file("abc"), other()), false);
});

test("identical directories (mode 040000) → equal", () => {
  assert.equal(fingerprintsEqual(dir(), dir()), true);
});

test("identical symlinks (same target-text hash) → equal; different target → not equal", () => {
  assert.equal(fingerprintsEqual(symlink("th"), symlink("th")), true);
  assert.equal(fingerprintsEqual(symlink("th"), symlink("other")), false);
});
