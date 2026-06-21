// ── Orchestration: process manager + dispatch + RPC handlers ──

import { unlinkSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentProc } from "./core";
import type { SessionLogger } from "./core";
import { spawnRpcSubprocess, type RpcSubprocess } from "./core";
import { agentKey, clearTimers, resetForDispatch, blankProcState, displayName, boxLine, extractLastLine } from "./core";
import type { AgentTeamContext } from "./core";

const SIGKILL_BACKSTOP_MS = 2_000;
const KILLALL_TIMEOUT_MS = 5_000;
const READY_PROBE_DELAY_MS = 500;
const SPAWN_READY_TIMEOUT_MS = 15_000;

export const MAX_RESPONSE_LENGTH = 20000; // Subagent tool-result cap. Keep the marker string in dispatch_agent in sync.
export const PONG_TIMEOUT = 600_000;  // 10 min — reset on every activity

// Map of event type → log message formatter for simple delegation
const simpleLogEvents: Record<string, (ev: any) => string> = {
	compaction_start: (ev) => `COMPACT start (reason: ${ev.reason || "auto"})`,
	compaction_end: (ev) => ev.aborted ? `COMPACT aborted` : `COMPACT done (${ev.reason || "auto"})`,
	auto_retry_start: (ev) => `AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`,
	auto_retry_end: (ev) => `AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`,
};

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
		default: {
			const fmt = simpleLogEvents[ev.type];
			if (fmt) ctx.logger.log(boxLine(fmt(ev), ctx.logger.getWidth()));
		}
	}
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
	if (!ev.success && ap.status === "running" && ap.resolveDispatch) {
		const errMsg = ev.error || `${ev.command} failed`;
		ctx.logger.logErrorBox(ap, "PROMPT ERROR", errMsg);
		ap.lastWork = `Error: ${errMsg}`;
		ap.status = "error";
		ctx.invalidate();
		ctx.resolveIfPending(ap, errMsg, 1);
	}
}

export function handleMessageUpdate(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	const delta = ev.assistantMessageEvent;
	if (delta?.type !== "text_delta") return;
	const chunk = delta.delta || "";
	ap.collectedText += chunk;
	ap.currentMessageText += chunk;
	ctx.logger.logStreamingText(ap, chunk);
	const lastNl = chunk.lastIndexOf("\n");
	const tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
	if (tail.trim()) ap.lastWork = tail.slice(0, 80);
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

export function handleToolStart(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	ap.toolCount++;
	let detail = "";
	const args = ev.args;
	if (args && typeof args === "object") {
		detail = Object.entries(args)
			.filter(([, v]) => typeof v === "string")
			.map(([k, v]) => `${k}=${(v as string).slice(0, 80)}`)
			.join(" ");
	}
	ctx.logger.logToolStart(ap, ev.toolName, detail);
	ctx.invalidate();
}

export function handleToolEnd(ctx: AgentTeamContext, ap: AgentProc, ev: any) {
	ctx.logger.logToolEnd(ap, ev.toolName, !ev.isError, ev.durationMs);
}

export function handleAgentEnd(ctx: AgentTeamContext, ap: AgentProc, _ev: any) {
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
	ctx.logger.updateWidth();
	const ap = ctx.procs.get(agentName.toLowerCase());
	if (!ap) {
		const available = Array.from(ctx.procs.values()).map(a => displayName(a.def.name)).join(", ");
		return Promise.resolve({
			output: `Agent "${agentName}" not found. Available: ${available}`,
			code: 1, elapsed: 0,
		});
	}

	// Kill any leftover process from the most recent dispatch. Tracking
	// a single ap is enough because the design is "one dispatch at a time"
	// and avoids iterating every team member on every dispatch.
	if (ctx.lastDispatchedAp && ctx.lastDispatchedAp !== ap) {
		ctx.killProc(ctx.lastDispatchedAp, true);
	}
	ctx.lastDispatchedAp = ap;

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

	// Write separator to combined session log
	if (ctx.logger.getStream()) {
		ctx.logger.getStream()!.write("\n" + "═".repeat(ctx.logger.getWidth()) + "\n\n");
	}

	// Task complete — kill the subagent process but KEEP the terminal pane alive
	// so the user can scroll back and see what the agent did.
	// The pane will be reused on the next dispatch (same agent = same pane).
	ctx.killProc(ap, true);

	ctx.wipeSessionFile(ap);

	ap.status = "dead";
	ctx.invalidate();

	return result;
}

export async function activateTeam(ctx: AgentTeamContext, name: string) {
	await ctx.killAll();
	ctx.procs.clear();
	ctx.activeTeam = name;
	ctx.persist();

	const members = ctx.teams[name] || [];
	const byName = new Map(ctx.allDefs.map(d => [d.name.toLowerCase(), d]));

	for (const m of members) {
		const def = byName.get(m.name.toLowerCase());
		if (!def) continue;
		ctx.procs.set(def.name.toLowerCase(), {
			def,
			teamModel: m.model,
			model: m.model || def.model || ctx.orchestratorModel || "",
			...blankProcState(),
		});
	}
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
		ap.systemPromptFile = join(this.sessionDir(), `${agentKey(ap)}-system-prompt.txt`);
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

	async killAll(ctx: AgentTeamContext, killPanesToo = false) {
		if (killPanesToo) ctx.killPanes();
		const exitPromises: Promise<void>[] = [];
		for (const ap of ctx.procs.values()) {
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
		ap.sessionFile = join(this.sessionDir(), `${agentKey(ap)}.json`);

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
		// e.g. "openrouter/baidu/cobuddy:free" → provider="openrouter", model="baidu/cobuddy:free"
		const slashIdx = model.indexOf("/");
		const hasProvider = slashIdx > 0;
		const provider = hasProvider ? model.slice(0, slashIdx) : undefined;
		const modelName = hasProvider ? model.slice(slashIdx + 1) : model;

		const args = [
			"--mode", "rpc",
			"-p",
			"--no-extensions",
			...this.cachedExtPaths().flatMap(p => ["--extension", p]),
			...(provider ? ["--provider", provider] : []),
			"--model", modelName,
			"--tools", ap.def.tools,
			"--system-prompt", ap.systemPromptFile,
			"--session", ap.sessionFile,
		];

		// Record exact spawn command to tmp file (debug aid — not logged to SessionLogger)
		const AgentCmdDir = join(homedir(), ".pi","agent-team-log","agent-cmd");
		const cmdParts = [bin, ...args].map(a => /[\s"'\\$\``]/.test(a) ? JSON.stringify(a) : a);
		const cmdLine = cmdParts.join(" ");
		const body = `${new Date().toISOString()}\nagent: ${displayName(ap.def.name)}\n\n${cmdLine}\n`;
		writeFileSync(join(AgentCmdDir, `spawn-cmd-${agentKey(ap)}.txt`), body);

		const sub = spawnRpcSubprocess({
			bin,
			args,
			logger: ctx.logger,
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
				ctx.logger.logErrorBox(ap, `PROCESS EXIT code=${code}`, "");
				this.resolveIfPending(ap, `Process exited unexpectedly with code ${code}`, 1);
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

			// Wait 500ms then send get_state as readiness probe
			setTimeout(() => {
				if (!ap.proc) return;
				const stdin = ap.proc.stdin;
				if (!stdin?.writable) return;
				try {
					stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
				} catch { }
			}, READY_PROBE_DELAY_MS);
		});
	}
}

/** Returns a (ap, line) => void closure with the ctx baked in. Used by memory.ts
 *  (which cannot import this module) — caller wires it up in index.ts. */
export function makeHandleEvent(ctx: AgentTeamContext): (ap: AgentProc, line: string) => void {
	return (ap, line) => handleEvent(ctx, ap, line);
}
