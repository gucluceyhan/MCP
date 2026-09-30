/**
 * Step 6: wire serileştirme testleri (spec 107/108/58-59).
 *
 * Saf birim testleri — hiçbir I/O yok: handcrafted `CompactResult` +
 * tip'li hatalar → MCP wire JSON'u.
 *
 * Çiviler:
 * - 107: iç camelCase tip hiçbir şekilde MCP wire'ına sızmaz; DESIGN §3
 *   snake_case vocabulary birebir; `JSON.stringify(result)` (camelCase) değil.
 * - 108: koşullu alanlar yalnız anlamlı durumda; `null` ile boşta YOK — omit.
 * - 58/59: bilinen tip'li hataların güvenli sözlüğü korunur; bilinmeyen
 *   istisna → `internal_error` / sabit mesaj; `cause`/stack/payload ASLA yok.
 */
import { ContextAssemblyError } from "../dist/context/types.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeCompactResult,
  serializeToolError,
} from "../dist/task/wire.js";
import { BackendError } from "../dist/backend/errors.js";
import { CoordinatorError } from "../dist/backend/InferenceCoordinator.js";
import { WorkspaceError } from "../dist/workspace/Workspace.js";
import { WorkerContractError, type CompactResult } from "../dist/worker/result.js";
import { SplashTaskError } from "../dist/task/SplashTaskService.js";

// ── fixture'lar ──────────────────────────────────────────────────────────────

function appliedResult(): CompactResult {
  return {
    sessionId: "sess-1",
    round: 1,
    status: "applied",
    baseStatus: "fresh",
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 100_000,
      inputTokens: 1_234,
      outputReserveTokens: 32_768,
      selectedContextTier: "runtime_max",
      truncatedReadonlyContext: false,
    },
    summary: "Implemented the thing.",
    filesChanged: ["src/a.ts", "src/b.ts"],
    diffStats: { files: 2, insertions: 34, deletions: 12 },
    validation: {
      editsRequested: 3,
      editsApplied: 3,
      rejected: [{ file: "src/c.ts", edit: 1, reason: "search text not found at operation 0" }],
    },
    warnings: ["Sensitive values were redacted from the context."],
    usage: { in: 1_234, out: 256 },
  };
}

function busyResult(conflict: "splash" | "mlx" | "ollama" | "unknown" = "mlx"): CompactResult {
  return {
    sessionId: "sess-2",
    round: 1,
    status: "inference_busy",
    baseStatus: "fresh",
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 0,
      inputTokens: 0,
      outputReserveTokens: 32_768,
      selectedContextTier: "runtime_max",
      truncatedReadonlyContext: false,
    },
    inference: { conflict },
    summary: "Inference is temporarily unavailable; no worker generation was run.",
    filesChanged: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
    warnings: [],
    usage: { in: 0, out: 0 },
  };
}

function staleBaseResult(): CompactResult {
  return {
    sessionId: "sess-3",
    round: 2,
    status: "stale_base",
    baseStatus: "stale",
    staleFiles: ["src/a.ts"],
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 100_000,
      inputTokens: 0,
      outputReserveTokens: 32_768,
      selectedContextTier: "runtime_max",
      truncatedReadonlyContext: false,
    },
    summary: "The base drifted; the round was aborted before inference.",
    filesChanged: ["src/a.ts"],
    diffStats: { files: 1, insertions: 3, deletions: 1 },
    validation: { editsRequested: 1, editsApplied: 1, rejected: [] },
    warnings: [],
    usage: { in: 10, out: 20 },
  };
}

function needsSplitResult(): CompactResult {
  return {
    sessionId: "sess-4",
    round: 1,
    status: "needs_split",
    baseStatus: "fresh",
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 32_000,
      inputTokens: 0,
      outputReserveTokens: 32_768,
      selectedContextTier: "runtime_max",
      truncatedReadonlyContext: false,
    },
    splitHint: {
      requiredInputTokens: 60_000,
      availableMaxTokens: 32_000,
      outputReserveTokens: 32_768,
      pressureFiles: ["src/big.ts"],
      suggestedGroups: [["src/big.ts"], ["src/other.ts"]],
    },
    summary: "The required context does not fit; split the task.",
    filesChanged: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
    warnings: [],
    usage: { in: 0, out: 0 },
  };
}

/** Nesne ağacının TÜM anahtarlarını (iç içe dahil) toplar. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, into);
    }
  }
  return into;
}

// ── 107: wire casing ─────────────────────────────────────────────────────────

test("107: applied result serializes to DESIGN §3 snake_case vocabulary — no camelCase anywhere", () => {
  const wire = serializeCompactResult(appliedResult());

  // Her alan snake_case (DESIGN §3):
  assert.deepEqual(Object.keys(wire).sort(), [
    "base_status",
    "context",
    "diff_stats",
    "files_changed",
    "round",
    "rules_source",
    "session_id",
    "status",
    "summary",
    "usage",
    "validation",
    "warnings",
  ]);
  assert.equal(wire.session_id, "sess-1");
  assert.equal(wire.status, "applied");
  assert.equal(wire.base_status, "fresh");
  assert.equal(wire.rules_source, "none");
  assert.deepEqual(wire.context, {
    runtime_max_tokens: 100_000,
    input_tokens: 1_234,
    output_reserve_tokens: 32_768,
    selected_context_tier: "runtime_max",
    truncated_readonly_context: false,
  });
  assert.deepEqual(wire.diff_stats, { files: 2, insertions: 34, deletions: 12 });
  assert.deepEqual(wire.usage, { in: 1_234, out: 256 });
  const validation = wire.validation as {
    edits_requested: number;
    edits_applied: number;
    rejected: Array<{ file: string; edit: number; reason: string }>;
  };
  assert.deepEqual(validation, {
    edits_requested: 3,
    edits_applied: 3,
    rejected: [{ file: "src/c.ts", edit: 1, reason: "search text not found at operation 0" }],
  });

  // İÇ camelCase tip'in hiçbir alanı sızmadı:
  const keys = collectKeys(wire);
  for (const camel of [
    "sessionId",
    "baseStatus",
    "rulesSource",
    "runtimeMaxTokens",
    "inputTokens",
    "outputReserveTokens",
    "selectedContextTier",
    "truncatedReadonlyContext",
    "filesChanged",
    "diffStats",
    "editsRequested",
    "editsApplied",
  ]) {
    assert.ok(!keys.has(camel), `camelCase key "${camel}" leaked into the wire`);
  }

  // `JSON.stringify(result)` yerine açık eşleme: text payload JSON geçerli.
  const text = JSON.stringify(wire);
  assert.ok(text.includes('"session_id":"sess-1"'));
  assert.ok(!text.includes('"sessionId"'));
});

// ── 108: koşullu alanlar ─────────────────────────────────────────────────────

test("108: applied → conditional fields ABSENT (no inference, no split_hint, no stale_files, no null)", () => {
  const wire = serializeCompactResult(appliedResult());
  assert.ok(!("inference" in wire));
  assert.ok(!("split_hint" in wire));
  assert.ok(!("stale_files" in wire));
  const text = JSON.stringify(wire);
  assert.ok(!text.includes("null"), "no field is nulled to signal absence");
});

test("108: inference_busy → `inference` present; no split_hint / stale_files", () => {
  const wire = serializeCompactResult(busyResult("mlx"));
  assert.deepEqual(wire.inference, { conflict: "mlx" });
  assert.equal(wire.status, "inference_busy");
  assert.ok(!("split_hint" in wire));
  assert.ok(!("stale_files" in wire));
});

test("108: stale_base → `stale_files` present; no inference / split_hint", () => {
  const wire = serializeCompactResult(staleBaseResult());
  assert.deepEqual(wire.stale_files, ["src/a.ts"]);
  assert.equal(wire.base_status, "stale");
  assert.ok(!("inference" in wire));
  assert.ok(!("split_hint" in wire));
});

test("108: needs_split → `split_hint` present (suggested_groups nested); no inference / stale_files", () => {
  const wire = serializeCompactResult(needsSplitResult());
  assert.deepEqual(wire.split_hint, {
    required_input_tokens: 60_000,
    available_max_tokens: 32_000,
    output_reserve_tokens: 32_768,
    pressure_files: ["src/big.ts"],
    suggested_groups: [["src/big.ts"], ["src/other.ts"]],
  });
  assert.ok(!("inference" in wire));
  assert.ok(!("stale_files" in wire));
});

// ── 58/59: güvenli hata serileştirme ─────────────────────────────────────────

test("58: BackendError http → kind + safe message + status", () => {
  const err = new BackendError(
    "http",
    "Inference request failed with HTTP status 500 (/v1/chat/completions)",
    { status: 500, cause: "RESPONSE_BODY_FRAGMENT_WITH_SECRET" },
  );
  const wire = serializeToolError(err);
  assert.deepEqual(wire, {
    kind: "http",
    message: "Inference request failed with HTTP status 500 (/v1/chat/completions)",
    status: 500,
  });
  assert.ok(!JSON.stringify(wire).includes("RESPONSE_BODY_FRAGMENT_WITH_SECRET"));
});

test("58: BackendError network → no status field (only meaningful for http)", () => {
  const err = new BackendError("network", "Could not reach the inference runtime", {
    cause: new Error("connect ECONNREFUSED 127.0.0.1:8000"),
  });
  const wire = serializeToolError(err);
  assert.deepEqual(wire, { kind: "network", message: "Could not reach the inference runtime" });
  assert.ok(!("status" in wire));
  assert.ok(!JSON.stringify(wire).includes("ECONNREFUSED"));
});

test("59: CoordinatorError kinds preserved verbatim (safe vocabulary)", () => {
  for (const kind of ["aborted", "invalid_request", "lock_release_failed"] as const) {
    const err = new CoordinatorError(kind, "A safe fixed message");
    assert.deepEqual(serializeToolError(err), { kind, message: "A safe fixed message" });
  }
});

test("59: WorkspaceError kinds preserved verbatim", () => {
  const err = new WorkspaceError("invalid_repository", "The project root is not a valid Git working tree");
  assert.deepEqual(serializeToolError(err), {
    kind: "invalid_repository",
    message: "The project root is not a valid Git working tree",
  });
});

test("59: WorkerContractError kinds preserved verbatim", () => {
  assert.deepEqual(serializeToolError(new WorkerContractError("invalid_output", "Worker output is not valid JSON")), {
    kind: "invalid_output",
    message: "Worker output is not valid JSON",
  });
});

test("59: ContextAssemblyError kinds preserved verbatim (safe fixed messages)", () => {
  for (const [kind, message] of [
    ["invalid_input", "The requested context tier exceeds the runtime maximum"],
    ["unsafe_path", "A selected path is unsafe"],
    ["assembly_failed", "Reading the read-only context failed"],
  ] as Array<["invalid_input" | "unsafe_path" | "assembly_failed", string]>) {
    const err = new ContextAssemblyError(kind, message, {
      cause: new Error("fs errno + repo path + raw I/O fragment"),
    });
    const wire = serializeToolError(err);
    assert.deepEqual(wire, { kind, message });
    assert.ok(!JSON.stringify(wire).includes("errno") && !JSON.stringify(wire).includes("fs"));
  }
});

test("59: SplashTaskError kinds preserved verbatim (incl. task_cleanup_failed)", () => {
  const err = new SplashTaskError("task_cleanup_failed", "Task cleanup failed", {
    cause: new Error("git stderr with a path and source fragment"),
  });
  const wire = serializeToolError(err);
  assert.deepEqual(wire, { kind: "task_cleanup_failed", message: "Task cleanup failed" });
  assert.ok(!JSON.stringify(wire).includes("git stderr"));
});

test("59: unknown exceptions never surface their payload → internal_error", () => {
  // Arbitrary Error: mesajı keyfi payload taşır (worker çıktısı vb.) — yüzeye YOK.
  const sneaky = new Error("SUPER_SECRET_WORKER_OUTPUT_LEAK");
  const wire = serializeToolError(sneaky);
  assert.deepEqual(wire, { kind: "internal_error", message: "Internal Splash error" });
  assert.ok(!JSON.stringify(wire).includes("SUPER_SECRET"));
  // Error OLMAYAN istisnalar da aynı güvenli yol:
  assert.deepEqual(serializeToolError("a raw string throw"), {
    kind: "internal_error",
    message: "Internal Splash error",
  });
  assert.deepEqual(serializeToolError(null), { kind: "internal_error", message: "Internal Splash error" });
});
