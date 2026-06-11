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
	teamModel?: string;   // model override from teams.yaml (highest precedence)
	proc: ChildProcess | null;
	stdoutBuf: string;
	status: "idle" | "running" | "starting" | "done" | "error" | "dead";
	ready: boolean;
	readyResolve: (() => void) | null;
	task: string;
	collectedText: string;
	currentMessageText: string;   // accumulates text for the current assistant message
	lastAssistantText: string;   // text of the last completed assistant message
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
	lastActivity: number;          // timestamp of last received RPC event
	resetPongTimeout?: () => void; // resets the 10-min pong timer
	resolveDispatch: ((output: string, code: number) => void) | null;
	sessionFile: string;
	systemPromptFile: string;
	lastPromptHash?: string;
	streamLineBuf: string;   // partial line buffer for streaming text box-wrapping
}

interface TeamMember {
	name: string;
	model?: string;
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

/** Format token count: >=1000 → "1.2k", else raw */
const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Iterate files in multiple directories, deduplicating by name */
function scanDirs(dirs: string[], predicate: (name: string) => boolean): string[] {
	const paths: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const f of readdirSync(dir)) {
				if (predicate(f)) paths.push(resolve(dir, f));
			}
		} catch { }
	}
	return paths;
}

/** Create a blank AgentProc state object */
function blankProcState(): Omit<AgentProc, "def" | "model" | "teamModel"> {
	return {
		proc: null, stdoutBuf: "", status: "dead", ready: false, readyResolve: null,
		task: "", collectedText: "", currentMessageText: "", lastAssistantText: "",
		contextWindow: 0, tokensUsed: 0, tokensOut: 0,
		cacheRead: 0, cacheWrite: 0, cacheSavedTotal: 0,
		toolCount: 0, elapsed: 0, lastWork: "", runCount: 0,
		timer: undefined, dispatchTimeout: undefined, sigkillTimeout: undefined,
		lastActivity: 0, resetPongTimeout: undefined, resolveDispatch: null,
		sessionFile: "", systemPromptFile: "", lastPromptHash: undefined,
		streamLineBuf: "",
	};
}

	function clearTimers(ap: AgentProc) {
		clearInterval(ap.timer);
		if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
		if (ap.sigkillTimeout) { clearTimeout(ap.sigkillTimeout); ap.sigkillTimeout = undefined; }
	}

/** Reset mutable dispatch fields on an AgentProc (reuses blank state pattern) */
function resetForDispatch(ap: AgentProc) {
	ap.status = "dead";
	ap.ready = false;
	ap.readyResolve = null;
	ap.collectedText = "";
	ap.currentMessageText = "";
	ap.lastAssistantText = "";
	ap.stdoutBuf = "";
	ap.streamLineBuf = "";
	ap.resolveDispatch = null;
	ap.toolCount = 0;
	ap.task = "";
	ap.lastWork = "";
	ap.lastPromptHash = undefined;
	clearTimers(ap);
}

// ── Terminal Backend Abstraction ───────────────────────────────────────

interface TerminalBackend {
	detect(): boolean;
	getTerminalWidth(): number;
	createLogPane(cwd: string, logFile: string, origPaneId: string): string | null;
	resizePane(paneId: string, width: number): void;
	killPane(paneId: string): void;
	isValidPaneId(id: string): boolean;
}

class TmuxBackend implements TerminalBackend {
	detect(): boolean {
		return !!process.env.TMUX;
	}

	getTerminalWidth(): number {
		try {
			const r = spawnSync("tmux", ["display-message", "-p", "#{client_width}"], { encoding: "utf-8" });
			const w = parseInt(r.stdout?.trim() || "0", 10);
			return w > 0 ? w : 0;
		} catch { return 0; }
	}

	createLogPane(cwd: string, logFile: string, origPaneId: string): string | null {
		// Validate origPaneId to prevent shell injection in the tmux shell script
		if (origPaneId && !/^%\d+$/.test(origPaneId)) origPaneId = "";
		const escapedCwd = cwd.replace(/'/g, "'\\''");
		const lf = logFile.replace(/'/g, "'\\''");
		// Vertical split: pane takes full window width and auto-resizes with terminal.
		// Do NOT lock the width with `resize-pane -x` — it would prevent auto-resize.
		const script = [
			`P=$(tmux split-window -v -d -l 8 -c '${escapedCwd}' -P -F '#{pane_id}')`,
			`tmux select-pane -t $P -T 'Agent Team Log'`,
			`tmux send-keys -t $P 'tail -n +1 -f ${lf}' Enter`,
			`echo $P`,
			`tmux select-pane -t ${origPaneId}`,
		].join("\n");
		try {
			const r = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
			return r.stdout?.trim() || null;
		} catch { return null; }
	}

	resizePane(paneId: string, width: number): void {
		try {
			spawn("tmux", ["resize-pane", "-t", paneId, "-x", String(width)], { stdio: "ignore" });
		} catch { }
	}

	killPane(paneId: string): void {
		spawn("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
	}

	isValidPaneId(id: string): boolean {
		return /^%\d+$/.test(id);
	}
}

class HerdrBackend implements TerminalBackend {
	detect(): boolean {
		return process.env.HERDR_ENV === "1";
	}

	getTerminalWidth(): number {
		// 1) Explicit hint wins — herdr hosts can export HERDR_PANE_WIDTH at session start.
		const hint = parseInt(process.env.HERDR_PANE_WIDTH || "", 10);
		if (Number.isFinite(hint) && hint > 0) return hint;
		// 2) If stdio is still attached to the pane, stdout.columns reports its width.
		if (process.stdout && Number.isFinite(process.stdout.columns) && (process.stdout.columns as number) > 0) {
			return process.stdout.columns as number;
		}
		// 3) Fallback: typical herdr split is ~120 cols; the MIN/MAX clamp in updateLogWidth
		//    still bounds this to [60, 300] so the value is just a sensible seed.
		return 120;
	}

	createLogPane(cwd: string, logFile: string, _origPaneId: string): string | null {
		const paneId = process.env.HERDR_PANE_ID || "";
		if (!paneId) return null;
		try {
			// Split current pane downward. herdr returns a JSON envelope:
			// {"id":"cli:pane:split","result":{"pane":{"pane_id":"w<hex>-<n>", ...}}, "type":"pane_info"}
			const splitResult = spawnSync("herdr", ["pane", "split", paneId, "--direction", "down", "--cwd", cwd, "--no-focus"], { encoding: "utf-8" });
			if (splitResult.status !== 0) return null;
			let newId: string | undefined;
			try {
				const envelope = JSON.parse(splitResult.stdout || "");
				newId = envelope?.result?.pane?.pane_id;
			} catch {
				return null;
			}
			if (!newId || !this.isValidPaneId(newId)) return null;
			// Rename pane
			const renameResult = spawnSync("herdr", ["pane", "rename", newId, "Agent Team Log"], { encoding: "utf-8" });
			if (renameResult.status !== 0) return null;
			// Run tail command in new pane
			const runResult = spawnSync("herdr", ["pane", "run", newId, `tail -n +1 -f ${logFile}`], { encoding: "utf-8" });
			if (runResult.status !== 0) return null;
			return newId;
		} catch (e) {
			console.error("[agent-team/herdr] createLogPane failed:", e instanceof Error ? e.message : e);
			return null;
		}
	}

	resizePane(_paneId: string, _width: number): void {
		// herdr has no resize-pane command; no-op
	}

	killPane(paneId: string): void {
		spawn("herdr", ["pane", "close", paneId], { stdio: "ignore" });
	}

	isValidPaneId(id: string): boolean {
		// herdr pane IDs are `w<hex>-<n>` (e.g. w65385dc1da5392-2); case-insensitive on the hex portion.
		return /^w[0-9a-f]+-\d+$/i.test(id);
	}
}

function parseTeamsYaml(raw: string): Record<string, TeamMember[]> {
	const teams: Record<string, TeamMember[]> = {};
	let cur = "";
	let curMember: TeamMember | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const tm = line.match(/^(\S[^:]*):$/);
		if (tm) { cur = tm[1].trim(); teams[cur] = []; curMember = null; continue; }
		if (!cur) continue;
		// Named member: "  - name: worker"
		const nm = line.match(/^\s*-\s+name:\s*(.+)$/);
		if (nm) {
			curMember = { name: nm[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		// Simple string member: "  - worker"
		const im = line.match(/^\s*-\s+(\S+)$/);
		if (im) {
			curMember = { name: im[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		// Member property: "    model: foo"  (indented under a named member)
		const pm = line.match(/^\s{2,}(\w+):\s*(.+)$/);
		if (pm && curMember) {
			if (pm[1].trim() === "model") curMember.model = pm[2].trim();
			continue;
		}
	}
	return teams;
}

function parseAgentFile(fp: string): AgentDef | null {
	try {
		let raw = readFileSync(fp, "utf-8");
		raw = raw.replace(/\r\n/g, "\n"); // Normalize Windows line endings
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
		} catch { }
	}
	// Also load absolute-path extensions from settings.json (e.g. observability)
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (existsSync(settingsPath)) {
			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			for (const ext of (raw.extensions || [])) {
				if (typeof ext !== "string") continue;
				if (ext.startsWith("-")) continue; // disabled
				const resolved = ext.startsWith("/") ? ext : join(getAgentDir(), ext);
				if (existsSync(resolved) && !paths.includes(resolved)) paths.push(resolved);
			}
		}
	} catch { }
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
	} catch { }
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
	for (const fp of scanDirs(dirs, f => f.endsWith(".md"))) {
		const def = parseAgentFile(fp);
		if (def && !seen.has(def.name.toLowerCase())) {
			seen.add(def.name.toLowerCase());
			agents.push(def);
		}
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
	let teams: Record<string, TeamMember[]> = {};
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
	let sharedPaneId: string | null = null; // single terminal pane for combined session log
	let sessionLogFile = "";           // single combined log file path
	let sessionLogStream: WriteStream | null = null; // single combined log stream

	// ── Terminal backend auto-detection ────────────────────────────
	const _herdrBackend = new HerdrBackend();
	const _tmuxBackend = new TmuxBackend();
	const terminal: TerminalBackend = _herdrBackend.detect() ? _herdrBackend
		: _tmuxBackend.detect() ? _tmuxBackend
			: _tmuxBackend; // fallback to tmux (will be no-op if tmux not available)

	// Persist current runtime state to disk
	function persist() {
		savePersistedConfig({
			activeTeam,
			gridCols,
			enabled,
		});
	}
	// ── Logging ─────────────────────────────────────────────────────

	const MIN_logWidth = 60;
	const MAX_logWidth = 300;
	let logWidth = MIN_logWidth; // updated dynamically

	function getTerminalWidth(): number {
		return terminal.getTerminalWidth();
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
		if (sessionLogStream) { try { sessionLogStream.end(); } catch { } sessionLogStream = null; }
	}

	/** Agent header: "Scout · model-name" */
	function agentLabel(ap: AgentProc): string {
		return `${displayName(ap.def.name)} · ${shortModel(ap.model)}`;
	}

	function tag(ap: AgentProc, heading: string): string {
		return `[${displayName(ap.def.name)}][${shortModel(ap.model)}] - ${heading}`;
	}

	// ── Low-level write helpers ──

	function log(msg: string) {
		if (sessionLogStream) sessionLogStream.write(msg + "\n");
	}

	function logRaw(msg: string) {
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
		if (!sessionLogStream || !ap.streamLineBuf) return;
		sessionLogStream.write(boxLine(ap.streamLineBuf, logWidth) + "\n");
		ap.streamLineBuf = "";
	}

	// ── Box drawing helpers ──

	function hrPad(content: string, width: number, left: string, right: string, fill = "─"): string {
		const inner = width - left.length - right.length;
		const used = [...content].length; // unicode-aware length
		// 0 is valid: an empty closing line and a line that exactly fills `inner` both
		// want no fill, only the two corners. Using Math.max(1, …) inflated those by 1 cell
		// and shifted the right border left.
		const pad = Math.max(0, inner - used);
		return left + content + fill.repeat(pad) + right;
	}

	function boxLine(content: string, width: number): string {
		const inner = width - 4; // "│ " + " │"
		let body = content;
		if ([...content].length > inner) {
			// Reserve room for the marker so the total stays within `inner` cells.
			const marker = `…[+N]`;
			const cut = inner - marker.length;
			body = [...content].slice(0, Math.max(0, cut)).join("") + marker;
		}
		return hrPad(` ${body} `, width, "│", "│", " ");
	}

	// ── Structured log events ──


	function logTaskBox(ap: AgentProc, taskNum: number, task: string) {
		log("");
		log(`Date: ${new Date().toISOString()}`);
		log(hrPad(` Task #${taskNum} · ${agentLabel(ap)} `, logWidth, "╭", "╮"));
		const inner = logWidth - 4;
		for (const para of task.split("\n")) {
			const words = para.split(" ");
			let line = "";
			for (const w of words) {
				if (line && [...line].length + 1 + [...w].length > inner) {
					log(boxLine(line, logWidth));
					line = w;
				} else {
					line = line ? line + " " + w : w;
				}
			}
			if (line) log(boxLine(line, logWidth));
		}
	}

	function logToolStart(ap: AgentProc, tool: string, detail: string) {
		log(boxLine(`┌ ${tool}${detail ? " " + detail : ""}`, logWidth));
	}

	function logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
		log(boxLine(`└ ${ok ? "✓" : "✗"} ${tool}${durMs ? ` (${Math.round(durMs)}ms)` : ""}`, logWidth));
	}

	function logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
		log("")
		log(hrPad(` DONE  ${elapsedSec}s · ${tools} tools `, logWidth, "╰", "╯"));
	}

	function logErrorBox(ap: AgentProc, heading: string, detail: string) {
		log(hrPad(` ✗ ${agentLabel(ap)} `, logWidth, "╭", "╮"));
		log(boxLine(heading, logWidth));
		if (detail) log(boxLine(detail, logWidth));
		log(hrPad("", logWidth, "╰", "╯"));
	}

	// ── Terminal Panes ──────────────────────────────────────────────────

	function resizeSharedPane() {
		if (!sharedPaneId || !terminal.isValidPaneId(sharedPaneId)) return;
		const tw = terminal.getTerminalWidth();
		if (tw <= 0) return;
		terminal.resizePane(sharedPaneId, tw);
	}

	function handleTerminalResize() {
		updateLogWidth();
		resizeSharedPane();
		invalidate();
	}

	function createSessionPane() {
		if (!enabled) return;
		if (!terminal.detect()) return;
		if (!sessionLogFile) return;
		if (sharedPaneId) return; // pane already exists

		const cwd = (tmuxCwd || process.cwd());
		const origPane = process.env.TMUX_PANE || process.env.HERDR_PANE_ID || "";
		const id = terminal.createLogPane(cwd, sessionLogFile, origPane);
		if (id && terminal.isValidPaneId(id)) sharedPaneId = id;
	}

	function killPanes() {
		closeSessionLog();
		if (sharedPaneId && terminal.isValidPaneId(sharedPaneId)) {
			const id = sharedPaneId;
			sharedPaneId = null;
			terminal.killPane(id);
		}
	}

	// ── Spawn / Kill ────────────────────────────────────────────────


	function killProc(ap: AgentProc, immediate = false) {
		resolveIfPending(ap, ap.status === "running" || ap.status === "starting" ? "Process killed" : "", 1);
		if (ap.proc) {
			const dying = ap.proc;
			try {
				if (immediate) dying.kill("SIGKILL");
				else {
					dying.kill("SIGTERM");
					ap.sigkillTimeout = setTimeout(() => { try { dying.kill("SIGKILL"); } catch { } }, 2000);
				}
			} catch { }
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
		const content = `${ap.def.systemPrompt} \n\n **VERY IMPORTANT** If complete file is requested, refuse and give reason file is big please read without subagent`;
		if (ap.lastPromptHash === content) return; // skip if unchanged
		ap.lastPromptHash = content;
		ap.systemPromptFile = join(sessionDir, `${agentKey(ap)}-system-prompt.txt`);
		writeFileSync(ap.systemPromptFile, content);
	}

	function cleanSystemPrompt(ap: AgentProc) {
		if (ap.systemPromptFile) {
			try { unlinkSync(ap.systemPromptFile); } catch { }
		}
	}

	function spawnProc(ap: AgentProc): Promise<boolean> {
		// Ensure clean slate
		if (ap.proc) killProc(ap);
		resetForDispatch(ap);

		ap.status = "starting";
		ap.sessionFile = join(sessionDir, `${agentKey(ap)}.json`);

		// Write system prompt to temp file to avoid CLI escaping issues
		writeSystemPrompt(ap);

		// Sync model: if agent def has no model, always use current orchestrator model
		const model = ap.teamModel || ap.def.model || orchestratorModel || "google/gemini-2.5-flash";
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
			...cachedExtPaths.flatMap(p => ["--extension", p]),
			...(provider ? ["--provider", provider] : []),
			"--model", modelName,
			"--tools", ap.def.tools,
			"--system-prompt", ap.systemPromptFile,
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
			for (const line of d.split("\n")) if (line.trim()) log(line);
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
				} catch { }
			}, 500);
		});
	}



	/** Safely delete session file if it exists */
	function wipeSessionFile(ap: AgentProc) {
		if (ap.sessionFile && existsSync(ap.sessionFile)) {
			try { unlinkSync(ap.sessionFile); } catch { }
		}
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

	// Map of event type → log message formatter for simple delegation
	const simpleLogEvents: Record<string, (ev: any) => string> = {
		compaction_start: (ev) => `COMPACT start (reason: ${ev.reason || "auto"})`,
		compaction_end: (ev) => ev.aborted ? `COMPACT aborted` : `COMPACT done (${ev.reason || "auto"})`,
		auto_retry_start: (ev) => `AUTO-RETRY attempt ${ev.attempt}/${ev.maxAttempts} (${ev.delayMs}ms)`,
		auto_retry_end: (ev) => `AUTO-RETRY ${ev.success ? "succeeded" : "failed"} (attempt ${ev.attempt})`,
	};

	function handleEvent(ap: AgentProc, line: string) {
		let ev: any;
		try { ev = JSON.parse(line); } catch { return; }

		if (ap.status === "running") {
			ap.lastActivity = Date.now();
			ap.resetPongTimeout?.();
		}

		switch (ev.type) {
			case "response": return handleResponse(ap, ev);
			case "message_update": return handleMessageUpdate(ap, ev);
			case "message_end": return handleMessageEnd(ap, ev);
			case "tool_execution_start": return handleToolStart(ap, ev);
			case "tool_execution_end": return handleToolEnd(ap, ev);
			case "agent_end": return handleAgentEnd(ap, ev);
			case "extension_ui_request": return autoRespondUI(ap, ev);
			default: {
				const fmt = simpleLogEvents[ev.type];
				if (fmt) log(boxLine(fmt(ev), logWidth));
			}
		}
	}

	function handleResponse(ap: AgentProc, ev: any) {
		if (!ap.ready) {
			ap.ready = true;
			ap.status = "idle";
			if (ev.success && ev.data?.model?.contextWindow) {
				ap.contextWindow = ev.data.model.contextWindow;
			}
			invalidate();
			if (ap.readyResolve) { ap.readyResolve(); ap.readyResolve = null; }
		}
		if (!ev.success && ap.status === "running" && ap.resolveDispatch) {
			const errMsg = ev.error || `${ev.command} failed`;
			logErrorBox(ap, "PROMPT ERROR", errMsg);
			ap.lastWork = `Error: ${errMsg}`;
			ap.status = "error";
			invalidate();
			resolveIfPending(ap, errMsg, 1);
		}
	}

	function handleMessageUpdate(ap: AgentProc, ev: any) {
		const delta = ev.assistantMessageEvent;
		if (delta?.type !== "text_delta") return;
		const chunk = delta.delta || "";
		ap.collectedText += chunk;
		ap.currentMessageText += chunk;
		logStreamingText(ap, chunk);
		const lastNl = chunk.lastIndexOf("\n");
		const tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
		if (tail.trim()) ap.lastWork = tail.slice(0, 80);
	}

	function handleMessageEnd(ap: AgentProc, ev: any) {
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
		flushStreamBuf(ap);
		if (ap.currentMessageText.trim()) ap.lastAssistantText = ap.currentMessageText;
		ap.currentMessageText = "";
		invalidate();
	}

	function handleToolStart(ap: AgentProc, ev: any) {
		ap.toolCount++;
		let detail = "";
		const args = ev.args;
		if (args && typeof args === "object") {
			detail = Object.entries(args)
				.filter(([, v]) => typeof v === "string")
				.map(([k, v]) => `${k}=${(v as string).slice(0, 80)}`)
				.join(" ");
		}
		logToolStart(ap, ev.toolName, detail);
		invalidate();
	}

	function handleToolEnd(ap: AgentProc, ev: any) {
		logToolEnd(ap, ev.toolName, !ev.isError, ev.durationMs);
	}

	function handleAgentEnd(ap: AgentProc, _ev: any) {
		clearInterval(ap.timer);
		flushStreamBuf(ap);

		const output = ap.lastAssistantText
			|| ap.currentMessageText.trim()
			|| ap.collectedText.trim()
			|| "(no output)";

		logDoneBox(ap, Math.round(ap.elapsed / 1000), ap.toolCount);
		ap.status = "done";
		ap.lastWork = extractLastLine(output);

		ap.collectedText = "";
		ap.currentMessageText = "";
		ap.lastAssistantText = "";

		invalidate();

		if (wCtx) {
			wCtx.ui.notify(
				tag(ap, `done (${Math.round(ap.elapsed / 1000)}s, ${ap.toolCount} tools)`),
				"success",
			);
		}

		resolveIfPending(ap, output, 0);
	}

	/** Extract last non-empty line from text */
	function extractLastLine(text: string): string {
		let scanFrom = text.length - 1;
		while (scanFrom >= 0) {
			const nl = text.lastIndexOf("\n", scanFrom);
			const seg = text.slice(nl + 1, scanFrom + 1).trim();
			if (seg) return seg;
			scanFrom = nl - 1;
		}
		return "";
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
		try { ap.proc.stdin.write(JSON.stringify(resp) + "\n"); } catch { }
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
		if (!Object.keys(teams).length) teams = { all: allDefs.map(d => ({ name: d.name })) };
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
			const def = byName.get(m.name.toLowerCase());
			if (!def) continue;
			procs.set(def.name.toLowerCase(), {
				def,
				teamModel: m.model,
				model: m.model || def.model || orchestratorModel || "",
				...blankProcState(),
			});
		}
	}

	// ── Dispatch ────────────────────────────────────────────────────

	const MAX_RESPONSE_LENGTH = 20000; // Subagent tool-result cap. Keep the marker string in dispatch_agent in sync.
	const PONG_TIMEOUT = 600_000;  // 10 min — reset on every activity

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

		wipeSessionFile(ap);

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
		ap.lastActivity = Date.now();
		invalidate();

		const t0 = Date.now();
		ap.timer = setInterval(() => {
			ap.elapsed = Date.now() - t0;
			invalidate();
		}, 500);

		// ── Activity-based timeout ──
		// Resets on every RPC event (streaming, tool calls, responses, etc.)
		// If 10 min passes with no activity → stuck → kill
		const doResetPongTimeout = () => {
			if (ap.dispatchTimeout) clearTimeout(ap.dispatchTimeout);
			ap.dispatchTimeout = setTimeout(() => {
				const silence = Math.round((Date.now() - ap.lastActivity) / 1000);
				logErrorBox(ap, "NO ACTIVITY", `no event for ${silence}s — force-killing`);
				ap.lastWork = `Timed out (${silence}s silence)`;
				resolveIfPending(ap, `No activity for ${silence}s — killed`, 1);
				killProc(ap, true);
				if (wCtx) wCtx.ui.notify(tag(ap, `NO ACTIVITY (${silence}s) — killed`), "error");
				invalidate();
			}, PONG_TIMEOUT);
		};
		ap.resetPongTimeout = doResetPongTimeout;

		doResetPongTimeout(); // start initial 10-min timer

		logTaskBox(ap, ap.runCount, task);

		const cmdPayload = { type: "prompt", message: task };
		try {
			if (!ap.proc?.stdin?.writable) {
				clearInterval(ap.timer);
				ap.status = "error";
				invalidate();
				return { output: `Process died before task could be sent`, code: 1, elapsed: 0 };
			}
			ap.proc.stdin.write(JSON.stringify(cmdPayload) + "\n");
		} catch (err: any) {
			clearInterval(ap.timer);
			ap.status = "error";
			invalidate();
			return { output: `Write error: ${err.message}`, code: 1, elapsed: 0 };
		}

		const result = await new Promise<{ output: string; code: number; elapsed: number }>((resolve) => {
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

		// Task complete — kill the subagent process but KEEP the terminal pane alive
		// so the user can scroll back and see what the agent did.
		// The pane will be reused on the next dispatch (same agent = same pane).
		killProc(ap, true);

		wipeSessionFile(ap);

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

		process.stdout.on("resize", handleTerminalResize);
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

			const tokenStr = `In=${fmtTok(ap.tokensUsed)}  Out=${fmtTok(ap.tokensOut)}`;
			const pctStr = ` Ctx=${pct}%/${fmtTok(ap.contextWindow)}`;

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
				const tag = this.agentTag(agent);

				onUpdate?.({
					content: [{ type: "text", text: `${tag} - dispatching...` }],
					details: { agent, task, status: "dispatching" },
				});

				// Listen for ESC / abort signal — kill running subagent
				if (signal) {
					signal.addEventListener("abort", () => {
						const ap = procs.get(agent.toLowerCase());
						if (ap && (ap.status === "running" || ap.status === "starting")) {
							logErrorBox(ap, "ABORTED", "User pressed ESC");
							killProc(ap, true);
							wipeSessionFile(ap);
							ap.status = "dead";
							invalidate();
						}
					});
				}

				const r = await dispatch(agent, task);

				// Guard rail: truncate response to last MAX_RESPONSE_LENGTH chars
				let output = r.output;
				if (output.length > MAX_RESPONSE_LENGTH) {
					output = output.slice(-MAX_RESPONSE_LENGTH);
					output = `... [truncated to last ${MAX_RESPONSE_LENGTH} chars]\n` + output;
				}

				const status = r.code === 0 ? "done" : "error";
				const summary = `${tag} - ${status} in ${Math.round(r.elapsed / 1000)}s`;

				if (r.code !== 0 && wCtx) {
					wCtx.ui.notify(summary, "error");
				}

				return {
					content: [{ type: "text", text: output }],
					details: { agent, task, status, elapsed: r.elapsed, exitCode: r.code, fullOutput: output },
				};
			} catch (err: any) {
				if (wCtx) wCtx.ui.notify(`[${agent}] Error: ${err?.message || err}`, "error");
				return {
					content: [{ type: "text", text: `Error dispatching ${agent}: ${err?.message || err}. The orchestrator should inform the user.` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		/** Get agent display info: [name][model] tag */
		agentTag(name: string): string {
			const apRef = procs.get(name.toLowerCase());
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

	// ── Commands ────────────────────────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Select a team",
		handler: async (_args, ctx) => {
			wCtx = ctx;
			const names = Object.keys(teams);
			if (!names.length) { ctx.ui.notify("No teams defined", "warning"); return; }

			const opts = names.map(n => {
				const m = teams[n].map(t => displayName(t.name)).join(", ");
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

				pi.setActiveTools(["dispatch_agent", "ask_user_question", "todo", "read", "bash", "grep", "find", "ls", "write", "edit"]);
				invalidate();
				const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
				ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
				await ctx.ui.notify(`✓ Agent team enabled — Team: ${activeTeam} (${members}) — agents spawn on-demand`);
			} else if (sub === "off") {
				enabled = false;
				persist();
				await killAll();
				wCtx = ctx;
				// Restore all tools EXCEPT dispatch_agent
				const allNames = pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
				pi.setActiveTools(allNames);
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



	// ── Shortcut: Ctrl+Q toggle ─────────────────────────────────────

	pi.registerShortcut("ctrl+q", {
		description: "Toggle agent team on/off",
		handler: async (ctx) => {
			wCtx = ctx;
			if (enabled) {
				enabled = false;
				persist();
				await killAll();
				const allNames = pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
				pi.setActiveTools(allNames);
				invalidate();
				ctx.ui.notify("✓ Agent team disabled", "info");
			} else {
				enabled = true;
				persist();

				await killAll();
				procs.clear();

				loadAgents(ctx.cwd);
				tmuxCwd = ctx.cwd;

				const names = Object.keys(teams);
				const teamToActivate = (activeTeam && names.includes(activeTeam)) ? activeTeam : (names[0] || "");
				if (teamToActivate) await activateTeam(teamToActivate);

				openSessionLog();
				createSessionPane();

				pi.setActiveTools(["dispatch_agent", "ask_user_question", "todo", "read", "bash", "grep", "find", "ls", "write", "edit"]);
				invalidate();
				const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
				ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
				ctx.ui.notify(`✓ Agent team enabled — Team: ${activeTeam} (${members})`, "info");
			}
		},
	});

	// ── System Prompt Override ──────────────────────────────────────

	function buildCatalog(): string {
		return Array.from(procs.values())
			.map(a => {
				const alive = a.proc ? "alive" : "dead";
				return `### ${displayName(a.def.name)}\n**Dispatch as:** \`${a.def.name}\` [${alive}]\n${a.def.description}\n**Tools:** ${a.def.tools}`;
			})
			.join("\n\n");
	}

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
				if (!ap.teamModel && !ap.def.model) ap.model = orchestratorModel;
			}
		}

		// Build catalog of available agents
		const catalog = buildCatalog();
		const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
		const t0 = Date.now();
		const cwd = process.cwd();
		return {
			systemPrompt: `
You are the primary reasoning agent for this multi-agent team. You orchestrate work, make decisions, and produce the final answer — you do not offload thinking to subagents.

You are a precise, autonomous orchestrator. Your strength is decomposing problems, dispatching the right tools and subagents for each job, verifying results against acceptance criteria, and synthesizing a clean final answer.


# Tone and Style

- Be concise, direct, and to the point. No filler, no apologies, no restating the prompt.
- Your output will be displayed on a command line interface. Responses use GitHub-flavored Markdown rendered in monospace.
- Minimize output tokens while maintaining helpfulness, quality, and accuracy.
- Do not answer with unnecessary preamble or postamble. Get straight to the action or answer.
- Only use emojis if the user explicitly requests it.

# Workflow

1. **Restate the goal** in one line. If ambiguous, ask ONE focused question, then proceed.
2. **Identify missing context.** Call file_reader/searcher ONLY if the current context cannot answer. Dispatch independent lookups in parallel, in a single batch.
3. **Plan the minimal change set** with explicit acceptance criteria (what must be true when done). Prefer editing existing files over creating new ones.
4. **Dispatch coder/documenter.** Wait for results and check them against the acceptance criteria.
5. **Dispatch tester** with the exact commands to run. If failures, send the error excerpt + failing file paths back to coder (max 2 retry cycles). After 2, stop and surface the failure to the user with the evidence — never paper over it.
6. **Summarize:** what changed, what was verified, what is left.

IMPORTANT: Always plan extensively before dispatching. Reflect on subagent outcomes before proceeding. Do not dispatch blindly.

# Dispatch Contract

- ONE agent at a time. Wait for full response before dispatching the next.
- Subagents are stateless — they see nothing but your prompt. Every dispatch must include:
  - The task in one line, plus acceptance criteria
  - All relevant file paths, excerpts, error messages, and decisions already made
  - What to return and in what format
- Never say "as discussed" or reference prior turns — the subagent has no prior turns.
- Skip .venv, .pi, node_modules, __pycache__, .git in all file operations.

# Escalation Protocol

Subagents reply with structured signals. Route them — do not re-dispatch blindly:

- AMBIGUOUS: <question> → answer it yourself if you can; otherwise ask the user. Re-dispatch with the answer baked in.
- NOT FOUND → treat as ground truth for that location; widen the search or change approach.
- BLOCKED: <reason> → resolve the blocker (missing env, flag, permission) before re-dispatching.

# Hard Rules

- Delegate only context-heavy work (large files, web, command execution). Never delegate reasoning, planning, or decisions.
- Never accept a subagent output without checking it fits the goal and acceptance criteria.
- Never modify code yourself — that is coder job.
- Never run tests yourself — that is tester job.
- Never re-dispatch a subagent for a question you can answer from the result you already have.
- Stay in scope: no drive-by refactors, no unrequested features. Note them as suggestions instead.
- For temporary files use ${cwd}/tmp directory

# Tool Priority

- grep before read. read with offset/limit before full file. glob before recursive find.
- Quick needle queries (one known file/symbol) you may do yourself; anything broader goes to file_reader.
- If a subagent output looks confused, dispatch a NEW session with a sharper prompt — do not try to steer the broken one.

# Output Contract

Final answer: 3-8 lines.

- Goal recap (1 line)
- What changed (file:line refs)
- Verification status (which commands passed/failed, or "not verified")
- Open questions or "done"

No filler, no apologies, no restating the prompt.

## Subagents
${catalog}

Date: ${new Date(t0).toISOString().split("T")[0]}
CWD: ${cwd}

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
			// Ensure dispatch_agent is NOT in active tools when disabled
			const allNames = pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
			pi.setActiveTools(allNames);
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

		// Open combined session log + create log pane
		openSessionLog();
		createSessionPane();

		// Lock to dispatcher-only tools
		pi.setActiveTools(["dispatch_agent", "ask_user_question", "todo", "read", "bash", "grep", "find", "ls", "write", "edit"]);

		_ctx.ui.setStatus("agent-team", `Team: ${activeTeam} (${procs.size})`);
		const members = Array.from(procs.values()).map(a => displayName(a.def.name)).join(", ");
		_ctx.ui.notify(
			`Team: ${activeTeam} (${members}) — agents spawn on-demand per task\n\n` +
			`/agents-team          Select a team\n` +
			`/Ctrl+q                Toggle agent mode`,
			"info",
		);
		invalidate();
	});

	// ── Session Shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		process.stdout.off("resize", handleTerminalResize);
		persist();
		await killAll(true);
	});


}
