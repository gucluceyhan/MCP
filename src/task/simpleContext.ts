/**
 * Step 6: basit (simple) düzenlenebilir-taban bağlamı (DESIGN.md §5/7.5, 11 madde 6).
 *
 * Step 6'nın TEK bağlam katmanıdır — Step 7 bunu gerçek Context Assembler'la
 * (adaptif bütçe, redaksiyon, tam tokenize, tier seçimi, `needs_split`)
 * değiştirir; bu dosya o zamana kadar geçici katmandır.
 *
 * Invariantlar (Step 6 spec 17-25):
 * - Okuma YALNIZCA workspace dizininden (`workspace.workspaceDir`) yapılır —
 *   canlı ana checkout'tan değil: model bağlamı == immutable base.
 * - İçerik TAMAMEN `workspace.editablePaths`'tir (lexicographic sıralı);
 *   repository crawl YOK (package.json/README/CLAUDE.md/AGENTS.md — yok).
 * - Düzenli dosya: birebir baytlar; STRICT UTF-8 round-trip. Normalizasyon
 *   YOK (CRLF/LF, tab, trailing boşluk, son newline aynen).
 *   Geçersiz UTF-8 (binary) → ikame karakteriyle decode YOK; deterministik
 *   metadata marker (base64/hex yok) — worker modify edemez, delete edebilir.
 * - Sembolik bağlantı: ASLA takip edilmez (`lstat`/`readlink`); hedef
 *   içeriği okunmaz; link'in kendisinin metadata'sı verilir.
 * - Tabanda yok: açık ABSENT marker (yok ≠ boş; worker `create` kullanabilir).
 * - Redaksiyon (Step 7) ve kurallar (Step 8) YOK; salt-okunur referans YOK.
 */

import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "../workspace/Workspace.js";

/** Düzenli dosya içeriğinin marker'ı (blok başlık/sonu arasındaki içerik). */
export const BINARY_CONTENT_MARKER =
  "[BINARY CONTENT OMITTED: modify is unsupported; delete remains possible.]";
/** Sembolik bağlantı metadata'sının öneki (hedef metni takip edilmez). */
export const SYMLINK_MARKER_PREFIX = "[SYMLINK -> ";
/** Tabanda var olmayan seçili yol (worker `create` kullanabilir). */
export const ABSENT_MARKER = "[ABSENT IN IMMUTABLE BASE]";
/**
 * Savunmacı marker: base'te temsil edilemeyen tip (dizin/özel nesne).
 * Oluşturmaca seçili yolların dosya-benzeri olduğunu zaten doğruladığı için
 * pratikte ulaşılmaz; yine de içeriğe değil metaya düşer.
 */
export const NOT_REPRESENTABLE_MARKER = "[NOT REPRESENTABLE IN IMMUTABLE BASE]";

/**
 * Seçili yolların exact taban içeriğini worker'a gidecek deterministik bir
 * bağlam bloğuna çevirir (saf string üretimi; tek I/O = workspace dosyaları).
 *
 * Blok formatı (birebir):
 *   `===== EDITABLE BASE: <yol> =====\n<içerik>
===== END EDITABLE BASE: <yol> =====`
 * Bloklar tek boş satırla ayrılır; `editablePaths` BOŞSA sonuç BOŞ stringtir
 * (Worker Contract bu durumda REPOSITORY CONTEXT bölümünü koymaz).
 */
export async function buildSimpleEditableContext(
  workspaceDir: string,
  editablePaths: readonly string[],
): Promise<string> {
  // Deterministik sıra (spec 19): lexiconographic; dosya sistemi
  // dizin sayımı (readdir) BAŞVURULMAZ.
  const ordered = [...editablePaths].sort();
  const blocks: string[] = [];
  for (const canonical of ordered) {
    blocks.push(await buildBlock(workspaceDir, canonical));
  }
  return blocks.join("\n\n");
}

/** Tek bir seçili yolun bağlam bloğu. */
async function buildBlock(workspaceDir: string, canonical: string): Promise<string> {
  const abs = path.resolve(workspaceDir, canonical);
  // Containment (savunmacı): workspace manager yolun zaten normalize olduğunu
  // garanti eder; yine de kökten kaçış imkânsız olmalı.
  const rel = path.relative(workspaceDir, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WorkspaceError("unsafe_path", "A selected path is unsafe");
  }

  let body: string;
  let stat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    stat = await lstat(abs);
  } catch {
    stat = null; // var değil → ABSENT (spec 24)
  }

  if (stat === null) {
    body = ABSENT_MARKER;
  } else if (stat.isSymbolicLink()) {
    // Link TAKİP EDİLMEZ (spec 23): hedef metin `readlink`'tan; hedef dosya
    // içeriği ASLA okunmaz.
    let target: string;
    try {
      target = await readlink(abs);
    } catch {
      // lstat "link" dedi, readlink okuyamadı (race/izin) — içerik vermeden
      // metadata (hedef bilinmiyor; worker yine de delete edebilir).
      target = "<unreadable>";
    }
    body = `${SYMLINK_MARKER_PREFIX}${target}]`;
  } else if (stat.isFile()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      // Base'te var ama okunamıyor (race/izin): bağlam güvenli temsil
      // edilemez — tip'li işletimsel hata (içerik/çözüm YOK, mesaj SABİТ).
      throw new WorkspaceError("workspace_operation_failed", "Reading the editable base failed");
    }
    // Strict UTF-8 round-trip (spec 21/22): decode → re-encode → karşıla.
    // Node'un utf8 decoder'ı geçersiz baytları U+FFFD ile değiştirir; round-trip
    // uyumsuzluğu geçersiz diziyi yakalar. Geçerli dosyada içerik BİREBİRDİR
    // (CRLF/tab/trailing boşluk/son newline aynen).
    body = isStrictUtf8(bytes) ? bytes.toString("utf8") : BINARY_CONTENT_MARKER;
  } else {
    // Dizin/FIFO/socket/cihaz — oluşturmaca bunları zaten reddederdi;
    // savunmacı metadata (içerik ASLA yok).
    body = NOT_REPRESENTABLE_MARKER;
  }

  return `===== EDITABLE BASE: ${canonical} =====\n${body}\n===== END EDITABLE BASE: ${canonical} =====`;
}

/** `bytes` strict UTF-8 olarak round-trip ediyor mu? (saf, bayt-tam.) */
function isStrictUtf8(bytes: Buffer): boolean {
  return bytes.equals(Buffer.from(bytes.toString("utf8"), "utf8"));
}
