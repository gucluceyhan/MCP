/**
 * Step 5: yol/oturum-kimliği güvenliği testleri (`src/workspace/pathSafety.ts`).
 *
 * Çiviler (Step 5 spec 12/13/14, 79): normalize + containment, Windows-form
 * savunması (POSIX üzerinde), `.git` yasağı, session id güvenliği,
 * workspaceDir "repo dışı" kanonik denetimi (sembolik-bağlantı by-pass'ı
 * dahil) ve sembolik-bağlantı bileşeni tespiti.
 *
 * Testler BUILT çıktıyı (dist/) import eder (package.json pretest).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeOutside,
  hasSymlinkInPath,
  isPathInside,
  isSafeSessionId,
  isTrustedTreePath,
  normalizeRepoPath,
  resolveContained,
} from "../dist/workspace/pathSafety.js";

// ── normalizeRepoPath ───────────────────────────────────────────────────────

test("normalizeRepoPath: ordinary relative paths canonicalize to themselves", () => {
  assert.equal(normalizeRepoPath("src/foo.ts"), "src/foo.ts");
  assert.equal(normalizeRepoPath("foo/bar/baz.txt"), "foo/bar/baz.txt");
});

test("normalizeRepoPath: dot segments / duplicate slashes / trailing slash collapse (alias, spec 46)", () => {
  assert.equal(normalizeRepoPath("src/./foo.ts"), "src/foo.ts");
  assert.equal(normalizeRepoPath("src//foo.ts"), "src/foo.ts");
  assert.equal(normalizeRepoPath("./src/foo.ts"), "src/foo.ts");
  assert.equal(normalizeRepoPath("src/foo.ts/"), "src/foo.ts");
});

test("normalizeRepoPath: dots inside a segment name are not traversal", () => {
  assert.equal(normalizeRepoPath("a..b/c..d.ts"), "a..b/c..d.ts");
});

test("normalizeRepoPath: rejects ../ escapes (spec 79)", () => {
  assert.equal(normalizeRepoPath("../outside.ts"), null);
  assert.equal(normalizeRepoPath("foo/../../outside.ts"), null);
  assert.equal(normalizeRepoPath("a/b/../../../x"), null);
  assert.equal(normalizeRepoPath(".."), null);
});

test("normalizeRepoPath: rejects absolute paths (POSIX + Windows forms, on POSIX — spec 13/79)", () => {
  assert.equal(normalizeRepoPath("/absolute/path.ts"), null);
  assert.equal(normalizeRepoPath("C:\\outside\\file.ts"), null);
  assert.equal(normalizeRepoPath("C:/outside/file.ts"), null);
  assert.equal(normalizeRepoPath("C:outside.ts"), null);
  assert.equal(normalizeRepoPath("\\\\server\\share\\file.ts"), null);
  assert.equal(normalizeRepoPath("..\\outside.ts"), null);
});

test("normalizeRepoPath: rejects .git in ANY component (spec 14)", () => {
  assert.equal(normalizeRepoPath(".git"), null);
  assert.equal(normalizeRepoPath(".git/config"), null);
  assert.equal(normalizeRepoPath("foo/.git/index"), null);
  assert.equal(normalizeRepoPath("foo/.git/../../x"), null);
});

test("normalizeRepoPath: rejects .git case-insensitively (case-variant dirs, spec 14)", () => {
  // case-insensitive dosya sistemlerinde (macOS APFS, Windows NTFS) `.GIT`
  // gerçek `.git`'e çözümlenir — git metadata'sı bağlama sızdırılmaz:
  assert.equal(normalizeRepoPath(".GIT"), null);
  assert.equal(normalizeRepoPath(".GIT/config"), null);
  assert.equal(normalizeRepoPath(".Git/config"), null);
  assert.equal(normalizeRepoPath(".gIT/HEAD"), null);
  assert.equal(normalizeRepoPath("src/.GIT/config"), null);
  assert.equal(normalizeRepoPath("foo/.Git"), null);
});

test("normalizeRepoPath: rejects empty / bare-dot / NUL", () => {
  assert.equal(normalizeRepoPath(""), null);
  assert.equal(normalizeRepoPath("."), null);
  assert.equal(normalizeRepoPath("a\0b.ts"), null);
  assert.equal(normalizeRepoPath("//"), null);
});

// ── isTrustedTreePath (Step 9 audit düzeltme A — güvenli/self-captured alan) ──
//
// Güvenli (git'in KENDİ ürettiği) ağaç yolları için YAPISEL kural — seçili/
// worker (güvenilmez) yolların karakter-kümesi kuralı (`normalizeRepoPath`)
// ile AYNI DEĞİLDİR. İki güven alanı:
// - red (platform-bağımsız): boş, NUL, mutlak, `..` bileşeni, TAM `.git`
//   bileşeni (büyük/küçük harf duyARLI — case varyantı yasal POSIX adıdır;
//   downstream'da canonical worker yoluyla eşleşemez → fail-closed);
// - kabul: backslash'li ad (POSIX'te yasal dosya adı), `.`/çift-slash
//   alias'ları, `:` içeren ad, case-varyant `.git`.

test("isTrustedTreePath: ordinary + alias + exotic-but-legal names are accepted", () => {
  assert.equal(isTrustedTreePath("src/a.ts"), true);
  assert.equal(isTrustedTreePath("a//b.ts"), true); // çift-slash alias — kaçış yok
  assert.equal(isTrustedTreePath("a/./b.ts"), true); // nokta bileşeni — kaçış yok
  assert.equal(isTrustedTreePath("a..b/c.ts"), true); // noktalar adın İÇİNDE — traversal değil
  assert.equal(isTrustedTreePath("a\\b.ts"), true); // backslash'li AD — POSIX'te yasal dosya adı
  assert.equal(isTrustedTreePath("src/weird\\name.ts"), true); // dürüst-repo senaryosu (audit A)
  assert.equal(isTrustedTreePath(".gitignore"), true); // `.git` PREFIX'i — tam bileşen EŞLEŞMESİ değil
  assert.equal(isTrustedTreePath("git.txt"), true);
});

test("isTrustedTreePath: .git case variants are legal names (exact, case-SENSITIVE match)", () => {
  // `normalizeRepoPath`'ın duyARSIZ kuralı güvenilmez girdi için fail-safe
  // aşırı redtir; kendi-ağaç verisinde `.GIT` yasal bir POSIX adıdır.
  assert.equal(isTrustedTreePath(".GIT"), true);
  assert.equal(isTrustedTreePath("src/.Git/config"), true);
});

test("isTrustedTreePath: colon-in-name is accepted on every platform (no separator semantics)", () => {
  // `C:foo.ts` POSIX'te düz bir dosya adıdır; Windows'ta drive-göreceli
  // ÇÖZÜMLEME potansiyeli taşır AMA hiçbir tüketim noktasında yol olarak
  // çözülmez: canonical (slash-only, `:`'siz) worker yollarıyla eşleşemez,
  // `mktree` adında `:` kabul eder → red YAPMAZSA dürüst (Windows'ta `C:`
  // adlı dosyaları takip eden) repository'ların oturumları bozulurdu.
  assert.equal(isTrustedTreePath("C:foo.ts"), true);
  assert.equal(isTrustedTreePath("src/file:name.ts"), true);
});

test("isTrustedTreePath: escape / management-area forms are rejected", () => {
  assert.equal(isTrustedTreePath(""), false); // boş
  assert.equal(isTrustedTreePath("a\0b.ts"), false); // NUL
  assert.equal(isTrustedTreePath("/absolute/evil.ts"), false); // mutlak POSIX (her platformda)
  assert.equal(isTrustedTreePath(".."), false); // bare traversal
  assert.equal(isTrustedTreePath("../evil.ts"), false);
  assert.equal(isTrustedTreePath("a/../b.ts"), false); // ortadaki `..` bileşeni
  assert.equal(isTrustedTreePath(".git"), false); // TAM yönetim alanı adı
  assert.equal(isTrustedTreePath(".git/config"), false);
  assert.equal(isTrustedTreePath("a/.git"), false);
  assert.equal(isTrustedTreePath("a/.git/b"), false);
});

test("isTrustedTreePath: platform-absolute forms (Windows forms are platform-aware)", () => {
  if (process.platform === "win32") {
    // Windows: sürücülü mutlak + UNC platform mutlak formu → red.
    assert.equal(isTrustedTreePath("C:\\evil.ts"), false);
    assert.equal(isTrustedTreePath("C:/evil.ts"), false);
    assert.equal(isTrustedTreePath("\\\\server\\share\\evil.ts"), false);
  } else {
    // POSIX: `C:\foo` gibi dizeler YASAL DOSYA ADIDIR (backslash = normal
    // karakter) — mutlak DEĞİLDİR, kabul (bkz. `normalizeRepoPath` farkı).
    assert.equal(isTrustedTreePath("C:\\evil.ts"), true);
    // `C:/evil.ts` POSIX'te `C:` + `evil.ts` segmentlerine bölünür — ikisi de
    // düz ad, göreceli yol asla mutlak olamaz → kabul.
    assert.equal(isTrustedTreePath("C:/evil.ts"), true);
    assert.equal(isTrustedTreePath("\\\\server\\share\\evil.ts"), true);
  }
  // Her platformda: `/` ile başlayan form mutlak → red.
  assert.equal(isTrustedTreePath("/evil.ts"), false);
});

// ── isSafeSessionId ─────────────────────────────────────────────────────────

test("isSafeSessionId: ordinary opaque ids are accepted", () => {
  assert.equal(isSafeSessionId("abc-123"), true);
  assert.equal(isSafeSessionId("a..b"), true);
  assert.equal(isSafeSessionId("a.b_c"), true);
  assert.equal(isSafeSessionId("s-20260924-0001"), true);
});

test("isSafeSessionId: rejects empty / dot / traversal / separators / controls (spec 12)", () => {
  assert.equal(isSafeSessionId(""), false);
  assert.equal(isSafeSessionId("."), false);
  assert.equal(isSafeSessionId(".."), false);
  assert.equal(isSafeSessionId("a/b"), false);
  assert.equal(isSafeSessionId("a\\b"), false);
  assert.equal(isSafeSessionId("a\0b"), false);
  assert.equal(isSafeSessionId("a\nb"), false);
  assert.equal(isSafeSessionId("a\r\nb"), false);
  assert.equal(isSafeSessionId("a:colon"), false);
  assert.equal(isSafeSessionId("a?quest"), false);
});

test("isSafeSessionId: rejects over-long identifiers", () => {
  assert.equal(isSafeSessionId("a".repeat(201)), false);
  assert.equal(isSafeSessionId("a".repeat(200)), true);
});

// ── isPathInside / resolveContained ─────────────────────────────────────────

test("isPathInside: containment semantics", () => {
  assert.equal(isPathInside("/repo", "/repo/sub/file"), true);
  assert.equal(isPathInside("/repo", "/repo2/file"), false);
  assert.equal(isPathInside("/repo", "/repo"), false); // kök kendisi "içeride" değil
  assert.equal(isPathInside("/repo", "/other"), false);
});

test("resolveContained: normalized relative paths resolve inside; traversal resolves null", () => {
  assert.equal(resolveContained("/repo", "src/a.ts"), "/repo/src/a.ts");
  assert.equal(resolveContained("/repo", "../x"), null);
  assert.equal(resolveContained("/repo", "/abs"), null);
});

// ── canonicalizeOutside (workspaceDir / exportRoot denetimi) ────────────────

test("canonicalizeOutside: a directory outside the repo is accepted (created canonically)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    // macOS: os.tmpdir() `/var/folders/...` bir sembolik bağlantıdır; fonksiyon
    // KANONİK (realpath) formu döndürür — beklenti de realpath üzerinden kurulur.
    const realTmp = await realpath(tmp);
    const repo = path.join(tmp, "repo");
    const ws = path.join(tmp, "ws");
    await mkdir(repo, { recursive: true });
    const expected = path.join(realTmp, "ws");

    // var olmayan dizin: atal (tmp) realpath'lenir
    assert.equal(await canonicalizeOutside(ws, repo), expected);
    // repo dışındaki var dizin
    await mkdir(ws);
    assert.equal(await canonicalizeOutside(ws, repo), expected);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("canonicalizeOutside: repoRoot itself and anything inside the repo are rejected (spec 10)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    await mkdir(path.join(repo, ".splash"));

    assert.equal(await canonicalizeOutside(repo, repo), null);
    assert.equal(await canonicalizeOutside(path.join(repo, ".splash"), repo), null);
    assert.equal(await canonicalizeOutside(path.join(repo, ".git"), repo), null);
    // lexical: /repo/subdir/../ws → /repo/ws (repo İÇİ) → red
    assert.equal(await canonicalizeOutside(path.join(repo, "subdir", "..", "ws"), repo), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("canonicalizeOutside: symlink-escape is not a bypass (spec 10 — canonical parent resolution)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    // /tmp/.../link → repo ; workspaceDir = link/ws → kanonik olarak repo/ws (İÇİ) → red
    const link = path.join(tmp, "link");
    await symlink(repo, link);

    const viaSymlink = path.join(link, "ws");
    assert.equal(await canonicalizeOutside(viaSymlink, repo), null);

    // realpath'lenmiş repo yoluyla aynı karar (kök kanonik form fark etmez)
    const { realpath } = await import("node:fs/promises");
    const realRepo = await realpath(repo);
    assert.equal(await canonicalizeOutside(viaSymlink, realRepo), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ── hasSymlinkInPath ─────────────────────────────────────────────────────────

test("hasSymlinkInPath: reports symlink directory components (v1 write-safety, spec 48)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    const root = path.join(tmp, "ws");
    await mkdir(path.join(root, "real"), { recursive: true });
    await symlink(path.join(tmp, "outside"), path.join(root, "link")); // dışa bağırlı (ama var olmayan) link

    // Temiz yol: atal gerçek dizin, hedef var değil (create'nin normal hali) → false
    assert.equal(await hasSymlinkInPath(path.join(root, "real", "f.txt"), root), false);
    // Ortada eksik bileşen → yürüyüş durur, false pozitif YOK
    assert.equal(await hasSymlinkInPath(path.join(root, "real", "sub", "f.txt"), root), false);
    // link'in altından yazma (create/modify: includeTarget=true) → symlink atal → true
    assert.equal(await hasSymlinkInPath(path.join(root, "link", "f.txt"), root, { includeTarget: true }), true);
    // link'in KENDİSİ hedef (delete: includeTarget=false → hedefin kendisi symlink olabilir,
    // çünkü link'in KOPYASI değil link SİLİNİR) → false
    assert.equal(await hasSymlinkInPath(path.join(root, "link"), root, { includeTarget: false }), false);
    // link'in altı, hedef dahil edilmeden (yalnız atallar) → link atal symlink → true
    assert.equal(await hasSymlinkInPath(path.join(root, "link", "f.txt"), root, { includeTarget: false }), true);
    // temiz yol, yalnız atallar
    assert.equal(await hasSymlinkInPath(path.join(root, "real", "f.txt"), root, { includeTarget: false }), false);
    // containment ihlali → güvenli taraf
    assert.equal(await hasSymlinkInPath(path.join(tmp, "other", "f.txt"), root), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("hasSymlinkInPath: missing ancestors stop the walk (no false positive)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    const root = path.join(tmp, "ws");
    await mkdir(root, { recursive: true });
    assert.equal(await hasSymlinkInPath(path.join(root, "nope", "deeper", "f.txt"), root), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("hasSymlinkInPath failClosed: an ancestor became a FILE (lstat ENOTDIR) → false, no throw (the rest cannot exist)", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-")));
  try {
    const root = path.join(tmp, "ws");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "src"), "now a file\n"); // `src` artık DOSYA
    const target = path.join(root, "src", "x", "a.ts");
    // Ölçüm (varsayım değil): `src/x` atalının lstat'ı gerçek fs'te ENOTDIR.
    await assert.rejects(lstat(path.join(root, "src", "x")), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOTDIR");

    assert.equal(await hasSymlinkInPath(target, root, { includeTarget: false, failClosed: true }), false);
    assert.equal(await hasSymlinkInPath(target, root, { includeTarget: true, failClosed: true }), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("hasSymlinkInPath failClosed: any other ancestor lstat errno (EACCES/EIO/ELOOP/EPERM) is still thrown", async () => {
  for (const code of ["EACCES", "EIO", "ELOOP", "EPERM"]) {
    const lstatFn = async (): Promise<never> => {
      throw Object.assign(new Error(`${code} (fault-injected)`), { code });
    };
    await assert.rejects(
      hasSymlinkInPath("/repo/src/x/a.ts", "/repo", { includeTarget: false, lstatFn, failClosed: true }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === code,
    );
  }
});

test("workspaceDir precondition: a pre-existing non-empty dir is detected (spec 11)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "splash-pathsaf-"));
  try {
    const dir = path.join(tmp, "ws");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "junk.txt"), "x");
    const entries = (await import("node:fs/promises")).readdir;
    assert.equal((await entries(dir)).length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
