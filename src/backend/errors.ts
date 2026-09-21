/**
 * Tip'li inference backend hataları (DESIGN.md bölüm 2.5).
 *
 * Disiplin — `message` / `cause` bölünmesi (DESIGN.md bölüm 9):
 * - `kind` makine-okunur, kararı istikrarlı bir sınıflandırmadır.
 * - `message` KISA ve GÜVENELİDİR: yalnız durum + uç (endpoint) adını taşır;
 *   istek gövdesini, yanıt gövdesini, model mesaj içeriğini ve API anahtarını
 *   ASLA içermez. Inference Coordinator (Step 3) `message`'i frontier'a
 *   yüzeyine taşır — o yüzden `message` fragment-taşıyan bir metin asla
 *   değildir.
 * - `cause` TEKNİK geliştirici kanalıdır; `message`'in parçası DEĞİLDİR:
 *   - `kind: "network"`      → orijinal hata nesnesi (fetch hatası / AbortError)
 *   - `kind: "http"`         → yanıt gövdesinden ≤200 karakterlik detay dizesi
 *     (`error.message` / üst düzey `message`) ya da parse edilemezse `undefined`
 *   - `kind: "invalid_response"` → `undefined` — JSON parse hatası
 *     (V8 `SyntaxError`) mesajında gövde snippet'i barındıracağı için
 *     ASLA saklanmaz; şekil hatalarında da `undefined`
 *   - diğer türler           → genellikle `undefined`
 *
 * Redaksiyon kuralı: API anahtarı yapılandırıldıysa, 2xx-dışı bir yanıt
 * gövdesinden çıkarılan detayda anahtarın her birebir geçişi
 * `[REDACTED]` ile değiştirilir (kırpamadan ÖNCE) — böylece anahtar,
 * runtime/proxy onu hata gövdesine yansıtsa bile ne `message`'de ne
 * `cause`'ta asla görünmez.
 */

export type BackendErrorKind =
  /** Runtime 2xx dışı bir HTTP durumla döndü; `status` dolu, gövde detayı `cause`'ta. */
  | "http"
  /** Runtime'a hiç ulaşılamadı (bağlantı hatası) ya da istek iptal edildi. */
  | "network"
  /** Runtime'ın `/status` ya da model listesi geçerli bir durum raporlamadı. */
  | "invalid_status"
  /** Runtime, yapılandırılan modelin farklı bir modeli sunuyor. */
  | "model_mismatch"
  /** 2xx dönen yanıt beklenen şekle uymuyor. */
  | "invalid_response"
  /** İşaretleyicinin (caller) kendi istek seçenekleri doğrulamadan geçemedi. */
  | "invalid_request";

export interface BackendErrorOptions {
  /** HTTP durum kodu; yalnızca `kind: "http"` için anlamlıdır. */
  status?: number;
  /**
   * Teknik kanal (bkz. dosya başlığı): `kind: "http"` için yanıt gövdesinden
   * ≤200 karakterlik detay dizesi; `kind: "network"` için orijinal hata
   * nesnesi; `invalid_response` için her zaman `undefined` (parse hatası
   * gövde snippet'i taşır). `message` her zaman GÜVENLİ kalır; detay
   * yalnız burada durur.
   */
  cause?: unknown;
}

export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    options: BackendErrorOptions = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; tekrar atama gerekmez.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BackendError";
    this.status = options.status;
  }

  /** `kind` "http" ise HTTP durum kodu. */
  readonly status?: number;

  // Not: `cause` alanı yeniden DEKLARE EDİLMEZ — ES2022 `Error`'den
  // (options ile) miras alınır. (target ES2022 → define-semantics: boş
  // alan deklarasyonu, `super()`'ın kurduğu değeri `void 0` ile ezerdi.)
}
