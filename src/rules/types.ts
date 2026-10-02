/**
 * Step 8: Project rules — type contracts + typed error (DESIGN.md §6, 11 m.8).
 *
 * This file carries only types and the typed error — no I/O, no formatting,
 * no tokenization. The split of responsibilities (Step 8 spec 3):
 *
 * - `RulesResolver` (RulesResolver.ts) = WHERE the rules come from
 *   (hook/session payload first; otherwise root CLAUDE.md / AGENTS.md).
 * - `ContextAssembler` = redaction + soft-budget measurement + safe
 *   compaction of the resolved rules (src/context/rules.ts + assembler).
 *
 * Security discipline (DESIGN.md §9): `RulesResolutionError.message` is
 * FIXED and short — no path, no file content, no raw errno text, no rule
 * material. Technical detail (`cause`) is developer-channel only and never
 * travels to the MCP wire.
 */

import type { Stats } from "node:fs";
import type { RulesSource } from "../worker/result.js";

// ── Resolved rules representation (Step 8 spec 15) ──────────────────────────

/**
 * Single rule document sources. `hook` = session/hook-supplied rules
 * (splash_task `options.rules`); the two repository file names are the
 * complete, closed discovery vocabulary (root only — no crawling).
 */
export type RuleDocumentSource = "hook" | "CLAUDE.md" | "AGENTS.md";

/**
 * One resolved rule document.
 * - `content` is the EXACT decoded text (byte-faithful: CRLF/tabs/
 *   indentation/final newline preserved; never trimmed or rewritten).
 * - For repository files the bytes were strict-UTF-8 validated at read time;
 *   redaction is NOT applied here — the Context Assembler redacts each
 *   document before any measurement or model-visible formatting, so raw
 *   secret values never reach the tokenizer or the prompt.
 */
export interface RuleDocument {
  readonly source: RuleDocumentSource;
  readonly content: string;
}

/**
 * The result of one rules resolution (once per task session).
 * - `source: "none"` ⇔ `documents: []` — the worker prompt omits the
 *   PROJECT RULES section entirely.
 * - Repository document order is deterministic: CLAUDE.md before AGENTS.md
 *   (never filesystem/mtime/alphabetical discovery order).
 * - The provenance (`source`) is the final, closed `RulesSource` vocabulary
 *   (DESIGN.md §6) and is reported truthfully on every compact result —
 *   while the rules CONTENT is never returned on the wire.
 */
export interface ResolvedRules {
  readonly source: RulesSource;
  readonly documents: readonly RuleDocument[];
}

// ── Resolver input / DI surface ─────────────────────────────────────────────

/**
 * One `resolve` call: a single task session's rules resolution.
 * - `suppliedRules`: session/hook-supplied rules from
 *   `splash_task.options.rules`. Whitespace-only (or absent) input is NOT a
 *   valid supplied payload — it falls back to repository discovery (trim is
 *   used solely for emptiness detection; a valid payload is preserved
 *   byte-for-byte).
 * - `repoRoot`: the canonical Git repository root ALREADY discovered by the
 *   task layer — the resolver never re-discovers Git and never accepts a
 *   rule-specific root.
 *
 * No `AbortSignal` surface: the resolver's work is bounded, local and
 * read-only (at most one `realpath`, two `lstat`, two `readFile` per call —
 * `node:fs/promises` reads are not signal-aware, so there is nothing
 * cancellable to observe). Request cancellation is respected where it is
 * real: the Context Assembler forwards the signal to the runtime operations
 * it performs for the rules (tokenization/measurement) and to the inference
 * dispatch (DESIGN.md: no inference after abort).
 */
export interface RulesResolverInput {
  suppliedRules?: string;
  repoRoot: string;
}

/**
 * Read-only rules filesystem surface — the test seam (Step 8 spec 170).
 * Exactly the three read operations rules discovery needs; the interface
 * itself is the boundary (no write/rename/unlink/member of any kind).
 * Production default: `node:fs/promises`. No mutable module-global seam.
 *
 * Step 9 hardening (spec 49): the production `readFile` member is the shared
 * no-follow safe read (`workspace/SafeRepoReader.noFollowReadFile` —
 * `open(O_RDONLY|O_NOFOLLOW)` → same-handle read), NOT a link-following read.
 * The `lstat` → `readFile` call SEQUENCE is unchanged, so all Step 8 call
 * counts / call-surface guards remain valid (spec 297); the race is closed
 * because the content read itself is no-follow. Test seams implement `readFile`
 * as scripted and model the race by making it fail with `ELOOP`.
 */
export interface RulesFs {
  lstat(target: string): Promise<Stats>;
  /** Safe content read — no-follow in production (spec 48/49). */
  readFile(target: string): Promise<Buffer>;
  realpath(target: string): Promise<string>;
}

/** Structural view of the resolver for dependency injection (spec 171). */
export interface RulesResolverLike {
  resolve(input: RulesResolverInput): Promise<ResolvedRules>;
}

// ── Typed rules error ───────────────────────────────────────────────────────

/**
 * Closed error vocabulary (kept deliberately small — Step 8 spec 25). Every
 * safe-failure of the resolution chain (non-regular entry, any I/O failure
 * other than ENOENT, invalid UTF-8, uncertain root canonicalization,
 * cancellation) is this one kind with one fixed message: the public surface
 * can distinguish "rules could not be resolved safely" without any
 * filesystem detail.
 */
export type RulesResolutionErrorKind = "rules_resolution_failed";

/**
 * Rules resolution failed safely (fail-closed). `message` is a fixed, safe
 * constant — no absolute path, no file content, no raw errno. `cause`
 * (developer channel) may carry the original error for logs; `serializeToolError`
 * maps kind + message only, so nothing technical reaches the MCP wire.
 */
export class RulesResolutionError extends Error {
  constructor(
    readonly kind: RulesResolutionErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    // `cause` comes from here (ES2022 Error); the field is not re-declared.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RulesResolutionError";
  }
}

/** Fixed public message — the ONLY message in this vocabulary. */
export const RULES_RESOLUTION_FAILED_MESSAGE =
  "Project rules could not be resolved safely";
