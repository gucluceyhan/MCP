/**
 * RuntimeConflictDetector testleri (Step 3).
 *
 * Süreç tabloları SENTETİKTİR: enjekte edilen scanner sabit
 * `ProcessInfo` listeleri döndürür — makinedeki gerçek süreçlere,
 * duvar saatine ya da dış komuta BAĞIMLI DEĞİL. Gerçek `ps` scanner'ı
 * (createPsScanner) ayrı bir bileşen olarak üretime aittir; burada
 * yalnızca sınıflandırma mantığı pin'lenir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeConflictDetector,
  type ProcessInfo,
} from "../dist/backend/RuntimeConflictDetector.js";

function proc(pid: number, ppid: number, command: string): ProcessInfo {
  return { pid, ppid, command };
}

/** Verilen tabloyu döndüren deterministik scanner'lı sınıflandırıcı. */
function detectorFor(table: ProcessInfo[]): RuntimeConflictDetector {
  return new RuntimeConflictDetector(() => Promise.resolve(table));
}

// Yapılandırılmış Splash runtime'ın tipik ağacı: sunucu + yerel
// (serve-native) child'ı.
const CONFIGURED: ProcessInfo[] = [
  proc(500, 1, "splash serve --port 8000 --host 127.0.0.1"),
  proc(501, 500, "python3 -m splash serve-native --model incoai/Qwen3.8-27B-Splash"),
];

// ── yapılandırılmış runtime ağacı dışlanır ──────────────────────────────

test("the configured Splash server + its native child (descendants) are excluded → none", async () => {
  const kind = await detectorFor(CONFIGURED).detect(500);
  assert.equal(kind, "none");
});

test("a transitive descendant (grandchild) of the configured tree is also excluded → none", async () => {
  const kind = await detectorFor([
    proc(500, 1, "splash serve --port 8000"),
    proc(501, 500, "splash serve-native"),
    proc(502, 501, "python3 -m splash serve-native --worker 1"),
  ]).detect(500);
  assert.equal(kind, "none");
});

test("a configured pid that is absent from the table: nothing is excluded (a real second Splash still conflicts)", async () => {
  const kind = await detectorFor([
    proc(900, 1, "splash serve --port 9000"),
  ]).detect(500);
  assert.equal(kind, "splash");
});

// ── splash ───────────────────────────────────────────────────────────────

test("a second real Splash runtime tree → splash", async () => {
  const kind = await detectorFor([
    ...CONFIGURED,
    proc(900, 1, "splash serve --port 9000"),
    proc(901, 900, "splash serve-native"),
  ]).detect(500);
  assert.equal(kind, "splash");
});

test("python launcher forms of the Splash runtime are recognized", async () => {
  for (const command of [
    "python3 /opt/splash/bin/splash serve --port 8000",
    "python3 -m splash serve --port 8000",
    "python -m splash serve-native --model m",
    "uvx splash serve --port 8000",
    "uv run splash serve --port 8000",
  ]) {
    const kind = await detectorFor([proc(900, 1, command)]).detect(500);
    assert.equal(kind, "splash", `expected splash for: ${command}`);
  }
});

test("a bare `splash` file opened by a non-interpreter (editor, grep) is NOT a conflict", async () => {
  for (const command of [
    "code /home/u/splash", // editör, `splash` adında dosya AÇIYOR
    "vim /home/u/splash",
    "grep -r splash /home/u/docs/splash",
    "cat /home/u/splash",
    // MCP sunucusunun kendi süreci (yol "Splash" içeriyor)
    "node /Users/u/Splash MCP/dist/index.js",
  ]) {
    const kind = await detectorFor([proc(950, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

test("a plain python script named `splash` WITHOUT a serve form is NOT a runtime", async () => {
  const kind = await detectorFor([proc(950, 1, "python3 /home/u/splash --flag")]).detect(500);
  assert.equal(kind, "none");
});

test("a similarly-named python module (`splash_serve`) is NOT the Splash runtime", async () => {
  const kind = await detectorFor([proc(950, 1, "python3 -m splash_serve --port 8000")]).detect(500);
  assert.equal(kind, "none");
});

// ── gerçek resmi dağıtım biçimi (geliştirme makinesinde ÖLÇÜLDÜ) ─────────

test("the REAL official Splash deployment shape: detected when unconfigured, self-excluded when configured", async () => {
  // Makinede ölçülen ağacın birebir yapısı (yollar kısaltıldı,
  // token yapısı aynı): python sunucu KÖKÜ + `serve-native` yerel
  // child'ı. Kök satırın kendisinde `serve` token'ı YOK — tanıma
  // child'ın `serve-native` formu üzerinden olmalı.
  const table = [
    proc(
      1000,
      1,
      "python3 -u /opt/homebrew/Cellar/splash/1.0/libexec/server/server.py /some/model/target /some/model/draft --tokenizer /some/model/tokenizer --model incoai/Qwen3.8-27B-Splash --binary /opt/homebrew/Cellar/splash/1.0/libexec/engine/splash --max-memory auto --max-context auto",
    ),
    proc(
      1001,
      1000,
      "/opt/homebrew/Cellar/splash/1.0/libexec/engine/splash serve-native /some/model/target /some/model/draft auto auto",
    ),
  ];

  // Kök PID yapılandırılmışsa: kök + child (torun kapalılığı)
  // sınıflandırmadan çıkarılır → none.
  const configured = await detectorFor(table).detect(1000);
  assert.equal(configured, "none");

  // Hiçbir şey yapılandırılmamışsa: ağaç bir Splash runtime olarak
  // TESPİT EDİLİR → splash (resmi dağıtım biçimi kaçmaz).
  const unconfigured = await detectorFor(table).detect(null);
  assert.equal(unconfigured, "splash");
});

// ── mlx ──────────────────────────────────────────────────────────────────

test("an MLX-LM runtime (python -m form) → mlx", async () => {
  const kind = await detectorFor([
    proc(500, 1, "splash serve --port 8000"),
    proc(700, 1, "python3 -m mlx_lm.server --port 8080"),
  ]).detect(500);
  assert.equal(kind, "mlx");
});

test("an MLX-VLM runtime (python -m form) → mlx", async () => {
  const kind = await detectorFor([
    proc(500, 1, "splash serve --port 8000"),
    proc(701, 1, "python -m mlx_vlm.generate --prompt hi"),
  ]).detect(500);
  assert.equal(kind, "mlx");
});

test("MLX executable forms (venv entry points) → mlx", async () => {
  for (const command of [
    "mlx_lm.server --port 8080",
    "/opt/venv/bin/mlx_lm.server --port 8080",
    "mlx_vlm.generate --prompt hi",
  ]) {
    const kind = await detectorFor([proc(702, 1, command)]).detect(500);
    assert.equal(kind, "mlx", `expected mlx for: ${command}`);
  }
});

test("a path/argument merely CONTAINING `mlx` (notes file, project dir) is NOT a conflict", async () => {
  for (const command of [
    "code /project/mlx-notes.txt",
    "python3 /project/mlx_lm_training/train.py --epochs 1",
    "vim mlx-lab/README.md",
  ]) {
    const kind = await detectorFor([proc(703, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

// ── ollama ───────────────────────────────────────────────────────────────

test("an Ollama serving/runner process → ollama", async () => {
  const kind = await detectorFor([
    proc(500, 1, "splash serve --port 8000"),
    proc(800, 1, "ollama serve"),
    proc(801, 800, "ollama runner --port 11435"),
  ]).detect(500);
  assert.equal(kind, "ollama");
});

test("`ollama` as a NON-executable argument (echo, script path) is NOT a conflict", async () => {
  for (const command of [
    "echo ollama",
    "bash /home/u/ollama-notes.sh",
    "grep ollama /home/u/dotfiles",
    // Tasarımın SPEC'TE LİTE listelenen hali: editör bir `ollama`
    // notu DOSYASI AÇIYOR — yürütülebilir `code`, argüman metni.
    "code /project/ollama-notes.txt",
  ]) {
    const kind = await detectorFor([proc(802, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

// ── sıradan süreçler + öncelik ───────────────────────────────────────────

test("ordinary host processes do not conflict", async () => {
  const kind = await detectorFor([
    ...CONFIGURED,
    proc(600, 1, "git status"),
    proc(601, 1, "python3 my_script.py"),
    proc(602, 1, "node dist/index.js"),
    proc(603, 1, "zsh"),
  ]).detect(500);
  assert.equal(kind, "none");
});

test("priority is fixed and deterministic: splash > mlx > ollama", async () => {
  const both = await detectorFor([
    proc(700, 1, "python3 -m mlx_lm.server"),
    proc(800, 1, "ollama serve"),
  ]).detect(500);
  assert.equal(both, "mlx");

  const splashPlus = await detectorFor([
    proc(900, 1, "splash serve --port 9000"),
    proc(800, 1, "ollama serve"),
  ]).detect(500);
  assert.equal(splashPlus, "splash");
});

// ── scanner hatası yayılır ──────────────────────────────────────────────

test("a failing scanner (rejected promise) propagates — the caller fails closed", async () => {
  const detector = new RuntimeConflictDetector(
    () => Promise.reject(new Error("ps exited with an error")),
  );
  await assert.rejects(detector.detect(500));
});

test("a failing scanner (synchronous throw) also propagates", async () => {
  const detector = new RuntimeConflictDetector(() => {
    throw new Error("ps unavailable");
  });
  await assert.rejects(detector.detect(500));
});
