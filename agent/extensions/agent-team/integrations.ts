// ── Integrations: tool registration + slash commands + shortcut ──

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { AgentTeamContext, BatchTaskResult } from "./core";
import { displayName, shortModel } from "./core";
import { MAX_RESPONSE_LENGTH } from "./orchestration";
import { toggleSidebar } from "./ui";

/** Truncate a subagent output to the tool-result cap (keeps the tail). */
function capOutput(out: string): string {
  return out.length > MAX_RESPONSE_LENGTH ? out.slice(-MAX_RESPONSE_LENGTH) : out;
}

/** Format batch results as markdown sections joined by "---". `includeAgent`
 *  adds the agent name to the section header (dispatch_agents spans multiple
 *  agents; dispatch_agent's multi-task mode always reports one). Sets
 *  `anyFail` when any result exited non-zero. Shared by both dispatch tools.
 *
 *  Individual outputs are capped at MAX_RESPONSE_LENGTH, but when many
 *  subagents run in parallel the combined text can still be N× that limit.
 *  An overall cap (with a clear truncation marker) prevents the downstream
 *  orchestrator from receiving a silently-truncated result. */
function formatBatchParts(results: BatchTaskResult[], includeAgent: boolean): { text: string; anyFail: boolean } {
  let anyFail = false;

  // Build parts one at a time, tracking total size so we can stop before
  // the combined output exceeds the cap. Always include at least the first
  // result; subsequent results are added only if there is headroom.
  let combined = "";
  let included = 0;
  for (const res of results) {
    if (res.code !== 0) anyFail = true;
    const status = res.code === 0 ? "done" : "error";
    const header = includeAgent ? `### ${res.agent}\n${res.task}` : `### ${res.task}`;
    const part = `${header}\n→ ${status} (${Math.round(res.elapsed / 1000)}s)\n\n${capOutput(res.output)}`;
    const separator = included > 0 ? "\n\n---\n\n" : "";
    if (combined.length + separator.length + part.length > MAX_RESPONSE_LENGTH && included > 0) {
      const remaining = results.length - included;
      combined += `\n\n---\n\n… [${remaining} more result(s) truncated — combined output exceeded ${MAX_RESPONSE_LENGTH} chars]`;
      break;
    }
    combined += separator + part;
    included++;
  }

  return { text: combined, anyFail };
}

/** Get agent display info: [name][model] tag */
function agentTag(team: AgentTeamContext, name: string): string {
  const apRef = team.procs.get(name.toLowerCase());
  return `[${name}][${apRef ? shortModel(apRef.model) : "?"}]`;
}

export function registerDispatchAgentTool(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: "Delegate one independent task to a specialist in a fresh isolated process. The worker sees no orchestrator context, other workers, or unsaved reasoning, so include objective, scope, relevant paths/symbols and snippets, constraints, acceptance criteria, and an explicit output format with status, evidence, errors, and uncertainty. Use one consolidated dispatch for related writable edits; never overlap writes. For large generated files, provide a path and specification rather than pasting the entire file.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (case-insensitive)" }),
      task: Type.String({ description: "Task description for the agent. Use this OR `tasks`." }),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Multiple task descriptions for the SAME agent — spawns one isolated subagent per task (parallel for read-only agents, serialized for writable ones). When dispatching multiple instances of the same agent partition the work (URLs, queries, files) so each task is distinct to avoid duplicate work. For writable agents prefer a single consolidated `task` over many small `tasks` — they run serialized with a cold start each. Use instead of `task`." })),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      const { agent, task, tasks } = params as { agent: string; task?: string; tasks?: string[] };
      if (!team.enabled) return {
        content: [{ type: "text", text: "Agent team is disabled. /agents-team-toggle on" }],
        details: {},
      };

      const multi = Array.isArray(tasks) && tasks.length > 0;
      const single = typeof task === "string" && task.trim().length > 0;
      if (!multi && !single) {
        return {
          content: [{ type: "text", text: "dispatch_agent requires either `task` (string) or non-empty `tasks` (array of strings for the same agent)." }],
          details: {},
        };
      }

      // Listen for ESC / abort signal — kill the shared team-member proc
      // if this is a single dispatch. Multi-task clones are aborted via the
      // signal passed to dispatchAgentMany, which scopes termination to
      // only the clones it created for this call.
      let abortHandler: (() => void) | undefined;
      try {
        const tag = agentTag(team, agent);

        onUpdate?.({
          content: [{ type: "text", text: `${tag} - ${multi ? `dispatching ${tasks!.length} task(s)...` : "dispatching..."}` }],
          details: { agent, task, tasks, status: "dispatching", multi },
        });

        if (signal) {
          const capturedAp = team.procs.get(agent.toLowerCase());
          abortHandler = () => {
            if (capturedAp && (capturedAp.status === "running" || capturedAp.status === "starting")) {
              team.logger.logErrorBox(capturedAp, "ABORTED", "User pressed ESC");
              team.killProc(capturedAp, true);
              team.wipeSessionFile(capturedAp);
              capturedAp.status = "dead";
              team.invalidate();
            }
          };
          signal.addEventListener("abort", abortHandler);
        }

        // Normalize to an aggregated batch result so single + multi
        // paths share one formatting/truncation path below.
        let aggregate: { ok: boolean; error?: string; results: Array<{ agent: string; task: string; output: string; code: number; elapsed: number; error: string | null }> };
        if (multi) {
          const r = await team.dispatchAgentMany(agent, tasks as string[], signal);
          if (!r.ok) {
            if (team.wCtx) team.wCtx.ui.notify(`${tag} rejected`, "error");
            return {
              content: [{ type: "text", text: `dispatch_agent rejected: ${r.error}` }],
              details: { agent, tasks, status: "error", error: r.error },
            };
          }
          aggregate = r;
        } else {
          const r = await team.dispatch(agent, task as string);
          aggregate = { ok: true, results: [{ agent, task: task as string, output: r.output, code: r.code, elapsed: r.elapsed, error: null }] };
        }

        const batch = multi
          ? formatBatchParts(aggregate.results, false)
          : { text: "", anyFail: aggregate.results.some(r => r.code !== 0) };
        const anyFail = batch.anyFail;

        const finalOutput = multi ? batch.text : (() => {
          let o = aggregate.results[0].output;
          if (o.length > MAX_RESPONSE_LENGTH) o = `... [truncated to last ${MAX_RESPONSE_LENGTH} chars]\n` + o.slice(-MAX_RESPONSE_LENGTH);
          return o;
        })();

        const totalElapsed = aggregate.results.reduce((s, r) => s + r.elapsed, 0);
        const status = anyFail ? "error" : "done";
        const summary = `${tag} - ${status} in ${Math.round(totalElapsed / 1000)}s`;

        if (anyFail && team.wCtx) team.wCtx.ui.notify(summary, "error");

        return {
          content: [{ type: "text", text: finalOutput }],
          details: { agent, task: single ? task : undefined, tasks: multi ? tasks : undefined, status, elapsed: totalElapsed, exitCode: anyFail ? 1 : 0, multi, fullOutput: finalOutput, results: multi ? aggregate.results : undefined },
        };
      } catch (err: any) {
        if (team.wCtx) team.wCtx.ui.notify(`[${agent}] Error: ${err?.message || err}`, "error");
        return {
          content: [{ type: "text", text: `Error dispatching ${agent}: ${err?.message || err}. The orchestrator should inform the user.` }],
          details: { agent, task, tasks, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
        };
      } finally {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    },

    renderCall(args, theme) {
      const a = (args as any).agent || "?";
      const t = (args as any).task || "";
      const tasksArr = (args as any).tasks;
      const multiLabel = Array.isArray(tasksArr) && tasksArr.length > 1 ? ` (${tasksArr.length} tasks)` : "";
      const text = t || (Array.isArray(tasksArr) ? `${tasksArr.length} task(s)` : "");
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
        theme.fg("accent", `${agentTag(team, a)}${multiLabel} - `) +
        theme.fg("muted", text),
        0, 0,
      );
    },

    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);

      const tag = agentTag(team, d.agent || "?");

      if (options.isPartial || d.status === "dispatching") {
        return new Text(
          theme.fg("accent", `${tag} - working...`),
          0, 0,
        );
      }

      if (d.multi && d.results) {
        const n = d.results.length;
        const fails = d.results.filter((r: any) => r.code !== 0).length;
        const ok = d.status === "done" && fails === 0;
        const elapsed = typeof d.elapsed === "number" ? Math.round(d.elapsed / 1000) : 0;
        const header = theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} ${tag} - ${n} task(s)${fails ? `, ${fails} failed` : ""} (${elapsed}s)`);
        if (options.expanded && d.fullOutput) {
          return new Text(header + "\n" + theme.fg("muted", d.fullOutput), 0, 0);
        }
        return new Text(header, 0, 0);
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

export function registerDispatchAgentsTool(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerTool({
    name: "dispatch_agents",
    label: "Dispatch Agents (parallel, read-only)",
    description:
      "Run independent READ-ONLY tasks concurrently and return every result labeled by agent and task. " +
      "Each task must have a distinct non-overlapping scope and include objective, context, acceptance criteria, and output/evidence requirements. " +
      "Only read-only agents are allowed; writable agents must use dispatch_agent and must never overlap file mutations. " +
      "Treat non-zero exits, timeouts, empty/malformed output, and BLOCKED results as failures surfaced to the orchestrator.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: "Agent name (case-insensitive)" }),
          task: Type.String({ description: "Task description for the agent" }),
        }),
        { description: "Independent read-only lookups to run concurrently." },
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      const { tasks } = params as { tasks: Array<{ agent: string; task: string }> };
      if (!team.enabled) {
        return { content: [{ type: "text", text: "Agent team is disabled. /agents-team-toggle on" }], details: {} };
      }
      if (!team.parallelDispatch) {
        return {
          content: [{
            type: "text",
            text: "Parallel dispatch is disabled. Enable with /agents-parallel on, or use dispatch_agent for each agent.",
          }],
          details: {},
        };
      }
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "dispatch_agents requires a non-empty `tasks` array of {agent, task}." }],
          details: {},
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `dispatch_agents - dispatching ${tasks.length} read-only task(s) in parallel...` }],
        details: { count: tasks.length, status: "dispatching" },
      });

      const r = await team.dispatchMany(tasks, signal);

      if (!r.ok) {
        if (team.wCtx) team.wCtx.ui.notify(`dispatch_agents rejected`, "error");
        return {
          content: [{ type: "text", text: `dispatch_agents rejected: ${r.error}` }],
          details: { status: "error", error: r.error },
        };
      }

      const { text: combined, anyFail } = formatBatchParts(r.results, true);

      return {
        content: [{ type: "text", text: combined }],
        details: { status: anyFail ? "error" : "done", results: r.results, fullOutput: combined },
      };
    },

    renderCall(args, theme) {
      const list = (args as any).tasks || [];
      const names = list.map((t: any) => t.agent).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("dispatch_agents ")) +
        theme.fg("accent", `(${list.length}) `) +
        theme.fg("muted", names),
        0, 0,
      );
    },

    renderResult(result, options, theme) {
      const d = result.details as any;
      if (!d) return new Text((result.content[0] as any)?.text || "", 0, 0);
      if (options.isPartial || d.status === "dispatching") {
        return new Text(theme.fg("accent", `dispatch_agents - working...`), 0, 0);
      }
      const n = d.results?.length ?? 0;
      const fails = d.results?.filter((r: any) => r.code !== 0).length ?? 0;
      const ok = d.status === "done" && fails === 0;
      return new Text(
        theme.fg(ok ? "success" : "error", `${ok ? "✓" : "✗"} dispatch_agents - ${n} task(s)${fails ? `, ${fails} failed` : ""}`),
        0, 0,
      );
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

  pi.registerCommand("agents-parallel", {
    description: "Toggle GLOBAL parallelism (subagent dispatch + host tool calls): /agents-parallel [on|off|status] [max N]",
    handler: async (args, ctx) => {
      team.wCtx = ctx;
      const tokens = (args?.trim().split(/\s+/).filter(Boolean) ?? []).map(t => t.toLowerCase());
      let changed = false;
      let note = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "on") { team.parallelDispatch = true; changed = true; }
        else if (t === "off") { team.parallelDispatch = false; changed = true; }
        else if (t === "status") { /* report only */ }
        else if (t === "max") {
          const n = parseInt(tokens[++i] ?? "", 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else if (t.startsWith("max=")) {
          const n = parseInt(t.slice(4), 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) { team.maxParallel = n; changed = true; }
          else note += "Invalid max (1-20). ";
        } else {
          note += `Unknown arg "${t}". `;
        }
      }
      if (changed) {
        team.persist();
        pi.setActiveTools(team.activeToolList());
        team.invalidate();
      }
      const mode = team.parallelDispatch ? "ON" : "OFF";
      ctx.ui.notify(
        `${note}Parallelism: ${mode} — covers subagent dispatch AND host tool calls (read/grep/find/ls); writes always serialized.${changed ? ` Max ${team.maxParallel} concurrent read-only subagents.` : ""}`,
        "info",
      );
    },
  });
}


export function registerShortcut(pi: ExtensionAPI, team: AgentTeamContext) {
  pi.registerShortcut("ctrl+q", {
    description: "Toggle agent team sidebar",
    handler: async (ctx) => {
      if (!team.enabled) return;
      team.wCtx = ctx;
      toggleSidebar(team);
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
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
