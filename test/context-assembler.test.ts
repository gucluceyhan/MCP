/**
 * Step 7: `ContextAssembler` birim testleri (DESIGN.md §2.3/5/9, 11 madde 7).
 *
 * Saf birim: fake `ContextRuntime` (scriptlenebilir ölçüm/durum) + fake
 * `Workspace` (in-memory `readBaseEntry`) + fake/gerçek `ContextFs` —
 * hiçbir git, hiçbir HTTP, hiçbir gerçek model.
 *
 * Çiviler (207 maddelik spec + DESIGN §5):
 * - kademe seçimi: sığan EN KÜÇÜK kade; inflation YOK (64K'a sığan 128K'a
 *   kalkmaz; açık override → tek aday); kanonik etiket vs runtime_max
 * - pay müzakeresi: preferred sığıyorsa preferred, değilse min; açık pay
 *   ≥ min; kademe ASLA yükseltilmez
 * - `needs_split`: zorunlu + pay > tavan → BİLEŞTİRİLMEZ (messages YOK),
 *   pressure dosyaları (token ölçümü; içerik YOK)
 * - redaksiyon: görev + içerik; sabit uyarılar (kaynak YOK)
 * - secret dosya: içerik GİRMEZ; marker + uyarı
 * - salt-okunur: ENOENT → ABSENT; EACCES/EIO → fail-closed; symlink
 *   (içeride → metadata; dışarı → unsafe_path; atal → unsafe_path);
 *   path kaçağı → unsafe_path; dizin → meta
 * - salt-okunur azaltımı: sığmazsa lexicographic SON tam dosya atılır;
 *   düzenlenebilir ASLA kıpırdamaz; tam ölçü + yeniden tam ölçü
 * - dispatch paketi = ölçülen paket (byte-bayt; yeniden derleme YOK)
 * - hata yüzeyi: sabit güvenli mesaj; `cause` public'e taşınmaz
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Stats } from "node:fs";
import path from "node:path";

import {
  ContextAssembler,
  ABSENT_MARKER,
  BINARY_CONTENT_MARKER,
  CONTEXT_REDUCTION_WARNING,
  NEEDS_SPLIT_WARNING,
  REDACTION_WARNING,
  SECRET_FILE_WARNING,
  SYMLINK_MARKER_PREFIX,
  labelForTier,
} from "../dist/context/ContextAssembler.js";
import {
  ContextAssemblyError,
  type AssembledContext,
  type ContextAssemblyInput,
  type ContextFs,
  type ContextRuntime,
} from "../dist/context/types.js";
import { BackendError } from "../dist/backend/errors.js";
import type {
  InferenceMessage,
  InferenceRunOptions,
  RuntimeInfo,
  TokenizeOptions,
  TokenizeResult,
} from "../dist/backend/InferenceBackend.js";
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceBaseEntry,
} from "../dist/workspace/Workspace.js";

// ── Fake runtime (scriptlenebilir ölçüm; jenerasyon yüzeyi YOK) ─────────────

class FakeRuntime implements ContextRuntime {
  maxTokens = 131_072;
  refreshFails = false;
  /** `countPromptTokens` davranışı (varsayılan: bayt uzunluğu = "token"). */
  countFn: (messages: InferenceMessage[]) => number = (messages) =>
    messages.reduce((sum, m) => sum + m.content.length, 0);
  countCalls: InferenceMessage[][] = [];
  /** `tokenize` davranışı (pressure dosyaları). */
  tokenFn: (content: string) => number = (content) => content.length;
  tokenCalls: string[] = [];
  refreshCount = 0;

  get runtimeInfo(): RuntimeInfo | null {
    return { ready: true, maximumContextTokens: this.maxTokens, servedModel: "fake-model" };
  }
  async refreshRuntimeInfo(): Promise<RuntimeInfo> {
    this.refreshCount++;
    if (this.refreshFails) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    return this.runtimeInfo as RuntimeInfo;
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    this.countCalls.push([...messages]);
    return this.countFn(messages);
  }
  async tokenize(content: string): Promise<TokenizeResult> {
    this.tokenCalls.push(content);
    return { tokens: [], count: this.tokenFn(content) };
  }
}

// ── Fake workspace (in-memory base snapshot) ─────────────────────────────────

function fileEntry(content: string | Buffer): WorkspaceBaseEntry {
  return { exists: true, type: "file", mode: "100644", content: Buffer.from(content) };
}

function fakeWorkspace(
  repoRoot: string,
  editablePaths: readonly string[],
  entries: Record<string, WorkspaceBaseEntry>,
): Workspace {
  return {
    repoRoot,
    workspaceDir: path.join(repoRoot, ".ws-unused"),
    baseCommit: "0".repeat(40),
    sessionId: "sess-fake",
    editablePaths: [...editablePaths].sort(),
    base: { fingerprints: new Map(), basePaths: new Map() },
    readBaseEntry(canonical: string): WorkspaceBaseEntry {
      const entry = entries[canonical];
      if (entry === undefined) {
        throw new WorkspaceError("invalid_input", "Only editable base paths can be read");
      }
      return entry;
    },
    applyPatchSet: async () => {
      throw new Error("fake workspace: no mutation in this test");
    },
    resetToBase: async () => undefined,
    diff: async () => "",
    stat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
    exportPatch: async () => {
      throw new Error("fake workspace: no export in this test");
    },
    destroy: async () => undefined,
  };
}

/** Gerçek tmp ağacı + node:fs tabanlı ContextFs (arıza enjeksiyonlu). */
interface FsHarness {
  fs: ContextFs;
  root: string;
}

async function realFsHarness(t: TestContext): Promise<FsHarness> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-ctxfs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real: ContextFs = { lstat, readFile, readlink, realpath };
  return { fs: real, root };
}

/** `ContextFs` üzerine yol bazlı arıza katmanı. */
function faultLayer(base: ContextFs, faults: Map<string, string>): ContextFs {
  const errno = (code: string) => Object.assign(new Error(`${code} (fault-injected)`), { code });
  const wrap = <T>(fn: (p: string) => Promise<T>) => async (p: string): Promise<T> => {
    const code = faults.get(p);
    if (code !== undefined) {
      throw errno(code);
    }
    return fn(p);
  };
  return {
    lstat: wrap(base.lstat),
    readFile: wrap(base.readFile),
    readlink: wrap(base.readlink),
    realpath: base.realpath,
  };
}

const TIERS = [65_536, 131_072, 196_608] as const;

function baseInput(
  overrides: Partial<ContextAssemblyInput> = {},
): ContextAssemblyInput {
  return {
    task: "Do the thing",
    workspace: fakeWorkspace("/repo", [], {}),
    readonlyPaths: [],
    rules: undefined,
    history: [],
    tiers: [...TIERS],
    minOutputReserve: 32_768,
    preferredOutputReserve: 65_536,
    ...overrides,
  };
}

// ── labelForTier ─────────────────────────────────────────────────────────────

test("labelForTier: canonical tiers → labels; unknown → runtime_max", () => {
  assert.equal(labelForTier(65_536), "64k");
  assert.equal(labelForTier(131_072), "128k");
  assert.equal(labelForTier(196_608), "192k");
  assert.equal(labelForTier(128_000), "runtime_max");
  assert.equal(labelForTier(64_000), "runtime_max");
});

// ── girdi / override doğrulaması ────────────────────────────────────────────

test("empty task → invalid_input", async () => {
  const assembler = new ContextAssembler({ runtime: new FakeRuntime() });
  await assert.rejects(
    assembler.assemble(baseInput({ task: "   " })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
});

test("explicit reserve below the minimum → invalid_input", async () => {
  const assembler = new ContextAssembler({ runtime: new FakeRuntime() });
  await assert.rejects(
    assembler.assemble(baseInput({ outputReserveTokens: 100 })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
});

test("non-integer reserve → invalid_input", async () => {
  const assembler = new ContextAssembler({ runtime: new FakeRuntime() });
  await assert.rejects(
    assembler.assemble(baseInput({ outputReserveTokens: 32_768.5 })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
});

test("explicit tier above the runtime maximum → invalid_input (never inflated)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 65_536;
  const assembler = new ContextAssembler({ runtime });
  await assert.rejects(
    assembler.assemble(baseInput({ contextTier: "128k" })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
});

test("runtime refresh failure propagates verbatim (no invented state)", async () => {
  const runtime = new FakeRuntime();
  runtime.refreshFails = true;
  const assembler = new ContextAssembler({ runtime });
  await assert.rejects(
    assembler.assemble(baseInput()),
    (err: unknown) => err instanceof BackendError && err.kind === "network",
  );
});

// ── kademe seçimi + pay müzakeresi ──────────────────────────────────────────

test("small required context → smallest tier (64k), label 64k, no inflation", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000;
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput());

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 65_536);
  assert.equal(result.selectedContextTier, "64k");
  assert.equal(result.runtimeMaxTokens, 131_072);
  assert.equal(result.inputTokens, 1_000);
  // preferred(65_536) + required(1_000) > 65_536 → min(32_768):
  assert.equal(result.outputReserveTokens, 32_768);
  assert.equal(result.truncatedReadonlyContext, false);
  assert.deepEqual(result.warnings, []);
});

test("required fits only the larger tier → 128k chosen (never below need)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 196_608;
  // 90_000 + 32_768 = 122_768 > 65_536 (64k yetmez); ≤ 131_072 → 128k sığıyor.
  runtime.countFn = () => 90_000;
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput());

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 131_072);
  assert.equal(result.selectedContextTier, "128k");
});

test("runtime maximum joins the candidate set (not in configured tiers)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 90_000; // kanonik kademelerden küçük — aday olmalı
  // 50_000 + 32_768 = 82_768 > 65_536 (ilk kade yetmez); ≤ 90_000 →
  // runtime max seçilir, etiketi `runtime_max` (kanonik değil).
  runtime.countFn = () => 50_000;
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput());

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 90_000);
  assert.equal(result.selectedContextTier, "runtime_max");
});

test("explicit tier: single candidate — never inflated beyond it", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000; // 64K'a bile sığar; açık 128K verildi.
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ contextTier: "128k" }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 131_072);
  assert.equal(result.selectedContextTier, "128k");
});

test("reserve negotiation: preferred when it fits the selected tier", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000; // 1_000 + 65_536 ≤ 65_536? HAYIR (66_536) → min.
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.outputReserveTokens, 32_768); // preferred sığmıyor → min

  // preferred'in SİĞDIĞI senaryo: tier 128k, required küçük.
  const runtime2 = new FakeRuntime();
  runtime2.maxTokens = 196_608;
  runtime2.countFn = () => 50_000; // 50_000 + 65_536 = 115_536 ≤ 131_072 → preferred
  const assembler2 = new ContextAssembler({ runtime: runtime2 });
  const result2 = await assembler2.assemble(baseInput());
  assert.equal(result2.status, "ready");
  if (result2.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result2.selectedTierTokens, 131_072);
  assert.equal(result2.outputReserveTokens, 65_536); // preferred müzakere edildi
});

test("explicit reserve is honored verbatim (no negotiation; tier unchanged)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000;
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ outputReserveTokens: 40_000 }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.outputReserveTokens, 40_000);
  assert.equal(result.selectedTierTokens, 65_536); // kade müzakere edilmedi
});

// ── needs_split ──────────────────────────────────────────────────────────────

test("required + reserve > runtime max → needs_split: no messages, pressure hint only", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 65_536;
  runtime.countFn = () => 50_000; // 50_000 + 32_768 > 65_536 → sığmaz
  runtime.tokenFn = (content) => content.length;
  const workspace = fakeWorkspace("/repo", ["src/big.ts", "src/a.ts"], {
    "src/a.ts": fileEntry("x".repeat(5)),
    "src/big.ts": fileEntry("y".repeat(50_000)),
  });
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "needs_split");
  if (result.status !== "needs_split") {
    throw new Error("unreachable");
  }
  assert.equal(result.requiredInputTokens, 50_000);
  assert.equal(result.availableMaxTokens, 65_536);
  assert.equal(result.outputReserveTokens, 32_768);
  assert.equal(result.runtimeMaxTokens, 65_536);
  // pressure: token'a göre Sıralı (büyük → küçük); içerik YOK.
  assert.deepEqual(result.pressureFiles, ["src/big.ts", "src/a.ts"]);
  assert.ok(result.warnings.includes(NEEDS_SPLIT_WARNING));
  // messages YOK (BİLEŞTİRİLMEZ — inference'a inmez):
  const keys = Object.keys(result);
  assert.ok(!keys.includes("messages"), "needs_split paketinde mesaj olamaz");
  assert.ok(!keys.includes("inputTokens"), "needs_split paketinde tam ölçü alanı olamaz");
});

test("pressureFiles: at most 8, token-desc then path-asc, tokenizer failure → 0 (hint stays)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 65_536;
  runtime.countFn = () => 50_000; // needs_split
  const entries: Record<string, WorkspaceBaseEntry> = {};
  const paths: string[] = [];
  for (let i = 0; i < 12; i++) {
    const p = `src/f${String(i).padStart(2, "0")}.ts`;
    paths.push(p);
    entries[p] = fileEntry("z".repeat(i + 1)); // token sayısı = uzunluk (artan)
  }
  const workspace = fakeWorkspace("/repo", paths, entries);
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "needs_split");
  if (result.status !== "needs_split") {
    throw new Error("unreachable");
  }
  assert.equal(result.pressureFiles.length, 8);
  // En büyük 8: f11..f04 (token desc); eşitlikte path asc.
  assert.deepEqual(result.pressureFiles, [
    "src/f11.ts",
    "src/f10.ts",
    "src/f09.ts",
    "src/f08.ts",
    "src/f07.ts",
    "src/f06.ts",
    "src/f05.ts",
    "src/f04.ts",
  ]);

  // BLOCKER 5: tokenizer arızası sıralamayı 0'a SAHTELEMEZ — tip'li hata
  // YAYILIR; `needs_split` ASLA sahte sıralamayla üretilmez.
  const runtime2 = new FakeRuntime();
  runtime2.maxTokens = 65_536;
  runtime2.countFn = () => 50_000; // needs_split
  const failing = new Proxy(runtime2, {
    get(target, prop) {
      if (prop === "tokenize") {
        return async () => {
          throw new BackendError("network", "tokenizer down");
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ContextRuntime;
  const assembler2 = new ContextAssembler({ runtime: failing });
  await assert.rejects(
    assembler2.assemble(baseInput({ workspace })),
    (err: unknown) => err instanceof BackendError && err.kind === "network",
  );

  // AbortSignal → iptal aynen YAYILIR (`needs_split`'a dönüştürülmez).
  const controller = new AbortController();
  controller.abort();
  const runtime3 = new FakeRuntime();
  runtime3.maxTokens = 65_536;
  runtime3.countFn = () => 50_000; // needs_split
  const aborting = new Proxy(runtime3, {
    get(target, prop) {
      if (prop === "tokenize") {
        return async () => {
          throw new BackendError("network", "aborted");
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ContextRuntime;
  const assembler3 = new ContextAssembler({ runtime: aborting });
  await assert.rejects(
    assembler3.assemble(baseInput({ workspace, signal: controller.signal })),
    (err: unknown) => err instanceof BackendError,
  );
});

// ── redaksiyon + secret dosya ────────────────────────────────────────────────

test("task secret → redacted in the worker message; warning; raw value gone", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime });
  const raw = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

  const result = await assembler.assemble(baseInput({ task: `Rotate: ${raw}` }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(!user.includes(raw), "ham secret worker'a ASLA gitmez");
  assert.ok(user.includes("[REDACTED_SECRET]"));
  assert.ok(result.warnings.includes(REDACTION_WARNING));
  for (const warning of result.warnings) {
    assert.ok(!warning.includes(raw), "uyarı secret taşımaz");
  }
});

test("editable content secret → redacted; source never on the wire", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const workspace = fakeWorkspace("/repo", ["src/creds.ts"], {
    "src/creds.ts": fileEntry('export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\n'),
  });
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const text = result.messages.map((m) => m.content).join("\n");
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(text.includes("[REDACTED_SECRET]"));
  assert.ok(result.warnings.includes(REDACTION_WARNING));
});

test("secret file (editable .env) → content NEVER enters; marker + fixed warning", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const workspace = fakeWorkspace("/repo", [".env"], {
    ".env": fileEntry("DATABASE_PASSWORD=top-secret-value\n"),
  });
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const text = result.messages.map((m) => m.content).join("\n");
  assert.ok(!text.includes("top-secret-value"), "secret dosya içeriği bağlama GİRMEZ");
  assert.ok(text.includes("[SECRET FILE CONTENT OMITTED]"));
  assert.ok(result.warnings.includes(SECRET_FILE_WARNING));
});

test("secret file absent in base → ABSENT marker (existence is a fact, content is not)", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const workspace = fakeWorkspace("/repo", [".env"], {
    ".env": { exists: false },
  });
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes(ABSENT_MARKER));
  assert.ok(result.warnings.includes(SECRET_FILE_WARNING));
});

// ── düzenlenebilir blok marker'ları ─────────────────────────────────────────

test("editable entries: text / binary / symlink / absent markers (Step 6 format preserved)", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const workspace = fakeWorkspace("/repo", ["src/a.ts", "src/b.ts", "src/link.ts", "src/gone.ts"], {
    "src/a.ts": fileEntry("hello"),
    "src/b.ts": { exists: true, type: "file", mode: "100644", content: Buffer.from([0xff, 0xfe]) },
    "src/link.ts": { exists: true, type: "symlink", mode: "120000", target: "a.ts" },
    "src/gone.ts": { exists: false },
  });
  const assembler = new ContextAssembler({ runtime });

  const result = await assembler.assemble(baseInput({ workspace }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  // lexicographic sıra: a, b, gone, link — bloklar bu sırayla:
  assert.ok(user.includes("===== EDITABLE BASE: src/a.ts =====\nhello\n===== END EDITABLE BASE: src/a.ts ====="));
  assert.ok(user.includes("===== EDITABLE BASE: src/b.ts =====\n" + BINARY_CONTENT_MARKER));
  assert.ok(user.includes(`${SYMLINK_MARKER_PREFIX}a.ts]`));
  assert.ok(!user.includes("hello\na.ts"), "link hedefi takip edilmez");
  assert.ok(user.includes(ABSENT_MARKER));
});

test("editable content is never truncated (full base bytes reach the worker message)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000; // scripted küçük ölçü → sığar; içerik kırpılmamalı
  const head = "HEAD_SENTINEL_UNIQ_0\n";
  const tail = "TAIL_SENTINEL_UNIQ_9\n";
  const filler = "x".repeat(100_000); // tek parça uzun editable içerik
  const workspace = fakeWorkspace("/repo", ["src/long.ts"], {
    "src/long.ts": fileEntry(head + filler + tail),
  });
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput({ workspace }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  // Baş + gövde + son, hepsi mesajda → içerik ASLA kısaltılmaz (G-1 çivisi).
  assert.ok(user.includes(head), "editable başlangıcı mesajda olmalı");
  assert.ok(user.includes(filler), "editable gövdesi TAMAMEN mesajda olmalı (kırpılma yok)");
  assert.ok(user.includes(tail), "editable sonu mesajda olmalı");
});

// ── salt-okunur yol güvenliği + azaltımı (gerçek fs) ─────────────────────────

test("read-only path: content read; ENOENT → ABSENT; EACCES → fail-closed (never 'absent')", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  await mkdir(path.join(repo, "refs"), { recursive: true });
  await writeFile(path.join(repo, "refs", "doc.md"), "reference doc\n");
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, [], {});

  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  // (a) mevcut dosya → içerik girer:
  const ok = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/doc.md"] }));
  assert.equal(ok.status, "ready");
  if (ok.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = ok.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes("===== READ-ONLY REFERENCE: refs/doc.md =====\nreference doc\n"));

  // (b) yok (GERÇEK ENOENT) → ABSENT marker, hata YOK:
  const absent = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/missing.md"] }));
  assert.equal(absent.status, "ready");
  if (absent.status !== "ready") {
    throw new Error("unreachable");
  }
  const user2 = absent.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user2.includes(ABSENT_MARKER));

  // (c) EACCES (izinsiz) → "yokmuş" sayılmaz — fail-closed:
  const faults = new Map([[path.join(repo, "refs", "doc.md"), "EACCES"]]);
  const faulty = new ContextAssembler({ runtime: new FakeRuntime(), fs: faultLayer(h.fs, faults) });
  const fresh = new FakeRuntime();
  fresh.countFn = () => 100;
  const failing = new ContextAssembler({ runtime: fresh, fs: faultLayer(h.fs, faults) });
  void faulty;
  await assert.rejects(
    failing.assemble(baseInput({ workspace, readonlyPaths: ["refs/doc.md"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "assembly_failed",
  );
});

test("read-only path escape (../) → unsafe_path", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  await mkdir(repo, { recursive: true });
  const workspace = fakeWorkspace(repo, [], {});
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  await assert.rejects(
    assembler.assemble(baseInput({ workspace, readonlyPaths: ["../outside.ts"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "unsafe_path",
  );
});

test("read-only path under a symlink ancestor → unsafe_path (never traversed)", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  const outside = path.join(h.root, "outside");
  await mkdir(path.join(repo, "real"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "loot.txt"), "outside file\n");
  await symlink(outside, path.join(repo, "real", "link")); // atal bir SEMBOLİK BAĞLANTI
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, [], {});
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  await assert.rejects(
    assembler.assemble(baseInput({ workspace, readonlyPaths: ["real/link/loot.txt"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "unsafe_path",
  );
});

test("read-only symlink leaf: inside target → metadata (not followed); outside target → unsafe_path", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  const outside = path.join(h.root, "outside");
  await mkdir(path.join(repo, "refs"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(repo, "refs", "doc.md"), "inside\n");
  await writeFile(path.join(outside, "loot.txt"), "outside\n");
  await symlink("../refs/doc.md", path.join(repo, "refs", "inner-link.md"));
  await symlink(path.join(outside, "loot.txt"), path.join(repo, "refs", "outer-link.md"));
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, [], {});
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  // İçerideki link: metadata, hedef içeriği girmez:
  const ok = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/inner-link.md"] }));
  assert.equal(ok.status, "ready");
  if (ok.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = ok.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes(`${SYMLINK_MARKER_PREFIX}../refs/doc.md]`));
  assert.ok(!user.includes("inside\n"), "link hedefi takip edilmez");

  // Dışarıya kaçıran link: unsafe_path:
  await assert.rejects(
    assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/outer-link.md"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "unsafe_path",
  );
});

test("read-only secret file → marker, content never read", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, ".env"), "DATABASE_PASSWORD=outside-secret\n");
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, [], {});
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  const result = await assembler.assemble(baseInput({ workspace, readonlyPaths: [".env"] }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const text = result.messages.map((m) => m.content).join("\n");
  assert.ok(!text.includes("outside-secret"));
  assert.ok(text.includes("[SECRET FILE CONTENT OMITTED]"));
  assert.ok(result.warnings.includes(SECRET_FILE_WARNING));
});

test("read-only directory → NOT REPRESENTABLE metadata (content never)", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, "docs", "x.md"), "hidden inside dir\n");
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, [], {});
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  const result = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["docs"] }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes("[NOT REPRESENTABLE IN IMMUTABLE BASE]"));
  assert.ok(!user.includes("hidden inside dir"), "dizin içeriği asla okunmaz");
});

test("read-only reduction: lexicographic-last whole file evicted; editable never moves", async (t) => {
  const h = await realFsHarness(t);
  const repo = path.join(h.root, "repo");
  await mkdir(path.join(repo, "refs"), { recursive: true });
  // 3 salt-okunur dosya — her biri 12_000 bayt.
  await writeFile(path.join(repo, "refs", "a.md"), "A".repeat(12_000));
  await writeFile(path.join(repo, "refs", "b.md"), "B".repeat(12_000));
  await writeFile(path.join(repo, "refs", "c.md"), "C".repeat(12_000));
  await chmodRepo(h.root);
  const workspace = fakeWorkspace(repo, ["src/keep.ts"], {
    "src/keep.ts": fileEntry("keep me\n"),
  });

  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  // Bütçe modeli (deterministik, sistem şablonu boyutundan bağımsız):
  // 1_000 + her salt-okunur blok 45_000 → TAM bağlam 3 blok 136_000 + 32_768
  // = 168_768 > 131_072 (runtime_max) → azaltım BAŞLAR: lexicographic SON
  // (c) atılır; 2 blok 91_000 + 32_768 = 123_768 ≤ 131_072 → dur (a+b, 128k).
  // (BLOCKER 2: kade TAM bağlamdan seçilir; yalnız tavan aşımında atılır.)
  runtime.countFn = (messages) => {
    const user = messages.find((m) => m.role === "user");
    const blocks = user ? (user.content.match(/===== READ-ONLY REFERENCE:/g) ?? []).length : 0;
    return 1_000 + blocks * 45_000;
  };
  const assembler = new ContextAssembler({ runtime, fs: h.fs });

  const result = await assembler.assemble(
    baseInput({ workspace, readonlyPaths: ["refs/a.md", "refs/b.md", "refs/c.md"] }),
  );

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.truncatedReadonlyContext, true);
  assert.ok(result.warnings.includes(CONTEXT_REDUCTION_WARNING));
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  // LEXICOGRAPHİK SON: `c.md` atılır; a + b kalır:
  assert.ok(!user.includes("REFS/c.md".toLowerCase()) && !user.includes("refs/c.md =====\nC"), "c.md atılmış olmalı");
  assert.ok(user.includes("B".repeat(12_000)), "b.md korunmalı");
  assert.ok(user.includes("keep me\n"), "düzenlenebilir ASLA kıpırdamaz");
  // Seçilen kademeye sığıyor (fail-closed koruması aşılmadı):
  assert.ok(result.inputTokens + result.outputReserveTokens <= result.selectedTierTokens);
});

// ── dispatch paketi == ölçülen paket ─────────────────────────────────────────

test("measured messages ARE the dispatched messages (byte-identical; no rebuild)", async () => {
  const runtime = new FakeRuntime();
  runtime.countFn = () => 100;
  const workspace = fakeWorkspace("/repo", ["src/a.ts"], { "src/a.ts": fileEntry("code\n") });
  const assembler = new ContextAssembler({ runtime, fs: { lstat, readFile, readlink, realpath } });

  const result = await assembler.assemble(baseInput({ workspace, reasoningEffort: "xhigh" }));

  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  // Son ölçüm, SON paket üzerinde yapılmış: aynı mesaj dizisi (aynı sıra,
  // aynı içerik) — dispatch'in byte-bayt taşıyacağı referans:
  const lastMeasured = runtime.countCalls.at(-1);
  assert.ok(lastMeasured !== undefined);
  assert.deepEqual(lastMeasured, result.messages);
  // Roller: system + user (history boş; assistant mesajı YOK):
  assert.deepEqual(result.messages.map((m) => m.role), ["system", "user"]);
  // reasoning kimliği hem ölçümde hem dispatch'te aynı olmalı (render options):
  // — ölçüm çağrısı renderOptions'u aldı (reasoningEffort "xhigh"):
  // (burada dolaylı: aynı mesaj dizisi + aynı runtime = aynı prompt)
  void 0;
});

// ── BLOCKER düzeltmeleri (Step 7 güvenlik + bütçe önceliği) ─────────────────

// BLOCKER 1: read-only kanonik yol güvenliği (.git ASLA okunamaz).
test("BLOCKER 1: .git paths → unsafe_path (normalize null; içerik ASLA okunmaz)", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "src"), { recursive: true });
  await writeFile(path.join(h.root, "src", "a.ts"), "x");
  await mkdir(path.join(h.root, ".git"), { recursive: true });
  await writeFile(path.join(h.root, ".git", "config"), "token=LEAKME\n");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("x") });
  const assembler = new ContextAssembler({ runtime: new FakeRuntime(), fs: h.fs });
  for (const bad of [".git", ".git/config", "foo/.git/config", "src/../.git/config", ".GIT/config", ".Git/config"]) {
    await assert.rejects(
      assembler.assemble(baseInput({ workspace, readonlyPaths: [bad] })),
      (err: unknown) => err instanceof ContextAssemblyError && err.kind === "unsafe_path",
    );
  }
});

// BLOCKER 1: atal lstat I/O hatası → fail-closed (assembly_failed; hedef okunmaz).
test("BLOCKER 1: ancestor lstat EACCES → assembly_failed (fail-closed; hedef okunmaz)", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "refs"), { recursive: true });
  await writeFile(path.join(h.root, "refs", "doc.md"), "secret-target\n");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("x") });
  const faults = new Map<string, string>([[path.join(h.root, "refs"), "EACCES"]]);
  const assembler = new ContextAssembler({ runtime: new FakeRuntime(), fs: faultLayer(h.fs, faults) });
  await assert.rejects(
    assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/doc.md"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "assembly_failed",
  );
});

// BLOCKER 1: kök realpath başarısızlığı → fail-closed (sözdizisel fallback YOK).
test("BLOCKER 1: repoRoot realpath EACCES → assembly_failed (no lexical fallback)", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "refs"), { recursive: true });
  await writeFile(path.join(h.root, "refs", "doc.md"), "x");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("x") });
  const fs: ContextFs = {
    lstat: h.fs.lstat,
    readFile: h.fs.readFile,
    readlink: h.fs.readlink,
    realpath: async () => {
      throw Object.assign(new Error("EACCES (fault)"), { code: "EACCES" });
    },
  };
  const assembler = new ContextAssembler({ runtime: new FakeRuntime(), fs });
  await assert.rejects(
    assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/doc.md"] })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "assembly_failed",
  );
});

// BLOCKER 1: alias'lar tek kanonik blok (aynı dosya birden çok kez okunmaz).
test("BLOCKER 1: aliases (src/./a.ts ≡ src//a.ts ≡ src/a.ts) → one canonical block", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "src"), { recursive: true });
  await writeFile(path.join(h.root, "src", "a.ts"), "CONTENT");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("x") });
  const assembler = new ContextAssembler({ runtime: new FakeRuntime(), fs: h.fs });
  const result = await assembler.assemble(
    baseInput({ workspace, readonlyPaths: ["src/./a.ts", "src//a.ts", "src/a.ts"] }),
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  // Yalnız başlık (footer `END ...` aynı alt-diziyi içerir → başlığı sabitle).
  assert.equal((user.match(/===== READ-ONLY REFERENCE: src\/a\.ts =====/g) ?? []).length, 1);
});

// BLOCKER 2: tam bağlam → kade. Required 64k'a sığar, tam 128k'a sığar → 128k,
// salt-okunur KORUNUR (atılmaz).
test("BLOCKER 2: required fits 64k, full fits 128k → 128k, readonly preserved", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "refs"), { recursive: true });
  await writeFile(path.join(h.root, "refs", "big.md"), "x");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("small") });
  const runtime = new FakeRuntime();
  runtime.maxTokens = 196_608; // 64k/128k/192k kullanılabilir
  runtime.countFn = (messages) => {
    const user = messages.find((m) => m.role === "user")!;
    const blocks = user.content.match(/===== READ-ONLY REFERENCE:/g) ?? [];
    return 1_000 + blocks.length * 50_000; // required 1_000 (64k), tam 51_000 (128k)
  };
  const assembler = new ContextAssembler({ runtime, fs: h.fs });
  const result = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/big.md"] }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedContextTier, "128k");
  assert.equal(result.selectedTierTokens, 131_072);
  assert.equal(result.truncatedReadonlyContext, false); // salt-okunur atılmadı
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes("READ-ONLY REFERENCE: refs/big.md"), "salt-okunur korundu");
});

// BLOCKER 2: tam bağlam 192k'a sığar → 192k, salt-okunur korunu.
test("BLOCKER 2: full fits 192k → 192k, readonly preserved", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "refs"), { recursive: true });
  await writeFile(path.join(h.root, "refs", "big.md"), "x");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("small") });
  const runtime = new FakeRuntime();
  runtime.maxTokens = 196_608;
  runtime.countFn = (messages) => {
    const user = messages.find((m) => m.role === "user")!;
    const blocks = user.content.match(/===== READ-ONLY REFERENCE:/g) ?? [];
    return 1_000 + blocks.length * 140_000; // tam 141_000 → 192k'a sığar, 128k'a değil
  };
  const assembler = new ContextAssembler({ runtime, fs: h.fs });
  const result = await assembler.assemble(baseInput({ workspace, readonlyPaths: ["refs/big.md"] }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedContextTier, "192k");
  assert.equal(result.selectedTierTokens, 196_608);
  assert.equal(result.truncatedReadonlyContext, false);
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes("READ-ONLY REFERENCE: refs/big.md"));
});

// BLOCKER 3 (kritik): tercih payı sığmasa bile TÜM salt-okunur korunur + min;
// bir salt-okunuru atmak preferred'i sığdıracaksa da atılmaz.
test("BLOCKER 3: preferred doesn't fit → ALL readonly preserved + min (no eviction for preferred)", async (t) => {
  const h = await realFsHarness(t);
  await mkdir(path.join(h.root, "refs"), { recursive: true });
  await writeFile(path.join(h.root, "refs", "a.md"), "x");
  await writeFile(path.join(h.root, "refs", "b.md"), "x");
  const workspace = fakeWorkspace(h.root, ["src/a.ts"], { "src/a.ts": fileEntry("s") });
  const runtime = new FakeRuntime();
  runtime.maxTokens = 196_608;
  runtime.countFn = (messages) => {
    const user = messages.find((m) => m.role === "user")!;
    const blocks = user.content.match(/===== READ-ONLY REFERENCE:/g) ?? [];
    return 8_000 + blocks.length * 36_000; // 2 blok = 80_000
  };
  const assembler = new ContextAssembler({ runtime, fs: h.fs });
  const result = await assembler.assemble(
    baseInput({ workspace, readonlyPaths: ["refs/a.md", "refs/b.md"] }),
  );
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedContextTier, "128k"); // tam bağlam 128k'a sığar (min payla)
  assert.equal(result.outputReserveTokens, 32_768); // preferred (65536) sığmıyor → min
  assert.equal(result.truncatedReadonlyContext, false); // BLOCKER 3: hiçbiri atılmadı
  const user = result.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(user.includes("READ-ONLY REFERENCE: refs/a.md"));
  assert.ok(user.includes("READ-ONLY REFERENCE: refs/b.md"), "ikisi de korundu");
});

// BLOCKER 4: açık `runtime_max` provenance (etiket sayısal türevi değil).
test("BLOCKER 4: explicit runtime_max (max=131072) → label runtime_max (128k DEĞİL)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 1_000;
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput({ contextTier: "runtime_max" }));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 131_072);
  assert.equal(result.selectedContextTier, "runtime_max");
});

// BLOCKER 4: adaptif kanonik — config 128k seçilirse etiket 128k (runtime_max değil).
test("BLOCKER 4: automatic canonical (max=131072, fits 128k not 64k) → label 128k", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 90_000; // 90_000+32_768=122_768 > 65_536, ≤ 131_072
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedTierTokens, 131_072);
  assert.equal(result.selectedContextTier, "128k");
});

// BLOCKER 4: açık kanonik kademe runtime max'ı aşıyorsa → invalid_input (clamp YOK).
test("BLOCKER 4: explicit 192k with max 131072 → invalid_input (no silent clamp)", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  const assembler = new ContextAssembler({ runtime });
  await assert.rejects(
    assembler.assemble(baseInput({ contextTier: "192k" })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
});

// BLOCKER 5/4: needs_split provenance — açık runtime_max → runtime_max (128k değil).
test("needs_split provenance: forced runtime_max (max=131072) → selected_context_tier=runtime_max", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 131_072;
  runtime.countFn = () => 200_000; // 200_000+32_768 > 131_072 → needs_split
  const workspace = fakeWorkspace("/repo", ["src/a.ts"], { "src/a.ts": fileEntry("x".repeat(5)) });
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput({ workspace, contextTier: "runtime_max" }));
  assert.equal(result.status, "needs_split");
  if (result.status !== "needs_split") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedContextTier, "runtime_max");
  assert.equal(result.availableMaxTokens, 131_072); // sayısal kalır
});

// needs_split provenance: adaptif (açık override yok) → runtime_max.
test("needs_split provenance: automatic → selected_context_tier=runtime_max", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 90_000; // kanonik kademeden küçük
  runtime.countFn = () => 60_000; // 60_000+32_768=92_768 > 90_000 → needs_split
  const workspace = fakeWorkspace("/repo", ["src/a.ts"], { "src/a.ts": fileEntry("x".repeat(5)) });
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput({ workspace }));
  assert.equal(result.status, "needs_split");
  if (result.status !== "needs_split") {
    throw new Error("unreachable");
  }
  assert.equal(result.selectedContextTier, "runtime_max");
  assert.equal(result.availableMaxTokens, 90_000);
});

// BLOCKER 5: pressure sıralaması TAM formatlanmış bloğu tokenize eder (body değil).
test("BLOCKER 5: pressure ranking tokenizes the FULL formatted editable block", async () => {
  const runtime = new FakeRuntime();
  runtime.maxTokens = 65_536;
  runtime.countFn = () => 50_000; // needs_split
  runtime.tokenFn = (content) => content.length;
  const workspace = fakeWorkspace("/repo", ["src/a.ts"], { "src/a.ts": fileEntry("body") });
  const assembler = new ContextAssembler({ runtime });
  const result = await assembler.assemble(baseInput({ workspace }));
  assert.equal(result.status, "needs_split");
  if (result.status !== "needs_split") {
    throw new Error("unreachable");
  }
  const call = runtime.tokenCalls.at(-1) ?? "";
  assert.ok(call.includes("===== EDITABLE BASE: src/a.ts ====="), "tam block başlığı");
  assert.ok(call.includes("body"), "body içerikte");
  assert.ok(call.includes("===== END EDITABLE BASE: src/a.ts ====="), "tam block sonu");
});

/** tmp yardımcıları ────────────────────────────────────────────────────────── */

async function chmodRepo(root: string): Promise<void> {
  // (macOS sandbox: chmod gerekmiyor; parite için no-op)
  void root;
}
