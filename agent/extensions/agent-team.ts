/**
 * Agent Team - Persistent subagent orchestrator
 *
 * Each subagent runs as a long-lived `pi --mode rpc` process in its own tmux
 * pane. The orchestrator sends tasks via RPC prompt commands and reads
 * streaming JSONL events. The SAME process is reused for every dispatch -
 * no respawn between tasks. Context accumulates within each subagent's
 * session file.
 *
 * Lifecycle:
 *   session_start  → spawn ALL subagents + create tmux panes
 *   dispatch       → send RPC prompt to existing process, await agent_end
 *   session_end    → kill ALL processes + close tmux panes
 *
 * Commands:
 *   /agents-team          - switch active team
 *   /agents-list          - list agents + process status
 *   /agents-grid N        - set grid columns (default 1)
 *   /agents-team-toggle   - enable/disable (on/off/status)
 *   /agents-restart       - restart all subagent processes
 *   /agents-autocompact   - toggle auto-compact for subagents (on/off/status)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "child_process";
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
	tokensUsed: number;      // last known input token usage
	tokensOut: number;       // last known output token usage
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
	logFile: string;
	logStream: WriteStream | null;
	tmuxPaneId: string | null;
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
	autocompact: boolean;
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
	let autocompact = _saved.autocompact ?? true; // auto-compact subagents when ctx > 60%
	const AUTOCOMPACT_THRESHOLD = 0.60;
	let tmuxCwd = "";
	let cachedExtPaths: string[] = []; // resolved once per session_start
	let orchestratorModel = ""; // model id from orchestrator's context

	// Persist current runtime state to disk
	function persist() {
		savePersistedConfig({
			activeTeam,
			gridCols,
			enabled,
			autocompact,
		});
	}

	// ── Logging ─────────────────────────────────────────────────────
	//
	//  Log format uses Unicode box-drawing characters, no ANSI codes.
	//  Each major lifecycle phase (spawn, task, error) gets its own box.
	//
	//  ╭── Scout · model-name ──────────────────────╮
	//  │ SPAWN  rpc model=...                        │
	//  │ READY ✓ cmd=get_state success=true          │
	//  ╰────────────────────────────────────────────╯
	//
	//  ╭── Task #1 ─────────────────────────────────╮
	//  │ Search for configuration files...           │
	//  │                                            │
	//  │  ┌ grep pattern=... path=...               │
	//  │  └ ✓ grep (42ms)                           │
	//  │                                            │
	//  │  (streaming text)                           │
	//  ╰── DONE  77s · 13 tools ───────────────────╯

	const LOG_WIDTH = 60; // target width for box borders

	function openLog(ap: AgentProc) {
		ap.logFile = join(logDir, `${agentKey(ap)}.log`);
		writeFileSync(ap.logFile, "");
		ap.logStream = createWriteStream(ap.logFile, { flags: "a" });
	}

	/** Agent header: "Scout · model-name" */
	function agentLabel(ap: AgentProc): string {
		return `${displayName(ap.def.name)} · ${shortModel(ap.model)}`;
	}

	function tag(ap: AgentProc, heading: string): string {
		return `[${displayName(ap.def.name)}][${shortModel(ap.model)}] - ${heading}`;
	}

	// ── Low-level write helpers ──

	function log(ap: AgentProc, msg: string) {
		if (ap.logStream) ap.logStream.write(msg + "\n");
	}

	function logRaw(ap: AgentProc, msg: string) {
		if (ap.logStream) ap.logStream.write(msg);
	}

	function closeLog(ap: AgentProc) {
		if (ap.logStream) { try { ap.logStream.end(); } catch {} ap.logStream = null; }
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

	function logSpawnBox(ap: AgentProc, model: string) {
		log(ap, "");
		log(ap, hrPad(` ${agentLabel(ap)} `, LOG_WIDTH, "╭", "╮"));
		log(ap, boxLine(`SPAWN  rpc model=${model}`, LOG_WIDTH));
	}

	function logReadyOk(ap: AgentProc, cmd: string, success: boolean) {
		log(ap, boxLine(`READY ✓ cmd=${cmd} success=${success}`, LOG_WIDTH));
		log(ap, hrPad("", LOG_WIDTH, "╰", "╯"));
		log(ap, "");
	}

	function logTaskBox(ap: AgentProc, taskNum: number, task: string) {
		log(ap, "");
		log(ap, hrPad(` Task #${taskNum} `, LOG_WIDTH, "╭", "╮"));
		const inner = LOG_WIDTH - 4;
		const words = task.split(" ");
		let line = "";
		for (const w of words) {
			if (line && [...line].length + 1 + [...w].length > inner) {
				log(ap, boxLine(line, LOG_WIDTH));
				line = w;
			} else {
				line = line ? line + " " + w : w;
			}
		}
		if (line) log(ap, boxLine(line, LOG_WIDTH));
		log(ap, "");
	}

	function logToolStart(ap: AgentProc, tool: string, detail: string) {
		const info = detail ? ` ${detail}` : "";
		log(ap, boxLine(`┌ ${tool}${info}`, LOG_WIDTH));
	}

	function logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
		const icon = ok ? "✓" : "✗";
		const dur = durMs ? ` (${Math.round(durMs)}ms)` : "";
		log(ap, boxLine(`└ ${icon} ${tool}${dur}`, LOG_WIDTH));
	}

	function logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
		log(ap, "");
		log(ap, hrPad(` DONE  ${elapsedSec}s · ${tools} tools `, LOG_WIDTH, "╰", "╯"));
		log(ap, "");
	}

	function logErrorBox(ap: AgentProc, heading: string, detail: string) {
		log(ap, "");
		log(ap, hrPad(` ✗ ${agentLabel(ap)} `, LOG_WIDTH, "╭", "╮"));
		log(ap, boxLine(heading, LOG_WIDTH));
		if (detail) log(ap, boxLine(detail, LOG_WIDTH));
		log(ap, hrPad("", LOG_WIDTH, "╰", "╯"));
		log(ap, "");
	}

	// ── Tmux Panes ──────────────────────────────────────────────────

	function createPanes() {
		if (!enabled) return;
		if (!process.env.TMUX) return;
		const list = Array.from(procs.values()).filter(ap => ap.logFile);
		if (!list.length) return;

		const cwd = (tmuxCwd || process.cwd()).replace(/'/g, "'\\''");
		const origPane = process.env.TMUX_PANE || "";
		const lines: string[] = [];
		const n = list.length;

		for (let i = 0; i < n; i++) {
			const ap = list[i];
			const label = displayName(ap.def.name).replace(/'/g, "'\\''");
			const lf = ap.logFile.replace(/'/g, "'\\''");

			if (i === 0) {
				// First pane: vertical split from main (fixed height)
				lines.push(`P${i}=$(tmux split-window -v -d -l 8 -c '${cwd}' -P -F '#{pane_id}')`);
			} else if (n === 2) {
				// 2 agents: split the first subagent pane at 50%
				lines.push(`P${i}=$(tmux split-window -h -d -p 50 -t $P0 -c '${cwd}' -P -F '#{pane_id}')`);
			} else {
				// 3+ agents: split from previous pane, calculate percentage for even widths
				// Each split takes (100/(n-i))% of the source pane's width.
				// This ensures all n subagent panes end up equal width.
				const pct = Math.round(100 / (n - i));
				lines.push(`P${i}=$(tmux split-window -h -d -p ${pct} -t $P${i - 1} -c '${cwd}' -P -F '#{pane_id}')`);
			}
			lines.push(`tmux select-pane -t $P${i} -T '${label}'`);
			lines.push(`tmux send-keys -t $P${i} 'tail -n +1 -f ${lf}' Enter`);
			lines.push(`echo $P${i}`);
		}

		if (origPane) lines.push(`tmux select-pane -t ${origPane}`);
		lines.push("tmux select-layout -E");

		const child = spawn("sh", ["-c", lines.join("\n")], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (d: string) => { out += d; });
		child.on("close", () => {
			const ids = out.trim().split("\n").filter(Boolean);
			for (let i = 0; i < ids.length && i < list.length; i++) {
				list[i].tmuxPaneId = ids[i].trim();
			}
		});
	}

	function createSinglePane(ap: AgentProc) {
		if (!enabled) return;
		if (!process.env.TMUX || !ap.logFile || ap.tmuxPaneId) return;
		const cwd = (tmuxCwd || process.cwd()).replace(/'/g, "'\\''");
		const label = displayName(ap.def.name).replace(/'/g, "'\\''");
		const lf = ap.logFile.replace(/'/g, "'\\''");
		const origPane = process.env.TMUX_PANE || "";
		const script = [
			`P=$(tmux split-window -v -d -l 8 -c '${cwd}' -P -F '#{pane_id}')`,
			`tmux select-pane -t $P -T '${label}'`,
			`tmux send-keys -t $P 'tail -n +1 -f ${lf}' Enter`,
			`echo $P`,
			`tmux select-pane -t ${origPane}`,
		].join("\n");
		const ch = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
		let pid = "";
		ch.stdout.setEncoding("utf-8");
		ch.stdout.on("data", (d: string) => { pid += d; });
		ch.on("close", () => { const id = pid.trim(); if (id) ap.tmuxPaneId = id; });
	}

	function killPanes() {
		const ids: string[] = [];
		for (const ap of procs.values()) {
			closeLog(ap);
			if (ap.tmuxPaneId) { ids.push(ap.tmuxPaneId); ap.tmuxPaneId = null; }
		}
		if (!ids.length) return;
		spawn("sh", ["-c", ids.map(id => `tmux kill-pane -t ${id}`).join("\n")], { stdio: "ignore" });
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
		closeLog(ap);
		cleanSystemPrompt(ap);
		ap.status = "dead";
		ap.ready = false;
		ap.stdoutBuf = "";
		clearTimers(ap);
	}

	async function killAll() {
		killPanes();
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
		ap.systemPromptFile = join(sessionDir, `${agentKey(ap)}-system-prompt.txt`);
		writeFileSync(ap.systemPromptFile, `You are working in the project cwd.\n\n ${ap.def.systemPrompt}`);
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

		logSpawnBox(ap, model);
		const proc = spawn(bin, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		ap.proc = proc;
		invalidate();

		// Read JSONL events from stdout
		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
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
		proc.stderr!.on("data", (d: string) => logRaw(ap, d));

		proc.on("error", (err) => {
			logErrorBox(ap, "PROCESS ERROR", err.message);
			ap.status = "error";
			ap.lastWork = `Error: ${err.message}`;
			resolveIfPending(ap, `Process error: ${err.message}`, 1);
			ap.proc = null;
		});

		proc.on("close", (code) => {
			logErrorBox(ap, `PROCESS EXIT code=${code}`, "");
			resolveIfPending(ap, `Process exited with code ${code}`, code ?? 1);
			ap.proc = null;
			ap.status = "dead";
			ap.ready = false;
			clearTimers(ap);
			invalidate();
		});

		// ── Readiness probe: send get_state, wait for response ──
		log(ap, boxLine("Waiting for RPC readiness...", LOG_WIDTH));

		return new Promise<boolean>((resolve) => {
			// Give process 15s to become ready
			const readyTimeout = setTimeout(() => {
				if (!ap.ready) {
					logErrorBox(ap, "READY TIMEOUT", `status=${ap.status}`);
					ap.status = ap.proc ? "idle" : "dead";
					ap.ready = true;
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

	async function spawnAll() {
		// Spawn agents sequentially - avoids resource contention when
		// multiple `pi --mode rpc` processes fork simultaneously.
		for (const ap of procs.values()) {
			openLog(ap);
			await spawnProc(ap);
		}
		createPanes();
	}

	// ── Resolve helper ──────────────────────────────────────────────

	function resolveIfPending(ap: AgentProc, output: string, code: number) {
		if (!ap.resolveDispatch) return;
		const resolve = ap.resolveDispatch;
		ap.resolveDispatch = null;
		clearTimers(ap);
		resolve(output, code);
	}

	/** Send compact RPC command to subagent */
	function triggerCompact(ap: AgentProc, pct: number) {
		if (!ap.proc?.stdin.writable) return;
		const pctStr = Math.round(pct * 100);
		log(ap, boxLine(`AUTOCOMPACT ctx=${pctStr}% > ${Math.round(AUTOCOMPACT_THRESHOLD * 100)}% — sending compact`, LOG_WIDTH));
		if (wCtx) {
			wCtx.ui.notify(tag(ap, `autocompact ctx=${pctStr}%`), "info");
		}
		try {
			ap.proc.stdin.write(JSON.stringify({ type: "compact" }) + "\n");
		} catch {
			log(ap, boxLine(`AUTOCOMPACT failed to write`, LOG_WIDTH));
		}
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
				logReadyOk(ap, ev.command, ev.success);
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
				logRaw(ap, chunk);
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
				ap.tokensUsed = u.input || 0;
				ap.tokensOut = u.output || 0;
				if (u.totalTokens) ap.tokensUsed = u.totalTokens - ap.tokensOut;
			}
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

			// Autocompact: if context usage > threshold, send compact command
			if (autocompact && ap.contextWindow > 0 && ap.tokensUsed > 0) {
				const pct = ap.tokensUsed / ap.contextWindow;
				if (pct > AUTOCOMPACT_THRESHOLD) {
					triggerCompact(ap, pct);
				}
			}

			return;
		}

		// Compaction events (from autocompact or manual)
		if (ev.type === "compaction_start") {
			log(ap, boxLine(`COMPACT start (reason: ${ev.reason || "auto"})`, LOG_WIDTH));
			return;
		}
		if (ev.type === "compaction_end") {
			if (ev.aborted) {
				log(ap, boxLine(`COMPACT aborted`, LOG_WIDTH));
			} else {
				log(ap, boxLine(`COMPACT done (${ev.reason || "auto"})`, LOG_WIDTH));
			}
			return;
		}

		// Auto-retry events: log for visibility (dispatch already resolved on agent_end)
		if (ev.type === "auto_retry_start") {
			log(ap, boxLine(`AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`, LOG_WIDTH));
			return;
		}
		if (ev.type === "auto_retry_end") {
			log(ap, boxLine(`AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`, LOG_WIDTH));
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
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				runCount: 0,
				ready: false,
				readyResolve: null,
				systemPromptFile: "",
				resolveDispatch: null,
				sessionFile: "",
				logFile: "",
				logStream: null,
				tmuxPaneId: null,
			});
		}

		await spawnAll();
	}

	// ── Dispatch ────────────────────────────────────────────────────

	const DISPATCH_TIMEOUT = 600_000; // 10 minutes

	async function dispatch(agentName: string, task: string): Promise<{ output: string; code: number; elapsed: number }> {
		const ap = procs.get(agentName.toLowerCase());
		if (!ap) {
			const available = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${available}`,
				code: 1, elapsed: 0,
			});
		}

		if (ap.status === "running" || ap.status === "starting") {
			// Check if process is actually dead (zombie detection)
			if (ap.proc && (ap.proc.exitCode !== null || ap.proc.signalCode !== null)) {
				// Process is dead but close event may not have fired
				killProc(ap, true);
				log(ap, boxLine("Detected zombie process - force-killed", LOG_WIDTH));
			} else {
				return { output: `${displayName(ap.def.name)} is ${ap.status}. Wait for it to finish.`, code: 1, elapsed: 0 };
			}
		}

		// If status is "error" from a previous timeout, process may still be alive - kill it
		if (ap.status === "error" && ap.proc) {
			log(ap, boxLine("Previous error state - killing stale process", LOG_WIDTH));
			killProc(ap, true);
		}

		// Auto-respawn only if process actually died
		if (!ap.proc || ap.status === "dead" || ap.status === "error") {
			openLog(ap);
			const started = await spawnProc(ap);
			if (!started) {
				return { output: `${displayName(ap.def.name)} failed to start.`, code: 1, elapsed: 0 };
			}
			// Re-create tmux pane for this agent
			createSinglePane(ap);
		}

		// spawnProc already waits for readiness - just verify
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
			ap.proc!.stdin.write(cmd);
		} catch (err: any) {
			clearInterval(ap.timer);
			ap.status = "error";
			invalidate();
			return { output: `Write error: ${err.message}`, code: 1, elapsed: 0 };
		}

		return new Promise<{ output: string; code: number; elapsed: number }>((resolve) => {
			// Timeout safety net - KILL the stuck process so it respawns cleanly
			ap.dispatchTimeout = setTimeout(() => {
				logErrorBox(ap, "TIMEOUT", `after ${Math.round(DISPATCH_TIMEOUT / 1000)}s - force-killing process`);
				ap.lastWork = "Timed out";
				killProc(ap, true);
				resolveIfPending(ap, `Dispatch timed out after ${Math.round(DISPATCH_TIMEOUT / 1000)}s`, 1);
				if (wCtx) wCtx.ui.notify(tag(ap, `TIMEOUT (${Math.round(DISPATCH_TIMEOUT / 1000)}s) — killed`), "error");
				invalidate();
			}, DISPATCH_TIMEOUT);

			ap.resolveDispatch = (output, code) => {
				// timeout cleanup handled by resolveIfPending - don't double-clear
				resolve({ output, code, elapsed: ap.elapsed });
			};
		});
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
		const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "..." : s;

		const statusColor = ap.status === "idle" ? "dim"
			: ap.status === "starting" ? "warning"
			: ap.status === "running" ? "accent"
			: ap.status === "done" ? "success" : "error";
		const statusIcon = ap.status === "idle" ? "○"
			: ap.status === "starting" ? "◐"
			: ap.status === "running" ? "●"
			: ap.status === "done" ? "✓" : "✗";

		const name = displayName(ap.def.name);
		const sm = shortModel(ap.model);
		const modelStr = sm ? ` (${sm})` : "";
		const timeStr = (ap.status === "running" || ap.status === "starting") ? ` ${Math.round(ap.elapsed / 1000)}s` : "";
		const plug = ap.proc ? "🔌" : "💀";
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
			const tokenStr = `ctx ${fmtTok(ap.tokensUsed)}/${fmtTok(ap.contextWindow)}`;
			const outStr = `out ${fmtTok(ap.tokensOut)}`;
			const pctStr = `${pct}%`;

			const line2 = theme.fg(barColor, bar) + " " +
				theme.fg("dim", tokenStr) + " " +
				theme.fg(barColor, pctStr) + " " +
				theme.fg("dim", outStr);
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
		description: "Dispatch a task to a persistent specialist agent. The agent process stays alive across dispatches - context accumulates. See system prompt for available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent" }),
		}),

		async execute(_id, params, _sig, onUpdate, _ctx) {
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
					details: { agent, task, status, elapsed: r.elapsed, exitCode: r.code, fullOutput: isLarge ? truncated : r.output },
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

				// Kill old sessions, reload agents, spawn new processes + tmux panes
				await killAll();
				procs.clear();

				loadAgents(ctx.cwd);
				tmuxCwd = ctx.cwd;

				const names = Object.keys(teams);
				const teamToActivate = (activeTeam && names.includes(activeTeam)) ? activeTeam : (names[0] || "");
				if (teamToActivate) {
					await activateTeam(teamToActivate);
				}

				pi.setActiveTools(["dispatch_agent", "askUserQuestion"]);
				invalidate();
				const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
				ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
				await ctx.ui.notify(`✓ Agent team enabled — Team: ${activeTeam} (${members})`);
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
		description: "Restart all subagent processes",
		handler: async (_args, ctx) => {
			wCtx = ctx;
			if (!enabled) { ctx.ui.notify("Agent team is disabled. Use /agents-team-toggle on", "warning"); return; }
			ctx.ui.notify("Restarting all subagent processes...", "info");
			await killAll();
			await spawnAll();
			ctx.ui.notify(`Restarted ${procs.size} agents`, "success");
			invalidate();
		},
	});

	pi.registerCommand("agents-autocompact", {
		description: "Toggle auto-compact subagents when ctx > 60% (on/off/status)",
		handler: async (args, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
			if (sub === "on") {
				autocompact = true;
				persist();
				await ctx.ui.notify("✓ Subagent autocompact enabled (triggers when ctx > 60%)");
			} else if (sub === "off") {
				autocompact = false;
				persist();
				await ctx.ui.notify("✓ Subagent autocompact disabled");
			} else {
				const status = autocompact ? "enabled" : "disabled";
				await ctx.ui.notify(`Subagent autocompact is ${status} (threshold: ${Math.round(AUTOCOMPACT_THRESHOLD * 100)}%)
Usage: /agents-autocompact on|off`);
			}
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
			systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through agents using the dispatch_agent tool.

## Active Team: ${activeTeam}
Members: ${members}

All subagents are **persistent processes** - they stay alive for the entire session.
Each agent retains full conversation context from previous dispatches.
You CAN dispatch the same agent multiple times - it reuses the same process and remembers prior context.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Dispatch tasks to the right agent using dispatch_agent
- Review results and dispatch follow-up tasks if needed
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused - one clear objective per dispatch
- Only ONE agent can be dispatched at a time

## Rules
- NEVER try to read, write, or execute code directly - you have no such tools
- ALWAYS use dispatch_agent to get work done
- Summarize the outcome for the user
- **Error handling**: If dispatch_agent returns an error (code !== 0), you MUST:
  1. Immediately notify the user with the agent name and error details
  2. Explain what went wrong in plain language
  3. Suggest a recovery action (retry, different agent, manual fix)
  4. Do NOT silently continue as if nothing happened

## Agents

${catalog}

Date : ${new Date(t0).toISOString().split("T")[0]}
Current Directory : ${cwd}
`,
		};
	});

	// ── Session Start ───────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clean up old processes
		await killAll();

		if (wCtx) { wCtx.ui.setWidget("agent-team", undefined); wInvalidate = null; }
		wCtx = _ctx;
		const m0 = _ctx.model;
		orchestratorModel = m0 ? (m0.provider ? `${m0.provider}/${m0.id}` : m0.id) : "";

		// Wipe old session files
		if (existsSync(sessionDir)) {
			for (const f of readdirSync(sessionDir)) {
				if (f.endsWith(".json")) try { unlinkSync(join(sessionDir, f)); } catch {}
			}
		}

		loadAgents(_ctx.cwd);
		tmuxCwd = _ctx.cwd;

		if (!enabled) {
			// Always show widget even when disabled
			initWidget();
			_ctx.ui.notify(
				"Agent team is disabled. Use /agents-team-toggle on to enable.",
				"info",
			);
			return;
		}

		// Restore saved team or default to first
		const names = Object.keys(teams);
		const savedTeam = _saved.activeTeam || "";
		const restoreTeam = (savedTeam && names.includes(savedTeam)) ? savedTeam : (names[0] || "");
		if (restoreTeam) await activateTeam(restoreTeam);

		// Lock to dispatcher-only tools
		pi.setActiveTools(["dispatch_agent", "askUserQuestion"]);

		_ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
		const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
		_ctx.ui.notify(
			`Team: ${activeTeam} (${members})\n` +
			`All ${procs.size} subagent processes spawned (persistent RPC)\n\n` +
			`/agents-team          Select a team\n` +
			`/agents-list          List agents + process status\n` +
			`/agents-grid <1-6>    Set grid columns\n` +
			`/agents-restart       Restart all subagent processes\n` +
			`/agents-autocompact   Toggle auto-compact (on/off/status)`,
			"info",
		);
		invalidate();
	});

	// ── Session Shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		persist();
		await killAll();
		if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
	});

	// Periodic animation refresh + health check
	// Tracked so we can clean up on session shutdown
	let healthInterval: ReturnType<typeof setInterval> | null = null;

	function startHealthCheck() {
		if (healthInterval) return; // prevent duplicates
		healthInterval = setInterval(() => {
			if (!enabled) return;
			animFrame++;
			// Health check: detect zombie/dead processes that didn't trigger close event
			for (const ap of procs.values()) {
				if (ap.proc && (ap.status === "idle" || ap.status === "done")) {
					try {
						if (ap.proc.exitCode !== null || ap.proc.signalCode !== null) {
							log(ap, boxLine(`Health check: process dead (exit=${ap.proc.exitCode})`, LOG_WIDTH));
							ap.status = "dead";
							ap.proc = null;
							ap.ready = false;
							if (wCtx) wCtx.ui.notify(tag(ap, "process died (detected by health check)"), "warning");
						}
					} catch {}
				}
			}
			invalidate();
		}, 3000);
	}

	startHealthCheck();
}
