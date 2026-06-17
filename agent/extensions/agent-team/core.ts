// ── Types ──

import type { ChildProcess } from "child_process";
import type { WriteStream } from "fs";

export interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

export interface AgentProc {
	def: AgentDef;
	model: string;
	teamModel?: string;   // model override from teams.yaml (highest precedence)
	proc: ChildProcess | null;
	procRef: RpcSubprocess | null;
	stdoutBuf: string;
	status: "idle" | "running" | "starting" | "done" | "error" | "dead";
	ready: boolean;
	readyResolve: ((success: boolean) => void) | null;
	readyTimeout?: ReturnType<typeof setTimeout>;
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
	lastActivity: number;          // timestamp of last received RPC event
	resetPongTimeout?: () => void; // resets the 10-min pong timer
	resolveDispatch: ((output: string, code: number) => void) | null;
	sessionFile: string;
	systemPromptFile: string;
	lastPromptHash?: string;
	streamLineBuf: string;   // partial line buffer for streaming text box-wrapping
}

export interface TeamMember {
	name: string;
	model?: string;
}

export interface MemoryState {
	status: "idle" | "recording" | "summarizing" | "done" | "error";
	runCount: number;
	lastSummaryAt: number;
	lastError: string;
	elapsed: number;
}

export interface TeamConfig {
	activeTeam: string;
	gridCols: number;
	enabled: boolean;
}

export interface TerminalBackend {
	detect(): boolean;
	getTerminalWidth(): number;
	createLogPane(cwd: string, logFile: string, origPaneId: string): string | null;
	resizePane(paneId: string, width: number): void;
	killPane(paneId: string): void;
	isValidPaneId(id: string): boolean;
}

/** Contract that the AgentTeam class satisfies structurally. All orchestration,
 *  ui, and integrations code receives a value typed as AgentTeamContext rather
 *  than importing AgentTeam directly. This breaks the historical import-type
 *  cycle through index.ts.
 *  memoryManager is typed as `any` to avoid a circular import with memory.ts. */
export interface AgentTeamContext {
	// State
	procs: Map<string, AgentProc>;
	lastDispatchedAp: AgentProc | null;
	orchestratorModel: string;
	cachedExtPaths: string[];
	sessionDir: string;
	allDefs: AgentDef[];
	teams: Record<string, TeamMember[]>;
	activeTeam: string;
	saved: Partial<TeamConfig>;
	wCtx: any;
	enabled: boolean;
	animFrame: number;
	wInvalidate: (() => void) | null;
	gridCols: number;
	memoryManager: any; // MemoryManager | null (typed in memory.ts; elided here to avoid circular import)
	memoryModel: string;
	resizeHandler: () => void; // bound closure used by initWidget + session_shutdown

	// Callbacks
	logger: SessionLogger;
	invalidate: () => void;
	resolveIfPending: (ap: AgentProc, output: string, code: number) => void;
	wipeSessionFile: (ap: AgentProc) => void;
	tag: (ap: AgentProc, heading: string) => string;
	spawnProc: (ap: AgentProc) => Promise<boolean>;
	killProc: (ap: AgentProc, immediate?: boolean) => void;
	killAll: (killPanesToo?: boolean) => Promise<void>;
	persist: () => void;
	dispatch: (agentName: string, task: string) => Promise<{ output: string; code: number; elapsed: number }>;
	activateTeam: (name: string) => Promise<void>;
	handleEvent: (ap: AgentProc, line: string) => void;
	killPanes: () => void;
	enableAgentTeam: (ctx: any) => Promise<void>;
	disableAgentTeam: (ctx: any) => Promise<void>;
}

// ── Utilities ──

import { readdirSync, existsSync } from "fs";
import { resolve } from "path";

/** Extract short model name after last '/' */
export function shortModel(model: string): string {
	const i = model.lastIndexOf("/");
	return i >= 0 ? model.slice(i + 1) : model;
}

export const displayName = (name: string) =>
	name.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

export const agentKey = (ap: { def: { name: string } }) =>
	ap.def.name.toLowerCase().replace(/\s+/g, "-");

/** Format token count: >=1000 → "1.2k", else raw */
export const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Iterate files in multiple directories, deduplicating by name */
export function scanDirs(dirs: string[], predicate: (name: string) => boolean): string[] {
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
export function blankProcState(): Omit<AgentProc, "def" | "model" | "teamModel"> {
	return {
		proc: null, procRef: null, stdoutBuf: "", status: "dead", ready: false, readyResolve: null, readyTimeout: undefined,
		task: "", collectedText: "", currentMessageText: "", lastAssistantText: "",
		contextWindow: 0, tokensUsed: 0, tokensOut: 0,
		cacheRead: 0, cacheWrite: 0, cacheSavedTotal: 0,
		toolCount: 0, elapsed: 0, lastWork: "", runCount: 0,
		timer: undefined, dispatchTimeout: undefined,
		lastActivity: 0, resetPongTimeout: undefined, resolveDispatch: null,
		sessionFile: "", systemPromptFile: "", lastPromptHash: undefined,
		streamLineBuf: "",
	};
}

export function clearTimers(ap: AgentProc) {
	clearInterval(ap.timer);
	if (ap.dispatchTimeout) { clearTimeout(ap.dispatchTimeout); ap.dispatchTimeout = undefined; }
}

/** Reset mutable dispatch fields on an AgentProc (reuses blank state pattern).
 *  NOTE: `lastPromptHash` is intentionally NOT reset here — it's the cache
 *  key used by `writeSystemPrompt` to skip re-writing the prompt file when
 *  the content is unchanged. It is invalidated in `blankProcState` (when a
 *  new AgentProc is constructed) and the next write will re-hash. */
export function resetForDispatch(ap: AgentProc) {
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
	clearTimers(ap);
	if (ap.readyTimeout) { clearTimeout(ap.readyTimeout); ap.readyTimeout = undefined; }
}

// ── Box drawing helpers ──

export function hrPad(content: string, width: number, left: string, right: string, fill = "─"): string {
	const inner = width - left.length - right.length;
	const used = [...content].length; // unicode-aware length
	// 0 is valid: an empty closing line and a line that exactly fills `inner` both
	// want no fill, only the two corners. Using Math.max(1, …) inflated those by 1 cell
	// and shifted the right border left.
	const pad = Math.max(0, inner - used);
	return left + content + fill.repeat(pad) + right;
}

export function boxLine(content: string, width: number): string {
	const inner = width - 4; // "│ " + " │"
	let body = content;
	// ASCII fast path: pure-ASCII strings have grapheme count === char count,
	// so we skip the `[...content]` spread allocation for the common case.
	const len = (content.length === 0 || /[\u0080-\uFFFF]/.test(content))
		? [...content].length
		: content.length;
	if (len > inner) {
		// Reserve room for the marker so the total stays within `inner` cells.
		const marker = `…[+N]`;
		const cut = inner - marker.length;
		if (content.length === len) {
			// Pure ASCII: simple slice, no spread needed.
			body = content.slice(0, Math.max(0, cut)) + marker;
		} else {
			body = [...content].slice(0, Math.max(0, cut)).join("") + marker;
		}
	}
	return hrPad(` ${body} `, width, "│", "│", " ");
}

/** Extract last non-empty line from text. Single reverse scan: O(n) for
 *  text length n regardless of how many trailing empty lines exist. */
export function extractLastLine(text: string): string {
	let end = text.length;
	// Walk backwards from the end, skipping trailing whitespace/newlines.
	while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === " " || text[end - 1] === "\t" || text[end - 1] === "\r")) {
		end--;
	}
	if (end === 0) return "";
	// Find the previous newline to bound the line.
	let start = end;
	while (start > 0 && text[start - 1] !== "\n") {
		start--;
	}
	return text.slice(start, end);
}

// ── Terminal backends ──

import { spawn, spawnSync } from "child_process";

export class TmuxBackend implements TerminalBackend {
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
		// Wrap logFile in single quotes with embedded-quote escape — same
		// pattern as escapedCwd above. This protects against paths containing
		// shell metacharacters (single quote, $, `, ;, etc.).
		const lf = `'${logFile.replace(/'/g, "'\\''")}'`;
		// Vertical split: pane takes full window width and auto-resizes with terminal.
		// Do NOT lock the width with `resize-pane -x` — it would prevent auto-resize.
		const script = [
			`P=$(tmux split-window -v -d -l 8 -c '${escapedCwd}' -P -F '#{pane_id}')`,
			`tmux select-pane -t $P -T 'Agent Team Log'`,
			`tmux send-keys -t $P "tail -n +1 -f ${lf}" Enter`,
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

export class HerdrBackend implements TerminalBackend {
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
		// herdr pane IDs: as of herdr 0.7.0 the format is `w<hex>:<alnum>`
		// (e.g. w654222c09d4a21:p8, suffix is hex/case-insensitive); pre-0.7.0
		// used `w<hex>-<n>` (e.g. w65385dc1da5392-2). Both forms are accepted.
		return /^w[0-9a-f]+[:-][a-z0-9]+$/i.test(id);
	}
}

// ── Logging ──

import { createWriteStream } from "fs";
import { join } from "path";

export class SessionLogger {
	private logDir: string;
	private logFile = "";
	private stream: WriteStream | null = null;
	private logWidth = 60;
	private terminal: TerminalBackend;
	private MIN_logWidth = 60;
	private MAX_logWidth = 300;

	constructor(terminal: TerminalBackend, logDir: string) {
		this.terminal = terminal;
		this.logDir = logDir;
	}

	setLogDir(dir: string) { this.logDir = dir; }
	getLogFile(): string { return this.logFile; }
	getStream(): WriteStream | null { return this.stream; }

	open(): void {
		if (this.stream) return; // already open
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		this.logFile = join(this.logDir, `session-${ts}.log`);
		this.stream = createWriteStream(this.logFile, { flags: "a" });
		this.stream.on("error", (err) => console.error(`Session log write error:`, err.message));
	}

	close(): void {
		if (this.stream) { try { this.stream.end(); } catch { } this.stream = null; }
	}

	updateWidth(): void {
		const tw = this.terminal.getTerminalWidth();
		this.logWidth = tw > 0 ? Math.min(Math.max(tw, this.MIN_logWidth), this.MAX_logWidth) : this.MIN_logWidth;
	}

	getWidth(): number { return this.logWidth; }

	// ── Low-level write helpers ──

	log(msg: string) {
		if (this.stream) this.stream.write(msg + "\n");
	}

	logRaw(msg: string) {
		if (this.stream) this.stream.write(msg);
	}

	logStreamingText(ap: AgentProc, chunk: string) {
		if (!this.stream) return;
		ap.streamLineBuf += chunk;
		let idx: number;
		while ((idx = ap.streamLineBuf.indexOf("\n")) >= 0) {
			const line = ap.streamLineBuf.slice(0, idx);
			ap.streamLineBuf = ap.streamLineBuf.slice(idx + 1);
			this.stream.write(boxLine(line, this.logWidth) + "\n");
		}
	}

	flushStreamBuf(ap: AgentProc) {
		if (!this.stream || !ap.streamLineBuf) return;
		this.stream.write(boxLine(ap.streamLineBuf, this.logWidth) + "\n");
		ap.streamLineBuf = "";
	}

	/** Agent header: "Scout · model-name" */
	private agentLabel(ap: AgentProc): string {
		return `${displayName(ap.def.name)} · ${shortModel(ap.model)}`;
	}

	// ── Structured log events ──

	logTaskBox(ap: AgentProc, taskNum: number, task: string) {
		this.log("");
		this.log(`Date: ${new Date().toISOString()}`);
		this.log(hrPad(` Task #${taskNum} · ${this.agentLabel(ap)} `, this.logWidth, "╭", "╮"));
		const inner = this.logWidth - 4;
		for (const para of task.split("\n")) {
			const words = para.split(" ");
			let line = "";
			for (const w of words) {
				if (line && [...line].length + 1 + [...w].length > inner) {
					this.log(boxLine(line, this.logWidth));
					line = w;
				} else {
					line = line ? line + " " + w : w;
				}
			}
			if (line) this.log(boxLine(line, this.logWidth));
		}
	}

	logToolStart(ap: AgentProc, tool: string, detail: string) {
		this.log(boxLine(`┌ ${tool}${detail ? " " + detail : ""}`, this.logWidth));
	}

	logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
		this.log(boxLine(`└ ${ok ? "✓" : "✗"} ${tool}${durMs ? ` (${Math.round(durMs)}ms)` : ""}`, this.logWidth));
	}

	logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
		this.log("")
		this.log(hrPad(` DONE  ${elapsedSec}s · ${tools} tools `, this.logWidth, "╰", "╯"));
	}

	logErrorBox(ap: AgentProc, heading: string, detail: string) {
		this.log(hrPad(` ✗ ${this.agentLabel(ap)} `, this.logWidth, "╭", "╮"));
		this.log(boxLine(heading, this.logWidth));
		if (detail) this.log(boxLine(detail, this.logWidth));
		this.log(hrPad("", this.logWidth, "╰", "╯"));
	}
}

// ── RPC subprocess spawner ──

import { spawn as nodeSpawn } from "node:child_process";

export interface RpcSubprocessOpts {
	bin: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	logger: SessionLogger;
	/** Called for each complete, non-empty JSONL line emitted on stdout. */
	onLine: (line: string) => void;
	/** Called when the child emits 'error'. Fires at most once. */
	onError: (err: Error) => void;
	/** Called when the child emits 'close'. Fires at most once. */
	onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface RpcSubprocess {
	proc: ChildProcess;
	/**
	 * Send a signal (default SIGTERM) and schedule a SIGKILL 2s later as a
	 * backstop. Idempotent — only the first call has effect.
	 */
	kill: (signal?: NodeJS.Signals) => void;
}

export function spawnRpcSubprocess(opts: RpcSubprocessOpts): RpcSubprocess {
	const proc: ChildProcess = nodeSpawn(opts.bin, opts.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: opts.env ?? { ...process.env },
		// Windows can't execute .cmd/.bat directly through spawn; route via the shell.
		shell: process.platform === "win32",
	});

	let settled = false;
	let killed = false;

	const fireError = (err: Error) => {
		if (settled) return;
		settled = true;
		opts.onError(err);
	};
	const fireClose = (code: number | null, signal: NodeJS.Signals | null) => {
		if (settled) return;
		settled = true;
		opts.onClose(code, signal);
	};

	// Read JSONL events from stdout
	proc.stdout!.setEncoding("utf-8");
	// Cap the in-flight line buffer so a runaway single line (no \n) cannot
	// exhaust memory. If we exceed the cap, force-emit the buffer as a
	// truncated line and reset — the consumer can then decide what to do.
	const MAX_LINE_BUF = 1 << 20; // 1 MiB
	let stdoutBuf = "";
	proc.stdout!.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		while (true) {
			const nl = stdoutBuf.indexOf("\n");
			if (nl === -1) {
				if (stdoutBuf.length > MAX_LINE_BUF) {
					const truncated = stdoutBuf.slice(0, MAX_LINE_BUF);
					stdoutBuf = "";
					opts.onLine(truncated);
				}
				break;
			}
			let line = stdoutBuf.slice(0, nl);
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			opts.onLine(line);
		}
	});

	proc.stderr!.setEncoding("utf-8");
	proc.stderr!.on("data", (d: string) => {
		for (const line of d.split("\n")) if (line.trim()) opts.logger.log(line);
	});

	proc.on("error", (err) => {
		fireError(err);
	});

	proc.on("close", (code, signal) => {
		fireClose(code, signal);
	});

	return {
		proc,
		kill: (signal: NodeJS.Signals = "SIGTERM") => {
			if (killed) return;
			killed = true;
			try { proc.kill(signal); } catch { }
			setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { }
			}, 2000);
		},
	};
}
