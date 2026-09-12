/**
 * OmniRoute Provider Extension
 *
 * Adds OmniRoute (https://github.com/diegosouzapw/OmniRoute) as a model
 * provider: one OpenAI-compatible endpoint in front of hundreds of providers
 * and 1200+ models, with quota-aware auto-fallback and combo routing.
 *
 * Only combo models are exposed. The router's catalog is fetched live from its
 * OpenAI-compatible /v1/models endpoint at extension load and filtered to
 * combos — entries OmniRoute tags `owned_by: "combo"`, which covers both the
 * zero-config `auto/*` virtual combos and the persisted named combos (e.g.
 * `kimi-k3`, `glm-5.3`). Raw provider models are dropped. All combos are
 * auto-scoped into `enabledModels` as `omni-router/*`, so they appear in
 * /model, /modelcost and /scoped-models without manual setup (the /omniroute
 * commands still manage that scope). The provider is always "configured" (the
 * API key resolves to the real key value (env alias or auth.json), or a local
 * placeholder the router accepts). When the router is unreachable, a small
 * fallback list of `auto/*` combos keeps the provider usable.
 *
 * Usage (key resolution: OMNI_ROUTER_API_KEY / OMNI_ROUTER_API env →
 * OMNIROUTE_API_KEY env → the omni-router credential in pi's auth.json, i.e.
 * getAgentDir()/auth.json):
 *   export OMNI_ROUTER_API_KEY=sk-...   # key from OmniRoute Dashboard -> Endpoints
 *   # …or let pi store it: auth.json entry for "omni-router" ({ type: "api_key", key })
 *   export OMNI_ROUTER_BASE_URL=http://localhost:20128/v1   # optional, this is the default
 *   pi
 *   # combos are auto-scoped; /omniroute manages that scope if needed:
 *   /omniroute add auto/best-coding
 *   /omniroute add kimi-k3
 *
 * Commands (combos are auto-scoped; these manage the scope):
 *   /omniroute              # refresh the model catalog from the router + status
 *   /omniroute all          # scope ALL omni-router models (adds omni-router/* to enabledModels)
 *   /omniroute none         # remove every omni-router entry from enabledModels
 *   /omniroute scope        # list the current omni-router entries in enabledModels
 *   /omniroute add <id>     # scope a specific model, e.g. /omniroute add kimi-k3
 *   /omniroute rm <id>      # unscope a specific model
 *
 * The real key (OMNI_ROUTER_API_KEY / OMNI_ROUTER_API, OMNIROUTE_API_KEY
 * alias, or auth.json) is only needed for the /v1/models catalog fetch; chat
 * requests accept any bearer.
 */

import { getAgentDir, type ExtensionAPI, type ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Config
// =============================================================================

const BASE_URL = (
	process.env.OMNI_ROUTER_BASE_URL ?? "http://localhost:20128/v1"
).replace(/\/+$/, "");
// Real key when set, otherwise a local placeholder. A literal non-empty
// key keeps the provider "configured" in pi's model registry, so omni-router
// models always appear in /modelcost (getAvailable) and are selectable. The
// router accepts any bearer for chat; the real key is still required for the
// /v1/models catalog fetch below.
//
// Key resolution: OMNI_ROUTER_API_KEY env → OMNI_ROUTER_API env →
// OMNIROUTE_API_KEY env → the omni-router credential in pi's auth.json
// (getAgentDir()/auth.json, the git-ignored store pi itself writes, format
// { type: "api_key", key }).
function readAuthJsonKey(): string {
	try {
		const authPath = join(getAgentDir(), "auth.json");
		if (!existsSync(authPath)) return "";
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
		const cred = data?.["omni-router"];
		if (!cred) return "";
		// API-key credentials store the secret under `key`; OAuth under `access`.
		return typeof cred.key === "string" ? cred.key
			: typeof cred.access === "string" ? cred.access
			: "";
	} catch {
		return "";
	}
}
const ENV_API_KEY =
	process.env.OMNI_ROUTER_API_KEY ??
	process.env.OMNI_ROUTER_API ??
	process.env.OMNIROUTE_API_KEY ??
	readAuthJsonKey();
const API_KEY = ENV_API_KEY || "sk-omniroute-local";
const FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// Models API (OpenAI-compatible /v1/models + OmniRoute extra fields)
// =============================================================================

interface OmniRouterModel {
	id: string;
	/** OmniRoute sets this to "combo" for every combo (virtual auto/* + named). */
	owned_by?: string;
	name?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	capabilities?: {
		tool_calling?: boolean;
		reasoning?: boolean;
		thinking?: boolean;
		vision?: boolean;
	};
	pricing?: {
		input?: number;
		output?: number;
		cached?: number;
		cache_creation?: number;
	};
}

/**
 * Combos only: OmniRoute tags every combo (the zero-config `auto/*` virtual
 * combos and the persisted named combos) with `owned_by: "combo"`. The id
 * prefix is a fallback for router builds that omit the field.
 */
function isCombo(m: OmniRouterModel): boolean {
	return m.owned_by === "combo" || m.id.startsWith("auto/");
}

function mapModel(m: OmniRouterModel): ProviderModelConfig {
	const caps = m.capabilities ?? {};
	const contextWindow =
		Math.max(m.context_length ?? 0, m.max_input_tokens ?? 0) || 200_000;
	const maxTokens = m.max_output_tokens ?? Math.min(contextWindow, 16_384);
	const pricing = m.pricing ?? {};
	return {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: !!(caps.reasoning || caps.thinking),
		input: caps.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
		// OmniRoute pricing is already per-million-token USD.
		cost: {
			input: pricing.input ?? 0,
			output: pricing.output ?? 0,
			cacheRead: pricing.cached ?? 0,
			cacheWrite: pricing.cache_creation ?? 0,
		},
		contextWindow,
		maxTokens,
	};
}

async function fetchOmniRouterModels(): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: {
			...(ENV_API_KEY ? { Authorization: `Bearer ${ENV_API_KEY}` } : {}),
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`GET ${BASE_URL}/models failed: HTTP ${response.status} ${response.statusText}`,
		);
	}
	const json = (await response.json()) as { data?: OmniRouterModel[] };
	if (!json.data || !Array.isArray(json.data)) {
		throw new Error("Invalid /v1/models response: missing data array");
	}
	const combos = json.data.filter(isCombo);
	if (combos.length === 0) {
		throw new Error("OmniRoute /v1/models returned no combo models");
	}
	return combos.map(mapModel);
}

// Fallback combos used when the router is unreachable at load time. The live
// catalog replaces these on the first successful fetch (/omniroute or startup).
const FALLBACK_MODELS: ProviderModelConfig[] = [
	["auto/best-coding", "Auto (best coding)", true, false],
	["auto/best-reasoning", "Auto (best reasoning)", true, false],
	["auto/best-chat", "Auto (best chat)", true, false],
	["auto/best-fast", "Auto (fastest)", true, false],
	["auto/best-vision", "Auto (best vision)", true, true],
	["auto/coding", "Auto (coding)", true, false],
	["auto/fast", "Auto (fast)", true, false],
	["auto/chat", "Auto (chat)", true, false],
	["auto/cheap", "Auto (cheapest)", true, false],
	["auto/reasoning", "Auto (reasoning)", true, false],
	["auto/vision", "Auto (vision)", true, true],
].map(([id, name, reasoning, vision]) => ({
	id: id as string,
	name: name as string,
	reasoning: reasoning as boolean,
	input: vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 65_536,
}));

// =============================================================================
// enabledModels (scope) helpers — same settings file /modelcost writes
// =============================================================================

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		if (existsSync(SETTINGS_PATH)) {
			return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		}
	} catch { /* fall through to empty */ }
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

/** Entries in enabledModels that belong to the omni-router provider. */
function getOmniRouterScope(): string[] {
	return getEnabledModels().filter(
		(e) => e === "omni-router/*" || e.startsWith("omni-router/"),
	);
}

/** enabledModels glob that scopes every omni-router model. The provider only
 *  registers combos, so this entry scopes exactly the combo catalog. */
const COMBO_SCOPE = "omni-router/*";

/**
 * Auto-scope all combos into enabledModels. Idempotent: a no-op once
 * `omni-router/*` is present, and replaces any individual omni-router entries
 * with the single glob (superset). pi's enabledModels patterns support globs
 * (minimatch on `provider/modelId`), so one entry covers the whole catalog.
 */
function ensureComboScope(): boolean {
	try {
		const list = getEnabledModels();
		if (list.includes(COMBO_SCOPE)) return false;
		setEnabledModels([COMBO_SCOPE, ...list.filter((e) => !e.startsWith("omni-router/"))]);
		return true;
	} catch {
		// Non-fatal: never block extension load on a settings write. Scope can
		// still be managed with the /omniroute commands.
		return false;
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	let models: ProviderModelConfig[] = FALLBACK_MODELS;

	// Auto-scope every combo so they appear in /model and /scoped-models.
	// pi reads enabledModels at startup, so a fresh write lands next session.
	ensureComboScope();

	// Fetch the catalog at load time so the provider is immediately usable
	// with the router's combo catalog.
	fetchOmniRouterModels()
		.then((fetched) => {
			models = fetched;
			pi.registerProvider("omni-router", makeConfig(fetched));
			ensureComboScope();
		})
		.catch((error) => {
			console.warn(
				"[omni-router] Failed to fetch models at startup:",
				error instanceof Error ? error.message : error,
			);
		});

	pi.registerProvider("omni-router", makeConfig(models));

	// Keep the catalog fresh when a session starts (models are added/removed
	// as provider quotas change).
	pi.on("session_start", async (_event, ctx) => {
		try {
			const fetched = await fetchOmniRouterModels();
			models = fetched;
			pi.registerProvider("omni-router", makeConfig(fetched));
			ensureComboScope();
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"omni-router",
				theme.fg("accent", `🛰 ${fetched.length} combos`),
			);
		} catch {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"omni-router",
				theme.fg("error", `🛰 OmniRoute unreachable`),
			);
		}
	});

	// Refresh the catalog + manage which omni-router models are scoped
	// (enabledModels in agent/settings.json).
	pi.registerCommand("omniroute", {
		description: "Refresh OmniRoute catalog; manage scope: /omniroute [all|none|scope|add <id>|rm <id>]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["all", "none", "scope", "add ", "rm "];
			const f = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
			return (f.length ? f : subs).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const sub = (args?.trim().split(/\s+/)[0] ?? "").toLowerCase();
			const rest = (args?.trim().split(/\s+/).slice(1).join(" ") ?? "").trim();

			if (sub === "all") {
				if (ensureComboScope()) {
					ctx.ui.notify("Scoped ALL omni-router combos (omni-router/*). They now appear in /model, /modelcost, /scoped-models.", "info");
				} else {
					ctx.ui.notify("omni-router/* is already in enabledModels.", "info");
				}
				return;
			}

			if (sub === "none") {
				const list = getEnabledModels().filter((e) => !e.startsWith("omni-router/"));
				setEnabledModels(list);
				ctx.ui.notify("Removed all omni-router entries from enabledModels.", "info");
				return;
			}

			if (sub === "scope") {
				const entries = getOmniRouterScope();
				ctx.ui.notify(
					entries.length
						? `OmniRoute scope (${entries.length}): ${entries.join(", ")}`
						: "No omni-router entries in enabledModels. Use /omniroute all or /omniroute add <id>.",
					"info",
				);
				return;
			}

			if (sub === "add" || sub === "rm") {
				if (!rest) {
					ctx.ui.notify(`Usage: /omniroute ${sub} <model-id>`, "error");
					return;
				}
				const want = rest.startsWith("omni-router/") ? rest.slice("omni-router/".length) : rest;

				if (sub === "add") {
					// Resolve the id against the live catalog so a typo can be
					// caught and fuzzy matches surfaced.
					const catalog = models.length > 0
						? models
						: await fetchOmniRouterModels().catch(() => FALLBACK_MODELS);
					const exact = catalog.find((m) => m.id === want);
					if (!exact) {
						const fuzzy = catalog
							.filter((m) => m.id.toLowerCase().includes(want.toLowerCase()))
							.slice(0, 5)
							.map((m) => m.id);
						ctx.ui.notify(
							fuzzy.length
								? `No exact match "${want}". Did you mean: ${fuzzy.join(", ")}`
								: `No omni-router model matches "${want}".`,
							"warning",
						);
						return;
					}
					const list = getEnabledModels();
					const key = `omni-router/${exact.id}`;
					if (list.includes(key)) {
						ctx.ui.notify(`Already scoped: ${key}`, "info");
						return;
					}
					setEnabledModels([...list, key]);
					ctx.ui.notify(`Scoped ${key}. It now appears in /model, /modelcost, /scoped-models.`, "info");
				} else {
					const list = getEnabledModels();
					const key = `omni-router/${want}`;
					if (!list.includes(key)) {
						ctx.ui.notify(`Not in scope: ${key}`, "warning");
						return;
					}
					setEnabledModels(list.filter((e) => e !== key));
					ctx.ui.notify(`Unscoped ${key}.`, "info");
				}
				return;
			}

			// No subcommand: refresh the catalog + show status.
			try {
				const fetched = await fetchOmniRouterModels();
				models = fetched;
				pi.registerProvider("omni-router", makeConfig(fetched));
				ensureComboScope();
				const scoped = getOmniRouterScope().length;
				ctx.ui.notify(
					`OmniRoute: ${fetched.length} combos registered from ${BASE_URL} (${scoped} scope entr${scoped === 1 ? "y" : "ies"}).`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`OmniRoute unreachable at ${BASE_URL}: ${
						error instanceof Error ? error.message : error
					}`,
					"error",
				);
			}
		},
	});

	function makeConfig(modelList: ProviderModelConfig[]) {
		return {
			name: "OmniRoute",
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			api: "openai-completions" as const,
			models: modelList,
		};
	}
}