/**
 * Step 5: güvenli git yürütme katmanı (Step 5 spec 5, 6, 7).
 *
 * SHEL YOK (spec 5): tüm git komutları `spawn` ile, argv dizisi olarak
 * çalıştırılır — `exec("git ...")`, `sh -c`, pipeline, redireksiyon ASLA
 * kullanılmaz. Değişken yol argümanları ayrı argv girdisidir; pathspec
 * komutları `--` sonrası gelir.
 *
 * Ortam güvenliği (spec 6): her çağrıya deterministik, etkileşimsiz ortam
 * verilir (`GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`) — git asla prompt açmaz.
 * Miras alınan repo-yerel değişkenler (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, … — `--local-env-vars`) süzülür; tembel promisor çekme
 * kapalıdır (`GIT_NO_LAZY_FETCH=1`; bunu denetlemeyen git sürümünde —
 * `partialCloneUnsupported` tablosu — promisor'lı repo oluşturma/kurtarmada
 * `assertPartialCloneSupported` ile reddedilir).
 * Hook çalıştırabilecek her komuta `-c core.hooksPath=<devnull>` verilir;
 * repo-tanımı hook'lar ve kullanıcı shell komutları asla çalıştırılmaz.
 * `core.fsmonitor` da her çağrıya merkezi olarak devre dışı verilir
 * (audit HIGH-1: saldırgan repo config'inden keyfi program yürütmesi
 * olamaz — hook'larla aynı tehdit sınıfı).
 * `--no-ext-diff`/`--no-textconv` diff içerik güvenliği için çağrı yerinde
 * verilir (proje git config'i ASLA değiştirilmez — spec 25/67).
 *
 * Hata disiplini: hata durumunda `WorkspaceError("git_operation_failed")`
 * fırlatılır; `message` SABİТtir, ham stderr yalnız `cause`'ta (iç kanal)
 * durur — asla MCP yüzeyine taşınmaz (DESIGN.md bölüm 9).
 */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceError } from "./Workspace.js";

/**
 * Git'in hook'larını devre dışı bırakan yerel (komut-bazlı) config.
 * `-c` argümanı komutla birlikte argv'de gider — repo config'i DEĞİŞMEZ.
 * `os.devNull`: POSIX `/dev/null`, Windows `NUL` — her iki platformda
 * hook çalışacak hiçbir şey yok.
 */
export const HOOKS_DISABLED_CONFIG = `core.hooksPath=${os.devNull}`;

/**
 * Git'in fsmonitor'unu devre dışı bırakan yerel (komut-bazlı) config.
 * Boş değer = "tanımsız" → git fsmonitor'unu ASLA çalıştırmaz
 * (ölçüldü: Apple Git 2.50 — marker betiği tetiklenmiyor).
 *
 * Tehdit (audit HIGH-1): saldırgan kontrollü bir repo `.git/config`'inde
 * `core.fsmonitor=<script>` tanımlıysa, her git çağrısı — oluşturmanın
 * İLK komutu (`git diff HEAD`) dahil — index tazelik kontrolünde bu dış
 * programı çalıştırırdı (keyfi program yürütme). Repo-tanımı hook'larla
 * AYNI tehdit sınıfıdır; `runGit` her çağrıya bu sabiti merkezi olarak
 * ekler (aşağıda). `-c` komut-bazıdır; repo config'i DEĞİŞMEZ.
 */
export const FSMONITOR_DISABLED_CONFIG = "core.fsmonitor=";

/**
 * Git pathspec argv'si: `:(literal)` öneği git'in pathspec magic'ini
 * (glob `*?[`, `:(exclude)`/`:(top)`/`:(attr:…)` vb.) neutralize eder —
 * worker/orkestratör kontrollü yol dizgeleri git DİREKTİFİ olarak
 * yorumlanamaz (audit CRITICAL-1; DESIGN 7.4 m.3).
 */
export function literalPathspec(p: string): string {
  return `:(literal)${p}`;
}

/**
 * Miras alınan ortamdan süzülen repo-yerel değişkenler — `git rev-parse
 * --local-env-vars` listesi (ölçüldü, Apple Git 2.50.1). `GIT_CONFIG_GLOBAL`
 * / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_NOSYSTEM` listede DEĞİL ve korunur
 * (kullanıcı/sistem-düzeyi config). Komut kapsamı config
 * (`GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT` — `safe.directory` dahil)
 * ortamdan VERİLEMEZ: `core.worktree` gibi bir ayar çalışma ağacını
 * yönlendirebilir; global/sistem config kullanılmalı.
 */
const REPO_LOCAL_ENV_VARS: ReadonlySet<string> = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/** `GIT_CONFIG_COUNT`'un eşlikçileri (`GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`). */
const GIT_CONFIG_PAIR_ENV = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** `buildGitEnv`'in EN SON yazdığı güvenlik sabitleri (`extra` gölgeleyemez). */
const GIT_SAFETY_ENV: Readonly<Record<string, string>> = {
  // Etkileşimsiz + deterministik (spec 6): asla prompt, asla yerel format.
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  // Partial clone'da eksik nesne promisor remote'tan TEMBEL çekilmez
  // (inceleme W-M2): okuma komutu ağa/transport'a (repo config'indeki
  // `remote.*.uploadpack`/`core.sshCommand` vb.) çıkamaz; repo config'i
  // bunu ezemez. YALNIZ bunu tembel çekme geçidinde denetleyen git
  // sürümünde etkilidir (2.45.1+ ya da yamalı bakım sürümü — tablo:
  // `partialCloneUnsupported`); diğerleri sessizce yok sayar, o durum
  // `assertPartialCloneSupported` ile kapatılır. BEDELİ: yerelde olmayan
  // bir nesneye ihtiyaç duyan komut (örn. `worktree add` checkout'u)
  // fail-closed hata verir.
  GIT_NO_LAZY_FETCH: "1",
};

/**
 * Git çocuk süreç ortamını kurar (SAF — inceleme W-H1/W-M2/LOW-3): `base`
 * kopyalanır (DEĞİŞTİRİLMEZ), repo-yerel miras değişkenleri silinir, sonra
 * `extra` (çağrı noktası) ve EN SON güvenlik sabitleri yazılır — `extra`
 * sabitleri gölgeleyemez.
 *
 * Süzme gerekçesi: MCP süreci mutlak `GIT_DIR`/`GIT_WORK_TREE` (vb.) ile
 * başlatılmışsa worktree komutları (`add -A`, `commit`, `reset --hard`)
 * `cwd`'yi yok sayıp ANA repoya giderdi (ölçüldü: ana dala commit + index
 * kirlenmesi). Repo her zaman `cwd`'den keşfedilir.
 *
 * Harf duyarsızlık (inceleme P1): Windows'ta ortam anahtarları büyük/küçük
 * harf duyarsızdır (Node `child_process` belgesi) — miras `Git_Dir` git'e
 * `GIT_DIR` olarak ulaşır. Eşleştirme bu yüzden `toUpperCase()` üzerinden
 * yapılır; platform dalı YOK (POSIX'te git yalnız büyük harfi okur,
 * karışık harfli kopyayı silmek zararsız). Aynı sebeple güvenlik
 * sabitlerinin karışık harfli kopyaları da silinir: `Git_No_Lazy_Fetch=0`
 * ile `GIT_NO_LAZY_FETCH=1` yan yana kalırsa Windows'ta hangisinin
 * kazanacağı belirsizdir — sabit TEK kopya olmalı.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (REPO_LOCAL_ENV_VARS.has(name) || GIT_CONFIG_PAIR_ENV.test(name)) {
      delete env[key];
    }
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) {
    if (Object.hasOwn(GIT_SAFETY_ENV, key.toUpperCase())) {
      delete env[key];
    }
  }
  return Object.assign(env, GIT_SAFETY_ENV);
}

/** `git --version` çıktısından `[major, minor, patch]`; ayrıştırılamazsa `null`. */
export function parseGitVersion(output: string): readonly [number, number, number] | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

/**
 * `GIT_NO_LAZY_FETCH`'i tembel çekmenin ortak geçidinde (`promisor-remote.c`
 * `fetch_objects()`) denetleyen bakım serileri: 2.<minor> → korumayı taşıyan
 * EN KÜÇÜK patch. 2.46+ hep korumalı; 2.39 öncesi hiç. Kaynak:
 * github.com/git/git etiketleri (ölçüldü 2026-10-05): v2.38.5, v2.39.3,
 * v2.40.1, v2.41.0, v2.42.1, v2.43.3, v2.44.0, v2.45.0 → YOK; tablodaki
 * patch'ler ile v2.46.0/v2.50.0 → VAR. v2.45.0 değişkeni yalnız nesne-okuma
 * yolunda okur (`environment.c` → `fetch_if_missing`); `diff` ön-çekmesi
 * (`promisor_remote_get_direct`) yine ağa çıkar → güvensiz sayılır.
 */
const NO_LAZY_FETCH_MIN_PATCH: ReadonlyMap<number, number> = new Map([
  [39, 4],
  [40, 2],
  [41, 1],
  [42, 2],
  [43, 4],
  [44, 1],
  [45, 1],
]);

/**
 * SAF karar (inceleme MEDIUM-1): bu git + bu repo için tembel promisor
 * çekme KAPATILAMIYOR mu? `true` → oluşturma/kurtarma reddedilir.
 * - promisor yok → `false` (çekilecek remote yok);
 * - promisor var + git 3+ / 2.46+ / tablodaki yamalı patch ve sonrası →
 *   `false` (`GIT_NO_LAZY_FETCH` etkili);
 * - promisor var + diğer her sürüm ya da sürüm AYRIŞTIRILAMADI → `true`
 *   (güvenli taraf: korumasız say).
 */
export function partialCloneUnsupported(gitVersionOutput: string, promisorConfigured: boolean): boolean {
  if (!promisorConfigured) {
    return false;
  }
  const version = parseGitVersion(gitVersionOutput);
  if (version === null) {
    return true;
  }
  const [major, minor, patch] = version;
  if (major !== 2) {
    return major < 2;
  }
  if (minor >= 46) {
    return false;
  }
  const minPatch = NO_LAZY_FETCH_MIN_PATCH.get(minor);
  return minPatch === undefined || patch < minPatch;
}

/**
 * `git --version` önbelleği — anahtar `PATH`: `spawn("git")` ikiliyi ortamın
 * `PATH`'iyle çözer; farklı `PATH` farklı git olabilir. Yalnız BAŞARILI
 * okumalar önbelleğe girer (hata → boş metin → ayrıştırılamaz → eski say).
 */
const gitVersionCache = new Map<string, string>();

async function readGitVersion(): Promise<string> {
  const key = process.env.PATH ?? "";
  const cached = gitVersionCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  try {
    // `--version` repo gerektirmez; `cwd` repo yolundan bağımsız (var olmayan
    // bir kurtarma kökü sürüm okumasını bozmasın).
    const text = (await runGit(["--version"], { cwd: os.tmpdir() })).stdout.toString("utf8").trim();
    gitVersionCache.set(key, text);
    return text;
  } catch {
    return "";
  }
}

/**
 * Salt-okunur `git config` okuması (ana repoda): çıkış 1 = anahtar yok →
 * `null`; başka her hata ATILIR (çağıran güvenli tarafa düşer).
 */
async function readRepoConfig(repoRoot: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await runGit(["config", ...args], { cwd: repoRoot })).stdout.toString("utf8");
  } catch (err) {
    if (err instanceof WorkspaceError && (err.cause as { exitCode?: unknown } | undefined)?.exitCode === 1) {
      return null;
    }
    throw err;
  }
}

/**
 * Repo bir promisor remote taşıyor mu? Üç sinyalden biri yeter:
 * - `extensions.partialClone` (eski biçim) — anahtarın VARLIĞI yeter; boş
 *   değer de (`""`) promisor'dır (ölçüldü, Git 2.50.1: boş ad → `fetch ''`);
 * - herhangi bir `remote.<ad>.promisor=true` (ölçüldü, Git 2.50.1
 *   `--filter=blob:none` klonu yalnız bunu yazar);
 * - herhangi bir `remote.<ad>.partialCloneFilter` — DEĞERİNDEN bağımsız,
 *   boş değer dahil; anahtarın varlığı yeter (git `promisor-remote.c`
 *   `promisor_remote_config()` bu anahtarı görünce `promisor_remote_new()`
 *   çağırır; ölçüldü v2.44.0, v2.50.0).
 * İki seviyeli `remote.promisor` / `remote.partialCloneFilter` (alt bölümsüz)
 * da sayılır: `parse_config_key` sonrası `name == NULL` koruması yok (v2.44.0
 * kaynağı) → boş adlı promisor üretilir (ölçüldü, Git 2.50.1: `fetch ''`) —
 * regex'ler bu yüzden `remote\.(.*\.)?` ile başlar.
 * Okunamazsa → `true` (güvenli taraf; yalnız korumasız git'te redde dönüşür).
 */
async function promisorConfigured(repoRoot: string): Promise<boolean> {
  try {
    if ((await readRepoConfig(repoRoot, ["--get", "extensions.partialclone"])) !== null) {
      return true;
    }
    const remotes = await readRepoConfig(repoRoot, ["--bool", "--get-regexp", "^remote\\.(.*\\.)?promisor$"]);
    if (remotes !== null && remotes.split("\n").some((line) => line.trimEnd().endsWith(" true"))) {
      return true;
    }
    return (await readRepoConfig(repoRoot, ["--get-regexp", "^remote\\.(.*\\.)?partialclonefilter$"])) !== null;
  } catch {
    return true;
  }
}

/**
 * Oluşturma + kurtarma kapısı (inceleme MEDIUM-1): `GIT_NO_LAZY_FETCH`'i
 * tembel çekme geçidinde denetlemeyen git (`partialCloneUnsupported`
 * tablosu) onu sessizce yok sayar → promisor'lı bir repoda eksik nesne
 * okuması repo config'indeki transport programlarını (`remote.*.uploadpack`,
 * `core.sshCommand`) host'ta çalıştırabilir. Böyle bir repo SABİT güvenli
 * mesajla reddedilir (yol/ortam değeri İÇERMEZ); korumalı git → davranış
 * değişmez.
 */
export async function assertPartialCloneSupported(repoRoot: string): Promise<void> {
  if (partialCloneUnsupported(await readGitVersion(), await promisorConfigured(repoRoot))) {
    throw new WorkspaceError(
      "invalid_repository",
      "Partial clone repositories require a Git release that honors GIT_NO_LAZY_FETCH (2.45.1+ or a patched maintenance release)",
    );
  }
}

/** Varsayılan git çağrı zaman aşımı (büyük repo diff'leri için cömert). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface GitRunOptions {
  /** Git komutunun çalışacağı dizin (repo buradan keşfedilir). */
  cwd: string;
  /**
   * Ek `-c` config çiftleri (örn. `core.hooksPath=...`, `commit.gpgsign=false`).
   * Yalnız bu komut için geçerli; hiçbir config dosyasına yazılmaz.
   * Güvenlik sabitleri (`core.hooksPath` + `core.fsmonitor`) bu listeden
   * bağımsız olarak her çağrıya merkezi eklenir ve `-c` önceliğinde SONDA
   * (kazanan) konumdadır — bu listeden gelen bir değer onları gölgeleyemez.
   */
  config?: readonly string[];
  /** Stdin yükü (örn. `git apply` için patch baytları) — shell pipeline YOK. */
  stdin?: Buffer | string;
  /** `process.env` (repo-yerel değişkenleri süzülmüş) üzerine merge edilen ek ortam değişkenleri. */
  env?: NodeJS.ProcessEnv;
  /** ms; aşılırsa çocuk süreç öldürülür. Varsayılan 5 dk. */
  timeoutMs?: number;
}

export interface GitRunResult {
  /** Çıktı ham Buffer olarak döner (binary patch'lar için utf8 decode'u YOK). */
  stdout: Buffer;
  /** Hata kanalı için biriktirilir (dışarıya yalnız kısılmış hali, `cause`'ta). */
  stderr: Buffer;
}

/** Ham stderr'den teknik kanal için güvenli, kısılmış dize üretir. */
function safeCauseDetail(stderr: Buffer, code: number | null): { stderr: string; exitCode: number | null } {
  // Teknik kanal: ≤500 byte, utf8 decode (geçersiz bayt → ikame karakteri).
  const text = stderr.subarray(0, 500).toString("utf8");
  return { stderr: text, exitCode: code };
}

/**
 * Shell'siz git yürütür (spec 5). Tüm git çağrılarının TEK geçidi.
 *
 * - argv: `config` çiftleri (`-c`) + alt komut + argümanlar — her biri ayrı girdi.
 * - stdout Buffer olarak toplanır (binary güvenli).
 * - Başarısız çıkış / spawn hatası / zaman aşımı → `WorkspaceError`
 *   (`git_operation_failed`, SABİТ message; detay `cause`'ta).
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const gitArgs: string[] = [];
  for (const pair of options.config ?? []) {
    gitArgs.push("-c", pair);
  }
  // Merkezi güvenlik kilidi (audit HIGH-1): her git çağrısı — `config`
  // argümanı verilsin veya verilmesin — hook + fsmonitor devre-dışı
  // config'lerini taşır. Komut satırında SONDA oldukları için `-c`
  // önceliğinde çağrı-bazlı config'in üstüne geçer (ölçüldü: son `-c`
  // kazanır); saldırgan repo config'inden (`.git/config`) gelen bir değer
  // asla kazanamaz. Çağrı noktalarının geçirdiği aynı sabitle oluşan
  // tekrarlardan davranış etkilenmez (aynı değer; sonuncu geçerli).
  gitArgs.push("-c", HOOKS_DISABLED_CONFIG, "-c", FSMONITOR_DISABLED_CONFIG);
  gitArgs.push(...args);

  // Repo-yerel miras değişkenleri süzülür + güvenlik sabitleri (buildGitEnv).
  const env = buildGitEnv(process.env, options.env);

  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn("git", gitArgs, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      const detail = safeCauseDetail(Buffer.concat(stderr), child.exitCode);
      reject(
        new WorkspaceError("git_operation_failed", "A Git operation failed", {
          cause: { command: args[0] ?? "git", ...detail, original: err },
        }),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("git timed out"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Zamanlayıcı event loop'u ayakta tutmasın; sonuç gelince zaten settle olur.
    timer.unref();

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Örn. git ikili yok (ENOENT) — ham detay `cause`'ta, mesaj SABİТ.
      if (err.code === "ENOENT") {
        fail(new Error("git executable not found"));
      } else {
        fail(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      // `settled` yalnız burada (success) veya `fail` içinde (error) ayarlanır —
      // `fail` çağrısından ÖNCE set edilirse `fail`'in kendi `settled` koruması
      // early-return yapar ve Promise asla settle olmazdı.
      if (code === 0) {
        settled = true;
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        fail(new Error(`git exited with code ${String(code)}`));
      }
    });

    const stdinData = options.stdin;
    if (stdinData !== undefined) {
      child.stdin.on("error", () => {
        // EPIPE vb.: close/yanlı çıkış kodu üzerinden settle edilir.
      });
      child.stdin.end(stdinData);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * NUL-bölümlü git çıktısını ( `-z`) dizgiye böler.
 * Boş kayıtlar (son NUL) korunur; çağrı tarafı boşları filtreler.
 * Geçersiz utf8 bayt → ikame karakteri (yalnız gösterim kanalı).
 */
export function splitNul(data: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      out.push(data.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  out.push(data.subarray(start).toString("utf8"));
  return out;
}

/**
 * `git cat-file --batch` çıktısını (header + tam boyutlu gövde kayıtları)
 * `oid → bayt` haritasına çözer.
 */
export function parseCatFileBatch(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  for (;;) {
    const headerEnd = data.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      if (offset < data.length) {
        throw new WorkspaceError("git_operation_failed", "Reading repository data failed", {
          cause: "malformed cat-file batch header",
        });
      }
      break;
    }
    const header = data.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40}) [a-z]+ (\d+)$/.exec(header);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new WorkspaceError("git_operation_failed", "Reading repository data failed", {
        cause: "malformed cat-file batch header",
      });
    }
    const size = Number(match[2]);
    const start = headerEnd + 1;
    if (start + size > data.length) {
      throw new WorkspaceError("git_operation_failed", "Reading repository data failed", {
        cause: "truncated cat-file batch payload",
      });
    }
    out.set(match[1], data.subarray(start, start + size));
    // Kayıt sonu: `git cat-file --batch` her kaydı `\n` ile bitirir
    // (ölçüldü, Apple Git 2.50; eski sürümlerde `\0` görülür — ikisi de kabul).
    // İçerik boyutu başlıktan BİREBİR bilindiği için `\n` içeren binary
    // içerikler de bozulmadan okunur.
    offset = start + size;
    if (offset < data.length) {
      const sep = data[offset];
      if (sep !== 0x0a && sep !== 0x00) {
        throw new WorkspaceError("git_operation_failed", "Reading repository data failed", {
          cause: "missing cat-file batch record separator",
        });
      }
      offset += 1;
    }
    if (offset >= data.length) {
      break;
    }
  }
  return out;
}

export interface DiscoverRepoRootOptions {
  /** Keşif başlangıç dizini (varsayılan: MCP sürecinin CWD'si). */
  cwd?: string;
  /** Config `repo_root` override'ı — varsa keşif buradan başlar. */
  override?: string;
}

/**
 * `dir`'in en yakın VAROLAN atalını döndürür (yoksa dosya sistemi köküne
 * kadar tırmanır; kök daima var). `spawn`'ın `cwd`'si var olmayan bir
 * dizin olamayacağı için git'i bu dizinden başlatırız — keşif "verilen
 * dizinden" başlar, dizin henüz yoksa en yakın var olan atalından.
 */
async function nearestExistingAncestor(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current; // dosya sistemi kökü — daima var
      }
      current = parent;
    }
  }
}

/**
 * Repository kökü keşfi (DESIGN.md 2.2/7.2, Step 5 spec 7):
 * başlangıç dizininden `git rev-parse --show-toplevel` ile kanonik toplevel
 * çözür; gerçek (bare değil) bir working-tree olduğunu ve HEAD commit'inin
 * var olduğunu doğrular. Dönen değer realpath ile kanonikleştirilmiş
 * mutlak toplevel'dır.
 *
 * Non-git dizin → `invalid_repository` ("The project root is not a valid
 * Git working tree"). Non-git YEDEK mekanizma YOK (spec 7, DESIGN 7.2).
 *
 * Başlangıç dizini henüz yoksa (örn. planlanmış bir alt dizin override'ı)
 * keşif en yakın var olan ataldan başlatılır; git oradan toplevel'i bulur.
 */
export async function discoverRepoRoot(options: DiscoverRepoRootOptions = {}): Promise<string> {
  const startDir = path.resolve(options.override ?? options.cwd ?? process.cwd());
  const probeDir = await nearestExistingAncestor(startDir);

  let toplevelText: string;
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: probeDir });
    toplevelText = result.stdout.toString("utf8").trim();
  } catch {
    throw new WorkspaceError("invalid_repository", "The project root is not a valid Git working tree");
  }
  if (toplevelText === "") {
    throw new WorkspaceError("invalid_repository", "The project root is not a valid Git working tree");
  }

  const root = path.resolve(toplevelText);

  // Gerçek (bare değil) working-tree doğrulaması (spec 7).
  let isBare: string;
  try {
    const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: root });
    isBare = bare.stdout.toString("utf8").trim();
  } catch {
    throw new WorkspaceError("invalid_repository", "The project root is not a valid Git working tree");
  }
  if (isBare === "true") {
    throw new WorkspaceError("invalid_repository", "The project root is not a valid Git working tree");
  }

  // v1 worktree tabanı bir base commit gerektirir (DESIGN.md 7.3).
  try {
    await runGit(["rev-parse", "--verify", "HEAD"], { cwd: root });
  } catch {
    throw new WorkspaceError("invalid_repository", "The repository does not have a HEAD commit");
  }

  // Dosya sistemi kanonikleştirmesi (semantik: symlink kökler tek kimlik).
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/**
 * Deterministik repository kimliği (DESIGN.md 7.6, Step 5 spec 70):
 * kanonik mutlak repo kökünün SHA-256 özetinin ilk 16 hex karakteri.
 * - Aynı kanonik repo → aynı kimlik; farklı kökler → (normale) farklı kimlik.
 * - Ham dosya yolu patch dosya/dizin adında ASLA yer almaz; rastgelelik YOK.
 */
export function computeRepoId(canonicalRepoRoot: string): string {
  const normalized = path.resolve(canonicalRepoRoot).replace(/[\\/]+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}
