/**
 * Step 5: parmak izi (fingerprint) yardımcıları (Step 5 spec 30, 31).
 *
 * Parmak izi = varlık + tip + ilintili mod + içerik (SHA-256 özet).
 * Bu dosyada İKİ yakalama yolu yaşar:
 *
 * 1. Base yakalama desteği (`gitModeType`/`normalizeGitFileMode`/`sha256Hex`):
 *    `GitWorktreeWorkspace` geçici base commit'i oluşturduktan sonra seçili
 *    yolların parmak izini worktree'nin ÇALIŞMA DOSYALARINDAN yakalar —
 *    `captureLiveFingerprint` ile BİREBİR aynı alan (PR #24):
 *    varlık (base commit'in `ls-tree`'i) + tip/mod (çalışma dosyasının
 *    `lstat`'ı: `0o100` bit → `100755`/`100644`; link → `120000`) + içerik
 *    SHA-256'ı (düzenli dosyanın baytları / link hedef metni).
 *
 *    İKİ ALAN KARIŞTIRILMAZ:
 *    - base parmak izi + tam-eşleşme içeriği = **working-tree baytları**
 *      (worker'a gösterilen şey birebir budur; `text`/`eol` normalizasyonu
 *      blob ile working tree'yi FARKLI baytlara sokabilir — ör. working
 *      tree CRLF vs blob LF — bu beklenen ve tam eşleşmeyi bozmaz);
 *    - geçici base commit = **diff/reset/export tabanı** (`git diff <base>`,
 *      `git reset --hard <base>`, `git apply`) — git kendi I/O'sunu bu
 *      commit etrafında tutarlı normalize eder.
 *    Base commit'in `ls-tree`'i yapısal doğruluk kaynağı olarak kalır
 *    (varlık + git modu → `basePaths`; create/delete denetimleri).
 *
 * 2. `captureLiveFingerprint`: bir yolun ANLIK (live) durumunu parmak iziye
 *    çevirir — PERMISSIVE (hoşgörülü) varyant: lstat hatası → `exists:false`,
 *    okuma hatası → özet vermeden tip+mod. Bu hoşgörü Step 9'un stale
 *    KARARI için YETMEZ (spec 45) — operasyonel hataları "yok" sayamaz.
 *    Step 9 stale denetimi bunun yerine STRICT yakalamayı kullanır:
 *    `captureStrictLiveFingerprint` / `captureStrictLiveExistence`.
 *
 * 3. STRICT live yakalama (`captureStrictLiveFingerprint` /
 *    `captureStrictLiveExistence` — Step 9 spec 44-52):
 *    - `lstat`: YALNIZ `ENOENT` → `exists:false`; her başka hata →
 *      `StrictReadError` (fail-closed; "yok" DEĞİL, belirsiz — spec 47).
 *    - sembolik bağlantı yaprağı: `lstat` + `readlink` (dereferans YOK);
 *      `readlink` hatası → `StrictReadError` (sahte yokluk DEĞİL — spec 51).
 *    - düzenli dosya: paylaşılacak no-follow okuma
 *      (`SafeRepoReader.noFollowReadFile` — `open(O_NOFOLLOW)` + aynı kol);
 *      hata → `StrictReadError` (spec 48).
 *    - `captureStrictLiveExistence`: YALNIZ `lstat` (içerik ASLA okunmaz —
 *      worker-oluşturulan yol çakışması için varlık yeterli, spec 171/266).
 *    İki varyantın ALANLARI aynı ölçektedir: base YENİDEN aynı alandan
 *    yakalandığı (PR #24) için karşılaştırma (`fingerprintsEqual`) iki
 *    tarafta da aynı ölçekte çalışır.
 *
 * Sembolik bağlantılar ASLA takip edilmez: link'in parmak izi = hedef metin.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { errnoIs, noFollowReadFile, StrictReadError } from "./SafeRepoReader.js";
import type { PathFingerprint } from "./Workspace.js";

/** Birebir baytların SHA-256 hex özeti (standart Node crypto, spec 30). */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Git tree modu → parmak izi tipi.
 * `100644`/`100755` (+ tarihsel `100444` salt-okunur blob) → `"file"`;
 * `120000` → `"symlink"`; gerisi (örn. `160000` gitlink) → `"other"`.
 */
export function gitModeType(mode: string): "file" | "symlink" | "other" {
  if (mode === "100644" || mode === "100755" || mode === "100444") {
    return "file";
  }
  if (mode === "120000") {
    return "symlink";
  }
  return "other";
}

/**
 * Git tree modunu git-ilintili üç temel moda normalize eder (spec 31):
 * `100444` (eski salt-okunur) → `100644`. Diğer modlar (`040000` dizin,
 * `160000` gitlink) aynen korunur — bunlar yalnız tip bilgisi taşır.
 */
export function normalizeGitFileMode(mode: string): string {
  if (mode === "100755" || mode === "120000") {
    return mode;
  }
  if (mode === "100644" || mode === "100444") {
    return "100644";
  }
  return mode;
}

/**
 * Bir yolun ANLIK durumunu `PathFingerprint`'e çevirir — PERMISSIVE (hoşgörülü)
 * varyant (spec 31): okuma hatası "yarım parmak izi" olarak yorumlanır.
 * Step 9 stale KARARI bu yardımcıyı KULLANMAZ (spec 45) — `StrictReadError`
 * fırlatan strict yakalama kullanır (dosya sonu).
 *
 * - var değil → `{ exists: false }`
 * - sembolik bağlantı → tip + `120000` + hedef metnin SHA-256 (takip YOK)
 * - düz dosya → tip + (`0o100` bitine göre `100755`/`100644`) + baytların SHA-256
 * - dizin → tip + `040000` (özet YOK — yalnız tip uyuşmazlığı denetimi)
 * - başka (FIFO/socket/cihaz) → tip `"other"` + `"other"` modu
 */
export async function captureLiveFingerprint(absolutePath: string): Promise<PathFingerprint> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(absolutePath);
  } catch {
    return { exists: false };
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(absolutePath);
    } catch {
      // Link var ama hedef metni okunamadı (race) — özet vermeden tip+mod.
      return { exists: true, type: "symlink", mode: "120000" };
    }
    return {
      exists: true,
      type: "symlink",
      mode: "120000",
      contentSha256: sha256Hex(Buffer.from(target, "utf8")),
    };
  }

  if (stat.isDirectory()) {
    return { exists: true, type: "directory", mode: "040000" };
  }

  if (stat.isFile()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch {
      // Okunamayan dosya (izin/race): özet vermeden tip+mod.
      const executable = (stat.mode & 0o100) !== 0;
      return { exists: true, type: "file", mode: executable ? "100755" : "100644" };
    }
    const executable = (stat.mode & 0o100) !== 0;
    return {
      exists: true,
      type: "file",
      mode: executable ? "100755" : "100644",
      contentSha256: sha256Hex(bytes),
    };
  }

  return { exists: true, type: "other", mode: "other" };
}

/**
 * Pure fingerprint comparison (Step 9 spec 267) — no filesystem, no clock.
 *
 * Two fingerprints are equal iff they agree on:
 * - existence (`{ exists: false }` is a single distinct state);
 * - `type` (`file` / `symlink` / `directory` / `other`);
 * - `mode` (the git-adjacent mode string — never a platform stat mode);
 * - `contentSha256` (both absent, or byte-identical summaries).
 *
 * `mtime` and other volatile stat fields are NOT part of the fingerprint
 * (spec 31), so they never enter this comparison. Used by the stale checker to
 * diff the immutable base against a fresh live capture.
 */
export function fingerprintsEqual(a: PathFingerprint, b: PathFingerprint): boolean {
  if (!a.exists) {
    return !b.exists;
  }
  if (!b.exists) {
    return false;
  }
  return (
    a.type === b.type &&
    a.mode === b.mode &&
    (a.contentSha256 ?? null) === (b.contentSha256 ?? null)
  );
}

// ── Strict live capture (Step 9 spec 44-52) ─────────────────────────────────

/**
 * Strict live yakalamanın I/O dikişleri (test arıza enjeksiyonu).
 * Production varsayılanları: `node:fs/promises` `lstat`/`readlink` +
 * paylaşılacak no-follow okuma (`SafeRepoReader.noFollowReadFile`).
 *
 * `readFile` yüzeyi salt `(target) => Buffer`'dır — production'da BU no-follow
 * okumadır; enjekte bir sahte, aynı sözleşmeyi (hata fırlatabilir) yerine getirir.
 */
export interface StrictReadSeams {
  /** Varsayılan: `node:fs/promises.lstat` (no-follow; son bileşen link olsa da link'in kendisini stat'ler). */
  lstat?: (target: string) => Promise<Stats>;
  /** Varsayılan: `node:fs/promises.readlink` (hedef METNİ; dereferans YOK). */
  readlink?: (target: string) => Promise<string>;
  /** Varsayılan: `noFollowReadFile` (`open(O_RDONLY|O_NOFOLLOW)` + aynı kol). */
  readFile?: (target: string) => Promise<Buffer>;
}

/**
 * Bir yolun ANLIK durumunu `PathFingerprint`'e çevirir — STRICT varyant
 * (Step 9 stale-base denetiminin ölçüsü, spec 44-52). Permissive
 * `captureLiveFingerprint`'ın ALANLARI aynıdır (aynı ölçek), ama HATA
 * SÖZLEŞMESİ fail-closed'dır:
 *
 * - `lstat` `ENOENT` → `{ exists: false }` (yalnız GERÇEK yokluk, spec 47)
 * - `lstat` başka hata (EACCES/EIO/ELOOP/...) → `StrictReadError`
 * - link yaprağı: `readlink` (dereferans YOK) → hedef metin özeti;
 *   `readlink` hatası → `StrictReadError` (sahte yokluk DEĞİL, spec 51)
 * - düzenli dosya: no-follow okuma → bayt özeti; hata → `StrictReadError` (spec 48)
 * - dizin → `{ exists: true, type: "directory", mode: "040000" }` (içerik YOK)
 * - başka (FIFO/socket/cihaz) → `{ exists: true, type: "other", mode: "other" }`
 *
 * Saf: git YOK, saat YOK, yazma YOK. Çağrı tarafı (assembler) bu hatayı kendi
 * tip'li, güvenli işletme hatasına çevirir — stale DEĞİLDİR (spec 44).
 */
export async function captureStrictLiveFingerprint(
  absolutePath: string,
  seams: StrictReadSeams = {},
): Promise<PathFingerprint> {
  const lstatFn = seams.lstat ?? lstat;
  const readlinkFn = seams.readlink ?? readlink;
  const readFileFn = seams.readFile ?? noFollowReadFile;

  let stat: Stats;
  try {
    stat = await lstatFn(absolutePath);
  } catch (err) {
    // YALNIZ ENOENT "yoktur"; her başka hata belirsizlik = fail-closed.
    if (!errnoIs(err, "ENOENT")) {
      throw new StrictReadError(err);
    }
    return { exists: false };
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlinkFn(absolutePath);
    } catch (err) {
      // Link var ama hedef metni okunamadı (race/değişti) → işlemsel hata.
      throw new StrictReadError(err);
    }
    return {
      exists: true,
      type: "symlink",
      mode: "120000",
      contentSha256: sha256Hex(Buffer.from(target, "utf8")),
    };
  }

  if (stat.isDirectory()) {
    return { exists: true, type: "directory", mode: "040000" };
  }

  if (stat.isFile()) {
    let bytes: Buffer;
    try {
      bytes = await readFileFn(absolutePath);
    } catch (err) {
      // İzin/IO/... → özet verilemez → fail-closed (partial fingerprint YASAK).
      throw new StrictReadError(err);
    }
    const executable = (stat.mode & 0o100) !== 0;
    return {
      exists: true,
      type: "file",
      mode: executable ? "100755" : "100644",
      contentSha256: sha256Hex(bytes),
    };
  }

  return { exists: true, type: "other", mode: "other" };
}

/**
 * Bir yolun ANLIK VARLIĞINI doğrular — STRICT (Step 9 worker-oluşturulan
 * yol çakışması, spec 171/266). İçerik ASLA okunmaz: main'de bağımsız olarak
 * var olması YETMEZ değil — VAR OLMASI (içerik ne olursa) stale üretir;
 * yalnız varlık/tip sorulur, bayt okunmaz (spec 171: "existence alone is
 * enough"). Hata sözleşmesi `captureStrictLiveFingerprint` ile aynıdır:
 * `ENOENT` → `false`; başka `lstat` hatası → `StrictReadError` (fail-closed).
 */
export async function captureStrictLiveExistence(
  absolutePath: string,
  seams: StrictReadSeams = {},
): Promise<boolean> {
  const lstatFn = seams.lstat ?? lstat;
  try {
    await lstatFn(absolutePath);
    return true;
  } catch (err) {
    if (!errnoIs(err, "ENOENT")) {
      throw new StrictReadError(err);
    }
    return false;
  }
}
