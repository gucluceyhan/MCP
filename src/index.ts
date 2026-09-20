#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVICE_NAME, SERVICE_VERSION } from "./server.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Executable entry point (DESIGN.md section 10):
 *   1. load config → 2. construct the MCP server → 3. attach stdio → 4. start.
 *
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 * stdio is a v1 transport detail and belongs here, in the entry point —
 * never in the transport-agnostic server core.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[splash] ${SERVICE_NAME} v${SERVICE_VERSION} running on stdio\n`);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`[splash] ${reason}; shutting down\n`);
    void server
      .close()
      .catch((err: unknown) => {
        process.stderr.write(`[splash] error during shutdown: ${describeError(err)}\n`);
      })
      .finally(() => process.exit(0));
  };

  // The client (e.g. Claude Code) owns this child process's lifecycle;
  // when it goes away the pipe closes and the server must follow.
  process.stdin.on("end", () => shutdown("client disconnected (stdin closed)"));
  process.on("SIGINT", () => shutdown("SIGINT received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
}

main().catch((err: unknown) => {
  process.stderr.write(`[splash] fatal: ${describeError(err)}\n`);
  process.exit(1);
});
