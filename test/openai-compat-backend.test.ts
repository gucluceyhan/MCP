/**
 * OpenAICompatBackend testleri (Step 2).
 *
 * Runtime, 127.0.0.1:0 dinleyen sade bir `node:http` sunucusla taklit edilir;
 * her istek (metot, yol, header'lar, gövde) yakalanır ve test bazında hazır
 * (canned) JSON döndürülür. Gerçek modele hiç dokunulmaz.
 *
 * Testler BUILT çıktıyı (dist/) import eder: `npm test` önce build + test
 * derlemesini çalıştırır (pretest: dist/ ve dist-test/) ve `node --test`
 * dist-test/*.test.js dosyalarını çalıştırır — Node ≥20 yeterlidir, yerel
 * TypeScript strip'ine gerek yoktur. `tsconfig.test.json` bu dosyayı emit
 * edilmiş deklarasyon dosyaları (dist/*.d.ts) karşısında tip kontrolü yapar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatBackend } from "../dist/backend/OpenAICompatBackend.js";
import { BackendError } from "../dist/backend/errors.js";
import type { InferenceMessage, ReasoningEffort } from "../dist/backend/InferenceBackend.js";
import type { BackendConfig } from "../dist/config.js";

const MODEL = "test-model";

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
}

interface CannedResponse {
  status: number;
  body: unknown;
  /** Gövdenin gönderilmesinden önce beklenecek ms (in-flight senaryolar). */
  bodyDelayMs?: number;
  /** Header'lar gönderilir, sonra bu kadar ms'te soket YIKILIR (gövde asla bitmez). */
  destroyAfterMs?: number;
  /** `content-type` header değeri (varsayılan: `application/json`). */
  contentType?: string;
}

type Handler = (req: CapturedRequest) => CannedResponse;

interface MockRuntime {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** 127.0.0.1:0 üzerinde taklit runtime başlatır; her isteği yakalar. */
function startMockRuntime(handler: Handler): Promise<MockRuntime> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = body === "" ? undefined : JSON.parse(body);
      } catch {
        json = undefined;
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
        json,
      };
      requests.push(captured);
      const canned = handler(captured);
      res.writeHead(canned.status, {
        "content-type": canned.contentType ?? "application/json",
      });
      const payload = typeof canned.body === "string" ? canned.body : JSON.stringify(canned.body);
      // In-flight senaryolar: 200 header'ları derhal FLUSH edilir, gövde
      // gecikmeli gönderilir — böylece iptal gövde okuması SIRASINDA düşer.
      // Node http, writeHead ile header'ları flush ETMEZ (ölçüldü: fetch
      // ancak res.end anında, ~110 ms'te çözülmüştü); bu yüzden açık
      // flushHeaders zorunludur, yoksa iptal fetch aşamasına düşer ve
      // test yanlış dalı pin'ler.
      if (canned.bodyDelayMs !== undefined) {
        res.flushHeaders();
        setTimeout(() => res.end(payload), canned.bodyDelayMs);
      } else if (canned.destroyAfterMs !== undefined) {
        // Abort'siz read-error senaryosu: header'lar gönderilir, sonra
        // sunucu gövdenin ORTASINDA soketi yıkar — istemcinin text()
        // çağrısı non-abort bir hata ile reddedilir.
        res.flushHeaders();
        setTimeout(() => res.destroy(), canned.destroyAfterMs);
      } else {
        res.end(payload);
      }
    });
  });

  return new Promise<MockRuntime>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Mock runtime has no TCP address"));
        return;
      }
      const { port } = address as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err === undefined ? resolveClose() : rejectClose(err)));
            // Keep-alive soketlerini derhal kapat ki close() bekletmesin.
            server.closeIdleConnections();
          }),
      });
    });
  });
}

/** Bir çağrının `BackendError` ile reddedildiğini doğrular. */
async function expectBackendError(
  promise: Promise<unknown>,
  kind: BackendError["kind"],
  status?: number,
): Promise<BackendError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(
      err instanceof BackendError,
      `expected a BackendError, got: ${err instanceof Error ? err.message : String(err)}`,
    );
    assert.equal(err.kind, kind);
    if (status !== undefined) {
      assert.equal(err.status, status);
    }
    return err;
  }
  throw new Error("expected the call to reject");
}

function makeConfig(baseUrl: string, apiKey?: string): BackendConfig {
  return apiKey === undefined ? { baseUrl, model: MODEL } : { baseUrl, model: MODEL, apiKey };
}

/** Canlı runtime'ın /status gövdesine benzer: zorunlu alanlar + bilinmeyen ekler. */
const STATUS_OK = {
  schema_version: 5,
  ready: true,
  maximum_context_tokens: 262144,
  memory_pressure: "normal",
  admission: { state: "open", pending: 0 },
  identity: { model: MODEL, engine: "splash" },
  metrics: { requests: 1 },
};

const MODELS_OK = {
  object: "list",
  data: [{ id: MODEL, object: "model", created: 0, owned_by: "splash" }],
};

/** Canlı /v1/chat/completions gövdesi: tam + ek bilinmeyen alanlar. */
const CHAT_OK = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 123,
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "TAMAM", reasoning_content: "cogito..." },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  metrics: { latency_ms: 1 },
};

const MESSAGES: InferenceMessage[] = [
  { role: "system", content: "SYSTEM PROMPT" },
  { role: "user", content: "USER MESSAGE" },
];

// ── refreshRuntimeInfo ───────────────────────────────────────────────────

test("refreshRuntimeInfo: /status parses into RuntimeInfo and the cache is populated", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    if (req.path === "/v1/models") {
      return { status: 200, body: MODELS_OK };
    }
    return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const info = await backend.refreshRuntimeInfo();

  // Bilinmeyen ek alanlar kabul edilir; zorunlu alanlar normalize edilir.
  assert.deepEqual(info, { ready: true, maximumContextTokens: 262144, servedModel: MODEL });
  assert.equal(backend.runtimeInfo, info);
});

test("refreshRuntimeInfo: ready=false rejects invalid_status and never calls /v1/models", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: { ...STATUS_OK, ready: false } };
    }
    return { status: 200, body: MODELS_OK };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");

  assert.deepEqual(
    mock.requests.map((r) => r.path),
    ["/status"],
    "/v1/models must not be called when the runtime is not ready",
  );
  assert.equal(backend.runtimeInfo, null, "a failed refresh leaves the cache unset");
});

test("refreshRuntimeInfo: missing maximum_context_tokens rejects invalid_status", async (t) => {
  const { schema_version: _sv, ready: _r, ...withoutMax } = STATUS_OK;
  const mock = await startMockRuntime((req) =>
    req.path === "/status" ? { status: 200, body: withoutMax } : { status: 200, body: MODELS_OK },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");
  assert.equal(backend.runtimeInfo, null);
});

test("refreshRuntimeInfo: non-integer maximum_context_tokens rejects invalid_status", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/status"
      ? { status: 200, body: { ...STATUS_OK, maximum_context_tokens: "262144" } }
      : { status: 200, body: MODELS_OK },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");
  assert.equal(backend.runtimeInfo, null);
});

test("refreshRuntimeInfo: exact model match reports the configured model as servedModel", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/status"
      ? { status: 200, body: STATUS_OK }
      : { status: 200, body: MODELS_OK },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const info = await backend.refreshRuntimeInfo();
  assert.equal(info.servedModel, MODEL);
});

test("refreshRuntimeInfo: model mismatch rejects model_mismatch and preserves the previous good cache", async (t) => {
  let modelsCalls = 0;
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    modelsCalls += 1;
    // İkinci yenilemede runtime başka bir model sunuyor.
    return {
      status: 200,
      body:
        modelsCalls === 1
          ? MODELS_OK
          : { object: "list", data: [{ id: "some/other-model", object: "model" }] },
    };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const good = await backend.refreshRuntimeInfo();
  await expectBackendError(backend.refreshRuntimeInfo(), "model_mismatch");

  // Önceki iyi on-bellek dokunulmadan korunur (aynı nesne).
  assert.equal(backend.runtimeInfo, good);
  assert.deepEqual(backend.runtimeInfo, {
    ready: true,
    maximumContextTokens: 262144,
    servedModel: MODEL,
  });
});

test("refreshRuntimeInfo: /status non-2xx (503) rejects kind http with the status; the prior good cache is preserved", async (t) => {
  let statusCalls = 0;
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      statusCalls += 1;
      // İlk yenileme sağlıklı; ikincisinde runtime 503 döner.
      return statusCalls === 1
        ? { status: 200, body: STATUS_OK }
        : { status: 503, body: { error: { message: "runtime degraded" } } };
    }
    return { status: 200, body: MODELS_OK };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const good = await backend.refreshRuntimeInfo();
  const err = await expectBackendError(backend.refreshRuntimeInfo(), "http", 503);

  // message: YALNIZCA durum + uç; gövde fragmentı taşımaz.
  assert.equal(err.message, "Inference runtime returned HTTP 503 from /status");
  assert.ok(!err.message.includes("runtime degraded"), "no response body fragment");
  // Gövde detayı yalnız teknik `cause` kanalında.
  assert.equal(err.cause, "runtime degraded");
  // Başarısız yenileme önceki iyi on-belleği dokunmadan korunur (aynı nesne).
  assert.equal(backend.runtimeInfo, good);
  // /status 503 döndüğünde ikinci çağrı (/v1/models) hiç yapılmaz.
  assert.deepEqual(mock.requests.map((r) => r.path), ["/status", "/v1/models", "/status"]);
});

test("refreshRuntimeInfo: /v1/models non-2xx (500) rejects kind http with the status; the prior good cache is preserved", async (t) => {
  let modelsCalls = 0;
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    modelsCalls += 1;
    // İlk yenileme sağlıklı; ikincisinde model listesi 500 döner.
    return modelsCalls === 1
      ? { status: 200, body: MODELS_OK }
      : { status: 500, body: { error: { message: "model table unavailable" } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const good = await backend.refreshRuntimeInfo();
  const err = await expectBackendError(backend.refreshRuntimeInfo(), "http", 500);

  assert.equal(err.message, "Inference runtime returned HTTP 500 from /v1/models");
  assert.ok(!err.message.includes("model table unavailable"), "no response body fragment");
  assert.equal(err.cause, "model table unavailable");
  assert.equal(backend.runtimeInfo, good);
  assert.deepEqual(
    mock.requests.map((r) => r.path),
    ["/status", "/v1/models", "/status", "/v1/models"],
  );
});

test("refreshRuntimeInfo: /status 2xx with a non-JSON (text/html) body rejects invalid_response; the prior good cache is preserved", async (t) => {
  let statusCalls = 0;
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      statusCalls += 1;
      // İlk yenileme sağlıklı JSON; ikincisinde bir proxy HTML sayfası döndürür.
      return statusCalls === 1
        ? { status: 200, body: STATUS_OK }
        : { status: 200, body: "<html><body>gateway error</body></html>", contentType: "text/html" };
    }
    return { status: 200, body: MODELS_OK };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const good = await backend.refreshRuntimeInfo();
  const err = await expectBackendError(backend.refreshRuntimeInfo(), "invalid_response");

  assert.equal(err.message, "Response from /status was not valid JSON");
  assert.equal(backend.runtimeInfo, good, "a failed refresh leaves the good cache untouched");
});

test("refreshRuntimeInfo: /v1/models 2xx with a non-JSON (text/html) body rejects invalid_response; the prior good cache is preserved", async (t) => {
  let modelsCalls = 0;
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    modelsCalls += 1;
    return modelsCalls === 1
      ? { status: 200, body: MODELS_OK }
      : { status: 200, body: "<html><body>gateway error</body></html>", contentType: "text/html" };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const good = await backend.refreshRuntimeInfo();
  const err = await expectBackendError(backend.refreshRuntimeInfo(), "invalid_response");

  assert.equal(err.message, "Response from /v1/models was not valid JSON");
  assert.equal(backend.runtimeInfo, good, "a failed refresh leaves the good cache untouched");
});

test("refreshRuntimeInfo: /status body that is a JSON array or a bare string (not an object) rejects invalid_status", async () => {
  // (a) array; (b) çıplak JSON string'i. Not: harness string gövdeyi HAM
  // gönderdiği için (b) vakası önceden serileştirilmiş biçimde verilir —
  // telde `"ready"` (geçerli JSON, ama nesil değil) durur.
  const cases: CannedResponse[] = [
    { status: 200, body: [1, 2, 3] },
    { status: 200, body: JSON.stringify("ready") },
  ];
  for (const canned of cases) {
    const mock = await startMockRuntime((req) =>
      req.path === "/status" ? canned : { status: 200, body: MODELS_OK },
    );
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      const err = await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");
      assert.ok(err.message.includes("/status"), "the message must name the failing endpoint");
      assert.equal(backend.runtimeInfo, null, "a failed refresh leaves the cache unset");
    } finally {
      await mock.close();
    }
  }
});

test("refreshRuntimeInfo: zero, negative and fractional maximum_context_tokens each reject invalid_status", async () => {
  // Eksik (typeof) ve string (typeof) dalları mevcut testlerde; burada
  // `maximum <= 0` ve `!Number.isInteger` dalları pin'leniyor.
  const cases = [0, -5, 123.5];
  for (const maximum of cases) {
    const mock = await startMockRuntime((req) =>
      req.path === "/status"
        ? { status: 200, body: { ...STATUS_OK, maximum_context_tokens: maximum } }
        : { status: 200, body: MODELS_OK },
    );
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      const err = await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");
      assert.ok(err.message.includes("maximum_context_tokens"), "the message must name the field");
      assert.equal(backend.runtimeInfo, null);
    } finally {
      await mock.close();
    }
  }
});

test("refreshRuntimeInfo: /v1/models structural failures (object, data, entry) each reject invalid_status", async () => {
  const cases: { name: string; body: unknown; message: string }[] = [
    { name: "object !== 'list'", body: { object: "notalist", data: [{ id: MODEL }] }, message: "unexpected model list" },
    { name: "data not an array", body: { object: "list", data: { id: MODEL } }, message: "unexpected model list" },
    { name: "non-object entry", body: { object: "list", data: ["a-string"] }, message: "malformed model entry" },
    { name: "non-string id", body: { object: "list", data: [{ id: 123 }] }, message: "malformed model entry" },
  ];
  for (const { name, body, message } of cases) {
    const mock = await startMockRuntime((req) =>
      req.path === "/status" ? { status: 200, body: STATUS_OK } : { status: 200, body },
    );
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      const err = await expectBackendError(backend.refreshRuntimeInfo(), "invalid_status");
      assert.ok(err.message.includes(message), `${name}: message must carry the failing clause`);
      assert.ok(err.message.includes("/v1/models"), "the message must name the failing endpoint");
      assert.equal(backend.runtimeInfo, null);
    } finally {
      await mock.close();
    }
  }
});

// ── tokenize ─────────────────────────────────────────────────────────────

test("tokenize: ok returns tokens and count; body carries content and add_special", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path !== "/tokenize") {
      return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
    }
    return { status: 200, body: { tokens: [14556, 123] } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const result = await backend.tokenize("hello");

  assert.deepEqual(result, { tokens: [14556, 123], count: 2 });
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0]?.json, { content: "hello", add_special: false });
});

test("tokenize: malformed tokens each reject invalid_response", async () => {
  // (a) string, (b) eksik alan, (c) tam sayı olmayan giriş.
  const cases: Record<string, unknown>[] = [
    { tokens: "x" },
    { other: 1 },
    { tokens: [1, "2"] },
  ];
  for (const body of cases) {
    const mock = await startMockRuntime((req) => {
      if (req.path !== "/tokenize") {
        return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
      }
      return { status: 200, body };
    });
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      await expectBackendError(backend.tokenize("hello"), "invalid_response");
    } finally {
      await mock.close();
    }
  }
});

// ── renderPrompt / countPromptTokens ─────────────────────────────────────

test("renderPrompt: returns the prompt string; body carries messages; reasoning_effort only when provided", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path !== "/apply-template") {
      return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
    }
    return { status: 200, body: { prompt: "RENDERED PROMPT" } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));

  // Verilmediğinde anahtar gövdede YOK.
  const plain = await backend.renderPrompt(MESSAGES);
  assert.equal(plain, "RENDERED PROMPT");
  let body = mock.requests[0]?.json as Record<string, unknown>;
  assert.deepEqual(body.messages, MESSAGES);
  assert.ok(!("reasoning_effort" in body), "reasoning_effort must be absent when not provided");

  // Verildiğinde gövdede var.
  const withEffort = await backend.renderPrompt(MESSAGES, { reasoningEffort: "low" });
  assert.equal(withEffort, "RENDERED PROMPT");
  body = mock.requests[1]?.json as Record<string, unknown>;
  assert.equal(body.reasoning_effort, "low");
});

test("renderPrompt: malformed prompt rejects invalid_response", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/apply-template" ? { status: 200, body: { prompt: 42 } } : { status: 500, body: {} },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.renderPrompt(MESSAGES), "invalid_response");
});

test("renderPrompt: empty messages reject invalid_request without any network call", async (t) => {
  const mock = await startMockRuntime(() => ({ status: 200, body: { prompt: "x" } }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.renderPrompt([]), "invalid_request");
  assert.equal(mock.requests.length, 0, "no round trip for an empty request");
});

test("run/renderPrompt: non-whitelisted reasoningEffort rejects invalid_request", async (t) => {
  const mock = await startMockRuntime((req) => ({ status: 200, body: CHAT_OK }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  // Tip'siz veri simülasyonu: TS birleşik tipinin ötesinden geçiyor.
  const bogus = "ultra" as unknown as ReasoningEffort;
  await expectBackendError(backend.run(MESSAGES, { reasoningEffort: bogus }), "invalid_request");
  await expectBackendError(backend.renderPrompt(MESSAGES, { reasoningEffort: bogus }), "invalid_request");
  assert.equal(mock.requests.length, 0, "no round trip for an invalid effort");
});

test("countPromptTokens: exactly two calls in order (/apply-template then /tokenize) and returns the count", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path === "/apply-template") {
      return { status: 200, body: { prompt: "RENDERED PROMPT" } };
    }
    if (req.path === "/tokenize") {
      return { status: 200, body: { tokens: [1, 2, 3] } };
    }
    return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const count = await backend.countPromptTokens(MESSAGES, { reasoningEffort: "low" });

  assert.equal(count, 3);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0]?.path, "/apply-template");
  assert.equal(mock.requests[1]?.path, "/tokenize");
  const templateBody = mock.requests[0]?.json as Record<string, unknown>;
  assert.deepEqual(templateBody.messages, MESSAGES);
  assert.equal(templateBody.reasoning_effort, "low");
  const tokenizeBody = mock.requests[1]?.json as Record<string, unknown>;
  assert.deepEqual(tokenizeBody, { content: "RENDERED PROMPT", add_special: false });
});

test("countPromptTokens: when renderPrompt fails the chain stops — /tokenize is never called", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path === "/apply-template") {
      return { status: 500, body: { error: { message: "template render failed" } } };
    }
    if (req.path === "/tokenize") {
      return { status: 200, body: { tokens: [1] } };
    }
    return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const err = await expectBackendError(backend.countPromptTokens(MESSAGES), "http", 500);

  assert.equal(err.cause, "template render failed");
  // Zincir render'da durdu: ikinci gidiş-dönüş (/tokenize) asla yapılmadı.
  assert.deepEqual(
    mock.requests.map((r) => r.path),
    ["/apply-template"],
    "/tokenize must not be called after a failed renderPrompt",
  );
});

// ── run ──────────────────────────────────────────────────────────────────

test("run: body carries model, stream:false and mapped messages; result is normalized", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/v1/chat/completions" ? { status: 200, body: CHAT_OK } : { status: 404, body: {} },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const result = await backend.run(MESSAGES);

  const body = mock.requests[0]?.json as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, MESSAGES);

  // Canlı runtime'ın ek alanları (metrics, *_details) kabul edilir.
  assert.deepEqual(result, {
    content: "TAMAM",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });
});

test("run: max_completion_tokens is present only when maxOutputTokens is provided", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/v1/chat/completions" ? { status: 200, body: CHAT_OK } : { status: 404, body: {} },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await backend.run(MESSAGES);
  let body = mock.requests[0]?.json as Record<string, unknown>;
  assert.ok(!("max_completion_tokens" in body), "must be absent when not provided");

  await backend.run(MESSAGES, { maxOutputTokens: 1000 });
  body = mock.requests[1]?.json as Record<string, unknown>;
  assert.equal(body.max_completion_tokens, 1000);
});

test("run: reasoning_effort is present only when reasoningEffort is provided", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/v1/chat/completions" ? { status: 200, body: CHAT_OK } : { status: 404, body: {} },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await backend.run(MESSAGES);
  let body = mock.requests[0]?.json as Record<string, unknown>;
  assert.ok(!("reasoning_effort" in body), "must be absent when not provided");

  await backend.run(MESSAGES, { reasoningEffort: "low" });
  body = mock.requests[1]?.json as Record<string, unknown>;
  assert.equal(body.reasoning_effort, "low");
});

test("run: usage normalization with and without total_tokens", async (t) => {
  const mock = await startMockRuntime((req) => {
    if (req.path !== "/v1/chat/completions") {
      return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
    }
    const body = { ...CHAT_OK };
    // İkinci istekte runtime total_tokens raporlamaz.
    if (req === mock.requests[1]) {
      const usage = body.usage as Record<string, unknown>;
      delete usage.total_tokens;
    }
    return { status: 200, body };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));

  const withTotal = await backend.run(MESSAGES);
  assert.deepEqual(withTotal.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });

  const withoutTotal = await backend.run(MESSAGES);
  assert.equal(withoutTotal.usage.inputTokens, 11);
  assert.equal(withoutTotal.usage.outputTokens, 7);
  assert.equal(withoutTotal.usage.totalTokens, undefined);
});

/** run() gövde/bağlam hataları: her sarkan senaryo `invalid_response` ile reddedilir. */
const MALFORMED_RUN_CASES: { name: string; body: unknown }[] = [
  { name: "empty choices", body: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  { name: "missing usage", body: { choices: [{ index: 0, message: { role: "assistant", content: "x" } }] } },
  {
    name: "content null",
    body: {
      choices: [{ index: 0, message: { role: "assistant", content: null } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  },
  {
    name: "content non-string",
    body: {
      choices: [{ index: 0, message: { role: "assistant", content: 123 } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  },
  {
    name: "missing message",
    body: { choices: [{ index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  {
    name: "negative usage",
    body: {
      choices: [{ index: 0, message: { role: "assistant", content: "x" } }],
      usage: { prompt_tokens: -5, completion_tokens: 1 },
    },
  },
  {
    name: "non-object top level",
    body: "just a string",
  },
];

for (const { name, body } of MALFORMED_RUN_CASES) {
  test(`run: malformed response (${name}) rejects invalid_response`, async (t) => {
    const mock = await startMockRuntime((req) =>
      req.path === "/v1/chat/completions"
        ? { status: 200, body }
        : { status: 404, body: { error: { message: `unexpected path ${req.path}` } } },
    );
    t.after(() => mock.close());

    const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
    await expectBackendError(backend.run(MESSAGES), "invalid_response");
  });
}

test("run: HTTP 500 — message is fragment-free; the body detail travels in cause only", async (t) => {
  // 500 karakterlik detay: hem 'message'a sızmayacak kadar uzun hem de
  // truncation'ın (≤200) doğrulanmasına elverişli.
  const longDetail = `internal error: response-side-detail-marker ${"x".repeat(500)}`;
  const mock = await startMockRuntime(() => ({
    status: 500,
    body: { error: { message: longDetail } },
  }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const err = await expectBackendError(backend.run(MESSAGES), "http", 500);

  // (a) message: YALNIZCA durum + uç. NE istek NE yanıt içeriği taşır (DESIGN.md 9).
  assert.equal(err.message, "Inference runtime returned HTTP 500 from /v1/chat/completions");
  assert.ok(!err.message.includes("USER MESSAGE"), "request content must not leak");
  assert.ok(!err.message.includes("SYSTEM PROMPT"), "request content must not leak");
  assert.ok(!err.message.includes("response-side-detail-marker"), "no response body fragment");
  assert.ok(!err.message.includes("xxx"), "no response body fragment");

  // (b) cause: ≤200 karakterlik truncasyon — ve tam beklenen kırpma.
  assert.equal(err.cause, longDetail.slice(0, 200));
  assert.equal(typeof err.cause, "string");
  assert.ok((err.cause as string).startsWith("internal error: response-side-detail-marker"));
});

test("run: empty messages reject invalid_request without any network call", async (t) => {
  const mock = await startMockRuntime((req) => ({ status: 200, body: CHAT_OK }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await expectBackendError(backend.run([]), "invalid_request");
  assert.equal(mock.requests.length, 0, "no round trip for an empty request");
});

// ── HTTP hata detayı (extractHttpDetail) ─────────────────────────────────

test("http error detail: top-level message, truncation boundary, and unparseable body all travel in cause only", async () => {
  const exactly200 = "E".repeat(200);
  const twoHundredOne = "F".repeat(201);
  const cases: { name: string; status: number; body: unknown; expectedCause: string | undefined }[] = [
    // `error` sarmalayıcısı YOK: üst düzey `message` alanı cause detayı olur.
    { name: "top-level message without error wrapper", status: 400, body: { message: "boom" }, expectedCause: "boom" },
    // Sınır: tam 200 karakter KESİLMEZ (truncateSafe yalnız >200'de kırparsa).
    { name: "exactly 200 chars stays intact", status: 500, body: { error: { message: exactly200 } }, expectedCause: exactly200 },
    // 201 karakter → ilk 200 karaktere kırpılır.
    { name: "201 chars truncated to the first 200", status: 500, body: { error: { message: twoHundredOne } }, expectedCause: twoHundredOne.slice(0, 200) },
    // Parse edilemeyen gövde (örn. proxy'nin HTML hatası) → cause YOK.
    { name: "unparseable body yields no cause", status: 502, body: "<!doctype html>no json here", expectedCause: undefined },
  ];
  for (const { name, status, body, expectedCause } of cases) {
    const mock = await startMockRuntime(() => ({ status, body }));
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      const err = await expectBackendError(backend.run(MESSAGES), "http", status);
      // message her vakada yalnız durum + uç; gövde fragmentı asla taşımaz.
      assert.equal(err.message, `Inference runtime returned HTTP ${status} from /v1/chat/completions`);
      assert.equal(err.cause, expectedCause, name);
    } finally {
      await mock.close();
    }
  }
});

// ── baseUrl biçimleri ────────────────────────────────────────────────────

test("baseUrl with a trailing slash: requests still land on the exact absolute endpoint paths", async (t) => {
  // v1 kararı (DESIGN.md 2.5): path prefix'li base URL'ler config
  // KATMANINDA (readUrl) reddedilir — prefix'in adaptörde sessizce atılması
  // senaryosu artık config load'da açık hatadır, burada pin'lenemez.
  // Adaptör düzeyinde kalan tek anlamlı biçim kök slash'tır:
  // `new URL("/status", "http://host/")` yine tam `/status`'e düşer.
  // (Direkt BackendConfig, loadConfig'i atlatır — bu test yalnız adaptörün
  // URL çözümleme davranışını sabitler.)
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    if (req.path === "/v1/models") {
      return { status: 200, body: MODELS_OK };
    }
    // Beklenmedik bir yola düşerse (örn. çift slash) 404 → red.
    return { status: 404, body: { error: { message: `unexpected path ${req.path}` } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend({ baseUrl: `${mock.baseUrl}/`, model: MODEL });
  await backend.refreshRuntimeInfo();
  assert.deepEqual(
    mock.requests.map((r) => r.path),
    ["/status", "/v1/models"],
    "requests must land on the exact absolute paths",
  );
});

// ── API key / hata güvenliği ─────────────────────────────────────────────

test("apiKey set: Authorization Bearer header on POSTs; absent when unset", async (t) => {
  const key = "sk-test-should-never-leak";
  const mock = await startMockRuntime((req) => {
    if (req.path === "/tokenize") {
      return { status: 200, body: { tokens: [1] } };
    }
    if (req.path === "/status") {
      return { status: 200, body: STATUS_OK };
    }
    return { status: 200, body: MODELS_OK };
  });
  t.after(() => mock.close());

  const withKey = new OpenAICompatBackend(makeConfig(mock.baseUrl, key));
  await withKey.tokenize("hello");
  await withKey.refreshRuntimeInfo();

  const authed = mock.requests.map((r) => r.headers.authorization);
  assert.deepEqual(authed, [
    `Bearer ${key}`,
    `Bearer ${key}`,
    `Bearer ${key}`,
  ]);

  const withoutKey = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await withoutKey.tokenize("hello");
  assert.equal(mock.requests[3]?.headers.authorization, undefined);
});

test("error messages never contain the API key", async (t) => {
  const key = "sk-test-should-never-leak";
  const mock = await startMockRuntime(() => ({
    status: 500,
    body: { error: { message: "internal error" } },
  }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl, key));
  const err = await expectBackendError(backend.tokenize("hello"), "http", 500);
  assert.ok(!err.message.includes(key), "the key must never appear in the message");
  assert.ok(!String(err.cause ?? "").includes(key), "the key must never appear in the cause");
});

test("http error detail: a key reflected in the error body is redacted — it appears in NEITHER message NOR cause", async (t) => {
  // Tehdit modeli: runtime/proxy, gönderilen bearer token'ı hata gövdesine
  // yansıtıyor (örn. geçersiz token yanıtı). Detay `cause` kanalına geçtiği
  // için anahtar burada `[REDACTED]` ile değiştirilmiş olmalı.
  const key = "sk-test-secret-should-never-leak";
  const mock = await startMockRuntime(() => ({
    status: 401,
    body: { error: { message: `invalid token ${key}` } },
  }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl, key));
  const err = await expectBackendError(backend.run(MESSAGES), "http", 401);

  assert.ok(!err.message.includes(key), "the key must never appear in the message");
  assert.ok(!String(err.cause ?? "").includes(key), "the key must never appear in the cause");
  // Detay hâlâ taşınır; anahtarın yerinde redaksiyon işareti durur.
  assert.equal(err.cause, "invalid token [REDACTED]");
});

test("http error detail (audit S9): a key reflected in the error body is redacted on both GET endpoints (/status, /v1/models)", async () => {
  // Tehdit modeli: runtime/proxy, gönderilen bearer token'ı hata gövdesine
  // yansıtıyor (örn. geçersiz token yanıtı). Redaksiyon, `requestJson`'in
  // TEK 2xx-dışı dalında yaşar ve tüm uçlarla paylaşıldığı halde mevcut
  // test yalnız POST /v1/chat/completions üzerinden pin'liyordu; GET uçlar
  // açıkça pin'sizdi (audit S9). Burası o boşluğu kapatır.
  const key = "sk-test-secret-should-never-leak";
  const endpoints = ["/status", "/v1/models"] as const;
  for (const endpoint of endpoints) {
    const mock = await startMockRuntime((req) => {
      if (req.path === endpoint) {
        return { status: 401, body: { error: { message: `invalid token ${key}` } } };
      }
      // Hedef uç dışındaki çağrı sağlıklı döner. /status vakasında zincir
      // 401'de durur; /v1/models vakasında önce /status 200'ını görürüz.
      return req.path === "/status" ? { status: 200, body: STATUS_OK } : { status: 200, body: MODELS_OK };
    });
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl, key));
      const err = await expectBackendError(backend.refreshRuntimeInfo(), "http", 401);

      assert.equal(err.message, `Inference runtime returned HTTP 401 from ${endpoint}`);
      assert.ok(!err.message.includes(key), "the key must never appear in the message");
      assert.ok(!String(err.cause ?? "").includes(key), "the key must never appear in the cause");
      // Tehdit gerçekten yürütüldü: anahtar telde (Bearer) gitti.
      assert.equal(
        mock.requests[mock.requests.length - 1]?.headers.authorization,
        `Bearer ${key}`,
        "the failing GET must carry the configured key",
      );
      // Detay hâlâ taşınır; anahtarın yerinde redaksiyon işareti durur.
      assert.ok(
        String(err.cause ?? "").includes("[REDACTED]"),
        "the redaction marker must stand where the key was",
      );
      assert.equal(err.cause, "invalid token [REDACTED]");
    } finally {
      await mock.close();
    }
  }
});

// ── contextTier ──────────────────────────────────────────────────────────

test("contextTier: larger than the known maximum rejects invalid_request and never reaches the wire", async (t) => {
  const smallStatus = { ready: true, maximum_context_tokens: 1000 };
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: smallStatus };
    }
    if (req.path === "/v1/models") {
      return { status: 200, body: MODELS_OK };
    }
    return { status: 200, body: CHAT_OK };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await backend.refreshRuntimeInfo();
  await expectBackendError(backend.run(MESSAGES, { contextTier: 2000 }), "invalid_request");

  assert.ok(
    !mock.requests.some((r) => r.path === "/v1/chat/completions"),
    "an invalid contextTier must not send a request",
  );
});

test("contextTier: valid tier is accepted and never appears in the request body", async (t) => {
  const smallStatus = { ready: true, maximum_context_tokens: 1000 };
  const mock = await startMockRuntime((req) => {
    if (req.path === "/status") {
      return { status: 200, body: smallStatus };
    }
    if (req.path === "/v1/models") {
      return { status: 200, body: MODELS_OK };
    }
    return { status: 200, body: CHAT_OK };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  await backend.refreshRuntimeInfo();
  const result = await backend.run(MESSAGES, { contextTier: 512 });

  assert.ok(result.content.length > 0);
  const runBody = mock.requests.find((r) => r.path === "/v1/chat/completions")?.json as Record<
    string,
    unknown
  >;
  assert.ok(!("contextTier" in runBody), "caller metadata must not be sent");
  assert.ok(!("context_tier" in runBody), "caller metadata must not be sent (snake_case)");
});

// ── network / abort ──────────────────────────────────────────────────────

/** Bir kapalı port numarası almak için sunucu aç-kapa. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address for closed-port probe");
  }
  const { port } = address as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("network failure (closed port) rejects kind network with a safe message", async () => {
  const port = await closedPort();
  const backend = new OpenAICompatBackend(makeConfig(`http://127.0.0.1:${port}`));

  const err = await expectBackendError(
    backend.run(MESSAGES),
    "network",
  );
  // Mesaj ucu (path) belirtir; tam URL / credential ASLA basılmaz.
  assert.ok(err.message.includes("/v1/chat/completions"));
  assert.ok(!err.message.includes("sk-"), "no credentials may leak");
});

test("aborted signal (aborted before the call) rejects a safe error and does not hang", async (t) => {
  const mock = await startMockRuntime((req) => ({ status: 200, body: CHAT_OK }));
  t.after(() => mock.close());
  const controller = new AbortController();
  controller.abort();

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const err = await expectBackendError(
    // Asla takılmasın: güvenlik ceketi (2 sn) ile yarışma.
    Promise.race([
      backend.run(MESSAGES, { signal: controller.signal }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test hung")), 2000)),
    ]),
    "network",
  );
  assert.ok(err.message.includes("aborted"));
  assert.equal(mock.requests.length, 0, "an aborted call must not hit the wire");
});

test("aborted DURING the body read maps to network/aborted, not invalid_response", async (t) => {
  // Tel sırası: 200 header'ları derhal flush edilir (harness), gövde 100 ms
  // gecikmeli gönderilir; iptal 30 ms'te gelir — fetch çözülmüştür, gövde
  // hâlâ streaming'dedir, yani iptal response.text() okuması ORTASINDA
  // düşer ve gövde-okuma catch dalından (isAbort → network/aborted)
  // çıkmalıdır.
  const mock = await startMockRuntime((req) => ({
    status: 200,
    body: { tokens: [1] },
    bodyDelayMs: 100,
  }));
  t.after(() => mock.close());

  const controller = new AbortController();
  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const pending = backend.tokenize("hello", { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);

  const err = await expectBackendError(
    // Asla takılmasın: güvenlik ceketi (3 sn) ile yarışma.
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("test hung")), 3000)),
    ]),
    "network",
  );
  assert.ok(err.message.includes("aborted"), `message says aborted (got: ${err.message})`);
});

test("socket destroyed mid-body WITHOUT a client abort rejects invalid_response (non-abort read-error path)", async (t) => {
  // Tel sırası: 200 header'ları derhal flush edilir; 50 ms'te sunucu
  // soketi YIKAR — istemcide iptal YOK, gövde okuması non-abort bir hata
  // ile reddedilir. Adaptor gövdeyi boş sayar; boş 2xx gövde JSON parse'ında
  // kırılır → invalid_response. (In-flight iptal testinin pin'lediği
  // catch dalının diğer kolunu pin'ler: isAbort=false yolunu.)
  const mock = await startMockRuntime((req) => ({
    status: 200,
    body: { tokens: [1] },
    destroyAfterMs: 50,
  }));
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const err = await expectBackendError(
    // Asla takılmasın: güvenlik ceketi (3 sn) ile yarışma.
    Promise.race([
      backend.tokenize("hello"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test hung")), 3000)),
    ]),
    "invalid_response",
  );
  assert.equal(err.message, "Response from /tokenize was not valid JSON");
});
