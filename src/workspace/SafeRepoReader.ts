/**
 * Step 9: strict no-follow repository reader — shared read-only primitive
 * (the small TOCTOU hardening carried from the Step 8 review; spec 48-53).
 *
 * WHY A DEDICATED PRIMITIVE
 * ─────────────────────────
 * The Step 8 review documented a residual read-only leaf race: a
 * security-sensitive live read performed as `lstat(path)` then `readFile(path)`
 * is NOT atomic — between the two calls the path can be swapped to a symbolic
 * link, and `readFile` (which follows links) would then read the link target
 * (e.g. an outside secret) instead of the regular file. This module closes that
 * race with a single, shared, handle-based no-follow regular-file read that
 * every security-sensitive live reader consumes:
 *
 *   open(path, O_RDONLY | O_NOFOLLOW)   ← symlink → ELOOP (never followed)
 *   ↓
 *   handle.stat()                       ← the pinned inode we actually opened
 *   ↓
 *   verify regular file                 ← directory/FIFO/socket/device → fail
 *   ↓
 *   handle.readFile()                   ← from the SAME handle (pinned inode)
 *   ↓
 *   handle.close() in `finally`         ← closed on every path (spec 299-301)
 *
 * `O_NOFOLLOW` makes the kernel reject the open if the final path component is
 * a symlink at the moment of open, and the read comes from the SAME handle, so
 * the inode is pinned: there is no check-then-follow window. A path swapped to
 * a symlink after a successful `open` cannot redirect the read (the handle
 * already points at the original regular inode).
 *
 * LAYERING: this lives in `src/workspace` (the low-level repository-filesystem
 * module) so that both `src/rules` (root CLAUDE.md / AGENTS.md) and
 * `src/context` (read-only reference leaves) can consume it WITHOUT a
 * rules↔context import cycle. It is a read-only primitive: no write, no rename,
 * no unlink, no Git, no clock.
 *
 * CONSUMERS (Step 9):
 * - `RulesResolver` uses it as its production `readFile` seam member (spec 49).
 * - `ContextAssembler` uses it for regular-file read-only leaf reads (spec 50).
 * - `SessionManager`'s stale checker consumes it through `ContextAssembler`
 *   (spec 53) — the stale capture never does arbitrary raw reads here.
 *
 * Do NOT use `lstat(path)` → `readFile(path)` for security-sensitive live
 * reads (spec 48). This is the one shared safe reader.
 */

import { constants as fsConstants, open } from "node:fs/promises";
import type { Stats } from "node:fs";

/** `O_RDONLY | O_NOFOLLOW` — open a regular file, never follow a symlink. */
const NOFOLLOW_RDONLY = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/**
 * Minimal handle surface the no-follow read drives. Production is the
 * `node:fs/promises` `FileHandle` (structural match — only the members used are
 * declared). Test seams supply a scripted handle to model the race (regular at
 * lookup → symlink at read).
 */
export interface SafeFileHandle {
  /** `stat` on the open handle = the pinned inode (the fstat-equivalent). */
  stat(): Promise<Stats>;
  /** Read the whole file from the pinned inode. */
  readFile(): Promise<Buffer>;
  /** Close the handle (always, in `finally`). */
  close(): Promise<void>;
}

/** Injectable open seam (test race injection; production default: node:fs). */
export type SafeOpenFn = (target: string, flags: number) => Promise<SafeFileHandle>;

/**
 * Strict live read could not be completed safely (Step 9 spec 44/45/47/51).
 *
 * Raised when a strict capture cannot determine the live state with
 * fail-closed certainty: an `lstat` error other than `ENOENT`/`ENOTDIR` (both
 * are definite answers — the path cannot exist; anything else —
 * EACCES/EIO/ELOOP/... — is uncertainty),
 * a `readlink` failure on a symlink leaf, or a failed no-follow content read.
 * The caller maps this to its own typed, safe error — it is an OPERATIONAL
 * failure, never "absent" and never "stale" (spec 44/47/51). The `cause`
 * carries the technical error (developer channel only — never surfaced).
 */
export class StrictReadError extends Error {
  constructor(cause: unknown) {
    super("strict live read failed", { cause });
    this.name = "StrictReadError";
  }
}

/** `err` is a `NodeJS.ErrnoException` with the given `code`? */
export function errnoIs(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function errnoOf(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Production default open: `node:fs/promises` (structural `SafeFileHandle`). */
const realOpen: SafeOpenFn = (target, flags) => open(target, flags);

/**
 * Read a regular file's bytes with the shared no-follow handle sequence.
 *
 * Error contract (the CALLER maps these to its own typed, safe error):
 * - `ENOENT`  → the path is absent (the only "absent").
 * - `ELOOP`   → the final path component is a symlink (never followed).
 * - other errno / non-regular entry → operational failure (fail-closed).
 *
 * On success returns the file bytes as a defensive `Buffer` copy. The handle is
 * closed on every path (success or any failure — spec 299-301).
 */
export async function noFollowReadFile(target: string, openFn: SafeOpenFn = realOpen): Promise<Buffer> {
  const handle = await openFn(target, NOFOLLOW_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      // Directory / FIFO / socket / device: not readable as a regular file.
      throw errnoOf("EISDIR", "no-follow read: entry is not a regular file");
    }
    return Buffer.from(await handle.readFile());
  } finally {
    await handle.close();
  }
}
