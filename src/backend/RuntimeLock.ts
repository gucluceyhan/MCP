import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Süreçler arası Splash inference kilidi (DESIGN.md bölüm 2.7 / 11 madde 3).
 *
 * Disiplin:
 * - Atomik ilke: tek `mkdir` — check-then-create YOK. Kilit dizini zaten
 *   var ise (EEXIST) kilit BAŞKADADIR; sahiplik `owner.json` üzerinden
 *   doğrulanır, beklenmez, zorlanmaz.
 * - Kilit dosyasına ASLA yazılmaz: kaynak kod, prompt, mesaj, model
 *   çıktısı, API anahtarı. Sadece: şema sürümü, PID, opak token, opak
 *   `owner_id`, zaman damgası.
 * - Güvenli bırakma: silinmeden ÖNCE `owner.json` okunur; saklı token ile
 *   eldeki token karşılaştırılır; EŞLEŞME yoksa silme YASAK (tip'li
 *   `LockError` fırlatılır). Bir başkasının kilidini silmek bir sonraki
 *   inference'un aynı anda iki runtime'ı kullanması demektir.
 * - Bayat kilit kurtarması: sahip PID'nin canlılığı `process.kill(pid, 0)`
 *   ile sorgulanır (gerçek sinyal YOK). Ölüm garanti değilse (bilinmeyen
 *   durum, okunamayan kayıt) FAIL CLOSED — belirsiz kilit ASLA silinmez.
 *   Yeni oluşturulmuş (grace dönemi içinde) eksik/kayıtsız kilit de
 *   "meşgul" sayılır; yalnızca yaşlı olanlar kurtarılır.
 * - Kilit durumu `<outputRoot>/runtime/` altındadır — asla bir proje
 *   deposunun içinde değil. Dizini bu sınıf KURULUMDA oluşturmaz; yalnızca
 *   ilk `acquire`'da açar (başlangıç kilitsizdir).
 *
 * Bu sınıf bir kuyruk/planlayıcı DEĞİLDİR: tek kilit, tek token.
 * Aynı süreçte tekrar giriş (re-entrancy) desteklenmez — aynı süreç ikinci
 * kez `acquire` ederse (kendi kilidi hâlâ varken) "busy" alır; seriye almayı
 * Inference Coordinator'ın FIFO'su garanti eder.
 */

/** Bir PID'nin canlılık kararı. */
export type LivenessVerdict = "alive" | "dead" | "unknown";

/**
 * PID canlılık denetçisi (injeksiyon noktası). Üretim implementasyonu
 * `processLiveness`'tır; testler deterministik davranış enjekte eder.
 */
export type PidLiveness = (pid: number) => LivenessVerdict;

/** `owner.json` içeriği — kilit sahibinin kimlik kartı. */
export interface RuntimeLockOwner {
  schema_version: 1;
  /** Kilit alan (ya da bayat kilidin eski) süreç PID'si. */
  pid: number;
  /** `crypto.randomUUID()` — yalnızca kilit alan süreç bunu bilir. */
  token: string;
  /** Opaque sahiplik kimliği (gelecekteki session_id); içerik taşımaz. */
  owner_id: string;
  /** ISO 8601 zaman damgası. */
  acquired_at: string;
}

/** `acquire` sonucu: token (kazanıldı) ya da neden (kazanılamadı). */
export type LockAcquireResult =
  | { acquired: true; token: string }
  | {
      acquired: false;
      /**
       * `busy` — başka bir (canlı) süreç inference'ı sahipleniyor;
       * `uncertain` — kilit durumu güvenle doğrulanamıyor (fail closed).
       */
      reason: "busy" | "uncertain";
    }
;

/** Tip'li kilit hatası: `message` her zaman KISA ve güvenlidir. */
export type LockErrorKind = "token_mismatch" | "owner_invalid" | "release_failed";

export class LockError extends Error {
  constructor(
    readonly kind: LockErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LockError";
  }
}

/** Kilit dizininin adı: `<runtimeDir>/inference.lock`. */
export const INFERENCE_LOCK_DIR = "inference.lock";
/** Sahiplik kaydının adı: `<runtimeDir>/inference.lock/owner.json`. */
export const OWNER_FILE_NAME = "owner.json";

/**
 * Eksik/kayıtsız (ya da bozuk) bir kilit dizini için tolerans penceresi:
 * dizini YENİ OLUŞTURULMUŞ sayılan yaş aralığı. Bu pencere içinde kilit
 * "meşgul" kabul edilir ve dokunulmaz — yarışırdaki bir süreç tam da
 * o anda `owner.json` yazıyor olabilir. Pencereyi aşan kayıt
 * bayat sayılır ve kurtarılır.
 */
export const STALE_LOCK_GRACE_MS = 5_000;

/** Bayat kilit kurtarışından sonra sınırı deneme sayısı. */
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * Üretim PID canlılık denetçisi: `process.kill(pid, 0)` hiçbir sinyal
 * GÖNDERMEZ — yalnızca varoluşu denetler. Başarılı ya da `EPERM`
 * (başka kullanıcının süreci: var demektir) → `alive`; `ESRCH` → `dead`;
 * başka her şey → `unknown` (fail closed).
 */
export function processLiveness(pid: number): LivenessVerdict {
  if (!Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return "alive";
    }
    if (code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
}

export interface RuntimeLockOptions {
  /** Enjekte edilebilir saat (ms epoch); testler sabit değer kullanır. */
  now?: () => number;
  /** Enjekte edilebilir canlılık denetçisi (varsayılan: `processLiveness`). */
  liveness?: PidLiveness;
}

/** `owner.json`'dan güvenle çıkarılan alanlar (okuma tarafı). */
interface StoredOwner {
  pid: number;
  token: string;
}

export class RuntimeLock {
  #runtimeDir: string;
  #lockDir: string;
  #ownerFile: string;
  #now: () => number;
  #liveness: PidLiveness;

  constructor(runtimeDir: string, options: RuntimeLockOptions = {}) {
    this.#runtimeDir = runtimeDir;
    this.#lockDir = path.join(runtimeDir, INFERENCE_LOCK_DIR);
    this.#ownerFile = path.join(this.#lockDir, OWNER_FILE_NAME);
    this.#now = options.now ?? Date.now;
    this.#liveness = options.liveness ?? processLiveness;
  }

  /**
   * İnference kilidini almaya çalışır.
   *
   * Kazanıldığında `owner.json` yazılır ve token dönür. Kaybedildiğinde
   * (başka bir süreç kilitte) ASLA beklemez — `busy`/`uncertain` ile
   * derhal döner; beklemek ya da gizli iş kuyruğu Inference
   * Coordinator'ın (aynı süreç FIFO'su) tek yetkisidir.
   */
  async acquire(ownerId: string): Promise<LockAcquireResult> {
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw new LockError("owner_invalid", "ownerId must be a non-empty string");
    }
    await this.#ensureRuntimeDir();

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const token = randomUUID();
      try {
        // Atomik ilke: dizin varsa mkdir EEXIST ile reddedilir —
        // iki süreç aynı anda kazanamaz.
        await mkdir(this.#lockDir, { mode: 0o700 });
      } catch (err) {
        if (!isErrno(err, "EEXIST")) {
          // Gerçek bir fs hatası (izin, eksik üst dizin, ...): fail closed.
          return { acquired: false, reason: "uncertain" };
        }
        const verdict = await this.#inspectExistingLock();
        if (verdict === "busy" || verdict === "uncertain") {
          return { acquired: false, reason: verdict };
        }
        // `stale`: sahibi kesin ölü (ya da yaşlı eksik kayıt) —
        // güvenle kurtar ve yeniden dene.
        await this.#reclaimStaleLock();
        continue;
      }

      // mkdir başarılı — dizin BİZİM. Sahiplik kaydını yayımla.
      const owner: RuntimeLockOwner = {
        schema_version: 1,
        pid: process.pid,
        token,
        owner_id: ownerId,
        acquired_at: new Date(this.#now()).toISOString(),
      };
      try {
        await writeFile(this.#ownerFile, `${JSON.stringify(owner, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch {
        // Yalnızca BİZ oluşturduğumuz dizin bu noktada eksik kayda
        // sahiptir (token henüz yayımlanmadı — hiç kimse sahipliği
        // doğrulayamaz). Kendi yarım kalıntımızı temizle; fail closed.
        await bestEffortRm(this.#lockDir);
        return { acquired: false, reason: "uncertain" };
      }
      // Modları kesinleştir (umask'e rağmen); pratik olmadığında hata
      // YOKTU — sahiplik token'la korunur, mod ikincil bir derinliktir.
      await bestEffortChmod(this.#lockDir, 0o700);
      await bestEffortChmod(this.#ownerFile, 0o600);
      return { acquired: true, token };
    }

    // Sınırlı yeniden deneme tükendi (kalıcı kurtarma yarışı): fail closed.
    return { acquired: false, reason: "uncertain" };
  }

  /**
   * Kilidi BIRAKIR — asla körü körüne silmez. `owner.json` okunur; saklı
   * token ile kilit alan tarafın elindeki token karşılaştırılır ve yalnızca
   * eşleşmede dizin kaldırılır. Eşleşme yoksa (kilit artık başkasına
   * ait) `LockError` fırlatılır — kilit yerinde kalır, sahibi ya kendi
   * bırakır ya bayat sayılıp kurtarılır.
   */
  async release(token: string): Promise<void> {
    let dirExists = true;
    try {
      const info = await stat(this.#lockDir);
      dirExists = info.isDirectory();
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        // Kilit dizini yok (başka süreç bayat sayıp kurtardı ya da
        // zaten bırakıldı): bırakma bir no-op'tur — idempotent.
        return;
      }
      throw new LockError(
        "release_failed",
        "Could not release the inference lock (lock directory unreadable)",
      );
    }
    if (!dirExists) {
      // Bir dosya/kısaltma yolu (bizim dizin değil): dokunulmaz.
      throw new LockError(
        "owner_invalid",
        "The inference lock path is not a directory; refusing to remove it",
      );
    }

    let raw: string;
    try {
      raw = await readFile(this.#ownerFile, "utf8");
    } catch {
      // Dizin var ama kayıt okunamıyor: sahiplik doğrulanamıyor —
      // doğrulanamayan kilit silinmez.
      throw new LockError(
        "owner_invalid",
        "The inference lock owner record is missing or unreadable; refusing to remove the lock",
      );
    }
    const stored = tryParseStoredOwner(raw);
    if (stored === null) {
      throw new LockError(
        "owner_invalid",
        "The inference lock owner record is not valid; refusing to remove the lock",
      );
    }
    if (stored.token !== token) {
      // Kilit BİZİMKİ DEĞİL (biz çöküp kurtarıldık; başkası aldı).
      // Başkasının kilidini silmek iki runtime'ın aynı anda
      // inference yapmasına yol açar — asla.
      throw new LockError(
        "token_mismatch",
        "The inference lock is owned by another session; refusing to remove it",
      );
    }
    try {
      await rm(this.#lockDir, { recursive: true, force: true });
    } catch {
      throw new LockError(
        "release_failed",
        "Could not remove the inference lock directory",
      );
    }
  }

  // ── iç yardımcılar ─────────────────────────────────────────────────────

  /** Runtime kök dizinini oluşturmaya çalışır; hata kilidi fail-closed yapar. */
  async #ensureRuntimeDir(): Promise<void> {
    try {
      await mkdir(this.#runtimeDir, { recursive: true, mode: 0o700 });
    } catch {
      // Mevcut dizin ya da fs pahası: sonraki kilit-dizini mkdir'ı
      // gerçek hatayı (uncertain) yüzeye çıkarır.
      return;
    }
    await bestEffortChmod(this.#runtimeDir, 0o700);
  }

  /**
   * Mevcut kilit dizinini denetler:
   *  - `busy` — canlı sahip, ya da grace dönemi içinde eksik/bozuk kayıt
   *    (yeni oluşturulmuş olabilir): dokunulmaz.
   *  - `uncertain` — durum güvenle kurulamıyor (okunamayan kayıt,
   *    doğrulanamayan canlılık): fail closed.
   *  - `stale` — sahip KESİN ölü, ya da grace dönemini aşmış eksik/bozuk
   *    kayıt: güvenle kurtarılabilir.
   */
  async #inspectExistingLock(): Promise<"busy" | "uncertain" | "stale"> {
    let info;
    try {
      info = await stat(this.#lockDir);
    } catch (err) {
      // Yarış sırasında kurtarılmış olabilir: yeniden mkdir dene.
      if (isErrno(err, "ENOENT")) {
        return "stale";
      }
      return "uncertain";
    }
    if (!info.isDirectory()) {
      return "uncertain";
    }

    // Yaş yalnızca EKSİK/BOZUK kayıt için anlamlıdır (canlılık
    // doğrulanamayan sahiplik belirsizliğine tolerans penceresi koyar).
    const ageMs = this.#now() - info.mtimeMs;
    const withinGrace = ageMs < STALE_LOCK_GRACE_MS;

    let raw: string | null = null;
    try {
      raw = await readFile(this.#ownerFile, "utf8");
    } catch (err) {
      if (!isErrno(err, "ENOENT")) {
        // Okunamayan kayıt (izin, ...): fail closed.
        return "uncertain";
      }
      // Eksik kayıt (mkdir ile kayıt yazımı arasında çöküş):
      // yeni → meşgul say; yaşlı → bayat.
      return withinGrace ? "busy" : "stale";
    }

    const stored = tryParseStoredOwner(raw);
    if (stored === null) {
      // Bozuk kayıt: eksik kayıtla aynı yaş kuralı.
      return withinGrace ? "busy" : "stale";
    }

    const verdict = this.#liveness(stored.pid);
    if (verdict === "alive") {
      return "busy";
    }
    if (verdict === "dead") {
      return "stale";
    }
    // Doğrulanamayan canlılık: fail closed — silinmez.
    return "uncertain";
  }

  /**
   * Bayat kilidi güvenle kurtarır: kilit dizinini benzersiz bir
   * mezar taşına (`inference.lock.stale.<uuid>`) ATOMİK rename eder,
   * mezar taşı yalnızca rename eden süreç tarafından kaldırılır.
   * Yarışı başka süreç kazandıysa rename hata verir; o durumda kurtarma
   * yapılmaz ve `acquire` normal yoldan yeniden dener.
   */
  async #reclaimStaleLock(): Promise<void> {
    const tombstone = path.join(
      this.#runtimeDir,
      `${INFERENCE_LOCK_DIR}.stale.${randomUUID()}`,
    );
    let renamed = false;
    try {
      await rename(this.#lockDir, tombstone);
      renamed = true;
    } catch {
      renamed = false; // Dizin yok ya da başka süreç kaptı.
    }
    if (renamed) {
      // Mezar taşı kilit YOLU değil — inaktif bir kalıntıdır.
      // Kaldırılamazsa (fs pahası) sistem etkilenmez; en iyi çaba.
      await bestEffortRm(tombstone);
    }
  }
}

// ── modül-privat yardımcılar ─────────────────────────────────────────────

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // İkincil derinlik: sahiplik token'la korunur; mod ayarı
    // yapılamaması kilidi geçersiz kılmaz.
  }
}

async function bestEffortRm(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // Yalnızca KENDİ yarım kalıntılarımız için çağrılır; yine de
    // sessizce geç (asıl sahiplik koruması token'dadır).
  }
}

/** `owner.json`'u güvenli bir şekilde ayrıştırır; doğrulanamıyorsa `null`. */
function tryParseStoredOwner(raw: string): StoredOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { pid, token } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return { pid, token };
}
