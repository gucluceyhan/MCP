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
 *    çevirir — Step 9'un stale-base denetimi bu yardımcıyı kullanacak
 *    (ana working-tree'deki canlı durum ↔ immutable base parmak izi —
 *    PR #24'tan itibaren base YENİDEN aynı alandan yakalandığı için iki
 *    taraf aynı ölçekte karşılaştırılır). Step 5 karşılaştırma/MANTIĞI
 *    YAPMAZ; yalnızca yeniden kullanılabilir yakalama sağlar (spec 31:
 *    "Do NOT implement stale comparison yet").
 *
 * Sembolik bağlantılar ASLA takip edilmez: link'in parmak izi = hedef metin.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
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
 * Bir yolun ANLIK durumunu `PathFingerprint`'e çevirir (Step 9 için
 * yeniden kullanılabilir yardımcı — spec 31).
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
