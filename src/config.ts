import { homedir } from "node:os";
import path from "node:path";

/**
 * Centralized, typed Splash configuration (DESIGN.md sections 2.1, 5, 7.6).
 *
 * Step 1 scope: a flat, deterministic reader over environment variables with
 * the finalized defaults. Deliberately no config-file framework; the
 * documented `config/splash.example.json` lands with the README (build step 12).
 */

export interface BackendConfig {
  /** Base URL of the locally served, OpenAI-compatible inference API. */
  baseUrl: string;
  /** Model id served at `baseUrl`. */
  model: string;
}

export interface ContextConfig {
  /**
   * Fixed adaptive context tiers in tokens: 64K, 128K, 192K — scheduling
   * targets, not hard limits. The fourth tier ("runtime maximum") is resolved
   * from the inference backend's runtime status and is therefore never
   * configured here (DESIGN.md section 2.5: never hard-coded).
   */
  tiers: readonly number[];
  /** Minimum output headroom reserved for the worker response. */
  minOutputReserve: number;
  /** Preferred output headroom when runtime capacity permits it. */
  preferredOutputReserve: number;
  /** Soft budget for the resolved project rules pinned into the worker prompt. */
  rulesSoftBudget: number;
}

export interface SplashConfig {
  backend: BackendConfig;
  /**
   * Optional explicit project-root override. When absent, the project root is
   * auto-discovered from the MCP process CWD (implemented in a later step).
   * Resolved to an absolute path.
   */
  repoRoot?: string;
  /**
   * User-level output root for patches, sessions, and runtime state —
   * always outside any project repository. Resolved to an absolute path.
   */
  outputRoot: string;
  /** Correction-loop guardrail; at the limit the session is preserved, not destroyed. */
  maxRounds: number;
  context: ContextConfig;
}

export const CONFIG_DEFAULTS = {
  backend: {
    baseUrl: "http://127.0.0.1:8000",
    model: "incoai/Qwen3.8-27B-Splash",
  },
  outputRoot: path.join(homedir(), ".splash"),
  maxRounds: 10,
  context: {
    tiers: [65_536, 131_072, 196_608], // 64K / 128K / 192K
    minOutputReserve: 32_768,
    preferredOutputReserve: 65_536,
    rulesSoftBudget: 8_192,
  },
} as const;

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const trimmed = env[key]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const trimmed = env[key]?.trim();
  if (!trimmed) {
    return fallback;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== trimmed) {
    throw new Error(`Invalid ${key}: expected a positive integer, got "${trimmed}"`);
  }
  return value;
}

function readPositiveIntList(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: readonly number[],
): number[] {
  const trimmed = env[key]?.trim();
  if (!trimmed) {
    return [...fallback];
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid ${key}: empty entry in comma-separated list "${trimmed}"`);
  }
  return parts.map((part) => {
    const value = Number.parseInt(part, 10);
    if (!Number.isInteger(value) || value <= 0 || String(value) !== part) {
      throw new Error(`Invalid ${key}: expected a positive integer, got "${part}"`);
    }
    return value;
  });
}

function readUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = readString(env, key, fallback);
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid ${key}: "${value}" is not a valid URL`);
  }
  return value;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Loads the Splash configuration. Deterministic: a pure function of the
 * provided environment mapping (defaults to `process.env`).
 *
 * Recognized variables (all optional, all with finalized defaults):
 *   SPLASH_BACKEND_BASE_URL, SPLASH_BACKEND_MODEL, SPLASH_REPO_ROOT,
 *   SPLASH_OUTPUT_ROOT, SPLASH_MAX_ROUNDS, SPLASH_CONTEXT_TIERS,
 *   SPLASH_CONTEXT_MIN_OUTPUT_RESERVE, SPLASH_CONTEXT_PREFERRED_OUTPUT_RESERVE,
 *   SPLASH_CONTEXT_RULES_SOFT_BUDGET
 *
 * Invalid values throw; the entry point reports them and refuses to start.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SplashConfig {
  const repoRoot = readString(env, "SPLASH_REPO_ROOT", "");
  return {
    backend: {
      baseUrl: readUrl(env, "SPLASH_BACKEND_BASE_URL", CONFIG_DEFAULTS.backend.baseUrl),
      model: readString(env, "SPLASH_BACKEND_MODEL", CONFIG_DEFAULTS.backend.model),
    },
    repoRoot: repoRoot !== "" ? path.resolve(expandHome(repoRoot)) : undefined,
    outputRoot: path.resolve(
      expandHome(readString(env, "SPLASH_OUTPUT_ROOT", CONFIG_DEFAULTS.outputRoot)),
    ),
    maxRounds: readPositiveInt(env, "SPLASH_MAX_ROUNDS", CONFIG_DEFAULTS.maxRounds),
    context: {
      tiers: readPositiveIntList(env, "SPLASH_CONTEXT_TIERS", CONFIG_DEFAULTS.context.tiers),
      minOutputReserve: readPositiveInt(
        env,
        "SPLASH_CONTEXT_MIN_OUTPUT_RESERVE",
        CONFIG_DEFAULTS.context.minOutputReserve,
      ),
      preferredOutputReserve: readPositiveInt(
        env,
        "SPLASH_CONTEXT_PREFERRED_OUTPUT_RESERVE",
        CONFIG_DEFAULTS.context.preferredOutputReserve,
      ),
      rulesSoftBudget: readPositiveInt(
        env,
        "SPLASH_CONTEXT_RULES_SOFT_BUDGET",
        CONFIG_DEFAULTS.context.rulesSoftBudget,
      ),
    },
  };
}
