/**
 * Step 9: stale-base KARARI — saf karşılaştırıcı (spec 29-44, 171-173,
 * 265-268, 426-434).
 *
 * SORUMLULUK (spec 53/363): canlı okuma YAPMAZ — `ContextAssembler
 * .captureLiveBase` (strict no-follow yakalama; spec 45-52) canlı durumu
 * ölçer, BU fonksiyon yalnızca persisted immutable taban ile ölçülen canlı
 * durumu karşılaştırıp stale yolu listesini üretir. Git YOK (spec 265:
 * working-file baytları ölçü birimidir — `git diff`/`git status` KULLANILMAZ),
 * I/O YOK, saat YOK (mtime ASLA — spec 429/430).
 *
 * Karar kuralları:
 * - Her immutable DÜZENLENEBİLİR taban yolu için (spec 30): canlı parmak izi
 *   ≠ base parmak izi (varlık/tip/mod/içerik — `fingerprintsEqual`, spec 31)
 *   → stale. Mod sürüklenmesi (100644⇄100755, dosya⇄link, var⇄yok) stale
 *   (spec 32).
 * - Worker'ın oluşturduğu HER yol (spec 33/34): main'de bağımsız olarak VAR
 *   olması (içerik ne olursa) → stale (spec 171: varlık tek başına yeter;
 *   içerik ASLA okunmaz/karşılaştırılmaz).
 *
 * Çıktı: kanonik, dedup'lu, leksikografik sıralı stale yollar (spec 37);
 * kaynak içeriği/özet/mod detayı YOK (spec 185).
 *
 * FAIL-CLOSED SINIRI: operasyonel yakalama hatası (EACCES/EIO/swap edilmiş
 * symlink) BU fonksiyona ULAŞMAZ — `captureLiveBase` onu tip'li hata olarak
 * atar (spec 44: işletme hatası stale DEĞİLDİR; oturum korunur). Bu fonksiyon
 * yalnız güvenli tamamlanmış ölçümlerle çalışır.
 */

import type { PathFingerprint } from "../workspace/Workspace.js";
import { fingerprintsEqual } from "../workspace/fingerprint.js";
import { resolveContained } from "../workspace/pathSafety.js";
import type { LiveBaseState } from "../context/types.js";

/**
 * Karşılaştırma girdisi — tüm değerler caller tarafından hazırdır:
 * - `repoRoot`: ana repository'nin KANONİK mutlak kökü (persisted).
 * - `editablePaths`: oturumun BİTMEZ düzenlenebilir taban yolları (kanonik,
 *   repository-göreceli).
 * - `baseFingerprints`: canonical yol → base yakalama anındaki parmak izi
 *   (persisted immutable snapshot).
 * - `createdPaths`: son doğrulanmış turun worker-oluşturduğu yollar (kanonik).
 * - `live`: `captureLiveBase` çıktısı (strict canlı ölçüm — absolute anahtarlar).
 */
export interface StaleDecisionInput {
  repoRoot: string;
  editablePaths: readonly string[];
  baseFingerprints: ReadonlyMap<string, PathFingerprint>;
  createdPaths: readonly string[];
  live: LiveBaseState;
}

/**
 * Stale taban kararını üretir (saf; aynı girdi → birebir aynı çıktı).
 *
 * Dönen dizi: stale olan yolların KANONİK repository-göreceli formları,
 * dedup + leksikografik sıralı. Boş dizi = taban taze (fresh).
 */
export function decideStale(input: StaleDecisionInput): string[] {
  const stale = new Set<string>();

  // 1) Düzenlenebilir taban yolları: parmak izi karşılaştırması (spec 30-32).
  for (const canonical of input.editablePaths) {
    const base = input.baseFingerprints.get(canonical);
    if (base === undefined) {
      // Yapısal invariant (store load doğrulaması her editable yolun
      // parmak izini zorunlu tutar): ulaşılmaz — yine de fail-closed
      // davranmak yerine sessizce atlamak yerine güvenli tarafta kalınır:
      // temsil edilemeyen bir taban yolu "bilinmiyor"dur; stale DEĞİL
      // (yol güvenliği store'da fail-closed kuruldu). Savunma dalı.
      continue;
    }
    const live = input.live.baseFingerprints.get(resolveCanonical(input.repoRoot, canonical));
    if (live === undefined || !fingerprintsEqual(base, live)) {
      stale.add(canonical);
    }
  }

  // 2) Worker-oluşturulan yollar: main'de varlığı tek başına stale (spec 33/171).
  for (const canonical of input.createdPaths) {
    const exists = input.live.createdExists.get(resolveCanonical(input.repoRoot, canonical));
    if (exists === true) {
      stale.add(canonical);
    }
  }

  return [...stale].sort();
}

/**
 * Kanonik repository-göreceli yolun mutlak formu. Persisted yollar store
 * load doğrulamasından geçmiştir (`normalizeRepoPath` — `.git`/`..`/mutlak/
 * backslash/NUL red); `resolveContained` burada saf sözdizimsel derin
 * savunmadır. `null` (ulaşılmaz) — teorik imkânsızlık — çağrı tarafının
 * fail-closed hatasına düşer.
 */
function resolveCanonical(repoRoot: string, canonical: string): string {
  const abs = resolveContained(repoRoot, canonical);
  if (abs === null) {
    // Ulaşılmaz yol: güvenli tarafta — stale olarak işaretlenmez; caller
    // (SessionManager) store doğrulamasının garantilediği bu durumda
    // asla durmaz (savunma dalı; ulaşırsa hata fırlatılır).
    throw new Error("internal: persisted session path failed containment check");
  }
  return abs;
}
