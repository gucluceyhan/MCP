# HANDOFF — Step 9 (2026-10-02)

> Bağlam sıkıştırmasına karşı sigorta. Devam eden her yeni session ÖNCE bu dosyayı
> + `~/.claude/CLAUDE.md` + `~/.config/opencode/MEMORY.md` TAM okumalı, sonra kabul
> ölçütünü kendi cümlesiyle yeniden yazmalı.

## Durum
- **Dal:** `feature/step9-session-manager` (= `origin/main` = `main` @ `e6593be`, Step 8/PR #30).
- **Başlangıç başlık:** `e6593befc7521110e6ee21f8d988cb4bd13ee13f`.
- **Step 9 commit:** `143e64a` — `Step 9: add persistent sessions and splash_refine`.
- **PR:** https://github.com/gucluceyhan/MCP/pull/31 (draft; taban `main`).
- **İş:** YALNIZ Step 9 — kalıcı SessionManager + `splash_refine` + stale-base +
  created-path çakışma + immutable yaşam döngüsü + tur geçmişi + exact küçültme +
  `max_rounds` + disk kalıcılığı + crash/restart kurtarma + eşzamanlı açık oturumlar.
  **Step 10** (`splash_diff`/`splash_close`/patch-export) ve **Step 11** (gerçek-model
  E2E) UYGULANMAYACAK.
- **Ölçülen durum (önceki session):** `npm run build` + `npm run typecheck` = exit 0;
  `npm test` = **544 PASS / 0 FAIL** (487 baseline + 23 A + 9 B + 17 C + 4 D-history + 4 E-reduction).
- **Ölçülen durum (2026-10-02, tam Step 9 ağacı):** `npm run build` + `npm run typecheck` = exit 0;
  `npm test` = **591 PASS / 0 FAIL** (22,3 sn). 12-mutasyon auditi (spec 461) sonrasında tüm
  `src/**` dosyaları mutasyon-öncesi SHA-256 baseline'ıyla birebir (33/33 OK) ve final gate
  yeniden 591/0 doğrulandı.

## Tamamlanan katmanlar
### Katman A — TOCTOU/no-follow sertleştirme (Step 8 review'den taşınan) ✅
- `src/workspace/SafeRepoReader.ts` (YENİ): `noFollowReadFile(target, openFn?)` =
  `open(O_RDONLY|O_NOFOLLOW) → handle.stat() → (düzenli değilse EISDIR) → handle.readFile()
  → finally close`. `SafeFileHandle` + `SafeOpenFn` + `errnoIs` tip/fonksiyonları.
  workspace'ta (rules↔context döngüsünü önlemek için).
- `src/workspace/fingerprint.ts`: `fingerprintsEqual(a,b)` saf yardımcı (varlık/tip/mod/
  contentSha256; mtime YOK) eklendi.
- `src/rules/types.ts` (`RulesFs`) + `src/context/types.ts` (`ContextFs`): arayüz
  **değişmedi** (lstat/readFile[/readlink]/realpath); yalnız doküman notu — production
  `readFile` = no-follow. → **Tüm Step 8 testleri aynen geçerli** (spec 297/298).
- `src/rules/RulesResolver.ts` + `src/context/ContextAssembler.ts`: `realFs.readFile =
  noFollowReadFile`. `lstat → readFile` SIRA'sı korunur (call-count + `guardSeam` geçerli);
  yarış, içerik okumasının no-follow olmasıyla kapanır.
- Yeni testler: `test/safe-repo-reader.test.ts` (9: gerçek-fs O_NOFOLLOW + scripted
  handle-close + reader yarış), `test/fingerprint.test.ts` (12: matrix), `rules-resolver`
  (194 yarış), `context-assembler` (195 yarış, `readFileFaultLayer` helper).
### Katman B — Workspace recovery API ✅
- `src/workspace/Workspace.ts`: `BaseTreeEntry` (nested, `children?`) + `BaseCommitIdentity`
  + `BaseContentValue` (file-base64/symlink-target/absent) + `WorkspaceRecoveryState`
  (schemaVersion=1, kimlik+base+tree+commit+contents+created+hash); `Workspace`'e
  `snapshotRecoveryState()`/`recoveryStateHash()`/`currentCreatedPaths()`;
  `WorkspaceApplyResult.createdPaths`.
- `src/workspace/GitWorktreeWorkspace.ts`: 3 method implementasyonu +
  `restoreGitWorktreeWorkspace(state)` (lazy: kimlik+hash → reuse / mismatch →
  destroy+recreate / missing → recreate; case (a) base-object-present `worktree add`,
  case (b) `mktree`+`commit-tree`+blob-recreate, fail-closed) + helper'lar
  (`materializeWorkspace`/`worktreeIdentityMatches`/`destroyWorktreeSafely`/
  `recreateWorktree`/`baseObjectPresent`/`recreateBaseBlobs`/`mktreeFromEntries`/
  `commitTreeRebuild`/`treeEntryType`); ctor'a optional `initialCreatedPaths`.
  - 🔑 `mktree -z` format (ölçüldü Apple Git 2.50): `mode SP type SP oid TAB path NUL`
    (meta NUL ile DEĞİL — `oid NUL path NUL` input-format-error).
  - main'den ASLA yeniden yakalama YOK; base snapshot `validationBase`/`base`'ten.
  - `restore` BİREBİR base'te döner; SessionManager (Katman D) reapply + hash kararı verir.
- Test: `test/workspace-worktree.test.ts` +9 recovery (116 CRLF / 117 symlink / 118 absent /
  119-121 reapply+hash / 124 drift / 125 no-drift / 126 reuse / 127 mismatch-recreate /
  case-b pruned-recon) + 3 fake'a (context-assembler/rules, splash-task-service) 3 method.
  → `npm test` = **519 PASS / 0 FAIL** (487+23 A + 9 B); `npm run typecheck` exit 0.
### Katman C — Session kalıcılık katmanı ✅
- `src/session/types.ts` (YENİ): `SESSION_SCHEMA_VERSION=1`; `PersistedSession`
  (schemaVersion/sessionId/repoRoot/repoId/task/rules/options/editable+readonly
  paths/workspaceRecovery/round/maxRoundsAcknowledged/rounds/latestResult?/
  latestWorkerResult?/currentCreatedPaths/latestWorkspaceStateHash?) + `PersistedRound`
  + `SessionOptions` (spec 21: reasoning_effort/context_tier/output_reserve) +
  `SessionError` (6 kind: not_found/corrupt/persistence_failed/recovery_failed/
  operation_failed/conflict — sabit güvenli mesaj) + `SessionStoreFs` dikişi
  (mkdir+recursive, chmod, readFile, openWrite, rename, removeFile, stat, openDir).
- `src/session/SessionStore.ts` (YENİ): `load` (id→dir outputRoot'tan yeniden
  hesap; session.json tek yetkili; bozuk JSON/eksik alan/geçersiz tip/bilinmeyen
  sürüm/güvensiz yol/id-uyumsuzluğu/kimlik-uyumsuzluğu/geçersiz kural provenance/
  geçersiz worker sonucu → `session_corrupt` fail-closed; ENOENT → not_found;
  TAZE savunmacı kopya döner) + `save` (session.json.tmp 0600→fsync→rename→
  dizin fsync(best-effort)→0700; hata → tmp temizle + `session_persistence_failed`)
  + `create` (özel `mkdir` — mevcut dizin EEXIST → `session_conflict`, üst yazılmaz).
  - No-log (spec 17): içerik loglanmaz; hata cause = kısa neden etiketi (içerik YOK).
  - No-Git (spec 5/113): repository kimliği saf `repoIdentity` dikişiyle (varsayılan
    `computeRepoId`); workspace kurtarma SessionManager'ın işi.
  - Gerçek adapter = `node:fs/promises`; `FileHandle.sync()` v23'te mevcut.
- Test: `test/session-store.test.ts` +19 (roundtrip+izin+bozuk gerçek-fs; temp-file/
  sürüm/id/yol/kimlik/kural/worker-tamper + yazım-hatası + çakışma + güven-siz-id
  + opsiyonel-roundtrip + save-önkoşulları + audit LOW-1 `round↔result.round`
  + LOW-2 `latestWorkspaceStateHash` 64-hex format).
   → `npm test` = **538 PASS / 0 FAIL** (katman sonu); `npm run typecheck` exit 0.
### Katman D — `history.ts` (rafine-geçmişi sınıflaması) ✅
- `src/session/history.ts` (YENİ): `buildHistory(rounds, currentFeedback) → ContextHistoryMessage[]`.
  - **Tasarım (kayıtlı) — konuşma repliği, eski→yeni:** her tamamlanış tur `i` için
    `assistant(result_i)` SONRA `user(feedback_{i+1} + validation_i)`. En SON user mesajı
    = GÜNCEL feedback + SON validation → `protected` (asla atılmaz, spec 82/101); eski
    refinement → `old_refinement`, worker sonuçları → `previous_worker` (azaltma adayı,
    spec 85-86). Her feedback/validation/sonuç TAM BİR defa (yoklama yok). Dizi sırası
    kronolojik → "oldest first" dizin konumundan yürür.
  - Boş tur → tek korumalı `user` mesajı (yalnız feedback; validation bölümü YOK).
  - Formatlar: `formatRefinement` (feedback + `edits_requested`/`edits_applied`/`rejected:
    file/edit/reason` — spec 82/102), `formatWorkerResult` (determinist JSON; kayıtlı
    `WorkerResult`'a DOKUNMAZ — spec 98). Redaksiyon ASLA burada YOK (assembler'da, spec 96-98).
- `src/context/types.ts`: `ContextHistoryMessage` + `history?: ContextHistoryMessage[]` (önceki oturumda).
- Test: `test/session-history.test.ts` +4 (tek-tur / çok-tur replik / boş-tur / kayıt-dokunmaz).
### Katman E — `ContextAssembler` sınıflı azaltma ✅
- `build(activeReserve, activeReadonly, activeHistory)`: geçmiş `kind`/`protected` taşır,
  modele yalnız rol+içerik gider (harita). Redaksiyon `assemble` başında BİR kez (7b) —
  `redactedHistory` taze kopya; kayıtlı WorkerResult'a dokunmaz.
- **Preflight** (spec 92) = `build(reserve, [], protectedHistory)` — korumalı geçmiş
  ZORUNLU; isteğe bağlı eski geçmiş + salt-okunur preflight'a girmez. Sığmazsa `needs_split`.
- **Azaltma sırası** (spec 87): `findSmallestFittingTier` null iken → (1) en eski
  korumasız refinement, (2) en eski önceki worker, (3) salt-okunur (lex son), (4) yine
  sığmaz → fail-closed. Her adımda TAM yeniden ölçü (spec 89); tek `assemble` çağrısı (spec 90).
- Uyarılar (spec 99): `HISTORY_REFINEMENT_REDUCTION_WARNING` + `HISTORY_WORKER_REDUCTION_WARNING`;
  yeni wire alanı YOK (spec 100) — `truncatedReadonlyContext` yalnız salt-okunur. Redaksiyon
  `REDACTION_WARNING`'a katılır (`historyRedacted`). Boş geçmiş → Step 8 davranışı birebir.
- Test: `test/context-assembler.test.ts` +4 (ref→worker sırası / worker-atılır / korumalı
  sığmaz→needs_split / redaksiyon). → `npm test` = **544 PASS / 0 FAIL**; typecheck exit 0.

## Sıradaki adımlar (katman zinciri)
1. **Katman A-F** [completed] — tüm Step 9 katmanları tamamlandı:
   SafeRepoReader/fingerprint, workspace recovery, SessionStore, history,
   ContextAssembler sınıflı azaltma, SessionManager + stale + RoundRunner,
   SplashTaskService devri + `splash_refine` + wire + dispose.
2. **Tam doğrulama** [completed] — `npm run build` + `npm run typecheck` +
   `npm test` = **591 PASS / 0 FAIL**. 5 zorunlu entegrasyon senaryosu +
   MCP wire/leak testleri `test/step9-integration.test.ts` içinde tamamlandı.
3. **Bağımsız audit** [completed] — `code-audit-sentinel` 24 spec-460 kontrolü:
   **BLOCK=0 / HIGH=0 / MEDIUM=0**, 6 LOW. LOW-1 (`round↔result.round`
   cross-check) + LOW-2 (`latestWorkspaceStateHash` 64-hex) PR'a alındı ve
   2 yeni fail-closed store testiyle kapatıldı. LOW-3 (tasarım kabulü),
   LOW-4 (`captureBase` ham lstat/readFile — Step 5 kapsamı), LOW-5
   (kozmetik indent), LOW-6 (kullanılmayan `session_conflict` union üyesi)
   GitHub issue adayları olarak PR dışında bırakıldı.
4. **12 mutasyon doğrulaması** [completed] — `testing-qa-architect` 12/12
   mutasyonu yakaladı; tüm `src/**` dosyaları mutasyon öncesi SHA-256
   baseline'ına byte-identical geri alındı; final gate yeniden 591/0.
   Kapanış notu: literal "non-empty rules'ı eski geçmişten önce evict et"
   varyantı mevcut kuralsız fixture'larla doğrudan gözlemlenemiyor; aynı
   invariant ailesinin soft-budget formu M11 ile 4 test tarafından yakalandı.
   Non-empty rules reduction-order testi issue adayı.
5. **DESIGN.md** [completed] — durum "Steps 1–9 implemented; rest design-only";
   Step 8 TOCTOU notu handle-based no-follow çözümüne güncellendi; Step 6/7/8
   implementation notları Step 9'un disk kalıcılığı, history ve durable rules
   pin'i ile uyumlu hale getirildi; Step 9 implementation note eklendi.
6. **Final kapanış** [nearly complete] — Step 9 commit `143e64a`
   oluşturuldu, draft PR #31 açıldı (`## Merge Sırası: Bağımsız`, taban `main`).
   Kalan: 47-bölümlü final rapor (spec 469) + PR #31'i sırası gelince
   ready'ye alma.

## Kritik tasarım kararları (kayıtlı)
- No-follow: `readFile` seam üyesi production'da no-follow; arayüz/imza değişmedi.
- Recovery: `git cat-file -e <base>^{commit}` varsa `worktree add`; object yoksa
  `mktree`+`commit-tree` (aynı SHA); blob eksik → fail-closed `session_recovery_failed`
  (kısmi rekonstrüksiyon YOK). `recoveryStateHash` = SHA-256 of
  `git diff --binary --full-index <base> --no-ext-diff --no-textconv --no-renames`.
- Disk = source of truth; RAM = cache. Invariant: 1 görev + 1 immutable taban + 1 pinned
  kural + 0..n salt-okunur + N tur. rebase/main-resync/editable-expand/silme YOK.
- `max_rounds` config'te zaten var (default 10, `SPLASH_MAX_ROUNDS`); `round >= maxRounds`
  → `status=max_rounds` (inference YOK, usage 0/0).
- SessionManager Coordinator/backend/resolver OLUŞTURMAZ — server inject eder.
- Store: `SessionStoreFs` dikişi tek I/O yüzeyi (production `node:fs/promises`; test
  sahte). Store Git BİLMEZ — repository kimliği saf `repoIdentity` (varsayılan
  `computeRepoId`, pure) dikişiyle doğrulanır. Atomik yazım: tmp 0600→fsync→rename→
  dizin-fsync(best-effort). Bozukluk = fail-closed `session_corrupt` (best-effort yok).

## Araç / referans
- Spec: `/var/folders/mj/.../T/opencode/step9_spec.txt` (3176 satır / 469 madde, 82819 B).
  ⚠️ tmp'de — her session başında varlığı doğrulanmalı; yoksa kullanıcıdan yeniden istenir.
- Proje kökü: `/Users/gucluceyhan/Documents/Yazılımlarım ve Kodlar/Splash MCP`.
- Test envanteri (satır): context-assembler 1088→(+195), rules-resolver 466→(+194),
  workspace-worktree (139KB, 1870 satır), splash-task-service 1489, splash-server 649,
  worker-result/contract, openai-compat-backend 1195, inference-coordinator 909, ...
  + YENİ: safe-repo-reader (9), fingerprint (12), session-store (19),
  session-history (4), session-stale (13), session-manager (26),
  step9-integration (6). Final toplam: **591**.
- Kalite kapısı: her katman sonra `npm test`; commit öncesi `code-audit-sentinel` +
  `testing-qa-architect` (bağımsız).

## Kapanış turu — 2026-10-03
- 3 merge-blocker kapatıldı:
  1. Recovery workspace path trusted runtime session yolundan türetildi; persisted `workspaceDir` destructive target olamaz.
  2. Persisted state deep/exact validation eklendi; unsupported nested values typed state olamaz.
  3. `SessionStore` no-follow/exclusive seam’e geçti; symlinked `session.json`/tmp/dir takip edilmez.
- Audit düzeltmeleri:
  - F-1: canonical persisted/expected workspace-dir karşılaştırması (symlinked `outputRoot` ancestor’ında sahte-pozitif red düzeltildi).
  - F-2: `repoRoot` absolute + `workspaceRecovery.repoRoot` eşitliği.
  - F-3: `lstat` errno sınıflaması (yalnız ENOENT “absent”, diğerleri fail-closed).
  - A: self-captured git tree path’leri için yapısal trusted-tree validation; backslash’lı dürüst repo adı yanlış `session_corrupt` üretmez.
  - B: `canonicalizeOutside === null` için stabil `unsafe_path` kind.
- QA:
  - N-2 racy-reset positive control load-tolerant yapıldı; sınıf-yolu güvenlik assert’leri koşulsuz korundu.
  - Final gate: `npm run build` exit 0, `npm run typecheck` exit 0, `npm test` = **618 PASS / 0 FAIL** (3 ardışık + mutation-sonrası final).
  - Bağımsız `code-audit-sentinel` re-audit = **PASS**; yeni Critical/High/Medium yok.
- 47-bölümlü final rapor: `docs/step9-final-report.md` (spec 469).
- PR dışı takip issue adayları:
  - N-1: `recreateWorktree` → `git worktree add` öncesi F-6 tarzı external-filter re-check.
  - M8: manager-seviye symlinked-ancestor `outputRoot` restore testi.
  - N-3/N-4: trusted tree path inert forms + lstat error-kind semantiği (INFO).
  - M7: `O_EXCL` TOCTOU residual (dokümantasyon, issue zorunlu değil).
- Commit mesajında AI/Co-Author imza YOK.
