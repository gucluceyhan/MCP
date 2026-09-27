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
    // Git yönetim alanı ASLA hedef olamaz (spec 14) — her konumda, her işlemdede.
    if (segment === ".git") {
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
 * `absolute` yolun `root` altındaki bileşenleri arasında sembolik bağlantı
 * var mı? (v1 yazma güvenliği, spec 48: worker yazıları ASLA sembolik
 * bağlantı bileşeni üzerinden ilerlemez — workspace İÇİNE bağlanan bir
 * bağlantı bile kabul edilmez; allow-list by-pass'ı olamaz.)
 *
 * `includeTarget: false` ise hedef kendisi denetlenmez (delete: hedefin
 * sembolik bağlantı olması meşrudur — link'in kendisi kaldırılır).
 * Eksik (var olmayan) atal bileşenlerde denetim orada durur.
 */
export async function hasSymlinkInPath(
  absolute: string,
  root: string,
  options: { includeTarget: boolean } = { includeTarget: true },
): Promise<boolean> {
  const rel = path.relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return true; // containment ihlali — güvenli taraf: "var" de.
  }
  const segments = rel.split(path.sep).filter((segment) => segment !== "");
  const limit = options.includeTarget ? segments.length : Math.max(0, segments.length - 1);

  let current = root;
  for (let i = 0; i < limit; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      break;
    }
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch {
      break; // Atal var değil → gerisi de var olamaz.
    }
    if (stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}
