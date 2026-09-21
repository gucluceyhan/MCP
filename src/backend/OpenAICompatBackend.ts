import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
  InferenceUsage,
  PromptRenderOptions,
  ReasoningEffort,
  RuntimeInfo,
  TokenizeOptions,
  TokenizeResult,
} from "./InferenceBackend.js";
import { BackendError } from "./errors.js";
import type { BackendConfig } from "../config.js";

/**
 * v1'in TEK inference backend'i (DESIGN.md 2.5 / 11 madde 2):
 * yerel model runtime'ının OpenAI-uyumlu HTTP API'si.
 *
 * Disiplin — adaptor bir YAPRAK'tır:
 * - Her çağında tam bir HTTP gidiş-dönüşü (`countPromptTokens` iki).
 * - Retry, kuyruk, kilit, planlama, süreç denetimi, dosya, git YOK.
 *   Seriye almanın tek sorumlusu Inference Coordinator'dir (DESIGN.md 2.7).
 * - `contextTier` caller metadata'dır: doğrulanır ama ASLA gönderilmez.
 * - `reasoning_effort` / `max_completion_tokens` yalnızca verildiğinde
 *   gövdeye girer; `reasoning_effort` ayrıca beyaz listededir.
 * - API anahtarı, ayarlıysa BİR kere, `Authorization` header'ı olarak
 *   gönderilir; hiçbir log ya da hata mesajına ASLA girmez. Runtime/proxy
 *   anahtarı bir hata gövdesine yansıtırsa bile, o gövdeden çıkarılan
 *   teknik detayda anahtar `[REDACTED]` ile değiştirilir (bkz.
 *   `extractHttpDetail`) — anahtar ne `message`'de ne `cause`'ta yaşar.
 * - Her çağında caller'ın `AbortSignal`'i korunur; otomatik retry YOK.
 *
 * Uçlar (tam olarak, runtime'ın canlı API'sine göre):
 *   GET  /status                 → ready + maximum_context_tokens
 *                                   (bilinmeyen ek alanlar kabul edilir)
 *   GET  /v1/models              → sunulan model listesi (tam eşleşme zorunlu)
 *   POST /v1/chat/completions    → tek non-stream tamamlanma
 *   POST /tokenize               → ham içeriğin tam token kimlikleri
 *   POST /apply-template         → render edilmiş sohbet şablonu (prompt)
 */
export class OpenAICompatBackend implements InferenceBackend {
  #config: BackendConfig;
  /** Son başarılı yenileme; başarısız yenileme bunu ASLA dokunmaz. */
  #runtimeInfo: RuntimeInfo | null = null;

  constructor(config: BackendConfig) {
    this.#config = config;
  }

  get runtimeInfo(): RuntimeInfo | null {
    return this.#runtimeInfo;
  }

  // ── runtime durumu ─────────────────────────────────────────────────────

  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    // 1) /status — yetki (authoritative) kapasite. Bilinmeyen ek alanlar
    // (schema_version, admission, identity, metrics, ...) kabul edilir.
    const status = await requestJson(this.#config, "GET", "/status", undefined, signal);
    if (!isRecord(status) || status.ready !== true) {
      throw new BackendError("invalid_status", "Inference runtime is not ready (/status)");
    }
    const maximum = status.maximum_context_tokens;
    if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum <= 0) {
      throw new BackendError(
        "invalid_status",
        "Inference runtime reported an invalid maximum_context_tokens (/status)",
      );
    }

    // 2) /v1/models — sunulan model, yapılandırılan modelle TAM eşleşmeli.
    // Fuzzy eşleşme ya da sessiz ikame YOK.
    const models = await requestJson(this.#config, "GET", "/v1/models", undefined, signal);
    if (!isRecord(models) || models.object !== "list" || !Array.isArray(models.data)) {
      throw new BackendError(
        "invalid_status",
        "Inference runtime returned an unexpected model list (/v1/models)",
      );
    }
    const data = models.data;
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.id !== "string") {
        throw new BackendError(
          "invalid_status",
          "Inference runtime returned a malformed model entry (/v1/models)",
        );
      }
    }
    const servesConfiguredModel = data.some(
      (entry) => isRecord(entry) && entry.id === this.#config.model,
    );
    if (!servesConfiguredModel) {
      throw new BackendError(
        "model_mismatch",
        `Configured model "${this.#config.model}" is not served by the runtime (/v1/models)`,
      );
    }

    // İki çağrı da başarılı: on-bellek YALNIZCA burada (yeniden) atanır.
    const info: RuntimeInfo = {
      ready: true,
      maximumContextTokens: maximum,
      servedModel: this.#config.model,
    };
    this.#runtimeInfo = info;
    return info;
  }

  // ── inference ──────────────────────────────────────────────────────────

  async run(
    messages: InferenceMessage[],
    options: InferenceRunOptions = {},
  ): Promise<InferenceResult> {
    if (messages.length === 0) {
      throw new BackendError("invalid_request", "run: messages must not be empty");
    }
    if (options.maxOutputTokens !== undefined) {
      if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
        throw new BackendError("invalid_request", "maxOutputTokens must be a positive integer");
      }
    }
    if (options.reasoningEffort !== undefined && !isReasoningEffort(options.reasoningEffort)) {
      throw new BackendError(
        "invalid_request",
        "reasoningEffort must be one of: none, low, medium, xhigh",
      );
    }
    if (options.contextTier !== undefined) {
      // contextTier caller metadata'dır: doğrulanır, gönderilmez.
      if (!Number.isInteger(options.contextTier) || options.contextTier <= 0) {
        throw new BackendError("invalid_request", "contextTier must be a positive integer");
      }
      const maximum = this.#runtimeInfo?.maximumContextTokens;
      if (maximum !== undefined && options.contextTier > maximum) {
        throw new BackendError(
          "invalid_request",
          `contextTier ${options.contextTier} exceeds the runtime maximum of ${maximum} tokens`,
        );
      }
    }

    const body: Record<string, unknown> = {
      model: this.#config.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      // v1 non-stream: adaptor tüm yanıtı tek parça alır.
      stream: false,
    };
    // İsteye bağlı alanlar YALNIZCA verildiğinde gövdeye girer.
    if (options.maxOutputTokens !== undefined) {
      body.max_completion_tokens = options.maxOutputTokens;
    }
    if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort;
    }
    // Not: options.contextTier bilinçli olarak gövdede YER ALMAZ.

    const parsed = await requestJson(
      this.#config,
      "POST",
      "/v1/chat/completions",
      body,
      options.signal,
    );
    return validateChatCompletion(parsed);
  }

  // ── tokenizer / şablon ─────────────────────────────────────────────────

  async tokenize(content: string, options: TokenizeOptions = {}): Promise<TokenizeResult> {
    // Boş içerik için davranış runtime'a aittir; adaptor koruma koymaz.
    const body = { content, add_special: options.addSpecial ?? false };
    const parsed = await requestJson(this.#config, "POST", "/tokenize", body, options.signal);
    if (!isRecord(parsed)) {
      throw new BackendError(
        "invalid_response",
        "Expected a JSON object with an integer 'tokens' array from /tokenize",
      );
    }
    const rawTokens = parsed.tokens;
    if (!Array.isArray(rawTokens)) {
      throw new BackendError(
        "invalid_response",
        "Expected a JSON object with an integer 'tokens' array from /tokenize",
      );
    }
    for (const token of rawTokens) {
      if (typeof token !== "number" || !Number.isInteger(token)) {
        throw new BackendError(
          "invalid_response",
          "Expected a JSON object with an integer 'tokens' array from /tokenize",
        );
      }
    }
    const tokens = rawTokens as number[];
    return { tokens: [...tokens], count: tokens.length };
  }

  async renderPrompt(
    messages: InferenceMessage[],
    options: PromptRenderOptions = {},
  ): Promise<string> {
    // `run` ile aynı sözleşme: boş mesaj listesi ağa hiç çıkmaz.
    if (messages.length === 0) {
      throw new BackendError("invalid_request", "renderPrompt: messages must not be empty");
    }
    if (options.reasoningEffort !== undefined && !isReasoningEffort(options.reasoningEffort)) {
      throw new BackendError(
        "invalid_request",
        "reasoningEffort must be one of: none, low, medium, xhigh",
      );
    }
    const body: Record<string, unknown> = {
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort;
    }
    const parsed = await requestJson(
      this.#config,
      "POST",
      "/apply-template",
      body,
      options.signal,
    );
    if (!isRecord(parsed) || typeof parsed.prompt !== "string") {
      throw new BackendError(
        "invalid_response",
        "Expected a JSON object with a string 'prompt' from /apply-template",
      );
    }
    return parsed.prompt;
  }

  async countPromptTokens(
    messages: InferenceMessage[],
    options: PromptRenderOptions = {},
  ): Promise<number> {
    const prompt = await this.renderPrompt(messages, options);
    const result = await this.tokenize(prompt, { signal: options.signal });
    return result.count;
  }
}

// ── modül-privat yardımcılar ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Iptal mi? (signal zaten iptal ya da undici AbortError) */
function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal !== undefined && signal.aborted) {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Runtime tarafından kabul edilen `reasoning_effort` değerleri.
 * `run()` / `renderPrompt()` bunların dışındaki her değeri `invalid_request`
 * ile reddeder (savunma derinliği: TS birleşik tipinin ötesinden,
 * tip'siz veriler gelebilir).
 */
const REASONING_EFFORTS = ["none", "low", "medium", "xhigh"] as const;

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Teknik hata detayının uzunluk tavanı (≈200 karakter). */
const SAFE_DETAIL_LIMIT = 200;

function truncateSafe(value: string): string {
  return value.length > SAFE_DETAIL_LIMIT ? value.slice(0, SAFE_DETAIL_LIMIT) : value;
}

/**
 * Yapılandırılmış API anahtarını detay dizesinden deterministik olarak
 * çıkarır: anahtarın her birebir geçişi `[REDACTED]` ile değiştirilir.
 * Runtime ya da bir proxy, gönderilen bearer token'ı hata gövdesine
 * yansıtabilirse (örn. `{"error":{"message":"invalid token <key>"}}`) bu
 * detay `BackendError.cause`'a gireceğinden, anahtar ASLA hata kanalında
 * yaşamasın diye kırpamadan ÖNCE redaksiyon uygulanır. Anahtar kendisi
 * hiçbir yeni hata dizesine yazılmaz/eklenmez — yalnızca yer değiştirilir.
 * Anahtar ayarlı değilse, boşsa ya da yalnızca boşluk içeriyorsa dize
 * dokunulmaz — boşluk-only bir anahtar `replaceAll` ile detayı bozmasın.
 * (`loadConfig` boş anahtarı zaten `undefined`'a düşürür; bu koruma,
 * BackendConfig'i doğrudan kuran çağrılar içindir.)
 */
function redactSecret(detail: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return detail;
  }
  return detail.replaceAll(apiKey, "[REDACTED]");
}

/**
 * 2xx-dışı bir yanıt gövdesinden teknik detay çıkarır: parse edilebilirse
 * `error.message` ya da üst düzey `message` alanı; yapılandırılmış API
 * anahtarı ayarlıysa önce `redactSecret` ile `[REDACTED]`'a çevrilir,
 * sonra `SAFE_DETAIL_LIMIT` karaktere kırpılır. Bu dize YALNIZCA
 * `BackendError.cause` kanalında taşınır — `message` hiçbir yanıt/istek
 * içeriği taşımaz (DESIGN.md bölüm 9) ve anahtar ne `message`'de ne
 * `cause`'ta asla görünmez. Gövde parse edilemezse ya da mesaj alanı yoksa
 * `undefined`.
 */
function extractHttpDetail(bodyText: string, apiKey: string | undefined): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  let message: unknown;
  if (isRecord(parsed) && isRecord(parsed.error)) {
    message = parsed.error.message;
  } else if (isRecord(parsed)) {
    message = parsed.message;
  }
  if (typeof message !== "string" || message.length === 0) {
    return undefined;
  }
  return truncateSafe(redactSecret(message, apiKey));
}

/**
 * Tüm çağrıların TEK modül-privat JSON gidiş-dönüşü yardımcısı.
 *
 * Tek istek, tek yanıt: retry YOK, planlama YOK (DESIGN.md 2.5).
 * Hata haritası:
 *   bağlantı hatası                     → BackendError("network")
 *   iptal (fetch ya da gövde okuması)   → BackendError("network") + "aborted"
 *   2xx dışı durum                      → BackendError("http") + `status`;
 *                                        gövde detayı (≤200) YALNIZCA `cause`'ta;
 *                                        API anahtarı ayarlıysa detaydaki anahtar
 *                                        geçişleri `[REDACTED]` yapılır
 *   2xx ama parse edilemeyen gövde      → BackendError("invalid_response");
 *                                        `cause` `undefined` (parse hatası
 *                                        gövde snippet'i taşır — saklanmaz)
 *
 * DESIGN.md bölüm 9: `message` hiçbir durumda istek/yanıt içeriği taşımaz —
 * coordinator bunu frontier'a yüzeyine taşır; teknik detay `cause`'tadır.
 * Redaksiyon kuralı: `config.apiKey` ayarlıysa, 2xx-dışı gövdeden çıkarılan
 * detayda anahtarın birebir geçişleri kırpamadan önce `[REDACTED]`'a
 * değiştirilir — anahtar ne `message`'de ne `cause`'ta asla görünmez.
 */
async function requestJson(
  config: BackendConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    headers["content-type"] = "application/json";
  }
  // Anahtar BİR kere, bu header'da; hiçbir mesaj ya da log'da yok.
  if (config.apiKey !== undefined) {
    headers["authorization"] = `Bearer ${config.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    const message =
      isAbort(err, signal)
        ? `Request aborted (${path})`
        : `Could not reach the inference runtime (${path})`;
    throw new BackendError("network", message, { cause: err });
  }

  // Gövde tam BİR kere okunur ve hiçbir hata mesajına ASLA yansıtılmaz.
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (readErr) {
    // Gövde okuma SIRASINDA gelen iptal bir ağ hatasıdır: network/aborted.
    if (isAbort(readErr, signal)) {
      throw new BackendError("network", `Request aborted (${path})`, { cause: readErr });
    }
    // Socket reset vb.: gövde boş kabul edilir — 2xx'te parse hatası
    // (invalid_response), 2xx-dışında genel http mesajı. Mevcut harita korunur.
    bodyText = "";
  }

  if (!response.ok) {
    // `message` fragment-taşıyan değildir; gövde detayı yalnız `cause`'ta.
    // Anahtar ayarlıysa detayda redakte edilir (bkz. extractHttpDetail).
    throw new BackendError(
      "http",
      `Inference runtime returned HTTP ${response.status} from ${path}`,
      { status: response.status, cause: extractHttpDetail(bodyText, config.apiKey) },
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    // `cause`: bilinçli olarak `undefined` — V8 `SyntaxError`'ın mesajı
    // gövdenin başından ~10 karakterlik bir snippet taşır; 2xx gövdesi
    // anahtarla başlıyorsa o prefix `cause`'a sızardı. Gövde içeriği
    // hiçbir hata kanalına girmez.
    throw new BackendError("invalid_response", `Response from ${path} was not valid JSON`);
  }
}

/**
 * `/v1/chat/completions` (non-stream) yanıtının şekline uydurması.
 * Her sarkan madde aynı `invalid_response` türüyle reddedilir.
 */
function validateChatCompletion(parsed: unknown): InferenceResult {
  const endpoint = "/v1/chat/completions";
  if (!isRecord(parsed)) {
    throw new BackendError("invalid_response", `Expected a JSON object from ${endpoint}`);
  }
  if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new BackendError(
      "invalid_response",
      `Expected a non-empty 'choices' array from ${endpoint}`,
    );
  }
  const first = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new BackendError(
      "invalid_response",
      `Expected a 'choices[0].message' object from ${endpoint}`,
    );
  }
  // `content` string OLMALIDIR. Canlı runtime'da tüm tamamlanma bütçesini
  // dışarım (reasoning) tükettiğinde `content: null` döner — string dışı
  // bir değer boş yanıt DEĞİL, geçersiz yanıttır.
  if (typeof first.message.content !== "string") {
    throw new BackendError(
      "invalid_response",
      `Expected a string 'message.content' from ${endpoint} (got a non-text response)`,
    );
  }
  if (!isRecord(parsed.usage)) {
    throw new BackendError(
      "invalid_response",
      `Expected a 'usage' object from ${endpoint}`,
    );
  }
  const promptTokens = parsed.usage.prompt_tokens;
  const completionTokens = parsed.usage.completion_tokens;
  if (!isNonNegativeInt(promptTokens) || !isNonNegativeInt(completionTokens)) {
    throw new BackendError(
      "invalid_response",
      `Expected non-negative integer 'usage.prompt_tokens'/'usage.completion_tokens' from ${endpoint}`,
    );
  }
  const usage: InferenceUsage = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
  };
  const totalTokens = parsed.usage.total_tokens;
  if (totalTokens !== undefined && !isNonNegativeInt(totalTokens)) {
    throw new BackendError(
      "invalid_response",
      `Expected a non-negative integer 'usage.total_tokens' from ${endpoint}`,
    );
  }
  if (isNonNegativeInt(totalTokens)) {
    usage.totalTokens = totalTokens;
  }
  return { content: first.message.content, usage };
}
