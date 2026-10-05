/**
 * Step 8: `RulesResolver` birim testleri (DESIGN.md §6, 11 m.8).
 *
 * Saf birim: scriptlenebilir `RulesFs` (lstat/readFile/realpath + çağrı
 * sayaçları) — hiçbir gerçek filesystem, hiçbir git.
 *
 * Çiviler:
 * - hook önceliği: geçerli payload → `hook`, repository ASLA dokunulmaz
 *   (lstat/readFile/realpath çağrısı YOK); boşluk-tek payload = YOK
 *   (repository fallback'i); geçerli payload bayt-bayt korunur
 * - repository keşfi: YALNIZ kökte `CLAUDE.md` → `AGENTS.md` (sıralı);
 *   crawl/parent/home/rekursif YOK
 * - whitespace-tek dosya = o kaynaktan içerik YOK (boşluklar yok sayılır,
 *   içerik byte-bayt aynen — trim YOK)
 * - fail-closed: symlink/dizin/FIFO → hata (ASLA "yok" DEĞİL); ENOENT
 *   YALNIZ "yoktur"; diğer errno (EACCES/EIO/...) + realpath başarısızlığı
 *   → hata; fallback YOK; invalid UTF-8 → hata (replacement karakter YOK)
 * - tip'li hata: tek kind + SABİT güvenli mesaj (yol/içerik/errno YOK);
 *   `cause` yalnız geliştirici kanalı
 * - stateless: çağrı arası cache YOK; eşzamanlı çözümler bağımsız
 * - çağrı yüzeyi: yalnız realpath/lstat/readFile (git/yazma YOK)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RulesResolver } from "../dist/rules/RulesResolver.js";
import {
  RULES_RESOLUTION_FAILED_MESSAGE,
  RulesResolutionError,
  type RulesFs,
} from "../dist/rules/types.js";

// ── Scriptlenebilir fake fs ──────────────────────────────────────────────────

type EntryKind = "file" | "dir" | "symlink" | "fifo" | "socket";

interface EntrySpec {
  kind?: EntryKind;
  content?: Buffer;
  lstatError?: string;
  readError?: string;
  /** symlink: `realpath`'in döndüreceği kanonik hedef. */
  realpathTarget?: string;
  /** symlink: `realpath` hatası (errno). */
  realpathError?: string;
}

function statOf(kind: EntryKind | undefined): Stats {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
    isFIFO: () => kind === "fifo",
    isSocket: () => kind === "socket",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  } as unknown as Stats;
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code} (fault-injected)`), { code });

/** Kök `root` altında `rel` dosyaları tanımlayan deterministik fs. */
class ScriptedRulesFs implements RulesFs {
  readonly root: string;
  entries = new Map<string, EntrySpec>();
  lstatCalls: string[] = [];
  readFileCalls: string[] = [];
  realpathCalls: string[] = [];
  /** `realpath` başarısızlığı (errno) — kök canonicalizasyonu fail-closed. */
  realpathError?: string;

  constructor(root = "/repo") {
    this.root = root;
  }

  abs(rel: string): string {
    return path.join(this.root, rel);
  }

  setFile(rel: string, content: string | Buffer, kind: EntryKind = "file"): this {
    this.entries.set(this.abs(rel), {
      kind,
      content: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    });
    return this;
  }

  setKind(rel: string, kind: EntryKind): this {
    this.entries.set(this.abs(rel), { kind });
    return this;
  }

  setLstatError(rel: string, code: string): this {
    this.entries.set(this.abs(rel), { kind: "file", lstatError: code });
    return this;
  }

  setReadError(rel: string, code: string): this {
    this.entries.set(this.abs(rel), { kind: "file", readError: code });
    return this;
  }

  /** Yaprak symlink: `realpath` → `target` (kanonik mutlak) ya da `error` errno. */
  setSymlink(rel: string, link: { target?: string; error?: string }): this {
    this.entries.set(this.abs(rel), { kind: "symlink", realpathTarget: link.target, realpathError: link.error });
    return this;
  }

  async lstat(target: string): Promise<Stats> {
    this.lstatCalls.push(target);
    const spec = this.entries.get(target);
    if (spec?.lstatError !== undefined) {
      throw errno(spec.lstatError);
    }
    if (spec === undefined) {
      throw errno("ENOENT");
    }
    return statOf(spec.kind);
  }

  async readFile(target: string): Promise<Buffer> {
    this.readFileCalls.push(target);
    const spec = this.entries.get(target);
    if (spec?.readError !== undefined) {
      throw errno(spec.readError);
    }
    if (spec === undefined || spec.content === undefined) {
      throw errno("ENOENT");
    }
    return spec.content;
  }

  async realpath(target: string): Promise<string> {
    this.realpathCalls.push(target);
    if (this.realpathError !== undefined) {
      throw errno(this.realpathError);
    }
    const spec = this.entries.get(target);
    if (spec?.realpathError !== undefined) {
      throw errno(spec.realpathError);
    }
    if (spec?.realpathTarget !== undefined) {
      return spec.realpathTarget;
    }
    // Kimlik canonicalizasyonu: kök aynen döner (test kökleri zaten
    // kanoniktir).
    return target;
  }
}

const RESOLVER = "/repo/CLAUDE.md";
const AGENTS = "/repo/AGENTS.md";

// ── hook önceliği ────────────────────────────────────────────────────────────

test("valid hook payload → `hook` source, byte-for-byte, and the repository is NEVER touched", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "repo rule that must not be read");
  const resolver = new RulesResolver({ fs });

  const payload = "  use tabs\nNEVER log secrets  \r\n";
  const result = await resolver.resolve({ suppliedRules: payload, repoRoot: "/repo" });

  assert.equal(result.source, "hook");
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]!.source, "hook");
  assert.equal(result.documents[0]!.content, payload, "payload bytes must survive verbatim");
  assert.equal(fs.realpathCalls.length, 0, "realpath must not run for a hook payload");
  assert.equal(fs.lstatCalls.length, 0, "lstat must not run for a hook payload");
  assert.equal(fs.readFileCalls.length, 0, "readFile must not run for a hook payload");
});

test("whitespace-only hook payload is NOT a valid payload → repository fallback runs", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "claude rule");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ suppliedRules: "   \n\t  ", repoRoot: "/repo" });

  assert.equal(result.source, "CLAUDE.md");
  assert.deepEqual(
    result.documents.map((doc) => doc.content),
    ["claude rule"],
  );
  assert.equal(fs.realpathCalls.length, 1, "fallback canonicalizes the root");
});

test("absent hook payload → repository fallback runs", async () => {
  const fs = new ScriptedRulesFs().setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "AGENTS.md");
  assert.deepEqual(
    result.documents.map((doc) => doc.content),
    ["agents rule"],
  );
});

// ── repository discovery (closed vocabulary, fixed order) ───────────────────

test("neither root file exists → `none` with zero documents (ENOENT is the only 'absent')", async () => {
  const fs = new ScriptedRulesFs();
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "none");
  assert.equal(result.documents.length, 0);
  assert.deepEqual(fs.lstatCalls, [RESOLVER, AGENTS]);
  assert.equal(fs.readFileCalls.length, 0);
});

test("CLAUDE.md only → source `CLAUDE.md`, content byte-faithful (no trim/rewrite)", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "  rule one\nrule two  \r\nno-final-newline");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "CLAUDE.md");
  assert.equal(result.documents[0]!.source, "CLAUDE.md");
  assert.equal(result.documents[0]!.content, "  rule one\nrule two  \r\nno-final-newline");
  assert.deepEqual(fs.readFileCalls, [RESOLVER]);
});

test("AGENTS.md only → source `AGENTS.md`", async () => {
  const fs = new ScriptedRulesFs().setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "AGENTS.md");
  assert.equal(result.documents[0]!.source, "AGENTS.md");
});

test("both exist → combined provenance in FIXED CLAUDE.md → AGENTS.md order", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "claude rule")
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "CLAUDE.md + AGENTS.md");
  assert.deepEqual(
    result.documents.map((doc) => doc.source),
    ["CLAUDE.md", "AGENTS.md"],
    "CLAUDE.md must precede AGENTS.md (never fs/mtime/alphabetical order)",
  );
  assert.deepEqual(
    result.documents.map((doc) => doc.content),
    ["claude rule", "agents rule"],
  );
});

test("whitespace-only CLAUDE.md yields no content → AGENTS.md is the source", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "   \n\t  \n")
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "AGENTS.md");
  assert.deepEqual(
    result.documents.map((doc) => doc.source),
    ["AGENTS.md"],
  );
});

test("both files whitespace-only → `none`", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "\n\t").setFile("AGENTS.md", "   ");
  const resolver = new RulesResolver({ fs });

  const result = await resolver.resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "none");
  assert.equal(result.documents.length, 0);
});

// ── fail-closed matrix ───────────────────────────────────────────────────────

test("invalid UTF-8 in CLAUDE.md fails closed — no fallback to AGENTS.md", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", Buffer.from([0xff, 0xfe, 0xfd]))
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) =>
      err instanceof RulesResolutionError &&
      err.kind === "rules_resolution_failed" &&
      err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.readFileCalls.length, 1, "only CLAUDE.md was read");
  assert.equal(fs.lstatCalls.length, 1, "AGENTS.md must never be reached after a failure");
  assert.equal(fs.realpathCalls.length, 1);
});

test("EACCES on CLAUDE.md lstat fails closed — no fallback to AGENTS.md", async () => {
  const fs = new ScriptedRulesFs()
    .setLstatError("CLAUDE.md", "EACCES")
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.lstatCalls.length, 1, "AGENTS.md must never be reached after an operational error");
});

test("symlink at a rule path fails closed (never followed, never 'absent')", async () => {
  const fs = new ScriptedRulesFs().setKind("CLAUDE.md", "symlink");
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.readFileCalls.length, 0, "a symlink must never be read");
});

test("directory at a rule path fails closed (never treated as absent)", async () => {
  const fs = new ScriptedRulesFs().setKind("AGENTS.md", "dir");
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.readFileCalls.length, 0);
});

test("FIFO / socket at a rule path fail closed", async () => {
  for (const kind of ["fifo", "socket"] as const) {
    const fs = new ScriptedRulesFs().setKind("CLAUDE.md", kind);
    const resolver = new RulesResolver({ fs });
    await assert.rejects(
      resolver.resolve({ repoRoot: "/repo" }),
      (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
    );
    assert.equal(fs.readFileCalls.length, 0, `${kind} must never be read`);
  }
});

test("readFile failure (EIO) after a valid lstat fails closed — no fallback", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "claude rule")
    .setReadError("CLAUDE.md", "EIO")
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.lstatCalls.length, 1, "AGENTS.md must never be reached after a read failure");
});

// ── Step 9 TOCTOU hardening (spec 194): the no-follow content read ───────────

test("race (spec 194): regular at lstat, ELOOP at the no-follow read → rules_resolution_failed; the target is never read", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "TOP-SECRET") // lstat sees a regular file
    .setReadError("CLAUDE.md", "ELOOP"); // the no-follow open fails: it's a symlink now
  const resolver = new RulesResolver({ fs });

  try {
    await resolver.resolve({ repoRoot: "/repo" });
    assert.fail("resolution must have failed");
  } catch (err) {
    assert.ok(err instanceof RulesResolutionError);
    assert.equal(err.message, RULES_RESOLUTION_FAILED_MESSAGE);
    assert.ok(!err.message.includes("TOP-SECRET"), "no rule material in the public message");
    assert.ok(String((err.cause as Error)?.message ?? "").includes("ELOOP"), "the no-follow read failed with ELOOP");
  }
  // The content read was attempted exactly once (the seam `readFile` member the
  // no-follow read rides on); the seam surface (lstat/readFile/realpath) is
  // unchanged, so the Step 8 call-count / guard tests remain valid (spec 297).
  assert.equal(fs.readFileCalls.length, 1, "the no-follow content read was attempted");
  assert.equal(fs.lstatCalls.length, 1, "the lstat classification ran exactly once");
});

test("a broken canonical root (realpath EACCES) fails closed before any rule access", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "claude rule");
  fs.realpathError = "EACCES";
  const resolver = new RulesResolver({ fs });

  await assert.rejects(
    resolver.resolve({ repoRoot: "/repo" }),
    (err: unknown) => err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE,
  );
  assert.equal(fs.lstatCalls.length, 0);
  assert.equal(fs.readFileCalls.length, 0);
});

// ── error surface (DESIGN.md §9) ─────────────────────────────────────────────

test("the typed error carries the fixed safe message; the cause is developer-channel only", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "claude rule")
    .setReadError("CLAUDE.md", "EACCES");
  const resolver = new RulesResolver({ fs });

  try {
    await resolver.resolve({ repoRoot: "/repo" });
    assert.fail("resolution must have failed");
  } catch (err) {
    assert.ok(err instanceof RulesResolutionError);
    assert.equal(err.message, RULES_RESOLUTION_FAILED_MESSAGE);
    assert.ok(!err.message.includes("/repo"), "no path in the public message");
    assert.ok(!err.message.includes("EACCES"), "no raw errno in the public message");
    assert.ok(!err.message.includes("claude rule"), "no rule material in the public message");
    // Geliştirici kanalı: asıl hata `cause`'ta yaşar (wire'a ASLA gitmez —
    // serializeToolError yalnız kind+message taşır).
    assert.ok((err.cause as Error).message.includes("EACCES"));
  }
});

// ── statelessness / concurrency ──────────────────────────────────────────────

test("no cache across calls: a later resolve re-reads the repository", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "v1");
  const resolver = new RulesResolver({ fs });

  const first = await resolver.resolve({ repoRoot: "/repo" });
  assert.equal(first.documents[0]!.content, "v1");

  fs.setFile("CLAUDE.md", "v2");
  const second = await resolver.resolve({ repoRoot: "/repo" });
  assert.equal(second.documents[0]!.content, "v2", "a stale cache would report v1");
  // Her resolve iki lstat yapar (CLAUDE + AGENTS) → iki resolve = 4;
  // önbellek olsaydı ikinci resolve 0 lstat yapardı.
  assert.equal(fs.lstatCalls.length, 4, "every resolve performs its own lstat");
});

test("concurrent resolutions are independent (single shared instance is safe)", async () => {
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "claude rule");
  const resolver = new RulesResolver({ fs });

  const [hook, repo] = await Promise.all([
    resolver.resolve({ suppliedRules: "hook rule", repoRoot: "/repo" }),
    resolver.resolve({ repoRoot: "/repo" }),
  ]);

  assert.equal(hook.source, "hook");
  assert.equal(repo.source, "CLAUDE.md");
  assert.equal(repo.documents[0]!.content, "claude rule");
});

// ── call surface (no Git, no writes) ─────────────────────────────────────────

/**
 * Seam koruması: resolver'ın fs nesnesine `RulesFs`'in üç üyesi DIŞINDA
 * herhangi bir üye erişimi (gelecekte yazma/git/... üyesi eklenirse) bu
 * Proxy ile HATA olur — sınırlama test tarafından pinlenir.
 */
function guardSeam(fs: ScriptedRulesFs): RulesFs {
  const allowed = new Set(["lstat", "readFile", "realpath"]);
  return new Proxy(fs as object, {
    get(target: object, prop: string | symbol) {
      if (typeof prop === "symbol" || allowed.has(prop as string)) {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      throw new Error(`RulesResolver touched a member outside the RulesFs seam: ${String(prop)}`);
    },
  }) as RulesFs;
}

test("the resolver only ever performs realpath/lstat/readFile — no Git, no mutation", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "claude rule")
    .setFile("AGENTS.md", "agents rule");
  const resolver = new RulesResolver({ fs: guardSeam(fs) });
  const result = await resolver.resolve({ repoRoot: "/repo" });
  assert.equal(result.source, "CLAUDE.md + AGENTS.md");
  assert.equal(fs.realpathCalls.length, 1, "exactly one canonicalization");
  assert.equal(fs.lstatCalls.length, 2, "exactly one lstat per known root surface");
  assert.equal(fs.readFileCalls.length, 2, "exactly one read per present file");
  // `RulesFs` arayüzünde (types.ts) write/rename/unlink/git üyesi YOKTUR —
  // proxy, gelecekte eklenen herhangi bir üye erişimini yakalar.
});

test("a resolver that would need a write surface is impossible by construction (seam guard rejects it)", async () => {
  // Guard'ın gerçekten koruduğunu kanıtlamak: bilinçli olarak yasak bir
  // üyeye erişen fs → resolver HATA VERİR (yüzey genişseydi sessizce
  // geçermi; guard bunu test'te patlatır).
  const fs = new ScriptedRulesFs().setFile("CLAUDE.md", "claude rule");
  const guarded = guardSeam(fs);
  const resolver = new RulesResolver({ fs: guarded as unknown as RulesFs });
  // Resolver yalnız seam üyelerini çağırır — bu yüzden bu çağrı BAŞARILI
  // olmalı; guard ancak seam DIŞI bir çağrıda patlar (aşağıdaki doğrudan
  // deneme guard'ın çalıştığını gösterir):
  await resolver.resolve({ repoRoot: "/repo" });
  assert.throws(
    () => {
      (guarded as unknown as { writeFile: () => void }).writeFile();
    },
    /outside the RulesFs seam/,
    "the seam guard rejects any non-lstat/readFile/realpath access",
  );
});

// ── İz 3 / K2: AGENTS.md → <root>/CLAUDE.md takma adı ───────────────────────

const failsClosed = (err: unknown): boolean =>
  err instanceof RulesResolutionError && err.message === RULES_RESOLUTION_FAILED_MESSAGE;

test("K2: AGENTS.md leaf symlink whose canonical target is exactly <root>/CLAUDE.md → alias, skipped WITHOUT reading", async () => {
  const fs = new ScriptedRulesFs()
    .setFile("CLAUDE.md", "claude rule")
    .setSymlink("AGENTS.md", { target: RESOLVER });
  const result = await new RulesResolver({ fs }).resolve({ repoRoot: "/repo" });

  assert.equal(result.source, "CLAUDE.md");
  assert.deepEqual(result.documents, [{ source: "CLAUDE.md", content: "claude rule" }]);
  assert.deepEqual(fs.readFileCalls, [RESOLVER], "the alias content must never be read");
});

test("K2: every other symlink stays fail-closed (never read)", async () => {
  const cases: Array<[string, ScriptedRulesFs]> = [
    ["AGENTS.md → outside the repository", new ScriptedRulesFs().setFile("CLAUDE.md", "c").setSymlink("AGENTS.md", { target: "/outside/AGENTS.md" })],
    ["AGENTS.md → in-repo non-root CLAUDE.md", new ScriptedRulesFs().setFile("CLAUDE.md", "c").setSymlink("AGENTS.md", { target: "/repo/docs/CLAUDE.md" })],
    ["AGENTS.md → in-repo other file", new ScriptedRulesFs().setFile("CLAUDE.md", "c").setSymlink("AGENTS.md", { target: "/repo/README.md" })],
    ["AGENTS.md canonicalization fails (dangling)", new ScriptedRulesFs().setSymlink("AGENTS.md", { error: "ENOENT" })],
    ["AGENTS.md canonicalization fails (ELOOP)", new ScriptedRulesFs().setFile("CLAUDE.md", "c").setSymlink("AGENTS.md", { error: "ELOOP" })],
    ["CLAUDE.md → AGENTS.md (reverse alias is NOT accepted)", new ScriptedRulesFs().setFile("AGENTS.md", "a").setSymlink("CLAUDE.md", { target: AGENTS })],
  ];
  for (const [label, fs] of cases) {
    await assert.rejects(new RulesResolver({ fs }).resolve({ repoRoot: "/repo" }), failsClosed, label);
    for (const [abs, spec] of fs.entries) {
      if (spec.kind === "symlink") {
        assert.ok(!fs.readFileCalls.includes(abs), `${label}: a symlink must never be read`);
      }
    }
  }
});

test("K2 (real filesystem): relative AGENTS.md -> CLAUDE.md alias resolves to CLAUDE.md only; ../outside link fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "splash-rules-k2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "CLAUDE.md"), "claude rule\n");
  await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
  const ok = await new RulesResolver().resolve({ repoRoot: repo });
  assert.equal(ok.source, "CLAUDE.md");
  assert.deepEqual(ok.documents, [{ source: "CLAUDE.md", content: "claude rule\n" }]);

  await rm(path.join(repo, "AGENTS.md"));
  await writeFile(path.join(root, "outside.md"), "outside rule\n");
  await symlink("../outside.md", path.join(repo, "AGENTS.md"));
  await assert.rejects(new RulesResolver().resolve({ repoRoot: repo }), failsClosed);
});
