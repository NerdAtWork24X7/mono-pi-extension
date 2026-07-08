// ── Types ──

import type { ChildProcess } from "child_process";

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
	logLines: string[];        // per-agent in-memory log ring buffer (rendered in the TUI widget, scaled per agent)
	runId?: string;         // unique per concurrent run; suffixed into session/prompt files to avoid collisions
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
	/** Master toggle for parallel batched subagent dispatch (dispatch_agents). */
	parallelDispatch?: boolean;
	/** Max concurrent read-only subagent processes spawned by one dispatch_agents call. */
	maxParallel?: number;
	/** Tools that mark an agent as "writable" (serialized, never parallel). */
	destructiveTools?: string[];
}

export interface TerminalBackend {
	detect(): boolean;
	/** Full host / client / orchestrator-pane width in columns. Used to size
	 *  the log pane at creation (tmux only; herdr ignores). Returns 0 if the
	 *  underlying value isn't available. */
	getTerminalWidth(): number;
	/** ACTUAL width of the log pane in columns. Distinct from `getTerminalWidth`:
	 *  for tmux we query `#{pane_width}` so manual pane dragging is respected;
	 *  for herdr we trust the env hint or stdout.columns. Returns 0 if unknown. */
	getLogPaneWidth(paneId: string | null): number;
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
	parallelDispatch: boolean;
	maxParallel: number;
	batchClones: Set<AgentProc>;
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
	/** Current active tool allowlist (includes dispatch_agents when parallel is on). */
	activeToolList: () => string[];
	/** True when an agent's tool allowlist includes any destructive (file-mutating) tool. */
	destructiveTools: string[];
	/** Async read/write lock: read-only dispatches run concurrently; writable dispatches are exclusive. */
	dispatchLock: RwLock;
	/** Serialize dispatches to the SAME agent so its shared AgentProc state never collides. */
	serializeAgent: (name: string, fn: () => Promise<any>) => Promise<any>;
	/** Batched parallel dispatch of read-only subagents. */
	dispatchMany: (tasks: Array<{ agent: string; task: string }>) => Promise<BatchDispatchResult>;
	/** Run the SAME agent across many tasks (one isolated clone per task). */
	dispatchAgentMany: (agentName: string, tasks: string[]) => Promise<BatchDispatchResult>;
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
		logLines: [],
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

// ── Parallel dispatch primitives ──

/** Per-task result from a batched (dispatch_agents) call. */
export interface BatchTaskResult {
	agent: string;
	task: string;
	output: string;
	code: number;
	elapsed: number;
	error: string | null;
}

/** Aggregate result of a batched (dispatch_agents) call. */
export interface BatchDispatchResult {
	ok: boolean;
	error?: string;
	results: BatchTaskResult[];
}

/** Classify an agent as writable (can mutate files → serialized) vs read-only
 *  (parallel) by inspecting its tool allowlist against `destructiveTools`. */
export function isWritable(def: AgentDef, destructiveTools: string[]): boolean {
	const set = new Set(destructiveTools.map(s => s.trim().toLowerCase()).filter(Boolean));
	return def.tools
		.split(",")
		.map(s => s.trim().toLowerCase())
		.filter(Boolean)
		.some(t => set.has(t));
}

/** Async reader/writer lock.
 *  - `read(fn)`  → multiple readers run concurrently.
 *  - `write(fn)` → exclusive: waits for in-flight readers/writers, blocks new ones.
 *  Used so read-only subagent dispatches parallelize while any write/edit dispatch
 *  is fully serialized (never runs alongside another dispatch). */
export class RwLock {
	private writing = false;
	private readers = 0;
	private queue: Array<{ exclusive: boolean; run: () => void }> = [];

	private pump() {
		if (this.writing) return;
		if (this.queue.length === 0) return;
		const head = this.queue[0];
		if (head.exclusive) {
			if (this.readers > 0) return; // wait for readers to drain
			this.queue.shift();
			this.writing = true;
			head.run();
		} else {
			// Admit a batch of consecutive readers.
			while (this.queue.length && !this.queue[0].exclusive) {
				const r = this.queue.shift()!;
				this.readers++;
				r.run();
			}
		}
	}

	read<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				fn().then(resolve, reject).finally(() => {
					this.readers--;
					this.pump();
				});
			};
			this.queue.push({ exclusive: false, run });
			this.pump();
		});
	}

	write<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				fn().then(resolve, reject).finally(() => {
					this.writing = false;
					this.pump();
				});
			};
			this.queue.push({ exclusive: true, run });
			this.pump();
		});
	}
}

// ── Log pane sizing ──

/** Fraction of terminal/host width allocated to the NEW log pane (tmux split-window).
 *  Applied ONLY when sizing the pane itself, never when deriving box width — the
 *  box width is a clamp of the *actual* log pane width so it tracks whatever
 *  size the pane ends up at (including manual tmux dragging or herdr's split). */
export const LOG_SPLIT_RATIO = 0.35;
export const LOG_PANE_MIN = 50;
export const LOG_PANE_MAX = 200;

/** Per-input-line byte cap for logBoxed(). The cap exists *only* to defend the
 *  unicode-aware `[...content].length` spread inside `boxLine` against OOM on
 *  runaway subprocess output. It does NOT limit the visible output — `boxLine`
 *  truncates to logWidth regardless of input size. Matches the stdout
 *  `MAX_LINE_BUF = 1 << 20` plumbing in `spawnRpcSubprocess`. */
export const LOG_LINE_INPUT_CAP = 1 << 20;

/** Width to use when SIZING the tmux log pane (at create + on user resize).
 *  Formula: 35% of host width, clamped to a sane reading range. Only used by
 *  TmuxBackend; HerdrBackend has no pane-width control. */
export function initialPaneWidth(hostWidth: number): number {
	return hostWidth > 0
		? Math.min(Math.max(Math.floor(hostWidth * LOG_SPLIT_RATIO), LOG_PANE_MIN), LOG_PANE_MAX)
		: LOG_PANE_MIN;
}

/** Width to use when DRAWING the box character borders for log lines.
 *  Clamp the ACTUAL log pane width — NO 0.35 ratio. The previous bug applied
 *  that ratio twice (once to size the pane, once to derive the box width),
 *  which collapsed small pane widths (e.g. herdr `HERDR_PANE_WIDTH=100`)
 *  down to LOG_PANE_MIN and broke alignment with the on-screen pane. */
export function boxWidth(paneWidth: number): number {
	return paneWidth > 0
		? Math.min(Math.max(paneWidth, LOG_PANE_MIN), LOG_PANE_MAX)
		: LOG_PANE_MIN;
}

// ── Box drawing helpers ──

export function hrPad(content: string, width: number, left: string, right: string, fill = "─"): string {
	const inner = width - left.length - right.length;
	// ASCII fast path: pure-ASCII strings have grapheme count === char count,
	// so we skip the `[...content]` spread allocation for the common case
	// (mirrors `boxLine` below).
	const asciiFast = content.length === 0 || !/[\u0080-\uFFFF]/.test(content);
	const used = asciiFast ? content.length : [...content].length;
	let body = content;
	let pad: number;
	if (used > inner) {
		// Content overflows the box. Truncate with marker so the bordered row
		// stays exactly `width` cells — otherwise a long agent/model label
		// (e.g. "Full Stack Web Developer · claude-3.5-sonnet") pushes the
		// right border past `width` and breaks tmux auto-wrap alignment.
		const marker = `…[+N]`;
		const cut = inner - marker.length;
		if (cut > 0) {
			body = asciiFast
				? content.slice(0, cut) + marker
				: [...content].slice(0, cut).join("") + marker;
			pad = 0;
		} else {
			// Inner is too small even for the marker (very narrow widgets).
			// Emit a bare horizontal line so the row is exactly `width` cells.
			body = "";
			pad = Math.max(0, inner);
		}
	} else {
		// 0 is valid: an empty closing line and a line that exactly fills `inner` both
		// want no fill, only the two corners. Using Math.max(1, …) inflated those by 1 cell
		// and shifted the right border left.
		pad = Math.max(0, inner - used);
	}
	return left + body + fill.repeat(pad) + right;
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

	getLogPaneWidth(paneId: string | null): number {
		// Query tmux for the actual current width of the log pane. This is the
		// source of truth for box-drawing and reflects manual dragging + tmux's
		// own rebalance on SIGWINCH — both of which we now respect instead of
		// overriding with our own formula.
		if (paneId && /^%\d+$/.test(paneId)) {
			try {
				const r = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_width}"], { encoding: "utf-8" });
				const w = parseInt(r.stdout?.trim() || "0", 10);
				if (w > 0) return w;
			} catch { /* fall through to estimate */ }
		}
		// Pre-creation: no log pane exists yet, so derive from the host width.
		return initialPaneWidth(this.getTerminalWidth());
	}

	createLogPane(cwd: string, logFile: string, origPaneId: string): string | null {
		// Validate origPaneId to prevent shell injection in the tmux shell script
		if (origPaneId && !/^%\d+$/.test(origPaneId)) origPaneId = "";
		const escapedCwd = cwd.replace(/'/g, "'\\''");
		// Wrap logFile in single quotes with embedded-quote escape — same
		// pattern as escapedCwd above. This protects against paths containing
		// shell metacharacters (single quote, $, `, ;, etc.).
		const lf = `'${logFile.replace(/'/g, "'\\''")}'`;
		// Horizontal split (left/right): log pane on the right.
		// Width is proportional to terminal width so boxed log lines fit the pane.
		const paneW = initialPaneWidth(this.getTerminalWidth());
		const script = [
			`P=$(tmux split-window -h -d -l ${paneW} -c '${escapedCwd}' -P -F '#{pane_id}')`,
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

	resizePane(paneId: string, _width: number): void {
		// Re-size the log pane to track the host width on terminal resize. After
		// this call returns, the actual pane width can be read back via
		// `getLogPaneWidth` (queries `#{pane_width}`), so subsequent log lines
		// are box-drawn at exactly that width. Note: `-x` locks the pane at a
		// fixed column count and overrides any manual drag the user did — we
		// accept that trade-off because the alternative (silent tmux auto-
		// rebalance) is version-dependent.
		const paneW = initialPaneWidth(this.getTerminalWidth());
		try {
			spawnSync("tmux", ["resize-pane", "-t", paneId, "-x", String(paneW)], { encoding: "utf-8" });
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
		// herdr has no "host width" — the orchestrator runs in the only its own
		// pane. We mirror `getLogPaneWidth`'s logic here so the two methods
		// return the same value (the log pane's actual width).
		return this.getLogPaneWidth(null);
	}

	getLogPaneWidth(_paneId: string | null): number {
		// herdr has no resize-pane and exposes no pane-width query, so the
		// best signal we have is the env hint set by the herdr host plus the
		// live `stdout.columns` on the orchestrator (which gets a SIGWINCH
		// on terminal resize and matches the log pane in a 50/50 split).
		// Env var wins because it carries the actual log pane width set by
		// herdr (which may NOT match stdout.columns if herdr splits 30/70).
		const hint = parseInt(process.env.HERDR_PANE_WIDTH || "", 10);
		if (Number.isFinite(hint) && hint > 0) return hint;
		if (process.stdout && Number.isFinite(process.stdout.columns) && (process.stdout.columns as number) > 0) {
			return process.stdout.columns as number;
		}
		return 120;
	}

	createLogPane(cwd: string, logFile: string, _origPaneId: string): string | null {
		const paneId = process.env.HERDR_PANE_ID || "";
		if (!paneId) return null;
		try {
			// Split current pane downward. herdr returns a JSON envelope:
			// {"id":"cli:pane:split","result":{"pane":{"pane_id":"w<hex>-<n>", ...}}, "type":"pane_info"}
			const splitResult = spawnSync("herdr", ["pane", "split", paneId, "--direction", "right", "--cwd", cwd, "--no-focus"], { encoding: "utf-8" });
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
// In-memory, per-agent ring buffers. The TUI widget renders these directly
// (see ui.ts), replacing the old tmux/herdr "Agent Team Log" side pane. No file
// stream or external pane is involved; lines are stored RAW (no border) and the
// widget boxes them at the actual widget width.

export const LOG_RING_MAX = 300;

export class SessionLogger {
	private logDir: string;
	private logWidth = LOG_PANE_MIN;
	private terminal: TerminalBackend;
	private generalLines: string[] = []; // ap-less logs (no owning agent)

	constructor(terminal: TerminalBackend, logDir: string) {
		this.terminal = terminal;
		this.logDir = logDir;
	}

	/** Append a line to the owning agent's ring buffer, or to the general
	 *  buffer when no agent is supplied. The widget boxes these at the actual
	 *  widget width, so lines are stored RAW (no border) here. */
	private push(ap: AgentProc | null, s: string) {
		if (ap) {
			const buf = ap.logLines;
			buf.push(s);
			if (buf.length > LOG_RING_MAX) buf.splice(0, buf.length - LOG_RING_MAX);
		} else {
			this.generalLines.push(s);
			if (this.generalLines.length > LOG_RING_MAX) this.generalLines.splice(0, this.generalLines.length - LOG_RING_MAX);
		}
	}

	/** No-op: the widget controls render width now. Kept so callers don't change. */
	updateWidth(): void {
		const paneW = this.terminal.getLogPaneWidth(null);
		this.logWidth = boxWidth(paneW);
	}

	getWidth(): number { return this.logWidth; }

	// ── Low-level write helpers ──

	log(msg: string, ap: AgentProc | null = null) {
		this.push(ap, msg);
	}

	logRaw(msg: string) {
		this.push(null, msg);
	}

	/** Store each line RAW (no outer box): the widget wraps it in the per-agent
	 *  panel border at the actual widget width, so box-drawing here would
	 *  mismatch. Used for subprocess stderr and memory notes. */
	logBoxed(msg: string, ap: AgentProc | null = null) {
		const trimmed = msg.endsWith("\n") ? msg.slice(0, -1) : msg;
		for (const ln of trimmed.split("\n")) this.push(ap, ln);
	}

	logStreamingText(ap: AgentProc, chunk: string) {
		ap.streamLineBuf += chunk;
		let idx: number;
		while ((idx = ap.streamLineBuf.indexOf("\n")) >= 0) {
			const line = ap.streamLineBuf.slice(0, idx);
			ap.streamLineBuf = ap.streamLineBuf.slice(idx + 1);
			this.push(ap, line);
		}
	}

	flushStreamBuf(ap: AgentProc) {
		if (!ap.streamLineBuf) return;
		this.push(ap, ap.streamLineBuf);
		ap.streamLineBuf = "";
	}

	/** Agent header: "Scout · model-name" */
	private agentLabel(ap: AgentProc): string {
		return `${displayName(ap.def.name)} · ${shortModel(ap.model)}`;
	}

	// ── Structured log events (raw lines; widget boxes them) ──

	logTaskBox(ap: AgentProc, taskNum: number, task: string) {
		this.push(ap, `▶ Task #${taskNum} · ${this.agentLabel(ap)}`);
		const inner = 80;
		for (const para of task.split("\n")) {
			const words = para.split(" ");
			let line = "";
			for (const w of words) {
				if (line && [...line].length + 1 + [...w].length > inner) {
					this.push(ap, "  " + line);
					line = w;
				} else {
					line = line ? line + " " + w : w;
				}
			}
			if (line) this.push(ap, "  " + line);
		}
	}

	logToolStart(ap: AgentProc, tool: string, detail: string) {
		this.push(ap, `┌ ${tool}${detail ? " " + detail : ""}`);
	}

	logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
		this.push(ap, `└ ${ok ? "✓" : "✗"} ${tool}${durMs ? ` (${Math.round(durMs)}ms)` : ""}`);
	}

	logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
		this.push(ap, `✓ DONE ${elapsedSec}s · ${tools} tools`);
	}

	logErrorBox(ap: AgentProc, heading: string, detail: string) {
		this.push(ap, `✗ ${this.agentLabel(ap)}`);
		this.push(ap, `  ${heading}`);
		if (detail) this.push(ap, `  ${detail}`);
	}

	/** No-op: per-agent buffers already isolate concurrent runs, so there is no
	 *  shared stream to flush into. Kept so callers don't change. */
	flushAgent(_ap: AgentProc, _width?: number) { }
}

// ── RPC subprocess spawner ──

import { spawn as nodeSpawn } from "node:child_process";

export interface RpcSubprocessOpts {
	bin: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	logger: SessionLogger;
	/** Owning agent, used to route buffered log output for parallel clones. */
	owner?: AgentProc | null;
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
		for (const line of d.split("\n")) if (line.trim()) opts.logger.logBoxed(line, opts.owner ?? null);
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
