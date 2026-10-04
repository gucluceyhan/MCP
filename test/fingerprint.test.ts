/**
 * Step 9: `fingerprintsEqual` — pure comparison matrix (spec 267).
 *
 * No filesystem, no clock inside the comparison. The matrix pins every
 * distinguishing field: existence, type, mode, and contentSha256 (both absent
 * vs. present-but-different vs. byte-identical). `mtime`/volatile stat fields
 * are NOT part of a fingerprint (spec 31), so they never enter the comparison.
 *
 * Dosya sonunda: STRICT canlı yakalamanın errno sözleşmesi (gerçek fs + seam) —
 * `lstat` ENOTDIR (önekteki bir bileşen dizin değil → yol var olamaz): taban
 * parmak izinde KESİN yokluk, worker-oluşturulan varlıkta ÇAKIŞMA (`true`);
 * diğer errno'lar (EACCES/EIO/ELOOP/EPERM) fail-closed kalır.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureStrictLiveExistence,
  captureStrictLiveFingerprint,
  fingerprintsEqual,
} from "../dist/workspace/fingerprint.js";
import { StrictReadError } from "../dist/workspace/SafeRepoReader.js";
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

// ── STRICT canlı yakalama: errno sözleşmesi ─────────────────────────────────

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} (fault-injected)`), { code });
}

/** `err` bir `StrictReadError` ve `cause.code` verilen errno mu? */
function isStrictReadErrorWith(err: unknown, code: string): boolean {
  return (
    err instanceof StrictReadError &&
    (err.cause as NodeJS.ErrnoException | undefined)?.code === code
  );
}

async function tmpRoot(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-fp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("strict capture: ancestor became a regular FILE (lstat ENOTDIR) → fingerprint exists:false; created-path existence true (collision) — never an error (real fs)", async (t) => {
  const root = await tmpRoot(t);
  // `src` artık bir DOSYA: altındaki her yol var OLAMAZ.
  await writeFile(path.join(root, "src"), "now a file\n");
  // Ölçüm (varsayım değil): gerçek fs bu durumda ENOTDIR verir.
  await assert.rejects(lstat(path.join(root, "src", "a.ts")), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOTDIR");

  for (const abs of [path.join(root, "src", "a.ts"), path.join(root, "src", "x", "a.ts")]) {
    // Taban parmak izi: kesin yokluk (taban yokluğuna karşı karşılaştırılır).
    assert.deepEqual(await captureStrictLiveFingerprint(abs), { exists: false });
    // Worker-oluşturulan yol: `create` main'e uygulanamaz → çakışma.
    assert.equal(await captureStrictLiveExistence(abs), true);
  }
  // Kontrast: gerçek yokluk (ENOENT) çakışma DEĞİLDİR.
  assert.equal(await captureStrictLiveExistence(path.join(root, "absent.ts")), false);
});

test("strict capture: every other lstat errno (EACCES/EIO/ELOOP/EPERM) stays fail-closed → StrictReadError (never 'absent')", async () => {
  for (const code of ["EACCES", "EIO", "ELOOP", "EPERM"]) {
    const seams = {
      lstat: async (): Promise<never> => {
        throw errno(code);
      },
    };
    await assert.rejects(captureStrictLiveFingerprint("/repo/src/a.ts", seams), (e: unknown) =>
      isStrictReadErrorWith(e, code),
    );
    await assert.rejects(captureStrictLiveExistence("/repo/src/a.ts", seams), (e: unknown) =>
      isStrictReadErrorWith(e, code),
    );
  }
});

test("strict capture: the ENOTDIR exemption is lstat-only — a content read failing with ENOTDIR stays fail-closed", async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, "a.ts");
  await writeFile(file, "const a = 1;\n");
  // lstat GERÇEK (düzenli dosya); yalnız içerik okuması ENOTDIR (race modeli).
  const seams = {
    readFile: async (): Promise<never> => {
      throw errno("ENOTDIR");
    },
  };
  await assert.rejects(captureStrictLiveFingerprint(file, seams), (e: unknown) => isStrictReadErrorWith(e, "ENOTDIR"));
});
