/**
 * Step 5: yol + oturum kimliği güvenliği (Step 5 spec 12, 13, 14).
 *
 * TEK merkezi güvenlik noktası: tüm workspace dosya yolları ve diff filtreleri
 * bu dosyadaki fonksiyonlarla geçer. `path.join(root, userPath)` ASLA güvenlik
 * denetimi olarak KULLANILMAZ — normalize + containment (içerme) doğrulaması
 * yapılır (spec 13).
 *
 * Reddedilen formlar (spec 13/14, her platformda — POSIX üzerinde
 * Windows-formları DAHİL):
 * - boş string, `.` tek başına
 * - mutlak POSIX yol (`/absolute/path.ts`)
 * - Windows sürücülü mutlak (`C:\outside\file.ts`, `C:/x.ts`) ve UNC (`\\srv\share`)
 * - `..` bileşeni (`../outside.ts`, `foo/../../bar`) — backslash AYRICA
 *   tamamen reddedilir (POSIX'te backslash dosya adı olabilir; v1'de
 *   belgelenen güvenlik tercihi: kabul edilmez)
 * - `.git` bileşeni (`.git`, `.git/config`, `foo/.git/index`) — git yönetim
 *   alanına hiçbir worker işleminin temas etmesi mümkün değil (spec 14)
 * - NUL içeren string
 *
 * Normalize edilen formlar (güvenli): `.` bileşenleri, çift slash, sonda
 * slash — `src/./foo.ts` ≡ `src/foo.ts` (alias, spec 46).
 */

import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";

/** `err` bir `NodeJS.ErrnoException` ve `code` verilen errno'ya eşit mi? */
function errnoIs(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/** Windows sürücülü mutlak: `C:\x`, `C:/x` (tek karakter sürücü). */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** Windows sürücü-göreceli: `C:foo` (mevcut dizin C:). */
const WINDOWS_DRIVE_RELO = /^[A-Za-z]:[^\\/]/;
/** UNC paylaşım: `\\server\share`. */
const UNC = /^\\\\/;

/**
 * Repository-göreceli yolu kanonik forma normalize eder; GÜVENLİ değilse
 * `null` döner (çağrı tarafı `unsafe_path` ile reddeder).
 *
 * Dönen dize: slash-bölümlü, `.`/`..`/`.git` bileşensiz, boş olmayan,
 * mutlak olmayan bir repository-göreceli yol.
 *
 * NOT: bu fonksiyon git pathspec magic karakterlerini (`* ? [ ] ( ) : ! @`)
 * reddetmez — meşru dosya adları bunları içerebilir. Yol dizgeleri git
 * pathspec argv'si olarak girdiğinde `:(literal)` pin'i magic'i
 * neutralize eder; pin `git.ts`'teki `literalPathspec`'ta uygulanır
 * (audit CRITICAL-1; DESIGN 7.4 m.3).
 */
export function normalizeRepoPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (raw.includes("\0")) {
    return null;
  }
  // Backslash: Windows ayraç formu — v1'de her yerde reddedilir
  // (POSIX'te literal backslash dosya adı; güvenlik tercihi: yok).
  if (raw.includes("\\")) {
    return null;
  }
  // Mutlak formlar (POSIX + Windows; POSIX üzerinde de savunulur — spec 13).
  if (raw.startsWith("/") || WINDOWS_DRIVE.test(raw) || WINDOWS_DRIVE_RELO.test(raw) || UNC.test(raw)) {
    return null;
  }

  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return null;
    }
    // Git yönetim alanı ASLA hedef olamaz (spec 14) — her konumda, her
    // işlemde. BÜYÜK/KÜÇÜK harf duyarsız: case-insensitive dosya sistemlerinde
    // (macOS APFS, Windows NTFS) `.GIT`/`.Git` gerçek `.git`'e çözümlenir —
    // git metadata'sı bağlama ASLA sızdırılmaz (fail-safe: aşırı ret kabul).
    if (segment.toLowerCase() === ".git") {
      return null;
    }
  }

  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (normalized === "" || normalized === "." || normalized === "..") {
    return null;
  }
  return normalized;
}

/**
 * Güvenli git-tree yoluna YAPISEL doğrulama (Step 9 audit düzeltme A):
 * tam git ağacından KENDİ tarafından yakalanan (self-captured) yollar —
 * `workspaceRecovery.basePaths` (tam `git ls-tree -r -z` haritası) ve
 * `immutableBaseEntries`'in `path` alanları — kullanıcı/worker GİRDİSİ
 * değildir; bunlar için KÜME (character-set) doğrulaması DEĞİL, yapısal
 * doğrulama uygulanır.
 *
 * Gerekçe: `normalizeRepoPath` seçili/worker (güvenilmez) yolları için doğru
 * katkisız kuraldır, ama karakter-kümesi kuralı (backslash'ı her yerde
 * reddetme) POSIX'te backslash'li bir adı takip EDEN dürüst repository'ların
 * oturumlarını kalıcı olarak yüklenemez (`session_corrupt`) yapardı — git,
 * POSIX'te backslash'li dosya adlarını takip edebilir (ölçüldü: `ls-tree`
 * aynen basar, `mktree` birebir aynı `tree` SHA'sını yeniden kurar).
 *
 * Yapısal kural yalnızca repository dışına kaçış ya da git yönetim alanına
 * müdahale potansiyeli taşıyan formları reddeder:
 * - boş string, NUL byte
 * - mutlak yol — platform mutlak formu (`path.isAbsolute`: POSIX `/...`;
 *   Windows `X:\...` / `X:/...` / UNC) + her platformda POSIX `/...` formu
 *   (Windows'ta sürücü-kökü göreceli çözümlenir = workspace dışı). NOT:
 *   POSIX'te `C:\foo` gibi bir dize YASAL bir dosya adındır (backslash =
 *   normal karakter) — mutlak DEĞİLDİR, kabul edilir. (`normalizeRepoPath`'ın
 *   platform-bağımsız red kuralı GÜVENİLMEZ girdi güvenliği içindir; bu
 *   yapısal kural KENDİ-agacı güvenliği içindir — iki güven alanı.)
 * - `..` yolu bileşeni (repository dışı kaçış; tam bileşen eşleşmesi)
 * - `.git` yolu bileşeni (tam, BÜYÜK/KÜÇÜK harf DUYARLI — tam yönetim alanı
 *   adı; bir bileşenin İÇİNDE backslash ya da başka dosya-adı karakteri
 *   taşıması RED sebebi DEĞİLDİR. `normalizeRepoPath`'ın duyarsız kuralı
 *   güvenilmez girdi için fail-safe aşırı rettir; kendi-agaç verisinde bir
 *   `.GIT` dosyası yasal bir POSIX adıdır ve downstream'da (validate.ts)
 *   asla canonical worker yoluyla eşleşemez → fail-closed korunur)
 *
 * Geri kalan formlar (örn. `.`/boş bileşen alias'ları, backslash'li adlar)
 * yapısal olarak güvendedir: kaçış imkânsızdır; downstream'da canonical
 * (normalize) worker yollarıyla eşleşemez, `mktree` ad kuralı slash'li
 * tek-adı reddeder (ölçüldü) → her tüketim fail-closed. Değer AYNEN kabul
 * edilir — alias normalizasyonu YOK (sessiz yeniden yazım fail-closed
 * disiplinine aykırıdır).
 */
export function isTrustedTreePath(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) {
    return false;
  }
  if (raw.includes("\0")) {
    return false;
  }
  if (path.isAbsolute(raw) || raw.startsWith("/")) {
    return false;
  }
  for (const segment of raw.split("/")) {
    if (segment === "..") {
      return false;
    }
    if (segment === ".git") {
      return false;
    }
  }
  return true;
}

/**
 * Oturum kimliği güvenliği (spec 12): kimlik ileride base commit mesajı,
 * patch dosya adı ve workspace metadata'sı olarak kullanılır —
 * dizinden kaçışa izin veren hiçbir form kabul edilmez, SESSİZCE yeniden
 * yazılmaz (girdi geçersizdir).
 *
 * Red: boş; `.`; `..`; `/` veya `\` içeren; NUL/kontrol karakteri içeren;
 * her platform dosya sisteminde riskli karakterler (`* : ? " < > |`);
 * 200 karakteri aşan.
 */
export function isSafeSessionId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    return false;
  }
  if (id === "." || id === "..") {
    return false;
  }
  for (const ch of id) {
    const code = ch.codePointAt(0);
    if (code === undefined) {
      return false;
    }
    // Kontrol karakterleri (NUL, yeni satır, geri dönüş, ESC...).
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  if (id.includes("/") || id.includes("\\")) {
    return false;
  }
  if (/[*:?"<>|]/.test(id)) {
    return false;
  }
  return true;
}

/** `candidate` (mutlak) `root` (mutlak) İÇİNDE mi? (kök kendisi dahil değil.) */
export function isPathInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return false;
  }
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `candidate` `root` içinde mi ya da kökün kendisi mi? */
export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * `target`'ın (mutlak) kanonik halini üretir ve `root` İÇİNDE ise `null`
 * döner — workspaceDir / exportRoot "repo dışında" denetimi (spec 10, 69).
 *
 * Henüz var olmayan dizinler için: derin VAR OLAN atal dizin `realpath` ile
 * kanonikleştirilir, geri kalan sözdizimsel olarak eklenir — böylece
 * basit sembolik-bağlantı kaçışları (`/tmp/link → repo`) by-pass olamaz
 * (spec 10).
 *
 * Dönen değer: mutlak, kanonik aday yol (var olmayabilir — yaratılacak).
 */
export async function canonicalizeOutside(target: string, root: string): Promise<string | null> {
  // Kök de kanonik (realpath) çözülmeli: macOS'ta `/var` → `/private/var`
  // gibi sembolik bağlantılar sayesinde sözdizimsel kök ile gerçek kök AYNI
  // dizin değil gibi görünürdü ve iç-çerme denetimi boşa düşerdi.
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    // Kök henüz var değil (ilk kurulum) → sözdizisel formla yetin.
    resolvedRoot = path.resolve(root);
  }
  const resolved = path.resolve(target);

  const suffix: string[] = [];
  let probe = resolved;
  for (;;) {
    try {
      const real = await realpath(probe);
      const candidate = suffix.length === 0 ? real : path.join(real, ...suffix);
      if (candidate === resolvedRoot || isPathInside(resolvedRoot, candidate)) {
        return null;
      }
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // ELOOP (bağlantı döngüsü) / erişim: kanonik form belirlenemez →
        // belirsizlikte REDDET (güvenli taraf).
        // ENOENT/ENOTDIR → tırmanmaya devam: en derin VAR OLAN atal
        // kanonikleştirilir (atal bir DOSYA ise yol yine de "repo dışında"
        // olarak kararlanır; gerçek imkânsızlık git adımında `git
        // worktree add` hatasıyla güvenli biçimde yüzeye çıkar).
        return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Dosya sistemi köküne kadar tırmandık; hiçbir atal var değil
        // (pratikte imkânsız) — sözdizimsel forma dön.
        const candidate = suffix.length === 0 ? resolved : path.join(resolved, ...suffix);
        if (candidate === resolvedRoot || isPathInside(resolvedRoot, candidate)) {
          return null;
        }
        return candidate;
      }
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Normalize edilmiş repository-göreceli yolu workspace kökü altında
 * mutlak yola çözer ve İçERMEYİ doğrular (spec 13: "Resolve and verify
 * containment"). Containment ihlali → `null`.
 */
export function resolveContained(root: string, canonical: string): string | null {
  const abs = path.resolve(root, canonical);
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/**
 * Seçilen sembolik bağlantının hedefi repository İÇİNDE kalıyor mu?
 * (spec 50: mutlak dış hedefler host dosyalarını okuma/taşıma kanalı olamaz.)
 * Hedef zincir çözülebildiyse `realpath`, çözülmezse (kırık link)
 * sözdizimsel çözüm kullanılır; ikisi de kök dışına düşüyorsa red.
 *
 * `resolveFn` (varsayılan: `node:fs/promises.realpath`) Context Assembler'ın
 * test enjeksiyonu (`ContextFs`) ile aynı dikişten geçebilir — daha zayıf
 * bir ikinci çözümleyici ikame edilmez.
 */
export async function symlinkTargetStaysInside(
  repoRoot: string,
  linkAbs: string,
  target: string,
  resolveFn: (target: string) => Promise<string> = realpath,
  failClosedOnResolveError = false,
): Promise<boolean> {
  const lexical = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(linkAbs), target);
  try {
    const resolved = await resolveFn(lexical);
    return isPathInsideOrEqual(repoRoot, resolved);
  } catch (err) {
    // Kırık hedef (ENOENT) → sözdizimsel çözüm meşru (metadata raporlanır).
    // Beklenmedik I/O (EACCES/EPERM/EIO/ELOOP) fail-closed: içerme
    // belirlenemedi → REDDET (kaynağı takip edip okuyamayız).
    if (failClosedOnResolveError && !errnoIs(err, "ENOENT")) {
      return false;
    }
    return isPathInsideOrEqual(repoRoot, lexical);
  }
}

/**
 * `absolute` yolun `root` altındaki bileşenleri arasında sembolik bağlantı
 * var mı? (v1 yazma güvenliği, spec 48: worker yazıları ASLA sembolik
 * bağlantı bileşeni üzerinden ilerlemez — workspace İÇİNE bağlanan bir
 * bağlantı bile kabul edilmez; allow-list by-pass'ı olamaz.)
 *
 * `includeTarget: false` ise hedef kendisi denetlenmez (delete: hedefin
 * sembolik bağlantı olması meşrudur — link'in kendisi kaldırılır).
 * Eksik (var olmayan) atal bileşenlerde denetim orada durur.
 *
 * `lstatFn` (varsayılan: `node:fs/promises.lstat`) — Context Assembler'ın
 * read-only yol denetimleri test arızaları enjekte edebilsin diye aynı
 * dikişten geçer; production davranış birebir node:fs'tir.
 */
export async function hasSymlinkInPath(
  absolute: string,
  root: string,
  options: {
    includeTarget: boolean;
    lstatFn?: (target: string) => Promise<Stats>;
    /**
     * `true` (Context Assembler live read sınırı): atal `lstat`'ta ENOENT/
     * ENOTDIR DIŞINDAKI I/O hatası (EACCES/EPERM/EIO/ELOOP) "sembolik
     * bağlantı yok" olarak YORUMLANMAZ — hata ATILIR (çağrı tarafı
     * `assembly_failed` yapar). ENOTDIR = önekteki bir bileşen dizin değil
     * (ör. bir dosya) → gerisi VAR OLAMAZ (kesin yokluk, ENOENT gibi) →
     * denetim orada durur; sonraki okuma aynı yokluğu kendi sözleşmesiyle
     * (ENOENT/ENOTDIR) yeniden görür.
     * `false`/verilmezse: atal var değil → denetim orada durar (Step 5).
     */
    failClosed?: boolean;
  } = { includeTarget: true },
): Promise<boolean> {
  const rel = path.relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return true; // containment ihlali — güvenli taraf: "var" de.
  }
  const segments = rel.split(path.sep).filter((segment) => segment !== "");
  const limit = options.includeTarget ? segments.length : Math.max(0, segments.length - 1);
  const probe = options.lstatFn ?? lstat;
  const failClosed = options.failClosed === true;

  let current = root;
  for (let i = 0; i < limit; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      break;
    }
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await probe(current);
    } catch (err) {
      if (failClosed && !errnoIs(err, "ENOENT") && !errnoIs(err, "ENOTDIR")) {
        throw err; // Belirsiz I/O → fail-closed (güvenli taraf).
      }
      // Atal var değil (ENOENT) / önekteki bileşen dizin değil (ENOTDIR)
      // veya legacy → gerisi var olamaz.
      break;
    }
    if (stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}
