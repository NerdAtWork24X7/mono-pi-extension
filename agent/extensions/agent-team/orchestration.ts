// ── Orchestration: process manager + dispatch + RPC handlers ──

import { unlinkSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentProc } from "./core";
import type { SessionLogger } from "./core";
import { spawnRpcSubprocess, type RpcSubprocess } from "./core";
import { agentKey, clearTimers, resetForDispatch, blankProcState, displayName, extractLastLine, isWritable, hasPiScopeExtension, parseModelId, filterSkills, MAX_COLLECTED_TEXT, type BatchDispatchResult, type BatchTaskResult, type AgentDef } from "./core";
import type { AgentTeamContext } from "./core";
import { resolveSkillPath } from "./config";

const KILLALL_TIMEOUT_MS = 5_000;
const SPAWN_READY_TIMEOUT_MS = 15_000;
/** Minimum time between streaming-token UI invalidations. Prevents render
 *  thrashing when a subagent emits many rapid text_delta events. */
const STREAM_INVALIDATE_THROTTLE_MS = 100;

export const MAX_RESPONSE_LENGTH = 20000; // Subagent tool-result cap. Keep the marker string in dispatch_agent in sync.
export const PONG_TIMEOUT = 600_000;  // 10 min — reset on every activity

// Map of event type → log message formatter for simple delegation
const simpleLogEvents: Record<string, (ev: any) => string> = {
	compaction_end: (ev) => ev.aborted ? `COMPACT aborted` : `COMPACT done (${ev.reason || "auto"})`,
	auto_retry_start: (ev) => `AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`,
	auto_retry_end: (ev) => `AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`,
};

/** Signal returned to the orchestrator when a subagent auto-compacts.
 *  The orchestrator should split the task into smaller pieces. */
const TASK_TOO_LARGE_SIGNAL = "TASK_TOO_LARGE: subagent context grew too large and auto-compacted. Split this task into smaller pieces and re-dispatch.";

export function handleEvent(ctx: AgentTeamContext, ap: AgentProc, line: string) {
	let ev: any;
	try { ev = JSON.parse(line); } catch { return; }

	if (ap.status === "running") {
		ap.lastActivity = Date.now();
		ap.resetPongTimeout?.();
	}

	switch (ev.type) {
		case "response": return handleResponse(ctx, ap, ev);
		case "message_update": return handleMessageUpdate(ctx, ap, ev);
		case "message_end": return handleMessageEnd(ctx, ap, ev);
		case "tool_execution_start": return handleToolStart(ctx, ap, ev);
		case "tool_execution_end": return handleToolEnd(ctx, ap, ev);
		case "agent_end": return handleAgentEnd(ctx, ap, ev);
		case "extension_ui_request": return autoRespondUI(ap, ev);
		case "compaction_start": return handleCompactionStart(ctx, ap, ev);
		default: {
			const fmt = simpleLogEvents[ev.type];
			if (fmt) ctx.logger.log(fmt(ev), ap);
		}
	}
}

/** Auto-compaction in a subagent means the task is too large for its context
 *  window. End the subagent immediately and return a signal so the orchestrator
 *  can split the task into smaller pieces. */
function handleCompactionStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	// Ignore duplicate compaction events after we've already terminated.
	if (ap.autoCompacted) return;
	const reason = ev.reason || "auto";
	// Manual compacts are intentional; only abort on automatic compactions.
	if (reason === "manual") {
		ctx.logger.log(`COMPACT start (reason: manual)`, ap);
		return;
	}
	ap.autoCompacted = true;
	ctx.logger.logErrorBox(ap, "AUTO-COMPACT", "subagent context grew too large — ending dispatch");
	ctx.resolveIfPending(ap, TASK_TOO_LARGE_SIGNAL, 1);
	ctx.killProc(ap, true);
	if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, "auto-compacted — task too large"), "warning");
	ctx.invalidate();
}

export function handleResponse(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	if (!ap.ready) {
		// Only accept the readiness probe when it succeeded. The get_state
		// response arrives while status is "starting", so the error branch
		// below (which checks "running") would otherwise never fire.
		if (ev.success) {
			ap.ready = true;
			ap.status = "idle";
			// Clear the spawn-readiness timeout — ready flipped to true via
			// the probe response, not the timeout. This closes the race where
			// the timeout fires just after the probe resolves.
			if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
			if (ev.data?.model?.contextWindow) {
				ap.contextWindow = ev.data.model.contextWindow;
			}
		} else {
			const errMsg = ev.error || `${ev.command} failed`;
			ctx.logger.logErrorBox(ap, "READY PROBE FAILED", errMsg);
			if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
		}
		ctx.invalidate();
		if (ap.readyResolve) { ap.readyResolve(ev.success === true); ap.readyResolve = null; }
	}
	// Capture a successful response's result text as a fallback completion
	// payload. Some hosts return the final answer only in the `response`
	// event (not via message streaming). Resolution still happens on
	// agent_end (fix 1) or process close (fix 2); this only enriches the
	// captured text those paths return.
	if (ev.success && ap.status === "running") {
		const resultText =
			typeof ev.data === "string" ? ev.data
				: (ev.data?.result?.text ?? ev.data?.text ?? ev.data?.content ?? "");
		if (resultText && !ap.lastAssistantText) ap.lastAssistantText = String(resultText);
	}

	if (!ev.success && ap.status === "running" && ap.resolveDispatch) {
		const errMsg = ev.error || `${ev.command} failed`;
		ctx.logger.logErrorBox(ap, "PROMPT ERROR", errMsg);
		ap.lastWork = `Error: ${errMsg}`;
		ap.status = "error";
		ctx.invalidate();
		ctx.resolveIfPending(ap, errMsg, 1);
	}
}

/** Per-agent streaming invalidation timestamps. Using a WeakMap keeps the
 *  AgentProc interface unchanged and avoids cross-agent update suppression. */
const lastStreamInvalidate = new WeakMap<AgentProc, number>();

export function handleMessageUpdate(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	const delta = ev.assistantMessageEvent;
	if (delta?.type !== "text_delta") return;
	const chunk = delta.delta || "";
	ap.collectedText += chunk;
	ap.currentMessageText += chunk;
	// Cap collectedText to prevent unbounded memory growth during long streams.
	// The lastAssistantText (set on message_end) is the authoritative output;
	// collectedText is only a fallback for process-close edge cases.
	if (ap.collectedText.length > MAX_COLLECTED_TEXT) {
		ap.collectedText = ap.collectedText.slice(-MAX_COLLECTED_TEXT);
	}
	ctx.logger.logStreamingText(ap, chunk);
	const lastNl = chunk.lastIndexOf("\n");
	const tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
	if (tail.trim()) ap.lastWork = tail.slice(0, 80);
	// Throttle UI invalidation during streaming to avoid burning CPU on every
	// token. The final state is still rendered on message_end / agent_end.
	const now = Date.now();
	const last = lastStreamInvalidate.get(ap) ?? 0;
	if (now - last > STREAM_INVALIDATE_THROTTLE_MS) {
		lastStreamInvalidate.set(ap, now);
		ctx.invalidate();
	}
}

export function handleMessageEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	if (ev.message?.role !== "assistant") return;
	const u = ev.message.usage;
	if (u) {
		const dispatchTokensOut = u.output || 0;
		ap.cacheRead = u.cacheRead || 0;
		ap.cacheWrite = u.cacheWrite || 0;
		ap.cacheSavedTotal += ap.cacheRead;
		let dispatchTokensUsed = u.input || 0;
		if (u.totalTokens) {
			const derived = u.totalTokens - dispatchTokensOut - ap.cacheRead - ap.cacheWrite;
			dispatchTokensUsed = u.input || (derived > 0 ? derived : u.totalTokens - dispatchTokensOut);
		}
		ap.tokensOut += dispatchTokensOut;
		ap.tokensUsed += dispatchTokensUsed;
	}
	ctx.logger.flushStreamBuf(ap);
	if (ap.currentMessageText.trim()) ap.lastAssistantText = ap.currentMessageText;
	ap.currentMessageText = "";
	ctx.invalidate();
}

/** Format a single tool-call argument for the log line. Strings are sliced to
 *  80 chars; arrays/objects become compact JSON. Null/undefined/empty values
 *  are skipped so a tool never renders with a dangling `=`. */
function fmtToolArg(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v.trim() ? v.slice(0, 80) : "";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	// objects / arrays → compact JSON (skip empty containers)
	try {
		const s = JSON.stringify(v);
		return s && s !== "[]" && s !== "{}" ? s.slice(0, 80) : "";
	} catch {
		return String(v).slice(0, 80);
	}
}

export function handleToolStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	ap.toolCount++;
	let detail = "";
	let args: unknown = ev.args;
	// Some hosts serialize args as a JSON string rather than an object.
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { /* keep the raw string */ }
	}
	if (args && typeof args === "object" && !Array.isArray(args)) {
		detail = Object.entries(args as Record<string, unknown>)
			.map(([k, v]) => {
				const s = fmtToolArg(v);
				return s ? `${k}=${s}` : "";
			})
			.filter(Boolean)
			.join(" ");
	} else if (Array.isArray(args)) {
		detail = (args as unknown[]).map(fmtToolArg).filter(Boolean).join(" ");
	} else if (typeof args === "string" && args.trim()) {
		detail = args.slice(0, 80);
	}
	// Never render a bare tool name: a call with no visible args is still
	// meaningful, and a blank detail reads as a logging bug.
	ctx.logger.logToolStart(ap, ev.toolName, detail || "(no args)");
	ctx.invalidate();
}

export function handleToolEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	ctx.logger.logToolEnd(ap, ev.toolName, !ev.isError, ev.durationMs);
	// The ✓/✗ + duration update rewrites the tool-start line in place; make
	// sure the TUI repaints it instead of waiting for the next event.
	ctx.invalidate();
}

export function handleAgentEnd(ctx: AgentTeamContext, ap: AgentProc, _ev: any) {
	// If we already terminated the subagent because it auto-compacted, ignore
	// any late agent_end event and don't overwrite the TASK_TOO_LARGE signal.
	if (ap.autoCompacted) return;
	clearInterval(ap.timer);
	ctx.logger.flushStreamBuf(ap);

	const output = ap.lastAssistantText
		|| ap.currentMessageText.trim()
		|| ap.collectedText.trim()
		|| "(no output)";

	ctx.logger.logDoneBox(ap, Math.round(ap.elapsed / 1000), ap.toolCount);
	ap.status = "done";
	ap.lastWork = extractLastLine(output);

	ap.collectedText = "";
	ap.currentMessageText = "";
	ap.lastAssistantText = "";

	ctx.invalidate();

	if (ctx.wCtx) {
		ctx.wCtx.ui.notify(
			ctx.tag(ap, `done (${Math.round(ap.elapsed / 1000)}s, ${ap.toolCount} tools)`),
			"success",
		);
	}

	ctx.resolveIfPending(ap, output, 0);
}

export function autoRespondUI(ap: AgentProc, ev: any) {
	if (!ap.proc) return;
	const stdin = ap.proc.stdin;
	if (!stdin?.writable) return;
	const { id, method } = ev;

	// Fire-and-forget methods
	if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method)) return;

	// Dialog methods: auto-respond
	let resp: any;
	if (method === "confirm") {
		resp = { type: "extension_ui_response", id, confirmed: true };
	} else if (method === "select" && ev.options?.length > 0) {
		resp = { type: "extension_ui_response", id, value: ev.options[0] };
	} else {
		resp = { type: "extension_ui_response", id, cancelled: true };
	}
	try { stdin.write(JSON.stringify(resp) + "\n"); } catch { }
}

export async function dispatch(
	ctx: AgentTeamContext,
	agentName: string,
	task: string,
): Promise<{ output: string; code: number; elapsed: number }> {
	const ap = ctx.procs.get(agentName.toLowerCase());
	if (!ap) {
		const available = Array.from(ctx.procs.values()).map(a => displayName(a.def.name)).join(", ");
		return { output: `Agent "${agentName}" not found. Available: ${available}`, code: 1, elapsed: 0 };
	}
	// Check if agent is disabled by user
	if (ctx.disabledAgents.has(agentName.toLowerCase())) {
		return { output: `Agent "${agentName}" is disabled. Enable it from the sidebar (Ctrl+Q).`, code: 1, elapsed: 0 };
	}
	// Read-only agents run concurrently under the read lock; writable agents
	// (any allowlist containing a destructive tool) take the exclusive write
	// lock so writes/edits are NEVER parallel. serializeAgent guards the shared
	// AgentProc so two concurrent dispatches to the SAME agent can't clobber
	// each other's mutable run state.
	const writable = isWritable(ap.def, ctx.destructiveTools);
	return ctx.serializeAgent(agentName.toLowerCase(), () =>
		writable
			? ctx.dispatchLock.write(() => runAgent(ctx, ap, task))
			: ctx.dispatchLock.read(() => runAgent(ctx, ap, task)),
	);
}

/** Run a single subagent to completion. Safe to call concurrently for distinct
 *  AgentProc instances (ephemeral clones or different team members). Callers
 *  are responsible for locking (see `dispatch` / `dispatchMany`). */
export async function runAgent(
	ctx: AgentTeamContext,
	ap: AgentProc,
	task: string,
): Promise<{ output: string; code: number; elapsed: number }> {
	ctx.wipeSessionFile(ap);

	// Spawn fresh process for this task
	ap.status = "dead";
	const started = await ctx.spawnProc(ap);
	if (!started) {
		return { output: `${displayName(ap.def.name)} failed to start.`, code: 1, elapsed: 0 };
	}

	if (!ap.ready || !ap.proc) {
		return { output: `${displayName(ap.def.name)} not ready.`, code: 1, elapsed: 0 };
	}

	// Start dispatch
	ap.status = "running";
	ap.task = task;
	ap.toolCount = 0;
	ap.elapsed = 0;
	ap.tokensUsed = 0;
	ap.tokensOut = 0;
	ap.cacheRead = 0;
	ap.cacheWrite = 0;
	ap.lastWork = "";
	ap.runCount++;
	ap.lastActivity = Date.now();
	ctx.invalidate();

	const t0 = Date.now();
	ap.timer = setInterval(() => {
		ap.elapsed = Date.now() - t0;
		ctx.invalidate();
	}, 500);

	// ── Activity-based timeout ──
	// Resets on every RPC event (streaming, tool calls, responses, etc.)
	// If 10 min passes with no activity → stuck → kill
	const doResetPongTimeout = () => {
		if (ap.dispatchTimeout) clearTimeout(ap.dispatchTimeout);
		ap.dispatchTimeout = setTimeout(() => {
			const silence = Math.round((Date.now() - ap.lastActivity) / 1000);
			ctx.logger.logErrorBox(ap, "NO ACTIVITY", `no event for ${silence}s — force-killing`);
			ap.lastWork = `Timed out (${silence}s silence)`;
			ctx.resolveIfPending(ap, `No activity for ${silence}s — killed`, 1);
			ctx.killProc(ap, true);
			if (ctx.wCtx) ctx.wCtx.ui.notify(ctx.tag(ap, `NO ACTIVITY (${silence}s) — killed`), "error");
			ctx.invalidate();
		}, PONG_TIMEOUT);
	};
	ap.resetPongTimeout = doResetPongTimeout;

	doResetPongTimeout(); // start initial 10-min timer

	ctx.logger.logTaskBox(ap, ap.runCount, task);

	const cmdPayload = { type: "prompt", message: task };
	const failDispatch = (msg: string): { output: string; code: number; elapsed: number } => {
		if (ap.timer) { clearInterval(ap.timer); ap.timer = undefined; }
		if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
		ap.resetPongTimeout = undefined;
		ap.resolveDispatch = null;
		ap.status = "error";
		ctx.invalidate();
		return { output: msg, code: 1, elapsed: 0 };
	};
	try {
		if (!ap.proc?.stdin?.writable) {
			return failDispatch(`Process died before task could be sent`);
		}
		ap.proc.stdin.write(JSON.stringify(cmdPayload) + "\n");
	} catch (err: any) {
		return failDispatch(`Write error: ${err.message}`);
	}

	const result = await new Promise<{ output: string; code: number; elapsed: number }>((resolve) => {
		ap.resolveDispatch = (output, code) => {
			// Clear timeout immediately to prevent race with normal completion
			if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
			resolve({ output, code, elapsed: ap.elapsed });
		};
	});

	// Task complete — kill the subagent process but KEEP the terminal pane alive
	// so the user can scroll back and see what the agent did.
	// The pane will be reused on the next dispatch (same agent = same pane).
	ctx.killProc(ap, true);

	ctx.wipeSessionFile(ap);

	ap.status = "dead";
	ctx.invalidate();

	return result;
}

/** Build an ephemeral AgentProc clone for a concurrent/parallel run. Clones do
 *  NOT touch the shared team-member AgentProc (which drives the widget), and
 *  carry a unique `runId` so their session/prompt files never collide. */
function makeClone(ctx: AgentTeamContext, def: AgentDef, model: string, teamModel: string | undefined, runId: string): AgentProc {
	return {
		def,
		teamModel,
		model,
		runId,
		...blankProcState(),
	};
}

/** Run many read-only agents concurrently (capped at `maxParallel`), each in
 *  its own subprocess. Returns aggregated per-task results. */
export async function dispatchMany(
	ctx: AgentTeamContext,
	tasks: Array<{ agent: string; task: string }>,
	signal?: AbortSignal,
): Promise<BatchDispatchResult> {
	// Validate: every task must resolve to a known, READ-ONLY agent. Writable
	// agents are rejected wholesale — they must go through dispatch_agent and
	// are always serialized, never parallel.
	const resolved: Array<{ name: string; def: AgentDef; model: string; teamModel: string | undefined; task: string }> = [];
	for (const t of tasks) {
		const ap = ctx.procs.get(t.agent.toLowerCase());
		if (!ap) {
			const available = Array.from(ctx.procs.values()).map(a => displayName(a.def.name)).join(", ");
			return { ok: false, error: `Agent "${t.agent}" not found. Available: ${available}`, results: [] };
		}
		// Check if agent is disabled by user
		if (ctx.disabledAgents.has(t.agent.toLowerCase())) {
			return { ok: false, error: `Agent "${t.agent}" is disabled. Enable it from the sidebar (Ctrl+Q).`, results: [] };
		}
		if (isWritable(ap.def, ctx.destructiveTools)) {
			return {
				ok: false,
				error: `Agent "${t.agent}" can write/edit files and must be dispatched via dispatch_agent (single, serialized) — never inside dispatch_agents. Move it out of the batch.`,
				results: [],
			};
		}
		resolved.push({ name: t.agent, def: ap.def, model: ap.model, teamModel: ap.teamModel, task: t.task });
	}

	if (signal?.aborted) {
		return { ok: false, error: "Aborted", results: [] };
	}

	const results: BatchTaskResult[] = new Array(resolved.length);
	let cursor = 0;
	const localClones: AgentProc[] = [];

	const onAbort = () => {
		for (const ap of localClones) {
			if (ap.status === "running" || ap.status === "starting") {
				ctx.killProc(ap, true);
				ctx.wipeSessionFile(ap);
				ap.status = "dead";
				ctx.invalidate();
			}
		}
	};
	signal?.addEventListener("abort", onAbort);

	const runOne = async (idx: number) => {
		const it = resolved[idx];
		const ap = makeClone(ctx, it.def, it.model, it.teamModel, `${it.name}-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		localClones.push(ap);
		ctx.batchClones.add(ap);
		try {
			const r = await runAgent(ctx, ap, it.task);
			results[idx] = { agent: it.name, task: it.task, output: r.output, code: r.code, elapsed: r.elapsed, error: null };
		} catch (e: any) {
			results[idx] = { agent: it.name, task: it.task, output: String(e?.message || e), code: 1, elapsed: 0, error: String(e?.message || e) };
		} finally {
			ctx.batchClones.delete(ap);
		}
	};
	const worker = async () => {
		let i: number;
		while ((i = cursor++) < resolved.length) await runOne(i);
	};
	const max = Math.max(1, Math.min(ctx.maxParallel || 5, resolved.length));
	// All read-only → run under the shared read lock so they stay exclusive
	// against any in-flight writable (write-locked) dispatch.
	return ctx.dispatchLock.read(async () => {
		try {
			if (signal?.aborted) return { ok: false, error: "Aborted", results: [] };
			await Promise.all(Array.from({ length: max }, worker));
			return { ok: true, results };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	});
}

/** Run the SAME agent across many tasks, each in its own isolated clone
 *  subprocess (never the shared team-member AgentProc). Read-only agents run
 *  concurrently (capped at maxParallel, or 1 when parallel dispatch is off);
 *  writable agents (edit/write) are always serialized under the write lock. */
export async function dispatchAgentMany(
	ctx: AgentTeamContext,
	agentName: string,
	tasks: string[],
	signal?: AbortSignal,
): Promise<BatchDispatchResult> {
	const ap = ctx.procs.get(agentName.toLowerCase());
	if (!ap) {
		const available = Array.from(ctx.procs.values()).map(a => displayName(a.def.name)).join(", ");
		return { ok: false, error: `Agent "${agentName}" not found. Available: ${available}`, results: [] };
	}
	// Check if agent is disabled by user
	if (ctx.disabledAgents.has(agentName.toLowerCase())) {
		return { ok: false, error: `Agent "${agentName}" is disabled. Enable it from the sidebar (Ctrl+Q).`, results: [] };
	}
	const writable = isWritable(ap.def, ctx.destructiveTools);

	if (signal?.aborted) {
		return { ok: false, error: "Aborted", results: [] };
	}

	const localClones: AgentProc[] = [];

	const onAbort = () => {
		for (const clone of localClones) {
			if (clone.status === "running" || clone.status === "starting") {
				ctx.killProc(clone, true);
				ctx.wipeSessionFile(clone);
				clone.status = "dead";
				ctx.invalidate();
			}
		}
	};
	signal?.addEventListener("abort", onAbort);

	try {
		const runOne = async (idx: number, t: string): Promise<BatchTaskResult> => {
			const clone = makeClone(ctx, ap.def, ap.model, ap.teamModel, `${agentName}-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
			localClones.push(clone);
			ctx.batchClones.add(clone);
			try {
				const r = await runAgent(ctx, clone, t);
				return { agent: agentName, task: t, output: r.output, code: r.code, elapsed: r.elapsed, error: null };
			} catch (e: any) {
				return { agent: agentName, task: t, output: String(e?.message || e), code: 1, elapsed: 0, error: String(e?.message || e) };
			} finally {
				ctx.batchClones.delete(clone);
			}
		};

		if (writable) {
			// Exclusive write lock; one clone at a time so file mutations never run concurrently.
			return ctx.dispatchLock.write(async () => {
				if (signal?.aborted) return { ok: false, error: "Aborted", results: [] };
				const results: BatchTaskResult[] = [];
				for (let i = 0; i < tasks.length; i++) results.push(await runOne(i, tasks[i]));
				return { ok: true, results };
			});
		}

		// Read-only: concurrent, capped at maxParallel (or 1 when parallel off).
		const results: BatchTaskResult[] = new Array(tasks.length);
		let cursor = 0;
		const worker = async () => {
			let i: number;
			while ((i = cursor++) < tasks.length) results[i] = await runOne(i, tasks[i]);
		};
		const max = ctx.parallelDispatch ? Math.max(1, Math.min(ctx.maxParallel || 5, tasks.length)) : 1;
		return ctx.dispatchLock.read(async () => {
			if (signal?.aborted) return { ok: false, error: "Aborted", results: [] };
			await Promise.all(Array.from({ length: max }, worker));
			return { ok: true, results };
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export async function activateTeam(ctx: AgentTeamContext, name: string) {
	await ctx.killAll();
	ctx.procs.clear();
	ctx.activeTeam = name;
	ctx.catalogDirty = true;

	const members = ctx.teams[name] || [];
	const byName = new Map(ctx.allDefs.map(d => [d.name.toLowerCase(), d]));

	// Clear disabledAgents for this team's members so teams.yaml is the
	// source of truth. Agents from other teams retain their state.
	for (const m of members) {
		const def = byName.get(m.name.toLowerCase());
		if (def) ctx.disabledAgents.delete(def.name.toLowerCase());
	}
	// Now re-add inactive members from teams.yaml
	for (const m of members) {
		const def = byName.get(m.name.toLowerCase());
		if (!def) continue;
		const agentKey = def.name.toLowerCase();
		ctx.procs.set(agentKey, {
			def,
			teamModel: m.model,
			model: m.model || def.model || ctx.orchestratorModel || "",
			...blankProcState(),
		});
		if (m.active === false) {
			ctx.disabledAgents.add(agentKey);
		}
	}
	ctx.persist();
}

export class ProcessManager {
	constructor(
		private sessionDir: () => string,
		private cachedExtPaths: () => string[],
		private orchestratorModel: () => string,
		private logger: SessionLogger,
		private invalidate: () => void,
	) {}

	// ── Resolve helper ──────────────────────────────────────────────

	resolveIfPending(ap: AgentProc, output: string, code: number) {
		if (!ap.resolveDispatch) return;
		const resolve = ap.resolveDispatch;
		ap.resolveDispatch = null;
		clearTimers(ap);
		resolve(output, code);
	}

	/** Safely delete session file if it exists */
	wipeSessionFile(ap: AgentProc) {
		if (ap.sessionFile && existsSync(ap.sessionFile)) {
			try { unlinkSync(ap.sessionFile); } catch { }
		}
	}

	// Write system prompt to temp file (avoids shell escaping issues with multi-line prompts)
	writeSystemPrompt(ap: AgentProc) {
		const content = `${ap.def.systemPrompt}\n\n`;
		if (ap.lastPromptHash === content && ap.systemPromptFile && existsSync(ap.systemPromptFile)) return; // skip if unchanged and file still exists
		ap.lastPromptHash = content;
		const key = agentKey(ap) + (ap.runId ? `-${ap.runId}` : "");
		ap.systemPromptFile = join(this.sessionDir(), `${key}-system-prompt.txt`);
		writeFileSync(ap.systemPromptFile, content);
	}

	cleanSystemPrompt(ap: AgentProc) {
		if (ap.systemPromptFile) {
			try { unlinkSync(ap.systemPromptFile); } catch { }
		}
	}

	killProc(ctx: AgentTeamContext, ap: AgentProc, immediate = false) {
		this.resolveIfPending(ap, ap.status === "running" || ap.status === "starting" ? "Process killed" : "", 1);
		if (ap.procRef) {
			if (immediate) {
				try { ap.procRef.proc.kill("SIGKILL"); } catch { }
			} else {
				// sub.kill() sends SIGTERM and schedules a 2s SIGKILL backstop
				ap.procRef.kill("SIGTERM");
			}
			ap.procRef = null;
		}
		ap.proc = null;
		this.cleanSystemPrompt(ap);
		ap.status = "dead";
		ap.ready = false;
		ap.stdoutBuf = "";
		// sigkillTimeout is no longer used; sub.kill() handles the backstop
		clearTimers(ap);
	}

	async killAll(ctx: AgentTeamContext) {
		const exitPromises: Promise<void>[] = [];
		// Snapshot both team-member procs and active parallel clones so we don't
		// miss any in-flight subprocess if the set is mutated during iteration.
		const allProcs = [...ctx.procs.values(), ...ctx.batchClones];
		for (const ap of allProcs) {
			const dying = ap.proc;
			if (dying) {
				// Skip the wait if the process has already exited — its 'close' event
				// has fired and any listener we attach now would be a no-op.
				const alreadyDead = dying.exitCode !== null || dying.signalCode !== null || dying.killed;
				if (!alreadyDead) {
					exitPromises.push(new Promise<void>(res => {
						const timer = setTimeout(res, KILLALL_TIMEOUT_MS);
						dying.on("close", () => { clearTimeout(timer); res(); });
					}));
				}
			}
			this.killProc(ctx, ap);
		}
		if (exitPromises.length) await Promise.all(exitPromises);
	}

	spawnProc(ctx: AgentTeamContext, ap: AgentProc): Promise<boolean> {
		// Ensure clean slate
		if (ap.proc) this.killProc(ctx, ap);
		resetForDispatch(ap);

		ap.status = "starting";
		ap.sessionFile = join(this.sessionDir(), `${agentKey(ap)}${ap.runId ? `-${ap.runId}` : ""}.json`);

		// Write system prompt to temp file to avoid CLI escaping issues
		this.writeSystemPrompt(ap);

		// Sync model: if agent def has no model, always use current orchestrator model
		const model = ap.teamModel || ap.def.model || this.orchestratorModel() || "google/gemini-2.5-flash";
		ap.model = model;
		const bin = process.platform === "win32" ? "pi.cmd" : "pi";

		// Build args: --no-extensions to block auto-discovery (including agent-team),
		// then explicitly load only non-agent-team extensions via -e.
		// --tools uses the agent's prompt-file tools as the allowlist.

		// Split provider from model if model contains a provider prefix
		const { provider, model: modelName } = parseModelId(model);

		const extPaths = this.cachedExtPaths();

		// Build skill flags: disable global skill discovery and load only the
		// explicit skills from the agent def, or all globally enabled skills if
		// the agent def does not specify a list.
		const skillFlags: string[] = ["--no-skills"];
		const filteredSubSkills = filterSkills(ctx.skillsCache, ctx.subagentSkills);
		const skillNames = ap.def.skills ?? filteredSubSkills.map(s => s.dir);
		for (const skillName of skillNames) {
			const skillPath = resolveSkillPath(skillName);
			if (skillPath) {
				skillFlags.push("--skill", skillPath);
			} else {
				ctx.logger.log(`Unknown skill: ${skillName}`, ap);
			}
		}

		const args = [
			"--mode", "rpc",
			"-p",
			"--no-extensions",
			...extPaths.flatMap(p => ["--extension", p]),
			...skillFlags,
			...(provider ? ["--provider", provider] : []),
			"--model", modelName,
			"--tools", ap.def.tools,
			"--system-prompt", ap.systemPromptFile,
			"--session", ap.sessionFile,
			"--name", ap.def.name,
			...(hasPiScopeExtension(extPaths) ? ["--o-name", ap.def.name] : []),

		];

		const sub = spawnRpcSubprocess({
			bin,
			args,
			logger: ctx.logger,
			owner: ap,
			onLine: (line) => {
				if (ap.proc !== sub.proc) return; // stale process guard
				ctx.handleEvent(ap, line);
			},
			onError: (err) => {
				if (ap.proc !== sub.proc) return; // stale process guard
				ctx.logger.logErrorBox(ap, "PROCESS ERROR", err.message);
				ap.status = "error";
				ap.lastWork = `Error: ${err.message}`;
				this.resolveIfPending(ap, `Process error: ${err.message}`, 1);
				ap.proc = null;
				ap.procRef = null;
			},
			onClose: (code) => {
				if (ap.proc !== sub.proc) return; // stale process guard
				// If we intentionally killed the subagent because it auto-compacted,
				// don't log a scary PROCESS EXIT box and don't overwrite the
				// TASK_TOO_LARGE signal that was already resolved.
				if (!ap.autoCompacted) {
					ctx.logger.logErrorBox(ap, `PROCESS EXIT code=${code}`, "");
					const captured = ap.lastAssistantText || ap.currentMessageText.trim() || ap.collectedText.trim();
					this.resolveIfPending(ap, captured || `Process exited with code ${code}`, code === 0 ? 0 : 1);
				}
				ap.proc = null;
				ap.procRef = null;
				ap.status = "dead";
				ap.ready = false;
				clearTimers(ap);
				this.invalidate();
			},
		});
		ap.proc = sub.proc;
		ap.procRef = sub;
		this.invalidate();

		// ── Readiness probe: send get_state, wait for response ──

		return new Promise<boolean>((resolve) => {
			// Give process 15s to become ready
			ap.readyTimeout = setTimeout(() => {
				ap.readyTimeout = undefined;
				if (!ap.ready) {
					ctx.logger.logErrorBox(ap, "READY TIMEOUT", `status=${ap.status}`);
					ap.status = ap.proc ? "idle" : "dead";
					ap.ready = ap.proc != null; // only ready if process is alive
					resolve(ap.proc != null);
				}
			}, SPAWN_READY_TIMEOUT_MS);

			ap.readyResolve = (success: boolean) => {
				if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
				resolve(success);
			}

			// Send get_state immediately as the readiness probe. The child's stdin
			// pipe buffers the request until its RPC reader is up, so there is no
			// need for a fixed startup delay — the response (or the 15s timeout)
			// determines readiness.
			if (ap.proc) {
				const stdin = ap.proc.stdin;
				if (stdin?.writable) {
					try {
						stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
					} catch { }
				}
			}
		});
	}
}

/** Returns a (ap, line) => void closure with the ctx baked in. Used by memory.ts
 *  (which cannot import this module) — caller wires it up in index.ts. */
export function makeHandleEvent(ctx: AgentTeamContext): (ap: AgentProc, line: string) => void {
	return (ap, line) => handleEvent(ctx, ap, line);
}
