#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createSplashRuntime, SERVICE_NAME, SERVICE_VERSION } from "./server.js";
import { serializeToolError } from "./task/wire.js";

/**
 * Güvenli stderr diyagistik metni (spec 71/123): bilinen tip'li hataların
 * kendi güvenli mesajları; bilinmeyen her şey sabit cümle. stdout PROTOKOL
 * içindir — diyagnostik YALNIZCA stderr'e.
 */
function safeDiagnostic(err: unknown): string {
  return serializeToolError(err).message;
}

/**
 * Executable entry point (DESIGN.md section 10):
 *   1. load config → 2. construct the Splash runtime (Step 6 composition) →
 *   3. attach stdio → 4. start.
 *
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 * stdio is a v1 transport detail and belongs here, in the entry point —
 * never in the transport-agnostic server core.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = createSplashRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  process.stderr.write(`[splash] ${SERVICE_NAME} v${SERVICE_VERSION} running on stdio\n`);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`[splash] ${reason}; shutting down\n`);
    void (async () => {
      // Sıra (spec 71): önce transport kapatılır (yeni istek kabul edilmez),
      // SONRA Step 6 runtime dispose edilir (aktif worktree'ler imha +
      // boş session dizinleri temiz). İkisi de güvenli tip'li hatalarla
      // stderr diyagnostiği üretir — kaynak/cause/log içeriği YOK.
      try {
        await runtime.server.close();
      } catch (err) {
        process.stderr.write(`[splash] shutdown: ${safeDiagnostic(err)}\n`);
      }
      try {
        await runtime.dispose();
      } catch (err) {
        process.stderr.write(`[splash] shutdown: ${safeDiagnostic(err)}\n`);
      }
      process.exit(0);
    })();
  };

  // The client (e.g. Claude Code) owns this child process's lifecycle;
  // when it goes away the pipe closes and the server must follow.
  process.stdin.on("end", () => shutdown("client disconnected (stdin closed)"));
  process.on("SIGINT", () => shutdown("SIGINT received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
}

main().catch((err: unknown) => {
  // Config hataları güvenli mesaj üretir (alan adı + neden; ham değer YOK).
  process.stderr.write(`[splash] fatal: ${safeDiagnostic(err)}\n`);
  process.exit(1);
});
