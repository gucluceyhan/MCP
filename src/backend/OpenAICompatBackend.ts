import http from "node:http";
import https from "node:https";
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
 * - JENERASYONDA transport zaman aşımı YOK (İz 2 / H1): global `fetch`
 *   (undici) başlık/gövde için 300 sn varsayılan tavan uygular (ölçüldü:
 *   300.99 sn'de `UND_ERR_HEADERS_TIMEOUT`) — `stream:false` uzun bir
 *   jenerasyonu runtime hâlâ üretirken "ağ hatası"na çevirirdi. Varsayılan
 *   transport `node:http(s)`'tir: istek başına bağlantı, yönlendirme
 *   İZLENMEZ (3xx = tip'li `http` hatası; prompt başka kökene gitmez — L4),
 *   yanıt gövdesi `maxResponseBytes` ile sınırlı. `/v1/chat/completions`
 *   SINIRSIZDIR (iptalin tek sahibi caller'ın sinyali); kontrol çağrıları
 *   (`/status`, `/v1/models`) 60 sn, ölçüm çağrıları (`/tokenize`,
 *   `/apply-template`) 300 sn soket-boşta tavanıyla sınırlıdır (İz 2 audit
 *   MEDIUM-1: kilitlenmiş bir runtime, kilit TUTULURKEN `/status`'ta süresiz
 *   bekletemez). Transport enjekte edilebilir (test dikişi).
 *
 * Uçlar (tam olarak, runtime'ın canlı API'sine göre):
 *   GET  /status                 → ready + maximum_context_tokens
 *                                   (bilinmeyen ek alanlar kabul edilir;
 *                                   Step 3: instance.pid yalnızca geçerli
 *                                   pozitif tam sayıyken kimlik olarak
 *                                   alınır — ham instance taşınmaz)
 *   GET  /v1/models              → sunulan model listesi (tam eşleşme zorunlu)
 *   POST /v1/chat/completions    → tek non-stream tamamlanma
 *   POST /tokenize               → ham içeriğin tam token kimlikleri
 *   POST /apply-template         → render edilmiş sohbet şablonu (prompt)
 */
/** Runtime'a TEK HTTP gidiş-dönüşünün isteği (transport dikişi). */
export interface RuntimeHttpRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Soket-boşta tavanı (ms): başlık beklerken ya da gövde akışı durduğunda
   * bu kadar veri gelmezse istek `ETIMEDOUT` koduyla düşer. YOKSA sınırsız
   * (yalnız jenerasyon — MEDIUM-1).
   */
  timeoutMs?: number;
}

/**
 * Başlıkları alınmış yanıt. Gövde AYRI okunur — bağlantı/başlık hatası ile
 * gövde-okuma hatası farklı haritalanır. `text(maxBytes)` tavanı aşan
 * gövdeyi okumayı keser ve `ResponseTooLargeError` ile reddeder.
 */
export interface RuntimeHttpResponse {
  status: number;
  text(maxBytes: number): Promise<string>;
}

export type RuntimeHttpTransport = (request: RuntimeHttpRequest) => Promise<RuntimeHttpResponse>;

export interface OpenAICompatBackendOptions {
  /** Enjekte edilebilir transport (varsayılan: `createNodeHttpTransport()`). */
  transport?: RuntimeHttpTransport;
  /** Yanıt gövdesi bayt tavanı (varsayılan: `DEFAULT_MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
  /**
   * TEST DİKİŞİ: kontrol/ölçüm tavanları (varsayılan: aşağıdaki sabitler).
   * Kullanıcı yapılandırması DEĞİLDİR (config/env yolu yok).
   */
  requestTimeoutsMs?: { control: number; measurement: number };
}

/** Kontrol çağrıları (`/status`, `/v1/models`) soket-boşta tavanı: 60 sn. */
export const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
/** Ölçüm çağrıları (`/tokenize`, `/apply-template`) soket-boşta tavanı: 300 sn. */
export const MEASUREMENT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Yanıt gövdesi tavanı: 64 MiB. Meşru en büyük yanıtlar (tam bağlam
 * `/apply-template` prompt'u, ~260K tokenlık `/tokenize` dizisi, çıkış payı
 * kadar tamamlanma) bunun çok altındadır; tavan yalnız hatalı/kötü niyetli
 * bir uç noktanın sınırsız bellek tüketmesini keser.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Gövde tavanı aşıldı (transport → adaptör iç sinyali; içerik taşımaz). */
export class ResponseTooLargeError extends Error {
  constructor() {
    super("Response body exceeded the size limit");
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Varsayılan transport: `node:http(s)`. Bilinçli olarak:
 * - varsayılan zaman aşımı YOK — yalnız istek `timeoutMs` taşıyorsa soket-
 *   boşta tavanı (`ETIMEDOUT`); paylaşılan agent'ın soket politikası devreye
 *   girmesin diye `agent: false` (istek başına bağlantı),
 * - yönlendirme izlenmez (node:http hiç izlemez),
 * - iptal yalnız caller'ın `signal`'i,
 * - gövde `TextDecoder` ile çözülür (`fetch().text()` ile aynı: UTF-8, BOM
 *   atılır, geçersiz bayt → U+FFFD).
 */
export function createNodeHttpTransport(): RuntimeHttpTransport {
  return (request) =>
    new Promise<RuntimeHttpResponse>((resolve, reject) => {
      const client = request.url.protocol === "https:" ? https : http;
      const headers: Record<string, string> = { ...request.headers };
      if (request.body !== undefined) {
        headers["content-length"] = String(Buffer.byteLength(request.body));
      }
      // Zaman aşımı hatası: gövde okuması da bunu (ECONNRESET değil) görsün
      // diye burada tutulur — dürüst "timed out" eşlemesi.
      let timeoutError: Error | null = null;
      const req = client.request(
        request.url,
        { method: request.method, headers, signal: request.signal, agent: false },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            text: (maxBytes) => readBody(res, maxBytes, () => timeoutError),
          });
        },
      );
      if (request.timeoutMs !== undefined) {
        // Soket-boşta tavanı (başlık bekleme + gövde akışı). Yalnız kontrol/
        // ölçüm çağrılarında verilir; jenerasyon sınırsızdır (MEDIUM-1).
        req.setTimeout(request.timeoutMs, () => {
          timeoutError = Object.assign(new Error("Inference runtime request timed out"), { code: "ETIMEDOUT" });
          req.destroy(timeoutError);
        });
      }
      // Yanıt sonrası gelen istek hatası (ör. gövde ortasında iptal) gövde
      // okumasında yüzeye çıkar; buradaki reject o noktada etkisizdir.
      req.on("error", reject);
      req.end(request.body);
    });
}

/**
 * Gövdeyi tavanla okur; erken kapanış/hata → red (asla takılmaz). Soket
 * zaman aşımıyla yıkıldıysa red nedeni o zaman aşımı hatasıdır.
 */
function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  timedOut: () => Error | null,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: unknown): void => {
      if (!settled) {
        settled = true;
        reject(timedOut() ?? err);
      }
    };
    res.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        fail(new ResponseTooLargeError());
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(new TextDecoder().decode(Buffer.concat(chunks)));
      }
    });
    res.on("error", fail);
    res.on("close", () => fail(new Error("Response closed before the body completed")));
  });
}

export class OpenAICompatBackend implements InferenceBackend {
  #config: BackendConfig;
  #http: HttpDeps;
  /** Son başarılı yenileme; başarısız yenileme bunu ASLA dokunmaz. */
  #runtimeInfo: RuntimeInfo | null = null;

  constructor(config: BackendConfig, options: OpenAICompatBackendOptions = {}) {
    this.#config = config;
    this.#http = {
      transport: options.transport ?? createNodeHttpTransport(),
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      controlTimeoutMs: options.requestTimeoutsMs?.control ?? CONTROL_REQUEST_TIMEOUT_MS,
      measurementTimeoutMs: options.requestTimeoutsMs?.measurement ?? MEASUREMENT_REQUEST_TIMEOUT_MS,
    };
  }

  get runtimeInfo(): RuntimeInfo | null {
    return this.#runtimeInfo;
  }

  // ── runtime durumu ─────────────────────────────────────────────────────

  async refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
    // 1) /status — yetki (authoritative) kapasite. Bilinmeyen ek alanlar
    // (schema_version, admission, identity, metrics, ...) kabul edilir.
    const status = await requestJson(this.#config, this.#http, "GET", "/status", undefined, signal);
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
    const models = await requestJson(this.#config, this.#http, "GET", "/v1/models", undefined, signal);
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

    // 3) Runtime kimliği (Step 3): `/status.instance.pid` — sunan
    //    süreç. Sıkı doğrulama (güvenli tam sayı, > 1); eksik ya da bozuk
    //    değer `runtimeProcessId`'yi boşta BIRAKIR (özellik konulmaz,
    //    `undefined` yazılmaz) — coordinator "kullanılır kimlik yok"
    //    deyip fail-closed davranır; asla tahmin edilmez. Ham
    //    `instance` nesnesi BÜTÜN HÂLİYLE asla dışarı taşınmaz
    //    (içindeki alanlar bilinenden genişleyebilir).
    let runtimeProcessId: number | undefined;
    const instance = status.instance;
    if (isRecord(instance)) {
      const pid = instance.pid;
      // `Number.isSafeInteger` + `pid > 1` (İz 2 / L3): PID 1 (launchd/init)
      // tüm host'un atasıdır — kimlik olarak kabul edilseydi çakışma
      // taramasından HER süreç dışlanırdı (sessiz fail-open).
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) {
        runtimeProcessId = pid;
      }
    }

    // İki çağrı da başarılı: on-bellek YALNIZCA burada (yeniden) atanır.
    const info: RuntimeInfo = {
      ready: true,
      maximumContextTokens: maximum,
      servedModel: this.#config.model,
    };
    if (runtimeProcessId !== undefined) {
      info.runtimeProcessId = runtimeProcessId;
    }
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
      this.#http,
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
    const parsed = await requestJson(this.#config, this.#http, "POST", "/tokenize", body, options.signal);
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
      this.#http,
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

/** Adaptörün transport bağımlılıkları (constructor'da çözülür). */
interface HttpDeps {
  transport: RuntimeHttpTransport;
  maxResponseBytes: number;
  /** Kontrol (`/status`, `/v1/models`) soket-boşta tavanı (ms). */
  controlTimeoutMs: number;
  /** Ölçüm (`/tokenize`, `/apply-template`) soket-boşta tavanı (ms). */
  measurementTimeoutMs: number;
}

/**
 * Zaman aşımı hata kodları (İz 2 / H1). Varsayılan transport zaman aşımı
 * KOYMAZ; ama enjekte edilmiş (ör. fetch/undici tabanlı) bir transport ya
 * da TCP bağlantı katmanı (`ETIMEDOUT`) bunları üretebilir — dürüst, ayrı
 * bir mesaja eşlenir ("ulaşılamadı"/"geçersiz JSON" DEĞİL).
 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

/**
 * Hatanın makine kodu (`err.code`, yoksa fetch tarzı `err.cause.code`) —
 * YALNIZ büyük harf/rakam/alt çizgi biçimindeyse (İz 2 / L5). `cause`
 * kanalına ham hata nesnesi DEĞİL yalnız bu kod girer: ham mesajlar host/
 * port, hatta geçersiz header değerini (anahtar!) yansıtabilir (ölçüldü:
 * CR/LF'li anahtarla fetch'in TypeError mesajı anahtarı içeriyordu).
 */
function errorCode(err: unknown): string | undefined {
  const pick = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
  };
  return pick(err) ?? (typeof err === "object" && err !== null ? pick((err as { cause?: unknown }).cause) : undefined);
}

/**
 * Taşıma hatasını tip'li `network` hatasına çevirir: iptal → "aborted",
 * zaman aşımı kodu → "timed out", diğer → "could not reach". `cause` yalnız
 * hata KODUDUR (ya da `undefined`).
 */
function networkError(err: unknown, signal: AbortSignal | undefined, path: string): BackendError {
  const code = errorCode(err);
  let message: string;
  if (isAbort(err, signal)) {
    message = `Request aborted (${path})`;
  } else if (code !== undefined && TIMEOUT_CODES.has(code)) {
    message = `Timed out waiting for the inference runtime (${path})`;
  } else {
    message = `Could not reach the inference runtime (${path})`;
  }
  return new BackendError("network", message, { cause: code });
}

/**
 * Görünür ASCII (0x21-0x7E) — HTTP header değerinde güvenli bayt kümesi.
 * `loadConfig` bunu zaten zorlar (İz 2 / L5); burası doğrudan kurulan
 * `BackendConfig` için savunma derinliğidir (CR/LF → header enjeksiyonu).
 */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * Tüm çağrıların TEK modül-privat JSON gidiş-dönüşü yardımcısı.
 *
 * Tek istek, tek yanıt: retry YOK, planlama YOK, yönlendirme YOK; zaman
 * aşımı yalnız kontrol/ölçüm çağrılarında, jenerasyonda YOK (DESIGN.md 2.5).
 * Hata haritası:
 *   bağlantı hatası                     → BackendError("network"); `cause` = hata kodu
 *   zaman aşımı kodu (TIMEOUT_CODES)    → BackendError("network") + "timed out"
 *   iptal (istek ya da gövde okuması)   → BackendError("network") + "aborted"
 *   2xx dışı durum (3xx DAHİL)          → BackendError("http") + `status`;
 *                                        gövde detayı (≤200) YALNIZCA `cause`'ta;
 *                                        API anahtarı ayarlıysa detaydaki anahtar
 *                                        geçişleri `[REDACTED]` yapılır
 *   gövde tavanı aşıldı                 → 2xx: BackendError("invalid_response");
 *                                        2xx-dışı: detaysız `http`
 *   2xx ama parse edilemeyen gövde      → BackendError("invalid_response");
 *                                        `cause` `undefined` (parse hatası
 *                                        gövde snippet'i taşır — saklanmaz)
 *   anahtar header'a güvenle yazılamaz  → BackendError("invalid_request"),
 *                                        ağa ÇIKMADAN (anahtar mesajda yok)
 *
 * DESIGN.md bölüm 9: `message` hiçbir durumda istek/yanıt içeriği taşımaz —
 * coordinator bunu frontier'a yüzeyine taşır; teknik detay `cause`'tadır.
 * Redaksiyon kuralı: `config.apiKey` ayarlıysa, 2xx-dışı gövdeden çıkarılan
 * detayda anahtarın birebir geçişleri kırpamadan önce `[REDACTED]`'a
 * değiştirilir — anahtar ne `message`'de ne `cause`'ta asla görünmez.
 */
async function requestJson(
  config: BackendConfig,
  deps: HttpDeps,
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
    if (!VISIBLE_ASCII.test(config.apiKey)) {
      throw new BackendError(
        "invalid_request",
        "The configured API key contains characters that are not allowed in an HTTP header",
      );
    }
    headers["authorization"] = `Bearer ${config.apiKey}`;
  }

  // Tavan uç noktaya göre SABİTTİR (MEDIUM-1): jenerasyon sınırsız;
  // kontrol/ölçüm çağrıları sınırlı — kilit tutulurken asılı kalınmaz.
  const timeoutMs =
    path === "/v1/chat/completions"
      ? undefined
      : path === "/status" || path === "/v1/models"
        ? deps.controlTimeoutMs
        : deps.measurementTimeoutMs;

  let response: RuntimeHttpResponse;
  try {
    response = await deps.transport({
      url: new URL(path, config.baseUrl),
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    throw networkError(err, signal, path);
  }

  const ok = response.status >= 200 && response.status < 300;

  // Gövde tam BİR kere okunur ve hiçbir hata mesajına ASLA yansıtılmaz.
  let bodyText: string;
  try {
    bodyText = await response.text(deps.maxResponseBytes);
  } catch (readErr) {
    // Gövde okuma SIRASINDA gelen iptal / zaman aşımı bir ağ hatasıdır.
    const code = errorCode(readErr);
    if (isAbort(readErr, signal) || (code !== undefined && TIMEOUT_CODES.has(code))) {
      throw networkError(readErr, signal, path);
    }
    if (readErr instanceof ResponseTooLargeError && ok) {
      throw new BackendError("invalid_response", `Response from ${path} exceeded the size limit`);
    }
    // Socket reset / 2xx-dışı tavan aşımı: gövde boş kabul edilir — 2xx'te
    // parse hatası (invalid_response), 2xx-dışında detaysız http. Mevcut harita.
    bodyText = "";
  }

  if (!ok) {
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
  // Çıkış bütçesi tükendi (İz 2 / L1): yanıt yarım kesildi — içerik (varsa)
  // eksik bir worker çıktısıdır. "Geçersiz JSON"/"metin dışı yanıt" yerine
  // dürüst, ayrı tip'li hata (bütçe/kapsam sorunu; model bozukluğu değil).
  if (first.finish_reason === "length") {
    throw new BackendError(
      "output_truncated",
      `Inference output budget exhausted before the response completed (${endpoint})`,
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
