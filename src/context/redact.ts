/**
 * Step 7: deterministik secret / PII redaksiyonu (DESIGN.md §5, §9).
 *
 * Disiplin:
 * - SAF string → string: model/NLP/rastgelelik/saat YOK; aynı girdi her
 *   zaman aynı çıktı.
 * - SABİТ placeholder sözlüğü; HER geçiş güçsüz (idempotent): placeholder
 *   çıktıları hiçbir geçişin (kendi dahil) desenine tekrar eşleşmez →
 *   yeniden uygulama kimliktir (testlenir).
 * - Yalnız doğrusal desenler (iç içe nicel gösteren geri tarama tuzağı
 *   YOK) — redaksiyon bir güvenlik katmanıdır, DoS yüzeyi olamaz.
 * - İsim/koruma: credential ATAMA deseninde anahtar ADI + ayracı korunur
 *   (yalnız değer gider) — worker'ın yapısal bağlamı bozulmaz.
 *
 * Sıralama (kaba → ince): PEM blokları (iç base64 token desenleriyle
 * çift-çevrime girmez) → token aileleri → Bearer → URL kimliği →
 * credential ataması (literal → satır başı dotenv → CLI bayrağı → yalnız
 * yapılandırma dosyasında çıplak `KEY: value`) → e-posta → telefon.
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
/**
 * Her şemada parolalı URL kimliği (`postgresql+asyncpg://u:p@h`,
 * `redis://:pw@h`, `mongodb+srv://`, `mqtt://`). Şema uzunluğu sınırlı —
 * `a-a-a…` gibi uzun koşularda her başlangıç sabit maliyetli (ReDoS yok).
 */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@?#:]*:[^\s/@?#]+@/gi;
/** HTTP(S) URL gömülü kimlik — parolasız token biçimi de (`https://TOKEN@host`). */
const URL_USERINFO = /\b(https?:\/\/)[^\s/@?#]+@/gi;
/** Secret'vari anahtar kelimeleri. */
const SECRET_WORDS =
  "password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key";
/**
 * Credential anahtarı: secret'vari kelime İÇEREN tam kimlik (`aws_`/`my_`
 * önekleri dahil). Önek/sonek sınırlı + başlangıç yalnız koşu başında
 * (`(?<![\w-])`) → uzun `[\w-]` koşularında doğrusal.
 */
const SECRET_KEY = `[\\w-]{0,64}(?:${SECRET_WORDS})[\\w-]{0,64}`;
/** Satıra/bayrağa sabitli biçimlerde noktalı anahtar (`spring.datasource.password`). */
const DOTTED_SECRET_KEY = `[\\w.-]{0,128}(?:${SECRET_WORDS})[\\w-]{0,64}`;
/** Satır başı yorum işareti (yorumlanmış secret satırları): `#`, `//`, `;`, `!`. */
const COMMENT_MARK = "(?:#|//|;|!)";
/** Bildirim anahtar sözcüğü: `export` (shell), Dockerfile `ENV`/`ARG`. */
const DECLARE = "(?:export|env|arg)";
/** Değer sonu: opsiyonel kapanış tırnağı + boşluklu `# yorum` ya da satır sonu. */
const VALUE_END = `["']?(?:[ \\t]+#|[ \\t]*$)`;
/**
 * Credential ataması — değer yalnız LİTERAL: tırnaklı string (kaçışlı tırnak
 * dahil; opsiyonel `b`/`r`/`f`/`u`/`rb`/`@`/`$`/`L`/`u8` öneki korunur) ya da
 * tek satırlık backtick. Anahtar opsiyonel tırnaklı (JSON `"password": "x"`),
 * anahtar ile ayraç arasında opsiyonel tip anotasyonu (`jwt_secret: str =
 * "x"`; anotasyon TEK sınırlı niceleyici — boşluk koşusunda karesel geri
 * izleme yok). Ayraç `:`/`=`/`:=`; literal ayraçtan (+ boşluk) HEMEN sonra
 * başlamalı → `==`/`===`/`=>`/`::` yapısal olarak eşleşmez.
 * Grup 1 (anahtar + ayraç) + grup 2 (önek) korunur; grup 3 placeholder'a.
 */
const CREDENTIAL_LITERAL = new RegExp(
  `(?<![\\w-])(["']?${SECRET_KEY}["']?[ \\t]*` +
    `(?::[\\w.\\[\\]<>|? \\t]{1,64}?=|:=|:|=)[ \\t]*)` +
    "((?:rb|u8|[brful@$])?)" +
    "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\\\n]|\\\\.)*`)",
  "gi",
);
/**
 * Çıplak değer — her metinde YALNIZ satır başı, BOŞLUKSUZ `KEY=value`
 * (dotenv/properties; noktalı anahtar serbest). Girinti yalnız bir yorum
 * işareti (`#`/`//`/`;`/`!`) ya da `export`/`ENV`/`ARG` ile birlikte —
 * girintili çağrı argümanı (`    api_key=api_key,`) eşleşmez. Değer satırın
 * geri kalanıdır (boşluklu `# yorum` hariç) ve kod ifadesi değildir
 * (tırnak/parantez/köşeli/süslü yok; `None`/`null`/`true`/`false`… değil).
 * Boşluklu `KEY = value` yalnız yapılandırma dosyalarında (CONFIG).
 */
const CREDENTIAL_DOTENV = new RegExp(
  `^((?:[ \\t]*(?:${COMMENT_MARK}[ \\t]*(?:${DECLARE}[ \\t]+)?|${DECLARE}[ \\t]+))?${DOTTED_SECRET_KEY}=)` +
    `(?!(?:none|null|nil|undefined|true|false)(?:[ \\t]|$))` +
    "([^\\s\"'`()\\[\\]{}]+)(?=[ \\t]+#|[ \\t]*$)",
  "gim",
);
/**
 * CLI bayrağı: `--…password…=VALUE` ve `-e KEY=VALUE` (yalnız boşluk/satır
 * başından sonra). Değer boşluğa kadar; tırnaklı değer literal geçişinindir.
 */
const CREDENTIAL_CLI = new RegExp(`(?<!\\S)((?:--|-e[ \\t]+)${DOTTED_SECRET_KEY}=)([^\\s"'\`]+)`, "gi");
/**
 * Yapılandırma dosyalarında (yol ipucu, `isConfigFilePath`) çıplak değer:
 * satır başı (girinti, yorum işareti, YAML `- ` öğesi, `export`/`ENV`/`ARG`
 * serbest; anahtar noktalı/tırnaklı olabilir) `KEY: value` / `KEY = value`;
 * değer satır sonuna kadar (boşluklu `# yorum` ve kapanış tırnağı hariç).
 * Tırnakla başlayan (literal geçişi), `[`/`{` (yer tutucu/akış), `|`/`>`
 * (YAML blok), `null`/`~`/`true`… ve saf referans (`${VAR}`,
 * `${{ secrets.X }}`, `$VAR`) değerler dokunulmaz. Kod dosyaları bu geçişi
 * ALMAZ. Boşluk niceleyicileri bitişik değil → doğrusal.
 */
const CREDENTIAL_CONFIG = new RegExp(
  `^([ \\t]*(?:${COMMENT_MARK}[ \\t]*)?(?:-[ \\t]+)?(?:${DECLARE}[ \\t]+)?["']?${DOTTED_SECRET_KEY}["']?[ \\t]*[:=][ \\t]*)` +
    `(?!(?:none|null|nil|undefined|true|false|~)${VALUE_END})` +
    `(?!(?:\\$\\{\\{[^\\n]*?\\}\\}|\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*)${VALUE_END})` +
    `([^\\s"'\\[{|>](?:[^\\n\\r]*?[^\\s])??)(?=${VALUE_END})`,
  "gim",
);
/** Çıplak-değer kuralının uygulandığı yapılandırma uzantıları. */
const CONFIG_EXTENSIONS: readonly string[] = [".yml", ".yaml", ".ini", ".toml", ".properties", ".conf", ".cfg", ".env"];

/** Yapılandırma dosyası mı? (`.env` şablonları dahil — içerikleri redakte edilir.) */
function isConfigFilePath(repoRelativePath: string): boolean {
  const name = path.posix.basename(repoRelativePath).toLowerCase();
  return (
    CONFIG_EXTENSIONS.includes(path.posix.extname(name)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith(".env-") ||
    name.startsWith(".env_")
  );
}
/**
 * E-posta adresleri. Başlangıç yalnız yerel-kısım koşusunun başında
 * (`(?<![\w.+-])`) — `a.a.a…` koşusunda her konumdan yeniden tarama yok.
 */
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
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

/** Redaksiyon ipucu: metnin geldiği repository-göreceli dosya yolu (varsa). */
export interface RedactOptions {
  path?: string;
}

/**
 * Tek metin üzerinde TÜM geçişleri sabit sırayla uygular.
 * İdempotent: `redactText(redactText(x, o), o) === redactText(x, o)`.
 * `options.path` bir yapılandırma dosyasıysa çıplak `KEY: value` da gider.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
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
    .replace(URL_PASSWORD, (_whole: string, scheme: string) => `${scheme}${REDACTED_SECRET}@`)
    .replace(URL_USERINFO, (_whole: string, scheme: string) => `${scheme}${REDACTED_SECRET}@`);
  // Credential ataması: anahtar adı + ayraç (+ tip anotasyonu) korunur;
  // yalnız literal değer placeholder'a. Boş tırnak çifti (`""`) secret
  // DEĞİLDİR — dokunulmaz.
  out = out.replace(CREDENTIAL_LITERAL, (whole: string, prefix: string, stringPrefix: string, literal: string) => {
    if (literal.length === 2) {
      return whole;
    }
    const quote = literal.charAt(0);
    return `${prefix}${stringPrefix}${quote}${REDACTED_SECRET}${quote}`;
  });
  out = out.replace(CREDENTIAL_DOTENV, (_whole: string, prefix: string) => `${prefix}${REDACTED_SECRET}`);
  out = out.replace(CREDENTIAL_CLI, (_whole: string, prefix: string) => `${prefix}${REDACTED_SECRET}`);
  if (options.path !== undefined && isConfigFilePath(options.path)) {
    out = out.replace(CREDENTIAL_CONFIG, (_whole: string, prefix: string) => `${prefix}${REDACTED_SECRET}`);
  }
  out = out.replace(EMAIL, () => REDACTED_EMAIL);
  // Telefon: rakam sayısı doğrulaması replacer'da (yalnız güçlü biçimler).
  out = out.replace(PHONE, (whole) => (countDigits(whole) >= 7 && countDigits(whole) <= 15 ? REDACTED_PHONE : whole));
  return out;
}

/** Belge amaçlı `.env` şablon adları — secret DEĞİL. */
const ENV_TEMPLATE_NAMES: readonly string[] = ["example", "sample", "template", "dist"];

/**
 * Secret dosya Sınıflandırması (deterministik v1; adım dosya adına bakar,
 * içeriğe ASLA bakmaz):
 * - `.env`, `.env.<suffix>`/`.env-<suffix>`/`.env_<suffix>` ve `<ad>.env` —
 *   `example`/`sample`/`template`/`dist` adları hariç (belge amaçlı
 *   şablonlar secret DEĞİLDİR);
 * - anahtar/sertifika depolama uzantıları: `.key`/`.p12`/`.pfx`/`.jks`/`.keystore`;
 * - SSH özel anahtar isimleri: `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`
 *   (`.pub` dahil DEĞİL — public anahtar secret değildir);
 * - `credentials`/`credentials.*`, `secret(s).json`, service-account
 *   kimlik dosyaları;
 * - Terraform state (`*.tfstate`, `*.tfstate.backup`), PuTTY `*.ppk`,
 *   `.git-credentials`, `.vault-token`, `.docker/config.json`,
 *   kubeconfig (`.kube/config`, `kubeconfig`).
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
  if (name.startsWith(".env.") || name.startsWith(".env-") || name.startsWith(".env_")) {
    return !ENV_TEMPLATE_NAMES.includes(name.slice(".env.".length));
  }
  // `prod.env` / `local.env` (şablon adları hariç: `example.env` …).
  if (name.endsWith(".env")) {
    return !ENV_TEMPLATE_NAMES.includes(name.slice(0, -".env".length));
  }
  // Terraform state (düz metin secret taşır), PuTTY özel anahtarı,
  // git/vault/kube kimlik dosyaları.
  if (name.endsWith(".tfstate") || name.endsWith(".tfstate.backup") || name.endsWith(".ppk")) {
    return true;
  }
  if (name === ".git-credentials" || name === ".vault-token" || name === "kubeconfig") {
    return true;
  }
  const parent = path.posix.basename(path.posix.dirname(repoRelativePath)).toLowerCase();
  if ((parent === ".docker" && name === "config.json") || (parent === ".kube" && name === "config")) {
    return true;
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
