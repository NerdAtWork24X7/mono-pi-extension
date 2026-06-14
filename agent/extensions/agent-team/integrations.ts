// ── Integrations: tool registration + slash commands + shortcut ──

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { AgentTeamContext } from "./core";
import { displayName, shortModel } from "./core";
import { MAX_RESPONSE_LENGTH } from "./orchestration";

export function registerDispatchAgentTool(pi: ExtensionAPI, team: AgentTeamContext) {
	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. A fresh process is spawned per task — no context carries over between dispatches. Include all necessary context in the task description.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent" }),
		}),

		async execute(_id, params, signal, onUpdate, _ctx) {
			const { agent, task } = params as { agent: string; task: string };
			if (!team.enabled) return {
				content: [{ type: "text", text: "Agent team is disabled. /agents-team-toggle on" }],
			};

			try {
				const tag = this.agentTag(agent);

				onUpdate?.({
					content: [{ type: "text", text: `${tag} - dispatching...` }],
					details: { agent, task, status: "dispatching" },
				});

				// Listen for ESC / abort signal — kill running subagent
				if (signal) {
					// Capture the ap at registration time. If the user dispatches
					// the same agent twice in a row, a second listener is added
					// for a NEW ap; the first listener must NOT see that one.
					const capturedAp = team.procs.get(agent.toLowerCase());
					if (capturedAp) {
						signal.addEventListener("abort", () => {
							if (capturedAp.status === "running" || capturedAp.status === "starting") {
								team.logger.logErrorBox(capturedAp, "ABORTED", "User pressed ESC");
								team.killProc(capturedAp, true);
								team.wipeSessionFile(capturedAp);
								capturedAp.status = "dead";
								team.invalidate();
							}
						});
					}
				}

				const r = await team.dispatch(agent, task);

				// Guard rail: truncate response to last MAX_RESPONSE_LENGTH chars
				let output = r.output;
				if (output.length > MAX_RESPONSE_LENGTH) {
					output = output.slice(-MAX_RESPONSE_LENGTH);
					output = `... [truncated to last ${MAX_RESPONSE_LENGTH} chars]\n` + output;
				}

				const status = r.code === 0 ? "done" : "error";
				const summary = `${tag} - ${status} in ${Math.round(r.elapsed / 1000)}s`;

				if (r.code !== 0 && team.wCtx) {
					team.wCtx.ui.notify(summary, "error");
				}

				return {
					content: [{ type: "text", text: output }],
					details: { agent, task, status, elapsed: r.elapsed, exitCode: r.code, fullOutput: output },
				};
			} catch (err: any) {
				if (team.wCtx) team.wCtx.ui.notify(`[${agent}] Error: ${err?.message || err}`, "error");
				return {
					content: [{ type: "text", text: `Error dispatching ${agent}: ${err?.message || err}. The orchestrator should inform the user.` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		/** Get agent display info: [name][model] tag */
		agentTag(name: string): string {
			const apRef = team.procs.get(name.toLowerCase());
			return `[${name}][${apRef ? shortModel(apRef.model) : "?"}]`;
		},

		renderCall(args, theme) {
			const a = (args as any).agent || "?";
			const t = (args as any).task || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", `${this.agentTag(a)} - `) +
				theme.fg("muted", t),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.text || "", 0, 0);

			const tag = this.agentTag(d.agent || "?");

			if (options.isPartial || d.status === "dispatching") {
				return new Text(
					theme.fg("accent", `${tag} - working...`),
					0, 0,
				);
			}

			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			const elapsed = typeof d.elapsed === "number" ? Math.round(d.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${tag} - ${elapsed}s`);

			if (options.expanded && d.fullOutput) {
				return new Text(header + "\n" + theme.fg("muted", d.fullOutput), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});
}

export function registerCommands(pi: ExtensionAPI, team: AgentTeamContext) {
	pi.registerCommand("agents-team", {
		description: "Select a team",
		handler: async (_args, ctx) => {
			team.wCtx = ctx;
			const names = Object.keys(team.teams);
			if (!names.length) { ctx.ui.notify("No teams defined", "warning"); return; }

			const opts = names.map(n => {
				const m = team.teams[n].map(t => displayName(t.name)).join(", ");
				return `${n} - ${m}`;
			});

			const choice = await ctx.ui.select("Select Team", opts);
			if (choice === undefined) return;

			const name = names[opts.indexOf(choice)];
			await team.activateTeam(name);
			team.invalidate();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${team.procs.size})`);
			ctx.ui.notify(`Team: ${name} - ${Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List agents + process status",
		handler: async (_args, ctx) => {
			team.wCtx = ctx;
			const list = Array.from(team.procs.values())
				.map(a => {
					const alive = a.proc ? "alive" : "dead";
					return `${displayName(a.def.name)} [${a.status}|${alive}|runs:${a.runCount}] ${a.def.description}`;
				})
				.join("\n");
			ctx.ui.notify(list || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({ value: n, label: `${n} columns` }));
			const f = items.filter(i => i.value.startsWith(prefix));
			return f.length ? f : items;
		},
		handler: async (args, ctx) => {
			team.wCtx = ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				team.gridCols = n;
				team.persist();
				ctx.ui.notify(`Grid: ${team.gridCols} columns`, "info");
				team.invalidate();
			} else {
				ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	pi.registerCommand("agents-team-toggle", {
		description: "Enable/disable agent team (on/off/status)",
		handler: async (args, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
			if (sub === "on") {
				await team.enableAgentTeam(ctx);
				const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
				await ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members}) — agents spawn on-demand`);
			} else if (sub === "off") {
				await team.disableAgentTeam(ctx);
				await ctx.ui.notify("✓ Agent team disabled - all subagent processes killed");
			} else if (sub === "status") {
				await ctx.ui.notify(team.enabled ? "Agent team is enabled" : "Agent team is disabled");
			} else {
				await ctx.ui.notify("Usage: /agents-team-toggle on|off|status");
			}
		},
	});

	pi.registerCommand("agents-restart", {
		description: "Kill any running subagent processes",
		handler: async (_args, ctx) => {
			team.wCtx = ctx;
			if (!team.enabled) { ctx.ui.notify("Agent team is disabled. Use /agents-team-toggle on", "warning"); return; }
			ctx.ui.notify("Killing all running subagent processes...", "info");
			await team.killAll();
			ctx.ui.notify("All subagent processes killed", "success");
			team.invalidate();
		},
	});
}

export function registerShortcut(pi: ExtensionAPI, team: AgentTeamContext) {
	pi.registerShortcut("ctrl+q", {
		description: "Toggle agent team on/off",
		handler: async (ctx) => {
			team.wCtx = ctx;
			if (team.enabled) {
				await team.disableAgentTeam(ctx);
				ctx.ui.notify("✓ Agent team disabled", "info");
			} else {
				await team.enableAgentTeam(ctx);
				const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
				ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
				ctx.ui.notify(`✓ Agent team enabled — Team: ${team.activeTeam} (${members})`, "info");
			}
		},
	});
}
