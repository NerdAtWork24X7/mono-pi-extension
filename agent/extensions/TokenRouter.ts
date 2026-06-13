/**
 * Tokenrouter Provider Extension
 *
 * Provides access to 300+ AI models via the Tokenrouter API (OpenRouter-compatible).
 * Uses the TOKENROUTER_KEY environment variable for API key authentication.
 *
 * Two base URLs are used:
 *   - TOKENROUTER_API_BASE (default: https://api.tokenrouter.com/v1) — used for chat completions.
 *     Override with TOKENROUTER_URL.
 *   - MODELS_API_BASE (default: https://open.palebluedot.ai/v1) — used to fetch the model list.
 *     Override with TOKENROUTER_MODELS_URL.
 *
 * Usage:
 *   pi install git:github.com/your-org/tokenrouter-pi-provider
 *   # Then set TOKENROUTER_KEY=your_api_key
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const TOKENROUTER_API_BASE = process.env.TOKENROUTER_URL || "https://api.tokenrouter.com/v1";
const MODELS_API_BASE = process.env.TOKENROUTER_MODELS_URL || "https://open.palebluedot.ai/v1";
const MODELS_FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// Dynamic Model Loading
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

function parsePrice(price: string | null | undefined): number {
  if (!price) return 0;
  const parsed = parseFloat(price);
  if (isNaN(parsed)) return 0;
  // OpenRouter prices are per-token; Pi expects per-million-token
  return parsed * 1_000_000;
}

type TokenrouterReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

type TokenrouterModelCompat = {
  cacheControlFormat?: "anthropic";
  requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningEffortMap?: Partial<Record<TokenrouterReasoningLevel, string>>;
};

function getTokenrouterModelCompat(
  m: OpenRouterModel,
): ProviderModelConfig["compat"] | undefined {
  const compat: TokenrouterModelCompat = {};

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
    name: m.name || m.id,
    reasoning: supportsReasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.prompt),
      output: parsePrice(m.pricing?.completion),
      cacheRead: parsePrice(m.pricing?.input_cache_read),
      cacheWrite: parsePrice(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length,
    maxTokens: maxTokens,
    compat: getTokenrouterModelCompat(m),
  };
}

async function fetchTokenrouterModels(options?: {
  apiKey?: string;
}): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "pi-tokenrouter-provider",
  };
  if (options?.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const response = await fetch(`${MODELS_API_BASE}/models`, {
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
      return true;
    })
    .map(mapOpenRouterModel);
}

// =============================================================================
// Provider Config
// =============================================================================

const apiKey = process.env.TOKENROUTER_KEY || "";

const TOKENROUTER_PROVIDER_CONFIG = {
  baseUrl: TOKENROUTER_API_BASE,
  apiKey: "$TOKENROUTER_KEY",
  api: "openai-completions" as const,
  headers: {
    "User-Agent": "pi-tokenrouter-provider",
  },
};

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  let models: ProviderModelConfig[] = [];
  try {
    models = await fetchTokenrouterModels({ apiKey: apiKey || undefined });
  } catch (error) {
    console.warn(
      "[tokenrouter] Failed to fetch models at startup:",
      error instanceof Error ? error.message : error,
    );
  }

  pi.registerProvider("tokenrouter", {
    ...TOKENROUTER_PROVIDER_CONFIG,
    models,
  });
}
