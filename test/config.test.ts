/**
 * Config testleri (Step 2): `SPLASH_API_KEY` okuma kuralları, base URL
 * köken (origin) kuralı ve mevcut varsayılanların korunması. `loadConfig`
 * deterministiktir: verilen env eşleşmesinin saf fonksiyonudur — testler
 * saf env nesneleri gönderir.
 *
 * Güvenlik regresyonu (Step 2 düzeltmesi): config hata mesajları YALNIZCA
 * alan adını + neden'i taşır; ham URL değerinden iz ASLA sızdırılmaz. Bir
 * URL credential (`user:pass@`), query-string token'ı (`?token=...`) veya
 * fragment (`#...`) taşıyabilir; boot hatası stderr'e yazıldığı için ham
 * değer oraya sızarsa gizli veri açığa çıkar. Bu yüzden red edilen
 * değerlere `super-secret` işareti (marker) gömülür ve fırlatılan mesajda
 * NE işaretin NE de tam ham değerin bulunmaması pin'lenir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";

test("SPLASH_API_KEY set: the trimmed value lands in backend.apiKey", () => {
  const config = loadConfig({ SPLASH_API_KEY: "  sk-abc-123  " });
  assert.equal(config.backend.apiKey, "sk-abc-123");
});

test("SPLASH_API_KEY unset: backend.apiKey is undefined", () => {
  const config = loadConfig({});
  assert.equal(config.backend.apiKey, undefined);
});

test("SPLASH_API_KEY whitespace-only: backend.apiKey is undefined", () => {
  const config = loadConfig({ SPLASH_API_KEY: "   \t " });
  assert.equal(config.backend.apiKey, undefined);
});

test("clean env: pre-existing defaults (baseUrl, model) are unchanged", () => {
  const config = loadConfig({});
  assert.equal(config.backend.baseUrl, "http://127.0.0.1:8000");
  assert.equal(config.backend.model, "incoai/Qwen3.8-27B-Splash");
  assert.equal(config.backend.apiKey, undefined);
});

// ── SPLASH_BACKEND_BASE_URL: v1'de yalnızca sunucu kökeni (origin) ───────

/**
 * Red değerlerine gömülen ortak işaret: hata mesajında sızarsa test kırılır.
 * (Test fikstürü — gerçek bir credential değil.)
 */
const MARKER = "super-secret";

/**
 * `loadConfig`'ın fırlattığı hata mesajını yakalar. Mesajın içeriği üzerinde
 * ek kontrol (işaret sızması) yapıldığı için `assert.throws` yerine bu
 * yakala-yöntem kullanılır; hata yoksa ya da Error değilse test kırılır.
 */
function configErrorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof Error)) {
      throw new Error(`expected loadConfig to throw an Error, got: ${String(err)}`);
    }
    return err.message;
  }
  throw new Error("expected loadConfig to throw");
}

/**
 * Bir red senaryosunun mesaj sözleşmesini doğrular: alan adı belirtilir,
 * NE gömülü işaret NE de tam ham değer mesajda yer alır.
 */
function expectSafeRejection(value: string): void {
  const message = configErrorMessage(() =>
    loadConfig({ SPLASH_BACKEND_BASE_URL: value }),
  );
  assert.match(message, /SPLASH_BACKEND_BASE_URL/, "the message must name the field");
  assert.ok(!message.includes(MARKER), `the marker must not leak into: ${message}`);
  assert.ok(!message.includes(value), `the raw value must not leak into: ${message}`);
}

test("base URL: a plain origin round-trips to itself (default unchanged)", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "http://127.0.0.1:8000" });
  assert.equal(config.backend.baseUrl, "http://127.0.0.1:8000");
});

test("base URL: a trailing root slash is accepted and normalized to the canonical origin", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "http://127.0.0.1:8000/" });
  assert.equal(config.backend.baseUrl, "http://127.0.0.1:8000");
});

test("base URL: an https origin without a port round-trips to itself", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "https://example.com" });
  assert.equal(config.backend.baseUrl, "https://example.com");
});

test("base URL: an uppercase scheme+host is accepted and lowercased to the canonical origin", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "HTTP://HOST" });
  assert.equal(config.backend.baseUrl, "http://host");
});

test("base URL: an IPv6 bracket origin round-trips to itself", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "http://[::1]:8000" });
  assert.equal(config.backend.baseUrl, "http://[::1]:8000");
});

test("base URL: a malformed (unparseable) value is rejected without echoing it", () => {
  // `super-secret` tek başına geçerli bir URL değil — parse dalı patlar.
  expectSafeRejection(MARKER);
});

test("base URL: a non-http(s) protocol is rejected without echoing it", () => {
  expectSafeRejection(`ftp://${MARKER}.example.com`);
});

test("base URL: an empty-host form is rejected without echoing it", () => {
  // ÖLÇÜLDÜ (Node v23): http/https'de boş hostname `new URL` tarafından
  // parse hatası olarak reddedilir (ör. `http://:8000` → Invalid URL) —
  // WHATWG special şemada boş host'u parse başarısızlığı sayar; bu yüzden
  // `hostname === ""` dalı http/https için ulaşılamaz ve savunma amaçlı
  // kalır. Boş-host formu PARSE dalında patlar; marker'lı değer oradan da
  // güvenli mesajla reddedilmeli (sızıntı regresyonu aynı).
  expectSafeRejection(`http://:${MARKER}`);
});

test("base URL: embedded userinfo (user:pass@ and user@) is rejected without echoing it", () => {
  for (const value of [`http://u:${MARKER}@127.0.0.1:8000`, `http://${MARKER}@127.0.0.1:8000`]) {
    expectSafeRejection(value);
  }
});

test("base URL: an embedded password is rejected without leaking it (secret-leak regression)", () => {
  expectSafeRejection(`https://user:${MARKER}@host`);
});

test("base URL: a non-root path prefix is rejected without echoing it", () => {
  // Query'deki işaret pathname dalından (önce kontrol edilir) önce yakalanır.
  expectSafeRejection(`http://127.0.0.1:8000/proxy?x=${MARKER}`);
});

test("base URL: an https path prefix is rejected without echoing it", () => {
  expectSafeRejection(`https://example.com/api/${MARKER}`);
});

test("base URL: a double-slash path ('//') is non-root and rejected without echoing it", () => {
  expectSafeRejection(`http://host:8000//${MARKER}`);
});

test("base URL: a query string is rejected without echoing it", () => {
  expectSafeRejection(`https://example.com/?x=${MARKER}`);
});

test("base URL: a token-bearing query string is rejected without leaking it (secret-leak regression)", () => {
  expectSafeRejection(`https://example.com/?token=${MARKER}`);
});

test("base URL: a fragment is rejected without echoing it", () => {
  expectSafeRejection(`https://example.com/#${MARKER}`);
});

// ── Step 7: bağlam bütçesi doğrulaması (SPLASH_CONTEXT_TIERS / reserve'ler) ──

test("context: clean env keeps the finalized tier/reserve defaults", () => {
  const config = loadConfig({});
  assert.deepEqual(config.context.tiers, [65_536, 131_072, 196_608]);
  assert.equal(config.context.minOutputReserve, 32_768);
  assert.equal(config.context.preferredOutputReserve, 65_536);
});

test("context: a valid tier subset (ascending) round-trips", () => {
  const config = loadConfig({ SPLASH_CONTEXT_TIERS: "131072,196608" });
  assert.deepEqual(config.context.tiers, [131_072, 196_608]);
});

test("context: a single known tier round-trips", () => {
  const config = loadConfig({ SPLASH_CONTEXT_TIERS: "65536" });
  assert.deepEqual(config.context.tiers, [65_536]);
});

test("context: an unknown tier value is rejected (no invented budget policy)", () => {
  assert.throws(() => loadConfig({ SPLASH_CONTEXT_TIERS: "70000" }), /not a known context tier/);
});

test("context: a duplicate tier entry is rejected", () => {
  assert.throws(() => loadConfig({ SPLASH_CONTEXT_TIERS: "65536,65536" }), /duplicate/);
});

test("context: a non-ascending tier list is rejected (order is part of the policy)", () => {
  assert.throws(() => loadConfig({ SPLASH_CONTEXT_TIERS: "131072,65536" }), /strictly increasing/);
});

test("context: an empty tier entry is rejected", () => {
  assert.throws(() => loadConfig({ SPLASH_CONTEXT_TIERS: "65536,,196608" }), /empty entry/);
});

test("context: preferred reserve below the minimum reserve is rejected", () => {
  assert.throws(
    () =>
      loadConfig({
        SPLASH_CONTEXT_MIN_OUTPUT_RESERVE: "40000",
        SPLASH_CONTEXT_PREFERRED_OUTPUT_RESERVE: "30000",
      }),
    /must not be below the minimum reserve/,
  );
});

test("context: preferred reserve equal to the minimum reserve is accepted", () => {
  const config = loadConfig({
    SPLASH_CONTEXT_MIN_OUTPUT_RESERVE: "40000",
    SPLASH_CONTEXT_PREFERRED_OUTPUT_RESERVE: "40000",
  });
  assert.equal(config.context.minOutputReserve, 40_000);
  assert.equal(config.context.preferredOutputReserve, 40_000);
});

test("L5: SPLASH_API_KEY with CR/LF/NUL/inner space/non-ASCII is rejected at load — the key is never echoed", () => {
  for (const bad of ["sk-abc\r\nX-Injected: 1", "sk-abc\ndef", "sk-abc\rdef", "sk-a\u0000b", "sk a", "sk-é", "sk-\u007f"]) {
    assert.throws(
      () => loadConfig({ SPLASH_API_KEY: bad }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "Invalid SPLASH_API_KEY: expected visible ASCII characters only (no whitespace or control characters)" &&
        !err.message.includes("sk-") && !err.message.includes("abc"),
      JSON.stringify(bad),
    );
  }
  // Görünür ASCII (0x21-0x7E) her karakter kabul edilir.
  const visible = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join("");
  assert.equal(loadConfig({ SPLASH_API_KEY: visible }).backend.apiKey, visible);
});
