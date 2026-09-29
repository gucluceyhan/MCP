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

test("non-integer tier / reserve → invalid_input", async () => {
  const assembler = new ContextAssembler({ runtime: new FakeRuntime() });
  await assert.rejects(
    assembler.assemble(baseInput({ contextTier: 65_536.5 })),
    (err: unknown) => err instanceof ContextAssemblyError && err.kind === "invalid_input",
  );
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
    assembler.assemble(baseInput({ contextTier: 131_072 })),
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

  const result = await assembler.assemble(baseInput({ contextTier: 131_072 }));

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

  // Tokenizer hatası ipucunu bozamaz: o dosya 0'la sıralanır.
  const runtime2 = new FakeRuntime();
  runtime2.maxTokens = 65_536;
  runtime2.countFn = () => 50_000;
  const failing = new Proxy(runtime2, {
    get(target, prop) {
      if (prop === "tokenize") {
        return async () => {
          throw new Error("tokenizer down");
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ContextRuntime;
  const assembler2 = new ContextAssembler({ runtime: failing });
  const result2 = await assembler2.assemble(baseInput({ workspace }));
  assert.equal(result2.status, "needs_split");
  if (result2.status !== "needs_split") {
    throw new Error("unreachable");
  }
  // Hepsi 0 token → path asc sıralaması: f00..f07.
  assert.deepEqual(result2.pressureFiles, [
    "src/f00.ts",
    "src/f01.ts",
    "src/f02.ts",
    "src/f03.ts",
    "src/f04.ts",
    "src/f05.ts",
    "src/f06.ts",
    "src/f07.ts",
  ]);
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
  // 1_000 + her salt-okunur blok 12_000 → 3 blok 37_000 (+32_768 pay = 69_768
  // > 65_536 → c atılır; 2 blok 25_000 + 32_768 = 57_768 ≤ 65_536 → dur, a+b).
  runtime.countFn = (messages) => {
    const user = messages.find((m) => m.role === "user");
    const blocks = user ? (user.content.match(/===== READ-ONLY REFERENCE:/g) ?? []).length : 0;
    return 1_000 + blocks * 12_000;
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

/** tmp yardımcıları ────────────────────────────────────────────────────────── */

async function chmodRepo(root: string): Promise<void> {
  // (macOS sandbox: chmod gerekmiyor; parite için no-op)
  void root;
}
