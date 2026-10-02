/**
 * Step 8: Project rules resolver (DESIGN.md §6, 11 m.8).
 *
 * Responsibility: decide WHERE the session's project rules come from —
 * nothing else. No redaction, no tokenization, no formatting, no budget
 * (all of that is the Context Assembler's job, Step 8 spec 3) and NO
 * Git — rules loading is plain read-only filesystem access (spec 141).
 *
 * Resolution chain (deterministic, DESIGN.md §6):
 *   1. session/hook-supplied rules (`options.rules`) — absolute priority:
 *      a valid, non-empty payload resolves to `hook` and the repository is
 *      NEVER touched (no lstat/readFile of any rule path).
 *   2. repository fallback — exactly TWO known root surfaces, in this
 *      fixed order: `<repoRoot>/CLAUDE.md`, then `<repoRoot>/AGENTS.md`.
 *      No crawling, no recursion, no parent-directory/home lookup, no glob,
 *      no Git. Whitespace-only file content = no rule content from that
 *      source.
 *   3. neither yields content → `{ source: "none", documents: [] }`.
 *
 * Fail-closed discipline (Step 8 spec 18-23):
 * - root is canonicalized with `realpath` first; an uncertain
 *   canonicalization fails closed (no lexical fallback after EACCES/EIO);
 * - each rule path is `lstat`'d (never `stat` — symlinks are NOT regular
 *   files): symlink / directory / FIFO / socket / device → failure,
 *   never "absent" and never followed;
 * - ONLY `ENOENT` means "this source does not exist"; every other errno
 *   (EACCES/EPERM/EIO/ELOOP/ENOTDIR/...) fails the whole resolution —
 *   there is no silent fallback to the other file after an operational
 *   error on a higher-priority source;
 * - bytes must round-trip strict UTF-8 (same discipline as the Context
 *   Assembler); invalid UTF-8 fails closed — never decoded with
 *   replacement characters.
 *
 * Cancellation (spec 142): the resolver itself carries no signal — its
 * work is bounded, local, read-only fs (fs reads are not signal-aware).
 * The request signal is respected by the Context Assembler, which forwards
 * it to every runtime operation the rules trigger (tokenization/
 * measurement) and to the inference dispatch — no background work is
 * invented here, and no inference runs after an abort (spec 142's
 * "at minimum" is the assembler/runtime forwarding).
 *
 * The resolver is stateless per call: no cache across sessions/repos
 * (spec 117), safe for concurrent resolution (spec 146), read-only
 * (spec 24), and resolves lazily — constructing it touches no filesystem
 * (spec 172/173).
 */

import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { noFollowReadFile } from "../workspace/SafeRepoReader.js";

import {
  RULES_RESOLUTION_FAILED_MESSAGE,
  RulesResolutionError,
  type ResolvedRules,
  type RuleDocument,
  type RuleDocumentSource,
  type RulesFs,
  type RulesResolverInput,
} from "./types.js";

/** The two — and only two — rule file names, in their fixed priority order. */
const RULE_FILE_NAMES: readonly RuleDocumentSource[] = ["CLAUDE.md", "AGENTS.md"];

// ── Production filesystem (default seam) ────────────────────────────────────

// `readFile` is the shared no-follow safe read (Step 9 spec 49): the
// `lstat → readFile` sequence is unchanged, but the content read is
// `open(O_NOFOLLOW)` + same-handle read, so a rule path swapped to a symlink
// between the two cannot be followed. (see workspace/SafeRepoReader)
const realFs: RulesFs = { lstat, readFile: noFollowReadFile, realpath };

/** Resolver dependencies — `fs` is optional (default: `node:fs/promises`). */
export interface RulesResolverDeps {
  /** Test seam: read-only filesystem with fault/call instrumentation. */
  fs?: RulesFs;
}

/** `bytes` round-trips strict UTF-8? (safe helper — byte-exact, no replacement characters). */
function isStrictUtf8(bytes: Buffer): boolean {
  return bytes.equals(Buffer.from(bytes.toString("utf8"), "utf8"));
}

/** `err` is a `NodeJS.ErrnoException` with the given `code`? */
function hasErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/**
 * Step 8: project rules resolver. Stateless (single shared instance is
 * safe — spec 4/146); every `resolve` call is independent and read-only.
 */
export class RulesResolver {
  #fs: RulesFs;

  constructor(deps: RulesResolverDeps = {}) {
    this.#fs = deps.fs ?? realFs;
  }

  /**
   * Resolves the project rules for one task session (called exactly once
   * per `splash_task`; the result is pinned in the live session state).
   *
   * Resolves to `ResolvedRules` (spec 15/16). Rejects with the typed
   * `RulesResolutionError` ("rules_resolution_failed", fixed safe message)
   * whenever the resolution cannot be completed safely — the caller
   * (task service) fails the request BEFORE any workspace/session
   * creation (Step 8 spec 27/138).
   */
  async resolve(input: RulesResolverInput): Promise<ResolvedRules> {
    // Priority 1: a VALID supplied payload wins absolutely — the
    // repository is never touched (spec 9/79/139/213). Trim is used
    // solely for emptiness detection; the payload itself is preserved
    // byte-for-byte (spec 8/17).
    if (input.suppliedRules !== undefined && input.suppliedRules.trim().length > 0) {
      return {
        source: "hook",
        documents: [{ source: "hook", content: input.suppliedRules }],
      };
    }

    // Priority 2: repository fallback — root canonicalization first.
    // Operational uncertainty (EACCES/EIO/... on the root) fails closed;
    // there is NO lexical fallback after a failed canonicalization (spec 23).
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.#fs.realpath(input.repoRoot);
    } catch (err) {
      throw this.#failed(err);
    }

    const documents: RuleDocument[] = [];
    for (const name of RULE_FILE_NAMES) {
      const content = await this.#readRuleFile(canonicalRoot, name);
      if (content !== null) {
        documents.push({ source: name, content });
      }
    }

    if (documents.length === 0) {
      return { source: "none", documents: [] };
    }
    if (documents.length === 1) {
      return { source: documents[0]!.source, documents };
    }
    // Both non-empty: combined provenance; fixed CLAUDE.md → AGENTS.md order.
    return { source: "CLAUDE.md + AGENTS.md", documents };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Reads exactly one root rule file. Returns `null` ONLY for genuine
   * absence (ENOENT). Every other outcome — non-regular entry (symlink /
   * directory / FIFO / socket / device), any I/O failure (EACCES, EPERM,
   * EIO, ELOOP, ...), invalid UTF-8 — rejects with the typed fail-closed
   * error. No silent fallback to another source (spec 19-21/88/89).
   */
  async #readRuleFile(canonicalRoot: string, name: RuleDocumentSource): Promise<string | null> {
    const abs = path.join(canonicalRoot, name);

    // `lstat` — never `stat`: a symlink is NOT a regular file, so any link
    // (inside or outside the repository) fails closed without being
    // followed (spec 19/88). ENOENT is the only "absent".
    let stat: Stats;
    try {
      stat = await this.#fs.lstat(abs);
    } catch (err) {
      if (hasErrno(err, "ENOENT")) {
        return null;
      }
      throw this.#failed(err);
    }
    if (!stat.isFile()) {
      // directory / fifo / socket / device / symlink — fail closed,
      // never treated as absent (spec 20).
      throw this.#failed();
    }

    let bytes: Buffer;
    try {
      bytes = await this.#fs.readFile(abs);
    } catch (err) {
      // Read failure (EACCES/EIO/... or ENOENT after the lstat window) —
      // the resolution FAILED; no fallback to the other file (spec 21).
      throw this.#failed(err);
    }
    if (!isStrictUtf8(bytes)) {
      // Invalid UTF-8 is not decodable content — fail closed, never with
      // replacement characters (spec 18).
      throw this.#failed();
    }

    // A whitespace-only file has no rule content (spec 13). The returned
    // text is the EXACT decoded bytes — no trim, no rewrite (spec 180).
    const text = bytes.toString("utf8");
    return text.trim() === "" ? null : text;
  }

  /** Fixed safe message + developer-channel `cause` (never on the wire). */
  #failed(cause?: unknown): RulesResolutionError {
    return new RulesResolutionError("rules_resolution_failed", RULES_RESOLUTION_FAILED_MESSAGE, {
      cause: cause ?? new Error("rules resolution failed safely (no detail)"),
    });
  }
}
