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
import { serializeCompactResult, serializeToolError } from "./task/wire.js";

/** Service name reported in MCP `initialize` and by the dev ping tool. */
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
   * Step 6 runtime kapatımı: yeni görev reddedilir, tüm aktif worktree'ler
   * imha edilir, boşalan session dizinleri temizlenir, kayıt defteri boşalır.
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
  // paylaşır — ölçüm (assembler) ve jenerasyon (coordinator) tek seri kaynaktan.
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

  // ─────────────────────────────────────────────────────────────────────
  // TEMPORARY (development only) — NOT part of the final Splash v1
  // public API. Remove this block when the four real tools
  // (splash_task, splash_refine, splash_diff, splash_close) are introduced.
  //
  // Exists only to verify MCP/stdio connectivity end to end. It touches
  // nothing: no repository, no model call, no git, no sessions, no files,
  // no background work.
  // ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "splash_ping",
    {
      title: "Splash ping (temporary dev tool)",
      description:
        "Development-only connectivity check. Returns the service name, version, and an ok status. " +
        "Temporary: removed once the real Splash tools are introduced.",
    },
    () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            service: SERVICE_NAME,
            version: SERVICE_VERSION,
            status: "ok",
          }),
        },
      ],
    }),
  );

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

  return {
    server,
    dispose: () => taskService.dispose(),
  };
}
