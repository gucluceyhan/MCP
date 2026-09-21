/**
 * Config testleri (Step 2): `SPLASH_API_KEY` okuma kuralları + mevcut
 * varsayılanların korunması. `loadConfig` deterministiktir: verilen env
 * eşleşmesinin saf fonksiyonudur — testler saf env nesneleri gönderir.
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
