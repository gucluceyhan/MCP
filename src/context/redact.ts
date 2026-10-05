/**
 * Step 7: deterministik secret / PII redaksiyonu (DESIGN.md §5, §9).
 *
 * Disiplin:
 * - SAF string → string: model/NLP/rastgelelik/saat YOK; aynı girdi her
 *   zaman aynı çıktı.
 * - SABİT placeholder sözlüğü; HER geçiş güçsüz (idempotent): placeholder
 *   çıktıları hiçbir geçişin (kendi dahil) desenine tekrar eşleşmez →
 *   yeniden uygulama kimliktir (testlenir).
 * - Yalnız doğrusal desenler (iç içe nicel gösteren geri tarama tuzağı
 *   YOK) — redaksiyon bir güvenlik katmanıdır, DoS yüzeyi olamaz.
 * - İsim/koruma: credential ATAMA deseninde anahtar ADI + ayracı korunur
 *   (yalnız değer gider) — worker'ın yapısal bağlamı bozulmaz.
 *
 * Sıralama (kaba → ince): PEM blokları (iç base64 token desenleriyle
 * çift-çevrime girmez) → token aileleri → Bearer → URL kimliği →
 * credential ataması → e-posta → telefon.
 */

import path from "node:path";

// ── Sabit placeholder sözlüğü (testler bu dizgeleri pin'ler) ────────────────

export const REDACTED_SECRET = "[REDACTED_SECRET]";
export const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";
export const REDACTED_CERTIFICATE = "[REDACTED_CERTIFICATE]";
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";
export const REDACTED_PHONE = "[REDACTED_PHONE]";
/** Secret dosya içeriğinin TAMAMEN bırakıldığı yer tutucu. */
export const SECRET_FILE_MARKER = "[SECRET FILE CONTENT OMITTED]";
/**
 * Redaksiyonun ürettiği TÜM sabit yer tutucular — doğrulayıcı, worker'ın
 * yazdığı içerikte (base'te literal olarak yoksa) bunları reddeder (K3).
 */
export const REDACTION_PLACEHOLDERS: readonly string[] = [
  REDACTED_SECRET,
  REDACTED_PRIVATE_KEY,
  REDACTED_CERTIFICATE,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  SECRET_FILE_MARKER,
];

// ── Desenler ─────────────────────────────────────────────────────────────────

/** PEM özel anahtar blokları (RSA/EC/OPENSSH/PGP varyantları). */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
/** PEM sertifika blokları. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
/** OpenAI ailesi anahtarlar (`sk-...`, `sk-ant-...` vb.). */
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
/** AWS uzun anahtar kimliği. */
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
/** GitHub token ailesi (ghp/gho/ghu/ghs/ghr). */
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
/** Slack token ailesi. */
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
/** GitHub fine-grained personal access token (`github_pat_...`). */
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g;
/** JWT (`eyJ...` = base64 `{"` başlangıcı; iki nokta, her segment ≥ 8 karakter). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** Google API anahtarı (`AIza...`, 35 karakter). */
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
/** `Authorization: Bearer <token>` — "Bearer " etiketi korunur. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9_\-._~+/]+=*/gi;
/** URL gömülü kimlik (`https://user:pass@host`). */
const URL_USERINFO = /\b(https?:\/\/)[^\s/@?#]+@/gi;
/**
 * Credential ataması (`password: "x"`, `token=x`, `api_key = y`,
 * `aws_secret_access_key = ...`, ...). İsim, secret'vari bir SONA sahip tam
 * kimliktir (`aws_`/`my_` gibi önekler dahil — `\b` tek başına underscore
 * içine giremez). Değer: tırnaksız string, tırlı string ya da tek bare token.
 */
const CREDENTIAL_ASSIGNMENT =
  /\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)[\w-]*)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
/** E-posta adresleri. */
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
/**
 * Telefon numaraları — GÜÇLÜ biçim gerektirir: `+` öneki + 6-18 karakter
 * (rakkam/boşluk/ayraç) YA da 3-3-4 gruplu biçim. Replacer rakam sayısını
 * 7-15 arasında doğrular; kısa rakam dizileri (kod, sürüm, satır no)
 * dokunulmaz kalır.
 */
const PHONE = /\+\d[\d\s().-]{5,17}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g;

// ── Geçişler ─────────────────────────────────────────────────────────────────

function countDigits(value: string): number {
  let digits = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      digits++;
    }
  }
  return digits;
}

/**
 * Tek metin üzerinde TÜM geçişleri sabit sırayla uygular.
 * İdempotent: `redactText(redactText(x)) === redactText(x)`.
 */
export function redactText(text: string): string {
  if (text.length === 0) {
    return text;
  }
  let out = text
    .replace(PEM_PRIVATE_KEY, () => REDACTED_PRIVATE_KEY)
    .replace(PEM_CERTIFICATE, () => REDACTED_CERTIFICATE)
    .replace(OPENAI_KEY, () => REDACTED_SECRET)
    .replace(AWS_KEY, () => REDACTED_SECRET)
    .replace(GITHUB_TOKEN, () => REDACTED_SECRET)
    .replace(SLACK_TOKEN, () => REDACTED_SECRET)
    .replace(GITHUB_PAT, () => REDACTED_SECRET)
    .replace(JWT, () => REDACTED_SECRET)
    .replace(GOOGLE_API_KEY, () => REDACTED_SECRET)
    .replace(BEARER, (_whole: string, label: string) => `${label}${REDACTED_SECRET}`)
    .replace(URL_USERINFO, (whole, scheme: string) => `${scheme}${REDACTED_SECRET}@`);
  // Credential ataması: anahtar adı + ayraç korunur; değer placeholder'a.
  out = out.replace(CREDENTIAL_ASSIGNMENT, (whole: string, key: string, separator: string, value: string) => {
    // Boş tırnak çifti (`""`) secret DEĞİLDİR — dokunulmaz (placeholder
    // "secret varmış" iması üretmez).
    if (value === '""' || value === "''") {
      return whole;
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return `${key}${separator}"${REDACTED_SECRET}"`;
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return `${key}${separator}'${REDACTED_SECRET}'`;
    }
    return `${key}${separator}${REDACTED_SECRET}`;
  });
  out = out.replace(EMAIL, () => REDACTED_EMAIL);
  // Telefon: rakam sayısı doğrulaması replacer'da (yalnız güçlü biçimler).
  out = out.replace(PHONE, (whole) => (countDigits(whole) >= 7 && countDigits(whole) <= 15 ? REDACTED_PHONE : whole));
  return out;
}

/**
 * Secret dosya Sınıflandırması (deterministik v1; adım dosya adına bakar,
 * içeriğe ASLA bakmaz):
 * - `.env` ve `.env.<suffix>` — `example`/`sample`/`template`/`dist`
 *   suffix'leri hariç (belge amaçlı şablonlar secret DEĞİLDİR);
 * - anahtar/sertifika depolama uzantıları: `.key`/`.p12`/`.pfx`/`.jks`/`.keystore`;
 * - SSH özel anahtar isimleri: `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`
 *   (`.pub` dahil DEĞİL — public anahtar secret değildir);
 * - `credentials`/`credentials.*`, `secret(s).json`, service-account
 *   kimlik dosyaları.
 *
 * Gizli dosya içeriği bağlama GİRMEDEN `SECRET_FILE_MARKER`'a düşer
 * (yoksa ABSENT marker) + sabit uyarı; dosyanın varlığı korunur.
 */
export function isSecretFilePath(repoRelativePath: string): boolean {
  const name = path.posix.basename(repoRelativePath).toLowerCase();
  if (name.length === 0) {
    return false;
  }
  if (name === ".env") {
    return true;
  }
  if (name.startsWith(".env.")) {
    const suffix = name.slice(".env.".length);
    return !["example", "sample", "template", "dist"].includes(suffix);
  }
  if (
    name.endsWith(".key") ||
    name === "key" ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    name.endsWith(".jks") ||
    name.endsWith(".keystore") ||
    name === "keystore"
  ) {
    return true;
  }
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(name)) {
    return true;
  }
  if (name === "credentials" || name.startsWith("credentials.")) {
    return true;
  }
  if (name === "secret.json" || name === "secrets.json") {
    return true;
  }
  if (name === "service-account.json" || name === "service_account.json") {
    return true;
  }
  // Kimlik/tokan taşıyıcısı konfig dosyaları. Fail-safe (over-omit kabul):
  // gereksiz bir atma yalnız bağlam kaybettirir; kaçan secret içeriği sızar.
  if (
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === ".pgpass" ||
    name === ".netrc" ||
    name === ".envrc" ||
    name === "htpasswd" ||
    name === ".htpasswd"
  ) {
    return true;
  }
  if (name === "token.json" || name === "tokens.json" || name.startsWith("token.")) {
    return true;
  }
  // PEM özel anahtar / sertifika uzantıları (private key `.pem`'de yaygındır).
  if (name.endsWith(".pem") || name.endsWith(".crt") || name.endsWith(".cer")) {
    return true;
  }
  return false;
}
