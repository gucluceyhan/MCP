/**
 * Stabil inference backend arayüzü (DESIGN.md bölüm 2.5, 10, 11 madde 2).
 *
 * Bu dosya YALNIZ tipler içermektedir — hiçbir mantık yoktur. Çekirdek
 * bileşenler (Inference Coordinator, Context Assembler) bu arayüze bağlı olur
 * ve somut motoru ya da model adını ASLA referans vermez (DESIGN.md 2.5:
 * core independence).
 *
 * Sözleşme:
 * - Implementasyon bir YAPRAK'tır: her çağrı tam olarak bir HTTP gidiş-dönüşü
 *   yapar (`refreshRuntimeInfo` + `countPromptTokens` iki gidiş-dönüşü).
 *   Kendi içinde planlama, kuyruk, kilit, retry, süreç denetimi yapmaz; tüm
 *   seriye alma işinin sorumlusu Inference Coordinator'dir (DESIGN.md 2.7).
 * - Her metod işaretleyicinin (caller) `AbortSignal`'ini alır ve network
 *   çağrısına aktarır; iptal sahibi her zaman caller'dir.
 * - Hatalar tip'li `BackendError` olarak reddedilir (bkz. errors.ts);
 *   mesajlar kısa ve güvenlidir (istek gövdesi / model içeriği / API anahtarı
 *   hiçbir mesaja girmez).
 */

/** Model tarafına gönderilen sohbet rolleri. */
export type InferenceRole = "system" | "user" | "assistant";

/** Model'e gönderilen tek bir sohbet mesajı. */
export interface InferenceMessage {
  role: InferenceRole;
  content: string;
}

/**
 * Yerel runtime'ın `/apply-template` ve `/v1/chat/completions`
 * uçları tarafından kabul edilen dışarım (reasoning) seviyeleri.
 */
export type ReasoningEffort = "none" | "low" | "medium" | "xhigh";

/** Runtime'ın kendi status ucundan alınan yetki (authoritative) kapasite. */
export interface RuntimeInfo {
  /** Runtime kendini sunuma hazır (ready) bildiriyor. */
  ready: boolean;
  /**
   * Bağlam penceresinin token bazında sert tavanı. Asla sabit kodlanmaz:
   * sunulacak modele, donanıma ve bellek bütçesine bağlıdır (DESIGN.md 2.5).
   */
  maximumContextTokens: number;
  /** Runtime'ın sunduğunu onayladığı model kimliği. */
  servedModel: string;
}

/** `run()` için işaretleyici seçenekleri. */
export interface InferenceRunOptions {
  /**
   * İsteye bağlı çıkış tavanı (token). Pozitif tam sayı olarak doğrulanır;
   * YALNIZCA verildiğinde runtime'a `max_completion_tokens` olarak gönderilir.
   */
  maxOutputTokens?: number;
  /**
   * İsteye bağlı dışarım (reasoning) seviyesi; YALNIZCA verildiğinde
   * `reasoning_effort` olarak gönderilir.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * İşaretleyicinin seçtiği bağlam kademesi (token) — CALLER METADIR.
   * Doğrulanır (pozitif tam sayı; runtime bilgisi biliniyorsa
   * `maximumContextTokens`'i aşmaz) ama BİLİNÇLİ olarak hiçbir istek
   * gövdesine konulmaz: yerel runtime bunu kabul etmez.
   */
  contextTier?: number;
  /** Network çağrısına aktarılır; iptalin sahibi caller'dir. */
  signal?: AbortSignal;
}

/** Bir tamamlanma için token hakedişi. */
export interface InferenceUsage {
  /** Girdi (prompt) tokenları. */
  inputTokens: number;
  /** Çıkış (completion) tokenları. */
  outputTokens: number;
  /** Runtime raporluyorsa toplam token. */
  totalTokens?: number;
}

/** Bir inference çalışmasının sonucu. */
export interface InferenceResult {
  /** Model'in metin içeriği (daima string; değişimi = hata). */
  content: string;
  usage: InferenceUsage;
}

/** `tokenize()` için işaretleyici seçenekleri. */
export interface TokenizeOptions {
  /**
   * Tokenizer'ın özel (special) tokenlarını dahil et; `add_special` olarak
   * gönderilir. Varsayılan: `false`.
   */
  addSpecial?: boolean;
  signal?: AbortSignal;
}

/** Bir içeriğin tokenizer tarafından hesaplanan tam token kimlikleri. */
export interface TokenizeResult {
  tokens: number[];
  /** `tokens.length` — içeriğin tam token sayısı. */
  count: number;
}

/** `renderPrompt()` için işaretleyici seçenekleri. */
export interface PromptRenderOptions {
  /**
   * İsteye bağlı dışarım (reasoning) seviyesi; YALNIZCA verildiğinde
   * `reasoning_effort` olarak gönderilir.
   */
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

/**
 * Takılıp-çıkarılabilir inference motor uyarlayıcısı.
 *
 * v1 tam olarak tek implementasyonla gelir: `OpenAICompatBackend`.
 * Gelecekteki motorlar (Ollama, ...) bu arayüzü implemente eden yaprak
 * adaptorelerdir — yeni motor eklendiğinde çekirdek değişmez.
 */
export interface InferenceBackend {
  /**
   * Son BAŞARILI `refreshRuntimeInfo()` anında yakalanan runtime bilgi;
   * daha önce başarı yoksa `null`. Başarılı olmayan bir yenileme önceki
   * iyi değeri ASLA geçersiz kıldı veya silmez.
   */
  readonly runtimeInfo: RuntimeInfo | null;

  /**
   * Runtime'ın status ucu (`/status`) ve model listesi (`/v1/models`)
   * sorgulanır. İki çağrının da başarılı olması durumunda runtime bilgi
   * (yeniden) atanır; herhangi bir başarısızlık tip'li `BackendError` olarak
   * reddedilir ve önceki iyi on-bellek (cache) dokunulmadan korunur.
   */
  refreshRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo>;

  /**
   * Bir sohbet tamamlaması çalıştırır (`/v1/chat/completions`,
   * non-streaming) ve metin içeriğini + tam token hakedişini döndürür.
   */
  run(
    messages: InferenceMessage[],
    options?: InferenceRunOptions,
  ): Promise<InferenceResult>;

  /**
   * Ham içeriği runtime'ın tokenizer ucu (`/tokenize`) ile tam
   * tokenize eder — Context Assembler'in her istek öncesi geçtiği
   * ölçüdür.
   */
  tokenize(content: string, options?: TokenizeOptions): Promise<TokenizeResult>;

  /**
   * Verilen mesajlar için runtime'ın sohbet şablonu (chat template)
   * render eder (`/apply-template`) ve ortaya çıkan prompt stringini
   * döndürür.
   */
  renderPrompt(
    messages: InferenceMessage[],
    options?: PromptRenderOptions,
  ): Promise<string>;

  /**
   * `renderPrompt` + `tokenize` bileşiği: render edilmiş prompt'un tam
   * token sayısı. İki HTTP gidiş-dönüşü.
   */
  countPromptTokens(
    messages: InferenceMessage[],
    options?: PromptRenderOptions,
  ): Promise<number>;
}
