/**
 * Model Provider Extension — TokenHarbor + Kilo
 *
 * One extension file that registers both dynamic model providers:
 *
 *  • TokenHarbor (https://tokenharbor.ai) — one OpenAI-compatible gateway
 *    (base URL https://tokenharbor.ai/v1) in front of many upstream vendors
 *    with transparent per-token pricing, semantic/exact caching, and a free
 *    tier on select `:free` model ids. The catalog is fetched live from the
 *    OpenAI-compatible /v1/models endpoint at extension load, disk-cached, and
 *    re-fetched on session_start and via /tokenharbor. The catalog endpoint
 *    requires the API key (anonymous requests get 401), so models register only
 *    once TOKENHARBOR_API_KEY (or an auth.json credential) is set.
 *
 *  • Kilo — 300+ AI models via the Kilo Gateway (OpenRouter-compatible), with
 *    device-code flow for browser-based authentication. Free models are
 *    registered unauthenticated; /login kilo (or KILO_API_KEY=...) upgrades to
 *    the full catalog.
 *
 * They live in one file because both are dynamic provider extensions with the
 * same shape — catalog fetch + disk cache + status-line display — sharing the
 * agent-team/model-cache helper. Subagent provider routing treats this file as
 * the provider extension for both "kilo" and "tokenharbor" (see
 * PROVIDER_EXTENSIONS in agent-team/extensions.ts).
 *
 * Usage:
 *   export TOKENHARBOR_API_KEY=thk_live_...   # from tokenharbor.ai/dashboard/api-keys
 *   # …or let pi store it: auth.json entry for "tokenharbor" ({ type: "api_key", key })
 *   /login kilo                               # device-code login for Kilo
 *   # …or set KILO_API_KEY=...
 *   pi
 *   # pick a model with /model or /modelcost (auto-scoped), refresh TokenHarbor via:
 *   /tokenharbor                              # re-fetch the catalog + show status
 */

import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCachedModels } from "./agent-team/model-cache";

// =============================================================================
// TokenHarbor — Constants
// =============================================================================

const TOKENHARBOR_BASE_URL = (
  process.env.TOKENHARBOR_BASE_URL ?? "https://tokenharbor.ai/v1"
).replace(/\/+$/, "");
const TOKENHARBOR_TOS_URL = "https://tokenharbor.ai/terms";
const FETCH_TIMEOUT_MS = 10_000;
// Versioned because the disk cache stores the *mapped* ProviderModelConfig[]
// (reasoning/cost/compat already applied), not the raw catalog: a mapping
// change must not be shadowed by a still-fresh 12h-old entry. Bump on any
// change to mapTokenHarborModel.
const TOKENHARBOR_CACHE_KEY = "tokenharbor-models-v2";

// =============================================================================
// TokenHarbor — API key resolution
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
// TokenHarbor — Models API (OpenAI-compatible /v1/models + pricing fields)
// =============================================================================

/**
 * TokenHarbor pricing is USD per million tokens, matching pi's `cost` unit.
 * The live /v1/models catalog returns `input_usd_per_1m` / `output_usd_per_1m`
 * (numbers, 0 on `:free` ids); the OpenRouter-shaped `prompt`/`completion`/
 * `input_cache_*` keys are kept as fallbacks for shape changes. Price fields
 * are nullable when the catalog omits them — pi's cost is informational here
 * (the gateway bills upstream per-token usage), so omitted prices map to 0.
 *
 * The catalog carries no capability metadata: no `supported_parameters`, no
 * `architecture`, only `label`, `tier`, `blurb`, `tool_call`, and
 * `supports_prompt_cache`. Reasoning therefore cannot be detected from it.
 */
interface TokenHarborModel {
  id: string;
  label?: string;
  name?: string;
  blurb?: string;
  tier?: string;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  max_output_tokens?: number | null;
  supports_prompt_cache?: boolean;
  tool_call?: boolean;
  function_call?: boolean;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  supported_parameters?: string[];
  pricing?: {
    input_usd_per_1m?: string | number | null;
    output_usd_per_1m?: string | number | null;
    prompt?: string | number | null;
    completion?: string | number | null;
    input_cache_read?: string | number | null;
    input_cache_write?: string | number | null;
  };
}

/** TokenHarbor prices are already USD per million tokens. */
function parseTokenHarborPrice(
  price: string | number | null | undefined,
): number {
  if (price === null || price === undefined) return 0;
  const parsed = typeof price === "number" ? price : parseFloat(price);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapTokenHarborModel(m: TokenHarborModel): ProviderModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const contextWindow = m.context_length || 200_000;
  const maxTokens =
    m.max_completion_tokens ?? m.max_output_tokens ?? Math.min(65_536, contextWindow);
  const pricing = m.pricing ?? {};

  return {
    id: m.id,
    name: m.label ?? m.name ?? m.id,
    // Every model the gateway exposes is reasoning-capable, but the catalog
    // does not say so: it omits `supported_parameters` (and `architecture`),
    // so capability probing returns nothing and pi would offer no thinking
    // levels at all. TokenHarbor's own pi adapter marks every catalog entry
    // `reasoning: true`; the gateway accepts (and translates) the resulting
    // `reasoning_effort` for each upstream. With no `thinkingLevelMap`, pi
    // exposes off/minimal/low/medium/high and sends the level verbatim.
    reasoning: true,
    // Pi would otherwise send the OpenAI `developer` role for reasoning
    // models. This gateway fronts many vendors and also speaks the Anthropic
    // Messages shape (which has no `developer` role), so the universally
    // accepted `system` role is the safe hop.
    compat: { supportsDeveloperRole: false },
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parseTokenHarborPrice(pricing.input_usd_per_1m ?? pricing.prompt),
      output: parseTokenHarborPrice(pricing.output_usd_per_1m ?? pricing.completion),
      cacheRead: parseTokenHarborPrice(pricing.input_cache_read),
      cacheWrite: parseTokenHarborPrice(pricing.input_cache_write),
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
// TokenHarbor — enabledModels (scope) helpers — same settings file /modelcost writes
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

// =============================================================================
// TokenHarbor — Provider config
// =============================================================================

function makeTokenHarborConfig(
  models: ProviderModelConfig[],
): Record<string, unknown> {
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
// TokenHarbor — Extension wiring
// =============================================================================

async function registerTokenHarborProvider(pi: ExtensionAPI): Promise<void> {
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
      models = await loadCachedModels(TOKENHARBOR_CACHE_KEY, () =>
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

  pi.registerProvider("tokenharbor", makeTokenHarborConfig(models));

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
      const fetched = await loadCachedModels(TOKENHARBOR_CACHE_KEY, () =>
        fetchTokenHarborModels(token),
      );
      models = fetched;
      pi.registerProvider("tokenharbor", makeTokenHarborConfig(fetched));
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
          TOKENHARBOR_CACHE_KEY,
          () => fetchTokenHarborModels(token),
          // Commands are explicit user actions — always hit the network so a
          // manual refresh isn't silently served from a 12h-old cache.
          { ttlMs: 0 },
        );
        models = fetched;
        pi.registerProvider("tokenharbor", makeTokenHarborConfig(fetched));
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

// =============================================================================
// Kilo — Constants
// =============================================================================

const KILO_API_BASE = process.env.KILO_API_URL || "https://api.kilo.ai";
const KILO_GATEWAY_BASE = `${KILO_API_BASE}/api/gateway`;
const KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
const POLL_INTERVAL_MS = 3000;
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const KILO_TOS_URL = "https://kilo.ai/terms";
const KILO_PROFILE_ENDPOINT = `${KILO_API_BASE}/api/profile`;

// =============================================================================
// Kilo — Balance Fetching
// =============================================================================

interface KiloBalance {
  balance?: number;
}

async function fetchKiloBalance(token: string): Promise<number | null> {
  try {
    const response = await fetch(`${KILO_PROFILE_ENDPOINT}/balance`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as KiloBalance;
    return data.balance ?? null;
  } catch {
    return null;
  }
}

function formatCredits(balance: number): string {
  if (balance >= 1000) {
    return `$${(balance / 1000).toFixed(1)}k`;
  } else {
    return `$${balance.toFixed(2)}`;
  }
}

// =============================================================================
// Kilo — Device Authorization Flow
// =============================================================================

interface DeviceAuthResponse {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  userEmail?: string;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later.",
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthResponse;
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${code}`);

  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };

  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }

  return (await response.json()) as DeviceAuthPollResponse;
}

async function loginKilo(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Initiating device authorization...");
  const authData = await initiateDeviceAuth();
  const { code, verificationUrl, expiresIn } = authData;

  callbacks.onAuth({
    url: verificationUrl,
    instructions: `Enter code: ${code}`,
  });

  callbacks.onProgress?.("Waiting for browser authorization...");

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error("Login cancelled");
    }

    await abortableSleep(POLL_INTERVAL_MS, callbacks.signal);

    const result = await pollDeviceAuth(code);

    if (result.status === "approved") {
      if (!result.token) {
        throw new Error("Authorization approved but no token received");
      }
      callbacks.onProgress?.("Login successful!");
      return {
        refresh: result.token,
        access: result.token,
        expires: Date.now() + TOKEN_EXPIRATION_MS,
      };
    }

    if (result.status === "denied") {
      throw new Error("Authorization denied by user.");
    }

    if (result.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    callbacks.onProgress?.(
      `Waiting for browser authorization... (${remaining}s remaining)`,
    );
  }

  throw new Error("Authentication timed out. Please try again.");
}

async function refreshKiloToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credentials.expires > Date.now()) {
    return credentials;
  }
  throw new Error(
    "Kilo token expired. Please run /login kilo to re-authenticate.",
  );
}

// =============================================================================
// Kilo — Dynamic Model Loading
// =============================================================================

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_write?: string | null;
    input_cache_read?: string | null;
  };
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
}

/** OpenRouter prices are per-token; pi expects per-million-token. */
function parseKiloPrice(price: string | null | undefined): number {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  return parsed * 1_000_000;
}

function isFreeModel(m: OpenRouterModel): boolean {
  const prompt = parseFloat(m.pricing?.prompt ?? "1");
  const completion = parseFloat(m.pricing?.completion ?? "1");
  if (prompt !== 0 || completion !== 0) return false;
  // Zero pricing alone isn't reliable (some models report "0" but require auth).
  // Use the :free suffix (OpenRouter convention), Kilo-native models (no vendor
  // prefix), or known Kilo/OpenRouter free routers.
  if (m.id === "kilo-auto/free") return true;
  if (m.id.includes(":free")) return true;
  if (!m.id.includes("/")) return true;
  if (m.id.startsWith("kilo/") || m.id.startsWith("openrouter/")) return true;
  return false;
}

type KiloReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

type KiloModelCompat = {
  cacheControlFormat?: "anthropic";
  requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningEffortMap?: Partial<Record<KiloReasoningLevel, string>>;
};

function getKiloModelCompat(
  m: OpenRouterModel,
): ProviderModelConfig["compat"] | undefined {
  const compat: KiloModelCompat = {};

  // Kilo's gateway is OpenRouter-compatible, but it uses api.kilo.ai so
  // pi-ai's URL/provider auto-detection cannot infer OpenRouter model quirks.
  if (m.id.startsWith("anthropic/")) {
    compat.cacheControlFormat = "anthropic";
  }

  if (m.id === "deepseek/deepseek-v4-flash" || m.id === "deepseek/deepseek-v4-pro") {
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  if (m.id === "deepseek/deepseek-v4-pro") {
    compat.reasoningEffortMap = { xhigh: "max" };
  }

  return Object.keys(compat).length > 0
    ? (compat as ProviderModelConfig["compat"])
    : undefined;
}

function mapOpenRouterModel(m: OpenRouterModel): ProviderModelConfig {
  const inputModalities = m.architecture?.input_modalities ?? ["text"];
  const supportsImages = inputModalities.includes("image");
  const supportsReasoning =
    m.supported_parameters?.includes("reasoning") ?? false;
  const maxTokens =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    Math.ceil(m.context_length * 0.2);

  return {
    id: m.id,
    name: m.name,
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parseKiloPrice(m.pricing?.prompt),
      output: parseKiloPrice(m.pricing?.completion),
      cacheRead: parseKiloPrice(m.pricing?.input_cache_read),
      cacheWrite: parseKiloPrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length,
    maxTokens: maxTokens,
    compat: getKiloModelCompat(m),
  };
}

async function fetchKiloModels(options?: {
  token?: string;
  freeOnly?: boolean;
}): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-kilo-provider",
  };
  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${KILO_GATEWAY_BASE}/models`, {
    headers,
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as { data?: OpenRouterModel[] };
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array");
  }

  return json.data
    .filter((m) => {
      // Skip image generation models
      const outputMods = m.architecture?.output_modalities ?? [];
      if (outputMods.includes("image")) return false;
      // When unauthenticated, only show free models
      if (options?.freeOnly && !isFreeModel(m)) return false;
      return true;
    })
    .map(mapOpenRouterModel);
}

// =============================================================================
// Kilo — Provider Config
// =============================================================================

const KILO_PROVIDER_CONFIG = {
  baseUrl: KILO_GATEWAY_BASE,
  apiKey: "$KILO_API_KEY",
  api: "openai-completions" as const,
  headers: {
    "X-KILOCODE-EDITORNAME": "Pi",
    "User-Agent": "pi-kilo-provider",
  },
};

// =============================================================================
// Kilo — Extension wiring
// =============================================================================

async function registerKiloProvider(pi: ExtensionAPI): Promise<void> {
  // Fetch free models at load time so the provider is immediately usable.
  // Cached to disk: the agent-team extension loads this file into every
  // spawned subagent, so a warm cache avoids a network fetch per subagent
  // boot (up to 10s timeout). The host process refreshes it here.
  let freeModels: ProviderModelConfig[] = [];
  try {
    freeModels = await loadCachedModels("kilo-free-models", () =>
      fetchKiloModels({ freeOnly: true }),
    );
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch free models at startup:",
      error instanceof Error ? error.message : error,
    );
  }

  // Full model list cached after login or session_start (when already logged in).
  // Used by modifyModels to upgrade the free list without an async fetch.
  let cachedAllModels: ProviderModelConfig[] = [];

  function makeOAuthConfig() {
    return {
      name: "Kilo",
      login: async (callbacks: OAuthLoginCallbacks) => {
        const cred = await loginKilo(callbacks);
        // Cache full models so modifyModels can use them during the
        // modelRegistry.refresh() that runs right after login returns.
        try {
          cachedAllModels = await fetchKiloModels({ token: cred.access });
        } catch (error) {
          console.warn(
            "[kilo] Failed to fetch models after login:",
            error instanceof Error ? error.message : error,
          );
        }
        return cred;
      },
      refreshToken: refreshKiloToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      // Called by modelRegistry.refresh() when credentials exist.
      // After logout, credentials are removed so this won't be called,
      // leaving only the free models from config.models.
      modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
        if (cachedAllModels.length === 0) return models;
        // Use an existing kilo model as a template for provider metadata
        const template = models.find((m) => m.provider === "kilo");
        if (!template) return models;
        const nonKilo = models.filter((m) => m.provider !== "kilo");
        const fullModels = cachedAllModels.map((m) => ({
          ...template,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          compat: m.compat,
        }));
        return [...nonKilo, ...fullModels];
      },
    };
  }

  // Always register with free models. modifyModels upgrades to full list
  // when credentials exist, and naturally falls back after logout.
  pi.registerProvider("kilo", {
    ...KILO_PROVIDER_CONFIG,
    models: freeModels,
    oauth: makeOAuthConfig(),
  });

  // After session starts, pre-fetch all models if already logged in so
  // modifyModels has data to work with. Also fetch and display credits.
  pi.on("session_start", async (_event, ctx) => {
    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");

    // Clear credits if not logged in
    if (!token) {
      ctx.ui.setStatus("kilo-credits", undefined);
      return;
    }

    try {
      cachedAllModels = await loadCachedModels("kilo-models", () =>
        fetchKiloModels({ token }),
      );
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch models at session start:",
        error instanceof Error ? error.message : error,
      );
      return;
    }
    if (cachedAllModels.length > 0) {
      // Re-register to trigger modifyModels with the cached data.
      ctx.modelRegistry.registerProvider("kilo", {
        ...KILO_PROVIDER_CONFIG,
        models: freeModels,
        oauth: makeOAuthConfig(),
      });
    }

    // Fetch and display credits balance
    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Update credits display when model changes to a Kilo model
  pi.on("model_select", async (event, ctx) => {
    if (event.model?.provider !== "kilo") return;

    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");
    if (!token) return;

    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance on model select:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Refresh credits after each turn
  pi.on("turn_end", async (_event, ctx) => {
    const token = await ctx.modelRegistry.getApiKeyForProvider("kilo");
    if (!token) return;

    try {
      const balance = await fetchKiloBalance(token);
      if (balance !== null) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus(
          "kilo-credits",
          theme.fg("accent", `💰 ${formatCredits(balance)}`),
        );
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch balance on turn end:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // On first use of a Kilo model without login, print ToS notice.
  let tosShown = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (tosShown) return;
    if (ctx.model?.provider !== "kilo") return;

    if (ctx.modelRegistry.getProviderAuthStatus("kilo")?.label === "oauth") {
      tosShown = true;
      return;
    }

    tosShown = true;

    return {
      message: {
        customType: "kilo",
        content: `By using Kilo, you agree to the Terms of Service: ${KILO_TOS_URL}`,
        display: true,
      },
    };
  });
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Both providers register in parallel so the two catalog fetches (each up to
  // 10s, disk-cached after the first boot) overlap exactly as they did when
  // they lived in separate extension files.
  await Promise.all([
    registerTokenHarborProvider(pi),
    registerKiloProvider(pi),
  ]);
}
