/**
 * Agent Team - Ephemeral subagent orchestrator
 *
 * Subagents are spawned on-demand per task. A fresh `pi --mode rpc` process
 * is created for each dispatch, the task runs, and the process is killed
 * once the result is reported back to the orchestrator. No context
 * accumulates between dispatches — each task starts with a clean slate.
 *
 * Lifecycle:
 *   session_start  → load agent defs only (NO spawning)
 *   dispatch       → spawn fresh process → send task → await result → kill
 *   session_end    → cleanup any residual processes
 *
 * Commands:
 *   /agents-team          - switch active team
 *   /agents-list          - list agents + process status
 *   /agents-grid N        - set grid columns (default 1)
 *   /agents-team-toggle   - enable/disable (on/off/status)
 *   /agents-restart       - kill any running subagent processes
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import {
	readdirSync, readFileSync, existsSync, mkdirSync,
	unlinkSync, writeFileSync, createWriteStream,
	type WriteStream,
} from "fs";
import { join, resolve } from "path";

// ── Types ──────────────────────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

interface AgentProc {
	def: AgentDef;
	model: string;
	proc: ChildProcess | null;
	stdoutBuf: string;
	status: "idle" | "running" | "starting" | "done" | "error" | "dead";
	ready: boolean;
	readyResolve: (() => void) | null;
	task: string;
	collectedText: string;
	contextWindow: number;   // model context window (tokens)
	tokensUsed: number;      // last known input token usage (excl. cache)
	tokensOut: number;       // last known output token usage
	cacheRead: number;       // last known cached input tokens (prompt cache hits)
	cacheWrite: number;      // last known cache write tokens
	cacheSavedTotal: number; // cumulative cache-read tokens across all dispatches
	toolCount: number;
	elapsed: number;
	lastWork: string;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
	dispatchTimeout?: ReturnType<typeof setTimeout>;
	sigkillTimeout?: ReturnType<typeof setTimeout>;
	resolveDispatch: ((output: string, code: number) => void) | null;
	sessionFile: string;
	systemPromptFile: string;
	lastPromptHash?: string;
	streamLineBuf: string;   // partial line buffer for streaming text box-wrapping
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract short model name after last '/' */
function shortModel(model: string): string {
	const i = model.lastIndexOf("/");
	return i >= 0 ? model.slice(i + 1) : model;
}

const displayName = (name: string) =>
	name.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

const agentKey = (ap: { def: { name: string } }) =>
	ap.def.name.toLowerCase().replace(/\s+/g, "-");

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let cur = "";
	for (const line of raw.split("\n")) {
		const tm = line.match(/^(\S[^:]*):$/);
		if (tm) { cur = tm[1].trim(); teams[cur] = []; continue; }
		const im = line.match(/^\s+-\s+(.+)$/);
		if (im && cur) teams[cur].push(im[1].trim());
	}
	return teams;
}

function parseAgentFile(fp: string): AgentDef | null {
	try {
		const raw = readFileSync(fp, "utf-8");
		const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!m) return null;
		const fm: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const i = line.indexOf(":");
			if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		if (!fm.name) return null;
		const tools = new Set(
			(fm.tools || "read,grep,find,ls").split(",").map(s => s.replace(/\s+/g, "")).filter(Boolean)
		);
		for (const t of m[2].matchAll(/`([a-z][a-z0-9_-]+)`/g)) tools.add(t[1]);
		return {
			name: fm.name,
			description: fm.description || "",
			tools: [...tools].join(","),
			model: fm.model,
			thinking: fm.thinking || undefined,
			systemPrompt: m[2].trim(),
			file: fp,
		};
	} catch { return null; }
}

/** Collect extension paths (excluding agent-team and disabled extensions) for -e flags */
function scanExtensionPaths(cwd: string): string[] {
	const dirs = [
		join(cwd, ".pi", "extensions"),
		join(getAgentDir(), "extensions"),
	];
	const disabled = loadDisabledExtensions();
	const paths: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const f of readdirSync(dir, { withFileTypes: true })) {
				if (f.isDirectory()) {
					const idx = join(dir, f.name, "index.ts");
					if (existsSync(idx) && !isDisabled(idx, disabled)) paths.push(idx);
				} else if (f.isFile() && f.name.endsWith(".ts")) {
					const p = join(dir, f.name);
					if (!isDisabled(p, disabled)) paths.push(p);
				}
			}
		} catch {}
	}
	return paths.filter(p => !p.includes("agent-team"));
}

/** Load disabled extensions from settings.json */
function loadDisabledExtensions(): Set<string> {
	const disabled = new Set<string>();
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return disabled;
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const exts: string[] = raw.extensions || [];
		for (const e of exts) {
			if (typeof e === "string" && e.startsWith("-")) {
				disabled.add(e.slice(1));
			}
		}
	} catch {}
	return disabled;
}

/** Check if an extension path is disabled */
function isDisabled(extPath: string, disabled: Set<string>): boolean {
	for (const pattern of disabled) {
		if (extPath.endsWith(pattern)) return true;
	}
	return false;
}

function scanAgents(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		join(getAgentDir(), "agents"),
	];
	const agents: AgentDef[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, f));
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}
	return agents;
}

// ── Config Persistence ────────────────────────────────────────────────

interface TeamConfig {
	activeTeam: string;
	gridCols: number;
	enabled: boolean;
}

const CONFIG_FILE = "agent-team-config.json";

function loadPersistedConfig(): Partial<TeamConfig> {
	const p = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(p)) return {};
	try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function savePersistedConfig(cfg: TeamConfig) {
	writeFileSync(join(getAgentDir(), CONFIG_FILE), JSON.stringify(cfg, null, 2));
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const procs = new Map<string, AgentProc>(); // key = lowercase name
	let allDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	const _saved = loadPersistedConfig();
	let activeTeam = "";
	let gridCols = _saved.gridCols ?? 1;
	let animFrame = 0;
	let wCtx: any;
	let wInvalidate: (() => void) | null = null;
	let sessionDir = "";
	let logDir = "";
	let enabled = _saved.enabled ?? true;

	let tmuxCwd = "";
	let cachedExtPaths: string[] = []; // resolved once per session_start
	let orchestratorModel = ""; // model id from orchestrator's context
	let sharedPaneId: string | null = null; // single tmux pane for combined session log
	let sessionLogFile = "";           // single combined log file path
	let sessionLogStream: WriteStream | null = null; // single combined log stream

	// Persist current runtime state to disk
	function persist() {
		savePersistedConfig({
			activeTeam,
			gridCols,
			enabled,
		});
	}

	// ── Logging ─────────────────────────────────────────────────────
	//
	//  Log format uses Unicode box-drawing characters, no ANSI codes.
	//  Each major lifecycle phase (spawn, task, error) gets its own box.
	//

	//
	//  ╭── Task #1 · Scout · model-name ─────────────╮
	//  │ Search for configuration files...           │
	//  │                                            │
	//  │  ┌ grep pattern=... path=...               │
	//  │  └ ✓ grep (42ms)                           │
	//  │                                            │
	//  │  (streaming text)                           │
	//  ╰── DONE  77s · 13 tools ───────────────────╯

	const MIN_logWidth = 60;
	const MAX_logWidth = 300;
	let logWidth = MIN_logWidth; // updated dynamically

	function getTerminalWidth(): number {
		try {
			const r = spawnSync("tmux", ["display-message", "-p", "#{client_width}"], { encoding: "utf-8" });
			const w = parseInt(r.stdout?.trim() || "0", 10);
			return w > 0 ? w : 0;
		} catch { return 0; }
	}

	function updateLogWidth() {
		const tw = getTerminalWidth();
		logWidth = tw > 0 ? Math.min(Math.max(tw, MIN_logWidth), MAX_logWidth) : MIN_logWidth;
	}

	function openSessionLog() {
		if (sessionLogStream) return; // already open
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		sessionLogFile = join(logDir, `session-${ts}.log`);
		sessionLogStream = createWriteStream(sessionLogFile, { flags: "a" });
		sessionLogStream.on("error", (err) => console.error(`Session log write error:`, err.message));
	}

	function closeSessionLog() {
		if (sessionLogStream) { try { sessionLogStream.end(); } catch {} sessionLogStream = null; }
	}

	/** Agent header: "Scout · model-name" */
	function agentLabel(ap: AgentProc): string {
		return `${displayName(ap.def.name)} · ${shortModel(ap.model)}`;
	}

	function tag(ap: AgentProc, heading: string): string {
		return `[${displayName(ap.def.name)}][${shortModel(ap.model)}] - ${heading}`;
	}

	// ── Low-level write helpers ──

	function log(_ap: AgentProc, msg: string) {
		if (sessionLogStream) sessionLogStream.write(msg + "\n");
	}

	function logRaw(_ap: AgentProc, msg: string) {
		if (sessionLogStream) sessionLogStream.write(msg);
	}

	function logStreamingText(ap: AgentProc, chunk: string) {
		if (!sessionLogStream) return;
		ap.streamLineBuf += chunk;
		let idx: number;
		while ((idx = ap.streamLineBuf.indexOf("\n")) >= 0) {
			const line = ap.streamLineBuf.slice(0, idx);
			ap.streamLineBuf = ap.streamLineBuf.slice(idx + 1);
			sessionLogStream.write(boxLine(line, logWidth) + "\n");
		}
	}

	function flushStreamBuf(ap: AgentProc) {
		if (!sessionLogStream) return;
		if (ap.streamLineBuf) {
			sessionLogStream.write(boxLine(ap.streamLineBuf, logWidth) + "\n");
			ap.streamLineBuf = "";
		}
	}

	// ── Box drawing helpers ──

	function hrPad(content: string, width: number, left: string, right: string, fill = "─"): string {
		const inner = width - left.length - right.length;
		const used = [...content].length; // unicode-aware length
		const pad = Math.max(1, inner - used);
		return left + content + fill.repeat(pad) + right;
	}

	function boxLine(content: string, width: number): string {
		const inner = width - 4; // "│ " + " │"
		const truncated = [...content].length > inner ? [...content].slice(0, inner - 1).join("") + "..." : content;
		return hrPad(` ${truncated} `, width, "│", "│", " ");
	}

	// ── Structured log events ──


	function logTaskBox(ap: AgentProc, taskNum: number, task: string) {
	        log(ap, "");
		const t0 = Date.now();
		log(ap, `Date: ${new Date(t0).toISOString()}`);
        	log(ap, hrPad(` Task #${taskNum} · ${agentLabel(ap)} `, logWidth, "╭", "╮"));
		const inner = logWidth - 4;
		const paragraphs = task.split("\n");
		for (const para of paragraphs) {
			const words = para.split(" ");
			let line = "";
			for (const w of words) {
				if (line && [...line].length + 1 + [...w].length > inner) {
					log(ap, boxLine(line, logWidth));
					line = w;
				} else {
					line = line ? line + " " + w : w;
				}
			}
			if (line) log(ap, boxLine(line, logWidth));
		}


	}

	function logToolStart(ap: AgentProc, tool: string, detail: string) {
		const info = detail ? ` ${detail}` : "";
		log(ap, boxLine(`┌ ${tool}${info}`, logWidth));
	}

	function logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
		const icon = ok ? "✓" : "✗";
		const dur = durMs ? ` (${Math.round(durMs)}ms)` : "";
		log(ap, boxLine(`└ ${icon} ${tool}${dur}`, logWidth));
	}

	function logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
	        log(ap,"")
		log(ap, hrPad(` DONE  ${elapsedSec}s · ${tools} tools `, logWidth, "╰", "╯"));
	}

	function logErrorBox(ap: AgentProc, heading: string, detail: string) {
		log(ap, hrPad(` ✗ ${agentLabel(ap)} `, logWidth, "╭", "╮"));
		log(ap, boxLine(heading, logWidth));
		if (detail) log(ap, boxLine(detail, logWidth));
		log(ap, hrPad("", logWidth, "╰", "╯"));
	}

	// ── Tmux Panes ──────────────────────────────────────────────────

	function resizeSharedPane() {
		if (!sharedPaneId || !/^%\d+$/.test(sharedPaneId)) return;
		const tw = getTerminalWidth();
		if (tw <= 0) return;
		try {
			spawn("tmux", ["resize-pane", "-t", sharedPaneId, "-x", String(tw)], { stdio: "ignore" });
		} catch {}
	}

	function createSessionPane() {
		if (!enabled) return;
		if (!process.env.TMUX || !sessionLogFile) return;
		if (sharedPaneId) return; // pane already exists

		const cwd = (tmuxCwd || process.cwd()).replace(/'/g, "'\\''");
		const lf = sessionLogFile.replace(/'/g, "'\\''");
		const origPane = process.env.TMUX_PANE || "";
		if (origPane && !/^%\d+$/.test(origPane)) return;

		const tw = getTerminalWidth();
		const widthArg = tw > 0 ? `-x ${tw}` : "";
		const script = [
			`P=$(tmux split-window -v -d -l 8 -c '${cwd}' -P -F '#{pane_id}')`,
			`tmux select-pane -t $P -T 'Agent Team Log'`,
			widthArg ? `tmux resize-pane -t $P ${widthArg}` : "true",
			`tmux send-keys -t $P 'tail -n +1 -f ${lf}' Enter`,
			`echo $P`,
			`tmux select-pane -t ${origPane}`,
		].filter(Boolean).join("\n");
		const ch = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
		let pid = "";
		ch.stdout.setEncoding("utf-8");
		ch.stdout.on("data", (d: string) => { pid += d; });
		ch.on("close", () => { const id = pid.trim(); if (id) sharedPaneId = id; });
	}

	function killPanes() {
		closeSessionLog();
		if (sharedPaneId && /^%\d+$/.test(sharedPaneId)) {
			const id = sharedPaneId;
			sharedPaneId = null;
			spawn("tmux", ["kill-pane", "-t", id], { stdio: "ignore" });
		}
	}

	// ── Spawn / Kill ────────────────────────────────────────────────

	function clearTimers(ap: AgentProc) {
		clearInterval(ap.timer);
		if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
		if (ap.sigkillTimeout) { clearTimeout(ap.sigkillTimeout); ap.sigkillTimeout = undefined; }
	}

	function killProc(ap: AgentProc, immediate = false) {
		resolveIfPending(ap, ap.status === "running" || ap.status === "starting" ? "Process killed" : "", 1);
		if (ap.proc) {
			const dying = ap.proc;
			try {
				if (immediate) dying.kill("SIGKILL");
				else {
					dying.kill("SIGTERM");
					ap.sigkillTimeout = setTimeout(() => { try { dying.kill("SIGKILL"); } catch {} }, 2000);
				}
			} catch {}
			ap.proc = null;
		}
		cleanSystemPrompt(ap);
		ap.status = "dead";
		ap.ready = false;
		ap.stdoutBuf = "";
		clearTimers(ap);
	}

	async function killAll(killPanesToo = false) {
		if (killPanesToo) killPanes();
		const exitPromises: Promise<void>[] = [];
		for (const ap of procs.values()) {
			const dying = ap.proc;
			if (dying) {
				exitPromises.push(new Promise<void>(res => {
					const timer = setTimeout(res, 5000);
					dying.on("close", () => { clearTimeout(timer); res(); });
				}));
			}
			killProc(ap);
		}
		if (exitPromises.length) await Promise.all(exitPromises);
	}

	// Write system prompt to temp file (avoids shell escaping issues with multi-line prompts)
	function writeSystemPrompt(ap: AgentProc) {
		const content = `You are working in the project cwd.\n\n ${ap.def.systemPrompt}`;
		if (ap.lastPromptHash === content) return; // skip if unchanged
		ap.lastPromptHash = content;
		ap.systemPromptFile = join(sessionDir, `${agentKey(ap)}-system-prompt.txt`);
		writeFileSync(ap.systemPromptFile, content);
	}

	function cleanSystemPrompt(ap: AgentProc) {
		if (ap.systemPromptFile) {
			try { unlinkSync(ap.systemPromptFile); } catch {}
		}
	}

	function spawnProc(ap: AgentProc): Promise<boolean> {
		// Ensure clean slate
		if (ap.proc) killProc(ap);

		ap.status = "starting";
		ap.ready = false;
		ap.readyResolve = null;
		ap.collectedText = "";
		ap.stdoutBuf = "";
		ap.streamLineBuf = "";
		ap.resolveDispatch = null;
		ap.toolCount = 0;
		ap.task = "";
		ap.lastWork = "";
		clearTimers(ap);

		ap.sessionFile = join(sessionDir, `${agentKey(ap)}.json`);

		// Write system prompt to temp file to avoid CLI escaping issues
		writeSystemPrompt(ap);

		// Sync model: if agent def has no model, always use current orchestrator model
		const model = ap.def.model || orchestratorModel || "google/gemini-2.5-flash";
		ap.model = model;
		const bin = process.platform === "win32" ? "pi.cmd" : "pi";

		// Build args: --no-extensions to block auto-discovery (including agent-team),
		// then explicitly load only non-agent-team extensions via -e.
		// --tools uses the agent's prompt-file tools as the allowlist.
		const args = [
			"--mode", "rpc",
			"-p",
			"--no-extensions",
			...cachedExtPaths.flatMap(p => ["--extension", p]),
			"--model", model,
			"--tools", ap.def.tools,
			"--thinking", ap.def.thinking || "off",
			"--append-system-prompt", ap.systemPromptFile,
			"--session", ap.sessionFile,
		];

		const proc = spawn(bin, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		ap.proc = proc;
		invalidate();

		// Read JSONL events from stdout
		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			if (ap.proc !== proc) return; // stale process guard
			ap.stdoutBuf += chunk;
			while (true) {
				const nl = ap.stdoutBuf.indexOf("\n");
				if (nl === -1) break;
				let line = ap.stdoutBuf.slice(0, nl);
				ap.stdoutBuf = ap.stdoutBuf.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				handleEvent(ap, line);
			}
		});

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (d: string) => {
			if (ap.proc !== proc) return; // stale process guard
			for (const line of d.split("\n")) if (line.trim()) log(ap, line);
		});

		proc.on("error", (err) => {
			if (ap.proc !== proc) return; // stale process guard
			logErrorBox(ap, "PROCESS ERROR", err.message);
			ap.status = "error";
			ap.lastWork = `Error: ${err.message}`;
			resolveIfPending(ap, `Process error: ${err.message}`, 1);
			ap.proc = null;
		});

		proc.on("close", (code) => {
			if (ap.proc !== proc) return; // stale process guard
			logErrorBox(ap, `PROCESS EXIT code=${code}`, "");
			resolveIfPending(ap, `Process exited unexpectedly with code ${code}`, 1);
			ap.proc = null;
			ap.status = "dead";
			ap.ready = false;
			clearTimers(ap);
			invalidate();
		});

		// ── Readiness probe: send get_state, wait for response ──

		return new Promise<boolean>((resolve) => {
			// Give process 15s to become ready
			const readyTimeout = setTimeout(() => {
				if (!ap.ready) {
					logErrorBox(ap, "READY TIMEOUT", `status=${ap.status}`);
					ap.status = ap.proc ? "idle" : "dead";
					ap.ready = ap.proc != null; // only ready if process is alive
					resolve(ap.proc != null);
				}
			}, 15_000);

			ap.readyResolve = () => {
				clearTimeout(readyTimeout);
				resolve(ap.proc != null);
			}

			// Wait 500ms then send get_state as readiness probe
			setTimeout(() => {
				if (!ap.proc?.stdin.writable) return;
				try {
					ap.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
				} catch {}
			}, 500);
		});
	}



	// ── Resolve helper ──────────────────────────────────────────────

	function resolveIfPending(ap: AgentProc, output: string, code: number) {
		if (!ap.resolveDispatch) return;
		const resolve = ap.resolveDispatch;
		ap.resolveDispatch = null;
		clearTimers(ap);
		resolve(output, code);
	}



	// ── RPC Event Handling ──────────────────────────────────────────

	function handleEvent(ap: AgentProc, line: string) {
		let ev: any;
		try { ev = JSON.parse(line); } catch { return; }

		// Command response
		if (ev.type === "response") {
			// First response = process is ready
			if (!ap.ready) {
				ap.ready = true;
				ap.status = "idle";
				// Capture context window from get_state response
				if (ev.success && ev.data?.model?.contextWindow) {
					ap.contextWindow = ev.data.model.contextWindow;
				}
				invalidate();
				if (ap.readyResolve) { ap.readyResolve(); ap.readyResolve = null; }
			}
			// Error response while dispatch pending (e.g. prompt failed, model error)
			// agent_end never fires in this case, so we must resolve here to avoid timeout
			if (!ev.success && ap.status === "running" && ap.resolveDispatch) {
				const errMsg = ev.error || `${ev.command} failed`;
				logErrorBox(ap, "PROMPT ERROR", errMsg);
				ap.lastWork = `Error: ${errMsg}`;
				ap.status = "error";
				invalidate();
				resolveIfPending(ap, errMsg, 1);
			}
			return;
		}

		// Streaming text
		if (ev.type === "message_update") {
			const delta = ev.assistantMessageEvent;
			if (delta?.type === "text_delta") {
				const chunk = delta.delta || "";
				ap.collectedText += chunk;
				logStreamingText(ap, chunk);
				// Track last work line - scan only last portion
				const lastNl = chunk.lastIndexOf("\n");
				const tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
				if (tail.trim()) ap.lastWork = tail.slice(0, 80);
			}
			return;
		}

		// Token usage from assistant message_end
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const u = ev.message.usage;
			if (u) {
				ap.tokensOut = u.output || 0;
				ap.cacheRead = u.cacheRead || 0;
				ap.cacheWrite = u.cacheWrite || 0;
				ap.cacheSavedTotal += ap.cacheRead;
				// input excludes cache tokens — use directly for real cost
				ap.tokensUsed = u.input || 0;
				if (u.totalTokens) {
					// Fallback: derive input if provider didn't split it
					const derived = u.totalTokens - ap.tokensOut - ap.cacheRead - ap.cacheWrite;
					ap.tokensUsed = u.input || (derived > 0 ? derived : u.totalTokens - ap.tokensOut);
				}
			}
			flushStreamBuf(ap);
			invalidate();
			return;
		}

		// Tool tracking
		if (ev.type === "tool_execution_start") {
			ap.toolCount++;
			const args = ev.args;
			let detail = "";
			if (args && typeof args === "object") {
				detail = Object.entries(args)
					.filter(([, v]) => typeof v === "string")
					.map(([k, v]) => `${k}=${(v as string).slice(0, 80)}`)
					.join(" ");
			}
				logToolStart(ap, ev.toolName, detail);
			invalidate();
			return;
		}

		if (ev.type === "tool_execution_end") {
			logToolEnd(ap, ev.toolName, !ev.isError, ev.durationMs);
			return;
		}

		// Agent done - resolve the pending dispatch
		if (ev.type === "agent_end") {
			clearInterval(ap.timer);
			flushStreamBuf(ap);
			const full = ap.collectedText;
			logDoneBox(ap, Math.round(ap.elapsed / 1000), ap.toolCount);
			ap.status = "done";
			// Extract last non-empty line from accumulated text
			let lastLine = "";
			let scanFrom = full.length - 1;
			while (scanFrom >= 0) {
				const nl = full.lastIndexOf("\n", scanFrom);
				const seg = full.slice(nl + 1, scanFrom + 1).trim();
				if (seg) { lastLine = seg; break; }
				scanFrom = nl - 1;
			}
			ap.lastWork = lastLine;
			ap.collectedText = "";

			invalidate();

			if (wCtx) {
				wCtx.ui.notify(
					tag(ap, `done (${Math.round(ap.elapsed / 1000)}s, ${ap.toolCount} tools)`) ,
					"success",
				);
			}

			resolveIfPending(ap, full, 0);

			return;
		}

		// Compaction events (manual)
		if (ev.type === "compaction_start") {
			log(ap, boxLine(`COMPACT start (reason: ${ev.reason || "auto"})`, logWidth));
			return;
		}
		if (ev.type === "compaction_end") {
			if (ev.aborted) {
				log(ap, boxLine(`COMPACT aborted`, logWidth));
			} else {
				log(ap, boxLine(`COMPACT done (${ev.reason || "auto"})`, logWidth));
			}
			return;
		}

		// Auto-retry events: log for visibility (dispatch already resolved on agent_end)
		if (ev.type === "auto_retry_start") {
			log(ap, boxLine(`AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`, logWidth));
			return;
		}
		if (ev.type === "auto_retry_end") {
			log(ap, boxLine(`AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`, logWidth));
			return;
		}

		// Extension UI requests: auto-respond (headless subagent)
		if (ev.type === "extension_ui_request") {
			autoRespondUI(ap, ev);
			return;
		}
	}

	function autoRespondUI(ap: AgentProc, ev: any) {
		if (!ap.proc?.stdin.writable) return;
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
		try { ap.proc.stdin.write(JSON.stringify(resp) + "\n"); } catch {}
	}

	// ── Agent Loading ───────────────────────────────────────────────

	function loadAgents(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		logDir = join(cwd, ".pi", "agent-logs");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(logDir, { recursive: true });
		updateLogWidth();

		allDefs = scanAgents(cwd);
		cachedExtPaths = scanExtensionPaths(cwd);

		const tp = join(getAgentDir(), "agents", "teams.yaml");
		teams = existsSync(tp) ? parseTeamsYaml(readFileSync(tp, "utf-8")) : {};
		if (!Object.keys(teams).length) teams = { all: allDefs.map(d => d.name) };
	}

	// ── Team Activation ─────────────────────────────────────────────

	async function activateTeam(name: string) {
		await killAll();
		procs.clear();
		activeTeam = name;
		persist();

		const members = teams[name] || [];
		const byName = new Map(allDefs.map(d => [d.name.toLowerCase(), d]));

		for (const m of members) {
			const def = byName.get(m.toLowerCase());
			if (!def) continue;
			procs.set(def.name.toLowerCase(), {
				def,
				model: def.model || orchestratorModel || "",
				proc: null,
				stdoutBuf: "",
				status: "dead",
				task: "",
				collectedText: "",
				contextWindow: 0,
				tokensUsed: 0,
				tokensOut: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cacheSavedTotal: 0,
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				runCount: 0,
				ready: false,
				readyResolve: null,
				systemPromptFile: "",
				resolveDispatch: null,
				sessionFile: "",
				streamLineBuf: "",
			});
		}
	}

	// ── Dispatch ────────────────────────────────────────────────────

	const DISPATCH_TIMEOUT = 600_000; // 10 minutes

	async function dispatch(agentName: string, task: string): Promise<{ output: string; code: number; elapsed: number }> {
		updateLogWidth();
		const ap = procs.get(agentName.toLowerCase());
		if (!ap) {
			const available = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${available}`,
				code: 1, elapsed: 0,
			});
		}

		// Kill ALL leftover processes from any previous dispatch
		for (const other of procs.values()) {
			if (other.proc) killProc(other, true);
		}

		// Wipe session file BEFORE spawn to guarantee clean slate
		if (ap.sessionFile && existsSync(ap.sessionFile)) {
			try { unlinkSync(ap.sessionFile); } catch {}
		}

		// Also wipe system prompt cache to avoid leaking between agents
		ap.lastPromptHash = undefined;

		// Spawn fresh process for this task
		ap.status = "dead";
		const started = await spawnProc(ap);
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
		invalidate();

		const t0 = Date.now();
		ap.timer = setInterval(() => {
			ap.elapsed = Date.now() - t0;
			invalidate();
		}, 500);

		logTaskBox(ap, ap.runCount, task);

		const cmd = JSON.stringify({ type: "prompt", message: task }) + "\n";
		try {
			if (!ap.proc?.stdin?.writable) {
				clearInterval(ap.timer);
				ap.status = "error";
				invalidate();
				return { output: `Process died before task could be sent`, code: 1, elapsed: 0 };
			}
			ap.proc.stdin.write(cmd);
		} catch (err: any) {
			clearInterval(ap.timer);
			ap.status = "error";
			invalidate();
			return { output: `Write error: ${err.message}`, code: 1, elapsed: 0 };
		}

		const result = await new Promise<{ output: string; code: number; elapsed: number }>((resolve) => {
			// Timeout safety net - KILL the stuck process so it doesn't leak
			ap.dispatchTimeout = setTimeout(() => {
				logErrorBox(ap, "TIMEOUT", `after ${Math.round(DISPATCH_TIMEOUT / 1000)}s - force-killing process`);
				ap.lastWork = "Timed out";
				// Resolve FIRST with the timeout message before killProc overwrites it
				resolveIfPending(ap, `Dispatch timed out after ${Math.round(DISPATCH_TIMEOUT / 1000)}s`, 1);
				killProc(ap, true);
				if (wCtx) wCtx.ui.notify(tag(ap, `TIMEOUT (${Math.round(DISPATCH_TIMEOUT / 1000)}s) — killed`), "error");
				invalidate();
			}, DISPATCH_TIMEOUT);

			ap.resolveDispatch = (output, code) => {
				// Clear timeout immediately to prevent race with normal completion
				if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
				resolve({ output, code, elapsed: ap.elapsed });
			};
		});

		// Write separator to combined session log
		if (sessionLogStream) {
			sessionLogStream.write("\n" + "═".repeat(logWidth) + "\n\n");
		}

		// Task complete — kill the subagent process but KEEP the tmux pane alive
		// so the user can scroll back and see what the agent did.
		// The pane will be reused on the next dispatch (same agent = same pane).
		killProc(ap, true);

		// Wipe session file so next dispatch starts fresh
		if (ap.sessionFile && existsSync(ap.sessionFile)) {
			try { unlinkSync(ap.sessionFile); } catch {}
		}

		ap.status = "dead";
		invalidate();

		return result;
	}

	// ── Widget ──────────────────────────────────────────────────────

	function initWidget() {
		if (!wCtx) return;
		wInvalidate = null;

		wCtx.ui.setWidget("agent-team", (tui: any, theme: any) => {
			const text = new Text("", 0, 1);
			wInvalidate = () => tui.requestRender();

			return {
				render(width: number): string[] {
					if (!enabled) {
						text.setText(theme.fg("dim", `Agent Team: disabled (team=${activeTeam || "none"})  /agents-team-toggle on`));
						return text.render(width);
					}
					if (!procs.size) {
						text.setText(theme.fg("dim", "No agents. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, procs.size);
					const gap = 1;
					const colW = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(procs.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const row = agents.slice(i, i + cols);
						const cards = row.map(a => renderCard(a, colW, theme));
						while (cards.length < cols) cards.push([" ".repeat(colW)]);
						const h = Math.max(...cards.map(c => c.length));
						for (const c of cards) { while (c.length < h) c.push(" ".repeat(colW)); }
						for (let line = 0; line < h; line++) {
							rows.push(cards.map(c => c[line] || ""));
						}
					}

					text.setText(rows.map(r => r.join(" ".repeat(gap))).join("\n"));
					return text.render(width);
				},
				invalidate() { text.invalidate(); },
			};
		});
	}

	function invalidate() {
		animFrame++;
		if (!wCtx) return;
		if (wInvalidate) wInvalidate();
		else initWidget();
	}

	function renderCard(ap: AgentProc, w: number, theme: any): string[] {
		const trunc = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "..." : s;

		const statusColor = ap.status === "idle" ? "dim"
			: ap.status === "starting" ? "warning"
			: ap.status === "running" ? "accent"
			: ap.status === "done" ? "success" : "error";
		const statusIcon = ap.status === "idle" ? "○"
			: ap.status === "starting" ? "◐"
			: ap.status === "running" ? "●"
			: ap.status === "done" ? "✓" : "";

		const name = displayName(ap.def.name);
		const sm = shortModel(ap.model);
		const modelStr = sm ? ` (${sm})` : "";
		const timeStr = (ap.status === "running" || ap.status === "starting") ? ` ${Math.round(ap.elapsed / 1000)}s` : "";
		const plug = ap.status === "running" ? "\u{1F50C}" : ap.status === "dead" ? "\u{1F916}" : "\u{1F50C}";
		const statusStr = `${plug}${statusIcon}${timeStr}`;

		const maxLabel = w - statusStr.length - 2;
		const truncatedName = trunc(name, maxLabel - modelStr.length);
		const label = theme.fg("accent", theme.bold(truncatedName)) + theme.fg("dim", modelStr);
		const dots = Math.max(1, w - truncatedName.length - modelStr.length - statusStr.length - 2);

		const line1 = label + " " + (ap.status === "running"
			? animDots(dots, animFrame, theme)
			: theme.fg("dim", "·".repeat(dots))) + " " +
			theme.fg(statusColor, statusStr);

		// Token/context usage line
		const lines = [line1];
		if (ap.contextWindow > 0 && (ap.tokensUsed > 0 || ap.tokensOut > 0)) {
			const pct = Math.min(100, Math.round((ap.tokensUsed / ap.contextWindow) * 100));
			const barW = Math.min(12, Math.max(5, Math.floor((w - 20) / 2)));
			const filled = Math.round((pct / 100) * barW);
			const bar = "█".repeat(filled) + "░".repeat(barW - filled);
			const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";

			const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
			const tokenStr = `In=${fmtTok(ap.tokensUsed)}  Out=${fmtTok(ap.tokensOut)}`;
			const pctStr = ` Ctx=${pct}%/${fmtTok(ap.contextWindow)}` ;
			
			// Cache stats line — show cache hits when present
		        const cacheHit = ap.cacheRead > 0 ? `Hit=${fmtTok(ap.cacheRead)}` : "";
			const total = ap.cacheSavedTotal > 0 ? `Σ=${fmtTok(ap.cacheSavedTotal)}` : "";
			const sep = cacheHit && total ? " " : "";
			const cacheLabel = `Cache: ${cacheHit}${sep}${total}`;
			
			const line2 = theme.fg(barColor, bar) + " " +
				theme.fg("dim", tokenStr) + " " +
				theme.fg(barColor, pctStr) + " " + theme.fg("success", "  \u{1F4BE} " + cacheLabel);		
			lines.push(line2);

	
		}

		return lines;
	}

	function animDots(n: number, frame: number, theme: any): string {
		const colors = ["accent", "success", "warning"];
		let r = "";
		for (let i = 0; i < n; i++) {
			const pos = ((i - frame) % 6 + 6) % 6;
			if (pos < 3) {
				const ci = ((Math.floor((i - pos) / 6)) % colors.length + colors.length) % colors.length;
				r += theme.fg(colors[ci], "·");
			} else {
				r += theme.fg("dim", "·");
			}
		}
		return r;
	}

	// ── dispatch_agent Tool ─────────────────────────────────────────

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
			if (!enabled) return {
				content: [{ type: "text", text: "Agent team is disabled. /agents-team-toggle on" }],
			};

			try {
				const apRef = procs.get(agent.toLowerCase());
				const modelTag = apRef ? shortModel(apRef.model) : "?";

				onUpdate?.({
					content: [{ type: "text", text: `[${agent}][${modelTag}] - dispatching...` }],
					details: { agent, task, status: "dispatching" },
				});

				// Listen for ESC / abort signal — kill running subagent
				if (signal) {
					signal.addEventListener("abort", () => {
						const ap = procs.get(agent.toLowerCase());
						if (ap && (ap.status === "running" || ap.status === "starting")) {
							logErrorBox(ap, "ABORTED", "User pressed ESC");
							killProc(ap, true);
							if (ap.sessionFile && existsSync(ap.sessionFile)) {
								try { unlinkSync(ap.sessionFile); } catch {}
							}
							ap.status = "dead";
							invalidate();
						}
					});
				}

				const r = await dispatch(agent, task);

				const isLarge = r.output.length > 8000;
				const truncated = isLarge
					? r.output.slice(0, 8000) + "\n\n... [truncated]" : r.output;

				const status = r.code === 0 ? "done" : "error";
				const summary = `[${agent}][${modelTag}] - ${status} in ${Math.round(r.elapsed / 1000)}s`;

				if (r.code !== 0 && wCtx) {
					wCtx.ui.notify(summary, "error");
				}

				return {
					content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
					// If truncated, store the truncated version as fullOutput to avoid
					// holding a 2x copy (truncated + original) in memory
					details: { agent, task, status, elapsed: r.elapsed, exitCode: r.code, fullOutput: truncated },
				};
			} catch (err: any) {
				if (wCtx) wCtx.ui.notify(`[${agent}] Error: ${err?.message || err}`, "error");
				return {
					content: [{ type: "text", text: `Error dispatching ${agent}: ${err?.message || err}. The orchestrator should inform the user.` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const a = (args as any).agent || "?";
			const t = (args as any).task || "";
			const apRef = procs.get(a.toLowerCase());
			const modelTag = apRef ? shortModel(apRef.model) : "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", `[${a}][${modelTag}] - `) +
				theme.fg("muted", t),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.text || "", 0, 0);

			const apRef = procs.get((d.agent || "").toLowerCase());
			const modelTag = apRef ? shortModel(apRef.model) : "?";

			if (options.isPartial || d.status === "dispatching") {
				return new Text(
					theme.fg("accent", `[${d.agent || "?"}][${modelTag}] - working...`),
					0, 0,
				);
			}

			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			const elapsed = typeof d.elapsed === "number" ? Math.round(d.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} [${d.agent}][${modelTag}] - ${elapsed}s`);

			if (options.expanded && d.fullOutput) {
				const output = d.fullOutput.length > 4000
					? d.fullOutput.slice(0, 4000) + "\n..." : d.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ────────────────────────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Select a team",
		handler: async (_args, ctx) => {
			wCtx = ctx;
			const names = Object.keys(teams);
			if (!names.length) { ctx.ui.notify("No teams defined", "warning"); return; }

			const opts = names.map(n => {
				const m = teams[n].map(displayName).join(", ");
				return `${n} - ${m}`;
			});

			const choice = await ctx.ui.select("Select Team", opts);
			if (choice === undefined) return;

			const name = names[opts.indexOf(choice)];
			await activateTeam(name);
			invalidate();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${procs.size})`);
			ctx.ui.notify(`Team: ${name} - ${Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List agents + process status",
		handler: async (_args, ctx) => {
			wCtx = ctx;
			const list = Array.from(procs.values())
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
			wCtx = ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				persist();
				ctx.ui.notify(`Grid: ${gridCols} columns`, "info");
				invalidate();
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
				enabled = true;
				persist();

				await killAll();
				procs.clear();

				loadAgents(ctx.cwd);
				tmuxCwd = ctx.cwd;

				const names = Object.keys(teams);
				const teamToActivate = (activeTeam && names.includes(activeTeam)) ? activeTeam : (names[0] || "");
				if (teamToActivate) {
					await activateTeam(teamToActivate);
				}

				openSessionLog();
				createSessionPane();

				pi.setActiveTools(["dispatch_agent", "askUserQuestion"]);
				invalidate();
				const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
				ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
				await ctx.ui.notify(`✓ Agent team enabled — Team: ${activeTeam} (${members}) — agents spawn on-demand`);
			} else if (sub === "off") {
				enabled = false;
				persist();
				await killAll();
				wCtx = ctx;
				pi.setActiveTools(pi.getAllTools().map(t => t.name));
				invalidate();
				await ctx.ui.notify("✓ Agent team disabled - all subagent processes killed");
			} else if (sub === "status") {
				await ctx.ui.notify(enabled ? "Agent team is enabled" : "Agent team is disabled");
			} else {
				await ctx.ui.notify("Usage: /agents-team-toggle on|off|status");
			}
		},
	});

	pi.registerCommand("agents-restart", {
		description: "Kill any running subagent processes",
		handler: async (_args, ctx) => {
			wCtx = ctx;
			if (!enabled) { ctx.ui.notify("Agent team is disabled. Use /agents-team-toggle on", "warning"); return; }
			ctx.ui.notify("Killing all running subagent processes...", "info");
			await killAll();
			ctx.ui.notify("All subagent processes killed", "success");
			invalidate();
		},
	});



	// ── System Prompt Override ──────────────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!enabled) return;

		// Sync orchestrator model on each turn
		// Use provider-prefixed ID (e.g. "zai/glm-5.1") to avoid ambiguous resolution
		// when multiple providers define the same model ID (e.g. "glm-5.1" exists
		// under opencode, opencode-go, and zai providers)
		const m = _ctx.model;
		const newModel = m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "";
		if (newModel && newModel !== orchestratorModel) {
			orchestratorModel = newModel;
			// Update subagents that don't have their own model
			for (const ap of procs.values()) {
				if (!ap.def.model) ap.model = orchestratorModel;
			}
		}

		const catalog = Array.from(procs.values())
			.map(a => {
				const alive = a.proc ? "alive" : "dead";
				return `### ${displayName(a.def.name)}\n**Dispatch as:** \`${a.def.name}\` [${alive}]\n${a.def.description}\n**Tools:** ${a.def.tools}`;
			})
			.join("\n\n");

		const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
                const t0 = Date.now();
		const cwd = process.cwd();
		return {
			systemPrompt: `You are a dispatcher. Delegate ALL work via dispatch_agent. No direct file access.
Team: ${activeTeam} | Members: ${members}
Each dispatch is fresh — include ALL context. One dispatch at a time. On error: notify user + suggest fix.
- Only ONE agent can be dispatched at a time

## Rules
- NEVER try to read, write, or execute code directly - you have no such tools
- ALWAYS use dispatch_agent to get work done
## Agents

${catalog}

Date: ${new Date(t0).toISOString().split("T")[0]} | CWD: ${cwd}
`,
		};
	});

	// ── Session Start ───────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clean up any leftover processes
		await killAll();

		if (wCtx) { wCtx.ui.setWidget("agent-team", undefined); wInvalidate = null; }
		wCtx = _ctx;
		const m0 = _ctx.model;
		orchestratorModel = m0 ? (m0.provider ? `${m0.provider}/${m0.id}` : m0.id) : "";

		loadAgents(_ctx.cwd);
		tmuxCwd = _ctx.cwd;

		initWidget();

		if (!enabled) {
			_ctx.ui.notify(
				"Agent team is disabled. Use /agents-team-toggle on to enable.",
				"info",
			);
			return;
		}

		// Restore saved team or default to first — NO spawning
		const names = Object.keys(teams);
		const savedTeam = _saved.activeTeam || "";
		const restoreTeam = (savedTeam && names.includes(savedTeam)) ? savedTeam : (names[0] || "");
		if (restoreTeam) await activateTeam(restoreTeam);

		// Open combined session log + create single tmux pane
		openSessionLog();
		createSessionPane();

		// Lock to dispatcher-only tools
		pi.setActiveTools(["dispatch_agent", "askUserQuestion"]);

		_ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
		const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
		_ctx.ui.notify(
			`Team: ${activeTeam} (${members}) — agents spawn on-demand per task\n\n` +
			`/agents-team          Select a team\n` +
			`/agents-list          List agents + process status\n` +
			`/agents-grid <1-6>    Set grid columns\n` +
			`/agents-restart       Kill any running subagent processes`,
			"info",
		);
		invalidate();
	});

	// ── Session Shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		persist();
		await killAll(true);
	});


}
