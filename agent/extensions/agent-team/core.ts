// ── Types ──

import type { ChildProcess } from "child_process";

export interface AgentDef {
  name: string;
  description: string;
  tools: string;
  model?: string;
  thinking?: string;
  /** Explicit skill allowlist for this subagent. When present, global skill
   *  discovery is disabled (`--no-skills`) and only these skill names are
   *  loaded. When absent, the subagent receives every globally enabled skill. */
  skills?: string[];
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
  autoCompacted: boolean;        // true if subagent hit auto-compaction
  compactionCount: number;       // auto-compactions in the current dispatch (abort at cap)
  sessionFile: string;
  systemPromptFile: string;
  lastPromptHash?: string;
  streamLineBuf: string;   // partial line buffer for streaming text box-wrapping
  logLines: string[];        // per-agent in-memory log ring buffer (rendered in the TUI widget, scaled per agent)
  logHead: number;            // index of the oldest logical ring-buffer entry
  streamLogIdx: number;      // logLines index where the current assistant message's streamed text began (retry rollback mark)
  runId?: string;         // unique per concurrent run; suffixed into session/prompt files to avoid collisions
}

export interface TeamMember {
  name: string;
  model?: string;
  /** Whether this subagent is active. Defaults to true when absent. */
  active?: boolean;
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
  /** Agent names that are disabled by the user via the sidebar */
  disabledAgents?: string[];
  /** Skill directory names enabled for the orchestrator system prompt. Empty = none enabled. */
  orchestratorSkills?: string[];
  /** Skill directory names available to subagents. Empty = none enabled. */
  subagentSkills?: string[];
  /** Orchestrator tool denylist. Tools listed are hidden from the orchestrator. Empty = all tools shown. */
  skipOrchestratorTools?: string[];
}

/** Contract that the AgentTeam class satisfies structurally. All orchestration,
 *  ui, and integrations code receives a value typed as AgentTeamContext rather
 *  than importing AgentTeam directly. This breaks the historical import-type
 *  cycle through index.ts.
 *  memoryManager is typed as `any` to avoid a circular import with memory.ts. */
export interface AgentTeamContext {
  // State
  procs: Map<string, AgentProc>;
  orchestratorModel: string;
  cachedExtPaths: string[];
  sessionDir: string;
  /** Cached agent catalog string for the system prompt. Invalidated when
   *  the active team (and therefore ctx.procs) changes. */
  catalogCache: string;
  /** True when the cached catalog needs to be rebuilt. */
  catalogDirty: boolean;
  /** Cached skills list for the system prompt. Computed once per session. */
  skillsCache: Array<{ name: string; description: string; dir: string }>;
  /** Cached AGENTS.md content for the system prompt. Computed once per session. */
  agentMdCache: string | null;
  allDefs: AgentDef[];
  teams: Record<string, TeamMember[]>;
  activeTeam: string;
  saved: Partial<TeamConfig>;
  wCtx: any;
  enabled: boolean;
  parallelDispatch: boolean;
  maxParallel: number;
  batchClones: Set<AgentProc>;
  /** Set of agent names that are temporarily disabled by the user */
  disabledAgents: Set<string>;
  /** Skill directory names enabled for orchestrator system prompt. Empty = none. */
  orchestratorSkills: Set<string>;
  /** Skill directory names available to subagents. Empty = none. */
  subagentSkills: Set<string>;
  animFrame: number;
  wInvalidate: (() => void) | null;
  gridCols: number;
  memoryManager: any; // MemoryManager | null (typed in memory.ts; elided here to avoid circular import)
  memoryModel: string;
  memoryFile: string;
  memoryDir: string;
  originalMemoryModel: string; // preserved value for re-enabling after toggle off
  memoryActive: boolean; // persisted on/off switch from teams.yaml memory_model.active
  resizeHandler: () => void; // bound closure used by initWidget + session_shutdown

  // Callbacks
  logger: SessionLogger;
  invalidate: () => void;
  resolveIfPending: (ap: AgentProc, output: string, code: number) => void;
  wipeSessionFile: (ap: AgentProc) => void;
  tag: (ap: AgentProc, heading: string) => string;
  spawnProc: (ap: AgentProc) => Promise<boolean>;
  killProc: (ap: AgentProc, immediate?: boolean) => void;
  killAll: () => Promise<void>;
  persist: () => void;
  dispatch: (agentName: string, task: string) => Promise<{ output: string; code: number; elapsed: number }>;
  activateTeam: (name: string) => Promise<void>;
  handleEvent: (ap: AgentProc, line: string) => void;
  enableAgentTeam: (ctx: any) => Promise<void>;
  disableAgentTeam: (ctx: any) => Promise<void>;
  /** Current active tool allowlist (includes dispatch_agents when parallel is on). */
  activeToolList: () => string[];
  /** True when an agent's tool allowlist includes any destructive (file-mutating) tool. */
  destructiveTools: string[];
  /** Async read/write lock: read-only dispatches run concurrently; writable dispatches are exclusive. */
  /** Orchestrator tool denylist. Tools listed are hidden from the orchestrator. Empty = all tools shown. */
  skipOrchestratorTools: string[];
  dispatchLock: RwLock;
  /** Serialize dispatches to the SAME agent so its shared AgentProc state never collides. */
  serializeAgent: (name: string, fn: () => Promise<any>) => Promise<any>;
  /** Batched parallel dispatch of read-only subagents. */
  dispatchMany: (tasks: Array<{ agent: string; task: string }>, signal?: AbortSignal) => Promise<BatchDispatchResult>;
  /** Run the SAME agent across many tasks (one isolated clone per task). */
  dispatchAgentMany: (agentName: string, tasks: string[], signal?: AbortSignal) => Promise<BatchDispatchResult>;
}

// ── Utilities ──

import { readdirSync, existsSync } from "fs";
import { resolve } from "path";

/** Extract short model name after last '/' */
export function shortModel(model: string): string {
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

/** Split a provider-prefixed model ID into provider and model name.
 *  e.g. "openrouter/baidu/cobuddy:free" → { provider: "openrouter", model: "baidu/cobuddy:free" }
 *  Returns provider=undefined when there is no prefix. */
export function parseModelId(full: string): { provider: string | undefined; model: string } {
  const slashIdx = full.indexOf("/");
  if (slashIdx > 0) {
    return { provider: full.slice(0, slashIdx), model: full.slice(slashIdx + 1) };
  }
  return { provider: undefined, model: full };
}

/** Filter skills by an enable-set. Returns all skills when the set is empty
 *  (meaning no filter), otherwise only skills whose `dir` is in the set. */
export function filterSkills(
  skills: Array<{ name: string; description: string; dir: string }>,
  enabledSet: Set<string>,
): Array<{ name: string; description: string; dir: string }> {
  if (enabledSet.size === 0) return [];
  return skills.filter(s => enabledSet.has(s.dir));
}

/** Max bytes allowed for `collectedText` during streaming. Prevents unbounded
 *  memory growth if a subagent emits extremely long output. */
export const MAX_COLLECTED_TEXT = 1 << 20; // 1 MiB

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
    autoCompacted: false,
    compactionCount: 0,
    sessionFile: "", systemPromptFile: "", lastPromptHash: undefined,
    streamLineBuf: "",
    logLines: [],
    logHead: 0,
    streamLogIdx: 0,
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
  ap.streamLogIdx = ap.logLines.length;
  ap.resolveDispatch = null;
  ap.autoCompacted = false;
  ap.compactionCount = 0;
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
  const destructive = new Set(destructiveTools.map(s => s.trim().toLowerCase()).filter(Boolean));
  return def.tools.split(",").some(tool => destructive.has(tool.trim().toLowerCase()));
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

// ── Logging ──
// In-memory, per-agent ring buffers. The TUI widget renders these directly
// (see ui.ts), replacing the old tmux/herdr "Agent Team Log" side pane. No file
// stream or external pane is involved; lines are stored RAW (no border) and the
// widget boxes them at the actual widget width.

export const LOG_RING_MAX = 300;

/** Strip everything that corrupts the monospace log grid: ANSI escape codes,
 *  carriage returns, and other control characters. Tabs become two spaces. */
export const ansiRe = /\x1b\[[0-9;]*m/g;
const ctrlRe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
export function sanitizeLine(s: string): string {
  let t = s.replace(ansiRe, "");   // drop colour/style escapes
  t = t.replace(/\r/g, "");        // drop CR (progress bars, \r\n)
  t = t.replace(/\t/g, "  ");      // tabs -> 2 spaces
  t = t.replace(ctrlRe, "");       // drop remaining control chars
  return t.trimEnd();
}

export class SessionLogger {

  /** Append a line to the owning agent's ring buffer. The widget boxes these
   *  at the actual widget width, so lines are stored RAW (no border) here. */
  private push(ap: AgentProc, s: string) {
    const value = sanitizeLine(s);
    const buf = ap.logLines;
    if (buf.length < LOG_RING_MAX) {
      buf.push(value);
      return;
    }
    // Keep the public array shape for the renderer, but overwrite the oldest
    // slot instead of shifting/splicing on every streamed line.
    buf[ap.logHead] = value;
    ap.logHead = (ap.logHead + 1) % LOG_RING_MAX;
  }

  // ── Low-level write helpers ──

  log(msg: string, ap: AgentProc) {
    this.push(ap, msg);
  }

  /** Store each line RAW (no outer box): the widget wraps it in the per-agent
   *  panel border at the actual widget width, so box-drawing here would
   *  mismatch. Used for subprocess stderr and memory notes. */
  logBoxed(msg: string, ap?: AgentProc | null) {
    if (!ap) return;
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
    this.push(ap, `▶ ${tool}${detail ? " " + detail : ""}`);
  }

  logToolEnd(ap: AgentProc, tool: string, ok: boolean, durMs?: number) {
    const tag = ok ? "✓" : "✗";
    const dur = durMs ? ` (${Math.round(durMs)}ms)` : "";
    // Mark the tool-call line in place (no separate status line). Scan
    // backwards for the most recent line that starts with `▶ <tool>` — an
    // already-ended call carries ✓/✗ instead, so this always finds the
    // in-flight one even under parallel/out-of-order tool events or ring
    // buffer rollover, and never corrupts a different line. The word
    // boundary check keeps a `▶ Task #…` header from matching a tool
    // whose name is a prefix of another string.
    for (let i = ap.logLines.length - 1; i >= 0; i--) {
      const line = ap.logLines[i];
      if (line.startsWith(`▶ ${tool}`) && (line.length === tool.length + 2 || line[tool.length + 2] === " ")) {
        ap.logLines[i] = tag + line.slice(1) + dur;
        return;
      }
    }
    // No recorded start (e.g. tool_end without tool_start) — keep the line
    // unambiguous rather than silently dropping the event.
    this.push(ap, `${tag} ${tool}${dur}`);
  }

  logDoneBox(ap: AgentProc, elapsedSec: number, tools: number) {
    this.push(ap, `✓ DONE ${elapsedSec}s · ${tools} tools`);
  }

  logErrorBox(ap: AgentProc, heading: string, detail: string) {
    this.push(ap, `✗ ${this.agentLabel(ap)}`);
    this.push(ap, `  ${heading}`);
    if (detail) this.push(ap, `  ${detail}`);
  }

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
  /** Called for non-empty stderr lines. Routed only to this subprocess owner. */
  onStderr?: (line: string) => void;
}

export interface RpcSubprocess {
  proc: ChildProcess;
  /** Send a signal and terminate the owned process. Idempotent. */
  kill: (signal?: NodeJS.Signals) => void;
  /** True once kill() has been requested. */
  killed: boolean;
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
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = () => {
    if (settled) return false;
    settled = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
    return true;
  };
  const fireError = (err: Error) => {
    if (!settle()) return;
    opts.onError(err);
  };
  const fireClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!settle()) return;
    opts.onClose(code, signal);
  };

  // Read JSONL events from stdout
  proc.stdout!.setEncoding("utf-8");
  // Cap the in-flight line buffer so a runaway single line (no \n) cannot
  // exhaust memory. If we exceed the cap, force-emit the buffer as a
  // truncated line and reset — the consumer can then decide what to do.
  const MAX_LINE_BUF = 1 << 20; // 1 MiB
  let stdoutBuf = "";
  let stdoutEnded = false;
  // Emit one complete (or, at EOF, final partial) line. The completion
  // event (agent_end / final response) is often the LAST thing on stdout
  // and may not be newline-terminated; flushing only on "\n" silently
  // drops it, so we also drain the remainder on 'end'/'close'.
  const emitLine = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) return;
    opts.onLine(line);
  };
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
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      emitLine(line);
    }
  });
  // Drain trailing partial line when the stream ends (no trailing \n).
  proc.stdout!.on("end", () => {
    stdoutEnded = true;
    if (stdoutBuf.length > 0) emitLine(stdoutBuf);
    stdoutBuf = "";
  });

  proc.stderr!.setEncoding("utf-8");
  let stderrBuf = "";
  const emitStderr = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) return;
    opts.onStderr?.(line);
    if (!opts.onStderr && opts.owner) opts.logger.logBoxed(line, opts.owner);
  };
  proc.stderr!.on("data", (d: string) => {
    stderrBuf += d;
    let nl: number;
    while ((nl = stderrBuf.indexOf("\n")) >= 0) {
      emitStderr(stderrBuf.slice(0, nl));
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });
  proc.stderr!.on("end", () => {
    if (stderrBuf) emitStderr(stderrBuf);
    stderrBuf = "";
  });

  proc.on("error", (err) => {
    fireError(err);
  });

  proc.on("close", (code, signal) => {
    // Backstop: deliver any final buffered line only if stdout did not already
    // flush it on 'end'. This keeps completion delivery exactly-once.
    if (!stdoutEnded && stdoutBuf.length > 0) emitLine(stdoutBuf);
    stdoutBuf = "";
    if (stderrBuf.length > 0) emitStderr(stderrBuf);
    stderrBuf = "";
    fireClose(code, signal);
  });

  return {
    proc,
    get killed() { return killed; },
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (killed) return;
      killed = true;
      try { proc.stdin?.end(); } catch { }
      try { proc.stdout?.resume(); } catch { }
      try { proc.stderr?.resume(); } catch { }
      try { proc.kill(signal); } catch { }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (!settled) {
          try { proc.kill("SIGKILL"); } catch { }
        }
      }, 2000);
    },
  };
}
