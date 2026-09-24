/**
 * Step 4: worker çıktı parse/doğrulama testleri (`src/worker/result.ts`).
 *
 * v1 worker çıktı sözleşmesini çiviler: sıkı JSON, `schema_version: 1`,
 * tam alan kümeleri, exact search/replace, duplicate path yasağı — ve
 * parserın repository ANLAMI taşımADIĞI sınırı (Step 5'e aittir).
 *
 * Testler BUILT çıktıyı (dist/) import eder (bkz. package.json pretest).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_SCHEMA_VERSION,
  WorkerContractError,
  parseWorkerResult,
  type CompactResult,
  type DiffStats,
  type SplitHint,
  type ValidationResult,
  type WorkerResult,
} from "../dist/worker/result.js";

/** Geçerli bir parse'ı doğrular; dönen yapıyı teste verir. */
function parseOk(raw: string): WorkerResult {
  return parseWorkerResult(raw);
}

/**
 * `parseWorkerResult`'ın `WorkerContractError` ile reddettiğini doğrular
 * ve HATA MESAJINI döndürür (sır saklama testleri için).
 */
function parseFail(raw: string): string {
  let message = "";
  assert.throws(
    () => {
      parseWorkerResult(raw);
    },
    (err: unknown) => {
      assert.ok(
        err instanceof WorkerContractError,
        `expected WorkerContractError, got: ${String(err)}`,
      );
      assert.equal(err.kind, "invalid_output");
      message = err.message;
      return true;
    },
  );
  return message;
}

/** Üç düzenleme türünü birden içeren geçerli bir yanıt (spec 41). */
function validFullResponse(): string {
  return JSON.stringify({
    schema_version: 1,
    summary: "Updated calculation, added helper, removed obsolete module.",
    edits: [
      {
        kind: "modify",
        path: "src/a.ts",
        operations: [
          { search: "const x = 1;", replace: "const x = 2;" },
          { search: "return x;", replace: "return x + 1;" },
        ],
      },
      { kind: "create", path: "src/new.ts", content: "export const value = 1;\n" },
      { kind: "delete", path: "src/old.ts" },
    ],
  });
}

// ── Geçerli yanıtlar ───────────────────────────────────────────────────────

test("valid response with all three edit kinds parses into the expected normalized structure", () => {
  const result = parseOk(validFullResponse());

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.summary, "Updated calculation, added helper, removed obsolete module.");
  assert.deepEqual(result, {
    schemaVersion: 1,
    summary: "Updated calculation, added helper, removed obsolete module.",
    edits: [
      {
        kind: "modify",
        path: "src/a.ts",
        operations: [
          { search: "const x = 1;", replace: "const x = 2;" },
          { search: "return x;", replace: "return x + 1;" },
        ],
      },
      { kind: "create", path: "src/new.ts", content: "export const value = 1;\n" },
      { kind: "delete", path: "src/old.ts" },
    ],
  });
});

test("WORKER_SCHEMA_VERSION is exactly 1 (no silent migration of other versions)", () => {
  assert.equal(WORKER_SCHEMA_VERSION, 1);
});

test("empty edits array is valid — no fabricated modifications (spec 42)", () => {
  const result = parseOk(
    JSON.stringify({
      schema_version: 1,
      summary: "No change required; the requested behavior is already present.",
      edits: [],
    }),
  );
  assert.deepEqual(result.edits, []);
});

test("summary outer whitespace is trimmed — the only permitted normalization (spec 56)", () => {
  const raw = JSON.stringify({ schema_version: 1, summary: "  padded summary  ", edits: [] });
  assert.equal(parseOk(raw).summary, "padded summary");
});

test("surrounding whitespace around the JSON document is accepted", () => {
  const raw = `  \n${validFullResponse()}\n  `;
  assert.equal(parseOk(raw).edits.length, 3);
});

test("edit and operation order is preserved exactly — no reordering (spec 56)", () => {
  const raw = JSON.stringify({
    schema_version: 1,
    summary: "s",
    edits: [
      { kind: "delete", path: "z.ts" },
      {
        kind: "modify",
        path: "a.ts",
        operations: [
          { search: "second", replace: "2nd" },
          { search: "first", replace: "1st" },
        ],
      },
      { kind: "create", path: "m.ts", content: "" },
    ],
  });
  const result = parseOk(raw);
  assert.deepEqual(result.edits.map((e) => e.path), ["z.ts", "a.ts", "m.ts"]);
  const modify = result.edits[1];
  if (modify?.kind !== "modify") {
    throw new Error("expected the middle edit to be a modify");
  }
  assert.deepEqual(modify.operations.map((o) => o.search), ["second", "first"]);
});

test("each parse builds a fresh structure — no shared references across calls (spec 30)", () => {
  const raw = validFullResponse();
  const first = parseOk(raw);
  const second = parseOk(raw);
  assert.deepEqual(first, second);
  assert.notEqual(first.edits, second.edits);
});

// ── Tam (exact) search/replace baytları ────────────────────────────────────

test("search/replace strings are preserved byte-exactly — no CRLF/indent/trim normalization (spec 57)", () => {
  const search = "  \tconst x = 1;\r\n\t"; // girinti + sekme + CRLF + sonda boşluk
  const replace = "  const x = 2;\r\n";
  const raw = JSON.stringify({
    schema_version: 1,
    summary: "s",
    edits: [
      {
        kind: "modify",
        path: "src/a.ts",
        operations: [{ search, replace }],
      },
    ],
  });
  const result = parseOk(raw);
  const modify = result.edits[0];
  if (modify?.kind !== "modify") {
    throw new Error("expected a modify edit");
  }
  assert.equal(modify.operations[0]?.search, search);
  assert.equal(modify.operations[0]?.replace, replace);
});

test("unicode content is preserved exactly (no unicode normalization)", () => {
  const search = "şöğüçış \u00a0metin";
  const raw = JSON.stringify({
    schema_version: 1,
    summary: "s",
    edits: [{ kind: "create", path: "src/t.ts", content: `${search}\n` }],
  });
  const result = parseOk(raw);
  const create = result.edits[0];
  if (create?.kind !== "create") {
    throw new Error("expected a create edit");
  }
  assert.equal(create.content, `${search}\n`);
});

// ── Bozuk JSON (sıkı belge kuralı) ─────────────────────────────────────────

test("rejects plain non-JSON text; the raw content does not leak into the error (spec 43)", () => {
  const raw = "not json";
  const message = parseFail(raw);
  assert.ok(!message.includes("not json"));
});

test("rejects truncated JSON; the raw content does not leak into the error", () => {
  const raw = '{"schema_version":1,"summary":"x","edits":[{"kind":"modify"';
  const message = parseFail(raw);
  assert.ok(!message.includes("modify"));
});

test("rejects JSON followed by trailing prose (spec 43)", () => {
  const raw = `${validFullResponse()}\nHope this helps!`;
  parseFail(raw);
});

test("rejects JSON preceded by prose", () => {
  const raw = `Here is the patch:\n${validFullResponse()}`;
  parseFail(raw);
});

test("rejects Markdown-fenced JSON — the fence is never stripped (spec 44)", () => {
  const raw = "```json\n" + validFullResponse() + "\n```";
  parseFail(raw);
});

test("rejects non-object JSON documents (array / null / number / string / boolean)", () => {
  for (const raw of ["[1,2]", "null", "42", '"hello"', "true"]) {
    parseFail(raw);
  }
});

test("rejects non-string input without leaking it", () => {
  const message = parseFail(42 as unknown as string);
  assert.ok(!message.includes("42"));
});

// ── schema_version ─────────────────────────────────────────────────────────

test("rejects unknown / wrong-typed / missing schema_version (spec 5, 45)", () => {
  parseFail(JSON.stringify({ schema_version: 2, summary: "x", edits: [] }));
  parseFail(JSON.stringify({ schema_version: "1", summary: "x", edits: [] }));
  parseFail(JSON.stringify({ schema_version: 0, summary: "x", edits: [] }));
  parseFail(JSON.stringify({ summary: "x", edits: [] }));
});

// ── Üst düzey alanlar ──────────────────────────────────────────────────────

test("rejects unknown top-level fields — Splash-owned facts never enter worker output (spec 38, 46)", () => {
  for (const extra of ["files_changed", "status", "usage", "diff_stats", "session_id", "base_status", "validation"]) {
    const raw = JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [],
      [extra]: ["src/a.ts"],
    });
    parseFail(raw);
  }
});

test("rejects missing required top-level fields", () => {
  parseFail(JSON.stringify({ summary: "x", edits: [] }));
  parseFail(JSON.stringify({ schema_version: 1, edits: [] }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "x" }));
});

test("summary must be a non-empty string", () => {
  parseFail(JSON.stringify({ schema_version: 1, summary: 42, edits: [] }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "   ", edits: [] }));
});

test("edits must be an array", () => {
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: "nope" }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: null }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: {} }));
});

// ── Edit türleri ───────────────────────────────────────────────────────────

test("rejects unknown edit kinds (spec 47)", () => {
  const kinds = [
    "rename",
    "move",
    "chmod",
    "execute",
    "command",
    "patch",
    "replace_file",
    "append",
  ];
  for (const kind of kinds) {
    const raw = JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind, path: "a", to: "b" }],
    });
    parseFail(raw);
  }
});

test("modify: empty or missing operations are rejected (spec 48)", () => {
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [] }],
    }),
  );
  parseFail(
    JSON.stringify({ schema_version: 1, summary: "x", edits: [{ kind: "modify", path: "a" }] }),
  );
});

test("modify: operations must be exactly {search, replace}", () => {
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [{ replace: "r" }] }],
    }),
  );
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [
        {
          kind: "modify",
          path: "a",
          operations: [
            { search: "s", replace: "r", mode: 1 },
          ],
        },
      ],
    }),
  );
});

test("modify: search must be a non-empty string", () => {
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [{ search: "", replace: "r" }] }],
    }),
  );
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [{ search: 42, replace: "r" }] }],
    }),
  );
});

test("modify: replace must be a string — but an empty replace is allowed (spec 48)", () => {
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [{ search: "s", replace: 42 }] }],
    }),
  );
  const result = parseOk(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "modify", path: "a", operations: [{ search: "s", replace: "" }] }],
    }),
  );
  const modify = result.edits[0];
  if (modify?.kind !== "modify") {
    throw new Error("expected a modify edit");
  }
  assert.deepEqual(modify.operations[0], { search: "s", replace: "" });
});

test("modify: a complete-file content field is rejected (spec 9)", () => {
  const raw = JSON.stringify({
    schema_version: 1,
    summary: "x",
    edits: [{ kind: "modify", path: "a", content: "entire rewritten file" }],
  });
  parseFail(raw);
});

test("modify: path must be a non-empty string", () => {
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [
        {
          kind: "modify",
          path: "",
          operations: [{ search: "s", replace: "r" }],
        },
      ],
    }),
  );
});

test("create: empty content is valid; missing / non-string content and extra fields are rejected (spec 49)", () => {
  const ok = parseOk(
    JSON.stringify({ schema_version: 1, summary: "x", edits: [{ kind: "create", path: "a", content: "" }] }),
  );
  const create = ok.edits[0];
  if (create?.kind !== "create") {
    throw new Error("expected a create edit");
  }
  assert.equal(create.content, "");

  parseFail(
    JSON.stringify({ schema_version: 1, summary: "x", edits: [{ kind: "create", path: "a" }] }),
  );
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "create", path: "a", content: 42 }],
    }),
  );
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "create", path: "a", content: "c", operations: [] }],
    }),
  );
  parseFail(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [{ kind: "create", path: "a", content: "c", mode: "0755" }],
    }),
  );
});

test("delete: only kind + path are accepted (spec 50)", () => {
  const ok = parseOk(
    JSON.stringify({ schema_version: 1, summary: "x", edits: [{ kind: "delete", path: "a" }] }),
  );
  assert.deepEqual(ok.edits[0], { kind: "delete", path: "a" });

  for (const extra of ["content", "operations", "reason", "search", "replace"]) {
    parseFail(
      JSON.stringify({
        schema_version: 1,
        summary: "x",
        edits: [{ kind: "delete", path: "a", [extra]: "x" }],
      }),
    );
  }
});

test("edits that are not objects are rejected", () => {
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: ["delete a"] }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: [42] }));
  parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits: [null] }));
});

// ── Duplicate hedef yollar ─────────────────────────────────────────────────

test("duplicate target paths are rejected, never auto-merged (spec 51)", () => {
  const op = { search: "s", replace: "r" };
  const cases = [
    // iki modify aynı yol
    [
      { kind: "modify", path: "src/a.ts", operations: [op] },
      { kind: "modify", path: "src/a.ts", operations: [op] },
    ],
    // modify + delete aynı yol
    [
      { kind: "modify", path: "src/a.ts", operations: [op] },
      { kind: "delete", path: "src/a.ts" },
    ],
    // create + create aynı yol
    [
      { kind: "create", path: "src/a.ts", content: "" },
      { kind: "create", path: "src/a.ts", content: "" },
    ],
  ];
  for (const edits of cases) {
    parseFail(JSON.stringify({ schema_version: 1, summary: "x", edits }));
  }
  // farklı yollar geçerlidir
  parseOk(
    JSON.stringify({
      schema_version: 1,
      summary: "x",
      edits: [
        { kind: "modify", path: "src/a.ts", operations: [op] },
        { kind: "delete", path: "src/a.ts " },
        { kind: "create", path: "src/a.tsx", content: "" },
      ],
    }),
  );
});

// ── SINIR: parser repository anlamı taşımaz (spec 55) ──────────────────────

test("structurally valid paths parse regardless of repository safety — path semantics belong to Step 5 Workspace Manager", () => {
  // Step 4'ın repository/workspace bilgisi YOKTUR: `..` kaçışı, mutlak yol
  // ve salt-okunur referans yolu yapısal olarak geçerlidir ve parser
  // KABUL EDER. Güvenliği Step 5 (allow-list, path bounds) sağlar. Bu test
  // ileride WorkerContract'a workspace sorumluluğu karışmasını çiviler.
  const result = parseOk(
    JSON.stringify({
      schema_version: 1,
      summary: "s",
      edits: [
        { kind: "modify", path: "../foo.ts", operations: [{ search: "a", replace: "b" }] },
        { kind: "create", path: "/absolute/foo.ts", content: "x" },
        { kind: "delete", path: "readonly-reference.ts" },
      ],
    }),
  );
  assert.equal(result.edits.length, 3);
});

// ── Hata sırrı (spec 54) ───────────────────────────────────────────────────

test("error messages never leak worker-generated payload", () => {
  const MARKER = "SUPER_SECRET_GENERATED_SOURCE";
  // (1) bozuk JSON içindeki marker
  const truncated = `{"schema_version":1,"summary":"${MARKER}"`;
  const m1 = parseFail(truncated);
  assert.ok(!m1.includes(MARKER), `leak via truncated JSON: ${m1}`);
  // (2) yapısal hata + marker'lı summary (alan kümesi hatası)
  const structural = JSON.stringify({
    schema_version: 1,
    summary: MARKER,
    edits: [],
    files_changed: [MARKER],
  });
  const m2 = parseFail(structural);
  assert.ok(!m2.includes(MARKER), `leak via structural error: ${m2}`);
  // (3) desteklenmeyen kind + marker'lı path
  const kind = JSON.stringify({
    schema_version: 1,
    summary: "x",
    edits: [{ kind: "execute", path: MARKER, command: MARKER }],
  });
  const m3 = parseFail(kind);
  assert.ok(!m3.includes(MARKER), `leak via kind error: ${m3}`);
});

// ── Compact result tipleri (spec 31-33) ────────────────────────────────────

test("compact-result types: the discriminated union shape compiles as designed", () => {
  const base = {
    sessionId: "opaque",
    round: 1,
    baseStatus: "fresh" as const,
    rulesSource: "CLAUDE.md" as const,
    context: {
      runtimeMaxTokens: 262144,
      inputTokens: 100000,
      outputReserveTokens: 65536,
      selectedContextTier: "192k" as const,
      truncatedReadonlyContext: false,
    },
    warnings: [],
  };
  const outcome = {
    summary: "...",
    filesChanged: ["src/foo.ts"],
    diffStats: { files: 1, insertions: 10, deletions: 2 } satisfies DiffStats,
    validation: {
      editsRequested: 2,
      editsApplied: 2,
      rejected: [{ file: "src/foo.ts", edit: 1, reason: "match not unique" }],
    } satisfies ValidationResult,
    usage: { in: 100000, out: 5000 },
  };

  const applied: CompactResult = { ...base, ...outcome, status: "applied" };
  const staleBase: CompactResult = {
    ...base,
    ...outcome,
    baseStatus: "stale",
    status: "stale_base",
    staleFiles: ["src/foo.ts"],
  };
  const needsSplit: CompactResult = {
    ...base,
    ...outcome,
    status: "needs_split",
    splitHint: {
      requiredInputTokens: 300000,
      availableMaxTokens: 262144,
      outputReserveTokens: 32768,
      pressureFiles: ["src/huge.ts"],
    } satisfies SplitHint,
  };
  const busy: CompactResult = {
    ...base,
    ...outcome,
    status: "inference_busy",
    inference: { conflict: "mlx" },
  };

  assert.equal(applied.status, "applied");
  assert.equal(staleBase.status, "stale_base");
  assert.equal(needsSplit.status, "needs_split");
  assert.equal(busy.status, "inference_busy");
});

test("compact-result types: invalid constructions are rejected at compile time", () => {
  const base = {
    sessionId: "opaque",
    round: 1,
    baseStatus: "fresh" as const,
    rulesSource: "none" as const,
    context: {
      runtimeMaxTokens: 1,
      inputTokens: 1,
      outputReserveTokens: 1,
      selectedContextTier: "64k" as const,
      truncatedReadonlyContext: false,
    },
    warnings: [],
  };
  const outcome = {
    summary: "",
    filesChanged: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    validation: { editsRequested: 0, editsApplied: 0, rejected: [] },
    usage: { in: 0, out: 0 },
  };

  // Not: `@ts-expect-error` yalnız bir SONRAKİ satırdaki hatayı bastırdığı
  // için geçersiz literal'lar TEK SATIRDA yazılır.
  // @ts-expect-error — needs_split without splitHint must not construct
  const missingHint: CompactResult = { ...base, ...outcome, status: "needs_split" };
  // @ts-expect-error — inference_busy without inference metadata must not construct
  const missingInference: CompactResult = { ...base, ...outcome, status: "inference_busy" };
  // @ts-expect-error — stale_base without staleFiles must not construct
  const missingStale: CompactResult = { ...base, ...outcome, status: "stale_base" };
  // @ts-expect-error — splitHint is not part of the "applied" shape
  const strayHint: CompactResult = { ...base, ...outcome, status: "applied", splitHint: { requiredInputTokens: 1, availableMaxTokens: 1, outputReserveTokens: 1, pressureFiles: [] } };
  // @ts-expect-error — unknown status literal
  const badStatus: CompactResult = { ...base, ...outcome, status: "weird" };
  // @ts-expect-error — unknown conflict literal (second conflict enum is forbidden)
  const badConflict: CompactResult = { ...base, ...outcome, status: "inference_busy", inference: { conflict: "other" } };
  // @ts-expect-error — rules source is a closed vocabulary
  const badRules: CompactResult = { ...base, ...outcome, status: "applied", rulesSource: "CLAUDE.md and AGENTS.md" };

  // runtime: the accepted shapes behave as typed
  assert.equal(missingHint.status, "needs_split");
  assert.equal(missingInference.status, "inference_busy");
  assert.equal(missingStale.status, "stale_base");
  assert.equal(strayHint.status, "applied");
  assert.equal(badStatus.status, "weird");
  assert.equal(badConflict.status, "inference_busy");
  assert.equal(badRules.rulesSource, "CLAUDE.md and AGENTS.md");
});

test("compact-result base freshness: baseStatus and staleFiles cannot contradict (Fix 2)", () => {
  const base = {
    sessionId: "opaque",
    round: 3,
    rulesSource: "none" as const,
    context: {
      runtimeMaxTokens: 262144,
      inputTokens: 1000,
      outputReserveTokens: 32768,
      selectedContextTier: "64k" as const,
      truncatedReadonlyContext: false,
    },
    warnings: [],
  };
  const outcome = {
    summary: "done",
    filesChanged: ["src/a.ts"],
    diffStats: { files: 1, insertions: 2, deletions: 1 } satisfies DiffStats,
    validation: {
      editsRequested: 1,
      editsApplied: 1,
      rejected: [],
    } satisfies ValidationResult,
    usage: { in: 50, out: 60 },
  };

  // GEÇERLİ — fresh ⇔ staleFiles yok:
  const validFresh: CompactResult = { ...base, ...outcome, status: "applied", baseStatus: "fresh" };
  // GEÇERLİ — stale ⇔ staleFiles var:
  const validStale: CompactResult = { ...base, ...outcome, status: "applied", baseStatus: "stale", staleFiles: ["src/a.ts"] };
  // GEÇERLİ — stale_base stale OLARAK TANIMLANIR (DESIGN.md 3): stale + staleFiles:
  const validStaleBase: CompactResult = { ...base, ...outcome, status: "stale_base", baseStatus: "stale", staleFiles: ["src/a.ts"] };
  // GEÇERLİ — needs_split / inference_busy tasarım gereği HER ZAMAN fresh
  // (tur kapısı önce; stale olsaydı stale_base olurdu): baseStatus DIRECT
  // olarak girer — spread ile değil (M5 pini: union üyesinden alan
  // silinse de direct literal yine hatasıyla yakalanır):
  const needsSplitFresh: CompactResult = { ...base, ...outcome, status: "needs_split", baseStatus: "fresh", splitHint: { requiredInputTokens: 1, availableMaxTokens: 1, outputReserveTokens: 1, pressureFiles: [] } };
  const busyFresh: CompactResult = { ...base, ...outcome, status: "inference_busy", baseStatus: "fresh", inference: { conflict: "splash" } };
  void validFresh;
  void validStale;
  void validStaleBase;
  void needsSplitFresh;
  void busyFresh;

  // Not: `@ts-expect-error` yalnız bir SONRAKİ satırdaki hatayı bastırdığı
  // için çelişkili literal'lar TEK SATIRDA yazılır.
  // @ts-expect-error — fresh taban staleFiles TAŞIYAMAZ
  const freshWithStaleFiles: CompactResult = { ...base, ...outcome, status: "applied", baseStatus: "fresh", staleFiles: ["src/a.ts"] };
  // @ts-expect-error — stale taban staleFiles'sİZ kurulamaz
  const staleWithoutFiles: CompactResult = { ...base, ...outcome, status: "applied", baseStatus: "stale" };
  // @ts-expect-error — stale_base fresh OLAMAZ
  const staleBaseFresh: CompactResult = { ...base, ...outcome, status: "stale_base", baseStatus: "fresh" };
  // @ts-expect-error — stale_base + fresh + staleFiles (çifte çelişki)
  const staleBaseFreshWithFiles: CompactResult = { ...base, ...outcome, status: "stale_base", baseStatus: "fresh", staleFiles: ["src/a.ts"] };
  // @ts-expect-error — needs_split: tur kapısı (stale-base denetimi) assembly ÖNCE; stale olsaydı stale_base olurdu ⇒ her zaman fresh
  const needsSplitStale: CompactResult = { ...base, ...outcome, status: "needs_split", baseStatus: "stale", staleFiles: ["src/a.ts"], splitHint: { requiredInputTokens: 1, availableMaxTokens: 1, outputReserveTokens: 1, pressureFiles: [] } };
  // @ts-expect-error — inference_busy: dispatch denetimin ARKASINDA ⇒ her zaman fresh
  const busyStale: CompactResult = { ...base, ...outcome, status: "inference_busy", baseStatus: "stale", staleFiles: ["src/a.ts"], inference: { conflict: "splash" } };

  // runtime: literal'lar tip hatalı olsa da inşaa edilebilir (type-level test)
  assert.equal(freshWithStaleFiles.status, "applied");
  assert.equal(staleWithoutFiles.status, "applied");
  assert.equal(staleBaseFresh.status, "stale_base");
  assert.equal(staleBaseFreshWithFiles.status, "stale_base");
  assert.equal(needsSplitStale.status, "needs_split");
  assert.equal(busyStale.status, "inference_busy");
});

// ── Tam (exact) anahtar kümesi pinleri — audit takibi ─────────────────────
//
// Parserın tek koruması `hasExactKeySet`'in UZUNLUK kontrolüdür; bu
// testler o korumayı ve bağlı ham-JSON davranışlarını ÇİVİLER (davranış
// değiştirilmez — pinlenir):
// - `JSON.parse` bir `__proto__` anahtarını normal (OWN) özellik olarak
//   oluşturur; 4 üst düzey anahtar ≠ 3 beklenen anahtar → red.
// - Gelecekte naive bir kopya (`Object.assign` / spread) `__proto__`
//   değerini prototype zincirine taşıyabilir — Object.prototype bütünlüğü
//   her red sonrası ayrıca doğrulanır.

test("top-level __proto__ / constructor / toJSON keys are rejected and never pollute Object.prototype", () => {
  for (const key of ["__proto__", "constructor", "toJSON"]) {
    // NOT: ham belge STRING olarak kurulur — JS nesne literal'ında
    // `{ __proto__: ... }` prototype'u ayarlar, own property oluşturmaz;
    // JSON metninde ise `__proto__` normal veridir (JSON.parse bunu
    // own property olarak oluşturur).
    const raw = `{"schema_version":1,"summary":"x","edits":[],"${key}":{"pollutedMarker":true}}`;
    const message = parseFail(raw);
    assert.equal(message, "Worker output contains unexpected fields");
    // Reddedilen parse'ın ardından Object.prototype BÜTÜN olmalı:
    // taze nesne marker'ı görmez, prototip o marker'ı sahiplenmez.
    const empty: Record<string, unknown> = {};
    assert.equal(empty["pollutedMarker"], undefined);
    assert.equal(Object.hasOwn(Object.prototype, "pollutedMarker"), false);
  }
});

test("extra / __proto__ keys inside modify, create, delete entries and modify operations are each rejected", () => {
  const cases: Array<[raw: string, expectedMessage: string]> = [
    // modify girdisi: düz fazladan anahtar
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"modify","path":"a","operations":[{"search":"s","replace":"r"}],"mode":1}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // modify girdisi: __proto__
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"modify","path":"a","operations":[{"search":"s","replace":"r"}],"__proto__":{"pollutedMarker":true}}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // create girdisi: düz fazladan anahtar
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"create","path":"a","content":"c","mode":"0755"}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // create girdisi: __proto__
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"create","path":"a","content":"c","__proto__":{"pollutedMarker":true}}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // delete girdisi: düz fazladan anahtar
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"delete","path":"a","reason":"x"}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // delete girdisi: __proto__
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"delete","path":"a","__proto__":{"pollutedMarker":true}}]}',
      "edits[0] has unexpected or missing fields",
    ],
    // modify operasyon nesnesi: düz fazladan anahtar
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"modify","path":"a","operations":[{"search":"s","replace":"r","mode":1}]}]}',
      "edits[0].operations[0] has unexpected or missing fields",
    ],
    // modify operasyon nesnesi: __proto__
    [
      '{"schema_version":1,"summary":"x","edits":[{"kind":"modify","path":"a","operations":[{"search":"s","replace":"r","__proto__":{"pollutedMarker":true}}]}]}',
      "edits[0].operations[0] has unexpected or missing fields",
    ],
  ];
  for (const [raw, expectedMessage] of cases) {
    const message = parseFail(raw);
    assert.equal(message, expectedMessage);
    // Aynı bütünlük garantisi her varyantta: Object.prototype marker
    // sahiplenmez, taze nesne marker'ı görmez.
    const empty: Record<string, unknown> = {};
    assert.equal(empty["pollutedMarker"], undefined);
    assert.equal(Object.hasOwn(Object.prototype, "pollutedMarker"), false);
  }
});

test("schema_version 1.0 is accepted — JSON number 1.0 IS the number 1 (=== 1 pinned)", () => {
  // JSON metni `1.0` → JS sayı değeri `1`; parser değeri `=== 1` ile
  // (yazı dizgisiyle değil) karşılaştırır. Bu kabul pinlenir: ileride
  // "1.0 ayrı bir sürüm" gibi bir gerekçeyle reddedilemez.
  const result = parseOk('{"schema_version":1.0,"summary":"s","edits":[]}');
  assert.equal(result.schemaVersion, 1);
});

test("duplicate JSON object keys: the last value wins (pinned, not changed)", () => {
  // `JSON.parse` cift anahtarda SON değeri alır: `1`'den sonra `2`
  // geldiği için belge `schema_version: 2` olarak GÖRÜLÜR ve desteklen-
  // mey sürüm olarak reddedilir (yapısal bir "cift anahtar" hatası
  // değil). Bu davranış pinlenir, değiştirilmez.
  const message = parseFail('{"schema_version":1,"schema_version":2,"summary":"x","edits":[]}');
  assert.equal(message, "Worker output has an unsupported schema_version");
});
