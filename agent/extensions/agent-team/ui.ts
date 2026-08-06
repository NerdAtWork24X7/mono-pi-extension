// ── UI: system prompt builder + widget rendering ──

import { Text, matchesKey, Key } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { displayName, fmtTok, hrPad, shortModel, ansiRe, isWritable, filterSkills } from "./core";
import { saveTeamsYaml, loadTeamsYaml, discoverAllSkills, type Skill } from "./config";
import { MemoryManager } from "./memory";
import { makeHandleEvent } from "./orchestration";
import { mkdirSync } from "fs";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "path";

/** An agent is "working" when it is actively doing something. Idle / done /
 *  error / dead agents are hidden from the widget so only live subagents show. */
export function isWorking(ap: AgentProc): boolean {
	return ap.status === "running" || ap.status === "starting";
}

/** Sidebar visibility state - module-level so it persists across re-renders */
let sidebarVisible = false;
let sidebarOverlayHandle: any = null;

export function isSidebarVisible(): boolean {
	return sidebarVisible;
}

export function toggleSidebar(ctx: AgentTeamContext) {
	if (sidebarVisible) {
		closeSidebar();
	} else {
		openSidebar(ctx);
	}
}

export function closeSidebar() {
	sidebarVisible = false;
	if (sidebarOverlayHandle) {
		sidebarOverlayHandle.hide();
		sidebarOverlayHandle = null;
	}
}

/** Persist the `active` flag for a specific agent in the current team to teams.yaml */
function persistAgentActive(ctx: AgentTeamContext, agentName: string, active: boolean) {
	const tp = join(getAgentDir(), "agents", "teams.yaml");
	const parsed = loadTeamsYaml(tp);
	const teamMembers = parsed.teams[ctx.activeTeam];
	if (teamMembers) {
		const member = teamMembers.find(m => m.name.toLowerCase() === agentName.toLowerCase());
		if (member) {
			member.active = active;
		}
	}
	// Also update the in-memory teams data
	const memMembers = ctx.teams[ctx.activeTeam];
	if (memMembers) {
		const mem = memMembers.find(m => m.name.toLowerCase() === agentName.toLowerCase());
		if (mem) mem.active = active;
	}
	saveTeamsYaml(tp, parsed);
}
/** Toggle a skill in a single enable-set. An empty set means "no skills
 *  enabled". Adding/removing is straightforward add/delete. */
function toggleSkillSet(set: Set<string>, allSkills: Skill[], sk: Skill) {
	if (set.has(sk.dir)) {
		set.delete(sk.dir);
	} else {
		set.add(sk.dir);
	}
}


export function openSidebar(ctx: AgentTeamContext) {
	if (!ctx.wCtx) return;
	sidebarVisible = true;

	const overlayWidth = 45;

	ctx.wCtx.ui.custom(
		(tui: any, theme: any, keybindings: any, done: () => void) => {
			let section: "orch" | "memory" | "teams" | "sub" = "orch"; // which section is focused
			let teamIdx = 0; // index within teams section
			let skillIdx = 0; // index within orchestrator skill list
			let subIdx = 0; // index within subagents flat list (agents then skills)
			// Snapshot ALL available skills (including disabled in settings.json) once when sidebar opens
			const allSkills = discoverAllSkills();
			const agents = () => Array.from(ctx.procs.values());

			const component = {
				render(width: number): string[] {
					const lines: string[] = [];
					const allAgents = agents();
					const w = Math.min(width, overlayWidth);
					const innerW = w - 2;
					const teamNames = Object.keys(ctx.teams);
					const subLen = allAgents.length + allSkills.length;

					// Top border
					lines.push(theme.fg("border", hrPad("", w, "╭", "╮", "─")));

					// Title with orchestrator status
					const titleText = "◆ Agent Team";
					const titlePad = Math.max(0, innerW - [...titleText].length);
					lines.push(
						theme.fg("border", "│ ") +
						theme.fg("accent", theme.bold(titleText)) +
						" ".repeat(titlePad) +
						theme.fg("border", " │")
					);

					// Orchestrator info (always shown)
					const orchModel = shortModel(ctx.orchestratorModel);
					const orchLabel = "Orchestrator";
					const orchModelStr = orchModel ? ` ${orchModel}` : "";
					const orchIcon = "●";
					const orchLine = ` ${orchIcon} ${orchLabel}${orchModelStr}`;
					const orchPad = Math.max(0, innerW - [...orchLine].length);
					lines.push(
						theme.fg("border", "│") +
						theme.fg("success", orchLine) +
						" ".repeat(orchPad) +
						theme.fg("border", " │")
					);

					// Orchestrator skills (folded under the orchestrator header)
					if (allSkills.length > 0) {
						if (skillIdx >= allSkills.length) skillIdx = Math.max(0, allSkills.length - 1);
						for (let i = 0; i < allSkills.length; i++) {
							const sk = allSkills[i];
							const isSelected = section === "orch" && i === skillIdx;
							const on = ctx.orchestratorSkills.has(sk.dir);
							const selPrefix = isSelected ? "▸ " : "  ";
							const icon = on ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
							const label = sk.name.length > innerW - 12 ? sk.name.slice(0, innerW - 15) + "…" : sk.name;
							const rawLine = selPrefix + (on ? "●" : "○") + " " + label;
							const visLen = [...rawLine].length;
							const skillPad = Math.max(0, innerW - visLen);
							const cellContent = theme.fg(isSelected ? "accent" : "text", selPrefix) + icon + theme.fg(isSelected ? "accent" : "text", label);
							const bgColor = isSelected ? "selectedBg" : undefined;
							let renderedLine = theme.fg("border", "│");
							if (bgColor) {
								renderedLine += theme.bg(bgColor, cellContent + " ".repeat(skillPad));
							} else {
								renderedLine += cellContent + " ".repeat(skillPad);
							}
							renderedLine += theme.fg("border", " │");
							lines.push(renderedLine);
						}
					}

					// Separator before Memory section
					lines.push(theme.fg("border", hrPad("", w, "├", "┤", "─")));

					// ── Memory section ──
					const memHeader = " Memory (Enter to toggle)";
					const memHeaderPad = Math.max(0, innerW - [...memHeader].length);
					lines.push(
						theme.fg("border", "│") +
						theme.fg("dim", theme.bold(memHeader)) +
						" ".repeat(memHeaderPad) +
						theme.fg("border", " │")
					);

					// Memory toggle
					{
						const hasMem = !!ctx.memoryManager;
						const memSelected = section === "memory";
						const memIcon = hasMem ? "●" : "○";
						const memLabel = hasMem
							? `Memory ${shortModel(ctx.memoryModel) || ""}`.trim()
							: "Memory (off)";
						const selPrefix = memSelected ? "▸ " : "  ";
						const rawLine = selPrefix + memIcon + " " + memLabel;
						const visLen = [...rawLine].length;
						const memPad = Math.max(0, innerW - visLen);
						const cellContent = theme.fg(memSelected ? "accent" : "text", selPrefix) +
							theme.fg(hasMem ? "success" : "dim", memIcon + " ") +
							theme.fg(memSelected ? "accent" : (hasMem ? "text" : "dim"), memLabel);
						const bgColor = memSelected ? "selectedBg" : undefined;
						let renderedLine = theme.fg("border", "│");
						if (bgColor) {
							renderedLine += theme.bg(bgColor, cellContent + " ".repeat(memPad));
						} else {
							renderedLine += cellContent + " ".repeat(memPad);
						}
						renderedLine += theme.fg("border", " │");
						lines.push(renderedLine);
					}

					// Separator
					lines.push(theme.fg("border", hrPad("", w, "├", "┤", "─")));

					// ── Teams section ──
					const teamsHeader = " Teams (Tab to switch focus)";
					const teamsHeaderPad = Math.max(0, innerW - [...teamsHeader].length);
					lines.push(
						theme.fg("border", "│") +
						theme.fg("dim", theme.bold(teamsHeader)) +
						" ".repeat(teamsHeaderPad) +
						theme.fg("border", " │")
					);

					if (teamNames.length === 0) {
						const emptyMsg = " No teams defined";
						const emptyPad = Math.max(0, innerW - [...emptyMsg].length);
						lines.push(
							theme.fg("border", "│") +
							theme.fg("dim", emptyMsg) +
							" ".repeat(emptyPad) +
							theme.fg("border", " │")
						);
					} else {
						if (teamIdx >= teamNames.length) teamIdx = Math.max(0, teamNames.length - 1);
						for (let i = 0; i < teamNames.length; i++) {
							const tn = teamNames[i];
							const isActive = tn === ctx.activeTeam;
							const isSelected = section === "teams" && i === teamIdx;
							const teamMembers = ctx.teams[tn] || [];
							const activeCount = teamMembers.filter(m => m.active !== false).length;
							const icon = isActive ? "●" : "○";
							const selPrefix = isSelected ? "▸ " : "  ";
							const countStr = ` (${activeCount}/${teamMembers.length})`;
							const teamLine = `${selPrefix}${icon} ${tn}${countStr}`;
							const teamCells = [...teamLine];
							const displayLine = teamCells.length > innerW
								? teamCells.slice(0, innerW - 1).join("") + "…"
								: teamLine;
							const teamPad = Math.max(0, innerW - [...displayLine].length);
							const lineColor = isActive ? "success" : (isSelected ? "accent" : "text");
							const bgColor = isSelected ? "selectedBg" : undefined;
							let renderedLine = theme.fg("border", "│");
							if (bgColor) {
								renderedLine += theme.bg(bgColor, theme.fg(lineColor, displayLine) + " ".repeat(teamPad));
							} else {
								renderedLine += theme.fg(lineColor, displayLine) + " ".repeat(teamPad);
							}
							renderedLine += theme.fg("border", " │");
							lines.push(renderedLine);
						}
					}

					// Separator
					lines.push(theme.fg("border", hrPad("", w, "├", "┤", "─")));

					// ── Subagents section header ──
					const subHeader = " Subagents (Enter to toggle)";
					const subHeaderPad = Math.max(0, innerW - [...subHeader].length);
					lines.push(
						theme.fg("border", "│") +
						theme.fg("dim", theme.bold(subHeader)) +
						" ".repeat(subHeaderPad) +
						theme.fg("border", " │")
					);

					// Clamp subagents-section index across agent rows + skill rows
					if (subIdx >= subLen) subIdx = Math.max(0, subLen - 1);

					// Agent list
					if (allAgents.length === 0) {
						const emptyMsg = " No agents loaded";
						const emptyPad = Math.max(0, innerW - [...emptyMsg].length);
						lines.push(
							theme.fg("border", "│") +
							theme.fg("dim", emptyMsg) +
							" ".repeat(emptyPad) +
							theme.fg("border", " │")
						);
					} else {
						for (let i = 0; i < allAgents.length; i++) {
							const ap = allAgents[i];
							const isSelected = section === "sub" && i === subIdx;
							const isDisabled = ctx.disabledAgents.has(ap.def.name.toLowerCase());

							// Status indicator - show different icon for disabled
							let statusColor: string;
							let statusIcon: string;
							if (isDisabled) {
								statusColor = "dim";
								statusIcon = "◌";
							} else {
								statusColor = ap.status === "idle" ? "dim"
									: ap.status === "starting" ? "warning"
										: ap.status === "running" ? "accent"
											: ap.status === "done" ? "success" : "error";
								statusIcon = ap.status === "idle" ? "○"
									: ap.status === "starting" ? "◐"
										: ap.status === "running" ? "●"
											: ap.status === "done" ? "✓" : "●";
							}

							const name = displayName(ap.def.name);
							const model = shortModel(ap.model);
							const modelStr = model ? ` · ${model}` : "";
							const selPrefix = isSelected ? "▸ " : "  ";
							const disableTag = isDisabled ? " [off]" : "";
							const agentLine = `${selPrefix}${statusIcon} ${name}${modelStr}${disableTag}`;

							// Truncate if too long
							const agentCells = [...agentLine];
							const displayLine = agentCells.length > innerW
								? agentCells.slice(0, innerW - 1).join("") + "…"
								: agentLine;
							const agentPad = Math.max(0, innerW - [...displayLine].length);

							const lineColor = isDisabled ? "dim" : (isSelected ? "accent" : "text");
							const bgColor = isSelected ? "selectedBg" : undefined;

							let renderedLine = theme.fg("border", "│");
							if (bgColor) {
								renderedLine += theme.bg(bgColor, theme.fg(lineColor, displayLine) + " ".repeat(agentPad));
							} else {
								renderedLine += theme.fg(lineColor, displayLine) + " ".repeat(agentPad);
							}
							renderedLine += theme.fg("border", " │");
							lines.push(renderedLine);
						}
					}

					// Subagent skills (folded under the subagents list)
					if (allSkills.length > 0) {
						const dash = "   " + "─".repeat(Math.max(4, innerW - 8));
						lines.push(
							theme.fg("border", "│") +
							theme.fg("dim", dash) +
							" ".repeat(Math.max(0, innerW - [...dash].length)) +
							theme.fg("border", " │")
						);
						for (let i = 0; i < allSkills.length; i++) {
							const sk = allSkills[i];
							const rowIdx = allAgents.length + i;
							const isSelected = section === "sub" && rowIdx === subIdx;
							const on = ctx.subagentSkills.has(sk.dir);
							const selPrefix = isSelected ? "▸ " : "  ";
							const icon = on ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
							const label = sk.name.length > innerW - 12 ? sk.name.slice(0, innerW - 15) + "…" : sk.name;
							const rawLine = selPrefix + (on ? "●" : "○") + " " + label;
							const visLen = [...rawLine].length;
							const skillPad = Math.max(0, innerW - visLen);
							const cellContent = theme.fg(isSelected ? "accent" : "text", selPrefix) + icon + theme.fg(isSelected ? "accent" : "text", label);
							const bgColor = isSelected ? "selectedBg" : undefined;
							let renderedLine = theme.fg("border", "│");
							if (bgColor) {
								renderedLine += theme.bg(bgColor, cellContent + " ".repeat(skillPad));
							} else {
								renderedLine += cellContent + " ".repeat(skillPad);
							}
							renderedLine += theme.fg("border", " │");
							lines.push(renderedLine);
						}
					}

					// Separator
					lines.push(theme.fg("border", hrPad("", w, "├", "┤", "─")));

					// Help text
					const helpLines = [
						" Tab Switch focus ↑↓ Navigate",
						" Enter Select team / Toggle skill / agent / memory",
						" ●=enabled ○=disabled (per group)",
						" Esc/Ctrl+Q Close sidebar",
					];
					for (const help of helpLines) {
						const helpPad = Math.max(0, innerW - [...help].length);
						lines.push(
							theme.fg("border", "│") +
							theme.fg("dim", help) +
							" ".repeat(helpPad) +
							theme.fg("border", " │")
						);
					}

					// Bottom border
					lines.push(theme.fg("border", hrPad("", w, "╰", "╯", "─")));

					return lines;
				},

				handleInput(data: string) {
					const allAgents = agents();
					const teamNames = Object.keys(ctx.teams);
					const subLen = allAgents.length + allSkills.length;

					if (matchesKey(data, Key.tab)) {
						// Cycle focus: orch -> teams -> sub -> orch
						section = section === "orch" ? "memory" : section === "memory" ? "teams" : section === "teams" ? "sub" : "orch";
						tui.requestRender();
					} else if (matchesKey(data, Key.up)) {
						if (section === "teams") {
							teamIdx = Math.max(0, teamIdx - 1);
						} else if (section === "orch") {
							skillIdx = Math.max(0, skillIdx - 1);
						} else if (section === "sub") {
							subIdx = Math.max(0, subIdx - 1);
						}
						tui.requestRender();
					} else if (matchesKey(data, Key.down)) {
						if (section === "teams") {
							teamIdx = Math.min(teamNames.length - 1, teamIdx + 1);
						} else if (section === "orch") {
							skillIdx = Math.min(allSkills.length - 1, skillIdx + 1);
						} else if (section === "sub") {
							subIdx = Math.min(Math.max(0, subLen - 1), subIdx + 1);
						}
						tui.requestRender();
					} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
						if (section === "memory") {
							// Toggle memory on/off
							if (ctx.memoryManager) {
								// Disable — preserve original model for re-enabling
								try { ctx.memoryManager.awaitIdle?.(0); } catch {}
								ctx.memoryManager = null;
								ctx.memoryModel = "";
								ctx.memoryFile = "";
							} else {
								// Enable — use preserved original model or read from teams.yaml
								let modelToEnable = ctx.originalMemoryModel;
								if (!modelToEnable) {
									const memTp = join(getAgentDir(), "agents", "teams.yaml");
									const memParsed = loadTeamsYaml(memTp);
									modelToEnable = memParsed.memoryModel || "";
								}
								if (modelToEnable) {
									ctx.originalMemoryModel = modelToEnable;
									ctx.memoryModel = modelToEnable;
									mkdirSync(ctx.memoryDir, { recursive: true });
									ctx.memoryFile = join(ctx.memoryDir, "project_memory.md");
									ctx.memoryManager = new MemoryManager({
										model: ctx.memoryModel,
										memoryFile: ctx.memoryFile,
										sessionDir: ctx.sessionDir,
										logger: ctx.logger,
										invalidate: () => ctx.invalidate(),
										cachedExtPaths: () => ctx.cachedExtPaths,
										def: {
											name: "memory-summarizer",
											description: "Per-turn memory summarizer spawned alongside the orchestrator.",
											tools: "read,write,edit",
											systemPrompt: "",
											file: "",
										},
										handleEvent: makeHandleEvent(ctx),
									});
								}
							}
							// Persist toggle to teams.yaml (preserve original value when disabling)
							const saveTp = join(getAgentDir(), "agents", "teams.yaml");
							const saveParsed = loadTeamsYaml(saveTp);
							saveParsed.memoryModel = ctx.memoryModel || ctx.originalMemoryModel || undefined;
							saveParsed.memoryActive = !!ctx.memoryManager;
							saveTeamsYaml(saveTp, saveParsed);
							ctx.catalogDirty = true;
							ctx.invalidate();
							tui.requestRender();
						} else if (section === "teams") {
							// Switch to the selected team
							if (teamIdx >= 0 && teamIdx < teamNames.length) {
								const newTeam = teamNames[teamIdx];
								if (newTeam !== ctx.activeTeam) {
									ctx.activateTeam(newTeam);
									ctx.invalidate();
									if (ctx.wCtx) {
										ctx.wCtx.ui.setStatus("agent-team", `Team: ${newTeam} (${ctx.procs.size})`);
										ctx.wCtx.ui.notify(`Switched to team: ${newTeam}`, "info");
									}
								}
							}
						} else if (section === "orch") {
							// Toggle orchestrator skill
							if (skillIdx >= 0 && skillIdx < allSkills.length) {
								const sk = allSkills[skillIdx];
								toggleSkillSet(ctx.orchestratorSkills, allSkills, sk);
								ctx.catalogDirty = true;
								ctx.persist();
								tui.requestRender();
							}
						} else {
							// Subagents section: agents list then subagent skills
							if (subIdx >= 0 && subIdx < allAgents.length) {
								// Toggle agent enabled/disabled
								const ap = allAgents[subIdx];
								const agentKey = ap.def.name.toLowerCase();
								const wasDisabled = ctx.disabledAgents.has(agentKey);

								if (wasDisabled) {
									// Enable the agent
									ctx.disabledAgents.delete(agentKey);
									persistAgentActive(ctx, ap.def.name, true);
								} else {
									// Disable the agent - kill if running
									if (ap.status === "running" || ap.status === "starting") {
										ctx.killProc(ap, true);
										ctx.wipeSessionFile(ap);
										ap.status = "dead";
									}
									ctx.disabledAgents.add(agentKey);
									persistAgentActive(ctx, ap.def.name, false);
								}
								ctx.catalogDirty = true;
								ctx.persist();
								ctx.invalidate();
								tui.requestRender();
							} else {
								// Toggle subagent skill
								const sIdx = subIdx - allAgents.length;
								if (sIdx >= 0 && sIdx < allSkills.length) {
									const sk = allSkills[sIdx];
									toggleSkillSet(ctx.subagentSkills, allSkills, sk);
									ctx.catalogDirty = true;
									ctx.persist();
									tui.requestRender();
								}
							}
						}
					} else if (matchesKey(data, Key.escape)) {
						closeSidebar();
						done();
					}
				},

				invalidate() {},
				wantsKeyRelease: false,
			};

			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				width: overlayWidth,
				anchor: "right-center",
				offsetX: -2,
				offsetY: 0,
				margin: 1,
			},
			onHandle: (handle: any) => {
				sidebarOverlayHandle = handle;
			},
		}
	);
}

// ── System prompt builder ──

export function buildCatalog(ctx: AgentTeamContext): string {
	if (!ctx.catalogDirty && ctx.catalogCache) return ctx.catalogCache;
	const filteredSubSkills = filterSkills(ctx.skillsCache, ctx.subagentSkills);
	ctx.catalogCache = Array.from(ctx.procs.values())
		.filter(a => !ctx.disabledAgents.has(a.def.name.toLowerCase()))
		.map(a => {
			const access = isWritable(a.def, ctx.destructiveTools) ? "read-write" : "read-only";
			const skillsLabel = a.def.skills
				? `**Skills:** ${a.def.skills.join(", ") || "none"}`
				: ``;
			return `### ${a.def.name}\n ${a.def.description}\n**Tools:** ${a.def.tools}\n${skillsLabel}`;
		})
		.join("\n\n");
	ctx.catalogDirty = false;
	return ctx.catalogCache;
}

export function buildSystemPrompt(args: {
	catalog: string;
	date: string;
	cwd: string;
	memory?: { file: string } | null;
	agentMd?: string | null;
	skills?: Array<{ name: string; description: string }>;
	parallel?: boolean;
	harshCriticEnabled?: boolean;
	orchestratorTools?: string[];
	readOnlyAgents?: string[];
	skillAgentMap?: Record<string, string[]>;
}): { systemPrompt: string } {
	// When parallelism is disabled, instruct the orchestrator to serialize
	// BOTH subagent dispatches and its own parallel host tool calls.
	const parallelRules = args.parallel === false
		? `- **Serialize all work (parallelism OFF)**: no subagent dispatch is ever batched or concurrent, read-only or writable — every subagent goes through \`dispatch_agent\` one at a time. Fire read-only host tool calls (read/grep/find/ls) one per turn too.
- **Never start a second dispatch while one is still in flight**, writable or not.`
		: `- **Parallel read-only dispatch**: independent read-only subagent lookups (agents whose tools exclude write/edit/doc_generator — e.g. \`file_reader\`) MUST be batched into ONE \`dispatch_agents\` call so they run concurrently. Do not call \`dispatch_agent\` for them one-by-one when they are independent. Cap each batch at ~6 lookups — if more are needed, split into sequential batches rather than one giant fan-out.
- **Read-only host tools**: you may fire multiple read-only tool calls (read/grep/find/ls) within a single turn.
- **Writes/edits are NEVER parallel**: any agent that can write or edit files (coder, documenter, doc_generator, searcher, tester, image_analyzer, …) goes through \`dispatch_agent\` and is always serialized — never include a writable agent in \`dispatch_agents\`, and never start a second write/edit while one is still in flight.
- **Partition parallel web lookups**: when dispatching multiple \`searcher\` agents in parallel, split the URLs/queries into disjoint subsets and assign a distinct subset to each subagent. Never give two parallel searchers the same URL or identical query.`;

	// Workflow steps 2 and 4 must match parallelRules exactly, or a
	// parallel:false run gets Workflow text telling it to batch dispatches
	// while Hard Rules simultaneously forbids it.
	const workflowStep2 = args.parallel === false
		? `2. **Fill context gaps.** Dispatch \`file_reader\`/\`searcher\` only if current context can't answer. Dispatch each one at a time via \`dispatch_agent\` (see Hard Rules — parallelism is off).`
		: `2. **Fill context gaps.** Dispatch \`file_reader\`/\`searcher\` only if current context can't answer; batch independent read-only lookups into a single \`dispatch_agents\` call to run them in parallel.`;
	const workflowStep4 = args.parallel === false
		? `4. **Dispatch the right subagent**, one at a time via \`dispatch_agent\`. Check every result against acceptance criteria before proceeding. If a writable agent's output fails acceptance criteria twice in a row, stop and surface it to the user rather than re-dispatching a third time.`
		: `4. **Dispatch the right subagent.** Read-only agents: batch into one \`dispatch_agents\` call (runs concurrently). Writable agents (coder, documenter, doc_generator, …): use \`dispatch_agent\` one at a time. Check every result against acceptance criteria before proceeding.`;

	const harshCriticSection = args.harshCriticEnabled
		? `\n# Harsh Critic Gate

\`harsh_critic\` is enabled — use it as a gatekeeper after ANY Worker subagent produces a deliverable (code, doc, output). Dispatch it with the original task, the Worker's output, and any prior critique. Loop revise → critique → revise until it returns \`VERDICT: APPROVED\` before showing the output to the user or shipping. Never skip the gate to save a round-trip; never override a REJECTED without addressing every listed issue. When it rejects, hand its prioritized ISSUES back to the Worker verbatim (respect the retry cap in Workflow step 5), not a paraphrase.\n`
		: "";

	const orchestratorToolsSection = args.orchestratorTools && args.orchestratorTools.length > 0
		? `\n# Orchestrator Tools\n\nActive tools available to you directly (without dispatching a subagent):\n${args.orchestratorTools.join(", ")}\n`
		: "";
	const readOnlyAgents = args.readOnlyAgents || [];
	const writableAgents = args.readOnlyAgents
		? args.catalog.split(/^### /m)
			.filter(Boolean)
			.map(block => block.split("\n")[0].trim())
			.filter(name => !readOnlyAgents.includes(name))
		: [];
	const subagentsSummary = args.readOnlyAgents
		? `\n**Read-only (parallelizable via dispatch_agents):** ${readOnlyAgents.join(", ") || "none"}\n**Writable (serialized via dispatch_agent):** ${writableAgents.join(", ") || "none"}\n`
		: "";
	const memSection = args.memory?.file
		? `\n# Memory\n\nA background process appends key context, decisions, and open questions to \`${args.memory.file}\` after each turn. Read it at the start of a task to recall prior project state and follow-ups.\n`
		: "";
	const agentMdSection = args.agentMd
		? `\n${args.agentMd}\n`
		: "";
	const skillsSection = args.skills && args.skills.length > 0
		? `\n# Available Skills\n\nConsult these yourself before planning step 3 if the task matches; they inform *your* plan and acceptance criteria, not a subagent's prompt — subagents don't read this list.\n\n${args.skills.map(s => {
				const agents = args.skillAgentMap?.[s.name];
				const agentSuffix = agents && agents.length > 0 ? ` (agents: ${agents.join(", ")})` : "";
				return `- **${s.name}**: ${s.description}${agentSuffix}`;
			}).join("\n")}\n`
		: "";
	return {
		systemPrompt: `
# Identity
Primary reasoning agent for a multi-agent team: decompose, dispatch, verify against acceptance criteria, synthesize. You orchestrate and decide — never offload reasoning/planning/decisions to subagents.

# Tone & Style
Lazy senior dev: efficient not careless, best code is code never written. Concise, direct, no filler/apologies/restating prompt. Output = GFM in monospace CLI, minimize tokens. No emojis unless asked. Ambiguous → ask ONE question, then proceed. Stuck beyond your knowledge → dispatch \`searcher\`, don't guess.

## Ladder (stop at first rung that holds)
1. Needed at all? No → skip, say so (YAGNI). 2. Stdlib? 3. Native platform feature? 4. Already-installed dep? 5. One line? 6. Minimum code.
Exception: any file-output task always → \`doc_generator\`, regardless of size (overrides ladder).

# Workflow
1. Restate goal (1 line); ask if ambiguous.
${workflowStep2}
3. Plan minimal change set + explicit acceptance criteria. Prefer editing over creating files.
${workflowStep4}
5. \`tester\` with exact commands. Failure → error excerpt + file paths back to \`coder\` (max 2 retries). After 2 → stop, surface failure+evidence, don't paper over.
6. **VERY IMPORTANT** Always perform test or have solid evidence that task is complete and fully functional.(No Compromise)
7. \`documenter\` if change touches public surface (CLI flags, env vars, exports, config keys, breaking changes), even unasked. Else skip.
8. Summarize: changed / verified / remaining.

Plan before dispatching. Reflect on every output before proceeding — never dispatch blindly.

# Dispatch Contract
Subagents are stateless, see only your prompt. Each dispatch: task+acceptance criteria (1 line) + all relevant paths/excerpts/errors/decisions + expected return format. Never reference prior turns ("as discussed").
${harshCriticSection}

# Escalation Protocol
- \`AMBIGUOUS: <q>\` → fixed by context/convention/readable file → resolve yourself. Genuine judgment call (product decision, destructive-vs-safe tradeoff) → ask user. Either way, re-dispatch with answer baked in.
- \`NOT FOUND\` → ground truth for that location; widen search / change approach.
- \`BLOCKED: <reason>\` → resolve blocker (env/flag/permission) before re-dispatch.
- \`TIMEOUT\` (tester) → real failure. Report partial output; re-dispatch only if you can name the cause — never retry identical command.
- \`TASK_TOO_LARGE: <reason>\` → the subagent's context grew too large and auto-compacted. Do not retry the same prompt. Split the task into smaller pieces and re-dispatch.
- Raw error, no keyword → treat as \`BLOCKED\`: find root cause, fix input/spec if yours, re-dispatch once. Fails again → stop, surface evidence verbatim.

# Hard Rules
${parallelRules}
- Delegate only context-heavy work (large files, web, exec) — never reasoning/planning/decisions.
- Never accept subagent output without checking it vs. goal/acceptance criteria.
- Never edit code or run tests yourself — always use a subagent.
- Any file-output task (.xlsx/.pdf/.docx/.pptx/.html/.csv/.json/…) → \`doc_generator\`, however simple — never inline file content.
- Never re-dispatch for something already answerable from results in hand.
- Stay in scope: no drive-by refactors/unrequested features — note as suggestions instead.
- Temp files → \`${args.cwd}/tmp\`.
- Ignore \`.venv .pi node_modules __pycache__ .git\` everywhere.
- YAGNI, prefer one-liners.
- Confirm the issue is actually fixed before marking done.
- When fixing issue always test using subagent and check if there are similar issue are found and ask if user wants to fix them.
- When You are not able to solve the problem instead of going in loop do web search and check for solution

# Tool Priority
\`grep\` > \`read\` (offset/limit) > full file; \`find\` for filename patterns. One known file/symbol → resolve yourself; broader → subagent. Any image task → \`image_analyzer\`, never infer from filename/path. Confused subagent output → fresh session, sharper prompt, don't steer the broken one.
${orchestratorToolsSection}${memSection}

# Subagents
${args.catalog}

# Subagents Sumary
${subagentsSummary}

${agentMdSection}

${skillsSection}

# Output Contract
3–8 lines: (1) goal recap, (2) what changed (file:line) or generated (abs paths), (3) verification status or "not verified", (4) open questions or "done". No filler, no apologies, no restating prompt.

Date: ${args.date}
CWD: \`${args.cwd}\`
`,
	};
}

// ── Widget rendering ──

export function initWidget(ctx: AgentTeamContext) {
	if (!ctx.wCtx) return;
	ctx.wInvalidate = null;

	ctx.wCtx.ui.setWidget("agent-team", (tui: any, theme: any) => {
		const text = new Text("", 0, 1);
		ctx.wInvalidate = () => tui.requestRender();
		return {
			render(width: number): string[] {
				const hasMemory = !!ctx.memoryManager;
				const activeClones = [...ctx.batchClones].filter(isWorking);
				const visibleProcs = [...ctx.procs.values()].filter(ap => !ctx.disabledAgents.has(ap.def.name.toLowerCase()));
				const totalCount = visibleProcs.length + activeClones.length;

				if (!ctx.enabled) {
					text.setText(theme.fg("dim", "Agent team disabled. /agents-team-toggle on"));
					return text.render(width);
				}

				if (!totalCount) {
					const hint = "No agents. Add subagent to agent.yml files to agents/";
					const hintVis = [...hint].length;
					const hintLine =
						theme.fg("border", "│   ") +
						theme.fg("dim", hint) +
						theme.fg("border", " ".repeat(Math.max(0, width - 4 - hintVis - 2)) + " │");
					const topBorder = theme.fg("border", hrPad("", width, "╭", "╮", "─"));
					const bottomBorder = theme.fg("border", hrPad("", width, "╰", "╯", "─"));
					text.setText([topBorder, hintLine, bottomBorder].join("\n"));
					return text.render(width);
				}

				const boxPad = 4;
				const innerW = width - boxPad;
				const cols = Math.min(ctx.gridCols, totalCount);
				const cardGap = 1;
				const colW = Math.floor((innerW - cardGap * (cols - 1)) / cols);

				const cards: string[][] = [];
				for (const ap of visibleProcs) cards.push(renderCard(ctx, ap, colW, theme));
				for (const ap of activeClones) {
					const label = displayName(ap.def.name) + (ap.runId ? " *" : "");
					cards.push(renderCard(ctx, ap, colW, theme, label));
				}
				if (hasMemory) cards.push(renderMemoryCard(ctx, colW, theme));

				const rows: string[][] = [];
				for (let i = 0; i < cards.length; i += cols) {
					const row = cards.slice(i, i + cols);
					while (row.length < cols) row.push([" ".repeat(colW)]);
					const h = Math.max(...row.map(c => c.length));
					for (const c of row) { while (c.length < h) c.push(" ".repeat(colW)); }
					for (let line = 0; line < h; line++) {
						rows.push(row.map(c => c[line] || ""));
					}
				}

				const topBorder = theme.fg("border", hrPad("", width, "╭", "╮", "─"));
				// ── Header: "Subagent Team" sits inside the box, left-aligned after the border ──
				const headerText = "Subagent Team";
				const headerPad = Math.max(0, innerW - [...headerText].length);
				const headerLine =
					theme.fg("border", "│ ") +
					theme.fg("accent", theme.bold(headerText)) +
					" ".repeat(headerPad) +
					" " + theme.fg("border", "│");
				const sepLine = theme.fg("border", hrPad("", width, "├", "┤", "─"));
				const boxedRows = rows.map(r => {
					const rowStr = r.join(" ".repeat(cardGap));
					const rowVis = [...rowStr.replace(ansiRe, "")].length;
					const padded = rowStr + " ".repeat(Math.max(0, innerW - rowVis));
					return theme.fg("border", "│") + " " + padded + " " + theme.fg("border", "│");
				});
				const bottomBorder = theme.fg("border", hrPad("", width, "╰", "╯", "─"));

				// ── Per-agent TUI log grid (scales with swapped agents) ──
				const logRows = renderLogGrid(ctx, innerW, theme);

				const parts = [topBorder, headerLine, sepLine, ...boxedRows];
				if (logRows.length) parts.push(theme.fg("border", hrPad("", width, "├", "┤", "─")), ...logRows);
				parts.push(bottomBorder);

				text.setText(parts.join("\n"));
				return text.render(width);
			},
		};
	}, { placement: "aboveEditor" });

	process.stdout.off("resize", ctx.resizeHandler);
	process.stdout.on("resize", ctx.resizeHandler);

	if (!ctx.wInvalidate) ctx.wInvalidate = () => { };
}

const LOG_PANEL_LINES = 6; // max log lines shown per agent panel

/** Build the per-agent log grid rendered beneath the status cards. Each column
 *  is one agent (team member + active parallel clone + memory), its lines pulled
 *  from that agent's in-memory ring buffer. The grid scales: more swapped agents
 *  → more columns, laid out across `gridCols`. */
export function renderLogGrid(ctx: AgentTeamContext, innerW: number, theme: any): string[] {
	const slots: Array<{ label: string; lines: string[]; accent: boolean }> = [];
	for (const ap of ctx.procs.values()) {
		if (!isWorking(ap)) continue;
		if (ctx.disabledAgents.has(ap.def.name.toLowerCase())) continue;
		slots.push({ label: displayName(ap.def.name), lines: ap.logLines || [], accent: true });
	}
	for (const ap of ctx.batchClones) {
		if (!isWorking(ap)) continue;
		const label = displayName(ap.def.name) + (ap.runId ? " *" : "");
		slots.push({ label, lines: ap.logLines || [], accent: false });
	}
	if (ctx.memoryManager && ctx.memoryManager.memoryLogAgent
		&& ["recording", "summarizing"].includes(ctx.memoryManager.snapshot.status)) {
		slots.push({ label: "Memory", lines: ctx.memoryManager.memoryLogAgent.logLines || [], accent: false });
	}
	if (!slots.length) return [];

	const gap = " │ "; // 3 chars between columns
	const cols = Math.max(1, Math.min(ctx.gridCols, slots.length));
	const colW = Math.max(6, Math.floor((innerW - (cols - 1) * gap.length) / cols));
	const maxLines = Math.max(1, ...slots.map(s => s.lines.length));
	const L = Math.min(maxLines, LOG_PANEL_LINES);

	const wrap = (s: string) => {
		const cells = [...s];
		if (cells.length > colW - 1) return cells.slice(0, colW - 1).join("") + "…";
		return cells.join("") + " ".repeat(Math.max(0, colW - cells.length));
	};
	const rowStr = (cells: string[]) =>
		theme.fg("border", "│") + " " + cells.join(gap) + " " + theme.fg("border", "│");

	// Render `cols` agent columns as one self-contained block (label row + L
	// log rows). Slots are chunked so a wide set of agents wraps into
	// stacked blocks instead of one over-wide row that the terminal wraps and
	// mixes. Matches the status-card grid's row-of-cols layout.
	function renderBlock(block: Array<{ label: string; lines: string[]; accent: boolean }>): string[] {
		const rows: string[] = [];
		rows.push(rowStr(block.map(s => theme.fg(s.accent ? "accent" : "text", theme.bold(wrap(s.label))))));
		for (let r = 0; r < L; r++) {
			rows.push(rowStr(block.map(s => {
				const idx = s.lines.length - L + r;
				const ln = idx >= 0 ? s.lines[idx] : "";
				return theme.fg("text", wrap(ln));
			})));
		}
		return rows;
	}

	const out: string[] = [];
	for (let i = 0; i < slots.length; i += cols) {
		out.push(...renderBlock(slots.slice(i, i + cols)));
	}
	return out;
}

export function invalidate(ctx: AgentTeamContext) {
	ctx.animFrame++;
	if (!ctx.wCtx) return;
	if (ctx.wInvalidate) ctx.wInvalidate();
	else initWidget(ctx);
}

// ── Card rendering (modern compact — thin accent bar, pill-like stats) ──

const trunc = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;

/** Pad a coloured string to exactly `targetW` visible cells with trailing spaces. */
function padToVis(colored: string, targetW: number): string {
	const v = [...colored.replace(ansiRe, "")].length;
	return colored + " ".repeat(Math.max(0, targetW - v));
}

/** 1–2 line agent card: accent bar + icon + name + time, optional stats row. */
export function renderCard(ctx: AgentTeamContext, ap: AgentProc, w: number, theme: any, labelOverride?: string): string[] {
	const statusColor = ap.status === "idle" ? "dim"
		: ap.status === "starting" ? "warning"
			: ap.status === "running" ? "accent"
				: ap.status === "done" ? "success" : "error";
	const statusIcon = ap.status === "idle" ? "○"
		: ap.status === "starting" ? "◐"
			: ap.status === "running" ? "●"
				: ap.status === "done" ? "✓" : "●";

	const name = labelOverride ?? displayName(ap.def.name);
	const sm = shortModel(ap.model);
	const modelStr = sm ? ` ${sm}` : "";
	const timeStr = ["running", "starting", "done"].includes(ap.status)
		? `${Math.round(ap.elapsed / 1000)}s` : "";

	// ── Line 1: ▌ ● Coder claude-3.5              12s ──
	const prefixLen = 4; // "▌ ● "
	const maxLabel = Math.max(1, w - prefixLen - [...timeStr].length - 1);
	const truncatedName = trunc(name, maxLabel - modelStr.length);
	const visibleL1 = prefixLen + [...truncatedName].length + [...modelStr].length;
	const spacing = Math.max(1, w - visibleL1 - [...timeStr].length);

	const line1 =
		theme.fg(statusColor, "▌ ") +
		theme.fg(statusColor, statusIcon + " ") +
		theme.fg("text", theme.bold(truncatedName)) +
		theme.fg("dim", modelStr) +
		" ".repeat(spacing) +
		theme.fg("dim", timeStr);

	const lines = [line1];

	// ── Line 2: ▌   ████░░░░  45% · In 1.2k · Out 400 · � H=500 ──
	if (ap.contextWindow > 0 && (ap.tokensUsed > 0 || ap.tokensOut > 0)) {
		const pct = Math.min(100, Math.round((ap.tokensUsed / ap.contextWindow) * 100));
		const barW = Math.min(10, Math.max(4, Math.floor((w - 4) / 4)));
		const filled = Math.round((pct / 100) * barW);
		const bar = "█".repeat(filled) + "░".repeat(barW - filled);
		const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "accent";

		let statStr = `${pct}% · In ${fmtTok(ap.tokensUsed)} · Out ${fmtTok(ap.tokensOut)}`;
		let cachePill = "";
		if (ap.cacheRead > 0 || ap.cacheSavedTotal > 0) {
			const parts: string[] = [];
			if (ap.cacheRead > 0) parts.push(`H=${fmtTok(ap.cacheRead)}`);
			if (ap.cacheSavedTotal > 0) parts.push(`Σ=${fmtTok(ap.cacheSavedTotal)}`);
			cachePill = ` · � ${parts.join(" ")}`;
		}

		// Drop cache pill if it would overflow; fall back to compact if still too wide
		if (4 + barW + 2 + [...statStr].length + [...cachePill].length > w) cachePill = "";
		if (4 + barW + 2 + [...statStr].length > w) {
			// Still overflowing — drop to bar + percentage only
			statStr = `${pct}%`;
		}

		const line2 = padToVis(
			theme.fg(statusColor, "▌   ") +
			theme.fg(barColor, bar) + "  " +
			theme.fg("dim", statStr) +
			theme.fg("success", cachePill),
			w,
		);

		lines.push(line2);
	}

	return lines;
}

// ── Memory card ──

function formatAgo(ms: number): string {
	if (!ms) return "";
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

export function renderMemoryCard(ctx: AgentTeamContext, w: number, theme: any): string[] {
	const mm = ctx.memoryManager;
	if (!mm) return [theme.fg("dim", "·".repeat(w))];

	const s = mm.snapshot;
	const status = s.status;
	const statusColor = status === "idle" ? "dim"
		: status === "recording" ? "warning"
			: status === "summarizing" ? "accent"
				: status === "done" ? "success" : "error";
	const statusIcon = status === "idle" ? "○"
		: status === "recording" ? "◐"
			: status === "summarizing" ? "●"
				: status === "done" ? "✓" : "●";

	const sm = ctx.memoryModel ? shortModel(ctx.memoryModel) : "";
	const modelStr = sm ? ` ${sm}` : "";

	const timeStr = (status === "summarizing") ? `${Math.round(s.elapsed / 1000)}s`
		: (s.lastSummaryAt ? formatAgo(s.lastSummaryAt) : "");

	// Line 1: ▌ ✓ Memory claude-3.5            5m
	const prefixLen = 4;
	const maxLabel = Math.max(1, w - prefixLen - [...timeStr].length - 1);
	const truncatedName = trunc("Memory", maxLabel - modelStr.length);
	const visibleL1 = prefixLen + [...truncatedName].length + [...modelStr].length;
	const spacing = Math.max(1, w - visibleL1 - [...timeStr].length);

	const line1 =
		theme.fg(statusColor, "▌ ") +
		theme.fg(statusColor, statusIcon + " ") +
		theme.fg("text", theme.bold(truncatedName)) +
		theme.fg("dim", modelStr) +
		" ".repeat(spacing) +
		theme.fg("dim", timeStr);

	// Line 2: ▌   last: 2025-01-01 12:00 · turn 3
	let detail = "";
	if (status === "error" && s.lastError) {
		detail = s.lastError.length > w - 5 ? s.lastError.slice(0, w - 6) + "…" : s.lastError;
	} else if (status === "done" && s.lastSummaryAt) {
		const ts = new Date(s.lastSummaryAt).toISOString().replace("T", " ").slice(0, 19);
		detail = `last: ${ts} · turn ${s.runCount}`;
	} else if (status === "recording") {
		detail = "recording turn…";
	} else if (status === "summarizing") {
		detail = "summarizing…";
	} else {
		detail = `turns: ${s.runCount}`;
	}
	const detailColor = status === "error" ? "error" : "dim";
	const line2 = padToVis(
		theme.fg(statusColor, "▌   ") + theme.fg(detailColor, detail),
		w,
	);

	return [line1, line2];
}
