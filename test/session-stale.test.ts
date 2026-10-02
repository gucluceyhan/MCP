/**
 * Step 9: `decideStale` saf karşılaştırıcısı — parmak izi boyutları matrixi
 * (spec 339: "Test every fingerprint dimension"; spec 30-37, 171-173).
 *
 * Bu dosya SAF (I/O YOK, git YOK, saat YOK): girdiler (persisted immutable
 * taban parmak izleri + `captureLiveBase` canlı ölçümü) elle kurulur; yalnız
 * karar mantığı test edilir. Canlı okuma strict no-follow davranışı
 * `context-assembler` testlerinde, kurtarma/yaşam döngüsü `session-manager`
 * testlerinde örtülüdür.
 *
 * Parmak izi boyutları (spec 31): VARLIK / TİP / MOD / İÇERİK — her birinin
 * tek başına stale üretmesi + fresh kalan kombinasyonlar. Worker-oluşturulan
 * yollar için yalnız VARLIK boyutu (spec 171: içerik asla okunmaz).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { decideStale, type StaleDecisionInput } from "../dist/session/stale.js";
import type { PathFingerprint } from "../dist/workspace/Workspace.js";
import type { LiveBaseState } from "../dist/context/types.js";

const REPO_ROOT = "/home/user/project";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Düzenli dosya parmak izi (git modu + içerik özeti). */
function fileFingerprint(mode: "100644" | "100755", content: string): PathFingerprint {
  return { exists: true, type: "file", mode, contentSha256: sha256(content) };
}

/** Sembolik bağlantı parmak izi (hedef metin özeti — dereferans YOK). */
function symlinkFingerprint(target: string): PathFingerprint {
  return { exists: true, type: "symlink", mode: "120000", contentSha256: sha256(target) };
}

/** Dizin parmak izi (içerik temsil edilemez — yalnız tip+mod). */
const DIRECTORY: PathFingerprint = { exists: true, type: "directory", mode: "040000" };
const ABSENT: PathFingerprint = { exists: false };

const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";
const CREATED = "src/generated.ts";

interface DecisionFixture {
  editablePaths?: readonly string[];
  baseFingerprints?: Map<string, PathFingerprint>;
  createdPaths?: readonly string[];
  /** Canlı base haritası (absolute anahtarlar — `captureLiveBase` sözleşmesi). */
  liveBase?: Map<string, PathFingerprint>;
  /** Canlı created-varlık haritası (absolute anahtarlar). */
  liveCreated?: Map<string, boolean>;
}

/** `StaleDecisionInput` kurar; eksik haritalar BOŞ (yokluk ≠ hata). */
function decide(fixture: DecisionFixture = {}): string[] {
  const input: StaleDecisionInput = {
    repoRoot: REPO_ROOT,
    editablePaths: fixture.editablePaths ?? [A, B],
    baseFingerprints: fixture.baseFingerprints ?? new Map(),
    createdPaths: fixture.createdPaths ?? [CREATED],
    live: {
      baseFingerprints: fixture.liveBase ?? new Map(),
      createdExists: fixture.liveCreated ?? new Map(),
    } satisfies LiveBaseState,
  };
  return decideStale(input);
}

/** Absolute form (saf karşılaştırıcının anahtar beklentisi). */
function abs(p: string): string {
  return `${REPO_ROOT}/${p}`;
}

// ── Fresh (taze taban) ───────────────────────────────────────────────────────

test("fresh: birebir eş parmak izleri + worker-oluşturulan yol main'de YOK → boş stale listesi", () => {
  const liveA = fileFingerprint("100644", "const value = 1;");
  const liveB = fileFingerprint("100644", "const other = 10;");
  const stale = decide({
    baseFingerprints: new Map([
      [A, fileFingerprint("100644", "const value = 1;")],
      [B, fileFingerprint("100644", "const other = 10;")],
    ]),
    liveBase: new Map([
      [abs(A), liveA],
      [abs(B), liveB],
    ]),
    liveCreated: new Map([[abs(CREATED), false]]),
  });
  assert.deepEqual(stale, []);
});

// ── İÇERİK boyutu ────────────────────────────────────────────────────────────

test("içerik değişimi (aynı mod/tip) → stale; diğer düzenlenebilir yol fresh kalır", () => {
  const stale = decide({
    baseFingerprints: new Map([
      [A, fileFingerprint("100644", "const value = 1;")],
      [B, fileFingerprint("100644", "const other = 10;")],
    ]),
    liveBase: new Map([
      [abs(A), fileFingerprint("100644", "const value = 999;")], // yalnız içerik değişti
      [abs(B), fileFingerprint("100644", "const other = 10;")],
    ]),
    liveCreated: new Map([[abs(CREATED), false]]),
  });
  assert.deepEqual(stale, [A]);
});

// ── MOD boyutu ───────────────────────────────────────────────────────────────

test("mod sürüklenmesi 100644 → 100755 (aynı içerik) → stale (spec 32)", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), fileFingerprint("100755", "const value = 1;")]]),
    createdPaths: [],
  });
  assert.deepEqual(stale, [A]);
});

// ── TİP boyutu ───────────────────────────────────────────────────────────────

test("dosya → sembolik bağlantı takası (aynı içerik özeti) → stale", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), symlinkFingerprint("somewhere-else.ts")]]),
    createdPaths: [],
  });
  assert.deepEqual(stale, [A]);
});

test("dosya → dizin takası → stale", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), DIRECTORY]]),
    createdPaths: [],
  });
  assert.deepEqual(stale, [A]);
});

// ── VARLIK boyutu ────────────────────────────────────────────────────────────

test("var olan taban dosyası silindi (exists:false) → stale", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), ABSENT]]),
    createdPaths: [],
  });
  assert.deepEqual(stale, [A]);
});

test("tabanda YOK olan yola ana ağaçta dosya geldi → stale (tip/varlık uyuşmazlığı)", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, ABSENT]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), fileFingerprint("100644", "someone-added-this")]]),
    createdPaths: [],
  });
  assert.deepEqual(stale, [A]);
});

// ── Worker-oluşturulan yollar (yalnız VARLIK — spec 33/171) ─────────────────

test("worker-oluşturulan yol main'de VAR (içerik ne olursa) → stale", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), fileFingerprint("100644", "const value = 1;")]]), // base taze
    liveCreated: new Map([[abs(CREATED), true]]),
  });
  assert.deepEqual(stale, [CREATED]);
});

test("worker-oluşturulan yol main'de YOK → fresh", () => {
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), fileFingerprint("100644", "const value = 1;")]]),
    liveCreated: new Map([[abs(CREATED), false]]),
  });
  assert.deepEqual(stale, []);
});

test("defans: createdExists haritasında giriş yok (undefined) → stale sayılmaz", () => {
  // `captureLiveBase` her yol için bir Boolean koyar; haritadan eksik
  // (undefined) yalnızca çağrı tarafı hatasıdır — güvenli tarafta: stale
  // sayılmaz (içerik okunmadığı için "yok" kanıtı yok).
  const stale = decide({
    baseFingerprints: new Map([[A, fileFingerprint("100644", "const value = 1;")]]),
    editablePaths: [A],
    liveBase: new Map([[abs(A), fileFingerprint("100644", "const value = 1;")]]),
    liveCreated: new Map(), // CREATED girişi bilinçli olarak YOK
  });
  assert.deepEqual(stale, []);
});

// ── Dedup + sıralama (spec 37: kanonik, dedup'lu, leksikografik) ────────────

test("dedup: aynı yol hem düzenlenebilir-taban hem created üzerinden stale → TEK kez listelenir", () => {
  // Tabanda YOK (absent) seçilen yol: worker create etti; ana ağaçta da var.
  // → hem fingerprint uyuşmazlığı (absent→var) hem created-varlık stale üretir.
  const stale = decide({
    editablePaths: [CREATED],
    baseFingerprints: new Map([[CREATED, ABSENT]]),
    liveBase: new Map([[abs(CREATED), fileFingerprint("100644", "content-any")]]),
    liveCreated: new Map([[abs(CREATED), true]]),
  });
  assert.deepEqual(stale, [CREATED]);
});

test("çoklu stale: girdi sırası ne olursa olsun çıktı leksikografik + dedup'lu", () => {
  const stale = decide({
    editablePaths: [C, A, B, C], // kasıtlı: sırasız + mükerrer
    baseFingerprints: new Map([
      [A, fileFingerprint("100644", "a-base")],
      [B, fileFingerprint("100644", "b-base")],
      [C, fileFingerprint("100644", "c-base")],
    ]),
    liveBase: new Map([
      [abs(A), fileFingerprint("100644", "a-live")],
      [abs(B), fileFingerprint("100644", "b-live")],
      [abs(C), fileFingerprint("100644", "c-live")],
    ]),
    liveCreated: new Map([[abs(CREATED), false]]),
  });
  assert.deepEqual(stale, [A, B, C]); // sıralı, mükerrer C tek
});

// ── Saf fonksiyon disiplinleri ────────────────────────────────────────────────

test("determinizm: aynı girdi → birebir aynı çıktı; girdi nesneleri mutasyona uğramaz", () => {
  const baseFingerprints = new Map([
    [A, fileFingerprint("100644", "const value = 1;")],
    [B, fileFingerprint("100644", "const other = 10;")],
  ]);
  const liveBase = new Map([
    [abs(A), fileFingerprint("100644", "DRIFTED")],
    [abs(B), fileFingerprint("100644", "const other = 10;")],
  ]);
  const liveCreated = new Map([[abs(CREATED), true]]);
  const input: StaleDecisionInput = {
    repoRoot: REPO_ROOT,
    editablePaths: [B, A], // sırasız girdi
    baseFingerprints,
    createdPaths: [CREATED],
    live: { baseFingerprints: liveBase, createdExists: liveCreated },
  };

  const first = decideStale(input);
  const second = decideStale(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [A, CREATED]); // leksikografik

  // Girdiye dokunulmadı (saf fonksiyon — caller'ın haritaları aynen):
  assert.deepEqual([...input.editablePaths], [B, A]);
  const a = input.baseFingerprints.get(A);
  assert.ok(a !== undefined && a.exists, "A taban girişi aynen kalmalı");
  assert.equal(input.live.createdExists.get(abs(CREATED)), true);
});