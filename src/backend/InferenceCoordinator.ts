import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
  RuntimeInfo,
} from "./InferenceBackend.js";
import { RuntimeLock, type LockAcquireResult, type PidLiveness } from "./RuntimeLock.js";
import {
  createPsScanner,
  RuntimeConflictDetector,
  type ConflictKind,
  type ProcessScanner,
} from "./RuntimeConflictDetector.js";

/**
 * Küresel inference koordinatörü (DESIGN.md bölüm 2.7 / 11 madde 3).
 *
 * v1 inference yolu:
 *   Splash session → InferenceCoordinator → OpenAICompatBackend →
 *   yapılandırılmış yerel Splash runtime
 *
 * Bu sınıf tek sorumluluğa sahiptir: bu makinede yerel model
 * jenerasyonu TEK SERİ KAYNAKTIR. Birden fazla (gelecek) session
 * eşzamanlı var olabilir; jenerasyonları bu koordinatör TEK FIFO
 * kuyruğunda sıralar — bir anda tam olarak BİR `backend.run()`
 * çalışır.
 *
 * Kurallar (tasarımın son sözü):
 * - Aynı süreç beklemesi NORMAL'dİR: ikinci istek kuyruğa girer,
 *   sırası gelince NORMAL sonuçla döner — `inference_busy` DEĞİLdir.
 * - Farklı bir Splash SÜRECİ kilidi tutuyorsa: beklenmez, gizli iş
 *   kuyruğa alınmaz, backend ÇAĞRILMAZ — derhal
 *   `{status:"inference_busy", conflict:"splash"}`.
 * - Host'ta dış runtime (MLX / Ollama / ikinci Splash) algılanırsa:
 *   aynı şekilde derhal `inference_busy` — geri deneme, zamanlayıcı,
 *   arka plan işi, polling YOK; `dispatch` çözümlendi, iş BİTTİ.
 * - Jenerasyon içi iptal YALNIZCA caller'ın `AbortSignal`'idir;
 *   icat edilmiş bir timeout YOK.
 * - Runtime BAŞLATILMAZ/DEĞİŞTİRİLMEZ: bu sınıf bir gözlemci +
 *   seriyeleyicidir, süreç denetçisi DEĞİLDİR (kill/restart yok).
 * - Kilit her dispatch yolunda bırakılır; BIRAKMA HATASI ASLA YUTULMAZ:
 *   iş, tip'li `lock_release_failed` REDİ ile çözümlenir. Öncelik
 *   (tek settlement noktası, release SONRASI):
 *     A) inference başarılı + release başarılı  → normal `completed`
 *     B) inference başarılı + release HATA      → `completed` DÖNMEZ;
 *        `lock_release_failed` red (asla sahte başarı yok)
 *     C) backend hata + release başarılı        → orijinal `BackendError`
 *        aynen yayılır
 *     D) backend hata + release HATA            → cleanup hatası yüzeyde;
 *        orijinal inference hatası YALNIZ `cause` olarak korunur
 *   (busy/çakışma ve aktif-iptal yollarına da aynı kural: release hatası
 *   varken `completed` ya da `inference_busy` ile ASLA çözülmez.)
 *
 * Gözlemlenebilirlik:
 * - `activeOwnerId`: kuyruktan çıkıp dispatch'e başlamış işin opak
 *   `ownerId`'si; yoksa `null`. (finally'de temizlenir.)
 * - `queueDepth`: aktif işin ARKASINDA bekleyen (henüz dispatch
 *   edilmemiş) iş sayısı — aktif iş dahil DEĞİLDİR.
 * - Kuyruktaki mesaj/istek içeriği hiçbir gözlem yolundan dışarı
 *   taşmaz.
 *
 * Sınır: bu sıradan bir sınıftır — ortamda (ambient) global
 * singleton DEĞİLDİR. Bir Splash MCP SÜRECİ tam olarak TEK örnek
 * oluşturur ve tüm session'lar paylaşır (server kompozisyonu, sonraki
 * adım). Testler bağımsız örnekler kurabilir.
 *
 * Runtime durumu: kilit + state `<outputRoot>/runtime/` altındadır —
 * `runtimeDir` constructor parametresi olarak GELİR (coordinator ev
 * dizinini kendisi ÇIKARMAZ; `loadConfig` `~/.splash`'ı çözer).
 * Konstrüksiyon hiçbir dosya sistemi işlemi YAPMAZ: kilit dizini
 * yalnızca ilk `dispatch` anında açılır.
 */

/** Koordinatöre iletilen inference isteği. */
export interface CoordinatedInferenceRequest {
  /** Opaque, boş olmayan sahip kimliği (gelecekteki session_id). */
  ownerId: string;
  messages: InferenceMessage[];
  /** Caller seçenekleri (içinde `AbortSignal`); backend'e aynen geçer. */
  options?: InferenceRunOptions;
}

/** `inference_busy` metadata'sındaki çakışma türü (kapalı sözlük). */
export type InferenceConflict = "splash" | "mlx" | "ollama" | "unknown";

/**
 * `dispatch` sonucu:
 * - `completed` — jenerasyon tamamlandı (`result` = backend çıktısı).
 * - `inference_busy` — inference kaynağı meşgul; metadata YALNIZCA
 *   `{status, conflict}`'tır (komut, PID, yol, içerik ASLA taşınmaz).
 */
export type CoordinatedInferenceResult =
  | { status: "completed"; result: InferenceResult }
  | { status: "inference_busy"; conflict: InferenceConflict };

/** Küçük, koordinatöre özgü tip'li hata (güvenli mesaj; içerik yok). */
export type CoordinatorErrorKind =
  | "aborted"
  | "invalid_request"
  | "lock_release_failed";

export class CoordinatorError extends Error {
  constructor(
    readonly kind: CoordinatorErrorKind,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    // `cause` buradan (ES2022 Error) alınır; tekrar atama gerekmez.
    // (Tam olarak `BackendError` deseni — `src/backend/errors.ts`.)
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoordinatorError";
  }
}

/** Ön-kapı iptali: dispatch'in kuyruk-iptaliyle AYNI tip'li hata (LOW-1). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new CoordinatorError("aborted", "Inference request was aborted before it started");
  }
}

/**
 * `acquire`'ı her koşulda bir Promise'a çevirir: senkron throw → red (dispatch
 * fail-closed yolunu, ön-kapı beklemesini aynı biçimde görür). Yerel Promise
 * aynen döner — ek tick yok.
 */
function startAcquire(lock: RuntimeLockLike, ownerId: string): Promise<LockAcquireResult> {
  try {
    return Promise.resolve(lock.acquire(ownerId));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Koordinatörün kullandığı kilit sözleşmesi (injeksiyon dikişi). Üretim
 * implementasyonu `RuntimeLock`'tur (süreçler arası, token-doğrulamalı);
 * testler release hatası modelleyen sahte bir kilit enjekte edebilir.
 */
export interface RuntimeLockLike {
  acquire(ownerId: string): Promise<LockAcquireResult>;
  release(token: string): Promise<void>;
  /**
   * İsteğe bağlı salt-okunur yoklama (İz 2 / M4 ön-kapısı) — `RuntimeLock`
   * sağlar. Yoksa ön-kapı kilit adımını atlar (dispatch yine yetkilidir).
   */
  peek?(): Promise<"free" | "busy" | "uncertain">;
}

/**
 * `probe` sonucu: `clear` — ölçüm trafiği başlayabilir (dispatch yine her
 * şeyi YENİDEN denetler); `inference_busy` — dispatch'in vereceği aynı
 * kapalı sözlükle meşgul.
 */
export type InferenceProbeResult =
  | { status: "clear" }
  | { status: "inference_busy"; conflict: InferenceConflict };

/**
 * Injeksiyon dikişleri — üretimde yalnızca `runtimeDir` + `backend`
 * (kilit, scanner, liveness, saat: varsayılanları üretime ait).
 */
export interface CoordinatorDeps {
  /** Yaprak HTTP adaptörü (kendi planlaması yok; seriyeleyen burası). */
  backend: InferenceBackend;
  /** Runtime durumu kökü: `<outputRoot>/runtime` (constructor parametresi). */
  runtimeDir: string;
  /** Host süreç tarayıcısı (varsayılan: `ps` üzerinden, kabuksuz). */
  scanner?: ProcessScanner;
  /** PID canlılık denetçisi (varsayılan: `process.kill(pid, 0)`). */
  liveness?: PidLiveness;
  /** Saat (ms epoch) (varsayılan: `Date.now`). */
  now?: () => number;
  /**
   * Kilit (varsayılan: `new RuntimeLock(runtimeDir, {now, liveness})`).
   * Test dikişi — release hatası senaryoları sahte kille
   * (fake) modellenir.
   */
  lock?: RuntimeLockLike;
}

interface QueuedJob {
  request: CoordinatedInferenceRequest;
  resolve: (result: CoordinatedInferenceResult) => void;
  reject: (err: unknown) => void;
  /** Kuyrukta iken iptali için kayıtlı dinleyici (settled'da sökülür). */
  abortHandler?: () => void;
}

export class InferenceCoordinator {
  #backend: InferenceBackend;
  #lock: RuntimeLockLike;
  #detector: RuntimeConflictDetector;

  /** FIFO: aktif işin arkasında bekleyen işler (sıralı, önceliksiz). */
  #queue: QueuedJob[] = [];
  /** Şu an dispatch edilen iş — her an en fazla BİR'i var olabilir. */
  #active: QueuedJob | null = null;
  /** `activeOwnerId` alanı (dequeue'da ayarlanır, finally'de temizlenir). */
  #activeOwnerId: string | null = null;
  /**
   * Bu süreç inference kilidini FİİLEN tutuyor mu: `acquire` `acquired:true`
   * döndükten SONRA kurulur, release denemesi bitince (başarılı ya da değil)
   * temizlenir. `#active` sahiplik kanıtı DEĞİLDİR (Codex P2): dequeue olmuş
   * işin `acquire`'ı hâlâ bekliyor ya da yabancı sahip bildirecek olabilir;
   * release sonrası da pump temizliğine dek dolu kalır. Ön-kapı (`probe`)
   * yoklamayı yalnız buna dayanarak atlar.
   */
  #lockHeld = false;
  /**
   * Bu süreçte SÜRMEKTE olan acquire denemesi (yoksa `null`; acquire
   * sonuçlanınca `finally`'de temizlenir). Ön-kapı, yoklama meşgul derken
   * gözlenen sahibin bizim yarım kilidimiz olup olmadığını bunun sonucuyla
   * ayırır (DESIGN 2.7: aynı süreç dispatch'i ASLA çakışma değildir).
   */
  #acquiring: Promise<LockAcquireResult> | null = null;

  constructor(deps: CoordinatorDeps) {
    this.#backend = deps.backend;
    // Üretim varsayılanı aynen: `RuntimeLock(runtimeDir, {now, liveness})`;
    // testler `lock` enjekte edebilir (örn. release hatası senaryoları).
    this.#lock =
      deps.lock ??
      new RuntimeLock(deps.runtimeDir, {
        now: deps.now,
        liveness: deps.liveness,
      });
    this.#detector = new RuntimeConflictDetector(deps.scanner ?? createPsScanner());
  }

  /**
   * Bir inference isteğini FIFO'ya iletir. Promise şu anlarda çözümlenir:
   * - sırası geldiğinde jenerasyon tamamlanınca → `completed`
   *   (ya da backend/refresh hatası → tip'li `BackendError` yayılır)
   * - kilit başka süreçteyse → derhal `inference_busy`/`splash`
   * - runtime kimliği yoksa / scanner başarısızsa → `inference_busy`/`unknown`
   * - host'ta dış runtime varsa → derhal `inference_busy`/<tür>
   * - kuyruktayken iptal edilirse → `CoordinatorError`("aborted")
   * - dispatch SONRASI kilit bırakılamadıysa →
   *   `CoordinatorError`("lock_release_failed") — bu durumda iş ASLA
   *   `completed` ya da `inference_busy` ile (sahte) başarı olarak
   *   çözülmez; cleanup hatası yüzeye çıkar (dosya dok. önceliği A-D).
   */
  dispatch(request: CoordinatedInferenceRequest): Promise<CoordinatedInferenceResult> {
    if (typeof request.ownerId !== "string" || request.ownerId.length === 0) {
      return Promise.reject(
        new CoordinatorError(
          "invalid_request",
          "Inference ownerId must be a non-empty string",
        ),
      );
    }

    const job: QueuedJob = { request, resolve: () => {}, reject: () => {} };
    const promise = new Promise<CoordinatedInferenceResult>((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });

    this.#queue.push(job);

    // Caller'ın `AbortSignal`'i: kuyrukta iken iptal, işi KUYRUKTAN
    // ÇIKARIR (backend asla çağrılmaz, kilit asla alınmaz, gizli
    // sonra-infans YOK); aktif iken aynı sinyal backend'e geçer ve
    // `finally` kilidi bırakır.
    const signal = request.options?.signal;
    if (signal !== undefined) {
      const drop = (): void => {
        const index = this.#queue.indexOf(job);
        if (index !== -1) {
          this.#queue.splice(index, 1);
        }
        job.reject(
          new CoordinatorError("aborted", "Inference request was aborted before it started"),
        );
      };
      if (signal.aborted) {
        // Zaten iptal edilmiş: dinleyici kurmaya gerek yok.
        drop();
      } else {
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          // Sadece hâlâ KUYRUKTAYSA düşürülür; aktif işin iptali
          // signal üzerinden backend'e kendiliğinden akar.
          const index = this.#queue.indexOf(job);
          if (index !== -1) {
            this.#queue.splice(index, 1);
            job.reject(
              new CoordinatorError(
                "aborted",
                "Inference request was aborted before it started",
              ),
            );
          }
        };
        job.abortHandler = onAbort;
        signal.addEventListener("abort", onAbort);
      }
    }

    this.#pump();
    return promise;
  }

  /**
   * Ölçüm trafiği ÖNCESİ kilit ALMAYAN ön-kapı (İz 2 / M4; DESIGN.md 2.5:
   * adaptör yalnız koordinatör üzerinden). Context Assembler'ın runtime
   * ölçümleri (`/status`, `/v1/models`, `/apply-template`, `/tokenize`)
   * FIFO'dan geçmez; bu yoklama, meşgul bir host'ta ölçüm yapılmadan
   * `inference_busy` dönülmesini sağlar. Danışma niteliğindedir (TOCTOU):
   * `dispatch` kilidi alıp her şeyi yeniden denetler.
   *
   * Sıra (dispatch'in haritasıyla birebir):
   *  0. sinyal zaten iptalse → tip'li `aborted` (dispatch'in iptal sözlüğü);
   *  1. bu süreç kilidi FİİLEN tutmuyorsa kilit yoklaması: canlı sahip →
   *     `splash`, doğrulanamıyor → `unknown` — kilit meşgulse runtime'a HİÇ
   *     gidilmez. Bu süreç kilidi fiilen tutuyorsa (`acquire` başarıyla
   *     dönmüş, release bitmemiş — yoklama öncesinde ya da yoklama SÜRERKEN)
   *     kilit BİZİMDİR — aynı süreç dispatch'i ASLA çakışma DEĞİLDİR (LOW-2;
   *     DESIGN 2.7). Yalnız dequeue olmuş bir dispatch kanıt DEĞİLDİR (Codex
   *     P2): yoklama meşgul/doğrulanamaz derken bu süreçte bir acquire
   *     sürüyorsa gözlenen sahip onun yarım kilidi olabilir — o acquire'ın
   *     SONUCU beklenir: alındı → kilit bizim; alınamadı/hata → yabancı
   *     sahip doğrulandı, yoklamanın kararı geçerli (runtime'a temas yok).
   *     Bekleme sınırlıdır (acquire başka süreci BEKLEMEZ) ve caller
   *     sinyaliyle kesilir. Yoklamadan (ve bu beklemeden) sonra sinyal
   *     iptalse → `aborted` (LOW-1);
   *  2. host taraması için YALNIZ runtime kimliği yenilenir (`/status` +
   *     `/v1/models`; asla önbellek — yeniden başlamış runtime'ın PID'i);
   *     tokenize/şablon ölçümü YOK; hata tip'li olarak AYNEN yayılır;
   *  3. kimlik yok → `unknown`; tarama hatası → `unknown`; çakışma → tür.
   * Hiçbir kilit alınmaz, hiçbir dosya yazılmaz, jenerasyon yapılmaz.
   */
  async probe(signal?: AbortSignal): Promise<InferenceProbeResult> {
    throwIfAborted(signal);
    if (!this.#lockHeld && this.#lock.peek !== undefined) {
      let state: "free" | "busy" | "uncertain";
      try {
        state = await this.#lock.peek();
      } catch {
        state = "uncertain";
      }
      throwIfAborted(signal);
      // Yoklama sürerken bu süreçteki bir dispatch kilidi FİİLEN aldıysa
      // gözlenen sahip biziz. Yalnız dequeue (acquire sonuçlanmamış) kanıt
      // değildir — gözlenen sahip yabancı olabilir.
      let ownLock: boolean = this.#lockHeld;
      const ownAttempt = this.#acquiring;
      if (!ownLock && state !== "free" && ownAttempt !== null) {
        // Gözlenen sahip bu süreçte sürmekte olan acquire'ın YARIM kilidi
        // olabilir: karar o acquire'ın sonucuna bırakılır.
        ownLock = await this.#awaitOwnAcquire(ownAttempt, signal);
        throwIfAborted(signal);
      }
      if (state === "busy" && !ownLock) {
        return { status: "inference_busy", conflict: "splash" };
      }
      if (state === "uncertain" && !ownLock) {
        return { status: "inference_busy", conflict: "unknown" };
      }
    }
    const info = await this.#backend.refreshRuntimeInfo(signal);
    if (info.runtimeProcessId === undefined) {
      return { status: "inference_busy", conflict: "unknown" };
    }
    let conflict: ConflictKind;
    try {
      conflict = await this.#detector.detect(info.runtimeProcessId);
    } catch {
      return { status: "inference_busy", conflict: "unknown" };
    }
    return conflict === "none" ? { status: "clear" } : { status: "inference_busy", conflict };
  }

  /** Aktif işin opak `ownerId`'si; hiçbir iş dispatch'de değilse `null`. */
  get activeOwnerId(): string | null {
    return this.#activeOwnerId;
  }

  /**
   * Aktif işin arkasında BEKLEYEN iş sayısı (kuyrukta, henüz dispatch
   * edilmemiş). Aktif iş dahil DEĞİLDİR.
   */
  get queueDepth(): number {
    return this.#queue.length;
  }

  // ── iç mekanizma ───────────────────────────────────────────────────────

  /**
   * Bu süreçte sürmekte olan acquire'ın SONUCUNU bekler (ön-kapı): `true` →
   * kilit bizim; `false` → alınamadı ya da hata (yabancı sahip doğrulandı).
   * Sonsuz bekleme yolu YOK: kilit sözleşmesi gereği `acquire` başka süreci
   * BEKLEMEZ (busy/uncertain ile derhal döner, yeniden denemesi sınırlı) —
   * yalnız kendi dosya işlemleri kadar sürer. Caller sinyali beklemeyi
   * keser → tip'li `aborted` (dispatch'in iptal sözlüğü).
   */
  async #awaitOwnAcquire(
    attempt: Promise<LockAcquireResult>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const own = attempt.then(
      (result) => result.acquired,
      () => false,
    );
    if (signal === undefined) {
      return own;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new CoordinatorError("aborted", "Inference request was aborted before it started"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([own, aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * FIFO pompası: aktif iş yoksa kuyruğun BAŞINDAKİ işi (sırası geleni)
   * dispatch eder. Sıra kuyruk yapısı gereği belirgindir: A→B→C —
   * asla A+B eşzamanlı, asla A→C→B. Öncelik, paralellik ya da arka
   * plan jenerasyonu yoktur.
   */
  #pump(): void {
    if (this.#active !== null) {
      return;
    }
    const job = this.#queue.shift();
    if (job === undefined) {
      return;
    }
    this.#active = job;
    // Dequeue olmuş iş dispatch'tedir: sahiplik artık ona aittir.
    this.#activeOwnerId = job.request.ownerId;

    const done = this.#runJob(job);
    done
      .finally(() => {
        // Önce kilidin bırakıldığına (runJob finally'si) sonra
        // sahipliğin temizlendiğine emin olunur — sıradaki iş ancak
        // bu sarmal tamamlanınca dispatch edilir.
        if (this.#active === job) {
          this.#active = null;
          this.#activeOwnerId = null;
        }
        this.#pump();
      })
      .catch(() => {
        // #runJob işin promise'ını kendi içinde çözer; bu koruma yalnızca
        // iç bir kusurun unhandled rejection'a dönüşmesini engeller.
      });
  }

  /**
   * Bir işin dispatch sırası (tasarım madde 19, birebir) + release
   * hatası settlement kuralı:
   *  1. kuyrukta iptal edilmiş mi? → güvenli tip'li red (kilit/alan yok)
   *  2. süreçler arası kilidi al
   *  3. kilit başka süreçte → inference_busy (splash / unknown)
   *     (kilit ALINMADI — bırakılacak bir şey yok; busy doğrudan çözülür)
   *  4. runtime bilgisini YENİLE (dispatch BAŞINDA; asla önbellek yok)
   *  5. yapılandırılan runtime'ın PID'sini al
   *  6. kullanılır kimlik yok → inference_busy/unknown (fail closed)
   *  7. host süreç tablosunu tara (scanner)
   *  8. yapılandırılan Splash ağacını (PID + tüm torunlar) çıkar
   *  9. çakışan runtime'ları sınıflandır (splash / mlx / ollama)
   * 10. çakışma var → inference_busy/<tür> (backend çağrılmaz)
   * 11. backend.run(messages, options) — options (sinyalle) aynen geçer
   * 12. "niyet edilen settlement" KARARLAŞIR (completed / busy /
   *     orijinal tip'li hata) — ama henüz ÇÖZÜLMEZ
   * 13. kilidi `finally`'de bırak (token-doğrulamalı) — HER YOLDA;
   *     bırakma hatası YAKALANIR, YUTULMAZ
   * 14. TEK settlement noktası (release SONRASI) — öncelik:
   *     - release başarılı → niyet edilen settlement aynen (A / C / busy)
   *     - release HATA     → tip'li `lock_release_failed` RED; orijinal
   *       inference hatası varsa YALNIZ `cause`'ta (B / D) — tek red
   * 15. sahipliği temizle (pump finally'si); FIFO devam eder (release
   *     hatası kuyruğu zehirlemez — sıradaki iş kendi acquire'ını yapar)
   *
   * `backend.run()` SONRASI tarama YOK; çakışma tespiti ÖNCESİ
   * jenerasyon YOK; otomatik yeniden deneme YOK.
   */
  async #runJob(job: QueuedJob): Promise<void> {
    const { request } = job;
    const signal = request.options?.signal;
    try {
      // 1) Kuyruktayken iptal: backend'e ASLA inmez, kilit ALINMAZ.
      if (signal !== undefined && signal.aborted) {
        job.reject(
          new CoordinatorError("aborted", "Inference request was aborted before it started"),
        );
        return;
      }

      // 2) Süreçler arası kilit (atomik mkdir). Deneme ön-kapıya görünür
      //    (`#acquiring`): yoklama bizim yarım kilidimizi görürse sonucu
      //    bekleyebilsin.
      const attempt = startAcquire(this.#lock, request.ownerId);
      this.#acquiring = attempt;
      let acquisition: LockAcquireResult;
      try {
        acquisition = await attempt;
      } catch {
        // Kilit katmanı sözleşmesi gereği atmaz (busy/uncertain
        // döndürür); yine de koru: fail closed, backend çağrılmaz.
        job.resolve({ status: "inference_busy", conflict: "unknown" });
        return;
      } finally {
        this.#acquiring = null;
      }

      // 3) Başka bir Splash süreci inference'ı sahipleniyor (ya da
      //    kilit durumu doğrulanamıyor): süreçler ARASI beklenmez,
      //    gizli iş kuyruğa alınmaz, backend çağrılmaz — derhal dön.
      // Kilit ALINMADI: bırakılacak bir şey yok, busy doğrudan çözülür.
      if (!acquisition.acquired) {
        job.resolve({
          status: "inference_busy",
          conflict: acquisition.reason === "busy" ? "splash" : "unknown",
        });
        return;
      }

      // Bundan sonrası kilidi BİZİM — 13'teki release sonucu nihai
      // settlement'i belirler; release tamamlanana dek iş çözülmez.
      // Sahiplik ancak ŞİMDİ kanıtlı: ön-kapı yoklamayı bu andan release
      // bitene dek atlayabilir.
      this.#lockHeld = true;
      let intended: CoordinatedInferenceResult | null = null;
      let inferenceError: unknown = null;
      try {
        // 4) Runtime kimliği her dispatch'te YENİLENİR — yeniden
        //    başlamış bir runtime'ın yeni PID'si yakalanır; jenerasyonlar
        //    arası "host temizdi" sonucu ASLA önbelleklenmez.
        let info: RuntimeInfo | null = null;
        try {
          info = await this.#backend.refreshRuntimeInfo(signal);
        } catch (err) {
          // 12 → C/D: refresh, inference yolunun parçasıdır — orijinal
          // tip'li hata aynen korunur (backend sorunu ASLA
          // `inference_busy`'a çevrilmez).
          inferenceError = err;
        }

        if (info !== null) {
          // 5-6) Kullanılır bir runtime kimliği (pozitif PID) yoksa
          //      yapılandırılan ağaç dışarı çıkartılamaz → fail closed.
          if (info.runtimeProcessId === undefined) {
            intended = { status: "inference_busy", conflict: "unknown" };
          } else {
            // 7-10) Host taraması: yapılandırılmış ağaç hariç,
            //       çakışan runtime'lar sınıflandırılır.
            let scannerFailed = false;
            let conflict: ConflictKind = "none";
            try {
              conflict = await this.#detector.detect(info.runtimeProcessId);
            } catch {
              // Scanner kullanılamıyor / yorumlanamıyor: fail closed.
              scannerFailed = true;
            }
            if (scannerFailed) {
              intended = { status: "inference_busy", conflict: "unknown" };
            } else if (conflict !== "none") {
              intended = { status: "inference_busy", conflict };
            } else {
              // 11) Tek inference çağrısı. Caller seçenekleri (iptal
              //     sinyaliyle) aynen backend'e akar — timeout YOK,
              //     retry YOK.
              try {
                const result = await this.#backend.run(request.messages, request.options);
                // 12) Tamamlandı.
                intended = { status: "completed", result };
              } catch (err) {
                // 12 → C/D: orijinal tip'li hata (BackendError) korunur.
                inferenceError = err;
              }
            }
          }
        }
      } finally {
        // 13) Kilit HER YOLDA (sonuç, çakışma, hata, iptal) bırakılır —
        // token doğrulaması kilit içinde ("bir başkasının kilidini asla
        // silme" kuralı orada yaşar; burası onu asla aşmaz). Bırakma
        // hatası YUTULMAZ: yakalanır ve 14'teki TEK settlement noktasında
        // önceliğe göre yüzeye çıkar.
        let releaseFailure: unknown = null;
        try {
          await this.#lock.release(acquisition.token);
        } catch (err) {
          releaseFailure = err;
        }
        // Release denemesi bitti: sahiplik artık kanıtlanamaz (hata yolunda
        // kilit yerinde kalmış olabilir) — ön-kapı yeniden yoklar (fail
        // closed). Settlement'tan ÖNCE: caller sonucu gördüğünde temizdir.
        this.#lockHeld = false;

        // 14) TEK settlement noktası — öncelik (dosya dok.):
        if (releaseFailure === null) {
          if (inferenceError !== null) {
            // C) Orijinal tip'li hata aynen yayılır (mevcut davranış).
            job.reject(inferenceError);
          } else {
            // A) / busy yolları: niyet edilen settlement aynen.
            // (`??` savunma amaçlı fail-closed varsayılanı — yukarıdaki
            // her yol `intended`'i doldurur; burada fiilen tetiklenmez.)
            job.resolve(intended ?? { status: "inference_busy", conflict: "unknown" });
          }
        } else if (inferenceError !== null) {
          // D) Cleanup hatası yüzeyde; orijinal inference hatası
          //    YALNIZ `cause`'ta (tek red — çift hata YOK).
          job.reject(
            new CoordinatorError(
              "lock_release_failed",
              "Could not release the inference lock after a failed inference",
              { cause: inferenceError },
            ),
          );
        } else {
          // B) Inference bitti ama kilit bırakılamadı: asla sahte
          //    başarı — cleanup hatası yüzeye çıkar (`cause`'ta kilit
          //    katmanının kendi tip'li hatası — token/path taşımaz).
          // Mesaj DÜRÜSTTÜR: `intended` busy ise jenerasyon hiç
          // ÇALIŞMADI (çakışma / kimlik yok / scanner hatası) — "finished
          // inference" demek yalan olurdu; "blocked dispatch" deriz.
          // (`intended` `null` ise — fiilen tetiklenmez — yine busy
          // varsayımı: fail-closed, en az iddialı mesaj.)
          const message =
            intended?.status === "inference_busy"
              ? "Could not release the inference lock after a blocked dispatch"
              : "Could not release the inference lock after a finished inference";
          job.reject(
            new CoordinatorError("lock_release_failed", message, { cause: releaseFailure }),
          );
        }
      }
    } finally {
      // Iptal dinleyicisini sök — kuyruk/aktif dışında referans kalmasın.
      if (job.abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", job.abortHandler);
      }
    }
  }
}
