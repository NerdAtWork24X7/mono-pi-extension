/**
 * Agent Sidebar Extension
 *
 * Right-side overlay panel for enabling/disabling subagents.
 *
 * Commands:
 *   /sidebar          - Toggle the sidebar open/closed
 *   Ctrl+Shift+B      - Toggle the sidebar (keyboard shortcut)
 *
 * The sidebar reads agents from:
 *   - ~/.pi/agent/agents/*.md  (user-level agents)
 *   - teams.yaml               (team definitions with model overrides)
 *
 * Enabled/disabled state persists across sessions in agent-sidebar-config.json.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ───────────────────────────────────────────────────────────

interface AgentInfo {
	name: string;
	description: string;
	tools: string;
	model?: string;
	teamModel?: string;
	source: "user" | "project";
	file: string;
	teamNames: string[]; // which teams include this agent
}

interface SidebarConfig {
	enabledAgents: string[]; // names of enabled agents
	activeTeam: string;
}

// ── Config persistence ──────────────────────────────────────────────

const CONFIG_FILE = "agent-sidebar-config.json";

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): SidebarConfig {
	const p = configPath();
	if (!existsSync(p)) return { enabledAgents: [], activeTeam: "" };
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return { enabledAgents: [], activeTeam: "" };
	}
}

function saveConfig(cfg: SidebarConfig) {
	try {
		writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
	} catch { /* ignore */ }
}

// ── Agent discovery ─────────────────────────────────────────────────

function parseAgentMd(filePath: string): AgentInfo | null {
	try {
		let raw = readFileSync(filePath, "utf-8");
		raw = raw.replace(/\r\n/g, "\n");
		const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!m) return null;
		const fm: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const i = line.indexOf(":");
			if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		if (!fm.name) return null;
		return {
			name: fm.name,
			description: fm.description || "",
			tools: fm.tools || "read,grep,find,ls",
			model: fm.model,
			source: "user",
			file: filePath,
			teamNames: [],
		};
	} catch {
		return null;
	}
}

interface ParsedTeams {
	teams: Record<string, Array<{ name: string; model?: string }>>;
}

function parseTeamsYaml(raw: string): ParsedTeams {
	raw = raw.replace(/\r\n?/g, "\n");
	const teams: Record<string, Array<{ name: string; model?: string }>> = {};
	let cur = "";
	let curMember: { name: string; model?: string } | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		// Top-level keys that aren't team names
		if (/^memory_model:/.test(line)) { cur = ""; curMember = null; continue; }
		const tm = line.match(/^(\S[^:]*):$/);
		if (tm) {
			cur = tm[1].trim();
			teams[cur] = [];
			curMember = null;
			continue;
		}
		if (!cur) continue;
		const nm = line.match(/^\s*-\s+name:\s*(.+)$/);
		if (nm) {
			curMember = { name: nm[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		const im = line.match(/^\s*-\s+(\S+)$/);
		if (im) {
			curMember = { name: im[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		const pm = line.match(/^\s{2,}(\w+):\s*(.+)$/);
		if (pm && curMember) {
			if (pm[1].trim() === "model") curMember.model = pm[2].trim();
			continue;
		}
	}
	return { teams };
}

function discoverAgents(): {
	agents: AgentInfo[];
	teams: Record<string, Array<{ name: string; model?: string }>>;
} {
	const agentDir = join(getAgentDir(), "agents");
	const agents: AgentInfo[] = [];
	const seen = new Set<string>();

	// Load .md agent files
	if (existsSync(agentDir)) {
		try {
			for (const f of readdirSync(agentDir)) {
				if (!f.endsWith(".md")) continue;
				const fp = join(agentDir, f);
				const def = parseAgentMd(fp);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch { /* ignore */ }
	}

	// Load teams.yaml
	let teams: Record<string, Array<{ name: string; model?: string }>> = {};
	const teamsPath = join(agentDir, "teams.yaml");
	if (existsSync(teamsPath)) {
		try {
			const parsed = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			teams = parsed.teams;
		} catch { /* ignore */ }
	}

	// Annotate agents with their team memberships and team model overrides
	for (const [teamName, members] of Object.entries(teams)) {
		for (const member of members) {
			const agent = agents.find((a) => a.name.toLowerCase() === member.name.toLowerCase());
			if (agent) {
				if (!agent.teamNames.includes(teamName)) agent.teamNames.push(teamName);
				if (member.model && !agent.teamModel) agent.teamModel = member.model;
			}
		}
	}

	return { agents, teams };
}

// ── Sidebar component ───────────────────────────────────────────────

class AgentSidebar {
	private agents: AgentInfo[];
	private teams: Record<string, Array<{ name: string; model?: string }>>;
	private enabledSet: Set<string>;
	private selectedIndex = 0;
	private activeTeam: string;
	private scrollOffset = 0;
	private maxVisible = 15;
	private done: () => void;
	private onChange?: () => void;
	private theme: any;
	private tui: any;
	private showingTeamPicker = false;
	private teamNames: string[] = [];
	private teamSelectedIndex = 0;

	constructor(
		agents: AgentInfo[],
		teams: Record<string, Array<{ name: string; model?: string }>>,
		config: SidebarConfig,
		theme: any,
		tui: any,
		done: () => void,
		onChange?: () => void,
	) {
		this.agents = agents;
		this.teams = teams;
		this.enabledSet = new Set(config.enabledAgents);
		this.activeTeam = config.activeTeam || Object.keys(teams)[0] || "";
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.onChange = onChange;
		this.teamNames = Object.keys(teams);

		// If no config saved yet, enable all agents by default
		if (config.enabledAgents.length === 0 && agents.length > 0) {
			for (const a of agents) this.enabledSet.add(a.name);
		}

		// Set selected index to first agent
		if (agents.length > 0) this.selectedIndex = 0;
	}

	handleInput(data: string): void {
		if (this.showingTeamPicker) {
			this.handleTeamPickerInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+b")) {
			this.done();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.ensureVisible();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.selectedIndex < this.agents.length - 1) {
				this.selectedIndex++;
				this.ensureVisible();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "space") || matchesKey(data, "enter")) {
			this.toggleSelected();
			return;
		}

		// 'a' to enable all
		if (data === "a") {
			for (const a of this.agents) this.enabledSet.add(a.name);
			this.saveAndNotify();
			this.tui.requestRender();
			return;
		}

		// 'n' to disable all
		if (data === "n") {
			this.enabledSet.clear();
			this.saveAndNotify();
			this.tui.requestRender();
			return;
		}

		// 't' to pick team
		if (data === "t" && this.teamNames.length > 0) {
			this.showingTeamPicker = true;
			this.teamSelectedIndex = this.teamNames.indexOf(this.activeTeam);
			if (this.teamSelectedIndex < 0) this.teamSelectedIndex = 0;
			this.tui.requestRender();
			return;
		}

		// 'e' to enable only team members
		if (data === "e" && this.activeTeam) {
			this.enabledSet.clear();
			const teamMembers = this.teams[this.activeTeam] || [];
			for (const m of teamMembers) {
				this.enabledSet.add(m.name);
			}
			this.saveAndNotify();
			this.tui.requestRender();
			return;
		}
	}

	private handleTeamPickerInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.showingTeamPicker = false;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.teamSelectedIndex > 0) {
				this.teamSelectedIndex--;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.teamSelectedIndex < this.teamNames.length - 1) {
				this.teamSelectedIndex++;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "space") || matchesKey(data, "enter")) {
			this.activeTeam = this.teamNames[this.teamSelectedIndex] || "";
			this.saveConfig();
			this.showingTeamPicker = false;
			this.tui.requestRender();
			return;
		}
	}

	private toggleSelected(): void {
		const agent = this.agents[this.selectedIndex];
		if (!agent) return;
		if (this.enabledSet.has(agent.name)) {
			this.enabledSet.delete(agent.name);
		} else {
			this.enabledSet.add(agent.name);
		}
		this.saveAndNotify();
		this.tui.requestRender();
	}

	private ensureVisible(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
		}
	}

	private saveConfig(): void {
		saveConfig({
			enabledAgents: Array.from(this.enabledSet),
			activeTeam: this.activeTeam,
		});
	}

	private saveAndNotify(): void {
		this.saveConfig();
		this.onChange?.();
	}

	/** Get the set of currently enabled agent names */
	getEnabledAgents(): Set<string> {
		return new Set(this.enabledSet);
	}

	render(width: number): string[] {
		if (this.showingTeamPicker) return this.renderTeamPicker(width);
		return this.renderAgentList(width);
	}

	private renderTeamPicker(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", th.bold(" Select Team"))) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		for (let i = 0; i < this.teamNames.length; i++) {
			const name = this.teamNames[i]!;
			const isSelected = i === this.teamSelectedIndex;
			const isCurrent = name === this.activeTeam;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const marker = isCurrent ? th.fg("success", " ●") : "";
			const text = isSelected ? th.fg("accent", name) : name;
			lines.push(border("│") + padLine(`${prefix}${text}${marker}`) + border("│"));
		}

		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate | Enter select | Esc back")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private renderAgentList(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		// Header
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		const headerText = "Subagent Sidebar";
		lines.push(border("│") + padLine(th.fg("accent", th.bold(` ${headerText}`))) + border("│"));

		// Team info
		if (this.activeTeam) {
			const teamMembers = this.teams[this.activeTeam] || [];
			const teamInfo = `Team: ${this.activeTeam} (${teamMembers.length})`;
			lines.push(border("│") + padLine(th.fg("muted", ` ${teamInfo}`)) + border("│"));
		}

		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		if (this.agents.length === 0) {
			lines.push(border("│") + padLine(th.fg("dim", " No agents found")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " Add .md files to ~/.pi/agent/agents/")) + border("│"));
		} else {
			// Visible agents
			const visibleAgents = this.agents.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);

			for (let i = 0; i < visibleAgents.length; i++) {
				const agent = visibleAgents[i]!;
				const globalIdx = this.scrollOffset + i;
				const isSelected = globalIdx === this.selectedIndex;
				const isEnabled = this.enabledSet.has(agent.name);

				const check = isEnabled
					? th.fg("success", "● ")
					: th.fg("dim", "○ ");
				const cursor = isSelected ? th.fg("accent", "→ ") : "  ";
				const name = isSelected ? th.fg("accent", agent.name) : agent.name;
				const model = agent.teamModel || agent.model;
				const modelStr = model ? th.fg("dim", ` [${shortModel(model)}]`) : "";
				const teamBadge = agent.teamNames.length > 0
					? th.fg("muted", ` ${agent.teamNames.join(",")}`)
					: "";

				const line = `${cursor}${check}${name}${modelStr}${teamBadge}`;
				lines.push(border("│") + padLine(line) + border("│"));

				// Description on next line (truncated)
				if (isSelected && agent.description) {
					const desc = agent.description.length > innerW - 6
						? agent.description.slice(0, innerW - 9) + "..."
						: agent.description;
					lines.push(border("│") + padLine(`    ${th.fg("dim", desc)}`) + border("│"));
				}
			}

			// Scroll indicator
			if (this.agents.length > this.maxVisible) {
				const scrollInfo = `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.maxVisible, this.agents.length)} of ${this.agents.length}`;
				lines.push(border("│") + padLine(th.fg("dim", ` ${scrollInfo}`)) + border("│"));
			}
		}

		// Enabled count
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		const enabledCount = this.enabledSet.size;
		const totalCount = this.agents.length;
		const statusLine = `${enabledCount}/${totalCount} enabled`;
		lines.push(border("│") + padLine(th.fg("muted", ` ${statusLine}`)) + border("│"));

		// Controls
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate | Space toggle")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " a all | n none | e team only")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " t pick team | Esc/B close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

function shortModel(model: string): string {
	const i = model.lastIndexOf("/");
	return i >= 0 ? model.slice(i + 1) : model;
}

// ── Extension entry point ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let sidebarHandle: any = null; // OverlayHandle when open
	let currentConfig = loadConfig();

	// Re-discover agents each time the sidebar opens (cheap file scan)
	function getAgents() {
		return discoverAgents();
	}

	function openSidebar(ctx: ExtensionCommandContext | any) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Sidebar requires TUI mode", "error");
			return;
		}

		const { agents, teams } = getAgents();
		const config = loadConfig();
		currentConfig = config;

		// If we have a saved config, use it; otherwise enable all
		if (config.enabledAgents.length === 0 && agents.length > 0) {
			currentConfig = {
				enabledAgents: agents.map((a) => a.name),
				activeTeam: config.activeTeam || Object.keys(teams)[0] || "",
			};
			saveConfig(currentConfig);
		}

		ctx.ui.custom<string | null>(
			(tui: any, theme: any, _kb: any, done: () => void) => {
				const sidebar = new AgentSidebar(
					agents,
					teams,
					currentConfig,
					theme,
					tui,
					done,
					() => {
						// When agents are toggled, update the config
						currentConfig = {
							enabledAgents: Array.from(sidebar.getEnabledAgents()),
							activeTeam: currentConfig.activeTeam,
						};
						ctx.ui.notify(
							`${currentConfig.enabledAgents.length} agents enabled`,
							"info",
						);
					},
				);

				return {
					render(width: number) {
						return sidebar.render(width);
					},
					handleInput(data: string) {
						sidebar.handleInput(data);
					},
					invalidate() {},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: 40,
					minWidth: 30,
					maxHeight: "90%",
					margin: { right: 1 },
				},
			},
		);
	}

	// Register /sidebar command
	pi.registerCommand("sidebar", {
		description: "Toggle subagent sidebar (enable/disable agents)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			openSidebar(ctx);
		},
	});

	// Register Ctrl+Shift+B shortcut
	pi.registerShortcut("ctrl+shift+b", {
		description: "Toggle subagent sidebar",
		handler: async (ctx) => {
			openSidebar(ctx);
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		currentConfig = loadConfig();
	});
}
