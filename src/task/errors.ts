/**
 * Step 6+9: tip'li görev katmanı hatası (güvenli mesaj; payload YOK).
 *
 * Bu dosya yalnızca tip + hatayı taşır — hiçbir I/O, orkestrasyon ya da
 * yaşam döngüsü mantığı YOK (spec 3: küçük modüller). `SplashTaskService`
 * (orkestrasyon) ve `SessionManager` (yaşam döngüsü) her ikisi de aynı
 * sözlüğü paylaşır; `wire.ts` `serializeToolError` bunu tanıyarak
 * yalnız `kind` + sabit `message`'i yüzeye taşır (`cause` ASLA — spec 12/13).
 *
 * `message` her zaman KISA ve SABİTtir: ham JSON, kural içeriği, worker
 * patch'i, mutlak özel yol, git stderr, errno detayı ASLA mesajda YOK.
 * Teknik detay (`cause`) yalnız geliştirici kanalıdır.
 */

export type SplashTaskErrorKind =
  /** Görev girdi sözleşmesine uymuyor (task/files/override'lar/session_id/feedback) — MCP şemasının derin savunması. */
  | "invalid_input"
  /**
   * Yapılandırılmış outputRoot, repository ile çelişiyor: `outputRoot ==
   * repoRoot` ya da outputRoot repo İÇİNDE — `sessions` dizini kullanıcı
   * projesinin içine düşer — session mkdir'ından ÖNCE red. (Repo, outputRoot
   * içinde OLMASI tek başına red DEĞİLDİR: `<outputRoot>/sessions/<id>`
   * repository ağacının dışında kalır; workspace dizinini Step 5 fabrikası
   * ayrıca doğrular.)
   */
  | "output_root_unsafe"
  /** Enjekte ID fabrikası güvenli/tekil bir kimlik üretemedi ya da kayıt çakışması. */
  | "session_conflict"
  /** Workspace imhası ya da session dizini temizliği başarısız (spec 74). */
  | "task_cleanup_failed"
  /** Runtime dispose edilmiş — yeni görev/refine kabul edilmez (spec 69/71). */
  | "shutting_down";

export class SplashTaskError extends Error {
  constructor(
    readonly kind: SplashTaskErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; alan yeniden declare edilmez.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SplashTaskError";
  }
}
