/**
 * Step 9: `buildHistory` birim testleri (spec 66-88, 96-101).
 *
 * Saf: `PersistedRound[]` + güncel geri bildirim → sınıflandırılmış
 * `ContextHistoryMessage[]`. I/O yok, redaksiyon YOK (assembler'da),
 * determinist. Çiviler:
 * - konuşma repliği sırası: assistant(result_i) → user(feedback_{i+1} + val_i)
 * - her feedback/validation/worker sonucu TAM BİR defa
 * - yalnız en son user mesajı `protected`; worker sonuçları `previous_worker`
 * - redaksiyon/kayıt: worker sonucu JSON'a determinist yazılır, kayıtlı
 *   `WorkerResult` MÜDAHALE EDİLMEZ (spec 98)
 * - boş tur → tek korumalı feedback mesajı (validation YOK)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory } from "../dist/session/history.js";
import type { PersistedRound } from "../dist/session/types.js";
import type {
  CompactResult,
  ValidationResult,
  WorkerResult,
} from "../dist/worker/result.js";

/** `PersistedRound` için en küçük geçerli bileşenleri üretir. */
function makeValidation(requested: number, applied: number, rejected: number): ValidationResult {
  return {
    editsRequested: requested,
    editsApplied: applied,
    rejected: Array.from({ length: rejected }, (_, i) => ({
      file: `f${i}.ts`,
      edit: i,
      reason: `reason-${i}`,
    })),
  };
}

function makeResult(round: number, summary: string, validation: ValidationResult): CompactResult {
  return {
    status: "applied",
    sessionId: "sess",
    round,
    rulesSource: "none",
    context: {
      runtimeMaxTokens: 1,
      inputTokens: 1,
      outputReserveTokens: 1,
      selectedContextTier: "64k",
      truncatedReadonlyContext: false,
    },
    warnings: [],
    summary,
    filesChanged: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    validation,
    usage: { in: 0, out: 0 },
    baseStatus: "fresh",
  };
}

function round(
  round: number,
  feedback: string | undefined,
  summary: string,
  requested: number,
  applied: number,
  rejected: number,
): PersistedRound {
  const validation = makeValidation(requested, applied, rejected);
  const workerResult: WorkerResult = {
    schemaVersion: 1,
    summary,
    edits: [{ kind: "modify", path: `f${round}.ts`, operations: [{ search: `s${round}`, replace: `r${round}` }] }],
  };
  return { round, feedback, workerResult, validation, result: makeResult(round, summary, validation) };
}

/** `needle`'in `haystack` içindeki (birebir) kaç kez geçtiğini sayar. */
function occurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

test("buildHistory: tek tur → assistant(result_1) + korumalı user(current + val_1)", () => {
  const history = buildHistory([round(1, undefined, "did the thing", 3, 3, 0)], "please fix the edge case");
  assert.equal(history.length, 2);
  const assistant = history[0];
  const user = history[1];
  assert.ok(assistant !== undefined && user !== undefined);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.kind, "worker_response");
  assert.equal(assistant.protected, false);
  assert.match(assistant.content, /WORKER RESULT \(round 1\)/);
  assert.match(assistant.content, /"summary":"did the thing"/);
  assert.equal(user.role, "user");
  assert.equal(user.kind, "refinement");
  assert.equal(user.protected, true);
  assert.match(user.content, /REFINEMENT FEEDBACK/);
  assert.match(user.content, /please fix the edge case/);
  assert.match(user.content, /edits_requested: 3/);
  assert.match(user.content, /edits_applied: 3/);
  assert.match(user.content, /rejected: none/);
});

test("buildHistory: çok-tur repliği — her feedback/validation/sonuç birer kez", () => {
  const history = buildHistory(
    [round(1, undefined, "result1", 1, 1, 0), round(2, "fb2", "result2", 2, 1, 1), round(3, "fb3", "result3", 3, 3, 0)],
    "fb4",
  );
  // 3 tur → 6 mesaj (3 assistant + 3 user)
  assert.equal(history.length, 6);
  const all = history.map((m) => m.content).join("\n");
  // Her geri bildirim tam bir kez (replik: fb2→r1 sonrasındaki user, ...)
  assert.equal(occurrences(all, "fb2"), 1);
  assert.equal(occurrences(all, "fb3"), 1);
  assert.equal(occurrences(all, "fb4"), 1);
  // Yalnız en son user mesajı korumalı
  assert.equal(history.filter((m) => m.protected).length, 1);
  assert.equal(history[history.length - 1]?.protected, true);
  assert.equal(history[history.length - 2]?.protected, false);
  // 3 worker sonucu, hiçbiri korumalı değil
  const workers = history.filter((m) => m.kind === "worker_response");
  assert.equal(workers.length, 3);
  assert.ok(workers.every((m) => m.protected === false));
  // redaksiyon/kayıt dokunmadı: red record worker'a taşınır (spec 101)
  assert.match(all, /file=f0\.ts edit=0 reason=reason-0/);
});

test("buildHistory: tur-0 oturumu refine ile 1. tur ürettiyse rounds[0].feedback result_1'den ÖNCE bir kez görünür", () => {
  const history = buildHistory(
    [round(1, "fb1", "result1", 1, 1, 0), round(2, "fb2", "result2", 2, 2, 0)],
    "fb3",
  );
  // user(fb1) → assistant(r1) → user(fb2 + val1) → assistant(r2) → user(fb3 + val2)
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  const first = history[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, "refinement");
  assert.equal(first.protected, false, "eski refinement — azaltma adayı");
  assert.equal(first.content, "REFINEMENT FEEDBACK\nfb1");
  const all = history.map((m) => m.content).join("\n");
  for (const fb of ["fb1", "fb2", "fb3"]) {
    assert.equal(occurrences(all, fb), 1, `${fb} tam bir kez`);
  }
  assert.equal(history.filter((m) => m.protected).length, 1);
  assert.equal(history[history.length - 1]?.protected, true);

  // Tek tur (tur-0 → refine → 1. tur) + güncel geri bildirim.
  const single = buildHistory([round(1, "only-fb1", "r1", 1, 1, 0)], "fb2");
  assert.deepEqual(
    single.map((m) => [m.role, m.kind, m.protected]),
    [
      ["user", "refinement", false],
      ["assistant", "worker_response", false],
      ["user", "refinement", true],
    ],
  );
  assert.equal(single[0]?.content, "REFINEMENT FEEDBACK\nonly-fb1");
});

test("buildHistory: boş tur → tek korumalı feedback mesajı (validation YOK)", () => {
  const history = buildHistory([], "initial correction");
  assert.equal(history.length, 1);
  const message = history[0];
  assert.ok(message !== undefined);
  assert.equal(message.role, "user");
  assert.equal(message.kind, "refinement");
  assert.equal(message.protected, true);
  assert.match(message.content, /REFINEMENT FEEDBACK/);
  assert.match(message.content, /initial correction/);
  assert.ok(!/VALIDATION/.test(message.content));
});

test("buildHistory: worker sonucu kayıtlı WorkerResult'a dokunmaz (spec 98)", () => {
  const source = round(1, undefined, "orig", 1, 1, 0);
  const summaryBefore = source.workerResult.summary;
  buildHistory([source], "fb");
  // Kayıtlı yetkili sonuç MÜDAHALE EDİLMEDİ.
  assert.equal(source.workerResult.summary, summaryBefore);
});
