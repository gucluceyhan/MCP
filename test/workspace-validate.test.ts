/**
 * Step 5: semantik doğrulama testleri (`src/workspace/validate.ts` — saf modül).
 *
 * Gerçek git/dosya YOK — yalnızca immutable base verisi + `WorkerResult`.
 * Çiviler (spec 41-57, 81-84, 86, 87): allow-list, readonly, path güvenliği,
 * tam eşleşme (0/1/2 + örtüşme), aralık örtüşmesi, kanonik alias, hiyerarşi
 * çakışması, binary-red, order-bağımsızlık, partial kabul, red-metadata
 * güvenliği (search/replace/içerik asla nedende taşınmaz).
 *
 * Testler BUILT çıktıyı (dist/) import eder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModifyEdit, WorkerEdit, WorkerResult } from "../dist/worker/result.js";
import type { PathFingerprint } from "../dist/workspace/Workspace.js";
import {
  INVALID_PATH_PLACEHOLDER,
  REJECTION_REASONS,
  countOccurrences,
  validateWorkerResult,
  type WorkspaceBase,
} from "../dist/workspace/validate.js";

// ── base kurma yardımcıları ─────────────────────────────────────────────────

function fileFingerprint(mode = "100644", content = "x"): PathFingerprint {
  return { exists: true, type: "file", mode, contentSha256: Buffer.from(content, "utf8").toString("hex") };
}

function baseFrom(
  editable: Record<string, string>,
  readonly: string[] = [],
  basePaths: Record<string, string> = {},
): WorkspaceBase {
  const editableMap = new Map<string, PathFingerprint>();
  const editableContent = new Map<string, Buffer>();
  for (const [p, content] of Object.entries(editable)) {
    editableMap.set(p, fileFingerprint());
    editableContent.set(p, Buffer.from(content, "utf8"));
  }
  // basePaths: editable + readonly + verilenler (varolan her şey)
  const bp = new Map<string, string>();
  for (const [p] of Object.entries(editable)) bp.set(p, "100644");
  for (const p of readonly) bp.set(p, "100644");
  for (const [p, mode] of Object.entries(basePaths)) bp.set(p, mode);
  return {
    editable: editableMap,
    editableContent,
    readonly: new Set(readonly),
    basePaths: bp,
  };
}

function resultOf(...edits: WorkerEdit[]): WorkerResult {
  return { schemaVersion: 1, summary: "test", edits };
}

function modify(p: string, ...ops: [string, string][]): ModifyEdit {
  return { kind: "modify", path: p, operations: ops.map(([search, replace]) => ({ search, replace })) };
}

function create(p: string, content = "new"): WorkerEdit {
  return { kind: "create", path: p, content };
}

function del(p: string): WorkerEdit {
  return { kind: "delete", path: p };
}

/** Red nedenlerini (edit index sırasıyla) döndürür. */
function reasons(base: WorkspaceBase, ...edits: WorkerEdit[]): string[] {
  return validateWorkerResult(base, resultOf(...edits)).result.rejected.map((r) => r.reason);
}

// ── allow-list (spec 81) ────────────────────────────────────────────────────

const ALLOW = baseFrom(
  { "src/a.ts": "alpha\n" },
  ["src/reference.ts"],
  { "src/secret.ts": "100644" },
);

test("allow-list: modify/delete editable accepted; read-only and other paths rejected (spec 81)", () => {
  const v = validateWorkerResult(ALLOW, resultOf(modify("src/a.ts", ["alpha", "beta"])));
  assert.equal(v.result.editsApplied, 1);
  assert.equal(v.result.rejected.length, 0);

  assert.deepEqual(reasons(ALLOW, modify("src/reference.ts", ["x", "y"])), [REJECTION_REASONS.readOnlyPath]);
  assert.deepEqual(reasons(ALLOW, del("src/reference.ts")), [REJECTION_REASONS.readOnlyPath]);
  assert.deepEqual(reasons(ALLOW, modify("src/secret.ts", ["x", "y"])), [REJECTION_REASONS.pathNotEditable]);
  assert.deepEqual(reasons(ALLOW, del("src/secret.ts")), [REJECTION_REASONS.pathNotEditable]);
  // create: editable set ÜYESİ olmak ZORUNLU DEĞİL — yeni güvenli yol serbest
  const c = validateWorkerResult(ALLOW, resultOf(create("src/new.ts")));
  assert.equal(c.result.editsApplied, 1);
});

// ── path güvenliği + red metadata (spec 41/42, 79) ─────────────────────────

test("unsafe worker path: rejected with placeholder file — raw path is NOT echoed (spec 42)", () => {
  const v = validateWorkerResult(ALLOW, resultOf(modify("../outside.ts", ["x", "y"])));
  assert.equal(v.result.editsApplied, 0);
  assert.equal(v.result.rejected.length, 1);
  assert.equal(v.result.rejected[0]!.reason, REJECTION_REASONS.unsafePath);
  assert.equal(v.result.rejected[0]!.file, INVALID_PATH_PLACEHOLDER);
  assert.notEqual(v.result.rejected[0]!.file, "../outside.ts");
});

test("unsafe .git / absolute / windows forms all reject with the same safe reason", () => {
  const evil = [modify(".git/config", ["x", "y"]), modify("/abs.ts", ["x", "y"]), modify("C:\\x.ts", ["x", "y"])];
  const v = validateWorkerResult(ALLOW, resultOf(...evil));
  assert.equal(v.result.rejected.length, 3);
  for (const r of v.result.rejected) {
    assert.equal(r.reason, REJECTION_REASONS.unsafePath);
    assert.equal(r.file, INVALID_PATH_PLACEHOLDER);
  }
});

// ── varlık / tip (spec 43/44, 49, 85) ──────────────────────────────────────

test("modify of an absent base target: target missing", () => {
  assert.deepEqual(reasons(baseFrom({}), modify("nope.ts", ["x", "y"])), [REJECTION_REASONS.targetMissing]);
});

test("modify of a base symlink is rejected (never followed — spec 49)", () => {
  const base: WorkspaceBase = {
    editable: new Map([["link.ts", { exists: true, type: "symlink", mode: "120000", contentSha256: "aa" }]]),
    editableContent: new Map(),
    readonly: new Set<string>(),
    basePaths: new Map([["link.ts", "120000"]]),
  };
  assert.deepEqual(reasons(base, modify("link.ts", ["x", "y"])), [REJECTION_REASONS.targetNotTextFile]);
  // silinebilir (link'in kendisi)
  const v = validateWorkerResult(base, resultOf(del("link.ts")));
  assert.equal(v.result.editsApplied, 1);
});

test("modify of a base binary (invalid UTF-8) is rejected — no corruption (spec 32/33, 85)", () => {
  const base: WorkspaceBase = {
    editable: new Map([["bin.dat", { exists: true, type: "file", mode: "100644", contentSha256: "bb" }]]),
    editableContent: new Map([["bin.dat", Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x42])]]),
    readonly: new Set<string>(),
    basePaths: new Map([["bin.dat", "100644"]]),
  };
  assert.deepEqual(reasons(base, modify("bin.dat", ["x", "y"])), [REJECTION_REASONS.targetNotTextFile]);
  // binary DOSYA silinebilir (path-only)
  const v = validateWorkerResult(base, resultOf(del("bin.dat")));
  assert.equal(v.result.editsApplied, 1);
});

test("delete of an absent base target: target missing", () => {
  assert.deepEqual(reasons(baseFrom({}), del("nope.ts")), [REJECTION_REASONS.targetMissing]);
});

// ── create varlıksızlığı / önek zinciri (spec 44/47) ────────────────────────

test("create over an existing base path (file / symlink / directory) is rejected (spec 44)", () => {
  const base = baseFrom({}, [], { "new": "100644", "sym": "120000" });
  assert.deepEqual(reasons(base, create("new")), [REJECTION_REASONS.createAlreadyExists]);
  assert.deepEqual(reasons(base, create("sym")), [REJECTION_REASONS.createAlreadyExists]);
  // dizin: base'te "dir/x" var → "dir" bir dizindir → create "dir" red
  assert.deepEqual(reasons(baseFrom({}, [], { "dir/x": "100644" }), create("dir")), [
    REJECTION_REASONS.createAlreadyExists,
  ]);
});

test("create whose ancestor is a base FILE is rejected (unrepresentable target)", () => {
  const base = baseFrom({}, [], { "a": "100644" });
  assert.deepEqual(reasons(base, create("a/child.ts")), [REJECTION_REASONS.createAlreadyExists]);
});

test("create whose ancestor is a base SYMLINK is rejected as unsafe symlink traversal (spec 48)", () => {
  const base = baseFrom({}, [], { "link": "120000" });
  assert.deepEqual(reasons(base, create("link/evil.ts")), [REJECTION_REASONS.unsafeSymlink]);
});

// ── tam eşleşme (spec 51/52, 82) ────────────────────────────────────────────

test("countOccurrences counts overlapping occurrences (spec 51)", () => {
  assert.equal(countOccurrences("aaa", "aa"), 2); // 0. ve 1.
  assert.equal(countOccurrences("abcabc", "abc"), 2);
  assert.equal(countOccurrences("abc", "abc"), 1);
  assert.equal(countOccurrences("abc", "z"), 0);
  assert.equal(countOccurrences("aaaa", "aa"), 3); // 0. ve 1. ve 2. — örtüşen
});

test("exact match: 0 → rejected, 1 → accepted, 2 → rejected (spec 82)", () => {
  const base = baseFrom({ "src/a.ts": "const x = 1;\nconst x = 1;\n" });
  assert.deepEqual(reasons(base, modify("src/a.ts", ["const y = 9;", "const y = 10;"])), [
    REJECTION_REASONS.searchNotFound(1),
  ]);
  const ok = validateWorkerResult(base, resultOf(modify("src/a.ts", ["const x = 1;", "const x = 2;"])));
  assert.equal(ok.result.rejected.length, 1); // 2 eşleşme → benzersiz değil
  assert.equal(ok.result.rejected[0]!.reason, REJECTION_REASONS.matchNotUnique(1));

  const baseOnce = baseFrom({ "src/a.ts": "const x = 1;\n" });
  const good = validateWorkerResult(baseOnce, resultOf(modify("src/a.ts", ["const x = 1;", "const x = 2;"])));
  assert.equal(good.result.editsApplied, 1);
  assert.equal(good.result.rejected.length, 0);
});

test("overlapping occurrence 'aaa'/'aa' is NOT unique (spec 51 example)", () => {
  const base = baseFrom({ "f.txt": "aaa" });
  const v = validateWorkerResult(base, resultOf(modify("f.txt", ["aa", "X"])));
  assert.equal(v.result.rejected[0]!.reason, REJECTION_REASONS.matchNotUnique(1));
});

// ── aralık örtüşmesi (spec 53, 83) ──────────────────────────────────────────

test("non-overlapping (adjacent) operations apply; overlapping ones reject the whole edit (spec 83)", () => {
  const base = baseFrom({ "f.txt": "abcdefghij" });

  const adjacent = validateWorkerResult(base, resultOf(modify("f.txt", ["abc", "ABC"], ["hij", "HIJ"])));
  assert.equal(adjacent.result.editsApplied, 1);
  assert.equal(adjacent.result.rejected.length, 0);
  assert.equal(adjacent.plan[0]!.content?.toString("utf8"), "ABCdefgHIJ");

  // [0,3) + [1,3) → örtüşme
  const overlap = validateWorkerResult(base, resultOf(modify("f.txt", ["abc", "X"], ["bc", "Y"])));
  assert.equal(overlap.result.editsApplied, 0);
  assert.equal(overlap.result.rejected[0]!.reason, REJECTION_REASONS.overlappingEdits);

  // aynı aralık iki kez → örtüşme
  const identical = validateWorkerResult(base, resultOf(modify("f.txt", ["def", "X"], ["def", "Y"])));
  assert.equal(identical.result.rejected[0]!.reason, REJECTION_REASONS.overlappingEdits);
});

// ── validate-before-mutate (spec 39, 87) ────────────────────────────────────

test("a modify with one invalid op is fully rejected — nothing is planned (spec 87)", () => {
  const base = baseFrom({ "f.txt": "alpha beta gamma" });
  const v = validateWorkerResult(
    base,
    resultOf(modify("f.txt", ["alpha", "ALPHA"], ["MISSING", "X"])),
  );
  assert.equal(v.result.editsApplied, 0);
  assert.equal(v.plan.length, 0); // kabul edilen plan YOK — operasyon 0 da uygulanmaz
  assert.equal(v.result.rejected[0]!.reason, REJECTION_REASONS.searchNotFound(2));
});

// ── kanonik alias + hiyerarşi (spec 46/47) ──────────────────────────────────

test("canonical aliases (src/foo.ts ≡ src/./foo.ts) are detected — both rejected, order-independent (spec 46)", () => {
  const base = baseFrom({ "src/foo.ts": "v1\n" });
  const r1 = validateWorkerResult(
    base,
    resultOf(modify("src/foo.ts", ["v1", "A"]), modify("src/./foo.ts", ["v1", "B"])),
  );
  const r2 = validateWorkerResult(
    base,
    resultOf(modify("src/./foo.ts", ["v1", "B"]), modify("src/foo.ts", ["v1", "A"])),
  );
  // Sıra BAĞIMSIZ: her iki düzenleme de red (aynı hedef)
  assert.equal(r1.result.editsApplied, 0);
  assert.equal(r2.result.editsApplied, 0);
  assert.deepEqual(
    r1.result.rejected.map((x) => [x.edit, x.reason].join("|")),
    r2.result.rejected.map((x) => [x.edit, x.reason].join("|")).sort(),
  );
  for (const rej of r1.result.rejected) {
    assert.equal(rej.reason, REJECTION_REASONS.pathConflict);
  }
});

test("hierarchy conflict: create file + create inside it → both rejected (spec 47)", () => {
  const base = baseFrom({});
  const v = validateWorkerResult(base, resultOf(create("new"), create("new/file.ts")));
  assert.equal(v.result.editsApplied, 0);
  assert.equal(v.result.rejected.length, 2);
  assert.equal(v.result.rejected[0]!.reason, REJECTION_REASONS.pathConflict);
  assert.equal(v.result.rejected[1]!.reason, REJECTION_REASONS.pathConflict);
});

test("hierarchy conflict: delete A + create A/child → both rejected (no hidden order-dependent transform, spec 47)", () => {
  const base = baseFrom({ a: "content\n" });
  const v = validateWorkerResult(base, resultOf(del("a"), create("a/child.txt")));
  assert.equal(v.result.editsApplied, 0);
  assert.equal(v.result.rejected.length, 2);
});

test("sibling paths (no ancestor relation) are not a hierarchy conflict", () => {
  const base = baseFrom({ "a/b.ts": "x\n", "a/c.ts": "y\n" });
  const v = validateWorkerResult(base, resultOf(modify("a/b.ts", ["x", "X"]), modify("a/c.ts", ["y", "Y"])));
  assert.equal(v.result.editsApplied, 2);
  assert.equal(v.result.rejected.length, 0);
});

// ── order-bağımsız uygulama (spec 54, 84) ───────────────────────────────────

test("same ops in opposite order produce byte-identical output (spec 84)", () => {
  const base = baseFrom({ "f.txt": "abcdefghij" });
  const v1 = validateWorkerResult(base, resultOf(modify("f.txt", ["abc", "111"], ["hij", "222"])));
  const v2 = validateWorkerResult(base, resultOf(modify("f.txt", ["hij", "222"], ["abc", "111"])));
  assert.ok(Buffer.from(v1.plan[0]!.content ?? "").equals(Buffer.from(v2.plan[0]!.content ?? "")));
  assert.equal(v1.plan[0]!.content?.toString("utf8"), "111defg222");
});

// ── partial kabul + sayaçlar (spec 40, 57, 86) ──────────────────────────────

test("partial acceptance: valid edits apply, invalid ones are reported (spec 86)", () => {
  // Not: Step 4 parserı LİTERAL aynı yola giren iki düzenlemeyi zaten parse
  // anında reddeder; semantik katman alias'larla (farklı literal, aynı
  // kanonik) karşılaşır — test de farklı literal yollarla kurulur.
  const base = baseFrom({ "a.ts": "one\ntwo\n", "b.ts": "beta\n" });
  const v = validateWorkerResult(
    base,
    resultOf(modify("a.ts", ["two", "TWO"]), modify("b.ts", ["beta", "beta"])),
  );
  assert.equal(v.result.editsApplied, 2);
  assert.equal(v.result.rejected.length, 0);

  const base2 = baseFrom({ "a.ts": "one\ntwo\n", "b.ts": "beta\nbeta\n" });
  const v2 = validateWorkerResult(
    base2,
    resultOf(
      modify("a.ts", ["two", "TWO"]), // 1 eşleşme → geçerli
      modify("b.ts", ["beta", "X"]), // 2 eşleşme → red
      create("c.txt", "gamma\n"), // geçerli
    ),
  );
  assert.equal(v2.result.editsRequested, 3);
  assert.equal(v2.result.editsApplied, 2);
  assert.equal(v2.result.rejected.length, 1);
  assert.equal(v2.result.rejected[0]!.reason, REJECTION_REASONS.matchNotUnique(1));
  // red edilen hedef plan'da YOK; geçerli olanlar var
  assert.ok(!v2.plan.some((p) => p.canonical === "b.ts"));
  assert.ok(v2.plan.some((p) => p.canonical === "a.ts"));
  assert.ok(v2.plan.some((p) => p.canonical === "c.txt"));
});

test("empty edits: valid no-op round (Step 4 kontratı)", () => {
  const v = validateWorkerResult(baseFrom({ a: "x\n" }), resultOf());
  assert.equal(v.result.editsRequested, 0);
  assert.equal(v.result.editsApplied, 0);
  assert.equal(v.result.rejected.length, 0);
});

// ── red metadata GÜVENLİĞİ: worker payload'ı sızdırılmaz (spec 41) ──────────

test("rejection reasons never contain the search/replace content or source bytes (spec 41)", () => {
  const marker = "UNIQUE-MARKER-DO-NOT-LEAK-9f8a7b";
  const base = baseFrom({ "src/a.ts": `const secret = "${marker}";\n` });
  const v = validateWorkerResult(
    base,
    resultOf(modify("src/a.ts", [`${marker}`, "REPLACED"])),
  );
  // 1 eşleşme → bu aslında kabul edilir; red için 0-eşleşme senaryosu:
  const v2 = validateWorkerResult(
    base,
    resultOf(modify("src/a.ts", ["definitely-not-there-${marker}", "x"])),
  );
  const dump = JSON.stringify(v.result.rejected) + JSON.stringify(v2.result);
  assert.ok(!dump.includes(marker), `marker leaked into validation metadata: ${dump}`);
});
