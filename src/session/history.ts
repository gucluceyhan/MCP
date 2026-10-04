/**
 * Step 9: rafine-geçmişinin sınıflandırılmış temsilini kurar (spec 66-88,
 * 96-101). SAFLIK: I/O yok, redaksiyon YOK (redaksiyon ContextAssembler'da —
 * spec 96-98), determinist; aynı girdi → birebir aynı mesajlar.
 *
 * Sorumluluk sınırı (spec 81): SessionManager, "güncel geri bildirim + son
 * validation + eski geri bildirimler + önceki worker yanıtları"nı BİLİR ve
 * bunları sınıflandırılmış `ContextHistoryMessage` dizisine çevirir. Token
 * ölçümü / azaltma yetkisi ContextAssembler'da kalır (spec 81/89-91).
 *
 * Sıra — konuşma repliği (eski → yeni, spec 82-86):
 *   assistant(result_i)  →  user(feedback_{i+1} + validation_i)   (i = 1..k)
 * Her geri bildirim / validation / worker sonucu TAM BİR defa görünür
 * (yoklama yok). En son `user` mesajı = GÜNCEL geri bildirim + SON validation
 * → `protected` (asla azaltılmaz, spec 82/101). Geri kalan refinement'ler
 * `old_refinement`, worker sonuçları `previous_worker` (azaltma adayları,
 * spec 85-86). Dizi sırası kronolojiktir → "oldest first" azaltma dizin
 * konumundan (en eski en önde) yürür.
 */

import type { ContextHistoryMessage } from "../context/types.js";
import type { ValidationResult, WorkerResult } from "../worker/result.js";
import type { PersistedRound } from "./types.js";

// ── Deterministik mesaj formatları ───────────────────────────────────────────

/**
 * Yapısal validation'ın worker'a gösterilecek deterministik metni
 * (spec 82/102): `file` / `edit` / `reason` — arama/yerine-koyma snippet'i
 * YOK (spec 102). Boş red → "rejected: none".
 */
function formatValidation(validation: ValidationResult, round: number): string {
  const lines: string[] = [
    `VALIDATION (round ${round})`,
    `edits_requested: ${validation.editsRequested}`,
    `edits_applied: ${validation.editsApplied}`,
  ];
  if (validation.rejected.length === 0) {
    lines.push("rejected: none");
  } else {
    lines.push("rejected:");
    for (const rejection of validation.rejected) {
      lines.push(`- file=${rejection.file} edit=${rejection.edit} reason=${rejection.reason}`);
    }
  }
  return lines.join("\n");
}

/**
 * Bir refinement (user) mesajı — bu turu TAKİP eden geri bildirim + bu
 * turun validation'ı. Boş geri bildirim → boş `REFINEMENT FEEDBACK` gövdesi
 * (1. tur gibi; validation yine taşınır — spec 101).
 */
function formatRefinement(
  followingFeedback: string | undefined,
  validation: ValidationResult,
  round: number,
): string {
  const feedbackSection = `REFINEMENT FEEDBACK\n${followingFeedback ?? ""}`;
  return `${feedbackSection}\n\n${formatValidation(validation, round)}`;
}

/**
 * Önceki worker sonucunun worker'a geri verilmesi (spec 84): deterministik
 * JSON. Ham runtime sarmalayıcı YOK; `schemaVersion` wire'dan gelir, geri
 * verilmez. Kaydedilmiş yetkili `WorkerResult` MÜDAHALE EDİLMEZ — burada
 * içerik salt değer olarak yeni bir string'e yazılır (spec 98).
 */
function formatWorkerResult(result: WorkerResult, round: number): string {
  return `WORKER RESULT (round ${round})\n${JSON.stringify({
    summary: result.summary,
    edits: result.edits,
  })}`;
}

/**
 * Tamamlanmış turlar + güncel geri bildirim → sınıflandırılmış rafine
 * geçmişi. `rounds` 1'den artan `round` numarasına sahip olmalı (spec 67);
 * `currentFeedback` = bu refine çağrısının sağladığı geri bildirim.
 */
export function buildHistory(
  rounds: readonly PersistedRound[],
  currentFeedback: string,
): ContextHistoryMessage[] {
  // Tur YOK (örn. ilk tur `needs_split` ile sonuçlandı) → eşleştirilecek
  // validation yok; yine de GÜNCEL geri bildirim worker'a ulaşmalı (spec 83).
  // Tek korumalı user mesajı (validation bölümü YOK).
  if (rounds.length === 0) {
    return [
      {
        role: "user",
        kind: "refinement",
        content: `REFINEMENT FEEDBACK\n${currentFeedback}`,
        protected: true,
      },
    ];
  }
  const messages: ContextHistoryMessage[] = [];
  const last = rounds.length - 1;
  for (let i = 0; i < rounds.length; i++) {
    const record = rounds[i];
    if (record === undefined) {
      // Döngü sınırı varlığı garanti eder; savunma (tip daraltma için).
      continue;
    }
    // assistant: worker'ın BU turda ürettiği normalize sonuç (spec 84).
    messages.push({
      role: "assistant",
      kind: "worker_response",
      content: formatWorkerResult(record.workerResult, record.round),
      protected: false,
    });
    // user: bu turu takip eden geri bildirim + bu turun validation'ı.
    // En son tur → GÜNCEL geri bildirim + protected (spec 82/101); önceki
    // turlar → bir sonraki turun kayıtlı geri bildirimi.
    const isLast = i === last;
    const followingFeedback = isLast ? currentFeedback : (rounds[i + 1]?.feedback);
    messages.push({
      role: "user",
      kind: "refinement",
      content: formatRefinement(followingFeedback, record.validation, record.round),
      protected: isLast,
    });
  }
  return messages;
}
