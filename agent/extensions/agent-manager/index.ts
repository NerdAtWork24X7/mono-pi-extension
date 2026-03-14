/**
 * Agent Manager Extension
 *
 * Provides an interactive /agent menu for managing subagent definitions in
 * ~/.pi/agent/agents/*.md and project-level .pi/agents/*.md files.
 *
 * Usage:
 *   /agent              → opens interactive menu
 *   /agent new          → jump straight to create wizard
 *   /agent edit <name>  → jump straight to edit for <name>
 *   /agent show <name>  → jump straight to show <name>
 *   /agent delete <name>→ jump straight to delete <name>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";



// ── Types ────────────────────────────────────────────────────────────────────

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string;
	model?: string;
}

interface AgentFile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
	source: "user" | "project";
}

// ── MD frontmatter helpers ───────────────────────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: { name: "", description: "" }, body: content };
	const fm: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
	}
	return { frontmatter: fm as unknown as AgentFrontmatter, body: match[2] };
}

function serializeAgent(fm: AgentFrontmatter, body: string): string {
	const lines = ["---", `name: ${fm.name}`, `description: ${fm.description}`];
	if (fm.tools) lines.push(`tools: ${fm.tools}`);
	if (fm.model) lines.push(`model: ${fm.model}`);
	lines.push("---", "", body.trimStart());
	return lines.join("\n");
}

// ── Discovery ────────────────────────────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentFile[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentFile[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md") || (!e.isFile() && !e.isSymbolicLink())) continue;
		const filePath = path.join(dir, e.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter: fm, body } = parseFrontmatter(content);
		if (!fm.name || !fm.description) continue;
		agents.push({
			name: fm.name,
			description: fm.description,
			tools: fm.tools ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
			model: fm.model,
			systemPrompt: body,
			filePath,
			source,
		});
	}
	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch { /* keep walking */ }
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

function discoverAll(cwd: string): { agents: AgentFile[]; userDir: string; projectDir: string | null } {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);
	const byName = new Map<string, AgentFile>();
	for (const a of loadAgentsFromDir(userDir, "user")) byName.set(a.name, a);
	if (projectDir) for (const a of loadAgentsFromDir(projectDir, "project")) byName.set(a.name, a);
	return { agents: Array.from(byName.values()), userDir, projectDir };
}

// ── Settings helpers ─────────────────────────────────────────────────────────

/** Read enabledModels (and fall back to defaultModel) from settings.json. */
function getEnabledModels(): string[] {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const json = JSON.parse(raw) as { enabledModels?: string[]; defaultModel?: string };
		const models: string[] = [];
		if (Array.isArray(json.enabledModels)) models.push(...json.enabledModels);
		if (json.defaultModel && !models.includes(json.defaultModel)) models.unshift(json.defaultModel);
		return models;
	} catch {
		return [];
	}
}

const TOOL_PRESETS: Record<string, string | undefined> = {
	"(default - all tools)": undefined,
	"read-only  — read, grep, find, ls": "read, grep, find, ls",
	"read+bash  — read, grep, find, ls, bash": "read, grep, find, ls, bash",
	"full       — read, bash, grep, find, ls, write, edit": "read, bash, grep, find, ls, write, edit",
};

// ── Extension entry point ────────────────────────────────────────────────────

export default function agentManagerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("agent", {
		description: "Open the agent manager menu (create, view, edit, delete agents)",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const rest = parts.slice(1).join(" ").trim();

			// Direct-jump shortcuts for power users
			switch (sub) {
				case "new": return menuNew(pi, ctx);
				case "monitor":
				case "ps": return showMonitor(ctx);
				case "show": return menuShow(rest || await pickAgent("Show agent:", discoverAll(ctx.cwd).agents, ctx), pi, ctx);
				case "edit": return menuEdit(rest || await pickAgent("Edit agent:", discoverAll(ctx.cwd).agents, ctx), pi, ctx);
				case "delete":
				case "rm": return menuDelete(rest || await pickAgent("Delete agent:", discoverAll(ctx.cwd).agents, ctx), pi, ctx);
			}

			// Main interactive menu
			await mainMenu(pi, ctx);
		},
	});

}


// ── Main menu ────────────────────────────────────────────────────────────────

async function mainMenu(pi: ExtensionAPI, ctx: any): Promise<void> {
	const { agents, userDir, projectDir } = discoverAll(ctx.cwd);

	// Build menu items
	const agentSection = agents.length > 0
		? agents.map((a) => {
			const src = a.source === "project" ? "proj" : "user";
			const mdl = a.model ? `  [${a.model}]` : "";
			const tls = a.tools ? `  (${a.tools.join(", ")})` : "";
			return `${a.name}`;
		})
		: ["(no agents found)"];

	const choices = [
		"────────── Actions ───────────",
		"✦  Create new agent",
		"🔍 Monitor running subagents",
		"──────────────────────────────",
		...agentSection,
	];

	const choice = await ctx.ui.select(
		`Agent Manager  (${agents.length} agent${agents.length !== 1 ? "s" : ""} • user: ${userDir})`,
		choices,
	);

	if (!choice) return; // Esc / dismissed

	if (choice === "✦  Create new agent") {
		return menuNew(pi, ctx);
	}

	if (choice === "🔍 Monitor running subagents") {
		return showMonitor(ctx);
	}

	if (choice.startsWith("──") || choice === "(no agents found)") {
		return; // separator or empty state — ignore
	}

	// Chose an existing agent row → extract name (first token)
	const agentName = choice.split(/\s/)[0];
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return;

	await agentActionsMenu(agent, pi, ctx);
}

// ── Per-agent actions menu ───────────────────────────────────────────────────

async function agentActionsMenu(agent: AgentFile, pi: ExtensionAPI, ctx: any): Promise<void> {
	const src = agent.source === "project" ? "project (.pi/agents)" : "user (~/.pi/agent/agents)";
	const toolStr = agent.tools ? agent.tools.join(", ") : "(default)";
	const modeStr = agent.model ?? "(default)";

	const choice = await ctx.ui.select(
		`${agent.name}  —  ${agent.description}\n  tools: ${toolStr}   model: ${modeStr}   [${src}]`,
		[
			"👁  Show full definition",
			"✏  Edit system prompt",
			"✏  Edit description",
			"✏  Edit model",
			"✏  Edit tools",
			"🗑  Delete agent",
			"← Back",
		],
	);

	if (!choice || choice === "← Back") return;

	switch (choice) {
		case "👁  Show full definition": return menuShow(agent.name, pi, ctx);
		case "✏  Edit system prompt": return menuEditField(agent, "system prompt", pi, ctx);
		case "✏  Edit description": return menuEditField(agent, "description", pi, ctx);
		case "✏  Edit model": return menuEditField(agent, "model", pi, ctx);
		case "✏  Edit tools": return menuEditField(agent, "tools", pi, ctx);
		case "🗑  Delete agent": return menuDelete(agent.name, pi, ctx);
	}
}

// ── Helpers for direct jumps ─────────────────────────────────────────────────

async function pickAgent(prompt: string, agents: AgentFile[], ctx: any): Promise<string> {
	if (agents.length === 0) {
		ctx.ui.notify("No agents found. Create one with /agent new", "info");
		return "";
	}
	const choice = await ctx.ui.select(prompt, agents.map((a) => `${a.name}  —  ${a.description}`));
	return choice?.split(/\s/)[0] ?? "";
}

// ── Show ─────────────────────────────────────────────────────────────────────

async function menuShow(name: string, _pi: ExtensionAPI, ctx: any): Promise<void> {
	if (!name) return;
	const { agents } = discoverAll(ctx.cwd);
	const agent = agents.find((a) => a.name === name);
	if (!agent) { ctx.ui.notify(`Agent "${name}" not found.`, "error"); return; }

	const toolList = agent.tools ? agent.tools.join(", ") : "(default all)";
	ctx.ui.notify(
		[
			`Agent: ${agent.name}  [${agent.source}]`,
			`File:  ${agent.filePath}`,
			`Desc:  ${agent.description}`,
			`Tools: ${toolList}`,
			`Model: ${agent.model ?? "(default)"}`,
			``,
			`System Prompt:`,
			`─────────────────────────────────────`,
			agent.systemPrompt.trim(),
		].join("\n"),
		"info",
	);
}

// ── Create wizard ────────────────────────────────────────────────────────────

async function menuNew(pi: ExtensionAPI, ctx: any): Promise<void> {
	const { userDir } = discoverAll(ctx.cwd);

	// Step 1 — name
	const nameRaw = await ctx.ui.editor("Agent name (e.g. my-agent):", "");
	if (!nameRaw?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }
	const safeName = nameRaw.trim().replace(/[^\w-]/g, "-").toLowerCase();

	// Step 2 — description
	const description = await ctx.ui.editor("Short description (one line):", "");
	if (!description?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }

	// Step 3 — model
	const enabledModels = getEnabledModels();
	if (enabledModels.length === 0) {
		ctx.ui.notify("No models found in settings.json → enabledModels. Add models there first.", "error");
		return;
	}
	const modelChoice = await ctx.ui.select("Model:", ["(default)", ...enabledModels]);
	if (modelChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
	const model = modelChoice === "(default)" ? undefined : modelChoice;

	// Step 4 — tools
	const toolPresetKeys = Object.keys(TOOL_PRESETS);
	const toolChoice = await ctx.ui.select("Tool set:", [...toolPresetKeys, "custom…"]);
	if (toolChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }

	let tools: string | undefined;
	if (toolChoice === "custom…") {
		const custom = await ctx.ui.editor("Enter tool list (comma-separated):", "read, grep, find, ls");
		if (custom === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
		tools = custom.trim() || undefined;
	} else {
		tools = TOOL_PRESETS[toolChoice];
	}

	// Step 5 — system prompt
	const defaultPrompt =
		`You are a ${safeName} agent. Describe your role and behavior here.\n\n## Responsibilities\n- ...\n\n## Output format\n- ...\n`;
	const systemPrompt = await ctx.ui.editor("System prompt:", defaultPrompt);
	if (systemPrompt === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }

	// Step 6 — scope
	const scopeChoice = await ctx.ui.select("Save to:", [
		`User  — ~/.pi/agent/agents  (always available)`,
		`Project  — .pi/agents  (repo-local)`,
	]);
	if (scopeChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }

	let targetDir: string;
	if (scopeChoice.startsWith("User")) {
		targetDir = userDir;
	} else {
		targetDir = findProjectAgentsDir(ctx.cwd) ?? path.join(ctx.cwd, ".pi", "agents");
	}

	fs.mkdirSync(targetDir, { recursive: true });
	const filePath = path.join(targetDir, `${safeName}.md`);

	if (fs.existsSync(filePath)) {
		const ok = await ctx.ui.confirm("Overwrite?", `Agent "${safeName}" already exists at:\n${filePath}`);
		if (!ok) { ctx.ui.notify("Cancelled.", "info"); return; }
	}

	const fm: AgentFrontmatter = { name: safeName, description: description.trim(), tools, model };
	fs.writeFileSync(filePath, serializeAgent(fm, systemPrompt), "utf-8");
	ctx.ui.notify(`✓ Agent "${safeName}" created at:\n${filePath}`, "info");
}

// ── Edit (field dispatcher) ──────────────────────────────────────────────────

async function menuEdit(name: string, pi: ExtensionAPI, ctx: any): Promise<void> {
	if (!name) return;
	const { agents } = discoverAll(ctx.cwd);
	const agent = agents.find((a) => a.name === name);
	if (!agent) { ctx.ui.notify(`Agent "${name}" not found.`, "error"); return; }
	await agentActionsMenu(agent, pi, ctx);
}

async function menuEditField(agent: AgentFile, field: string, _pi: ExtensionAPI, ctx: any): Promise<void> {
	const rawContent = fs.readFileSync(agent.filePath, "utf-8");
	const { frontmatter: fm, body } = parseFrontmatter(rawContent);

	if (field === "system prompt") {
		const updated = await ctx.ui.editor("Edit system prompt:", body);
		if (updated === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
		fs.writeFileSync(agent.filePath, serializeAgent(fm, updated), "utf-8");
		ctx.ui.notify(`✓ System prompt updated for "${agent.name}".`, "info");

	} else if (field === "description") {
		const updated = await ctx.ui.editor("Edit description:", fm.description);
		if (updated === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
		fm.description = updated.trim();
		fs.writeFileSync(agent.filePath, serializeAgent(fm, body), "utf-8");
		ctx.ui.notify(`✓ Description updated.`, "info");

	} else if (field === "model") {
		const enabledModels = getEnabledModels();
		if (enabledModels.length === 0) {
			ctx.ui.notify("No models found in settings.json → enabledModels. Add models there first.", "error");
			return;
		}
		const modelChoice = await ctx.ui.select(`Model (current: ${fm.model ?? "(default)"}):`, ["(default)", ...enabledModels]);
		if (modelChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
		fm.model = modelChoice === "(default)" ? undefined : modelChoice;
		fs.writeFileSync(agent.filePath, serializeAgent(fm, body), "utf-8");
		ctx.ui.notify(`✓ Model updated to "${fm.model ?? "(default)"}" for "${agent.name}".`, "info");

	} else if (field === "tools") {
		const toolPresetKeys = Object.keys(TOOL_PRESETS);
		const toolChoice = await ctx.ui.select(`Tool set (current: ${fm.tools ?? "(default)"}):`, [...toolPresetKeys, "custom…"]);
		if (toolChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }

		if (toolChoice === "custom…") {
			const custom = await ctx.ui.editor("Enter tool list (comma-separated):", fm.tools ?? "");
			if (custom === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
			fm.tools = custom.trim() || undefined;
		} else {
			fm.tools = TOOL_PRESETS[toolChoice];
		}
		fs.writeFileSync(agent.filePath, serializeAgent(fm, body), "utf-8");
		ctx.ui.notify(`✓ Tools updated for "${agent.name}".`, "info");
	}
}

// ── Delete ───────────────────────────────────────────────────────────────────

async function menuDelete(name: string, _pi: ExtensionAPI, ctx: any): Promise<void> {
	if (!name) return;
	const { agents } = discoverAll(ctx.cwd);
	const agent = agents.find((a) => a.name === name);
	if (!agent) { ctx.ui.notify(`Agent "${name}" not found.`, "error"); return; }

	const ok = await ctx.ui.confirm(
		`Delete "${name}"?`,
		`This will permanently remove:\n${agent.filePath}`,
	);
	if (!ok) { ctx.ui.notify("Cancelled.", "info"); return; }

	fs.unlinkSync(agent.filePath);
	ctx.ui.notify(`✓ Agent "${name}" deleted.`, "info");
}
