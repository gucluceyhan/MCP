import { execFile } from "node:child_process";

/**
 * Host inference-runtime çakışma algılama (DESIGN.md bölüm 2.7 / 11 madde 3).
 *
 * Görevi TEK: host süreç tablosuna bakıp "yapılandırılan Splash runtime'ın
 * kendi süreci ve torunları DIŞARIDA bırakıldığında, başka bir yerel
 * inference runtime'ı (Splash / MLX / Ollama) çalışıyor mu?" sorusunu
 * cevaplamak.
 *
 * Disiplin:
 * - Sınıflandırma TOKEN-BİLİNDİRLİDİR — rastgele komut satırında geniş
 *   alt-dize (substring) araması YOK. Bir editörün `splash` adında dosya
 *   AÇMASI, `echo ollama` ya da `mlx-notes.txt` içeren bir yol çakışma
 *   sayılmaz; bu MCP'nin kendi `node .../dist/index.js` süreci de
 *   (yolunda "Splash" dursa bile) çakışma sayılmaz.
 * - Yapılandırılan Splash runtime'ın PID'si ve TÜM torun süreçleri
 *   (ör. `serve-native` yerel child runtime'ı) sınıflandırmadan ÖNCE
 *   çıkarılır — istemli backend asla kendi kendisiyle çakışmaz.
 * - Ham komut satırları YALNIZCA iç temsildir: MCP çıktısında,
 *   `inference_busy` metadata'sında, hata mesajlarında ya da kalıcı
 *   durumda ASLA yer almaz (credential içerebilir).
 * - Scanner hatası YUTULMAZ: `detect` scanner'ın reddini yaydırır;
 *   Inference Coordinator bunu fail-closed `inference_busy`/`unknown`
 *   olarak haritalar.
 */

/** Host süreç tablosu satırı. `command` YALNIZCA iç temsildir. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Ham komut satırı — asla dışarı taşırılmaz. */
  command: string;
  /**
   * İsteğe bağlı çalıştırılabilir yolu (`ps -o comm=`, macOS'ta argv[0]) —
   * BOŞLUK içerebilir (İz 2 / M2). Yalnız `command`'ın boşlukla sınırlı
   * ÖNEKİ ise ilk token yerine kullanılır; aksi hâlde yok sayılır.
   */
  executable?: string;
}

/** Host süreç tablosu taraması (injeksiyon noktası). */
export type ProcessScanner = () => Promise<ProcessInfo[]>;

/** Algılanan çakışma türü (`"none"` = host temiz). */
export type ConflictKind = "none" | "splash" | "mlx" | "ollama";

/**
 * Python ailesi yorumlayıcı basename deseni: `python`, `python2`,
 * `python3`, `python2.7`, `python3.12`, `python3.13`, ... — yani
 * `python` + isteğe bağlı major (`2`/`3`) + sıfır ya da daha fazla `.N`
 * versiyon segmenti. Baş harf `P` da kabul edilir (İz 2 / M2): macOS
 * framework build'leri (Homebrew / python.org) venv'den çağrılsa bile
 * `…/Python.app/Contents/MacOS/Python` olarak çalışır (ölçüldü: ps komut
 * satırı venv yolunu değil bu yürütülebiliri gösterir). `^…$` sınırları sayesinde `python-helper`,
 * `python3-notes`, `mypython3`, `python3.13-debug-wrapper` gibi
 * benzer isimli yürütülebilirler yorumlayıcı DEĞİLDİR.
 */
const PYTHON_INTERPRETER_BASENAME = /^[Pp]ython(?:2|3)?(\.\d+)*$/;

/** Bir token'ın basename'ı: son `/` (ya da `\`) parçası. */
function basenameOf(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
}

function tokenizeCommand(command: string): string[] {
  return command.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Süreci token'lara böler: ilk token çalıştırılabilirdir. `executable`
 * (ps `comm`) komut satırının boşlukla sınırlanan ÖNEKİ ise — yolu boşluk
 * içeren yorumlayıcılar (`…/Yazılımlarım ve Kodlar/.venv/bin/python3`) —
 * ilk token TAMAMI odur; aksi hâlde düz boşluk bölmesi (İz 2 / M2).
 */
function processTokens(entry: ProcessInfo): string[] {
  const exe = entry.executable;
  if (
    exe !== undefined &&
    exe.length > 0 &&
    /\s/.test(exe) &&
    entry.command.startsWith(exe) &&
    (entry.command.length === exe.length || /\s/.test(entry.command[exe.length] ?? ""))
  ) {
    return [exe, ...tokenizeCommand(entry.command.slice(exe.length))];
  }
  return tokenizeCommand(entry.command);
}

/**
 * Komutun çalıştırılabiliri (ilk token) Python/uv ailesinden mi?
 *
 * Yorumlayıcı basename'ı YOL bağımsızdır: `/opt/homebrew/bin/python3.13` ya da
 * `/venv/bin/python3.12` aynı yorumlayıcıdır — basename deseniyle
 * tanınır (versioned formlar da dahil). `uv`/`uvx` çalıştırıcıları
 * literal olarak korunur. Bu kapı hem `isSplashRuntime` (b) dalını hem de
 * `isMlxRuntime`'u besler.
 */
function usesInterpreterLauncher(tokens: readonly string[]): boolean {
  const first = tokens[0];
  if (first === undefined) {
    return false;
  }
  const base = basenameOf(first);
  return base === "uv" || base === "uvx" || PYTHON_INTERPRETER_BASENAME.test(base);
}

/**
 * Bir komut gerçek bir Splash runtime'ı mı?
 *
 * Tanıma formları (tasarımın minimum imzaları):
 *  - `splash serve ...`            (CLI runtime)
 *  - `... serve-native`            (yerel native runtime formu)
 *  - `--mode=serve-native`         (native runtime bayrağı formu)
 *  - `python3 .../splash serve`    (Python launcher formu; versioned
 *                                   yorumlayıcılar da — `python3.13`,
 *                                   venv yolları — aynı kapıdan geçer)
 *  - `python -m splash ...`        (modül formu)
 *  - `uvx splash serve`            (uv/uvx formu)
 *
 * Gerçekten yanlış pozitif üretmemek için TÜM denetimler
 * TOKEN-BİLİNDİRLİDİR — rastgele komut satırı üzerinde geniş alt-dize
 * araması YOK: `serve`/`serve-native` yalnızca TAM token, basename'i
 * `serve-native` olan token ya da `=serve-native` bayrak formu olarak
 * sayılır (`vim serve-native-notes.txt`, `rsync .../serve-native/`
 * çakışma DEĞİLDİR). `splash` yürütülebilir/betik formu için `serve`
 * alt-komutu YINE şarttır; bir editörün `splash` adında dosya AÇMASI
 * (yürütülebilir `code`/`vim`) çakışma DEĞİLDİR.
 */
function isSplashRuntime(tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  const executable = basenameOf(tokens[0] ?? "");

  // Yerel native runtime imzası — token-bilinçli üç form:
  //  (1) tam `serve-native` token'ı (resmi child: `.../engine/splash
  //      serve-native ...`),
  //  (2) basename'i `serve-native` olan token (`./serve-native` biçimi),
  //  (3) `--mode=serve-native` biçiminde bayrak.
  // Geniş alt-dize araması bilinçli olarak YOK: `serve-native-notes.txt`
  // gibi dosya adları bu sınıfta çakışma üretmez.
  const hasServeNative = tokens.some(
    (token) =>
      token === "serve-native" ||
      basenameOf(token) === "serve-native" ||
      token.endsWith("=serve-native"),
  );
  if (hasServeNative) {
    return true;
  }

  const hasServe = tokens.some((token) => token === "serve" || token === "serve-native");
  if (!hasServe) {
    return false;
  }
  // (a) Yürütülebilirin kendisi `splash` + `serve` formu.
  if (executable === "splash") {
    return true;
  }
  // (b) Python/uv launcher + `splash` betik/modül argümanı + `serve`
  //     formu. `splash` argümanı basename eşitliğiyle aranır
  //     (`splash.ts`, `splash-notes.txt` eşleşmez); `serve` alt-komutu
  //     zorunludur — `python3 ~/my/splash --flag` gibi düz betik
  //     çağrıları runtime sayılmaz.
  if (usesInterpreterLauncher(tokens)) {
    return tokens.some((token) => basenameOf(token) === "splash");
  }
  return false;
}

/**
 * Bir komut gerçek bir MLX ailesi (mlx-lm / mlx-vlm) runtime'ı mı?
 *
 * Tanıma: yürütülebilir basename `mlx_lm`/`mlx_vlm` (ya da
 * `mlx_lm.*`/`mlx_vlm.*` venv giriş noktaları, örn. `mlx_lm.server`)
 * ya da bir Python/uv yorumlayıcısının — her formu: `python`, `python3`,
 * versioned (`python3.13`), venv yolu (`/venv/bin/python3.12`), `uv`/`uvx` —
 * argümanlarından biri TAM `mlx_lm`/`mlx_vlm` modül adı ya da
 * `mlx_lm.*`/`mlx_vlm.*` biçiminde (`python ... -m mlx_lm.server`,
 * `-m mlx_vlm.generate`). `python3 mlx_lm_utils.py` gibi yalnız ön-ecesi
 * aynı dosya adları ve `code /project/mlx-notes.txt` gibi argüman içi
 * metinler eşleşmez.
 */
function isMlxRuntime(tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  const executable = basenameOf(tokens[0] ?? "");
  if (executable === "mlx_lm" || executable === "mlx_vlm") {
    return true;
  }
  if (executable.startsWith("mlx_lm.") || executable.startsWith("mlx_vlm.")) {
    return true;
  }
  if (!usesInterpreterLauncher(tokens)) {
    return false;
  }
  return tokens.some((token) => {
    const base = basenameOf(token);
    // TAM modül adı ya da `mlx_lm.*`/`mlx_vlm.*` (venv giriş noktası,
    // modül alt-birimi). `mlx_lm_utils` gibi ÖN-ECE aynı isimler
    // bilinçli olarak eşleşmez.
    return (
      base === "mlx_lm" ||
      base.startsWith("mlx_lm.") ||
      base === "mlx_vlm" ||
      base.startsWith("mlx_vlm.")
    );
  });
}

/**
 * Bir komut gerçek bir Ollama serve/runtime süreci mi?
 *
 * Tanıma (token-bilinçli): yürütülebilir basename TAM `ollama` OLMALI ve
 * ilk argüman token'ı `serve` (daemon) ya da `runner` (model yürüten
 * subprocess) OLMALI. Güncel Ollama'da daemon `ollama serve`, model
 * yürüten subprocess `ollama runner --port …` şeklindedir; restructure
 * edilmiş repo (mlxrunner/discover) için argv'si doğrulanamayan ek formlar
 * icat EDİLMEZ — sınıflayıcı minimal kalır.
 *
 * İdari CLI komutları (`ollama list`, `ollama ps`, `ollama pull …`,
 * `ollama --help`, ...) daemon'u SORGULAR/işletir — kendisi long-running
 * inference runtime'ı DEĞİLDİR ve Splash inference'ı bloklamamalı.
 *
 * Argüman içindeki "ollama" metni (`echo ollama`, `code
 * /project/ollama-notes.txt`) YETMEZ — yürütülebilir konumu şarttır.
 */
function isOllamaRuntime(tokens: readonly string[]): boolean {
  if (tokens.length < 2) {
    return false;
  }
  const executable = basenameOf(tokens[0] ?? "");
  if (executable !== "ollama") {
    return false;
  }
  const subcommand = tokens[1] ?? "";
  return subcommand === "serve" || subcommand === "runner";
}

/**
 * Host süreç tablosu üzerindeki çakışma sınıflandırıcısı.
 *
 * Scanner constructor'da enjekte edilir; `detect` her çağrıda
 * tabloyu YENİDEN tarar (önbellek YOK — çağrı başına taze durum,
 * DESIGN.md 2.7: sonuç jenerasyonlar arası önbelleklenmez).
 */
export class RuntimeConflictDetector {
  #scanner: ProcessScanner;

  constructor(scanner: ProcessScanner) {
    this.#scanner = scanner;
  }

  /**
   * Host'u sınıflandırır. `configuredPid` (yapılandırılan Splash
   * runtime'ın PID'si; bilinmiyorsa `null`), TÜM torun süreçleri ve ATA
   * zinciri (pid > 1; uv/uvx başlatıcı) sınıflandırmadan çıkarılır —
   * istemli backend, başlatıcısı ve yerel child runtime'ı (`serve-native`)
   * asla çakışma üretmez; atanın diğer alt ağaçları dışlanmaz.
   *
   * Öncelik sırası sabittir (deterministik): splash > mlx > ollama >
   * none. Scanner hatası (throw/reject) YAYDIRILIR — çağrılan
   * (coordinator) fail-closed haritalamayı yapar.
   */
  async detect(configuredPid: number | null): Promise<ConflictKind> {
    const table = await this.#scanner();

    const known = new Set<number>();
    const childrenOf = new Map<number, number[]>();
    for (const entry of table) {
      known.add(entry.pid);
      const siblings = childrenOf.get(entry.ppid);
      if (siblings === undefined) {
        childrenOf.set(entry.ppid, [entry.pid]);
      } else {
        siblings.push(entry.pid);
      }
    }

    // Yapılandırılan runtime'ın torun kapalılığı (BFS, döngü-güvenli).
    const excluded = new Set<number>();
    if (configuredPid !== null && known.has(configuredPid)) {
      // ATA zinciri de dışlanır (İz 2 / M3): `uvx splash serve` gibi bir
      // başlatıcı yapılandırılmış runtime'ın EBEVEYNİDİR, rakibi değil.
      // Yalnız zincirin kendisi (ppid ile, pid > 1'e kadar; döngü-güvenli)
      // — atanın DİĞER çocuk alt ağaçları dışlanmaz.
      const parentOf = new Map<number, number>();
      for (const entry of table) {
        parentOf.set(entry.pid, entry.ppid);
      }
      let ancestor = parentOf.get(configuredPid);
      while (ancestor !== undefined && ancestor > 1 && !excluded.has(ancestor) && ancestor !== configuredPid) {
        excluded.add(ancestor);
        ancestor = parentOf.get(ancestor);
      }
      const descendants = new Set<number>();
      const stack = [configuredPid];
      while (stack.length > 0) {
        const pid = stack.pop();
        if (pid === undefined || descendants.has(pid)) {
          continue;
        }
        descendants.add(pid);
        excluded.add(pid);
        const children = childrenOf.get(pid);
        if (children !== undefined) {
          for (const child of children) {
            stack.push(child);
          }
        }
      }
    }

    let foundSplash = false;
    let foundMlx = false;
    let foundOllama = false;
    for (const entry of table) {
      if (excluded.has(entry.pid)) {
        continue; // İstemli backend ağacı: çakışma değildir.
      }
      const tokens = processTokens(entry);
      if (isSplashRuntime(tokens)) {
        foundSplash = true;
      } else if (isMlxRuntime(tokens)) {
        foundMlx = true;
      } else if (isOllamaRuntime(tokens)) {
        foundOllama = true;
      }
    }

    if (foundSplash) {
      return "splash";
    }
    if (foundMlx) {
      return "mlx";
    }
    if (foundOllama) {
      return "ollama";
    }
    return "none";
  }
}

/** `ps`'yi kabuksuz çalıştırır; hata/`maxBuffer` aşımı → red. */
function runPs(columns: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("ps", ["-axww", "-o", columns], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Üretim süreç tarayıcısı: `ps` — `execFile` ile, kabuk YOK, boru YOK
 * (dolayısıyla komut enjeksiyonu yüzeyi de yok).
 *
 * `ps -axww` tüm süreçleri tek satır/kolonda döndürür; `pid=,ppid=,command=`
 * başlıksız biçimi çıktıyı deterministik tutar. Çıktı `maxBuffer`'ı
 * aşarsa ya da `ps` başarısız olursa promise REDDER — coordinator bunu
 * fail-closed `inference_busy`/`unknown` olarak haritalar.
 *
 * İkinci tarama `pid=,comm=` (İz 2 / M2): çalıştırılabilir yolunu (macOS'ta
 * argv[0]; boşluk içerebilir) verir — komut satırı boşlukta bölünürken
 * kaybolan sınırı geri kazandırır. İki tarama atomik değildir: PID ile
 * eşlenir; eşleşmeyen/ayrıştırılamayan `comm` satırı yalnız ipucunu düşürür
 * (sınıflandırma ilk-token kuralına döner). `comm` taraması başarısızsa
 * tablo REDDEDİLİR (fail closed).
 */
export function createPsScanner(): ProcessScanner {
  return async () => {
    const [commandOut, commOut] = await Promise.all([runPs("pid=,ppid=,command="), runPs("pid=,comm=")]);
    const executables = new Map<number, string>();
    for (const line of commOut.split("\n")) {
      const match = /^\s*(\d+) (.+)$/.exec(line);
      if (match !== null) {
        executables.set(Number.parseInt(match[1] ?? "", 10), (match[2] ?? "").trimEnd());
      }
    }
    const table: ProcessInfo[] = [];
    for (const line of commandOut.split("\n")) {
      if (line.trim().length === 0) {
        continue; // Boş satır (ör. sondaki satır): zararsız.
      }
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const ppid = Number.parseInt(parts[1] ?? "", 10);
      // `ppid >= 0`: PID 1 (launchd) `ppid 0` raporlar — bu her
      // gerçek tablodadır ve güvenli yorumlanabilir (ebeveyn yok).
      // `pid > 0`: gerçek süreç kimliği şarttır.
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
        // Güvenle yorumlanamayan satır: tablo tam güvenilmez —
        // fail closed (coordinator `unknown` haritalar).
        throw new Error("Process table contains an unparseable row");
      }
      // `command`: kalan tüm satır. (Boş komut — örn. zombi —
      // hiçbir imzayla eşleşmez; tablo hata sayılmaz.)
      const info: ProcessInfo = { pid, ppid, command: parts.slice(2).join(" ") };
      const executable = executables.get(pid);
      if (executable !== undefined && executable.length > 0) {
        info.executable = executable;
      }
      table.push(info);
    }
    return table;
  };
}
