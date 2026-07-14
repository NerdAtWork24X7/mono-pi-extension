/**
 * Context Pruner Extension
 *
 * Reduces token usage by compacting conversation history before each LLM call.
 * For completed turns, only the user's message and the final assistant summary
 * are kept; intermediate tool calls and tool results are removed.
 * The current turn is left untouched so in-flight tool execution can continue.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage, ToolResultMessage, TextContent } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";

// ── Types ──

type PrunerMessage = AgentMessage;

interface PrunerConfig {
	enabled: boolean;
	/** When true, log how many messages were stripped per LLM call. */
	debug?: boolean;
}

interface PruneStats {
	strippedToolResults: number;
	convertedToolCallAssistantMessages: number;
	preservedAssistantTextMessages: number;
}

// ── Config persistence ──

const CONFIG_FILE = "context-pruner-config.json";

function getConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE);
}

function loadConfig(cwd: string): PrunerConfig {
	const p = getConfigPath(cwd);
	if (!existsSync(p)) return { enabled: false };
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8"));
		if (typeof raw.enabled === "boolean") {
			return { enabled: raw.enabled, debug: raw.debug === true };
		}
	} catch { /* ignore parse errors */ }
	return { enabled: false };
}

function saveConfig(cwd: string, cfg: PrunerConfig) {
	try {
		const p = getConfigPath(cwd);
		// Guard against symlink attacks: refuse to write if the path is a symlink.
		if (existsSync(p) && lstatSync(p).isSymbolicLink()) return;
		writeFileSync(p, JSON.stringify(cfg, null, 2));
	} catch { /* best-effort persistence */ }
}

// ── Status update ──

function updateStatus(
	ctx: { ui: { setStatus: (id: string, text: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } },
	enabled: boolean,
): void {
	const theme = ctx.ui.theme;
	const color = enabled ? "success" : "muted";
	ctx.ui.setStatus("context-pruner", theme.fg(color, statusText(enabled)));
}

// ── Message predicates ──

function isUserMessage(msg: PrunerMessage): msg is UserMessage {
	return (msg as any).role === "user";
}

function isAssistantMessage(msg: PrunerMessage): msg is AssistantMessage {
	return (msg as any).role === "assistant";
}

function isToolResultMessage(msg: PrunerMessage): msg is ToolResultMessage {
	return (msg as any).role === "toolResult";
}

/** True if the assistant message contains at least one toolCall block. */
function hasToolCalls(msg: AssistantMessage): boolean {
	return Array.isArray(msg.content) && msg.content.some((block: any) => block && block.type === "toolCall");
}

/** Extract only the non-empty text blocks from an assistant message. */
function extractTextBlocks(msg: AssistantMessage): TextContent[] {
	if (!Array.isArray(msg.content)) return [];
	return msg.content.filter((block: any) =>
		block && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
	) as TextContent[];
}

// ── Pruning logic ──

/**
 * Compacts previous turns while preserving the current turn.
 *
 * Strategy:
 * - Locate the last user message (start of the current turn).
 * - Keep every message from that point onward unchanged.
 * - For earlier messages, keep only user messages and final assistant messages
 *   (assistant messages without tool calls). Drop tool results and assistant
 *   messages that only requested tool calls.
 *
 * Returns the compacted message list and statistics about what was removed.
 */
function pruneMessages(messages: PrunerMessage[]): { messages: PrunerMessage[]; stats: PruneStats } {
	const stats: PruneStats = {
		strippedToolResults: 0,
		convertedToolCallAssistantMessages: 0,
		preservedAssistantTextMessages: 0,
	};

	// Find the index of the last user message.
	let lastUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isUserMessage(messages[i])) {
			lastUserIndex = i;
			break;
		}
	}

	// If there is no prior user message, nothing to compact.
	if (lastUserIndex <= 0) {
		return { messages, stats };
	}

	const compacted: PrunerMessage[] = [];
	for (let i = 0; i < lastUserIndex; i++) {
		const msg = messages[i];
		if (isUserMessage(msg)) {
			compacted.push(msg);
			continue;
		}
		if (isAssistantMessage(msg)) {
			if (!hasToolCalls(msg)) {
				// Final assistant summary — keep as-is.
				compacted.push(msg);
			} else {
				// Assistant message that issued tool calls. Preserve any text it
				// contained, but drop the toolCall blocks so the removed tool
				// results don't leave dangling references.
				const textBlocks = extractTextBlocks(msg);
				if (textBlocks.length > 0) {
					compacted.push({ ...msg, content: textBlocks });
					stats.preservedAssistantTextMessages++;
				}
				stats.convertedToolCallAssistantMessages++;
			}
			continue;
		}
		// Preserve custom/extension messages (custom, bashExecution, etc.) so
		// other extensions don't lose injected context. Drop tool results from
		// previous turns.
		if (!isToolResultMessage(msg)) {
			compacted.push(msg);
		} else {
			stats.strippedToolResults++;
		}
	}

	// Append the current turn unchanged.
	for (let i = lastUserIndex; i < messages.length; i++) {
		compacted.push(messages[i]);
	}

	return { messages: compacted, stats };
}

// ── UI status indicator ──

function statusText(enabled: boolean): string {
	return enabled ? "🌿 Context pruner: ON" : "🌿 Context pruner: OFF";
}

// ── Extension entry point ──

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let config = loadConfig(cwd);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		config = loadConfig(cwd);
		updateStatus(ctx, config.enabled);
	});

	pi.on("context", (event) => {
		if (!config.enabled) return;
		if (!Array.isArray(event.messages)) return;

		const { messages: pruned, stats } = pruneMessages(event.messages);
		if (config.debug) {
			pi.appendEntry("context-pruner-log", {
				strippedToolResults: stats.strippedToolResults,
				convertedToolCallAssistantMessages: stats.convertedToolCallAssistantMessages,
				preservedAssistantTextMessages: stats.preservedAssistantTextMessages,
				before: event.messages.length,
				after: pruned.length,
			});
		}
		return { messages: pruned };
	});

	pi.registerCommand("context-pruner", {
		description: "Toggle context pruning. Usage: /context-pruner [on|off|status|debug on|debug off]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const first = parts[0] ?? "";
			const second = parts[1] ?? "";

			if (first === "off") {
				config = { ...config, enabled: false };
				saveConfig(cwd, config);
				updateStatus(ctx, config.enabled);
				ctx.ui?.notify(`Context pruner is ${config.enabled ? "enabled" : "disabled"}, debug is ${config.debug ? "on" : "off"}.`, "info");
				ctx.ui?.notify("Context pruner disabled.", "info");
			} else if (first === "on" || first === "") {
				config = { ...config, enabled: true };
				saveConfig(cwd, config);
				updateStatus(ctx, config.enabled);
			        ctx.ui?.notify(`Context pruner is ${config.enabled ? "enabled" : "disabled"}, debug is ${config.debug ? "on" : "off"}.`, "info");
				ctx.ui?.notify("Context pruner enabled.", "info");
			} else if (first === "status") {
				ctx.ui?.notify(`Context pruner is ${config.enabled ? "enabled" : "disabled"}, debug is ${config.debug ? "on" : "off"}.`, "info");
			} else if (first === "debug" && second === "on") {
				config = { ...config, debug: true };
				saveConfig(cwd, config);
				ctx.ui?.notify("Context pruner debug logging enabled.", "info");
			} else if (first === "debug" && second === "off") {
				config = { ...config, debug: false };
				saveConfig(cwd, config);
				ctx.ui?.notify("Context pruner debug logging disabled.", "info");
			} else if (first === "debug") {
				ctx.ui?.notify(`Context pruner debug is ${config.debug ? "on" : "off"}.`, "info");
			} else {
				ctx.ui?.notify("Usage: /context-pruner [on|off|status|debug on|debug off]", "warning");
			}
		},
	});
}
