/**
 * Step 8: project rules — pure prompt-side helpers (DESIGN.md §5/6, 11 m.8).
 *
 * Responsibility boundary (Step 8 spec 3): the Context Assembler owns what
 * happens to the RESOLVED rules inside the context package. This file is
 * the pure half of that ownership — no I/O, no tokenization, no backend,
 * no clock:
 *
 * - `formatRuleDocuments` — the model-visible RULES SOURCE blocks. The
 *   content is byte-exact (CRLF/tabs/indentation/final newline preserved;
 *   NEVER trimmed or rewritten — same discipline as the Worker Contract's
 *   PROJECT RULES wrapper): only the fixed markers are added around each
 *   document, and documents are joined with a blank line.
 * - `dedupeRuleDocuments` — the ONLY compaction the soft budget may apply:
 *   exact-duplicate documents (byte-identical AFTER redaction) collapse to
 *   their first occurrence. Unique rule material is never touched — safety
 *   never silently loses rules (DESIGN.md §5/6).
 *
 * Security note (DESIGN.md §9): both helpers operate on ALREADY-REDACTED
 * documents (the assembler redacts each document before calling them), so
 * no raw secret value can enter the formatted text or a duplicate key.
 */

import type { RuleDocument } from "../rules/types.js";

/**
 * Fixed warning vocabulary for the rules soft budget (Step 8) — event type
 * only: no source content, no path, no file name, no count (DESIGN.md §9).
 */
export const RULES_COMPACTION_WARNING =
  "Project rules were compacted by removing exact duplicate rule material.";
export const RULES_OVER_BUDGET_WARNING =
  "Project rules exceed the configured soft budget; unique rule material was preserved.";

/**
 * One RULES SOURCE block for one rule document:
 *
 *   ===== RULES SOURCE: <source> =====
 *   <content — byte-exact, no trim>
 *   ===== END RULES SOURCE: <source> =====
 *
 * `<source>` is the document's own provenance (`hook` / `CLAUDE.md` /
 * `AGENTS.md`). Documents are joined with exactly one blank line; the order
 * of the input array is preserved verbatim (the resolver already ordered
 * them deterministically: hook first, then CLAUDE.md, then AGENTS.md).
 *
 * Empty input → `""` (the Worker Contract omits the PROJECT RULES section
 * for blank rule text — the worker prompt then has no rules block at all).
 *
 * A document whose bytes happen to contain a marker line is passed through
 * unchanged: the markers are formatting, not a quoting boundary — the
 * contract's structural safety text (Worker Contract) is what keeps any
 * such content in its data-only place.
 */
export function formatRuleDocuments(documents: readonly RuleDocument[]): string {
  if (documents.length === 0) {
    return "";
  }
  return documents
    .map((doc) => `===== RULES SOURCE: ${doc.source} =====\n${doc.content}\n===== END RULES SOURCE: ${doc.source} =====`)
    .join("\n\n");
}

/**
 * Deterministic exact-duplicate compaction (the ONLY safe compaction):
 * byte-identical documents (content AFTER redaction) collapse to their
 * FIRST occurrence; input order is otherwise preserved.
 *
 * - `kept` — the surviving documents, in original relative order.
 * - `removed` — how many exact duplicates were dropped (0 = no duplicates;
 *   the caller then keeps everything and reports the over-budget warning).
 *
 * This never drops a unique document: two different rule texts can never
 * be "redundant" with each other without a model in the loop, and Step 8
 * has no model in the loop (DESIGN.md §6: "compacted deterministically
 * where safe").
 */
export function dedupeRuleDocuments(documents: readonly RuleDocument[]): {
  kept: RuleDocument[];
  removed: number;
} {
  const seen = new Set<string>();
  const kept: RuleDocument[] = [];
  let removed = 0;
  for (const doc of documents) {
    if (seen.has(doc.content)) {
      removed += 1;
      continue;
    }
    seen.add(doc.content);
    kept.push(doc);
  }
  return { kept, removed };
}
