/**
 * Step 7: secret/PII redaksiyonu (DESIGN.md §5/9, 11 madde 7) — saf birim
 * testleri.
 *
 * Çiviler:
 * - bilinen secret aileleri (API anahtarı, private key, certificate, bearer,
 *   URL userinfo, credential ataması, e-posta, telefon) redakte edilir;
 * - placeholder'lar DETERMİNİSTİK + SABİТtir (kaynak değer ASLA kalmaz);
 * - redaksiyon İDEMPOTAN ve DETERMİNİSTİK (aynı girdi → aynı çıktı);
 * - masum içerik (kod, yollar, normal metin) DEĞİŞMEZ (yanlış pozitif yok);
 * - secret dosya SINIFLANDIRMASI: `.env` ailesi / anahtar uzantıları /
 *   credential dosyaları → `true`; `.env.example` / normal kaynak → `false`;
 * - hiçbir regex geriye-düşme (ReDoS) tuzağı taşımaz (patolojik girdi
 *   makul sürede çözülür).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED_CERTIFICATE,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_PRIVATE_KEY,
  REDACTED_SECRET,
  SECRET_FILE_MARKER,
  isSecretFilePath,
  redactText,
} from "../dist/context/redact.js";

// ── secret aileleri ──────────────────────────────────────────────────────────

test("redactText: OpenAI-style key → placeholder; raw value gone", () => {
  const raw = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const out = redactText(`key = ${raw}`);
  assert.ok(!out.includes(raw));
  assert.ok(out.includes(REDACTED_SECRET));
  assert.equal(out, `key = ${REDACTED_SECRET}`);
});

test("redactText: PEM private key block → placeholder (multi-line)", () => {
  const pem =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n";
  const out = redactText(pem);
  assert.ok(!out.includes("MIIEvQIBADANBg"));
  assert.ok(!out.includes("PRIVATE KEY-----\nMII"));
  assert.ok(out.includes(REDACTED_PRIVATE_KEY));
});

test("redactText: PEM certificate block → placeholder", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIBxx\n-----END CERTIFICATE-----\n";
  const out = redactText(pem);
  assert.ok(out.includes(REDACTED_CERTIFICATE));
  assert.ok(!out.includes("MIIBxx"));
});

test("redactText: AWS access key + secret pair → placeholder", () => {
  const out = redactText("aws_access_key_id = AKIAABCDEFGHIJKLMNOP\naws_secret_access_key = wJalrXUtnFEMI/abcdef0123456789");
  assert.ok(!out.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(!out.includes("wJalrXUtnFEMI/abcdef0123456789"));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: GitHub token → placeholder", () => {
  const raw = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const out = redactText(`token: ${raw}`);
  assert.ok(!out.includes(raw));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: Slack token → placeholder", () => {
  const raw = "xoxb-123456789012-abcdefghijklmnop-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const out = redactText(`bot=${raw}`);
  assert.ok(!out.includes(raw));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: GitHub fine-grained PAT / bare JWT / Google API key → placeholder", () => {
  const pat = "github_pat_" + "a1b2c3d4e5f6g7h8";
  const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
  const google = "AIza" + "a".repeat(35);
  const out = redactText(`${pat} ${jwt} ${google}`);
  assert.ok(!out.includes(pat));
  assert.ok(!out.includes(jwt));
  assert.ok(!out.includes(google));
  assert.equal(out.split(REDACTED_SECRET).length - 1, 3);
  assert.equal(redactText(out), out); // idempotent
});

test("redactText: Authorization bearer → placeholder (label preserved)", () => {
  const out = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9.abc.def"));
  assert.ok(out.includes("Bearer"));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: URL userinfo → placeholder (scheme + host preserved)", () => {
  const out = redactText("url = https://user:super-secret-password@example.com/api");
  assert.ok(!out.includes("super-secret-password"));
  assert.ok(out.includes("https:"));
  assert.ok(out.includes("example.com"));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: credential assignment (api_key=...) → placeholder", () => {
  const out = redactText('api_key="totally-not-a-real-but-secret-value"');
  assert.ok(!out.includes("totally-not-a-real-but-secret-value"));
  assert.ok(out.includes(REDACTED_SECRET));
});

test("redactText: e-mail → placeholder", () => {
  const out = redactText("contact: someone@example.com please");
  assert.ok(!out.includes("someone@example.com"));
  assert.ok(out.includes(REDACTED_EMAIL));
});

test("redactText: phone number → placeholder (digit-count bounded)", () => {
  const out = redactText("call +90 532 123 45 67 now");
  assert.ok(!out.includes("532 123 45 67"));
  assert.ok(out.includes(REDACTED_PHONE));
});

// ── masum içerik (yanlış pozitif YOK) ────────────────────────────────────────

test("redactText: ordinary source code is untouched", () => {
  const source = [
    "import { readFile } from 'node:fs/promises';",
    "export function load(config: Config) {",
    "  const url = new URL('/api/items', base);",
    "  const n = 123456789;",
    "  return url.href;",
    "}",
  ].join("\n");
  assert.equal(redactText(source), source);
});

test("redactText: file paths, words with @, short digit runs are untouched", () => {
  const benign = "src/config.ts and notes.txt — see README\nversion 1.2.3, port 8080, id 42";
  assert.equal(redactText(benign), benign);
});

// ── idempotans + determinizm ─────────────────────────────────────────────────

test("redactText: idempotent (redacting a redacted output changes nothing)", () => {
  const raw = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const once = redactText(`k=${raw}; mail=a@b.co`);
  assert.equal(redactText(once), once);
});

test("redactText: deterministic (same input → same output, twice)", () => {
  const input = `key: sk-abcdefghijklmnopqrstuvwxyz0123456789\ncontact dev@example.com\nphone 905321234567`;
  assert.equal(redactText(input), redactText(input));
});

// ── secret dosya sınıflandırması ─────────────────────────────────────────────

test("isSecretFilePath: .env family → secret", () => {
  assert.equal(isSecretFilePath(".env"), true);
  assert.equal(isSecretFilePath("config/.env.production"), true);
  assert.equal(isSecretFilePath(".env.local"), true);
});

test("isSecretFilePath: .env.example / .env.sample / .env.template → NOT secret", () => {
  assert.equal(isSecretFilePath(".env.example"), false);
  assert.equal(isSecretFilePath(".env.sample"), false);
  assert.equal(isSecretFilePath(".env.template"), false);
});

test("isSecretFilePath: key material extensions / names → secret", () => {
  assert.equal(isSecretFilePath("keys/server.key"), true);
  assert.equal(isSecretFilePath("certs/keystore.p12"), true);
  assert.equal(isSecretFilePath("deploy/keystore.pfx"), true);
  assert.equal(isSecretFilePath("jars/app.jks"), true);
  assert.equal(isSecretFilePath("keys/keystore"), true);
  assert.equal(isSecretFilePath("~/.ssh/id_rsa"), true);
  assert.equal(isSecretFilePath("keys/id_ed25519"), true);
  assert.equal(isSecretFilePath("gcp/service-account.json"), true);
  assert.equal(isSecretFilePath("gcp/service_account.json"), true);
  assert.equal(isSecretFilePath("secrets/credentials.yaml"), true);
  assert.equal(isSecretFilePath("auth/secret.json"), true);
});

test("isSecretFilePath: credential/token config carriers → secret (fail-safe over-omit)", () => {
  assert.equal(isSecretFilePath(".npmrc"), true);
  assert.equal(isSecretFilePath("config/.pypirc"), true);
  assert.equal(isSecretFilePath(".pgpass"), true);
  assert.equal(isSecretFilePath(".netrc"), true);
  assert.equal(isSecretFilePath("env/.envrc"), true);
  assert.equal(isSecretFilePath("apache/htpasswd"), true);
  assert.equal(isSecretFilePath(".htpasswd"), true);
  assert.equal(isSecretFilePath("auth/token.json"), true);
  assert.equal(isSecretFilePath("auth/tokens.json"), true);
});

test("isSecretFilePath: PEM / certificate extensions → secret", () => {
  assert.equal(isSecretFilePath("keys/server.pem"), true);
  assert.equal(isSecretFilePath("certs/ca.crt"), true);
  assert.equal(isSecretFilePath("certs/root.cer"), true);
});

test("isSecretFilePath: ordinary sources → NOT secret", () => {
  assert.equal(isSecretFilePath("src/main.ts"), false);
  assert.equal(isSecretFilePath("keys/README.md"), false);
  assert.equal(isSecretFilePath("package.json"), false);
  assert.equal(isSecretFilePath("src/config.ts"), false);
  assert.equal(isSecretFilePath("docs/environments.md"), false);
});

test("SECRET_FILE_MARKER is a fixed string (no path/content leakage by construction)", () => {
  assert.equal(SECRET_FILE_MARKER, "[SECRET FILE CONTENT OMITTED]");
});

// ── ReDoS dayanıklılığı (patolojik girdi makul sürede) ───────────────────────

test("redactText: pathological inputs resolve quickly (no catastrophic backtracking)", () => {
  const cases = [
    "sk-" + "a".repeat(10_000),
    "Bearer " + " ".repeat(500) + "x",
    Array.from({ length: 2_000 }, () => "key=").join("") + "!",
    "a@".repeat(5_000),
    "https://u:".repeat(2_000),
  ];
  for (const input of cases) {
    const start = Date.now();
    const out = redactText(input);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `redaction took ${elapsed}ms (possible ReDoS)`);
    assert.equal(typeof out, "string");
  }
});
