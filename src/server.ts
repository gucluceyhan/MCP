import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SplashConfig } from "./config.js";

/** Service name reported in MCP `initialize` and by the dev ping tool. */
export const SERVICE_NAME = "splash";
/** Service version; keep in sync with package.json. */
export const SERVICE_VERSION = "0.1.0";

/**
 * Transport-agnostic server construction (DESIGN.md sections 2.1 and 10).
 *
 * The core knows nothing about stdio or any other transport: the entry point
 * (`src/index.ts`) attaches a transport to the returned server and starts it,
 * so another transport is a leaf adapter, not a rewrite. Tool registration
 * lives here. `config` is threaded through for the tools' consumption; the
 * only thing registered in step 1 is the temporary ping tool below.
 */
export function createServer(config: SplashConfig): McpServer {
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

  return server;
}
