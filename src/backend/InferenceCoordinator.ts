import type {
  InferenceBackend,
  InferenceMessage,
  InferenceResult,
  InferenceRunOptions,
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
export type CoordinatorErrorKind = "aborted" | "invalid_request";

export class CoordinatorError extends Error {
  constructor(
    readonly kind: CoordinatorErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

/** Injeksiyon dikişleri — üretimde yalnızca `runtimeDir` + `backend`. */
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
  #lock: RuntimeLock;
  #detector: RuntimeConflictDetector;

  /** FIFO: aktif işin arkasında bekleyen işler (sıralı, önceliksiz). */
  #queue: QueuedJob[] = [];
  /** Şu an dispatch edilen iş — her an en fazla BİR'i var olabilir. */
  #active: QueuedJob | null = null;
  /** `activeOwnerId` alanı (dequeue'da ayarlanır, finally'de temizlenir). */
  #activeOwnerId: string | null = null;

  constructor(deps: CoordinatorDeps) {
    this.#backend = deps.backend;
    this.#lock = new RuntimeLock(deps.runtimeDir, {
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
   * Bir işin dispatch sırası (tasarım madde 19, birebir):
   *  1. kuyrukta iptal edilmiş mi? → güvenli tip'li red (kilit/alan yok)
   *  2. süreçler arası kilidi al
   *  3. kilit başka süreçte → inference_busy (splash / unknown)
   *  4. runtime bilgisini YENİLE (dispatch BAŞINDA; asla önbellek yok)
   *  5. yapılandırılan runtime'ın PID'sini al
   *  6. kullanılır kimlik yok → inference_busy/unknown (fail closed)
   *  7. host süreç tablosunu tara (scanner)
   *  8. yapılandırılan Splash ağacını (PID + tüm torunlar) çıkar
   *  9. çakışan runtime'ları sınıflandır (splash / mlx / ollama)
   * 10. çakışma var → inference_busy/<tür> (backend çağrılmaz)
   * 11. backend.run(messages, options) — options (sinyalle) aynen geçer
   * 12. sonucu çöz
   * 13. kilidi finally'de bırak
   * 14. sahiliği temizle (pump finally'si)
   * 15. FIFO devam eder
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

      // 2) Süreçler arası kilit (atomik mkdir).
      let acquisition: LockAcquireResult;
      try {
        acquisition = await this.#lock.acquire(request.ownerId);
      } catch {
        // Kilit katmanı sözleşmesi gereği atmaz (busy/uncertain
        // döndürür); yine de koru: fail closed, backend çağrılmaz.
        job.resolve({ status: "inference_busy", conflict: "unknown" });
        return;
      }

      // 3) Başka bir Splash süreci inference'ı sahipleniyor (ya da
      //    kilit durumu doğrulanamıyor): süreçler ARASI beklenmez,
      //    gizli iş kuyruğa alınmaz, backend çağrılmaz — derhal dön.
      if (!acquisition.acquired) {
        job.resolve({
          status: "inference_busy",
          conflict: acquisition.reason === "busy" ? "splash" : "unknown",
        });
        return;
      }

      try {
        // 4) Runtime kimliği her dispatch'te YENİLENİR — yeniden
        //    başlamış bir runtime'ın yeni PID'si yakalanır; jenerasyonlar
        //    arası "host temizdi" sonucu ASLA önbelleklenmez.
        const info = await this.#backend.refreshRuntimeInfo(signal);

        // 5-6) Kullanılır bir runtime kimliği (pozitif PID) yoksa
        //      yapılandırılan ağaç dışarı çıkartılamaz → fail closed.
        if (info.runtimeProcessId === undefined) {
          job.resolve({ status: "inference_busy", conflict: "unknown" });
          return;
        }

        // 7-10) Host taraması: yapılandırılmış ağaç hariç,
        //       çakışan runtime'lar sınıflandırılır.
        let conflict: ConflictKind;
        try {
          conflict = await this.#detector.detect(info.runtimeProcessId);
        } catch {
          // Scanner kullanılamıyor / yorumlanamıyor: fail closed.
          job.resolve({ status: "inference_busy", conflict: "unknown" });
          return;
        }
        if (conflict !== "none") {
          job.resolve({ status: "inference_busy", conflict });
          return;
        }

        // 11) Tek inference çağrısı. Caller seçenekleri (iptal
        //     sinyaliyle) aynen backend'e akar — timeout YOK, retry YOK.
        const result = await this.#backend.run(request.messages, request.options);

        // 12) Tamamlandı.
        job.resolve({ status: "completed", result });
      } finally {
        // 13) Kilit HER YOLDA (sonuç, çakışma, hata, iptal) bırakılır.
        // Token uyuşmazlığı = kilit artık başka bir sürece ait (biz
        // kurtarılmışız); o kilidi sahipleri ya bayat kurtarması
        // kaldırır — bizim silme hakkımız YOK. Bırakma hatası işin
        // KENDİSONUCUNU (completed ya da backend hatası) asla
        // gölgelemez; bilinçli olarak burada yutulur.
        try {
          await this.#lock.release(acquisition.token);
        } catch {
          // Bilinçli: kilit ya başka sürecin ya da bayat kurtarmasının
          // meselesidir; işin sonucu aynen taşınır.
        }
      }
    } catch (err) {
      // 4/11 adımlarındaki backend/refresh hataları: mevcut tip'li
      // `BackendError` aynen yayılır — backend sorunu ASLA
      // `inference_busy`'a çevrilmez. Kuyruğun devamı (14-15)
      // bundan etkilenmez.
      job.reject(err);
    } finally {
      // Iptal dinleyicisini sök — kuyruk/aktif dışında referans kalmasın.
      if (job.abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", job.abortHandler);
      }
    }
  }
}
