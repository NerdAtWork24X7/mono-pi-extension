/**
 * TokenHarbor Provider Extension
 *
 * Adds TokenHarbor (https://tokenharbor.ai) as a model provider: one
 * OpenAI-compatible gateway (base URL https://tokenharbor.ai/v1) in front of
 * many upstream vendors with transparent per-token pricing, semantic/exact
 * caching, and a free tier on select `:free` model ids.
 *
 * The model catalog (including per-million-token input/output pricing) is
 * fetched live from the OpenAI-compatible /v1/models endpoint at extension
 * load, disk-cached, and re-fetched on session_start and via /tokenharbor.
 * The catalog endpoint requires the API key (anonymous requests get 401), so
 * models register only once TOKENHARBOR_API_KEY (or an auth.json credential)
 * is set; `:free` model ids in the catalog never charge the wallet balance.
 *
 * Usage:
 *   export TOKENHARBOR_API_KEY=thk_live_...   # key from tokenharbor.ai/dashboard/api-keys
 *   # …or let pi store it: auth.json entry for "tokenharbor" ({ type: "api_key", key })
 *   pi
 *   # pick a model with /model or /modelcost (auto-scoped), refresh via:
 *   /tokenharbor              # re-fetch the catalog + show status
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCachedModels } from "./agent-team/model-cache";

// =============================================================================
// Constants
// =============================================================================

const TOKENHARBOR_BASE_URL = (
  process.env.TOKENHARBOR_BASE_URL ?? "https://tokenharbor.ai/v1"
).replace(/\/+$/, "");
const TOKENHARBOR_TOS_URL = "https://tokenharbor.ai/terms";
const FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// API key resolution
// =============================================================================

/**
 * Key resolution order: TOKENHARBOR_API_KEY env → the tokenharbor credential
 * in pi's auth.json (getAgentDir()/auth.json — the git-ignored store pi itself
 * writes, format { type: "api_key", key } or OAuth-shaped { access }).
 */
function readAuthJsonKey(): string {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (!existsSync(authPath)) return "";
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      any
    >;
    const cred = data?.["tokenharbor"];
    if (!cred) return "";
    return typeof cred.key === "string"
      ? cred.key
      : typeof cred.access === "string"
        ? cred.access
        : "";
  } catch {
    return "";
  }
}

function resolveApiKey(): string {
  return process.env.TOKENHARBOR_API_KEY || readAuthJsonKey();
}

// =============================================================================
// Models API (OpenAI-compatible /v1/models + TokenHarbor pricing fields)
// =============================================================================

/**
 * TokenHarbor pricing is USD per million tokens, matching pi's `cost` unit.
 * Price fields are nullable when the catalog omits them (e.g. some `:free`
 * variants) — pi's cost is informational here (gateway bills upstream
 * per-token usage), so omitted prices map to 0.
 */
interface TokenHarborModel {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number | null;
  max_output_tokens?: number | null;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    input_cache_read?: string | number | null;
    input_cache_write?: string | number | null;
  };
}

function parsePrice(price: string | number | null | undefined): number {
  if (price === null || price === undefined) return 0;
  const parsed = typeof price === "number" ? price : parseFloat(price);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapTokenHarborModel(m: TokenHarborModel): ProviderModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning =
    m.supported_parameters?.includes("reasoning") ?? false;
  const contextWindow = m.context_length || 200_000;
  const maxTokens =
    m.max_completion_tokens ?? m.max_output_tokens ?? Math.min(65_536, contextWindow);

  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow,
    maxTokens,
  };
}

async function fetchTokenHarborModels(
  token: string,
): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-tokenharbor-provider",
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(`${TOKENHARBOR_BASE_URL}/models`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Unauthorized (401): the TokenHarbor catalog requires a valid API key — set TOKENHARBOR_API_KEY to your thk_live_… key from tokenharbor.ai/dashboard/api-keys",
      );
    }
    throw new Error(
      `GET ${TOKENHARBOR_BASE_URL}/models failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: TokenHarborModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid /v1/models response: missing data array");
  }

  return json.data
    .filter((m) => {
      // Skip image generation models
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false;
      return true;
    })
    .map(mapTokenHarborModel);
}

// =============================================================================
// enabledModels (scope) helpers — same settings file /modelcost writes
// =============================================================================

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getEnabledModels(): string[] {
  const list = readSettings().enabledModels;
  return Array.isArray(list) ? (list as string[]) : [];
}

function setEnabledModels(list: string[]): void {
  const settings = readSettings();
  if (list.length === 0) delete settings.enabledModels;
  else settings.enabledModels = list;
  writeSettings(settings);
}

/** enabledModels glob that scopes every registered tokenharbor model. */
const PROVIDER_SCOPE = "tokenharbor/*";

/**
 * Auto-scope the whole tokenharbor catalog into enabledModels so the models
 * appear in /model, /modelcost and /scoped-models without manual setup.
 * Idempotent: a no-op once `tokenharbor/*` is present, and replaces any
 * individual tokenharbor entries with the single glob (superset). pi reads
 * enabledModels at startup, so a fresh write lands next session.
 */
function ensureProviderScope(): boolean {
  try {
    const list = getEnabledModels();
    if (list.includes(PROVIDER_SCOPE)) return false;
    setEnabledModels([
      PROVIDER_SCOPE,
      ...list.filter((e) => !e.startsWith("tokenharbor/")),
    ]);
    return true;
  } catch {
    // Non-fatal: never block extension load on a settings write. Scope can
    // still be managed via /modelcost (ctrl+s) or by editing settings.json.
    return false;
  }
}

// =============================================================================
// Provider config
// =============================================================================

function makeConfig(models: ProviderModelConfig[]): Record<string, unknown> {
  return {
    name: "Token Harbor",
    baseUrl: TOKENHARBOR_BASE_URL,
    // Resolved literal key keeps the provider "configured" in pi's model
    // registry (same approach as the omni-router extension). The catalog
    // fetch and chat requests share this key.
    apiKey: resolveApiKey() || "thk_unconfigured",
    api: "openai-completions" as const,
    models,
  };
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Register immediately with the disk-cached catalog (if present) so the
  // provider is usable before any network round-trip; the session_start hook
  // refreshes it. Cached to disk: the agent-team extension loads this file
  // into every spawned subagent, so a warm cache avoids a network fetch per
  // subagent boot. The catalog endpoint requires the API key (anonymous
  // requests get 401), so without one there is nothing to fetch — the
  // session_start hook surfaces a hint instead.
  const token = resolveApiKey();

  let models: ProviderModelConfig[] = [];
  if (token) {
    try {
      models = await loadCachedModels("tokenharbor-models", () =>
        fetchTokenHarborModels(token),
      );
    } catch (error) {
      console.warn(
        "[tokenharbor] Failed to load models at startup:",
        error instanceof Error ? error.message : error,
      );
    }
  } else {
    console.warn(
      "[tokenharbor] No API key found. Set TOKENHARBOR_API_KEY (thk_live_… from tokenharbor.ai/dashboard/api-keys) or add a tokenharbor entry to auth.json to load the model catalog.",
    );
  }

  pi.registerProvider("tokenharbor", makeConfig(models));

  // Auto-scope so the models are selectable via /model without manual setup.
  if (models.length > 0) ensureProviderScope();

  // Refresh the catalog when a session starts (models and prices change; the
  // free tier requires no key, so the refresh runs even when unconfigured).
  pi.on("session_start", async (_event, ctx) => {
    const token = resolveApiKey();
    const theme = ctx.ui.theme;

    if (!token) {
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("muted", "⚓ set TOKENHARBOR_API_KEY"),
      );
      return;
    }

    try {
      const fetched = await loadCachedModels("tokenharbor-models", () =>
        fetchTokenHarborModels(token),
      );
      models = fetched;
      pi.registerProvider("tokenharbor", makeConfig(fetched));
      ensureProviderScope();
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("accent", `⚓ ${fetched.length} models`),
      );
    } catch (error) {
      ctx.ui.setStatus(
        "tokenharbor",
        theme.fg("error", "⚓ TokenHarbor unreachable"),
      );
      console.warn(
        "[tokenharbor] Failed to refresh models at session start:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Refresh the catalog + show status on demand.
  pi.registerCommand("tokenharbor", {
    description:
      "Refresh the TokenHarbor model catalog and show provider status",
    handler: async (_args, ctx) => {
      const token = resolveApiKey();
      if (!token) {
        ctx.ui.notify(
          "No TokenHarbor API key. Set TOKENHARBOR_API_KEY (thk_live_… from tokenharbor.ai/dashboard/api-keys) or add a tokenharbor entry to auth.json.",
          "warning",
        );
        return;
      }
      try {
        const fetched = await loadCachedModels(
          "tokenharbor-models",
          () => fetchTokenHarborModels(token),
          // Commands are explicit user actions — always hit the network so a
          // manual refresh isn't silently served from a 12h-old cache.
          { ttlMs: 0 },
        );
        models = fetched;
        pi.registerProvider("tokenharbor", makeConfig(fetched));
        ensureProviderScope();
        ctx.ui.notify(
          `TokenHarbor: ${fetched.length} models registered from ${TOKENHARBOR_BASE_URL}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `TokenHarbor unreachable at ${TOKENHARBOR_BASE_URL}: ${
            error instanceof Error ? error.message : error
          }`,
          "error",
        );
      }
    },
  });

  // On first use of a TokenHarbor model without a configured key, print the
  // ToS notice (the free tier is a real upstream service).
  let tosShown = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (tosShown) return;
    if (ctx.model?.provider !== "tokenharbor") return;

    tosShown = true;

    if (resolveApiKey()) return;

    return {
      message: {
        customType: "tokenharbor",
        content: `By using TokenHarbor, you agree to the Terms of Service: ${TOKENHARBOR_TOS_URL}`,
        display: true,
      },
    };
  });
}
