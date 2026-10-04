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
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  MEASUREMENT_REQUEST_TIMEOUT_MS,
  OpenAICompatBackend,
  createNodeHttpTransport,
  type RuntimeHttpRequest,
} from "../dist/backend/OpenAICompatBackend.js";
import { InferenceCoordinator } from "../dist/backend/InferenceCoordinator.js";
import { INFERENCE_LOCK_DIR } from "../dist/backend/RuntimeLock.js";
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

// ── runtimeProcessId (Step 3: yapılandırılmış runtime kimliği) ─────────

/** Resmi /status biçimi: zorunlu alanlar + identity bloğu. */
const STATUS_WITH_INSTANCE = {
  ...STATUS_OK,
  instance: {
    id: "opaque-runtime-instance",
    pid: 12345,
    model: MODEL,
    host: "127.0.0.1",
    port: 8000,
  },
};

test("refreshRuntimeInfo: a valid instance.pid is surfaced as runtimeProcessId; the raw instance is NOT exposed", async (t) => {
  const mock = await startMockRuntime((req) =>
    req.path === "/status" ? { status: 200, body: STATUS_WITH_INSTANCE } : { status: 200, body: MODELS_OK },
  );
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const info = await backend.refreshRuntimeInfo();

  assert.deepEqual(info, {
    ready: true,
    maximumContextTokens: 262144,
    servedModel: MODEL,
    runtimeProcessId: 12345,
  });
  // deepStrictEqual aynı anahtar SETİNİ de pin'ler: ham `instance`
  // nesnesi (ya da herhangi bir ek alan) burada görünemez.
  assert.equal(backend.runtimeInfo, info);
});

test("refreshRuntimeInfo: a malformed instance.pid is NOT trusted — the property is omitted (not undefined) and the refresh still succeeds", async () => {
  const cases: { name: string; instance: unknown }[] = [
    { name: "string pid", instance: { id: "x", pid: "12345" } },
    { name: "zero pid", instance: { id: "x", pid: 0 } },
    { name: "negative pid", instance: { id: "x", pid: -5 } },
    { name: "fractional pid", instance: { id: "x", pid: 123.5 } },
    { name: "missing pid", instance: { id: "x" } },
    { name: "non-object instance", instance: "instance" },
    { name: "null instance", instance: null },
  ];
  for (const { name, instance } of cases) {
    const mock = await startMockRuntime((req) =>
      req.path === "/status"
        ? { status: 200, body: { ...STATUS_OK, instance } }
        : { status: 200, body: MODELS_OK },
    );
    try {
      const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
      const info = await backend.refreshRuntimeInfo();
      assert.equal(info.ready, true, `${name}: the refresh still succeeds`);
      assert.ok(
        !("runtimeProcessId" in info),
        `${name}: the property must be ABSENT, not explicitly undefined`,
      );
      assert.deepEqual(
        info,
        { ready: true, maximumContextTokens: 262144, servedModel: MODEL },
        name,
      );
    } finally {
      await mock.close();
    }
  }
});

test("refreshRuntimeInfo: the identity follows the runtime — a pid change is picked up on the next refresh", async (t) => {
  let statusCalls = 0;
  const instance = STATUS_WITH_INSTANCE.instance;
  const mock = await startMockRuntime((req) => {
    if (req.path !== "/status") {
      return { status: 200, body: MODELS_OK };
    }
    statusCalls += 1;
    // Runtime yeniden başladı: yeni PID raporluyor.
    return { status: 200, body: { ...STATUS_OK, instance: { ...instance, pid: statusCalls === 1 ? 111 : 222 } } };
  });
  t.after(() => mock.close());

  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const first = await backend.refreshRuntimeInfo();
  assert.equal(first.runtimeProcessId, 111);
  const second = await backend.refreshRuntimeInfo();
  assert.equal(second.runtimeProcessId, 222, "the refreshed identity must follow the runtime");
  assert.equal(backend.runtimeInfo, second);
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

// ── İz 2 inceleme düzeltmeleri (H1 / L1 / L3 / L4 / L5) ──────────────────

/**
 * Node'un yerleşik `fetch`'i (undici) varsayılan Agent'ı `headersTimeout` /
 * `bodyTimeout` = 300 sn ile kurar (ölçüldü: başlığı 320 sn geciktiren yerel
 * sunucuda global fetch 300.99 sn'de `UND_ERR_HEADERS_TIMEOUT` ile düştü).
 * 300 sn beklemek yerine global dispatcher'ı geçici olarak KÜÇÜLTÜLMÜŞ
 * zaman aşımlı bir Agent'la değiştiririz: adaptörün runtime çağrıları bu
 * varsayılandan ETKİLENMEMELİDİR (sözleşme: transport zaman aşımı YOK; iptal
 * yalnız caller'ın sinyali).
 */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

async function withShrunkGlobalFetchTimeouts(ms: number, fn: () => Promise<void>): Promise<void> {
  // Yerleşik undici tembel yüklenir: bir data: isteği global Agent'ı kurar.
  await (await fetch("data:,warm")).text();
  const holder = globalThis as unknown as Record<symbol, { constructor: new (o: object) => { close(): Promise<void> } }>;
  const previous = holder[UNDICI_GLOBAL_DISPATCHER];
  assert.ok(previous !== undefined, "the built-in fetch must expose its global dispatcher");
  const Agent = previous.constructor;
  const shrunk = new Agent({ headersTimeout: ms, bodyTimeout: ms });
  holder[UNDICI_GLOBAL_DISPATCHER] = shrunk as unknown as (typeof holder)[symbol];
  try {
    await fn();
  } finally {
    holder[UNDICI_GLOBAL_DISPATCHER] = previous;
    await shrunk.close();
  }
}

/** Başlıkları ya da gövdeyi geciktiren yerel sunucu (H1). */
async function startDelayingServer(
  mode: "headers" | "body",
  delayMs: number,
  body: unknown,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const payload = JSON.stringify(body);
      if (mode === "headers") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(payload);
        }, delayMs);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        setTimeout(() => res.end(payload), delayMs);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test("H1: a generation that withholds the response headers longer than the fetch default still completes (no transport timeout)", async (t) => {
  // undici zaman aşımları ~1 sn çözünürlüklü "fast timer" kullanır (ölçüldü:
  // 100 ms'ye küçültülmüş tavan ~1005 ms'de tetiklendi) — gecikme bunun üstünde.
  const server = await startDelayingServer("headers", 2_000, CHAT_OK);
  t.after(() => server.close());
  await withShrunkGlobalFetchTimeouts(100, async () => {
    // Kontrol (LOW-6): küçültülmüş tavan GERÇEKTEN etkin — ham fetch düşer;
    // aksi hâlde aşağıdaki başarı hiçbir şey kanıtlamazdı.
    await assert.rejects(
      fetch(`${server.baseUrl}/v1/chat/completions`, { method: "POST", body: "{}" }),
      (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === "UND_ERR_HEADERS_TIMEOUT",
    );
    const backend = new OpenAICompatBackend(makeConfig(server.baseUrl));
    const result = await backend.run(MESSAGES);
    assert.equal(result.content, "TAMAM");
  });
});

test("H1: a response body that arrives later than the fetch body default still completes (no transport timeout)", async (t) => {
  const server = await startDelayingServer("body", 2_000, { tokens: [1, 2, 3] });
  t.after(() => server.close());
  await withShrunkGlobalFetchTimeouts(100, async () => {
    // Kontrol (LOW-6): ham fetch'in gövde okuması küçültülmüş tavanda düşer.
    const raw = await fetch(`${server.baseUrl}/tokenize`, { method: "POST", body: "{}" });
    await assert.rejects(raw.text(), (err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return e.code === "UND_ERR_BODY_TIMEOUT" || e.cause?.code === "UND_ERR_BODY_TIMEOUT";
    });
    const backend = new OpenAICompatBackend(makeConfig(server.baseUrl));
    const result = await backend.tokenize("hello");
    assert.equal(result.count, 3);
  });
});

test("H1: an injected transport's timeout error maps to an honest 'timed out' network message; cause carries only the code", async () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]) {
    // fetch tarzı sarmalama: TypeError("fetch failed") + cause.code
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), { code }),
    });
    const backend = new OpenAICompatBackend(makeConfig("http://127.0.0.1:9"), {
      transport: async () => {
        throw wrapped;
      },
    });
    const err = await expectBackendError(backend.run(MESSAGES), "network");
    assert.equal(err.message, "Timed out waiting for the inference runtime (/v1/chat/completions)", code);
    assert.equal(err.cause, code);
  }
  // Gövde okuması SIRASINDA zaman aşımı da dürüst mesaj (boş gövde → "invalid JSON" DEĞİL).
  const backend = new OpenAICompatBackend(makeConfig("http://127.0.0.1:9"), {
    transport: async () => ({
      status: 200,
      text: async () => {
        throw Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" });
      },
    }),
  });
  const err = await expectBackendError(backend.tokenize("x"), "network");
  assert.equal(err.message, "Timed out waiting for the inference runtime (/tokenize)");
  assert.equal(err.cause, "UND_ERR_BODY_TIMEOUT");
});

test("H1: the injected transport receives the exact request (url, method, headers, body, signal)", async () => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }> = [];
  const controller = new AbortController();
  const backend = new OpenAICompatBackend(makeConfig("http://127.0.0.1:9", "k-1"), {
    transport: async (request) => {
      seen.push({ ...request, url: request.url.href });
      return { status: 200, text: async () => JSON.stringify({ tokens: [7] }) };
    },
  });
  const result = await backend.tokenize("abc", { signal: controller.signal });
  assert.equal(result.count, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "http://127.0.0.1:9/tokenize");
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.headers["authorization"], "Bearer k-1");
  assert.equal(seen[0]?.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0]?.body ?? "null"), { content: "abc", add_special: false });
  assert.equal(seen[0]?.signal, controller.signal);
});

test("L4: a 307/308 redirect is NOT followed — the prompt never reaches another origin; typed http error", async (t) => {
  const captured: string[] = [];
  const other = await startMockRuntime((req) => {
    captured.push(req.body);
    return { status: 200, body: CHAT_OK };
  });
  t.after(() => other.close());
  for (const status of [307, 308]) {
    const redirecting = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, { location: `${other.baseUrl}/v1/chat/completions` });
        res.end();
      });
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", () => resolve()));
    const { port } = redirecting.address() as AddressInfo;
    try {
      const backend = new OpenAICompatBackend(makeConfig(`http://127.0.0.1:${port}`, "k-redirect"));
      await expectBackendError(backend.run(MESSAGES), "http", status);
    } finally {
      await new Promise<void>((resolve) => {
        redirecting.close(() => resolve());
        redirecting.closeAllConnections();
      });
    }
  }
  assert.deepEqual(captured, [], "the redirect target must never receive the prompt");
});

test("L4: a response body larger than the cap is rejected (2xx → invalid_response; non-2xx → http without detail)", async (t) => {
  const big = { tokens: Array.from({ length: 2_000 }, (_, i) => i) };
  const mock = await startMockRuntime((req) =>
    req.path === "/tokenize"
      ? { status: 200, body: big }
      : { status: 500, body: { error: { message: "x".repeat(4_000) } } },
  );
  t.after(() => mock.close());
  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl), { maxResponseBytes: 1_024 });
  const err = await expectBackendError(backend.tokenize("x"), "invalid_response");
  assert.equal(err.message, "Response from /tokenize exceeded the size limit");
  assert.equal(err.cause, undefined);
  const httpErr = await expectBackendError(backend.renderPrompt(MESSAGES), "http", 500);
  assert.equal(httpErr.cause, undefined, "an oversized error body yields no detail");
  // Varsayılan tavan aynı yanıtları kabul eder (yalnız sınır aşımı reddedilir).
  const roomy = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  assert.equal((await roomy.tokenize("x")).count, 2_000);
});

test("L1: finish_reason 'length' is a typed output_truncated error — never a normal result or 'invalid JSON'", async (t) => {
  const truncated = (content: unknown) => ({
    ...CHAT_OK,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "length" }],
  });
  let next: unknown = truncated('{"schema_version":1,"summary":"half');
  const mock = await startMockRuntime(() => ({ status: 200, body: next }));
  t.after(() => mock.close());
  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  const err = await expectBackendError(backend.run(MESSAGES), "output_truncated");
  assert.equal(
    err.message,
    "Inference output budget exhausted before the response completed (/v1/chat/completions)",
  );
  // Tüm bütçeyi reasoning tüketti (content null) — aynı dürüst tür.
  next = truncated(null);
  await expectBackendError(backend.run(MESSAGES), "output_truncated");
  // finish_reason 'stop' aynen normal sonuç.
  next = CHAT_OK;
  assert.equal((await backend.run(MESSAGES)).content, "TAMAM");
});

test("L3: /status instance.pid must be a safe integer > 1 (pid 1 would exclude the whole host from the conflict scan)", async (t) => {
  let pid: unknown = 1;
  const mock = await startMockRuntime((req) =>
    req.path === "/status"
      ? { status: 200, body: { ...STATUS_OK, instance: { pid } } }
      : { status: 200, body: MODELS_OK },
  );
  t.after(() => mock.close());
  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl));
  for (const bad of [1, 2 ** 53, 2 ** 53 + 2]) {
    pid = bad;
    const info = await backend.refreshRuntimeInfo();
    assert.equal(Object.hasOwn(info, "runtimeProcessId"), false, `pid ${bad} must not be trusted`);
  }
  pid = 2;
  assert.equal((await backend.refreshRuntimeInfo()).runtimeProcessId, 2);
});

test("L5: a network failure's cause carries only the error code (never the raw error object)", async () => {
  const port = await closedPort();
  const backend = new OpenAICompatBackend(makeConfig(`http://127.0.0.1:${port}`));
  const err = await expectBackendError(backend.run(MESSAGES), "network");
  assert.equal(err.cause, "ECONNREFUSED");
});

test("L5: an API key with CR/LF never leaks into message, cause or stack (directly built config)", async (t) => {
  const mock = await startMockRuntime(() => ({ status: 200, body: CHAT_OK }));
  t.after(() => mock.close());
  const KEY = "LEAKYKEY-123\r\nX-Injected: yes";
  const backend = new OpenAICompatBackend(makeConfig(mock.baseUrl, KEY));
  let caught: unknown;
  try {
    await backend.run(MESSAGES);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof BackendError, "an invalid header value must reject typed");
  assert.equal(caught.kind, "invalid_request", "rejected before the wire — honest kind, not 'could not reach'");
  const surface = `${caught.message}|${String(caught.cause)}|${caught.stack ?? ""}|${JSON.stringify(caught.cause ?? null)}`;
  assert.ok(!surface.includes("LEAKYKEY"), "the key must not appear anywhere on the error");
  assert.equal(mock.requests.length, 0, "a header-injection attempt must never reach the wire");
});

// ── İz 2 audit düzeltmeleri (MEDIUM-1 / LOW-7) ───────────────────────────

test("MEDIUM-1: control/measurement calls carry a bounded timeout; ONLY generation is unbounded", async () => {
  const seen = new Map<string, RuntimeHttpRequest>();
  const backend = new OpenAICompatBackend(makeConfig("http://127.0.0.1:9"), {
    transport: async (request) => {
      seen.set(request.url.pathname, request);
      const body =
        request.url.pathname === "/status"
          ? STATUS_OK
          : request.url.pathname === "/v1/models"
            ? MODELS_OK
            : request.url.pathname === "/tokenize"
              ? { tokens: [1] }
              : request.url.pathname === "/apply-template"
                ? { prompt: "p" }
                : CHAT_OK;
      return { status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await backend.refreshRuntimeInfo();
  await backend.countPromptTokens(MESSAGES);
  await backend.run(MESSAGES);
  assert.equal(CONTROL_REQUEST_TIMEOUT_MS, 60_000);
  assert.equal(MEASUREMENT_REQUEST_TIMEOUT_MS, 300_000);
  assert.equal(seen.get("/status")?.timeoutMs, 60_000);
  assert.equal(seen.get("/v1/models")?.timeoutMs, 60_000);
  assert.equal(seen.get("/apply-template")?.timeoutMs, 300_000);
  assert.equal(seen.get("/tokenize")?.timeoutMs, 300_000);
  const chat = seen.get("/v1/chat/completions");
  assert.ok(chat !== undefined);
  assert.equal(Object.hasOwn(chat, "timeoutMs"), false, "generation has no timeout at all");
});

test("MEDIUM-1: the node transport honours timeoutMs while waiting for headers AND while the body idles (ETIMEDOUT)", async (t) => {
  const headers = await startDelayingServer("headers", 2_000, { ok: true });
  const body = await startDelayingServer("body", 2_000, { ok: true });
  t.after(() => Promise.all([headers.close(), body.close()]));
  const transport = createNodeHttpTransport();

  const started = Date.now();
  await assert.rejects(
    transport({ url: new URL(`${headers.baseUrl}/status`), method: "GET", headers: {}, timeoutMs: 150 }),
    (err: unknown) => (err as { code?: string }).code === "ETIMEDOUT",
  );
  assert.ok(Date.now() - started < 1_500, "the timeout fires long before the delayed headers");

  const response = await transport({ url: new URL(`${body.baseUrl}/status`), method: "GET", headers: {}, timeoutMs: 150 });
  assert.equal(response.status, 200);
  await assert.rejects(response.text(1_024), (err: unknown) => (err as { code?: string }).code === "ETIMEDOUT");
});

test("MEDIUM-1: a hung runtime /status inside dispatch → honest 'Timed out' and the coordinator lock is released", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/status") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...STATUS_OK, instance: { pid: 4242 } }));
        }, 2_000);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/models" ? MODELS_OK : CHAT_OK));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  const root = await mkdtemp(path.join(tmpdir(), "splash-m1-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const backend = new OpenAICompatBackend(makeConfig(`http://127.0.0.1:${port}`), {
    requestTimeoutsMs: { control: 150, measurement: 150 },
  });
  const coordinator = new InferenceCoordinator({
    backend,
    runtimeDir,
    scanner: async () => [{ pid: 4242, ppid: 1, command: "splash serve" }],
  });

  const err = await expectBackendError(
    coordinator.dispatch({ ownerId: "s-1", messages: MESSAGES }),
    "network",
  );
  assert.equal(err.message, "Timed out waiting for the inference runtime (/status)");
  assert.equal(err.cause, "ETIMEDOUT");
  await assert.rejects(stat(path.join(runtimeDir, INFERENCE_LOCK_DIR)), { code: "ENOENT" });
  assert.equal(coordinator.activeOwnerId, null);
});

test("LOW-7: aborting while waiting for the response headers (real transport) rejects promptly as network/aborted", async (t) => {
  const server = await startDelayingServer("headers", 2_000, CHAT_OK);
  t.after(() => server.close());
  const controller = new AbortController();
  const backend = new OpenAICompatBackend(makeConfig(server.baseUrl));
  const started = Date.now();
  const pending = backend.run(MESSAGES, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const err = await expectBackendError(pending, "network");
  assert.equal(err.message, "Request aborted (/v1/chat/completions)");
  assert.ok(Date.now() - started < 1_500, "the abort is not delayed until the headers arrive");
});

test("LOW-7: an https base URL uses TLS; a self-signed runtime certificate is rejected with only the error code as cause", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "splash-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(STATUS_OK));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  const backend = new OpenAICompatBackend(makeConfig(`https://127.0.0.1:${port}`, "k-tls"));
  const err = await expectBackendError(backend.refreshRuntimeInfo(), "network");
  assert.equal(err.message, "Could not reach the inference runtime (/status)");
  assert.equal(err.cause, "DEPTH_ZERO_SELF_SIGNED_CERT");
});
