/**
 * Step 10 — Katman G: `splash_diff` + `splash_close` uçtan uca entegrasyon
 * testleri (gerçek git, gerçek fs, MCP runtime + InMemoryTransport + Client).
 *
 * Ağırlık MCP yüzeyindedir (`createSplashRuntime` → `Client`). Yalnız MCP
 * runtime'ından enjekte EDİLEMEYEN dikiş (yetkili durum silme hatası —
 * `SessionStore.delete`) doğrudan `SessionManager` ile kurulur (S10-I9).
 * `createWorkspace` / `contextAssembler` dikişleri runtime seçeneklerinden
 * gelir; instrument edilmiş workspace GERÇEK `GitWorktreeWorkspace`'i sarar.
 *
 * `git apply` YALNIZ bu test harness'ında ve YALNIZ ana checkout'un tek
 * kullanımlık KOPYASINDA çalışır (Splash üretim kodu patch UYGULAMAZ —
 * Step 10 spec 2/33). Ana checkout'a karşı `git apply` bu dosyada YASAKTIR
 * (`gitApplyInCopy` koruması).
 *
 * Determinizm: sleep / süre bağımlılığı YOK. Eşzamanlılık testleri nedensel
 * kancalarla kurulur (deferred backend + instrument edilmiş workspace /
 * assembler sayaçları); "kuyrukta bekliyor" kanıtı için `setImmediate`
 * olay-döngüsü TURLARI kullanılır (süre DEĞİL): doğru implementasyonda
 * yanlış-negatif üretemez; kilidi kaldırılmış mutasyonda kilitsiz yolun
 * senkron öneki (cache hit → workspace/assembler çağrısı) bu turlarda
 * gözlemlenir.
 *
 * S10-I1..I16: spec §30-43 senaryoları. S10-I17+: Step 10 kapsamına alınan
 * düzeltmelerin uçtan uca kanıtları — F (stale yakalama ENOTDIR / atal
 * symlink = ölçüm), S#1 (tur-0 oturumun 1. turu refine'dan → restart),
 * S#2 (başarısız refine sonrası COMMIT edilmiş durum), S#4 (git dışı silinmiş
 * worktree kaydı), M1 (düşmanca diff/renk config'i → patch biçimi), H
 * (kurtarma hash'i diff config'inden bağımsız).
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSplashRuntime, type SplashRuntime, type SplashRuntimeOptions } from "../dist/server.js";
import { InferenceCoordinator, type RuntimeLockLike } from "../dist/backend/InferenceCoordinator.js";
import type { LockAcquireResult } from "../dist/backend/RuntimeLock.js";
import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
  RuntimeInfo,
  TokenizeResult,
} from "../dist/backend/InferenceBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import { ContextAssembler } from "../dist/context/ContextAssembler.js";
import type {
  AssembledContext,
  ContextAssemblyInput,
  LiveBaseCaptureInput,
  LiveBaseState,
} from "../dist/context/types.js";
import { WorkerContract } from "../dist/worker/WorkerContract.js";
import { RulesResolver } from "../dist/rules/RulesResolver.js";
import { computeRepoId } from "../dist/workspace/git.js";
import { createGitWorktreeWorkspace, restoreGitWorktreeWorkspace } from "../dist/workspace/GitWorktreeWorkspace.js";
import { WorkspaceError, type Workspace } from "../dist/workspace/Workspace.js";
import { SessionStore } from "../dist/session/SessionStore.js";
import { SessionManager, type SessionStoreLike } from "../dist/session/SessionManager.js";
import { SessionError, type PersistedSession } from "../dist/session/types.js";
import { serializeToolError } from "../dist/task/wire.js";
import type { SplashConfig } from "../dist/config.js";

// ── Git hermetiği ────────────────────────────────────────────────────────────

const GIT_ENV_KEYS = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Salt-okunur git sorgusu (stdout). Ana checkout'a YAZAN komut için KULLANILMAZ. */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── Fikstür ──────────────────────────────────────────────────────────────────

const BASE_A = "const value = 1;\n";
const BASE_B = "const other = 10;\n";
const LONG_LINES = Array.from({ length: 20 }, (_, index) => `// L${String(index + 1).padStart(2, "0")}`);
/**
 * 20 satırlık dosya — `-U3` bağlamını ölçmek için. Satırlar `/` ile başlar:
 * git'in varsayılan funcname kuralı (alfabetik/`_`/`$` ile başlayan satır)
 * hunk başlığına SATIR SIZDIRMAZ — "L06 diff'te yok" iddiası temiz kalır.
 */
const BASE_LONG = `${LONG_LINES.join("\n")}\n`;
const BASE_DEL = "export const doomed = true;\n";
const BASE_STAGED = "export const staged = 'v1';\n";
const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x49, 0x4e]);
const SECRET_PKG = '{"name":"fixture-only","secret":"NEVER_ON_WIRE"}\n';

/**
 * İçerik-sınırı işaretçisi (spec 30): YALNIZ worker çıktısında (create +
 * modify içeriği) bulunur — base'te, summary'de, girdide (kasıtlı yankı
 * denemeleri hariç) YOK. Sabit (deterministik) ve benzersiz.
 */
const MARKER = "S10_NO_CONTENT_MARKER_5e1f0c9a";

interface Fixture {
  root: string;
  repoRoot: string;
  outputRoot: string;
  sessionsDir: string;
  /** Hermetik global git config dosyası (`GIT_CONFIG_GLOBAL`) — başlangıçta boş. */
  gitConfig: string;
  config: SplashConfig;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "splash-step10-int-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const key of GIT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  await writeFile(path.join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GIT_AUTHOR_NAME = "Splash Step10 Int";
  process.env.GIT_AUTHOR_EMAIL = "step10@splash.test";
  process.env.GIT_COMMITTER_NAME = "Splash Step10 Int";
  process.env.GIT_COMMITTER_EMAIL = "step10@splash.test";

  const repoRoot = path.join(root, "repo");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Splash Step10 Int");
  git(repoRoot, "config", "user.email", "step10@splash.test");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(repoRoot, "src/a.ts"), BASE_A);
  await writeFile(path.join(repoRoot, "src/b.ts"), BASE_B);
  await writeFile(path.join(repoRoot, "src/long.ts"), BASE_LONG);
  await writeFile(path.join(repoRoot, "src/del.ts"), BASE_DEL);
  await writeFile(path.join(repoRoot, "src/staged.ts"), BASE_STAGED);
  await writeFile(path.join(repoRoot, "src/binary.bin"), BINARY_BYTES);
  await writeFile(path.join(repoRoot, "package.json"), SECRET_PKG);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-m", "base");

  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot);

  return {
    root,
    repoRoot,
    outputRoot,
    sessionsDir: path.join(outputRoot, "sessions"),
    gitConfig: path.join(root, "gitconfig"),
    config: {
      backend: { baseUrl: "http://127.0.0.1:8123", model: "fixture-model" },
      repoRoot,
      outputRoot,
      maxRounds: 10,
      context: {
        tiers: [65_536, 131_072, 196_608],
        minOutputReserve: 32_768,
        preferredOutputReserve: 65_536,
        rulesSoftBudget: 8_192,
      },
    },
  };
}

/**
 * Ana checkout'ta ÖNCEDEN var olan delta (DESIGN §7.3 "base delta"):
 * unstaged değişiklik, staged değişiklik, staged+unstaged, staged yeni
 * dosya, SEÇİLEN untracked dosya ve seçilmeyen untracked dosya. Hepsi
 * base'e girer (seçilmeyen untracked hariç) — export edilen patch'te
 * DEĞİŞİKLİK olarak ASLA bulunmamalı (spec 33).
 */
async function applyBaseDelta(fixture: Fixture): Promise<void> {
  const repo = fixture.repoRoot;
  await writeFile(path.join(repo, "src/a.ts"), `${BASE_A}// user-unstaged-delta\n`);
  await writeFile(path.join(repo, "src/staged.ts"), "export const staged = 'v2-staged-delta';\n");
  git(repo, "add", "src/staged.ts");
  await writeFile(path.join(repo, "src/b.ts"), "const other = 20; // staged-delta\n");
  git(repo, "add", "src/b.ts");
  await writeFile(path.join(repo, "src/b.ts"), "const other = 30; // unstaged-delta\n");
  await writeFile(path.join(repo, "src/staged-new.ts"), "export const stagedNew = 'staged-new-delta';\n");
  git(repo, "add", "src/staged-new.ts");
  await writeFile(path.join(repo, "src/untracked-selected.ts"), "export const untracked = 'selected-delta';\n");
  await writeFile(path.join(repo, "notes.local.txt"), "unselected untracked delta\n");
}

// ── Sahte backend (model çağrısı YOK; tüm dokunuşlar sayılır) ───────────────

interface RunCall {
  messages: InferenceMessage[];
  options: InferenceRunOptions | undefined;
}

class FakeBackend implements InferenceBackend {
  #current: RuntimeInfo | null = null;
  nextInfo: RuntimeInfo | null = {
    ready: true,
    maximumContextTokens: 128_000,
    servedModel: "fixture-model",
    runtimeProcessId: 4242,
  };
  runBehavior: (call: RunCall) => Promise<InferenceResult> = async () => {
    throw new Error("runBehavior not configured");
  };
  countBehavior: (messages: InferenceMessage[]) => number = () => 1_000;
  runCalls: RunCall[] = [];
  refreshCalls = 0;
  tokenizeCalls = 0;
  countCalls = 0;
  renderCalls = 0;

  get runtimeInfo(): RuntimeInfo | null {
    return this.#current;
  }
  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    this.refreshCalls++;
    if (signal?.aborted || this.nextInfo === null) {
      throw new BackendError("network", "Could not reach the inference runtime");
    }
    this.#current = this.nextInfo;
    return this.#current;
  }
  async run(messages: InferenceMessage[], options?: InferenceRunOptions): Promise<InferenceResult> {
    const entry: RunCall = { messages, options };
    this.runCalls.push(entry);
    return this.runBehavior(entry);
  }
  async tokenize(_content: string): Promise<TokenizeResult> {
    this.tokenizeCalls++;
    return { tokens: [], count: 0 };
  }
  async renderPrompt(): Promise<never> {
    this.renderCalls++;
    throw new Error("renderPrompt must not be called");
  }
  async countPromptTokens(messages: InferenceMessage[]): Promise<number> {
    this.countCalls++;
    return this.countBehavior(messages);
  }
  /**
   * Inference yüzeyine HER dokunuş (run + runtime yenileme + tokenizer +
   * prompt sayımı + render). diff/close bunu ASLA artırmamalı (spec 5/14).
   */
  touches(): number {
    return this.runCalls.length + this.refreshCalls + this.tokenizeCalls + this.countCalls + this.renderCalls;
  }
}

class FakeLock implements RuntimeLockLike {
  busy = false;
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    if (this.busy) {
      return { acquired: false, reason: "busy" };
    }
    return { acquired: true, token: `tok-${ownerId}` };
  }
  async release(_token: string): Promise<void> {}
}

const cleanScanner = async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];

/**
 * Sayaçlı Context Assembler (gerçek `ContextAssembler`'ı sarar):
 * `assembleCalls` = bağlam kurma (diff/close'ta 0 kalmalı — spec 5/14);
 * `captureCalls` = stale ölçümü (close'ta 1; diff'te 0 — spec 6/12).
 */
class CountingAssembler {
  assembleCalls = 0;
  captureCalls = 0;
  constructor(private readonly inner: ContextAssembler) {}
  assemble(input: ContextAssemblyInput): Promise<AssembledContext> {
    this.assembleCalls++;
    return this.inner.assemble(input);
  }
  captureLiveBase(input: LiveBaseCaptureInput): Promise<LiveBaseState> {
    this.captureCalls++;
    return this.inner.captureLiveBase(input);
  }
}

// ── Instrument edilmiş workspace (GERÇEK GitWorktreeWorkspace'i sarar) ──────

/**
 * Paylaşılan prob: workspace metot çağrı sayaçları + arıza/kapı kancaları.
 * - `failNextDestroy`: SONRAKİ `destroy` çağrısı hata atar — `"before"`:
 *   gerçek imhadan ÖNCE (worktree sağlam kalır); `"after"`: gerçek imha
 *   YAPILDIKTAN sonra (worktree gitmiş, nesne destroyed) — tek atımlık.
 * - `exportGate`: `exportPatch` gerçek export'tan önce bu kapıyı bekler
 *   (close'u kilit içinde TUTMAK için); `onExportEntered` girişte çağrılır.
 */
interface WorkspaceProbe {
  calls: Map<string, number>;
  failNextDestroy: "before" | "after" | null;
  exportGate: Promise<void> | null;
  onExportEntered: (() => void) | null;
}

function newProbe(): WorkspaceProbe {
  return { calls: new Map(), failNextDestroy: null, exportGate: null, onExportEntered: null };
}

function probeCount(probe: WorkspaceProbe, name: string): number {
  return probe.calls.get(name) ?? 0;
}

function probeSnapshot(probe: WorkspaceProbe): Record<string, number> {
  return Object.fromEntries([...probe.calls.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Proxy: tüm metotlar GERÇEK nesneye bağlı (`apply(target)`) çağrılır —
 * iç çağrılar (ör. `applyPatchSet` → `statInternal`) proxy'den GEÇMEZ,
 * yani sayaçlar yalnız SessionManager'ın DIŞ çağrılarını sayar.
 */
function instrumentWorkspace(real: Workspace, probe: WorkspaceProbe): Workspace {
  const bump = (name: string): void => {
    probe.calls.set(name, (probe.calls.get(name) ?? 0) + 1);
  };
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      const name = String(prop);
      if (name === "destroy") {
        return async (): Promise<void> => {
          bump(name);
          const mode = probe.failNextDestroy;
          if (mode !== null) {
            probe.failNextDestroy = null; // tek atımlık
            if (mode === "after") {
              await target.destroy();
            }
            throw new WorkspaceError("workspace_operation_failed", "Workspace destruction failed");
          }
          await target.destroy();
        };
      }
      if (name === "exportPatch") {
        return async (outputRoot: string): Promise<string> => {
          bump(name);
          probe.onExportEntered?.();
          if (probe.exportGate !== null) {
            await probe.exportGate;
          }
          return target.exportPatch(outputRoot);
        };
      }
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        bump(name);
        return fn.apply(target, args);
      };
    },
  });
}

// ── MCP runtime oturumu ──────────────────────────────────────────────────────

interface RuntimeOptions {
  /** Config eşi (ör. `maxRounds: 1`). Verilmezse fikstür config'i. */
  config?: SplashConfig;
  /** Verilirse task'ın oluşturduğu workspace'ler bu probla instrument edilir. */
  probe?: WorkspaceProbe;
}

interface RuntimeSession {
  client: Client;
  runtime: SplashRuntime;
  backend: FakeBackend;
  lock: FakeLock;
  assembler: CountingAssembler;
}

async function makeRuntimeSession(
  t: TestContext,
  fixture: Fixture,
  tag: string,
  options: RuntimeOptions = {},
): Promise<RuntimeSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const backend = new FakeBackend();
  const lock = new FakeLock();
  const assembler = new CountingAssembler(new ContextAssembler({ runtime: backend }));
  const runtimeOptions: SplashRuntimeOptions = {
    backend,
    coordinator: new InferenceCoordinator({
      backend,
      runtimeDir: path.join(fixture.outputRoot, `runtime-${tag}`),
      scanner: cleanScanner,
      lock,
    }),
    contextAssembler: assembler,
    processCwd: () => fixture.repoRoot,
  };
  const probe = options.probe;
  if (probe !== undefined) {
    runtimeOptions.createWorkspace = async (input) => instrumentWorkspace(await createGitWorktreeWorkspace(input), probe);
  }
  const runtime = createSplashRuntime(options.config ?? fixture.config, runtimeOptions);
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: `splash-step10-${tag}`, version: "0.0.1" });
  await client.connect(clientTransport);
  t.after(async () => {
    try {
      await client.close();
    } catch {}
    try {
      await runtime.server.close();
    } catch {}
    await runtime.dispose().catch(() => undefined);
  });
  return { client, runtime, backend, lock, assembler };
}

/** Süreç kapanışı simülasyonu (Step 9 455 kalıbı): dispose → transport kapat. */
async function shutdown(session: RuntimeSession): Promise<void> {
  await session.runtime.dispose();
  await session.client.close().catch(() => undefined);
  await session.runtime.server.close().catch(() => undefined);
}

// ── Wire yardımcıları ────────────────────────────────────────────────────────

interface WireContent {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<WireContent> {
  return (await client.callTool({ name, arguments: args })) as WireContent;
}

/**
 * Şema-reddi beklenen çağrı: SDK sürümüne göre şema hatası `isError` sonucu
 * YA DA fırlatılan `McpError` olabilir — ikisi de "reddedildi" sayılır.
 */
async function callExpectingRejection(client: Client, name: string, args: Record<string, unknown>): Promise<WireContent> {
  try {
    return (await client.callTool({ name, arguments: args })) as WireContent;
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

function wireText(res: WireContent): string {
  return res.content?.[0]?.text ?? "";
}

function parseWire(res: WireContent): Record<string, unknown> {
  const item = res.content?.[0];
  assert.ok(item !== undefined && item.type === "text" && typeof item.text === "string", "text content eksik");
  return JSON.parse(item.text) as Record<string, unknown>;
}

function expectOk(res: WireContent, label: string): Record<string, unknown> {
  assert.ok(!res.isError, `${label}: beklenmedik hata: ${wireText(res)}`);
  return parseWire(res);
}

/** `splash_diff` normal mod: HAM unified diff metni (sarmalayıcı YOK). */
function expectDiffText(res: WireContent, label: string): string {
  assert.ok(!res.isError, `${label}: beklenmedik hata: ${wireText(res)}`);
  return wireText(res);
}

interface DiffStatsWire {
  files: number;
  insertions: number;
  deletions: number;
}

/** `splash_diff stat:true`: YALNIZ `{"diff_stats":{files,insertions,deletions}}`. */
function expectStat(res: WireContent, label: string): DiffStatsWire {
  const json = expectOk(res, label);
  assert.deepEqual(Object.keys(json), ["diff_stats"], `${label}: stat yanıtı yalnız diff_stats taşımalı`);
  const stats = json.diff_stats as Record<string, unknown>;
  assert.deepEqual(Object.keys(stats).sort(), ["deletions", "files", "insertions"], `${label}: diff_stats anahtarları`);
  for (const key of ["files", "insertions", "deletions"] as const) {
    assert.ok(Number.isInteger(stats[key]), `${label}: ${key} tam sayı olmalı`);
  }
  return stats as unknown as DiffStatsWire;
}

/** Tip'li güvenli hata: `{kind, message}` — başka alan YOK (status yalnız http). */
function expectToolError(res: WireContent, kind: string, label: string): Record<string, unknown> {
  assert.equal(res.isError, true, `${label}: hata bekleniyordu, gelen: ${wireText(res)}`);
  const json = parseWire(res);
  assert.equal(json.kind, kind, `${label}: ${wireText(res)}`);
  assert.deepEqual(Object.keys(json).sort(), ["kind", "message"], `${label}: hata wire anahtarları`);
  assert.equal(typeof json.message, "string");
  return json;
}

const SESSION_NOT_FOUND = { kind: "session_not_found", message: "The session was not found" };

function expectSessionNotFound(res: WireContent, label: string): void {
  assert.equal(res.isError, true, `${label}: session_not_found bekleniyordu, gelen: ${wireText(res)}`);
  assert.deepEqual(parseWire(res), SESSION_NOT_FOUND, label);
}

interface CloseWire {
  patch_path: string;
  files_changed: string[];
  diff_stats: DiffStatsWire;
  summary: string;
  base_status: "fresh" | "stale";
  stale_files?: string[];
}

/**
 * `splash_close` yanıtı — anahtar kümesi BİREBİR (spec 10/29): fresh'te
 * `stale_files` YOK; stale'de ZORUNLU. İçerik alanı (diff/patch/source) YOK.
 */
function expectClose(res: WireContent, baseStatus: "fresh" | "stale", label = "splash_close"): CloseWire {
  const json = expectOk(res, label);
  const expectedKeys =
    baseStatus === "fresh"
      ? ["base_status", "diff_stats", "files_changed", "patch_path", "summary"]
      : ["base_status", "diff_stats", "files_changed", "patch_path", "stale_files", "summary"];
  assert.deepEqual(Object.keys(json).sort(), expectedKeys, `${label}: close wire anahtar kümesi`);
  assert.equal(json.base_status, baseStatus, `${label}: base_status`);
  assert.equal(typeof json.patch_path, "string");
  assert.equal(typeof json.summary, "string");
  const filesChanged: unknown = json.files_changed;
  assert.ok(
    Array.isArray(filesChanged) && filesChanged.every((entry: unknown) => typeof entry === "string"),
    `${label}: files_changed string dizisi olmalı`,
  );
  const stats = json.diff_stats as Record<string, unknown>;
  assert.deepEqual(Object.keys(stats).sort(), ["deletions", "files", "insertions"], `${label}: diff_stats anahtarları`);
  for (const key of ["files", "insertions", "deletions"] as const) {
    assert.ok(Number.isInteger(stats[key]), `${label}: diff_stats.${key} tam sayı olmalı`);
  }
  if (baseStatus === "stale") {
    const staleFiles: unknown = json.stale_files;
    assert.ok(
      Array.isArray(staleFiles) && staleFiles.length > 0 && staleFiles.every((entry: unknown) => typeof entry === "string"),
      `${label}: stale_files boş-olmayan string dizisi olmalı`,
    );
  }
  return json as unknown as CloseWire;
}

/** Compact / close / hata yanıtlarında kaynak, sır, git stderr, diff biçimi YOK. */
function assertNoLeak(text: string, label: string): void {
  for (const needle of [
    "const value = 1;",
    "const other = 10;",
    "// L01",
    "export const doomed",
    "NEVER_ON_WIRE",
    "EDITABLE BASE",
    "READ-ONLY REFERENCE",
    "fatal:",
    "diff --git",
    "GIT binary patch",
    "@@ -",
    MARKER,
  ]) {
    assert.ok(!text.includes(needle), `${label}: yanıtta "${needle}" sızdı`);
  }
}

// ── Worker çıktısı kurucuları (Step 4 şeması) ────────────────────────────────

type WorkerEdit =
  | { kind: "modify"; path: string; operations: Array<{ search: string; replace: string }> }
  | { kind: "create"; path: string; content: string }
  | { kind: "delete"; path: string };

function workerJson(summary: string, edits: WorkerEdit[]): string {
  return JSON.stringify({ schema_version: 1, summary, edits });
}

function modifyA(replace: string): WorkerEdit {
  return { kind: "modify", path: "src/a.ts", operations: [{ search: "const value = 1;", replace }] };
}

function respondWith(content: string): () => Promise<InferenceResult> {
  return async () => ({ content, usage: { inputTokens: 10, outputTokens: 5 } });
}

// ── fs / yol yardımcıları ────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function sessionPaths(fixture: Fixture, sessionId: string): { sessionDir: string; wsDir: string; sessionJson: string } {
  const sessionDir = path.join(fixture.sessionsDir, sessionId);
  return {
    sessionDir,
    wsDir: path.join(sessionDir, "workspace"),
    sessionJson: path.join(sessionDir, "session.json"),
  };
}

/** Sözleşme yolu: `<outputRoot>/patches/<computeRepoId(repoRoot)>/<session-id>.patch`. */
function expectedPatchPath(fixture: Fixture, sessionId: string): string {
  return path.join(fixture.outputRoot, "patches", computeRepoId(fixture.repoRoot), `${sessionId}.patch`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/**
 * Ağaç bayt anlık görüntüsü (`.git` hariç): yol → tip + TAM izin modu +
 * içerik özeti / link hedefi. Ana checkout'un BİREBİR korunduğunu kanıtlar.
 */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (childRel === ".git") {
        continue;
      }
      const abs = path.join(dir, entry.name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        out.set(childRel, `symlink:${await readlink(abs)}`);
      } else if (st.isDirectory()) {
        out.set(childRel, `dir:${(st.mode & 0o777).toString(8)}`);
        await walk(abs, childRel);
      } else if (st.isFile()) {
        out.set(childRel, `file:${(st.mode & 0o777).toString(8)}:${sha256(await readFile(abs))}`);
      } else {
        out.set(childRel, "other");
      }
    }
  }
  await walk(root, "");
  return out;
}

/**
 * İçerik ağacı (`.git` + dizinler hariç): yol → exec biti + içerik özeti.
 * `git apply` sonucunu karşılaştırmak için (umask'tan bağımsız).
 */
async function contentTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [rel, value] of await snapshotTree(root)) {
    if (value.startsWith("dir:")) {
      continue;
    }
    if (value.startsWith("file:")) {
      const [, mode = "0", digest = ""] = value.split(":");
      out.set(rel, `file:${(Number.parseInt(mode, 8) & 0o100) !== 0 ? "x" : "-"}:${digest}`);
    } else {
      out.set(rel, value);
    }
  }
  return out;
}

function contentEntry(content: string | Buffer, executable = false): string {
  return `file:${executable ? "x" : "-"}:${sha256(content)}`;
}

/**
 * Ana checkout git metadata'sı (salt-okunur sorgular): HEAD, `.git/HEAD`,
 * ana index baytları, tüm ref'ler. Close ana index'e/ref'lere DOKUNMAMALI
 * (worktree yönetimi yalnız `.git/worktrees/` + nesne veritabanına yazar).
 */
async function snapshotGitMeta(repo: string): Promise<Record<string, string>> {
  return {
    head: gitOut(repo, "rev-parse", "HEAD"),
    headFile: await readFile(path.join(repo, ".git", "HEAD"), "utf8"),
    index: sha256(await readFile(path.join(repo, ".git", "index"))),
    refs: gitOut(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
  };
}

/** Patch'in DEĞİŞİKLİK satırları (`+`/`-`; dosya başlıkları `+++`/`---` hariç). */
function changedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
}

/**
 * YALNIZ TEST HARNESS: ana checkout'un TEK KULLANIMLIK kopyasına `git apply`.
 * Ana checkout'a (ya da içine) karşı çağrı KORUMA ile reddedilir — Splash
 * üretim kodu patch uygulamaz; test de ana repoya uygulamaz.
 */
function gitApplyInCopy(
  fixture: Fixture,
  copyDir: string,
  patchPath: string,
  checkOnly: boolean,
  globalConfig?: string,
): void {
  const resolved = path.resolve(copyDir);
  assert.notEqual(resolved, fixture.repoRoot, "harness: git apply ana checkout'a KARŞI çalıştırılamaz");
  assert.ok(!isInside(fixture.repoRoot, resolved), "harness: git apply ana checkout İÇİNDE çalıştırılamaz");
  const args = checkOnly ? ["apply", "--check", patchPath] : ["apply", patchPath];
  // `globalConfig`: kopyayı VARSAYILAN (boş) global config ile uygula (M1/H).
  const env = globalConfig === undefined ? process.env : { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  execFileSync("git", args, { cwd: resolved, stdio: ["ignore", "pipe", "pipe"], env });
}

/** Varsayılan (boş) global git config dosyası — tek kullanımlık kopyaya `git apply` için. */
async function defaultGitConfig(fixture: Fixture): Promise<string> {
  const file = path.join(fixture.root, "gitconfig-default");
  await writeFile(file, "");
  return file;
}

/**
 * İçerik OKUMAYAN meta anlık görüntüsü: yol → tip + mod + boyut + mtime +
 * ctime + inode (lstat). Okunamaz (0000) dosyalı dış dizinde "hiçbir şey
 * yazılmadı / değiştirilmedi" kanıtı için (F-b).
 */
async function metaTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      const st = await lstat(abs);
      const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      out.set(childRel, `${kind}:${(st.mode & 0o7777).toString(8)}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
      if (kind === "dir") {
        await walk(abs, childRel);
      }
    }
  }
  await walk(root, "");
  return out;
}

/** Ana checkout'un tam kopyası (`.git` dahil — staged/unstaged durum aynen). */
async function copyMainCheckout(fixture: Fixture, name: string): Promise<string> {
  const copyDir = path.join(fixture.root, name);
  await cp(fixture.repoRoot, copyDir, { recursive: true });
  return copyDir;
}

/** Kapanmış oturum diskte iz bırakmaz: workspace + session.json + oturum dizini + worktree kaydı YOK. */
async function assertClosedOnDisk(fixture: Fixture, sessionId: string, label: string): Promise<void> {
  const paths = sessionPaths(fixture, sessionId);
  assert.ok(!(await pathExists(paths.wsDir)), `${label}: workspace dizini kalmamalı`);
  assert.ok(!(await pathExists(paths.sessionJson)), `${label}: session.json kalmamalı`);
  assert.ok(!(await pathExists(paths.sessionDir)), `${label}: oturum dizini kalmamalı`);
  const worktrees = gitOut(fixture.repoRoot, "worktree", "list", "--porcelain");
  assert.ok(!worktrees.includes(paths.wsDir), `${label}: worktree kaydı kalmamalı`);
}

/** Patch yeri + güvenliği (spec 15/41): mutlak, sözleşme yolu, repo/oturum DIŞI, 0600/0700. */
async function assertPatchLocation(fixture: Fixture, sessionId: string, patchPath: string, label: string): Promise<void> {
  assert.ok(path.isAbsolute(patchPath), `${label}: patch_path mutlak olmalı`);
  assert.equal(patchPath, expectedPatchPath(fixture, sessionId), `${label}: patch yolu sözleşmesi`);
  assert.ok(!isInside(fixture.repoRoot, patchPath), `${label}: patch repo DIŞINDA olmalı`);
  assert.ok(!isInside(fixture.sessionsDir, patchPath), `${label}: patch oturum/workspace DIŞINDA olmalı`);
  const fileStat = await stat(patchPath);
  assert.ok(fileStat.isFile(), `${label}: patch düzenli dosya olmalı`);
  assert.equal(fileStat.mode & 0o777, 0o600, `${label}: patch dosyası 0600 olmalı`);
  assert.equal((await stat(path.dirname(patchPath))).mode & 0o777, 0o700, `${label}: repo-id dizini 0700 olmalı`);
}

// ── Eşzamanlılık yardımcıları (süre YOK) ────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Olay döngüsünü `turns` kez döndürür (`setImmediate`) — SÜRE değil: her tur
 * tüm mikro-görevleri boşaltır. InMemoryTransport teslimi senkron, MCP
 * handler zinciri promise tabanlıdır → gönderilmiş bir isteğin I/O'suz
 * öneki (şema → servis → manager → kilit kaydı / cache-hit yolu) bu turlarda
 * tamamlanır.
 */
async function settleTurns(turns = 25): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function trackSettled<T>(promise: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

// ════════════════════════════════════════════════════════════════════════════
// S10-I1 — fresh close + patch doğruluğu (spec 33, 39A/M/N)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I1: fresh close — complete base-relative patch (modify/create/delete/binary), base delta excluded, applies to a disposable base copy; main checkout byte-identical", async (t) => {
  const fixture = await makeFixture(t);
  await applyBaseDelta(fixture);
  const s = await makeRuntimeSession(t, fixture, "i1");
  const NEW_CONTENT = "export const created = 1;\n";
  s.backend.runBehavior = respondWith(
    workerJson("Implemented the fresh-close fixture.", [
      modifyA("const value = 2;"),
      { kind: "create", path: "src/new.ts", content: NEW_CONTENT },
      { kind: "delete", path: "src/del.ts" },
      { kind: "delete", path: "src/binary.bin" },
    ]),
  );
  const task = expectOk(
    await call(s.client, "splash_task", {
      task: "Fresh close fixture",
      files: ["src/a.ts", "src/del.ts", "src/binary.bin", "src/untracked-selected.ts"],
    }),
    "splash_task",
  );
  assert.equal(task.status, "applied");
  const sessionId = task.session_id as string;
  const { wsDir } = sessionPaths(fixture, sessionId);

  // Worker sonucu (workspace) — base (delta dahil) + worker katkısı.
  const EXPECTED_A = "const value = 2;\n// user-unstaged-delta\n";
  assert.equal(await readFile(path.join(wsDir, "src/a.ts"), "utf8"), EXPECTED_A);
  assert.equal(await readFile(path.join(wsDir, "src/new.ts"), "utf8"), NEW_CONTENT);
  assert.ok(!(await pathExists(path.join(wsDir, "src/del.ts"))));
  assert.ok(!(await pathExists(path.join(wsDir, "src/binary.bin"))));

  const mainBefore = await snapshotTree(fixture.repoRoot);
  const metaBefore = await snapshotGitMeta(fixture.repoRoot);
  const touchesBefore = s.backend.touches();
  const assembleBefore = s.assembler.assembleCalls;

  const closeRes = await call(s.client, "splash_close", { session_id: sessionId });
  const close = expectClose(closeRes, "fresh");
  assertNoLeak(wireText(closeRes), "splash_close");

  // Inference / bağlam kurma YOK (spec 14).
  assert.equal(s.backend.touches(), touchesBefore, "close inference yüzeyine dokunmamalı");
  assert.equal(s.assembler.assembleCalls, assembleBefore, "close bağlam kurmamalı");

  // Ana checkout BİREBİR (spec 2/39M): working tree + index + HEAD + ref'ler.
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore, "ana working tree değişmemeli");
  assert.deepEqual(await snapshotGitMeta(fixture.repoRoot), metaBefore, "ana index/HEAD/ref'ler değişmemeli");

  // Metadata (spec 23): files_changed = son kalıcı sonuç; diff_stats = canlı stat; summary = compact özet.
  assert.deepEqual(close.files_changed, task.files_changed);
  assert.deepEqual([...close.files_changed].sort(), ["src/a.ts", "src/binary.bin", "src/del.ts", "src/new.ts"]);
  assert.deepEqual(close.diff_stats, { files: 4, insertions: 2, deletions: 2 });
  assert.deepEqual(close.diff_stats, task.diff_stats);
  assert.equal(close.summary, task.summary);

  // Patch yeri (spec 15/39N/41).
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I1");
  assert.ok(!isInside(wsDir, close.patch_path));

  // Patch içeriği: tam, base-göreceli, --binary --full-index.
  const patch = await readFile(close.patch_path, "utf8");
  const changed = changedLines(patch);
  assert.ok(patch.includes("diff --git a/src/a.ts b/src/a.ts"));
  assert.ok(changed.includes("-const value = 1;") && changed.includes("+const value = 2;"), "modify temsil edilmeli");
  assert.ok(patch.includes("diff --git a/src/new.ts b/src/new.ts"));
  assert.match(patch, /^new file mode 100644$/m, "create `new file mode` ile temsil edilmeli");
  assert.ok(changed.includes("+export const created = 1;"));
  assert.ok(patch.includes("diff --git a/src/del.ts b/src/del.ts"));
  assert.ok(changed.includes("-export const doomed = true;"), "delete temsil edilmeli");
  assert.ok(patch.includes("diff --git a/src/binary.bin b/src/binary.bin"));
  assert.ok(patch.includes("GIT binary patch"), "binary silme --binary bölümüyle temsil edilmeli");
  assert.equal((patch.match(/^deleted file mode 100644$/gm) ?? []).length, 2);
  assert.match(patch, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m, "--full-index (tam blob SHA) olmalı");

  // Base delta (önceden var olan kullanıcı değişikliği) DEĞİŞİKLİK olarak YOK.
  assert.ok(!changed.some((line) => line.includes("delta")), "base delta patch'te değişiklik satırı olamaz");
  for (const basePath of ["src/staged.ts", "src/b.ts", "src/staged-new.ts", "src/untracked-selected.ts", "notes.local.txt"]) {
    assert.ok(!patch.includes(basePath), `base delta yolu (${basePath}) patch'te olamaz`);
  }

  // YALNIZ HARNESS: tek kullanımlık base kopyasında `git apply --check` + gerçek apply.
  const copy = await copyMainCheckout(fixture, "apply-copy-i1");
  gitApplyInCopy(fixture, copy, close.patch_path, true);
  gitApplyInCopy(fixture, copy, close.patch_path, false);
  const expected = await contentTree(fixture.repoRoot);
  expected.set("src/a.ts", contentEntry(EXPECTED_A));
  expected.set("src/new.ts", contentEntry(NEW_CONTENT));
  expected.delete("src/del.ts");
  expected.delete("src/binary.bin");
  assert.deepEqual(await contentTree(copy), expected, "kopya + patch = worker sonucu (base delta korunur)");

  // Kapanış temizliği + ana checkout hâlâ BİREBİR (harness kopyası ana repoya dokunmadı).
  await assertClosedOnDisk(fixture, sessionId, "S10-I1");
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I2 — patch survival (spec 34, 39A)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I2: patch survival — workspace dir, session.json and sessions/<id> are gone; the exported patch bytes stay readable", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i2");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const paths = sessionPaths(fixture, sessionId);
  assert.ok(await pathExists(paths.wsDir));
  assert.ok(await pathExists(paths.sessionJson));

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  await assertClosedOnDisk(fixture, sessionId, "S10-I2");
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I2");

  const bytes = await readFile(close.patch_path);
  assert.ok(bytes.length > 0, "patch boş olmamalı");
  const text = bytes.toString("utf8");
  assert.ok(text.includes("diff --git a/src/a.ts b/src/a.ts"));
  assert.ok(changedLines(text).includes("+const value = 2;"));

  // Kapanan oturum RAM'den diriltilemez (spec 21) — patch yine yerinde.
  expectSessionNotFound(await call(s.client, "splash_diff", { session_id: sessionId }), "close sonrası diff");
  assert.deepEqual(await readFile(close.patch_path), bytes, "patch sonraki çağrılarda da korunur");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I3 — stale close: export eder, UYGULAMAZ (spec 13, 31, 39B)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I3: stale close — exports anyway, reports stale_files, never touches the drifted main file; patch is immutable base → worker", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i3");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;

  // Ana checkout'ta editable dosya sürüklenir (testin kasıtlı düzenlemesi).
  const DRIFTED = "const value = 1;\n// drifted-in-main\n";
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), DRIFTED);
  const mainBefore = await snapshotTree(fixture.repoRoot);
  const metaBefore = await snapshotGitMeta(fixture.repoRoot);
  const touchesBefore = s.backend.touches();

  const closeRes = await call(s.client, "splash_close", { session_id: sessionId });
  const close = expectClose(closeRes, "stale");
  assert.deepEqual(close.stale_files, ["src/a.ts"]);
  assertNoLeak(wireText(closeRes), "stale splash_close");
  assert.equal(s.backend.touches(), touchesBefore, "stale close inference yapmamalı");

  // Splash UYGULAMADI: ana dosya testin yazdığı haliyle BİREBİR; ağacın geri kalanı da.
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), DRIFTED);
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);
  assert.deepEqual(await snapshotGitMeta(fixture.repoRoot), metaBefore);

  // Patch export edildi ve oturum kapandı (stale kapanışı ENGELLEMEZ).
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I3");
  await assertClosedOnDisk(fixture, sessionId, "S10-I3");
  assert.deepEqual(close.files_changed, ["src/a.ts"]);

  // Patch immutable base → worker: sürüklenmiş içerik patch'te YOK.
  const patch = await readFile(close.patch_path, "utf8");
  const changed = changedLines(patch);
  assert.ok(changed.includes("-const value = 1;") && changed.includes("+const value = 2;"));
  assert.ok(!patch.includes("drifted-in-main"), "sürüklenmiş ana içerik patch'e girmemeli");

  // YALNIZ HARNESS: base durumuna döndürülmüş kopyada patch uygulanır.
  const copy = await copyMainCheckout(fixture, "apply-copy-i3");
  await writeFile(path.join(copy, "src/a.ts"), BASE_A);
  gitApplyInCopy(fixture, copy, close.patch_path, true);
  gitApplyInCopy(fixture, copy, close.patch_path, false);
  assert.equal(await readFile(path.join(copy, "src/a.ts"), "utf8"), "const value = 2;\n");
  // Ana dosya hâlâ sürüklenmiş haliyle.
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/a.ts"), "utf8"), DRIFTED);
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I4 — created-path collision close (spec 32, 39C)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I4: created-path collision — main independently creates the worker-created path → stale + stale_files, patch exported, session closed, main file untouched", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i4");
  const WORKER_NEW = "export const created = 'worker';\n";
  const MAIN_NEW = "export const created = 'main-independent';\n";
  s.backend.runBehavior = respondWith(
    workerJson("Created a new module.", [modifyA("const value = 2;"), { kind: "create", path: "src/new.ts", content: WORKER_NEW }]),
  );
  const task = expectOk(await call(s.client, "splash_task", { task: "Create a module", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;

  await writeFile(path.join(fixture.repoRoot, "src/new.ts"), MAIN_NEW);
  const mainBefore = await snapshotTree(fixture.repoRoot);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "stale");
  assert.deepEqual(close.stale_files, ["src/new.ts"], "çakışan create yolu stale raporlanmalı (yalnız o)");

  // Ana dosya AYNEN; ağaç BİREBİR.
  assert.equal(await readFile(path.join(fixture.repoRoot, "src/new.ts"), "utf8"), MAIN_NEW);
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);

  // Patch export edildi: worker'ın create'i (ana içerik DEĞİL).
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I4");
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(patch.includes("diff --git a/src/new.ts b/src/new.ts"));
  assert.match(patch, /^new file mode 100644$/m);
  assert.ok(changedLines(patch).includes("+export const created = 'worker';"));
  assert.ok(!patch.includes("main-independent"));

  // Oturum kapandı.
  await assertClosedOnDisk(fixture, sessionId, "S10-I4");
  expectSessionNotFound(await call(s.client, "splash_diff", { session_id: sessionId }), "close sonrası diff");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I5 — restart: diff birebir + close, inference YOK (spec 5, 43, 38G, 39E)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I5: restart — runtime B (fresh backend) returns the exact same splash_diff and closes the session without any inference", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = respondWith(
    workerJson("Round 1.", [modifyA("const value = 2;"), { kind: "create", path: "src/new.ts", content: "export const n = 1;\n" }]),
  );
  const task = expectOk(await call(a.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const diffA = expectDiffText(await call(a.client, "splash_diff", { session_id: sessionId }), "A diff");
  const statA = expectStat(await call(a.client, "splash_diff", { session_id: sessionId, stat: true }), "A stat");
  assert.ok(diffA.includes("+const value = 2;"));
  await shutdown(a);

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => {
    throw new Error("inference must not run during recovery/diff/close");
  };
  const diffB = expectDiffText(await call(b.client, "splash_diff", { session_id: sessionId }), "B diff");
  assert.equal(diffB, diffA, "yeniden başlatma sonrası diff BİREBİR aynı olmalı");
  assert.deepEqual(expectStat(await call(b.client, "splash_diff", { session_id: sessionId, stat: true }), "B stat"), statA);

  const close = expectClose(await call(b.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, task.files_changed);
  assert.deepEqual(close.diff_stats, task.diff_stats);
  assert.equal(close.summary, task.summary);
  assert.equal(b.backend.touches(), 0, "B'nin backend'i HİÇ çağrılmamalı");
  assert.equal(b.assembler.assembleCalls, 0, "B bağlam kurmamalı");

  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I5");
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(changedLines(patch).includes("+const value = 2;"));
  assert.ok(patch.includes("diff --git a/src/new.ts b/src/new.ts"));
  await assertClosedOnDisk(fixture, sessionId, "S10-I5");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I6 — restart + silinmiş worktree → yeniden kurulum (spec 43)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I6: restart after the worktree was removed — runtime B reconstructs it, splash_diff is identical, splash_close succeeds and cleans up", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = respondWith(workerJson("Round 1.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(a.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const diffA = expectDiffText(await call(a.client, "splash_diff", { session_id: sessionId }), "A diff");
  await shutdown(a);

  const { wsDir } = sessionPaths(fixture, sessionId);
  git(fixture.repoRoot, "worktree", "remove", "--force", wsDir);
  git(fixture.repoRoot, "worktree", "prune");
  assert.ok(!(await pathExists(wsDir)));

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => {
    throw new Error("inference must not run during recovery/diff/close");
  };
  const diffB = expectDiffText(await call(b.client, "splash_diff", { session_id: sessionId }), "B diff");
  assert.equal(diffB, diffA, "yeniden kurulan worktree aynı diff'i üretmeli");
  assert.ok(await pathExists(wsDir), "worktree yeniden kurulmuş olmalı");

  const close = expectClose(await call(b.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, ["src/a.ts"]);
  assert.equal(b.backend.touches(), 0);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I6");
  await assertClosedOnDisk(fixture, sessionId, "S10-I6");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I7 — export hatası (gerçek fs): hiçbir şey silinmez, retry kurtarır (spec 16, 35, 39F)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I7: export failure (real fs: <outputRoot>/patches is a FILE) — close fails with export_failed, workspace + session.json survive, diff still works; after the fault is removed close succeeds", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i7");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const paths = sessionPaths(fixture, sessionId);
  const diffBefore = expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff");
  const sessionJsonBefore = await readFile(paths.sessionJson);
  const mainBefore = await snapshotTree(fixture.repoRoot);

  // Deterministik arıza: beklenen dizin yerine DÜZ DOSYA.
  const blocker = path.join(fixture.outputRoot, "patches");
  await writeFile(blocker, "not a directory\n");

  const failed = await call(s.client, "splash_close", { session_id: sessionId });
  expectToolError(failed, "export_failed", "export hatası");
  const failedText = wireText(failed);
  assert.ok(!failedText.includes(fixture.root), "hata mesajı yol sızdırmamalı");
  assertNoLeak(failedText, "export hatası");

  // Hiçbir şey silinmedi; başarı iddiası YOK.
  assert.ok(await pathExists(paths.wsDir), "workspace korunmalı");
  assert.ok(await pathExists(paths.sessionJson), "session.json korunmalı");
  assert.deepEqual(await readFile(paths.sessionJson), sessionJsonBefore, "kalıcı durum değişmemeli");
  assert.ok((await stat(blocker)).isFile(), "arıza dosyası olduğu gibi kalır");
  assert.ok(!(await pathExists(expectedPatchPath(fixture, sessionId))));

  // Oturum kullanılabilir (RAM yanlışlıkla kapatılmadı).
  assert.equal(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "export hatası sonrası diff"), diffBefore);

  // Arıza kaldırılır → retry başarılı.
  await rm(blocker);
  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I7");
  await assertClosedOnDisk(fixture, sessionId, "S10-I7");
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I8 — destroy hatası (instrument edilmiş Workspace dikişi) (spec 17, 36, 39G)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I8: destroy failure BEFORE removal — close fails; patch + session.json + worktree remain; diff recovers; retry closes with a byte-identical patch", async (t) => {
  const fixture = await makeFixture(t);
  const probe = newProbe();
  const s = await makeRuntimeSession(t, fixture, "i8", { probe });
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const paths = sessionPaths(fixture, sessionId);
  const diffBefore = expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff");

  probe.failNextDestroy = "before";
  const failed = await call(s.client, "splash_close", { session_id: sessionId });
  expectToolError(failed, "workspace_operation_failed", "destroy hatası");
  assert.equal(probeCount(probe, "exportPatch"), 1, "destroy'dan ÖNCE export yapılmış olmalı");
  assert.equal(probeCount(probe, "destroy"), 1);

  // Patch dayanıklı kurtarma artifact'ı; yetkili durum silinmedi.
  const patchPath = expectedPatchPath(fixture, sessionId);
  assert.ok(await pathExists(patchPath), "patch kalmalı");
  const firstPatch = await readFile(patchPath);
  assert.ok(await pathExists(paths.sessionJson), "session.json kalmalı (destroy tamamlanmadı)");
  assert.ok(await pathExists(paths.wsDir), "worktree (bu varyantta) sağlam kalır");

  // Oturum hâlâ incelenebilir (lazy kurtarma ya da reuse).
  assert.equal(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "destroy hatası sonrası diff"), diffBefore);

  const touchesBefore = s.backend.touches();
  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.equal(close.patch_path, patchPath);
  assert.deepEqual(await readFile(patchPath), firstPatch, "retry export'u deterministik (birebir aynı patch)");
  assert.equal(s.backend.touches(), touchesBefore);
  await assertClosedOnDisk(fixture, sessionId, "S10-I8");
});

test("S10-I8b: destroy failure AFTER the worktree was removed — RAM must not trust the destroyed workspace: retry recovers from disk (recreate) and closes", async (t) => {
  const fixture = await makeFixture(t);
  const probe = newProbe();
  const s = await makeRuntimeSession(t, fixture, "i8b", { probe });
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const paths = sessionPaths(fixture, sessionId);

  probe.failNextDestroy = "after";
  expectToolError(await call(s.client, "splash_close", { session_id: sessionId }), "workspace_operation_failed", "destroy hatası");
  const patchPath = expectedPatchPath(fixture, sessionId);
  assert.ok(await pathExists(patchPath), "patch kalmalı");
  const firstPatch = await readFile(patchPath);
  assert.ok(await pathExists(paths.sessionJson), "session.json kalmalı");
  assert.ok(!(await pathExists(paths.wsDir)), "bu varyantta worktree gerçekten imha edildi");

  // RAM tahliye edilmediyse retry imha edilmiş nesneyi kullanır → workspace_destroyed.
  // Doğru davranış: disk yetkili → kurtarma worktree'yi yeniden kurar → close başarılı.
  const touchesBefore = s.backend.touches();
  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, ["src/a.ts"]);
  assert.deepEqual(await readFile(patchPath), firstPatch, "yeniden kurulumdan export birebir aynı");
  assert.equal(s.backend.touches(), touchesBefore, "kurtarma model-free");
  await assertClosedOnDisk(fixture, sessionId, "S10-I8b");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I9 — yetkili durum silme hatası (doğrudan SessionManager) (spec 20, 37, 39H)
// ════════════════════════════════════════════════════════════════════════════

/** İlk `n` `delete` çağrısını unlink'ten ÖNCE `session_operation_failed` ile reddeder. */
class FailingDeleteStore implements SessionStoreLike {
  deleteCalls = 0;
  #failuresLeft: number;
  constructor(
    private readonly inner: SessionStoreLike,
    failures: number,
  ) {
    this.#failuresLeft = failures;
  }
  get sessionsDir(): string {
    return this.inner.sessionsDir;
  }
  sessionDirFor(sessionId: string): string {
    return this.inner.sessionDirFor(sessionId);
  }
  create(sessionId: string): Promise<string> {
    return this.inner.create(sessionId);
  }
  load(sessionId: string): Promise<PersistedSession> {
    return this.inner.load(sessionId);
  }
  save(session: PersistedSession): Promise<void> {
    return this.inner.save(session);
  }
  async delete(sessionId: string): Promise<void> {
    this.deleteCalls++;
    if (this.#failuresLeft > 0) {
      this.#failuresLeft--;
      throw new SessionError("session_operation_failed");
    }
    await this.inner.delete(sessionId);
  }
}

test("S10-I9: store delete failure after destroy — close fails, session.json stays authoritative, RAM evicted; retry recreates the workspace from disk and closes", async (t) => {
  const fixture = await makeFixture(t);
  const backend = new FakeBackend();
  const lock = new FakeLock();
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir: path.join(fixture.outputRoot, "runtime-m"),
    scanner: cleanScanner,
    lock,
  });
  const store = new FailingDeleteStore(new SessionStore(fixture.outputRoot, { repoIdentity: computeRepoId }), 1);
  const restoreCalls = { count: 0 };
  const manager = new SessionManager({
    config: fixture.config,
    coordinator,
    contextAssembler: new ContextAssembler({ runtime: backend }),
    workerContract: new WorkerContract(),
    rulesResolver: new RulesResolver(),
    createWorkspace: (input) => createGitWorktreeWorkspace(input),
    restoreWorkspace: (state, options) => {
      restoreCalls.count++;
      return restoreGitWorktreeWorkspace(state, options);
    },
    store,
    repoIdentity: computeRepoId,
    processCwd: () => fixture.repoRoot,
  });
  t.after(async () => {
    await manager.dispose().catch(() => undefined);
  });

  backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = await manager.createTask({ task: "Change the value", files: ["src/a.ts"] });
  assert.equal(task.status, "applied");
  const sessionId = task.sessionId;
  const paths = sessionPaths(fixture, sessionId);
  const touchesBefore = backend.touches();

  await assert.rejects(manager.close({ sessionId }), (err: unknown) => {
    assert.ok(err instanceof SessionError, "tip'li oturum hatası bekleniyordu");
    assert.equal(err.kind, "session_operation_failed");
    const wire = serializeToolError(err);
    assert.equal(wire.kind, "session_operation_failed");
    assert.deepEqual(Object.keys(wire).sort(), ["kind", "message"]);
    return true;
  });
  assert.equal(store.deleteCalls, 1);
  assert.ok(await pathExists(paths.sessionJson), "session.json yetkili kalmalı");
  assert.ok(!(await pathExists(paths.wsDir)), "workspace imha edilmişti");
  const patchPath = expectedPatchPath(fixture, sessionId);
  assert.ok(await pathExists(patchPath), "patch kalmalı");
  const firstPatch = await readFile(patchPath);
  assert.ok(
    !manager.activeSessions().some((entry) => entry.sessionId === sessionId),
    "imha edilmiş workspace RAM'de bırakılmamalı",
  );
  assert.equal(restoreCalls.count, 0);

  // Retry: lazy kurtarma workspace'i diskten yeniden kurar → export tekrarlanır → temizlik.
  const closed = await manager.close({ sessionId });
  assert.equal(restoreCalls.count, 1, "retry diskten kurtarmalı");
  assert.equal(closed.baseStatus, "fresh");
  assert.ok(!("staleFiles" in closed));
  assert.equal(closed.patchPath, patchPath);
  assert.deepEqual(await readFile(patchPath), firstPatch, "export deterministik tekrarlanır");
  assert.deepEqual(closed.filesChanged, task.filesChanged);
  assert.deepEqual(closed.diffStats, task.diffStats);
  assert.equal(closed.summary, task.summary);
  assert.equal(store.deleteCalls, 2);
  assert.equal(backend.touches(), touchesBefore, "close/kurtarma inference yapmaz");
  await assertClosedOnDisk(fixture, sessionId, "S10-I9");
  assert.ok(!manager.activeSessions().some((entry) => entry.sessionId === sessionId));

  await assert.rejects(manager.close({ sessionId }), (err: unknown) => err instanceof SessionError && err.kind === "session_not_found");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I10 — tur-0 (needs_split) close: boş patch (spec 22, 42, 39D)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I10: round-0 close (first round needs_split) — empty diff, 0-byte patch, files_changed [], 0/0/0 stats, persisted safe summary", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i10");
  s.backend.countBehavior = () => 999_999_999;
  s.backend.runBehavior = async () => {
    throw new Error("inference must not run for needs_split");
  };
  const taskRes = await call(s.client, "splash_task", { task: "Too large", files: ["src/a.ts"] });
  const task = expectOk(taskRes, "splash_task");
  assert.equal(task.status, "needs_split");
  assert.equal(s.backend.runCalls.length, 0);
  const sessionId = task.session_id as string;
  assert.ok(await pathExists(sessionPaths(fixture, sessionId).sessionJson), "needs_split oturumu kalıcı");

  const touchesBefore = s.backend.touches();
  assert.equal(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "tur-0 diff"), "", "boş diff geçerli (38D)");
  assert.deepEqual(expectStat(await call(s.client, "splash_diff", { session_id: sessionId, stat: true }), "tur-0 stat"), {
    files: 0,
    insertions: 0,
    deletions: 0,
  });

  const closeRes = await call(s.client, "splash_close", { session_id: sessionId });
  const close = expectClose(closeRes, "fresh");
  assertNoLeak(wireText(closeRes), "tur-0 close");
  assert.deepEqual(close.files_changed, []);
  assert.deepEqual(close.diff_stats, { files: 0, insertions: 0, deletions: 0 });
  assert.equal(close.summary, task.summary, "kalıcı güvenli son compact özet");
  assert.equal(s.backend.touches(), touchesBefore, "tur-0 close inference yapmaz");

  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I10");
  assert.equal((await stat(close.patch_path)).size, 0, "sıfır değişiklik → 0 baytlık patch (hata DEĞİL)");
  await assertClosedOnDisk(fixture, sessionId, "S10-I10");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I11 — splash_diff kapsamı (spec 4-9, 38A-F/H/I)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I11: splash_diff scope — whole -U3, literal per-file filter, glob-like input cannot broaden, unsafe paths fail closed, stat-only numbers, stale main does not block, no inference, no state mutation", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i11");
  s.backend.runBehavior = respondWith(
    workerJson("Updated the value and the long file.", [
      modifyA("const value = 2;"),
      { kind: "modify", path: "src/long.ts", operations: [{ search: "// L10", replace: "// L10 changed" }] },
    ]),
  );
  const task = expectOk(
    await call(s.client, "splash_task", { task: "Two edits", files: ["src/a.ts", "src/b.ts", "src/long.ts"] }),
    "splash_task",
  );
  const sessionId = task.session_id as string;
  const { sessionJson } = sessionPaths(fixture, sessionId);
  const sessionJsonBytes = await readFile(sessionJson);
  const sessionJsonIno = (await stat(sessionJson)).ino;
  const touchesBefore = s.backend.touches();
  const assembleBefore = s.assembler.assembleCalls;
  const captureBefore = s.assembler.captureCalls;
  const diffOf = async (args: Record<string, unknown>, label: string): Promise<string> =>
    expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId, ...args }), label);

  // A — tüm workspace, 3 bağlam satırı.
  const whole = await diffOf({}, "whole");
  assert.ok(whole.startsWith("diff --git a/src/a.ts b/src/a.ts\n"), "ham unified diff metni (JSON/metadata sarmalayıcı YOK)");
  assert.ok(whole.includes("diff --git a/src/long.ts b/src/long.ts"));
  assert.ok(!whole.includes("src/b.ts"), "değişmemiş dosya diff'te olmamalı");
  const wholeChanged = changedLines(whole);
  assert.ok(wholeChanged.includes("-const value = 1;") && wholeChanged.includes("+const value = 2;"));
  const lines = whole.split("\n");
  const hunk = lines.findIndex((line) => /^@@ -7,7 \+7,7 @@/.test(line));
  assert.ok(hunk >= 0, "long.ts hunk'ı -U3 ile @@ -7,7 +7,7 @@ olmalı");
  assert.deepEqual(lines.slice(hunk + 1, hunk + 9), [
    " // L07",
    " // L08",
    " // L09",
    "-// L10",
    "+// L10 changed",
    " // L11",
    " // L12",
    " // L13",
  ]);
  assert.ok(!whole.includes("// L06") && !whole.includes("// L14"), "tam olarak 3 bağlam satırı");

  // `files: []` → filtresiz (Workspace sözleşmesi: boş dizi = filtresiz).
  assert.equal(await diffOf({ files: [] }, "files: []"), whole);
  // `stat: false` → normal diff.
  assert.equal(await diffOf({ stat: false }, "stat:false"), whole);

  // B — per-file filtre (iki değişenden biri).
  const longOnly = await diffOf({ files: ["src/long.ts"] }, "long only");
  assert.ok(longOnly.includes("diff --git a/src/long.ts b/src/long.ts"));
  assert.ok(!longOnly.includes("src/a.ts"), "filtre dışı dosya dönmemeli");
  assert.ok(whole.includes(longOnly), "per-file çıktı tüm diff'in birebir parçası");
  const aOnly = await diffOf({ files: ["src/a.ts"] }, "a only");
  assert.ok(aOnly.includes("diff --git a/src/a.ts b/src/a.ts") && !aOnly.includes("src/long.ts"));
  assert.equal(await diffOf({ files: ["src/long.ts", "src/a.ts"] }, "both"), whole);
  // D — güvenli ama değişmemiş / var olmayan yol → boş diff (hata DEĞİL).
  assert.equal(await diffOf({ files: ["src/b.ts"] }, "unchanged"), "");
  assert.equal(await diffOf({ files: ["src/does-not-exist.ts"] }, "missing"), "");

  // C — glob/pathspec-benzeri girdi GENİŞLEYEMEZ (literal): ya boş diff ya güvenli red.
  for (const pattern of ["src/*.ts", "*", "src/?.ts", "src/[al]*.ts", ":(glob)**", ":(top)src/a.ts"]) {
    const res = await call(s.client, "splash_diff", { session_id: sessionId, files: [pattern] });
    if (res.isError) {
      expectToolError(res, "invalid_input", `glob-benzeri ${pattern}`);
    } else {
      assert.equal(wireText(res), "", `glob-benzeri ${pattern} literal ele alınmalı (genişleme YOK)`);
    }
  }
  // C — güvensiz yollar fs'e inmeden reddedilir; girdi yankılanmaz.
  for (const unsafe of ["../x", ".git/config", "src/.GIT/config", "/etc/passwd", "src/../../x", "a\\b"]) {
    const res = await call(s.client, "splash_diff", { session_id: sessionId, files: [unsafe] });
    expectToolError(res, "invalid_input", `güvensiz yol ${JSON.stringify(unsafe)}`);
    assert.ok(!wireText(res).includes(unsafe), "güvensiz girdi hata metnine yansımamalı");
    const statRes = await call(s.client, "splash_diff", { session_id: sessionId, files: [unsafe], stat: true });
    expectToolError(statRes, "invalid_input", `güvensiz yol (stat) ${JSON.stringify(unsafe)}`);
  }
  // Boş yol: şema (`min(1)` varsa) YA DA manager (`invalid_input`) reddeder — ikisi de güvenli.
  const emptyPath = await callExpectingRejection(s.client, "splash_diff", { session_id: sessionId, files: [""] });
  assert.equal(emptyPath.isError, true, "boş yol reddedilmeli");
  if (wireText(emptyPath).startsWith("{")) {
    expectToolError(emptyPath, "invalid_input", "boş yol");
  }

  // E — stat:true: yalnız sayılar; kaynak/diff işareti YOK.
  const statRes = await call(s.client, "splash_diff", { session_id: sessionId, stat: true });
  assert.deepEqual(expectStat(statRes, "stat"), { files: 2, insertions: 2, deletions: 2 });
  const statText = wireText(statRes);
  for (const needle of ["const value", "// L1", "@@", "diff --git", "+++", "---"]) {
    assert.ok(!statText.includes(needle), `stat yanıtında "${needle}" olmamalı`);
  }
  // F — files + stat:true filtrelenmiş yolları yansıtır.
  assert.deepEqual(expectStat(await call(s.client, "splash_diff", { session_id: sessionId, files: ["src/a.ts"], stat: true }), "stat a"), {
    files: 1,
    insertions: 1,
    deletions: 1,
  });
  assert.deepEqual(
    expectStat(await call(s.client, "splash_diff", { session_id: sessionId, files: ["src/long.ts"], stat: true }), "stat long"),
    { files: 1, insertions: 1, deletions: 1 },
  );
  assert.deepEqual(expectStat(await call(s.client, "splash_diff", { session_id: sessionId, files: ["src/b.ts"], stat: true }), "stat b"), {
    files: 0,
    insertions: 0,
    deletions: 0,
  });

  // H — ana checkout stale iken diff yine workspace katkısını döner (stale guard DEĞİL).
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\n// drifted-in-main\n");
  assert.equal(await diffOf({}, "stale main whole"), whole);
  assert.deepEqual(expectStat(await call(s.client, "splash_diff", { session_id: sessionId, stat: true }), "stale main stat"), {
    files: 2,
    insertions: 2,
    deletions: 2,
  });

  // I — inference / bağlam kurma / stale ölçümü YOK; kalıcı durum yazılmadı.
  assert.equal(s.backend.touches(), touchesBefore, "diff inference yüzeyine dokunmamalı");
  assert.equal(s.assembler.assembleCalls, assembleBefore, "diff bağlam kurmamalı");
  assert.equal(s.assembler.captureCalls, captureBefore, "diff stale ölçümü yapmamalı (inceleme)");
  assert.deepEqual(await readFile(sessionJson), sessionJsonBytes, "diff kalıcı durumu değiştirmemeli");
  assert.equal((await stat(sessionJson)).ino, sessionJsonIno, "diff session.json'ı yeniden yazmamalı");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I12 — close sonrası + çift close (spec 21, 24, 38J, 39I)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I12: after close every tool answers session_not_found (no RAM resurrection); of two concurrent closes exactly one wins", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i12");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");

  const runCallsAfterClose = s.backend.runCalls.length;
  expectSessionNotFound(await call(s.client, "splash_diff", { session_id: sessionId }), "diff");
  expectSessionNotFound(await call(s.client, "splash_diff", { session_id: sessionId, stat: true }), "diff stat");
  expectSessionNotFound(await call(s.client, "splash_refine", { session_id: sessionId, feedback: "again" }), "refine");
  expectSessionNotFound(await call(s.client, "splash_close", { session_id: sessionId }), "ikinci close");
  assert.equal(s.backend.runCalls.length, runCallsAfterClose, "kapalı oturumda refine inference yapmamalı");
  await assertClosedOnDisk(fixture, sessionId, "S10-I12");

  // Eşzamanlı iki close: FIFO — biri kazanır, diğeri session_not_found.
  const second = expectOk(await call(s.client, "splash_task", { task: "Second session", files: ["src/a.ts"] }), "splash_task 2");
  const secondId = second.session_id as string;
  const results = await Promise.all([
    call(s.client, "splash_close", { session_id: secondId }),
    call(s.client, "splash_close", { session_id: secondId }),
  ]);
  const winners = results.filter((res) => !res.isError);
  const losers = results.filter((res) => res.isError === true);
  assert.equal(winners.length, 1, "tam olarak bir close kazanmalı");
  assert.equal(losers.length, 1);
  const winner = winners[0];
  const loser = losers[0];
  assert.ok(winner !== undefined && loser !== undefined);
  const close = expectClose(winner, "fresh");
  expectSessionNotFound(loser, "kaybeden close");
  await assertPatchLocation(fixture, secondId, close.patch_path, "S10-I12");
  await assertClosedOnDisk(fixture, secondId, "S10-I12 ikinci");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I13 — aynı-oturum eşzamanlılık: refine / diff / close FIFO (spec 24, 39J/K)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I13: same-session FIFO — diff/close queued behind an in-flight refine see round 2; refine/diff queued behind an in-flight close wake to session_not_found", async (t) => {
  const fixture = await makeFixture(t);
  const probe = newProbe();
  const s = await makeRuntimeSession(t, fixture, "i13", { probe });
  const ROUND1 = workerJson("Round 1.", [modifyA("const value = 2;")]);
  const ROUND2 = workerJson("Round 2.", [
    modifyA("const value = 3;"),
    { kind: "create", path: "src/extra.ts", content: "export const extra = 3;\n" },
  ]);

  // ── (a)+(b): refine uçuşta → diff + close kuyrukta ───────────────────────
  s.backend.runBehavior = respondWith(ROUND1);
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;

  const refineGate = deferred<void>();
  const refineEntered = deferred<void>();
  s.backend.runBehavior = async () => {
    refineEntered.resolve();
    await refineGate.promise;
    return { content: ROUND2, usage: { inputTokens: 20, outputTokens: 10 } };
  };
  let refineP!: Promise<WireContent>;
  let diffP!: Promise<WireContent>;
  let closeP!: Promise<WireContent>;
  try {
    refineP = call(s.client, "splash_refine", { session_id: sessionId, feedback: "make it three" });
    await refineEntered.promise; // refine kilidin İÇİNDE, model çağrısında bekliyor
    const captureAt = s.assembler.captureCalls;
    const callsAt = probeSnapshot(probe);

    diffP = call(s.client, "splash_diff", { session_id: sessionId });
    const diffState = trackSettled(diffP);
    await settleTurns(); // diff kuyruğa kaydoldu (sıra deterministik)
    closeP = call(s.client, "splash_close", { session_id: sessionId });
    const closeState = trackSettled(closeP);
    await settleTurns();

    assert.equal(diffState.settled, false, "diff, refine bitmeden çözülmemeli");
    assert.equal(closeState.settled, false, "close, refine bitmeden çözülmemeli");
    assert.equal(s.assembler.captureCalls, captureAt, "close, refine sürerken stale ölçümüne başlamamalı");
    assert.deepEqual(probeSnapshot(probe), callsAt, "diff/close yarım turdaki workspace'e dokunmamalı");
  } finally {
    refineGate.resolve();
  }
  const [refineRes, diffRes, closeRes] = await Promise.all([refineP, diffP, closeP]);

  const refined = expectOk(refineRes, "refine");
  assert.equal(refined.round, 2);
  assert.equal(refined.status, "applied");
  assert.deepEqual(refined.files_changed, ["src/a.ts", "src/extra.ts"]);

  const diff = expectDiffText(diffRes, "kuyruktaki diff");
  const diffChanged = changedLines(diff);
  assert.ok(diffChanged.includes("+const value = 3;"), "diff tur 2'yi görmeli");
  assert.ok(!diffChanged.includes("+const value = 2;"), "diff tur 1'i görmemeli");
  assert.ok(diff.includes("diff --git a/src/extra.ts b/src/extra.ts"));

  const close = expectClose(closeRes, "fresh", "kuyruktaki close");
  assert.deepEqual(close.files_changed, refined.files_changed, "close tur 2'nin files_changed'ını yansıtmalı");
  assert.deepEqual(close.diff_stats, refined.diff_stats);
  assert.equal(close.summary, refined.summary);
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(changedLines(patch).includes("+const value = 3;"));
  assert.ok(!changedLines(patch).includes("+const value = 2;"));
  assert.ok(patch.includes("diff --git a/src/extra.ts b/src/extra.ts"));
  assert.equal(s.backend.runCalls.length, 2);
  await assertClosedOnDisk(fixture, sessionId, "S10-I13a");

  // ── (c): close uçuşta (export kapısında) → refine + diff kuyrukta ─────────
  s.backend.runBehavior = respondWith(ROUND1);
  const task2 = expectOk(await call(s.client, "splash_task", { task: "Second", files: ["src/a.ts"] }), "splash_task 2");
  const secondId = task2.session_id as string;
  const exportGate = deferred<void>();
  const exportEntered = deferred<void>();
  probe.exportGate = exportGate.promise;
  probe.onExportEntered = () => exportEntered.resolve();
  const touchesAt = s.backend.touches();
  let close2P!: Promise<WireContent>;
  let refine2P!: Promise<WireContent>;
  let diff2P!: Promise<WireContent>;
  try {
    close2P = call(s.client, "splash_close", { session_id: secondId });
    await exportEntered.promise; // close kilidin İÇİNDE, export aşamasında
    const captureAt = s.assembler.captureCalls;
    const diffCallsAt = probeCount(probe, "diff");

    refine2P = call(s.client, "splash_refine", { session_id: secondId, feedback: "queued behind close" });
    const refineState = trackSettled(refine2P);
    diff2P = call(s.client, "splash_diff", { session_id: secondId });
    const diffState = trackSettled(diff2P);
    await settleTurns();

    assert.equal(refineState.settled, false, "refine, close bitmeden çözülmemeli");
    assert.equal(diffState.settled, false, "diff, close bitmeden çözülmemeli");
    assert.equal(s.backend.touches(), touchesAt, "kuyruktaki refine inference'a başlamamalı");
    assert.equal(s.assembler.captureCalls, captureAt, "kuyruktaki refine stale ölçümüne başlamamalı");
    assert.equal(probeCount(probe, "diff"), diffCallsAt, "kuyruktaki diff workspace'e dokunmamalı");
  } finally {
    probe.exportGate = null;
    probe.onExportEntered = null;
    exportGate.resolve();
  }
  const [close2Res, refine2Res, diff2Res] = await Promise.all([close2P, refine2P, diff2P]);
  expectClose(close2Res, "fresh", "uçuştaki close");
  expectSessionNotFound(refine2Res, "close arkasındaki refine");
  expectSessionNotFound(diff2Res, "close arkasındaki diff");
  assert.equal(s.backend.touches(), touchesAt, "uyanan refine inference yapmamalı");
  await assertClosedOnDisk(fixture, secondId, "S10-I13c");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I14 — içerik sınırı (no-content frontier) (spec 9, 29, 30, 39O)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I14: no-content frontier — generated content appears ONLY in splash_diff (normal mode) and the patch file; never in task/refine/close/stat/error responses", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i14");
  const compactTexts: Array<[string, string]> = [];
  const errorTexts: Array<[string, string]> = [];
  const sdkRejectionTexts: Array<[string, string]> = [];

  s.backend.runBehavior = respondWith(
    workerJson("Added a feature module.", [
      modifyA(`const value = 2; // ${MARKER}_modify`),
      { kind: "create", path: "src/feature.ts", content: `export const feature = "${MARKER}_create";\n` },
    ]),
  );
  const taskRes = await call(s.client, "splash_task", { task: "Add a feature", files: ["src/a.ts"] });
  const task = expectOk(taskRes, "splash_task");
  compactTexts.push(["splash_task", wireText(taskRes)]);
  const sessionId = task.session_id as string;

  s.backend.runBehavior = respondWith(
    workerJson("Refined the feature module.", [
      modifyA(`const value = 3; // ${MARKER}_modify_r2`),
      { kind: "create", path: "src/feature.ts", content: `export const feature = "${MARKER}_r2";\n` },
    ]),
  );
  const refineRes = await call(s.client, "splash_refine", { session_id: sessionId, feedback: "refine it" });
  expectOk(refineRes, "splash_refine");
  compactTexts.push(["splash_refine", wireText(refineRes)]);

  // splash_diff (normal) = kasıtlı içerik istisnası.
  assert.ok(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff").includes(MARKER));
  assert.ok(
    expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId, files: ["src/feature.ts"] }), "diff file").includes(MARKER),
  );
  // stat:true — içerik YOK.
  const statRes = await call(s.client, "splash_diff", { session_id: sessionId, stat: true });
  expectStat(statRes, "stat");
  compactTexts.push(["splash_diff stat", wireText(statRes)]);
  const statFileRes = await call(s.client, "splash_diff", { session_id: sessionId, files: ["src/feature.ts"], stat: true });
  expectStat(statFileRes, "stat file");
  compactTexts.push(["splash_diff stat files", wireText(statFileRes)]);

  // Hata yanıtları (kasıtlı yankı denemeleri dahil).
  const missing = await call(s.client, "splash_refine", { session_id: "00000000-0000-4000-8000-000000000000", feedback: "x" });
  expectSessionNotFound(missing, "bilinmeyen refine");
  errorTexts.push(["refine not found", wireText(missing)]);
  const unsafeFile = await call(s.client, "splash_diff", { session_id: sessionId, files: [`../${MARKER}`] });
  expectToolError(unsafeFile, "invalid_input", "diff güvensiz yol");
  errorTexts.push(["diff unsafe file", wireText(unsafeFile)]);
  const unsafeDiffId = await call(s.client, "splash_diff", { session_id: `../${MARKER}` });
  expectToolError(unsafeDiffId, "invalid_input", "diff güvensiz kimlik");
  errorTexts.push(["diff unsafe id", wireText(unsafeDiffId)]);
  const unsafeCloseId = await call(s.client, "splash_close", { session_id: `../${MARKER}` });
  expectToolError(unsafeCloseId, "invalid_input", "close güvensiz kimlik");
  errorTexts.push(["close unsafe id", wireText(unsafeCloseId)]);
  const badTask = await call(s.client, "splash_task", { task: "Bad path", files: [`../${MARKER}`] });
  assert.equal(badTask.isError, true);
  errorTexts.push(["task unsafe file", wireText(badTask)]);

  const blocker = path.join(fixture.outputRoot, "patches");
  await writeFile(blocker, "not a directory\n");
  const exportFailed = await call(s.client, "splash_close", { session_id: sessionId });
  expectToolError(exportFailed, "export_failed", "export hatası");
  errorTexts.push(["close export_failed", wireText(exportFailed)]);
  await rm(blocker);

  // Stale refine yanıtı (compact) — sonra sürüklenme geri alınır.
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), "const value = 1;\n// drift\n");
  const staleRes = await call(s.client, "splash_refine", { session_id: sessionId, feedback: "again" });
  assert.equal(expectOk(staleRes, "stale refine").status, "stale_base");
  compactTexts.push(["splash_refine stale", wireText(staleRes)]);
  await writeFile(path.join(fixture.repoRoot, "src/a.ts"), BASE_A);

  // SDK şema redleri.
  const schemaClose = await callExpectingRejection(s.client, "splash_close", { session_id: sessionId, apply: true });
  assert.equal(schemaClose.isError, true);
  sdkRejectionTexts.push(["close apply", wireText(schemaClose)]);
  const schemaDiff = await callExpectingRejection(s.client, "splash_diff", { session_id: sessionId, extra: MARKER });
  assert.equal(schemaDiff.isError, true);
  sdkRejectionTexts.push(["diff extra", wireText(schemaDiff)]);

  // Close (fresh — sürüklenme geri alındı).
  const closeRes = await call(s.client, "splash_close", { session_id: sessionId });
  const close = expectClose(closeRes, "fresh");
  compactTexts.push(["splash_close", wireText(closeRes)]);
  const afterClose = await call(s.client, "splash_diff", { session_id: sessionId });
  expectSessionNotFound(afterClose, "close sonrası diff");
  errorTexts.push(["diff after close", wireText(afterClose)]);

  for (const [label, text] of compactTexts) {
    assertNoLeak(text, label);
  }
  for (const [label, text] of errorTexts) {
    assertNoLeak(text, label);
    assert.ok(!text.includes(fixture.root), `${label}: hata yol sızdırmamalı`);
    const json = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ["kind", "message"], `${label}: hata wire anahtarları`);
  }
  for (const [label, text] of sdkRejectionTexts) {
    // `extra: MARKER` değeri bile şema hatasında yankılanmamalı (anahtar adı yankılanabilir).
    assert.ok(!text.includes(MARKER), `${label}: şema hatası değer yankılamamalı`);
  }

  // Disk üzerindeki patch = izinli tek içerik artifact'ı (negatif iddiaların anlamı için).
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(patch.includes(`${MARKER}_r2`), "patch son turu taşır");
  assert.ok(!patch.includes(`${MARKER}_create`), "patch tam ikame: tur 1 içeriği yok");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I15 — şema + araç yüzeyi (spec 1, 10, 27, 28, 41)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I15: tool surface is exactly four tools; splash_close/splash_diff are strict — apply/output_path/force/discard are rejected and the session stays open", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i15");
  const tools = (await s.client.listTools()).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["splash_close", "splash_diff", "splash_refine", "splash_task"],
    "üretim yüzeyi tam olarak dört araç (splash_ping YOK)",
  );
  const closeTool = tools.find((tool) => tool.name === "splash_close");
  const diffTool = tools.find((tool) => tool.name === "splash_diff");
  assert.ok(closeTool !== undefined && diffTool !== undefined);
  assert.deepEqual(Object.keys(closeTool.inputSchema.properties ?? {}).sort(), ["session_id"]);
  assert.deepEqual(Object.keys(diffTool.inputSchema.properties ?? {}).sort(), ["files", "session_id", "stat"]);

  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const paths = sessionPaths(fixture, sessionId);
  const touchesBefore = s.backend.touches();
  const evilPatch = path.join(fixture.root, "evil.patch");

  for (const args of [
    { session_id: sessionId, apply: true },
    { session_id: sessionId, output_path: evilPatch },
    { session_id: sessionId, force: true },
    { session_id: sessionId, discard: true },
    { session_id: sessionId, rebase: true },
    {},
    { session_id: "   " },
    { session_id: 42 },
  ]) {
    const res = await callExpectingRejection(s.client, "splash_close", args);
    assert.equal(res.isError, true, `close şeması reddetmeli: ${JSON.stringify(args)}`);
    assert.ok(!(await pathExists(expectedPatchPath(fixture, sessionId))), "reddedilen close export YAPMAMALI");
    assert.ok(!(await pathExists(evilPatch)), "çağıran kontrollü patch yolu ASLA kullanılmaz");
  }
  for (const args of [
    { session_id: sessionId, stat: "yes" },
    { session_id: sessionId, files: "src/a.ts" },
    { session_id: sessionId, apply: true },
  ]) {
    const res = await callExpectingRejection(s.client, "splash_diff", args);
    assert.equal(res.isError, true, `diff şeması reddetmeli: ${JSON.stringify(args)}`);
  }

  // Oturum AÇIK kalır.
  assert.ok(await pathExists(paths.wsDir));
  assert.ok(await pathExists(paths.sessionJson));
  assert.ok(changedLines(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff")).includes("+const value = 2;"));
  assert.equal(s.backend.touches(), touchesBefore);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I15");
  await assertClosedOnDisk(fixture, sessionId, "S10-I15");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I16 — max_rounds'taki oturum normal kapanır (spec 14)
// ════════════════════════════════════════════════════════════════════════════

test("S10-I16: a session at the max_rounds guardrail closes normally without inference", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i16", { config: { ...fixture.config, maxRounds: 1 } });
  s.backend.runBehavior = respondWith(workerJson("Round 1.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  assert.equal(s.backend.runCalls.length, 1);

  const guard = expectOk(await call(s.client, "splash_refine", { session_id: sessionId, feedback: "more" }), "max_rounds refine");
  assert.equal(guard.status, "max_rounds");
  assert.equal(s.backend.runCalls.length, 1, "guardrail inference yapmaz");

  const touchesBefore = s.backend.touches();
  const assembleBefore = s.assembler.assembleCalls;
  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, task.files_changed);
  assert.deepEqual(close.diff_stats, task.diff_stats);
  assert.equal(close.summary, task.summary, "max_rounds guardrail'i son üretilmiş özeti DEĞİŞTİRMEZ");
  assert.equal(s.backend.touches(), touchesBefore, "close max_rounds tetiklemez / inference yapmaz");
  assert.equal(s.assembler.assembleCalls, assembleBefore);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I16");
  await assertClosedOnDisk(fixture, sessionId, "S10-I16");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I17..I19 — F: stale yakalama ENOTDIR / atal symlink → ÖLÇÜM (hata DEĞİL)
// Önceden bu durumlarda close kalıcı hata veriyordu (assembly_failed /
// unsafe_path) — stale bir taban close'u ASLA engellemez (DESIGN §7.5).
// ════════════════════════════════════════════════════════════════════════════

test("S10-I17: stale capture (F-a) — main's `src` directory becomes a FILE (ENOTDIR) → close succeeds as stale, patch exported, main untouched", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i17");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;

  // Testin kasıtlı düzenlemesi: editable yolun ATASI düz dosyaya dönüşür.
  await rm(path.join(fixture.repoRoot, "src"), { recursive: true, force: true });
  await writeFile(path.join(fixture.repoRoot, "src"), "src is now a plain file\n");
  const mainBefore = await snapshotTree(fixture.repoRoot);
  const metaBefore = await snapshotGitMeta(fixture.repoRoot);
  const touchesBefore = s.backend.touches();

  const closeRes = await call(s.client, "splash_close", { session_id: sessionId });
  const close = expectClose(closeRes, "stale");
  assert.deepEqual(close.stale_files, ["src/a.ts"], "editable yol ENOTDIR ile yok ölçülür → stale");
  assertNoLeak(wireText(closeRes), "F-a close");
  assert.equal(s.backend.touches(), touchesBefore);

  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore, "ana ağaç (src dosyası dahil) birebir");
  assert.deepEqual(await snapshotGitMeta(fixture.repoRoot), metaBefore);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I17");
  const changed = changedLines(await readFile(close.patch_path, "utf8"));
  assert.ok(changed.includes("-const value = 1;") && changed.includes("+const value = 2;"), "patch base → worker");
  await assertClosedOnDisk(fixture, sessionId, "S10-I17");
});

test("S10-I18: stale capture (F-b) — main's `src` becomes a SYMLINK to an external directory → close succeeds as stale; nothing is read through or written to the external directory", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i18");
  s.backend.runBehavior = respondWith(workerJson("Changed the value.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(s.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;

  // Harici dizin: `a.ts` OKUNAMAZ (0000) — link izlenip içerik okunsaydı
  // EACCES → close hata verirdi (okuma YAPILMADIĞININ deterministik kanıtı;
  // root olarak koşulursa bu alt-iddia etkisizleşir ama yanlış-kırmızı üretmez).
  const external = path.join(fixture.root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "a.ts"), "external decoy — must never be read\n");
  await writeFile(path.join(external, "sentinel.txt"), "external sentinel\n");
  await chmod(path.join(external, "a.ts"), 0o000);
  await rm(path.join(fixture.repoRoot, "src"), { recursive: true, force: true });
  await symlink(external, path.join(fixture.repoRoot, "src"));
  const externalBefore = await metaTree(external);
  const mainBefore = await snapshotTree(fixture.repoRoot);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "stale");
  assert.deepEqual(close.stale_files, ["src/a.ts"], "atal symlink = sürüklenme → stale");

  assert.deepEqual(await metaTree(external), externalBefore, "harici dizine hiçbir şey yazılmadı/değiştirilmedi");
  assert.deepEqual(await readdir(external), ["a.ts", "sentinel.txt"]);
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore, "ana ağaç (src symlink'i dahil) birebir");
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I18");
  assert.ok(!isInside(external, close.patch_path), "patch harici dizine düşmez");
  assert.ok(changedLines(await readFile(close.patch_path, "utf8")).includes("+const value = 2;"));
  await assertClosedOnDisk(fixture, sessionId, "S10-I18");
});

test("S10-I19: stale capture (F-c) — create-only task creates src/new/x.ts; main turns `src/new` into a FILE → created-path collision (ENOTDIR) → close stale, patch exported, main untouched", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i19");
  const CREATED = "export const nested = true;\n";
  s.backend.runBehavior = respondWith(
    workerJson("Created a nested module.", [{ kind: "create", path: "src/new/x.ts", content: CREATED }]),
  );
  const task = expectOk(await call(s.client, "splash_task", { task: "Create a nested module", files: [] }), "splash_task");
  assert.equal(task.status, "applied");
  assert.deepEqual(task.files_changed, ["src/new/x.ts"]);
  const sessionId = task.session_id as string;

  await writeFile(path.join(fixture.repoRoot, "src/new"), "src/new is a plain file in main\n");
  const mainBefore = await snapshotTree(fixture.repoRoot);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "stale");
  assert.deepEqual(close.stale_files, ["src/new/x.ts"], "create main'e uygulanamaz → çakışma");
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I19");
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(patch.includes("diff --git a/src/new/x.ts b/src/new/x.ts"));
  assert.match(patch, /^new file mode 100644$/m);
  assert.ok(changedLines(patch).includes("+export const nested = true;"));
  await assertClosedOnDisk(fixture, sessionId, "S10-I19");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I20 — S#1: tur-0 oturumun 1. turunu refine üretir → restart → diff/close
// Önceden: restart sonrası kalıcı `session_corrupt` (1. turda feedback reddi).
// ════════════════════════════════════════════════════════════════════════════

for (const mode of ["inference_busy", "needs_split"] as const) {
  test(`S10-I20${mode === "needs_split" ? "b" : ""}: round-0 (${mode}) session → splash_refine produces round 1 → restart → splash_diff identical and splash_close succeeds (no session_corrupt)`, async (t) => {
    const fixture = await makeFixture(t);
    const a = await makeRuntimeSession(t, fixture, "a");
    if (mode === "inference_busy") {
      a.lock.busy = true;
    } else {
      a.backend.countBehavior = () => 999_999_999;
    }
    a.backend.runBehavior = async () => {
      throw new Error("inference must not run in a round-0 call");
    };
    const task = expectOk(await call(a.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
    assert.equal(task.status, mode);
    assert.equal(a.backend.runCalls.length, 0);
    const sessionId = task.session_id as string;

    a.lock.busy = false;
    a.backend.countBehavior = () => 1_000;
    a.backend.runBehavior = respondWith(workerJson("Round 1 produced by refine.", [modifyA("const value = 2;")]));
    const refined = expectOk(
      await call(a.client, "splash_refine", { session_id: sessionId, feedback: "please implement it now" }),
      "splash_refine",
    );
    assert.equal(refined.status, "applied");
    assert.equal(refined.round, 1, "tur-0 oturumun ilk üretilmiş turu 1. turdur");
    const diffA = expectDiffText(await call(a.client, "splash_diff", { session_id: sessionId }), "A diff");
    assert.ok(changedLines(diffA).includes("+const value = 2;"));
    await shutdown(a);

    const b = await makeRuntimeSession(t, fixture, "b");
    b.backend.runBehavior = async () => {
      throw new Error("inference must not run during recovery/diff/close");
    };
    assert.equal(
      expectDiffText(await call(b.client, "splash_diff", { session_id: sessionId }), "B diff"),
      diffA,
      "restart sonrası diff birebir (session_corrupt YOK)",
    );
    const close = expectClose(await call(b.client, "splash_close", { session_id: sessionId }), "fresh");
    assert.deepEqual(close.files_changed, ["src/a.ts"]);
    assert.equal(close.summary, refined.summary);
    assert.deepEqual(close.diff_stats, refined.diff_stats);
    assert.equal(b.backend.touches(), 0);
    await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I20");
    await assertClosedOnDisk(fixture, sessionId, "S10-I20");
  });
}

// ════════════════════════════════════════════════════════════════════════════
// S10-I21 — S#2: refine'da önceki turun oluşturduğu yol salt-okunur referans +
// geçersiz worker JSON → tur hatası; geri yükleme COMMIT edilmiş durumu kurar.
// Önceden: aday salt-okunur küme yeniden-uygulamada create'i sessizce reddedip
// workspace'i kalıcı durumdan saptırıyordu → close patch'i `src/new.ts`'siz.
// ════════════════════════════════════════════════════════════════════════════

test("S10-I21: failed refine that references the previous round's created file keeps the committed state — close exports src/new.ts and the patch applies to a default-config copy", async (t) => {
  const fixture = await makeFixture(t);
  const s = await makeRuntimeSession(t, fixture, "i21");
  const NEW_CONTENT = "export const created = 'round1';\n";
  s.backend.runBehavior = respondWith(
    workerJson("Created a module.", [{ kind: "create", path: "src/new.ts", content: NEW_CONTENT }]),
  );
  const task = expectOk(await call(s.client, "splash_task", { task: "Create a module", files: [] }), "splash_task");
  assert.equal(task.status, "applied");
  assert.deepEqual(task.files_changed, ["src/new.ts"]);
  const sessionId = task.session_id as string;
  const diffBefore = expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff");

  s.backend.runBehavior = respondWith("this is { not valid worker json");
  const refine = await call(s.client, "splash_refine", {
    session_id: sessionId,
    feedback: "use the new module as a reference",
    files: ["src/new.ts"],
  });
  // Tur hatası ORİJİNAL tip'li hatadır — geri yükleme başarılı (session_recovery_failed DEĞİL).
  expectToolError(refine, "invalid_output", "geçersiz worker JSON");
  assertNoLeak(wireText(refine), "refine hatası");

  // Workspace kalıcı (commit edilmiş) durumda: diff birebir.
  assert.equal(expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "refine hatası sonrası diff"), diffBefore);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, ["src/new.ts"]);
  assert.deepEqual(close.diff_stats, task.diff_stats);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I21");
  const patch = await readFile(close.patch_path, "utf8");
  assert.ok(patch.includes("diff --git a/src/new.ts b/src/new.ts"), "patch src/new.ts'i İÇERMELİ");
  assert.match(patch, /^new file mode 100644$/m);
  assert.ok(changedLines(patch).includes("+export const created = 'round1';"));

  const copy = await copyMainCheckout(fixture, "apply-copy-i21");
  const cleanConfig = await defaultGitConfig(fixture);
  gitApplyInCopy(fixture, copy, close.patch_path, true, cleanConfig);
  gitApplyInCopy(fixture, copy, close.patch_path, false, cleanConfig);
  assert.equal(await readFile(path.join(copy, "src/new.ts"), "utf8"), NEW_CONTENT);
  assert.ok(!(await pathExists(path.join(fixture.repoRoot, "src/new.ts"))), "ana checkout'a uygulanmadı");
  await assertClosedOnDisk(fixture, sessionId, "S10-I21");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I22 — S#4: worktree dizini git DIŞINDA silinir (kayıt kalır) → restart
// Önceden: `worktree add` "missing but already registered" → kurtarma hep hata.
// ════════════════════════════════════════════════════════════════════════════

test("S10-I22: worktree directory deleted outside git (registration left behind) → runtime B recovers: splash_diff identical, splash_close succeeds and unregisters", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = respondWith(workerJson("Round 1.", [modifyA("const value = 2;")]));
  const task = expectOk(await call(a.client, "splash_task", { task: "Change the value", files: ["src/a.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const diffA = expectDiffText(await call(a.client, "splash_diff", { session_id: sessionId }), "A diff");
  await shutdown(a);

  // Git DIŞI silme (rm -rf / Finder / temizlik aracı): `.git/worktrees/<n>` kaydı KALIR.
  const { wsDir } = sessionPaths(fixture, sessionId);
  await rm(wsDir, { recursive: true, force: true });
  assert.ok(!(await pathExists(wsDir)));
  assert.ok(gitOut(fixture.repoRoot, "worktree", "list", "--porcelain").includes(wsDir), "kayıt kalmış olmalı (önkoşul)");

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => {
    throw new Error("inference must not run during recovery/diff/close");
  };
  assert.equal(expectDiffText(await call(b.client, "splash_diff", { session_id: sessionId }), "B diff"), diffA);
  assert.ok(await pathExists(wsDir), "worktree yeniden kurulmuş olmalı");
  const close = expectClose(await call(b.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, ["src/a.ts"]);
  assert.equal(b.backend.touches(), 0);
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I22");
  await assertClosedOnDisk(fixture, sessionId, "S10-I22");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I23 — M1: kullanıcının porcelain diff config'i patch/diff biçimini bozamaz
// ════════════════════════════════════════════════════════════════════════════

test("S10-I23: hostile global git config (diff.noprefix + color.ui=always) with a dirty main — patch and splash_diff carry no ANSI escapes and standard a/ b/ headers; the patch applies to a default-config copy", async (t) => {
  const fixture = await makeFixture(t);
  await applyBaseDelta(fixture);
  await writeFile(fixture.gitConfig, "[diff]\n\tnoprefix = true\n[color]\n\tui = always\n");
  // Önkoşul: düşmanca config gerçekten etkili (çıplak `git diff` renkli + öneksiz).
  const rawUserDiff = gitOut(fixture.repoRoot, "diff", "HEAD");
  assert.ok(rawUserDiff.includes("\u001b["), "önkoşul: color.ui=always ANSI üretmeli");
  assert.ok(!rawUserDiff.includes("a/src/a.ts"), "önkoşul: diff.noprefix a/ önekini kaldırmalı");

  const s = await makeRuntimeSession(t, fixture, "i23");
  const NEW_CONTENT = "export const created = 1;\n";
  s.backend.runBehavior = respondWith(
    workerJson("Implemented under a hostile git config.", [
      modifyA("const value = 2;"),
      { kind: "create", path: "src/new.ts", content: NEW_CONTENT },
      { kind: "delete", path: "src/del.ts" },
    ]),
  );
  const task = expectOk(
    await call(s.client, "splash_task", { task: "Hostile config", files: ["src/a.ts", "src/del.ts", "src/untracked-selected.ts"] }),
    "splash_task",
  );
  assert.equal(task.status, "applied", "base yakalama (kirli main delta'sı) düşmanca config'te çalışmalı");
  const sessionId = task.session_id as string;
  const EXPECTED_A = "const value = 2;\n// user-unstaged-delta\n";
  assert.equal(await readFile(path.join(sessionPaths(fixture, sessionId).wsDir, "src/a.ts"), "utf8"), EXPECTED_A);

  const diff = expectDiffText(await call(s.client, "splash_diff", { session_id: sessionId }), "diff");
  assert.ok(!diff.includes("\u001b"), "splash_diff çıktısında ANSI kaçışı OLMAMALI");
  assert.ok(diff.startsWith("diff --git a/src/a.ts b/src/a.ts\n"));
  const mainBefore = await snapshotTree(fixture.repoRoot);

  const close = expectClose(await call(s.client, "splash_close", { session_id: sessionId }), "fresh");
  const patchBytes = await readFile(close.patch_path);
  assert.equal(patchBytes.indexOf(0x1b), -1, "patch'te ESC (0x1b) OLMAMALI");
  const patch = patchBytes.toString("utf8");
  for (const header of [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "diff --git a/src/new.ts b/src/new.ts",
    "diff --git a/src/del.ts b/src/del.ts",
  ]) {
    assert.ok(patch.includes(header), `patch standart başlık taşımalı: ${header}`);
  }

  // YALNIZ HARNESS: varsayılan config'li tek kullanımlık kopyada uygulama = worker sonucu.
  const copy = await copyMainCheckout(fixture, "apply-copy-i23");
  const cleanConfig = await defaultGitConfig(fixture);
  gitApplyInCopy(fixture, copy, close.patch_path, true, cleanConfig);
  gitApplyInCopy(fixture, copy, close.patch_path, false, cleanConfig);
  const expected = await contentTree(fixture.repoRoot);
  expected.set("src/a.ts", contentEntry(EXPECTED_A));
  expected.set("src/new.ts", contentEntry(NEW_CONTENT));
  expected.delete("src/del.ts");
  assert.deepEqual(await contentTree(copy), expected);
  assert.deepEqual(await snapshotTree(fixture.repoRoot), mainBefore);
  await assertClosedOnDisk(fixture, sessionId, "S10-I23");
});

// ════════════════════════════════════════════════════════════════════════════
// S10-I24 — H: kurtarma hash'i kullanıcının diff config'inden bağımsız
// ════════════════════════════════════════════════════════════════════════════

test("S10-I24: diff.context=7 + diff.algorithm=histogram added between runtimes — recovery still verifies, splash_diff stays -U3, splash_close succeeds with configured export context", async (t) => {
  const fixture = await makeFixture(t);
  const a = await makeRuntimeSession(t, fixture, "a");
  a.backend.runBehavior = respondWith(
    workerJson("Changed line 10.", [{ kind: "modify", path: "src/long.ts", operations: [{ search: "// L10", replace: "// L10 changed" }] }]),
  );
  const task = expectOk(await call(a.client, "splash_task", { task: "Change line 10", files: ["src/long.ts"] }), "splash_task");
  const sessionId = task.session_id as string;
  const diffA = expectDiffText(await call(a.client, "splash_diff", { session_id: sessionId }), "A diff");
  await shutdown(a);

  // Görev ile restart arasında kullanıcı diff biçim config'ini değiştirir.
  await writeFile(fixture.gitConfig, "[diff]\n\tcontext = 7\n\talgorithm = histogram\n");

  const b = await makeRuntimeSession(t, fixture, "b");
  b.backend.runBehavior = async () => {
    throw new Error("inference must not run during recovery/diff/close");
  };
  const diffB = expectDiffText(await call(b.client, "splash_diff", { session_id: sessionId }), "B diff");
  assert.match(diffB, /^@@ -7,7 \+7,7 @@/m, "splash_diff varsayılanı config'ten bağımsız 3 bağlam satırı");
  // Tek satırlık değişiklikte myers/histogram aynı hunk'ı üretir → birebir.
  assert.equal(diffB, diffA);

  const close = expectClose(await call(b.client, "splash_close", { session_id: sessionId }), "fresh");
  assert.deepEqual(close.files_changed, ["src/long.ts"]);
  assert.equal(b.backend.touches(), 0);
  const patch = await readFile(close.patch_path, "utf8");
  // Export "normal configured diff context" kullanır (DESIGN §7.6): diff.context=7.
  assert.match(patch, /^@@ -3,15 \+3,15 @@/m, "export yapılandırılmış bağlamı (7) kullanmalı");
  const copy = await copyMainCheckout(fixture, "apply-copy-i24");
  const cleanConfig = await defaultGitConfig(fixture);
  gitApplyInCopy(fixture, copy, close.patch_path, true, cleanConfig);
  gitApplyInCopy(fixture, copy, close.patch_path, false, cleanConfig);
  assert.equal(await readFile(path.join(copy, "src/long.ts"), "utf8"), BASE_LONG.replace("// L10", "// L10 changed"));
  await assertPatchLocation(fixture, sessionId, close.patch_path, "S10-I24");
  await assertClosedOnDisk(fixture, sessionId, "S10-I24");
});
