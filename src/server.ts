import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { SplashConfig } from "./config.js";
import { OpenAICompatBackend } from "./backend/OpenAICompatBackend.js";
import { InferenceCoordinator } from "./backend/InferenceCoordinator.js";
import type { InferenceBackend } from "./backend/InferenceBackend.js";
import { WorkerContract } from "./worker/WorkerContract.js";
import { createGitWorktreeWorkspace } from "./workspace/GitWorktreeWorkspace.js";
import type { Workspace, WorkspaceCreateInput } from "./workspace/Workspace.js";
import { ContextAssembler } from "./context/ContextAssembler.js";
import { RulesResolver } from "./rules/RulesResolver.js";
import type { RulesResolverLike } from "./rules/types.js";
import { SplashTaskService, type ContextAssemblerLike } from "./task/SplashTaskService.js";
import { serializeCloseResult, serializeCompactResult, serializeDiffResult, serializeToolError } from "./task/wire.js";

/** Service name reported in MCP `initialize`. */
export const SERVICE_NAME = "splash";
/** Service version; keep in sync with package.json. */
export const SERVICE_VERSION = "0.1.0";

/**
 * Step 6 runtime handle (spec 70): `McpServer` + `dispose()` — SDK'ın
 * `close()` üzerine monkey-patch ATMAZ; kapatım yaşam döngüsü küçük bir
 * soyutlamadır (transport kapatımı + Step 6 runtime dispose).
 */
export interface SplashRuntime {
  readonly server: McpServer;
  /**
   * Step 9/10 runtime kapatımı: yeni görev/refine/diff/close reddedilir,
   * in-flight çalışmalara güvenli terminal yollarına ulaşıncaya KADAR beklenir,
   * RAM önbellek + kilit kayıtları temizlenir; KALICI OTURUMLARA
   * DOKUNULMAZ — worktree'ler imha edilmez, session dizinleri silinmez
   * (spec 128-130: süreç kapanışı implicit close DEĞİL; hayatta kalan
   * geçerli worktree sonraki süreç tarafından reuse edilir; imha Step 10
   * `splash_close`'a aittir).
   * (Transport kapatımı bu method'da YOK — giriş noktası sırayla yapar.)
   */
  dispose(): Promise<void>;
}

/**
 * Test enjeksiyon dikişleri (spec 5) — hepsi isteğe bağlı; üretimde
 * varsayılanlar tam production zincirini kurar:
 * `OpenAICompatBackend → InferenceCoordinator → (process-wide)` ve
 * `createGitWorktreeWorkspace` (Step 5) + `WorkerContract` (Step 4).
 */
export interface SplashRuntimeOptions {
  /** MCP sürecinin CWD'si (varsayılan: `process.cwd`) — repo keşfi başlangıcı. */
  processCwd?: () => string;
  /** Injeksiyon: sahte backend (varsayılan: `OpenAICompatBackend`). */
  backend?: InferenceBackend;
  /**
   * İnjeksiyon: instrument edilmiş coordinator (varsayılan: gerçek
   * `InferenceCoordinator`). Verilirse `backend` dikişi ile BİRLİKTE
   * verilmelidir — coordinator'ın arkasındaki backend aynı object'tir.
   */
  coordinator?: InferenceCoordinator;
  /**
   * İnjeksiyon: instrument edilmiş context assembler (varsayılan: süreç-tek
   * `ContextAssembler`). Verilirse `backend` dikişi ile BİRLİKTE verilmelidir
   * — assembler'ın ölçüm yüzeyi aynı backend object'idir (süreç-tek).
   */
  contextAssembler?: ContextAssemblerLike;
  /**
   * İnjeksiyon: instrument edilmiş rules resolver (varsayılan: süreç-tek
   * `RulesResolver`). State YOKTUR (stateless) — tek instance paylaşımı
   * yalnızca süreç-tek disiplinindendir.
   */
  rulesResolver?: RulesResolverLike;
  /** İnjeksiyon: sahte/instrument edilmiş worker contract (spec 5). */
  workerContract?: WorkerContract;
  /** İnjeksiyon: sahte workspace fabrikası (varsayılan: Step 5 worktree). */
  createWorkspace?: (input: WorkspaceCreateInput) => Promise<Workspace>;
  /** İnjeksiyon: session ID fabrikası (varsayılan: `crypto.randomUUID`). */
  newSessionId?: () => string;
}

/**
 * `splash_task` MCP girdi şeması (spec 6/57) — SDK'nın desteklediği tip'li
 * yol (zod; SDK peer bağımlılığı → package.json'da açık dependency).
 *
 * - `task`: boş-olmayan string (trim ile boşluk-tek denetimi; orijinal metin
 *   worker'a aynen gider — spec 7).
 * - `files`: string dizisi — **ZORUNLU** (final sözleşme:
 *   `splash_task(task, files, options?)`): eksik `files` şema tarafında
 *   REDDEDİLİR — boş dizi icat edilmez (`default` YOK). BOŞ dizi GEÇERLİ
 *   (create-only görev) (spec 8). Her string açık repository-göreceli
 *   yoldur — glob/dizin/regex YOK.
 * - `options.reasoning_effort`: `none|low|medium|xhigh` (spec 6).
 * - `options.context_tier`: kanonik SEMBOLİK kademe (`64k`/`128k`/`192k`/
 *   `runtime_max`) — sayısal değer kabul EDİLMEZ (BLOCKER 4). VERİLMEDİSE
 *   adaptif seçim (Step 7). Runtime max'ı aşan kanonik kademe servis +
 *   assembler katmanında `invalid_input`'tur (sessizce sıkıştırılmaz).
 * - `options.output_reserve_tokens`: çıkış payı (token) — pozitif tam sayı;
 *   VERİLMEDİSE adaptif müzakere (preferred/min). Config minimumunun altı
 *   servis katmanında `invalid_input`'tur.
 * - `options.rules` (Step 8): session/hook tarafından sağlanan proje
 *   kuralları — düz string. BOŞLUK-TEK değer GEÇERLİDİR ama YOK sayılır
 *   (repository fallback'i: root CLAUDE.md/AGENTS.md); geçerli bir payload
 *   birincil kaynaktır ve repository'ya ASLA bakılmaz. VERİLMEDİSE de
 *   repository fallback'i geçerlidir. Çözülen kuralların İÇERİĞİ wire'a
 *   ASLA döndürülmez — yalnız `rules_source` provenance'ı döner.
 * - `repo_root`/`session_id`/`output_root`/`system_prompt` çağrı başına
 *   ASLA alınmaz (spec 6/9): config + süreç CWD'sinden çözülür; şemada
 *   tanımsız alanlar SDK tarafında düşer.
 */
const splashTaskInputSchema = z.object({
  task: z
    .string()
    .refine((value) => value.trim().length > 0, "The task must be a non-empty string"),
  files: z.array(z.string()),
  options: z
    .object({
      reasoning_effort: z.enum(["none", "low", "medium", "xhigh"]).optional(),
      context_tier: z.enum(["64k", "128k", "192k", "runtime_max"]).optional(),
      output_reserve_tokens: z.number().int().positive().optional(),
      rules: z.string().optional(),
    })
    .strict()
    .optional(),
});

/**
 * Transport-agnostic server kompozisyonu (DESIGN.md §2.1, 10, 11).
 *
 * SÜREÇ TEK instance'ları (spec 4):
 *   OpenAICompatBackend + InferenceCoordinator + ContextAssembler +
 *   RulesResolver (Step 8) + WorkerContract + SplashTaskService — hepsi
 *   burada, birer kez kurulur; tüm `splash_task` çağrıları AYNI
 *   coordinator + assembler + resolver'ı paylaşır (istek başına
 *   coordinator/assembler YOK).
 *
 * Konstrüksiyon tembel kalır (spec 84/85): hiçbir HTTP çağrısı (status/
 * models/completions) ve hiçbir dosya dizini oluşturmaz — bunlar yalnız
 * ilk gerçek dispatch / `splash_task` anında açılır.
 */
export function createSplashRuntime(config: SplashConfig, options: SplashRuntimeOptions = {}): SplashRuntime {
  // ── production zincir (süreç-tek) ─────────────────────────────────────────
  const backend = options.backend ?? new OpenAICompatBackend(config.backend);
  const coordinator =
    options.coordinator ??
    new InferenceCoordinator({
      backend,
      // Runtime durumu kökü (Step 3): `<outputRoot>/runtime` — yalnız ilk
      // dispatch'te dosya açılır; konstrüksiyon dosya sistemi YAPMAZ.
      runtimeDir: path.join(config.outputRoot, "runtime"),
    });
  const workerContract = options.workerContract ?? new WorkerContract();
  // SÜREÇ TEK (spec 4): assembler, coordinator ile AYNI backend instance'ını
  // paylaşır. Yalnız JENERASYON coordinator'ın FIFO'sundan (tek seri kaynak)
  // geçer; assembler'ın ölçüm trafiği (/status, /v1/models, /apply-template,
  // /tokenize) FIFO'ya GİRMEZ — her turda ölçümden ÖNCE coordinator'ın kilit
  // almayan ön-kapısı (`probe`, İz 2 / M4) meşguliyeti yoklar: kilit meşgulse
  // runtime'a HİÇ gidilmez; değilse host taraması için YALNIZ kimlik
  // yenilemesi (/status + /v1/models) yapılır — tokenize/şablon ölçümü YOK.
  // Meşgulse ölçüm yapılmadan `inference_busy` döner.
  const contextAssembler = options.contextAssembler ?? new ContextAssembler({ runtime: backend });
  // SÜREÇ TEK (Step 8): stateless resolver — tek instance tüm çağrılar için.
  // Konstrüksiyon tembel: filesystem'e hiçbir şey dokunmaz.
  const rulesResolver = options.rulesResolver ?? new RulesResolver();

  const taskService = new SplashTaskService({
    config,
    coordinator,
    contextAssembler,
    workerContract,
    rulesResolver,
    createWorkspace: options.createWorkspace ?? ((input) => createGitWorktreeWorkspace(input)),
    newSessionId: options.newSessionId,
    processCwd: options.processCwd,
  });

  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
  });

  // ── splash_task (Step 6+7 — ilk production aracı) ────────────────────────
  // El çok incedir: şema doğrulaması (yukarıda) → servis orkestrasyonu →
  // wire serileştirme. İş mantığı `SplashTaskService`'tadır, burada YOK.
  server.registerTool(
    "splash_task",
    {
      title: "Splash task",
      description:
        "Delegate a scoped coding task to the local Splash worker. The worker sees only the explicitly " +
        "listed files in an isolated workspace, returns a structured patch; Splash validates and applies " +
        "it locally. The response is compact metadata only — never generated code, diff, or source.",
      inputSchema: splashTaskInputSchema,
    },
    async (args, extra) => {
      try {
        const result = await taskService.executeTask({
          task: args.task,
          files: args.files,
          // Verilmediyse undefined → adaptif bütçe (kademe/pay müzakeresi).
          contextTier: args.options?.context_tier,
          outputReserveTokens: args.options?.output_reserve_tokens,
          // Kullanıcı vermediyse undefined → dispatch seçeneklerinde TAMAMEN YOK.
          reasoningEffort: args.options?.reasoning_effort,
          // Step 8: hook kuralları — verilmezse repository fallback'i
          // (root CLAUDE.md / AGENTS.md) devreye girer.
          rules: args.options?.rules,
          // MCP SDK istek sinyali → coordinator `options.signal` (spec 35).
          signal: extra.signal,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeCompactResult(result)),
            },
          ],
        };
      } catch (err) {
        // Tip'li, güvenli hata metadata'sı — kaynak/cause/stderr YOK (spec 58-63).
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeToolError(err)),
            },
          ],
        };
      }
    },
  );

  // ── splash_refine (Step 9 — ikinci production aracı) ──────────────────────
  // Bir AÇIK oturumu rafine eder: yalnız `session_id` + `feedback` (+ istekli
  // salt-okunur referans yollar). Oturum kendi repository kökünü, kurallarını
  // ve bütçe seçeneklerini göreve pin'lemiştir — bunlar ASLA yeniden kabul
  // edilmez (spec 20/22/248).
  //
  // Şema (spec 19-20):
  // - `session_id`: string (boş değil); manager güvenli kimliği dosya
  //   sistemine ERİŞİMDEN ÖNCE yeniden doğrular (`invalid_input`).
  // - `feedback`: boş-olmayan string (trim ile boşluk-tek denetimi).
  // - `files`: İSTEKLİ açık repository-göreceli salt-okunur referans yollar —
  //   BİRİKEN küme (cumulative); düzenlenebilir seti BÜZÜNMEZ (spec 24/26-28).
  //   Eksik → boş küme (önceki küme aynen).
  const splashRefineInputSchema = z.object({
    session_id: z.string().min(1),
    feedback: z
      .string()
      .refine((value) => value.trim().length > 0, "The feedback must be a non-empty string"),
    files: z.array(z.string()).optional(),
  });

  server.registerTool(
    "splash_refine",
    {
      title: "Splash refine",
      description:
        "Refine an open Splash session with correction feedback. The session keeps its pinned " +
        "repository, rules, and budget; only the feedback and optional read-only reference files " +
        "are accepted. The session base is re-verified before inference: if the main working tree " +
        "drifted, a compact stale_base result is returned and the session stays open.",
      inputSchema: splashRefineInputSchema,
    },
    async (args, extra) => {
      try {
        const result = await taskService.executeRefine({
          sessionId: args.session_id,
          feedback: args.feedback,
          // Verilmediyse boş küme — önceki salt-okunur küme aynen (spec 26).
          files: args.files ?? [],
          // MCP SDK istek sinyali → dispatch `options.signal` (spec 35).
          signal: extra.signal,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeCompactResult(result)),
            },
          ],
        };
      } catch (err) {
        // Tip'li, güvenli hata metadata'sı — kaynak/cause/stderr YOK (spec 12/13/58).
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeToolError(err)),
            },
          ],
        };
      }
    },
  );

  // ── splash_diff (Step 10 — içerik döndüren TEK araç, açık istekle) ──────
  // Açık oturumun immutable base → workspace katkısını İNCELEMEK için:
  // varsayılan tüm workspace unified diff'i (-U3); `files` literal yol
  // filtresi; `stat: true` yalnız istatistik. İş mantığı `SessionManager`'da
  // (kilit + lazy kurtarma; inference/kalıcılık YOK) — burada YOK.
  //
  // Şema: `session_id` zorunlu; `files`/`stat` isteğe bağlı. `.strict()`:
  // bilinmeyen alanlar sessizce DÜŞMEZ — reddedilir.
  const splashDiffInputSchema = z
    .object({
      session_id: z.string().min(1),
      files: z.array(z.string()).optional(),
      stat: z.boolean().optional(),
    })
    .strict();

  server.registerTool(
    "splash_diff",
    {
      title: "Splash diff",
      description:
        "Deliberately returns generated diff content for explicit inspection of an open Splash session. " +
        "This is the only Splash tool that returns generated code. Default: the unified diff of the " +
        "entire session workspace against its immutable base (3 context lines). `files` narrows the " +
        "diff to the listed repository-relative paths (literal paths, no globs). `stat: true` returns " +
        "statistics only (files, insertions, deletions) with no source content. Read-only: no inference, " +
        "no session state change; a drifted main working tree does not block it.",
      inputSchema: splashDiffInputSchema,
    },
    async (args) => {
      try {
        const result = await taskService.executeDiff({
          sessionId: args.session_id,
          files: args.files,
          stat: args.stat,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: serializeDiffResult(result),
            },
          ],
        };
      } catch (err) {
        // Tip'li, güvenli hata metadata'sı — kaynak/cause/stderr YOK.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeToolError(err)),
            },
          ],
        };
      }
    },
  );

  // ── splash_close (Step 10 — export + oturum kapatma) ─────────────────────
  // Yalnız `session_id`: patch yolu güvenilen `outputRoot`'tan türetilir;
  // apply/force/output_path gibi alanlar `.strict()` ile REDDEDİLİR. Splash
  // patch'i ana checkout'a ASLA uygulamaz — iş mantığı `SessionManager`'da.
  const splashCloseInputSchema = z
    .object({
      session_id: z.string().min(1),
    })
    .strict();

  server.registerTool(
    "splash_close",
    {
      title: "Splash close",
      description:
        "Export the final patch of an open Splash session and close the session. Returns compact metadata " +
        "only (absolute patch_path, files_changed, diff_stats, summary, base_status) — never code or diff " +
        "content. The patch file stays on disk outside the repository. A stale base does not block the " +
        "export, but a stale result (base_status \"stale\") must not be applied automatically by the " +
        "orchestrator. Splash never applies the patch to the repository itself.",
      inputSchema: splashCloseInputSchema,
    },
    async (args) => {
      try {
        const result = await taskService.executeClose({ sessionId: args.session_id });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeCloseResult(result)),
            },
          ],
        };
      } catch (err) {
        // Tip'li, güvenli hata metadata'sı — kaynak/cause/stderr YOK.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeToolError(err)),
            },
          ],
        };
      }
    },
  );

  return {
    server,
    dispose: () => taskService.dispose(),
  };
}
