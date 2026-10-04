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
  // İz 3 / M2: boşluklu `KEY = value` yalnız yapılandırma dosyasında → `.ini` yol ipucu.
  const out = redactText("aws_access_key_id = AKIAABCDEFGHIJKLMNOP\naws_secret_access_key = wJalrXUtnFEMI/abcdef0123456789", { path: "deploy/aws.ini" });
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

// ── İz 3 / A: credential ataması — yalnız LİTERAL değer (kod bozulmaz) ──────

test("A: code that merely NAMES a credential is untouched (no literal value)", () => {
  const unchanged = [
    "inputTokens: number;",
    "  inputTokens: number;",
    "if (token === null) {",
    "if (token == null) {",
    'if (token == "admin") {',
    "if (password === 'x') {",
    'const pick = (token) => "default";',
    'secret::load("x")',
    'if token: x == "y"',
    "const strip = (token) => token.trim();",
    "access_token = create_access_token(data)",
    "TOKEN = None",
    "token=get_token()",
    'ACCESS_TOKEN=os.getenv("TOKEN")',
    "API_TOKEN = null  # set at runtime",
    "def verify_password(plain_password: str, hashed_password: str) -> bool:",
    "    api_key=api_key,",
    "secret::Vault::open()",
    '"api_key": null,',
  ];
  for (const line of unchanged) {
    assert.equal(redactText(line), line, `must not change: ${line}`);
  }
});

test("A: literal credential values are redacted (typed, quoted-key, dotenv, export)", () => {
  const table: Array<[string, string]> = [
    ['jwt_secret: str = "prod-secret"', `jwt_secret: str = "${REDACTED_SECRET}"`],
    ['const apiKey: string = "abc123";', `const apiKey: string = "${REDACTED_SECRET}";`],
    ['"password": "hunter2"', `"password": "${REDACTED_SECRET}"`],
    ["'password': 'hunter2'", `'password': '${REDACTED_SECRET}'`],
    ['{"password":"hunter2"}', `{"password":"${REDACTED_SECRET}"}`],
    ["PASSWORD=hunter2", `PASSWORD=${REDACTED_SECRET}`],
    ["PASSWORD=hunter2\nDEBUG=1", `PASSWORD=${REDACTED_SECRET}\nDEBUG=1`],
    ["PASSWORD=abc;def # rotated", `PASSWORD=${REDACTED_SECRET} # rotated`],
    ["export API_KEY=x", `export API_KEY=${REDACTED_SECRET}`],
    ['token := "abc"', `token := "${REDACTED_SECRET}"`],
    ['private static final String API_KEY = "abc";', `private static final String API_KEY = "${REDACTED_SECRET}";`],
    ['password = "ab\\"cd"', `password = "${REDACTED_SECRET}"`],
  ];
  for (const [input, expected] of table) {
    assert.equal(redactText(input), expected, `input: ${input}`);
    assert.equal(redactText(expected), expected, `idempotent: ${expected}`);
  }
});

// ── İz 3 / B: URL kimliği her şemada + ek secret dosya sınıfları ─────────────

test("B: URL userinfo with a password is redacted for every scheme (host preserved)", () => {
  const table: Array<[string, string]> = [
    ["postgresql://u:p@h/db", `postgresql://${REDACTED_SECRET}@h/db`],
    ["redis://:pw@redis:6379", `redis://${REDACTED_SECRET}@redis:6379`],
    ["postgresql+asyncpg://user:s3cr3t@db:5432/app", `postgresql+asyncpg://${REDACTED_SECRET}@db:5432/app`],
    ["mongodb+srv://admin:pa55@cluster0.example.net/x", `mongodb+srv://${REDACTED_SECRET}@cluster0.example.net/x`],
    ["mqtt://dev:pw@broker:1883", `mqtt://${REDACTED_SECRET}@broker:1883`],
  ];
  for (const [input, expected] of table) {
    assert.equal(redactText(input), expected, `input: ${input}`);
    assert.equal(redactText(expected), expected, `idempotent: ${expected}`);
  }
  // Parolasız, kimliksiz URL'ler değişmez.
  for (const benign of ["redis://redis:6379/0", "http://host:8080/path?q=a:b", "file:///tmp/x"]) {
    assert.equal(redactText(benign), benign);
  }
});

test("B: additional secret file classes", () => {
  for (const p of [
    "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "keys/putty.ppk",
    ".git-credentials",
    "home/.docker/config.json",
    ".docker/config.json",
    "home/.kube/config",
    ".kube/config",
    "ci/kubeconfig",
    ".vault-token",
    "deploy/prod.env",
    ".env-local",
    ".env_production",
  ]) {
    assert.equal(isSecretFilePath(p), true, p);
  }
  for (const p of ["docs/config.json", "app/config", "src/environment.ts", ".env-example", ".env_sample", "example.env", "sample.env"]) {
    assert.equal(isSecretFilePath(p), false, p);
  }
});

test("ReDoS: long separator-joined runs resolve quickly", () => {
  for (const input of ["a-".repeat(50_000), "a.".repeat(50_000), "a_password-".repeat(20_000), "x://:".repeat(20_000), "password:" + " ".repeat(100_000) + "x"]) {
    const start = Date.now();
    redactText(input);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_000, `redaction took ${elapsed}ms (possible ReDoS)`);
  }
});

// ── İz 3 / A-config: yapılandırma dosyalarında çıplak değer (yol ipucu) ──────

test("A-config: bare `KEY: value` / `KEY = value` in config files is redacted (indented, list item, comment kept)", () => {
  const compose = [
    "services:",
    "  db:",
    "    environment:",
    "      POSTGRES_PASSWORD: s3cret",
    "      API_TOKEN: correct horse battery # rotated monthly",
    "  app:",
    "    environment:",
    "      - CLIENT_SECRET=abc123",
    "password: hunter2",
    "token: null",
    "secret:",
    "  nested: value",
  ].join("\n");
  const expected = [
    "services:",
    "  db:",
    "    environment:",
    `      POSTGRES_PASSWORD: ${REDACTED_SECRET}`,
    `      API_TOKEN: ${REDACTED_SECRET} # rotated monthly`,
    "  app:",
    "    environment:",
    `      - CLIENT_SECRET=${REDACTED_SECRET}`,
    `password: ${REDACTED_SECRET}`,
    "token: null",
    "secret:",
    "  nested: value",
  ].join("\n");
  const out = redactText(compose, { path: "deploy/docker-compose.yml" });
  assert.equal(out, expected);
  assert.equal(redactText(out, { path: "deploy/docker-compose.yml" }), out); // idempotent
});

test("A-config: every config extension / env template gets the bare-value rule; code files keep literal-only", () => {
  const line = "  password = hunter2\npassword: hunter2";
  const redacted = `  password = ${REDACTED_SECRET}\npassword: ${REDACTED_SECRET}`;
  for (const p of [
    "a.yml", "a.yaml", "conf/app.ini", "pyproject.toml", "src/main/resources/application.properties",
    "nginx/site.conf", "setup.cfg", "deploy/prod.env", ".env.example", ".env.sample", "CONFIG.YAML",
  ]) {
    assert.equal(redactText(line, { path: p }), redacted, p);
  }
  for (const p of ["src/a.ts", "app/models.py", "Makefile", "README.md", "src/config.ts", undefined]) {
    assert.equal(redactText(line, { path: p }), line, String(p));
  }
  // Kod dosyasındaki tip bildirimi DEĞİŞMEZ (yanlış-pozitif düzeltmesi korunur).
  const ts = "interface Creds {\n  password: string;\n  token: string\n}\npassword: hunter2";
  assert.equal(redactText(ts, { path: "src/creds.ts" }), ts);
  assert.equal(redactText(ts), ts);
});

test("ReDoS: config-hinted redaction stays linear", () => {
  const inputs = [
    "a-".repeat(50_000),
    "a.".repeat(50_000),
    "password: " + "a #".repeat(30_000),
    "password:" + " ".repeat(100_000) + "x",
    " ".repeat(100_000) + "password: x",
    "  - ".repeat(30_000),
    "token: x\n".repeat(50_000),
    "  password = " + "a b ".repeat(30_000),
  ];
  for (const input of inputs) {
    const start = Date.now();
    redactText(input, { path: "docker-compose.yml" });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_000, `config redaction took ${elapsed}ms (possible ReDoS)`);
  }
});

// ── İz 3 / audit: noktalı anahtar, çapalı ek biçimler, string önekleri ───────

/** [girdi, beklenen, yol ipucu?] — beklenen için idempotans da denetlenir. */
type Row = [string, string, string?];
function assertRows(rows: Row[]): void {
  for (const [input, expected, hint] of rows) {
    const options = hint === undefined ? {} : { path: hint };
    assert.equal(redactText(input, options), expected, `input (${hint ?? "no hint"}): ${input}`);
    assert.equal(redactText(expected, options), expected, `idempotent (${hint ?? "no hint"}): ${expected}`);
  }
}
const S = REDACTED_SECRET;

test("H1: dotted keys on line-anchored forms are redacted", () => {
  assertRows([
    ["spring.datasource.password=secret", `spring.datasource.password=${S}`, "src/main/resources/application.properties"],
    ["spring.datasource.password=secret", `spring.datasource.password=${S}`],
    ["db.password: x", `db.password: ${S}`, "config/app.yml"],
    ["  db.password: x", `  db.password: ${S}`, "config/app.yml"],
    ["mail.smtp.password = x # c", `mail.smtp.password = ${S} # c`, "mail.properties"],
  ]);
});

test("H2: indented export, Dockerfile ENV/ARG, commented-out lines, CLI flags are redacted", () => {
  assertRows([
    ["    export API_KEY=abc", `    export API_KEY=${S}`],
    ["ENV DB_PASSWORD=secret", `ENV DB_PASSWORD=${S}`, "Dockerfile"],
    ["  ARG GITHUB_TOKEN=abc", `  ARG GITHUB_TOKEN=${S}`],
    ["# PASSWORD=hunter2", `# PASSWORD=${S}`],
    ["  // API_KEY=abc", `  // API_KEY=${S}`],
    ["; db.password=x", `; db.password=${S}`],
    ["! secret=x", `! secret=${S}`],
    ["# export API_KEY=abc", `# export API_KEY=${S}`],
    ["# password: hunter2", `# password: ${S}`, "docker-compose.yml"],
    ["    # db_password = x", `    # db_password = ${S}`, "setup.cfg"],
    ["mysql --password=hunter2 -u root", `mysql --password=${S} -u root`],
    ["run --db-password=pw1 --verbose", `run --db-password=${S} --verbose`],
    ["docker run -e POSTGRES_PASSWORD=secret -d postgres", `docker run -e POSTGRES_PASSWORD=${S} -d postgres`],
  ]);
  for (const line of ["    api_key=api_key,", "        token=token)", 'args = ["--password=" + pw]', "x-e PASSWORD=y"]) {
    assert.equal(redactText(line), line, line);
    assert.equal(redactText(line, { path: "app/main.py" }), line, line);
  }
});

test("M1: string-prefixed and backtick literals are redacted (prefix + quote preserved)", () => {
  assertRows([
    ["app.secret_key = b'dev-secret'", `app.secret_key = b'${S}'`],
    ["token = r\"x\\y\"", `token = r"${S}"`],
    ["password = f\"{base}-pw\"", `password = f"${S}"`],
    ["SECRET = rb'abc'", `SECRET = rb'${S}'`],
    ["api_key = u'abc'", `api_key = u'${S}'`],
    ['string password = @"p@ss";', `string password = @"${S}";`],
    ['var token = $"tok-{n}";', `var token = $"${S}";`],
    ['const wchar_t* token = L"abc";', `const wchar_t* token = L"${S}";`],
    ['auto password = u8"abc";', `auto password = u8"${S}";`],
    ["const API_KEY = `abc123`;", "const API_KEY = `" + S + "`;"],
  ]);
  assert.equal(redactText("const token = `multi\nline`;"), "const token = `multi\nline`;"); // tek satır kuralı
});

test("M2: spaced `KEY = value` is config-only; code and unhinted text keep it", () => {
  const code = ["ACCESS_TOKEN_EXPIRE_MINUTES = 30", "MAX_TOKENS = 4096", "DB_PASSWORD = settings.x"];
  for (const line of code) {
    assert.equal(redactText(line), line, line);
    assert.equal(redactText(line, { path: "app/core/config.py" }), line, line);
  }
  assertRows([["aws_secret_access_key = wJalr/abc0123", `aws_secret_access_key = ${S}`, "deploy/aws.ini"]]);
});

test("L3: config references are kept; quoted list items keep their closing quote", () => {
  const yml = "docker-compose.yml";
  for (const line of [
    "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
    "  token: ${{ secrets.GH_TOKEN }}",
    "password: $DB_PASS",
    '  - "API_TOKEN=${TOKEN}"',
    "password: ${DB_PASS} # from env",
  ]) {
    assert.equal(redactText(line, { path: yml }), line, line);
  }
  assertRows([
    ['      - "CLIENT_SECRET=abc"', `      - "CLIENT_SECRET=${S}"`, yml],
    ["      - 'CLIENT_SECRET=abc' # c", `      - 'CLIENT_SECRET=${S}' # c`, yml],
  ]);
});

test("ReDoS: dotted / commented / CLI anchors stay linear on long runs", () => {
  const inputs = [
    "spring.".repeat(30_000) + "password=x",
    "# " + "a.".repeat(50_000),
    "#" + " ".repeat(100_000) + "x",
    "// " + "a-".repeat(50_000),
    "ENV " + "a.".repeat(50_000),
    "-- ".repeat(30_000),
    "--password".repeat(20_000),
    "-e ".repeat(30_000),
    "--" + "a.".repeat(50_000),
    "x = `" + "a".repeat(100_000),
    "token = b" + "'a".repeat(50_000),
    "token: ${{" + " a".repeat(50_000),
    "  - \"" + "a.".repeat(50_000),
  ];
  for (const input of inputs) {
    for (const hint of [undefined, "docker-compose.yml"]) {
      const start = Date.now();
      redactText(input, hint === undefined ? {} : { path: hint });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1_000, `redaction took ${elapsed}ms (possible ReDoS): ${input.slice(0, 20)}`);
    }
  }
});
