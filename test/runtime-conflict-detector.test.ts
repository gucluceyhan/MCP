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
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPsScanner,
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

// ── versioned Python yorumlayıcıları (paylaşılan kapı) ───────────────────

test("MLX via versioned Python interpreters (python3.13 / venv paths) → mlx", async () => {
  for (const command of [
    "python3.13 -m mlx_lm.server --port 8080",
    "python3.12 -m mlx_vlm.generate --prompt hello",
    "/opt/homebrew/bin/python3.13 -m mlx_lm.generate --model foo",
    "/venv/bin/python3.12 -m mlx_vlm.generate",
  ]) {
    const kind = await detectorFor([proc(704, 1, command)]).detect(500);
    assert.equal(kind, "mlx", `expected mlx for: ${command}`);
  }
});

test("interpreter-LIKE names that are not interpreters are NOT mlx (no false positive)", async () => {
  for (const command of [
    "python3.13 /project/mlx_notes.py", // script yolu — modül formu değil
    "python3-helper -m mlx_lm.server", // `python3-helper` yorumlayıcı değil
    "python3.13-debug-wrapper -m mlx_lm.server",
    "python3-notes",
    "mypython3",
  ]) {
    const kind = await detectorFor([proc(705, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

test("the shared interpreter gate also feeds the Splash side: versioned interpreter + `splash` → splash", async () => {
  const kind = await detectorFor([
    proc(900, 1, "python3.13 -m splash serve --port 8000"),
  ]).detect(500);
  assert.equal(kind, "splash");
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
    "echo ollama serve", // `serve` token'ı var ama yürütülebilir `echo`
    "bash /home/u/ollama-notes.sh",
    "grep ollama /home/u/dotfiles",
    // Tasarımın SPEC'TE LİTE listelenen hali: editör bir `ollama`
    // notu DOSYASI AÇIYOR — yürütülebilir `code`, argüman metni.
    "code /project/ollama-notes.txt",
    "bash /tmp/ollama serve", // kabuk bir betik AÇIYOR — yürütülebilir `bash`
    "code /project/ollama/serve-notes.txt",
  ]) {
    const kind = await detectorFor([proc(802, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

test("Ollama serve/runner processes (including full paths) → ollama", async () => {
  for (const command of [
    "ollama serve",
    "/usr/local/bin/ollama serve",
    "/opt/homebrew/bin/ollama serve",
    "ollama runner --port 11435",
    "/Applications/Ollama.app/Contents/Resources/rosetta/bin/ollama runner --port 11435",
  ]) {
    const kind = await detectorFor([proc(800, 1, command)]).detect(500);
    assert.equal(kind, "ollama", `expected ollama for: ${command}`);
  }
});

test("Ollama administrative CLI commands (list/ps/show/pull/rm/--help) are NOT conflicts", async () => {
  for (const command of [
    "ollama", // argümansız (tek token) — `tokens.length < 2` kenar durumu
    "ollama list",
    "ollama ps",
    "ollama show llama3",
    "ollama pull llama3",
    "ollama rm llama3",
    "ollama --help",
  ]) {
    const kind = await detectorFor([proc(803, 1, command)]).detect(500);
    assert.equal(kind, "none", `must not conflict: ${command}`);
  }
});

test("an `ollama list` CLI next to a real `ollama serve` daemon → still ollama (the daemon is detected; the CLI does not change the class)", async () => {
  const kind = await detectorFor([
    proc(804, 1, "ollama list"),
    proc(805, 1, "ollama serve"),
  ]).detect(500);
  assert.equal(kind, "ollama");
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

// ── İz 2 inceleme düzeltmeleri (M2 / M3) ─────────────────────────────────

test("M2: macOS framework Python (Python.app/Contents/MacOS/Python) running mlx_lm.server → mlx (measured ps shape)", async () => {
  // Ölçüldü (Homebrew python@3.13, venv ve doğrudan çağrı): ps komut satırı
  // venv yolunu DEĞİL framework yürütülebilirini gösterir.
  const kind = await detectorFor([
    proc(
      31726,
      1,
      "/opt/homebrew/Cellar/python@3.13/3.13.3/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python -m mlx_lm.server",
    ),
  ]).detect(null);
  assert.equal(kind, "mlx");
  const official = await detectorFor([
    proc(42, 1, "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m mlx_vlm.server --port 8081"),
  ]).detect(null);
  assert.equal(official, "mlx");
});

test("M2: an interpreter path containing spaces (executable known from ps comm) running mlx_lm.server → mlx", async () => {
  const exe = "/Users/u/Documents/Yazılımlarım ve Kodlar/.venv/bin/python3";
  const kind = await detectorFor([
    { pid: 31936, ppid: 1, command: `${exe} -m mlx_lm.server --port 8080`, executable: exe },
  ]).detect(null);
  assert.equal(kind, "mlx");
  // Aynı boşluklu yol ile Splash runtime biçimi de tanınır.
  const splash = await detectorFor([
    { pid: 31937, ppid: 1, command: `${exe} /opt/splash/bin/splash serve`, executable: exe },
  ]).detect(null);
  assert.equal(splash, "splash");
});

test("M2: a spaced-path executable that is NOT an interpreter stays a non-conflict (no false positive)", async () => {
  const exe = "/Applications/My Editor.app/Contents/MacOS/my editor";
  const kind = await detectorFor([
    { pid: 50, ppid: 1, command: `${exe} -m mlx_lm.server notes.txt`, executable: exe },
    // `executable` komut satırının ÖNEKİ değilse (yarış/uyumsuzluk) ilk token kuralı aynen.
    { pid: 51, ppid: 1, command: "vim mlx_lm.server", executable: "/usr/bin/python3" },
  ]).detect(null);
  assert.equal(kind, "none");
});

test("M3: the configured runtime's ANCESTORS (uv/uvx launcher) are excluded → none", async () => {
  const kind = await detectorFor([
    proc(1, 0, "/sbin/launchd"),
    proc(400, 1, "uvx splash serve"),
    proc(500, 400, "python3 /Users/u/.cache/uv/splash serve"),
  ]).detect(500);
  assert.equal(kind, "none");
});

test("M3: sibling subtrees of an ancestor are NOT excluded (a second runtime under the same launcher still conflicts)", async () => {
  const kind = await detectorFor([
    proc(1, 0, "/sbin/launchd"),
    proc(400, 1, "uvx splash serve"),
    proc(500, 400, "python3 /Users/u/.cache/uv/splash serve"),
    proc(600, 400, "python3 /Users/u/other/splash serve --port 9000"),
  ]).detect(500);
  assert.equal(kind, "splash");
  // Bir ata zinciri döngüsü (bozuk tablo) sonsuz döngüye girmez.
  const cyclic = await detectorFor([
    proc(700, 701, "uvx splash serve"),
    proc(701, 700, "python3 /x/splash serve"),
  ]).detect(701);
  assert.equal(cyclic, "none");
});

test("M2: the REAL ps scanner reports the spaced interpreter path so the classifier sees mlx (darwin)", { skip: process.platform !== "darwin" }, async (t) => {
  // Gerçek süreç: boşluklu dizinde `python3` adlı bir symlink (node'a) —
  // argv: `-e <bekle> -- -m mlx_lm.server`. Komut satırı ilk-token
  // kuralıyla yorumlayıcıyı GÖREMEZ; `ps -o comm=` (argv[0]) sınırı verir.
  const root = await mkdtemp(path.join(tmpdir(), "splash-ps-"));
  const dir = path.join(root, "My Projects", "Yazilimlarim ve Kodlar", "bin");
  await mkdir(dir, { recursive: true });
  const exe = path.join(dir, "python3");
  await symlink(process.execPath, exe);
  const child = spawn(exe, ["-e", "setTimeout(() => {}, 15000)", "--", "-m", "mlx_lm.server"], { stdio: "ignore" });
  t.after(async () => {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const scan = createPsScanner();
  let entry: ProcessInfo | undefined;
  for (let i = 0; i < 50 && entry?.command.includes("mlx_lm.server") !== true; i++) {
    entry = (await scan()).find((p) => p.pid === pid);
    if (entry?.command.includes("mlx_lm.server") !== true) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(entry !== undefined && entry.command.includes("mlx_lm.server"), "the child must appear in the process table");
  const only = await new RuntimeConflictDetector(async () => [entry as ProcessInfo]).detect(null);
  assert.equal(only, "mlx");
});
