/**
 * Step 5: worker patch semantik doğrulaması (DESIGN.md 7.4, Step 5 spec 39-57).
 *
 * SAFLIK: bu modül hiçbir I/O yapmaz — immutable base verisi
 * (`WorkspaceBase`) + `WorkerResult` girer, doğrulama kararı + uygulama
 * planı çıkar. Workspace Manager (GitWorktreeWorkspace.ts) planı diske
 * yazar. Saf olması, iki fazlı yaşam döngüsünün (spec 39: doğrulama TAMAM
 * olmadan hiçbir yazma) ve test edilebilirliğin garantisidir.
 *
 * İKİ FAZ (spec 39):
 * - Faz A — düzenleme başına bağımsız denetimler: yol güvenliği, allow-list
 *   (editable/readonly/base), varlık/tip, UTF-8 round-trip, tam eşleşme
 *   (benzersizlik + örtüşme), create varlıksızlığı/önek zinciri.
 *   Bir modify düzenlemesinin HERHANGİ bir operasyonu geçmezse TÜMÜ
 *   reddedilir (yarım operasyon asla uygulanmaz).
 * - Faz B — düzenleme-ler arası (order-bağımsız) çakışmalar: kanonik alias
 *   (`src/foo.ts` ≡ `src/./foo.ts`) ve hiyerarşi (`create a` + `create a/b`)
 *   — çakışan GRUPTAKİ TÜM düzenlemeler reddedilir; sonuç worker düzenleme
 *   SIRASINA bağımlı DEĞİLDİR (spec 46/47).
 *
 * Red nedenleri (spec 41): SABİТ, deterministik sözlük — search/replace
 * metni, dosya içeriği, kaynak snippet'i ASLA nedende yer almaz. Güvenli
 * repository-göreceli yol `file`'da taşınabilir; path-güvenliğinden
 * GEÇEMEMEŞSİZ (potansiyelce keyfi metin) yollar `<invalid-path>` yer
 * tutucusu olarak taşınır (spec 42 — worker payload'ı doğrulama
 * metadata'sı üzerinden geri sızdırılamaz).
 */

import type {
  ValidationRejection,
  ValidationResult,
  WorkerEdit,
  WorkerResult,
} from "../worker/result.js";
import type { PathFingerprint } from "./Workspace.js";
import { normalizeRepoPath } from "./pathSafety.js";

/** Path-güvenliğini geçememiş worker yolunun güvenli yer tutucusu (spec 42). */
export const INVALID_PATH_PLACEHOLDER = "<invalid-path>";

/**
 * Doğrulamanın immutable base girdisi (GitWorktreeWorkspace base yakalamada
 * kurar; Step 9 stale-check `Workspace.base` üzerinden aynı verinin
 * kamuya açık karşımını görür):
 * - `editable`: kanonik düzenlenebilir yol → base parmak izi
 * - `editableContent`: kanonik düzenlenebilir yol → base'in BİREBİR baytları
 *   (yalnız düz dosyalar; arama/değiştirme bu baytlar üzerinden doğrulanır —
 *   "mutable current workspace" DEĞİL, spec 29)
 * - `readonly`: kanonik salt-okunur bağlam yolları (yazılamaz)
 * - `basePaths`: base commit'te var olan TÜM dosya/sembolik-yollar → git modu
 *   (create varlıksızlık + önek zinciri denetimi)
 */
export interface WorkspaceBase {
  editable: ReadonlyMap<string, PathFingerprint>;
  editableContent: ReadonlyMap<string, Buffer>;
  readonly: ReadonlySet<string>;
  basePaths: ReadonlyMap<string, string>;
}

/**
 * Kabul edilen bir düzenlemenin uygulama planı.
 * `content`: modify → base'ten hesaplanan SONUÇ içerik; create → yazılacak
 * içerik. `delete` → içerik yoktur.
 * Apply sırası planın kendisi değil, immutable base ARALIKLARIDIR
 * (spec 54: sıra bağımsızdır — aşağıda kanıtlanır).
 */
export interface EditPlan {
  /** `WorkerResult.edits` içindeki sıralı konum. */
  editIndex: number;
  action: "modify" | "create" | "delete";
  /** Kanonik repository-göreceli yol. */
  canonical: string;
  content?: Buffer;
}

export interface WorkspaceValidation {
  /** Step 4'ün compact tipini aynen taşır (editsRequested/editsApplied/rejected). */
  result: ValidationResult;
  /** Kabul edilen düzenlemeler (orijinal edit sırasıyla). */
  plan: EditPlan[];
}

/**
 * Reddeder neden sözlüğü (spec 41 — testler bu dizgeleri pin'ler).
 * Hepsi SABİТtir; worker verisi (search/replace/içerik/yol) taşımaz.
 * `search`/`match` nedenlerinde güvenli tek ekleme: operasyon indeksi.
 */
export const REJECTION_REASONS = {
  pathNotEditable: "path not editable",
  readOnlyPath: "read-only path",
  unsafePath: "unsafe path",
  targetMissing: "target missing",
  targetNotTextFile: "target is not a regular text file",
  targetNotFile: "target is not a file",
  createAlreadyExists: "create target already exists",
  pathConflict: "target conflicts with another edit",
  unsafeSymlink: "unsafe symlink traversal",
  overlappingEdits: "overlapping edits",
  searchNotFound: (operation: number): string => `search text not found at operation ${operation}`,
  matchNotUnique: (operation: number): string => `match not unique at operation ${operation}`,
} as const;

interface Range {
  start: number;
  end: number;
}

/**
 * Tam (exact) eşleşme sayısı — ÖRTÜŞENLER DAHİL (spec 51):
 * `"aaa"` içinde `"aa"` → 0. ve 1. konumlarda 2 eşleşme (benzersiz DEĞİL).
 * Sayım `search.length` değil, 1 karakter ilerletilir — örtüşen
 * eşleşmeler kaçmaz. Boş `search` (şema zaten reddeder) → 0.
 * Fuzzy/normalizasyon/regex/küçük-büyük harf: YOK (spec 52).
 */
export function countOccurrences(text: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }
  let count = 0;
  let position = 0;
  for (;;) {
    const index = text.indexOf(search, position);
    if (index === -1) {
      break;
    }
    count += 1;
    position = index + 1; // örtüşen eşleşmeleri say
  }
  return count;
}

/**
 * Tam bir `WorkerResult`'u immutable base'e karşı doğrular (iki fazlı).
 * Dönen `result` Step 4'ün `ValidationResult` tipidir; `plan` kabul
 * edilen düzenlemelerin (on-hesaplanmış içerikleriyle) uygulama listesidir.
 */
export function validateWorkerResult(base: WorkspaceBase, workerResult: WorkerResult): WorkspaceValidation {
  const rejected: ValidationRejection[] = [];
  const plans: EditPlan[] = [];
  const rejectedFlags = new Array<boolean>(workerResult.edits.length).fill(false);

  const reject = (index: number, canonical: string | null, reason: string): void => {
    if (rejectedFlags[index]) {
      return; // aynı düzenleme için ikinci red kaydı oluşturulmaz
    }
    rejectedFlags[index] = true;
    // Spec 42: güvenli yol → aynen; güvenSİZ yol → yer tutucu (payload sızıntısı yok).
    rejected.push({ file: canonical ?? INVALID_PATH_PLACEHOLDER, edit: index, reason });
  };

  // Implicit dizinler: `basePaths` yalnız dosya/sembolik girişleri taşır; bir dosyanın
  // tüm atal dizinleri base'te "mevcut"dur (spec 44: create bunların üstüne yazamaz).
  // Bir kez türetilir; `create` kolunda hedef bu setin üyesi ise red edilir.
  const implicitDirectorySet = new Set<string>();
  for (const entryPath of base.basePaths.keys()) {
    const slash = entryPath.lastIndexOf("/");
    if (slash === -1) {
      continue; // kök seviye dosya — dizin parçası yok
    }
    let prefix = entryPath.slice(0, slash);
    while (prefix !== "") {
      implicitDirectorySet.add(prefix);
      const up = prefix.lastIndexOf("/");
      if (up === -1) {
        break;
      }
      prefix = prefix.slice(0, up);
    }
  }

  // ── Faz A: düzenleme başına bağımsız denetimler ─────────────────────────
  workerResult.edits.forEach((edit: WorkerEdit, index: number) => {
    const canonical = normalizeRepoPath(edit.path);
    if (canonical === null) {
      reject(index, null, REJECTION_REASONS.unsafePath);
      return;
    }

    if (edit.kind === "modify") {
      if (base.readonly.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.readOnlyPath);
        return;
      }
      // Varlık önce sorulur (spec: olmayan hedef → "target missing");
      // allow-list üyeliği ancak hedef base'te VARSA "path not editable" üretir.
      if (!base.basePaths.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.targetMissing);
        return;
      }
      if (!base.editable.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.pathNotEditable);
        return;
      }
      const fingerprint = base.editable.get(canonical);
      if (fingerprint === undefined || !fingerprint.exists) {
        reject(index, canonical, REJECTION_REASONS.targetMissing);
        return;
      }
      // Sembolik bağlantı ASLA takip edilmez (spec 49): modify yalnız düz metin dosyası.
      if (fingerprint.type === "symlink") {
        reject(index, canonical, REJECTION_REASONS.targetNotTextFile);
        return;
      }
      if (fingerprint.type !== "file") {
        reject(index, canonical, REJECTION_REASONS.targetNotFile);
        return;
      }
      const bytes = base.editableContent.get(canonical);
      if (bytes === undefined) {
        reject(index, canonical, REJECTION_REASONS.targetNotTextFile);
        return;
      }
      // Spec 32: BİREBİRLİK — UTF-8 round-trip bayt-bayt eşit değilse hedef
      // desteklenmeyen (binary) metindir; ikame karakteriyle bozulmaz.
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        reject(index, canonical, REJECTION_REASONS.targetNotTextFile);
        return;
      }

      // Her operasyonun base aralığını çözümler; 0 → red, 2+ → red (spec 51).
      const ranges: Range[] = [];
      let failed = false;
      edit.operations.forEach((op, opIndex) => {
        const occurrences = countOccurrences(text, op.search);
        if (occurrences === 0) {
          reject(index, canonical, REJECTION_REASONS.searchNotFound(opIndex + 1));
          failed = true;
          return;
        }
        if (occurrences > 1) {
          reject(index, canonical, REJECTION_REASONS.matchNotUnique(opIndex + 1));
          failed = true;
          return;
        }
        const start = text.indexOf(op.search);
        ranges.push({ start, end: start + op.search.length });
      });
      if (failed) {
        return; // TÜM modify düzenlemesi reddedilir (spec 39) — hiçbir operasyon uygulanmaz
      }

      // Örtüşme (spec 53): bitişik [0,5)+[5,10) GEÇERLİ; [0,6)+[5,10) GEÇERSİZ;
      // aynı aralık = örtüşme. Tek bir örtüşme → TÜM modify düzenlemesi reddedilir.
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const current = sorted[i];
        if (prev !== undefined && current !== undefined && current.start < prev.end) {
          reject(index, canonical, REJECTION_REASONS.overlappingEdits);
          return;
        }
      }

      // Sonuç içeriği base'ten ÖN-hesaplanır (spec 54): aralıklar başlangıç
      // yönünde AZALAN sırayla, sondan başa doğru uygulanır — operasyon
      // dizisi sırasından BAĞIMSIZ deterministik çıktı (test: spec 84).
      // Her operasyon tam bir aralığa çözümlenmiştir (yukarıda garantilendi);
      // tip daraltması yalnız `noUncheckedIndexedAccess`'in `ranges[i]`
      // belirsizliğini kapatır.
      const withRanges = edit.operations
        .map((op, i) => ({ replace: op.replace, range: ranges[i] }))
        .filter((entry): entry is { replace: string; range: Range } => entry.range !== undefined)
        .sort((a, b) => b.range.start - a.range.start);
      let output = text;
      for (const { replace, range } of withRanges) {
        output = output.slice(0, range.start) + replace + output.slice(range.end);
      }
      plans.push({ editIndex: index, action: "modify", canonical, content: Buffer.from(output, "utf8") });
      return;
    }

    if (edit.kind === "delete") {
      if (base.readonly.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.readOnlyPath);
        return;
      }
      // Varlık önce sorulur (spec: olmayan hedef → "target missing").
      if (!base.basePaths.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.targetMissing);
        return;
      }
      if (!base.editable.has(canonical)) {
        reject(index, canonical, REJECTION_REASONS.pathNotEditable);
        return;
      }
      const fingerprint = base.editable.get(canonical);
      if (fingerprint === undefined || !fingerprint.exists) {
        reject(index, canonical, REJECTION_REASONS.targetMissing);
        return;
      }
      // Düz dosya VEYA sembolik bağlantı silinebilir (link'in kendisi; takip YOK, spec 56/49).
      if (fingerprint.type !== "file" && fingerprint.type !== "symlink") {
        reject(index, canonical, REJECTION_REASONS.targetNotFile);
        return;
      }
      plans.push({ editIndex: index, action: "delete", canonical });
      return;
    }

    // create
    // Base'te HERHANGİ bir şey varsa (dosya, sembolik bağlantı, ya da bir dosyanın
    // altında türeyen implicit dizin) create red — base yolu overwrite EDİLEMEZ (spec 44).
    // `basePaths` yalnız dosya/sembolik girişleri taşır; "dir/x" varsa "dir" bir
    // implicit dizindir ve create("dir") onu overwrite etmeye çalışır.
    if (base.basePaths.has(canonical) || implicitDirectorySet.has(canonical)) {
      reject(index, canonical, REJECTION_REASONS.createAlreadyExists);
      return;
    }
    // Önek zinciri: herhangi bir atal base'te var → hedef temsil edilemez.
    const segments = canonical.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join("/");
      const mode = base.basePaths.get(prefix);
      if (mode === undefined) {
        continue;
      }
      if (mode === "120000") {
        // Atal sembolik bağlantı → yazma asla bağlantı üzerinden ilerlemez (spec 48).
        reject(index, canonical, REJECTION_REASONS.unsafeSymlink);
      } else {
        // Atal bir dosya → hedef dizin yapılamaz.
        reject(index, canonical, REJECTION_REASONS.createAlreadyExists);
      }
      return;
    }
    plans.push({
      editIndex: index,
      action: "create",
      canonical,
      content: Buffer.from(edit.content, "utf8"),
    });
  });

  // ── Faz B: düzenleme-ler arası çakışmalar (order-bağımsız, spec 46/47) ──

  const isRejectedNow = (plan: EditPlan): boolean => rejectedFlags[plan.editIndex] === true;

  // B1 — kanonik alias: aynı hedefe birden çok düzenleme → gruptakilerin
  // TÜMÜ reddedilir (ilk/son tercihi SIRA bağımlısı olurdu; red deterministik).
  const byCanonical = new Map<string, EditPlan[]>();
  for (const plan of plans) {
    if (isRejectedNow(plan)) {
      continue;
    }
    const group = byCanonical.get(plan.canonical) ?? [];
    group.push(plan);
    byCanonical.set(plan.canonical, group);
  }
  for (const group of byCanonical.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const plan of group) {
      reject(plan.editIndex, plan.canonical, REJECTION_REASONS.pathConflict);
    }
  }

  // B2 — hiyerarşi: bir düzenlemenin hedefi başka bir düzenlemenin hedefinin ATALI
  // ya da torunu ise (create "a" + create "a/b", delete "a" + create "a/b", ...)
  // HAYATTA KALAN düzenleme reddedilir — yoksa sonuç uygulama SIRASINA bağımlı
  // (gizli order-dependent dönüşüm, spec 47).
  //
  // Karşılaştırma, planlara değil TÜM güvenli (normalize edilmiş) hedeflere yapılır:
  // Faz A'da red edilmiş bir düzenleme de setin hedef kümesine dahildir. Örn.
  // delete "a" + create "a/b": create, Faz A'da "a" base'te dosya olduğu için red
  // edilse bile, "a/b" hedefi delete "a" ile hiyerarşik çakışmadır — delete de red
  // edilmelidir (sıra değişince ikisinin de akıbeti değişirdi).
  const allTargets: Array<{ editIndex: number; canonical: string }> = [];
  workerResult.edits.forEach((edit, index) => {
    const target = normalizeRepoPath(edit.path);
    if (target !== null) {
      allTargets.push({ editIndex: index, canonical: target });
    }
  });
  const remaining = plans.filter((plan) => !isRejectedNow(plan));
  const isStrictAncestor = (ancestor: string, descendant: string): boolean =>
    ancestor !== descendant && descendant.startsWith(`${ancestor}/`);
  for (const plan of remaining) {
    if (isRejectedNow(plan)) {
      continue;
    }
    let conflicts = false;
    for (const target of allTargets) {
      if (target.editIndex === plan.editIndex) {
        continue; // kendi hedefiyle çakışma sayılmaz (alias B1'de ele alınır)
      }
      if (
        isStrictAncestor(plan.canonical, target.canonical) ||
        isStrictAncestor(target.canonical, plan.canonical)
      ) {
        conflicts = true;
        break;
      }
    }
    if (conflicts) {
      reject(plan.editIndex, plan.canonical, REJECTION_REASONS.pathConflict);
    }
  }

  const finalPlans = plans.filter((plan) => !isRejectedNow(plan)).sort((a, b) => a.editIndex - b.editIndex);
  rejected.sort((a, b) => a.edit - b.edit);

  return {
    result: {
      editsRequested: workerResult.edits.length,
      editsApplied: finalPlans.length,
      rejected,
    },
    plan: finalPlans,
  };
}
