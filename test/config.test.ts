/**
 * Config testleri (Step 2): `SPLASH_API_KEY` okuma kuralları, base URL
 * köken (origin) kuralı ve mevcut varsayılanların korunması. `loadConfig`
 * deterministiktir: verilen env eşleşmesinin saf fonksiyonudur — testler
 * saf env nesneleri gönderir.
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

test("base URL: a non-root path prefix is rejected at config load", () => {
  assert.throws(
    () => loadConfig({ SPLASH_BACKEND_BASE_URL: "http://127.0.0.1:8000/proxy" }),
    /SPLASH_BACKEND_BASE_URL/,
  );
});

test("base URL: an https path prefix is rejected at config load", () => {
  assert.throws(() => loadConfig({ SPLASH_BACKEND_BASE_URL: "https://example.com/api" }), /SPLASH_BACKEND_BASE_URL/);
});

test("base URL: a query string is rejected at config load", () => {
  assert.throws(() => loadConfig({ SPLASH_BACKEND_BASE_URL: "https://example.com/?x=1" }), /SPLASH_BACKEND_BASE_URL/);
});

test("base URL: a fragment is rejected at config load", () => {
  assert.throws(() => loadConfig({ SPLASH_BACKEND_BASE_URL: "https://example.com/#fragment" }), /SPLASH_BACKEND_BASE_URL/);
});

test("base URL: embedded userinfo (user:pass@ and user@) is rejected at config load", () => {
  for (const value of ["http://user:pass@127.0.0.1:8000", "http://user@127.0.0.1:8000"]) {
    assert.throws(() => loadConfig({ SPLASH_BACKEND_BASE_URL: value }), /SPLASH_BACKEND_BASE_URL/);
  }
});

test("base URL: a double-slash path ('//') is non-root and rejected at config load", () => {
  assert.throws(
    () => loadConfig({ SPLASH_BACKEND_BASE_URL: "http://host:8000//" }),
    /SPLASH_BACKEND_BASE_URL/,
  );
});

test("base URL: an uppercase scheme+host is accepted and lowercased to the canonical origin", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "HTTP://HOST" });
  assert.equal(config.backend.baseUrl, "http://host");
});

test("base URL: an IPv6 bracket origin round-trips to itself", () => {
  const config = loadConfig({ SPLASH_BACKEND_BASE_URL: "http://[::1]:8000" });
  assert.equal(config.backend.baseUrl, "http://[::1]:8000");
});
