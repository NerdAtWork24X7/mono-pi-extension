import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";
import type { SessionLogger } from "./core";
import type { AgentDef, AgentProc, AgentTeamContext, MemoryState } from "./core";
import { blankProcState, parseModelId } from "./core";
import { spawnRpcSubprocess, type RpcSubprocess } from "./core";
import { buildExtensionCliArgs, buildScopeNameArgs } from "./extensions";
import { loadTeamsYaml, saveTeamsYaml, teamsYamlPath } from "./config";
import { makeHandleEvent } from "./orchestration";
import { piBin, trunc } from "./helpers";

/** Tight system prompt for the memory updater subprocess. The LLM is the
 *  sole writer of the memory file; the host only observes that a write
 *  occurred via tool_execution_start events. */

function buildMemorySystemPrompt(memoryFilePath: string): string {
  return `You are a project memory consolidator. Analyze the latest conversation turn and update \`${memoryFilePath}\` with persistent project knowledge.

---

# Project Memory File Structure

## Design Decisions
Architectural, algorithmic, and structural choices. Update or replace superseded entries.

## Facts
Concrete technical facts (file:line references, configs, APIs, constraints). Correct when changed.

## User Taste & Preferences
Observed user preferences regarding coding style, library choices, tone, and formatting.

## User Suggestions
Explicit user ideas or backlog items requested for future consideration.

## Failures & Solutions
Notable errors, root causes encountered, and the exact fixes that resolved them.

---

# Rules (Strictly Enforced)
- Capture ONLY project-specific, high-value facts; omit generic conversation.
- Merge new information and prune obsolete/superseded bullet points.
- No timestamps, conversational preamble, code fences, or meta-commentary.
- Do not create new top-level sections.
- Keep total file length concise (under 500 words).
- Write output directly to \`${memoryFilePath}\`.`;
}


/** Max idle time (no stdout line) before the memory subprocess is aborted. */
const IDLE_TIMEOUT_MS = 60_000;

/** After the memory file is detected written, give the LLM a short grace
 *  period to finalize, then treat the run as complete. Without this the
 *  subprocess can write the file yet keep streaming (never emitting
 *  `agent_end`), leaving MemoryState stuck at "summarizing" and the in-TUI
 *  memory log pinned on screen after the work is actually done. */
const SETTLE_MS = 5_000;

/** Hard wall-clock cap on a single memory run. Backstops a subprocess that
 *  stays active (keeps emitting lines, so the idle timeout never fires) yet
 *  never terminates — otherwise the log could remain visible indefinitely. */
const MEMORY_HARD_TIMEOUT_MS = 90_000;

/** Max queued summaries. If the orchestrator dispatches faster than the
 *  summarizer can consume, older entries are dropped to prevent unbounded
 *  memory growth. Each entry holds the full turn input+output. */
const MAX_PENDING_SUMMARIES = 10;

/** Pull the final assistant text from an agent_end messages array. */
export function extractLastAssistantText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i];
    if (m && m.role === "assistant") {
      const content = m.content;
      if (Array.isArray(content)) {
        return content
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
      }
      return "";
    }
  }
  return "";
}

/** Create a MemoryManager wired to the team's logger/session dirs. Sets up
 *  the memory dir + file path on ctx as a side effect. Shared by index.ts
 *  (session load) and the sidebar toggle so construction can't drift. */
export function createMemoryManager(ctx: AgentTeamContext, model: string): MemoryManager {
  mkdirSync(ctx.memoryDir, { recursive: true });
  ctx.memoryFile = join(ctx.memoryDir, "project_memory.md");
  return new MemoryManager({
    model,
    memoryFile: ctx.memoryFile,
    sessionDir: ctx.sessionDir,
    logger: ctx.logger,
    invalidate: () => ctx.invalidate(),
    cachedExtPaths: () => ctx.cachedExtPaths,
    def: {
      name: "memory-summarizer",
      description: "Per-turn memory summarizer spawned alongside the orchestrator.",
      tools: "read,write,edit",
      systemPrompt: "",
      file: "",
    },
    handleEvent: makeHandleEvent(ctx),
  });
}

/** Toggle the memory feature on/off (sidebar Enter on the Memory row).
 *  Persists the flag to teams.yaml (`memory_model.active`) and keeps
 *  `originalMemoryModel` so the configured model survives an off→on cycle. */
export function toggleMemory(ctx: AgentTeamContext): void {
  if (ctx.memoryManager) {
    // Disable — preserve original model for re-enabling
    try { ctx.memoryManager.abort(); } catch { }
    try { void ctx.memoryManager.awaitIdle(0); } catch { }
    ctx.memoryManager = null;
    ctx.memoryModel = "";
    ctx.memoryFile = "";
  } else {
    // Enable — use preserved original model or read from teams.yaml
    const model = ctx.originalMemoryModel || loadTeamsYaml(teamsYamlPath()).memoryModel || "";
    if (model) {
      ctx.originalMemoryModel = model;
      ctx.memoryModel = model;
      ctx.memoryManager = createMemoryManager(ctx, model);
    }
  }
  const parsed = loadTeamsYaml(teamsYamlPath());
  parsed.memoryModel = ctx.memoryModel || ctx.originalMemoryModel || undefined;
  parsed.memoryActive = !!ctx.memoryManager;
  saveTeamsYaml(teamsYamlPath(), parsed);
  ctx.catalogDirty = true;
  ctx.invalidate();
}

/**
 * Per-turn background memory updater. Owns a single `pi --mode rpc`
 * subprocess lifetime. The LLM uses the read/write/edit tools to maintain
 * the project memory file; the host only detects whether the file was
 * written by observing tool_execution_start events.
 */
export class MemoryManager {
  private model: string;
  private memoryFile: string;
  private sessionDir: string;
  private logger: SessionLogger;
  private invalidate: () => void;
  private cachedExtPaths: () => string[];
  private def: AgentDef;
  private handleEvent: (ap: AgentProc, line: string) => void;
  private logAgent: AgentProc | null = null; // active memory subagent (for the in-TUI log grid)

  private state: MemoryState = { status: "idle", runCount: 0, lastSummaryAt: 0, lastError: "", elapsed: 0 };
  private pendingInput = "";
  private pendingOutput = "";

  private currentSub: RpcSubprocess | null = null;
  /** Resolves the in-flight run early (kills the child without the
   *  non-zero-exit path reporting it as an error). Set by runSubprocess. */
  private currentCancel: (() => void) | null = null;
  /** Set by abort()/cancelCurrentRun() so the drain loop reports "idle"
   *  instead of "done"/"error" for a run the user killed. */
  private abortRequested = false;
  private currentSessionFile = "";
  private currentSystemPromptFile = "";
  private busy = false;
  private pendingSummaries: Array<{ input: string; output: string; signal?: AbortSignal }> = [];
  private draining = false;

  constructor(opts: {
    model: string;
    memoryFile: string;
    sessionDir: string;
    logger: SessionLogger;
    invalidate: () => void;
    cachedExtPaths: () => string[];
    def: AgentDef;
    handleEvent: (ap: AgentProc, line: string) => void;
  }) {
    this.model = opts.model;
    this.memoryFile = opts.memoryFile;
    this.sessionDir = opts.sessionDir;
    this.logger = opts.logger;
    this.invalidate = opts.invalidate;
    this.cachedExtPaths = opts.cachedExtPaths;
    this.def = opts.def;
    this.handleEvent = opts.handleEvent;
  }

  // ── Public read surface ──

  status(): MemoryState["status"] { return this.state.status; }
  get runCount(): number { return this.state.runCount; }
  get lastSummaryAt(): number { return this.state.lastSummaryAt; }
  get lastError(): string { return this.state.lastError; }
  get snapshot(): MemoryState { return { ...this.state }; }
  get memoryLogAgent(): AgentProc | null { return this.logAgent; }

  // ── Lifecycle hooks (called from index.ts) ──

  /** Called from before_agent_start. Captures the user prompt for this turn. */
  recordInput(text: string) {
    // If a previous turn's summary is still running, abandon it cleanly.
    // Ensures the previous turn's log panel is dismissed immediately;
    // otherwise the old logAgent resurfaces as soon as status flips to
    // "recording" and the widget re-renders.
    this.cancelCurrentRun();
    this.pendingInput = text || "";
    this.pendingOutput = "";
    this.state.runCount++;
    this.setStatus("recording");
  }

  /** Called from agent_end with the final assistant text (or "" if none).
   *  `signal` is the turn's abort signal so an ESC/abort of the turn also
   *  cancels the memory summarizer spawned for it. */
  recordOutput(text: string, signal?: AbortSignal) {
    if (this.state.status !== "recording") return;
    const trimmed = (text || "").trim();
    if (!trimmed) {
      // No assistant output → nothing to summarize
      this.setStatus("idle");
      return;
    }
    this.enqueueSummary(this.pendingInput, trimmed, signal);
    this.setStatus("summarizing");
  }

  /** Abort any in-flight memory summarization and drop queued summaries.
   *  Mirrors killing dispatch clones on ESC. Safe to call when idle. */
  abort() {
    // Drop queued work so the drain loop stops after the current run settles.
    // `draining` is owned by drainSummaries' finally block — clearing it here
    // would let a concurrent second drain loop start.
    this.pendingSummaries.length = 0;
    this.cancelCurrentRun();
    if (this.state.status === "summarizing") {
      this.setStatus("idle");
    }
  }

  /** Tear down the in-flight subprocess without the drain loop flagging it
   *  as an error (a killed child closes with a non-zero/null code). */
  private cancelCurrentRun() {
    if (!this.currentSub && !this.currentCancel) return;
    this.abortRequested = true;
    const cancel = this.currentCancel;
    this.currentCancel = null;
    if (cancel) {
      try { cancel(); } catch { }
    } else if (this.currentSub) {
      try { this.currentSub.kill(); } catch { }
    }
    this.currentSub = null;
    this.logAgent = null;
  }

  /** Best-effort wait for any in-flight subprocess (used on session_shutdown). */
  async awaitIdle(timeoutMs = 3000): Promise<void> {
    const t0 = Date.now();
    while ((this.busy || this.state.status === "summarizing") && (Date.now() - t0) < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.currentSub) {
      try { this.currentSub.proc.kill("SIGKILL"); } catch { }
      this.currentSub = null;
    }
  }

  // ── Internals ──

  private setStatus(s: MemoryState["status"], err: string = "") {
    this.state.status = s;
    if (err) this.state.lastError = err;
    this.invalidate();
  }

  private enqueueSummary(input: string, output: string, signal?: AbortSignal) {
    // Cap queue to prevent unbounded memory growth.
    // Drop oldest entries when the summarizer can't keep up.
    while (this.pendingSummaries.length >= MAX_PENDING_SUMMARIES) {
      this.pendingSummaries.shift();
    }
    this.pendingSummaries.push({ input, output, signal });
    if (!this.draining) {
      this.draining = true;
      void this.drainSummaries();
    }
  }

  private async drainSummaries() {
    try {
      while (this.pendingSummaries.length > 0) {
        const next = this.pendingSummaries.shift()!;
        this.busy = true;
        try {
          this.pendingInput = next.input;
          this.pendingOutput = next.output;
          // Clear any flag left over from a run that finished on its own
          // just as a cancel came in, so it can't mislabel this run.
          this.abortRequested = false;
          const { wroteFile } = await this.runSubprocess(next.signal);
          if (this.abortRequested) {
            this.abortRequested = false;
            this.setStatus("idle");
          } else {
            this.state.lastSummaryAt = Date.now();
            this.state.lastError = "";
            this.setStatus("done");
            if (!wroteFile) {
              this.logger.logBoxed(`memory: no update needed for turn #${this.state.runCount}`, this.logAgent ?? undefined);
            }
          }
        } catch (err: any) {
          if (this.abortRequested) {
            // User-initiated kill — not an error worth surfacing.
            this.abortRequested = false;
            this.setStatus("idle");
          } else {
            const msg = (err && err.message) ? err.message : String(err);
            this.setStatus("error", msg);
          }
        } finally {
          this.busy = false;
          this.currentSub = null;
          // Detach the completed/failed memory subagent from the TUI log
          // grid so the panel closes once the run is finished.
          this.logAgent = null;
          this.cleanupSessionFiles();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private writeSystemPromptFile() {
    this.currentSystemPromptFile = join(this.sessionDir, `memory-system-prompt-${Date.now()}.txt`);
    writeFileSync(this.currentSystemPromptFile, buildMemorySystemPrompt(this.memoryFile));
  }

  private cleanupSessionFiles() {
    if (this.currentSessionFile && existsSync(this.currentSessionFile)) {
      try { unlinkSync(this.currentSessionFile); } catch { }
    }
    if (this.currentSystemPromptFile && existsSync(this.currentSystemPromptFile)) {
      try { unlinkSync(this.currentSystemPromptFile); } catch { }
    }
    this.currentSessionFile = "";
    this.currentSystemPromptFile = "";
  }

  private runSubprocess(signal?: AbortSignal): Promise<{ wroteFile: boolean }> {
    this.writeSystemPromptFile();

    // Snapshot the memory file's mtime so we can fall back to it
    // when the LLM writes via a tool call we couldn't attribute
    // (e.g. relative path, symlink, or arg under a key we don't
    // recognise). File may not exist yet — treat as 0.
    let preMtime = 0;
    try { preMtime = statSync(this.memoryFile).mtimeMs; } catch { /* file may not exist yet */ }

    // Split provider from model on first "/" (matches process.ts pattern)
    const { provider, model: modelName } = parseModelId(this.model);

    const ts = Date.now();
    this.currentSessionFile = join(this.sessionDir, `memory-${ts}.json`);

    const memoryAp: AgentProc = {
      ...blankProcState(),
      def: this.def,
      model: this.model,
      sessionFile: this.currentSessionFile,
      systemPromptFile: this.currentSystemPromptFile,
      proc: null,
      procRef: null,
      status: "starting",
    };
    this.logAgent = memoryAp;

    const extPaths = this.cachedExtPaths();
    const cliArgs = [
      "--mode", "rpc",
      "-p",
      ...buildExtensionCliArgs(extPaths),
      ...(provider ? ["--provider", provider] : []),
      "--no-skills",
      "--no-context-files",
      "--thinking", "off",
      "--model", modelName,
      "--tools", memoryAp.def.tools,
      "--system-prompt", memoryAp.systemPromptFile,
      "--session", memoryAp.sessionFile,
      "--name", memoryAp.def.name,
      ...buildScopeNameArgs(extPaths, memoryAp.def.name),
    ];

    const bin = piBin();

    const mtimeAdvanced = () => {
      try {
        const post = statSync(this.memoryFile).mtimeMs;
        return post > preMtime;
      } catch {
        return false;
      }
    };

    return new Promise<{ wroteFile: boolean }>((resolve, reject) => {
      let fileWritten = false;
      let ready = false;
      let settled = false;
      let lastLineAt = Date.now();
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup: (() => void) | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.currentCancel = null;
        if (memoryAp.timer) { clearInterval(memoryAp.timer); memoryAp.timer = undefined; }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = undefined; }
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
        if (abortCleanup) { abortCleanup(); abortCleanup = undefined; }
        try { sub.kill(); } catch { }
        fn();
      };

      const sub = spawnRpcSubprocess({
        bin,
        args: cliArgs,
        logger: this.logger,
        onLine: (line) => {
          lastLineAt = Date.now();
          let ev: any;
          try { ev = JSON.parse(line); } catch { return; }

          // Route through the standard rpc pipeline first so streaming
          // text, tool start/end, agent_end, etc. all get logged and
          // the animation timer is cleared on agent_end.
          this.handleEvent(memoryAp, line);

          if (ev.type === "response") {
            if (!ready) {
              ready = true;
              if (!ev.success) {
                finish(() => reject(new Error(`memory readiness failed: ${ev.error || "unknown"}`)));
                return;
              }
              memoryAp.status = "running";
              memoryAp.lastActivity = Date.now();
              const taskText = `Summarize turn #${this.state.runCount}\n` +
                `User: ${trunc(this.pendingInput, 200)}\n` +
                `Assistant: ${trunc(this.pendingOutput, 200)}`;
              memoryAp.task = taskText;
              this.logger.logTaskBox(memoryAp, this.state.runCount, taskText);
              const promptPayload = {
                type: "prompt",
                message:
                  `# Latest turn\n\n` +
                  `User input: ${this.pendingInput}\n\n` +
                  `Assistant output: ${this.pendingOutput}\n\n`,
              };
              try {
                sub.proc.stdin!.write(JSON.stringify(promptPayload) + "\n");
              } catch (e: any) {
                finish(() => reject(new Error("failed to write prompt: " + (e?.message || e))));
              }
            }
          } else if (ev.type === "tool_execution_start") {
            // Detect a write/edit targeting the memory file path. The
            // built-in `write` tool accepts `path` or `file_path`;
            // `edit` uses `path`. Resolve against cwd so absolute and
            // relative paths both match.
            const tool = ev.toolName;
            const toolArgs = ev.args;
            if ((tool === "write" || tool === "edit") && toolArgs && typeof toolArgs === "object") {
              const raw = (toolArgs as any).path
                ?? (toolArgs as any).file_path
                ?? (toolArgs as any).file;
              if (typeof raw === "string" && raw.length > 0) {
                const target = resolvePath(raw);
                if (target === this.memoryFile) {
                  fileWritten = true;
                  // The LLM's only job is to update this file; once it has,
                  // the meaningful work is done. Let it finalize briefly,
                  // then complete the run so the log grid hides.
                  if (!settleTimer) {
                    settleTimer = setTimeout(() => {
                      finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
                    }, SETTLE_MS);
                  }
                  this.logger.logBoxed(`memory: detected write to ${target}`, memoryAp);
                }
              }
            }
          } else if (ev.type === "agent_end") {
            finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
          }
        },
        onError: (err) => {
          finish(() => reject(new Error("spawn error: " + err.message)));
        },
        onClose: (code) => {
          if (settled) return;
          if (code === 0) {
            finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
          } else {
            finish(() => reject(new Error(`memory subprocess exited with code ${code}`)));
          }
        },
      });
      memoryAp.proc = sub.proc;
      memoryAp.procRef = sub;
      this.currentSub = sub;
      // Lets abort()/recordInput() end the run without the killed child's
      // close code being reported as a memory error.
      if (!settled) {
        this.currentCancel = () => finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
      }

      // ESC/abort parity: if the turn that spawned this summary is aborted
      // (ESC), tear the summarizer down too — exactly like the dispatch
      // clones killed via the dispatch abort signal.
      if (signal) {
        const onAbort = () => finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
        signal.addEventListener("abort", onAbort);
        abortCleanup = () => { try { signal.removeEventListener("abort", onAbort); } catch { } };
        if (signal.aborted) onAbort();
      }

      // Already aborted before we started (e.g. an ESC-aborted turn):
      // finish() has resolved and killed the child, so skip timer setup.
      if (settled) return;

      // Hard wall-clock cap: guarantees the run terminates even if the
      // subprocess stays active without ever emitting agent_end.
      hardTimer = setTimeout(() => {
        finish(() => resolve({ wroteFile: fileWritten || mtimeAdvanced() }));
      }, MEMORY_HARD_TIMEOUT_MS);

      // Animation + elapsed timer — drives the widget's animDots (via
      // invalidate → animFrame bump) and keeps memoryAp.elapsed current
      // for handleAgentEnd's logDoneBox. Cleared by handleAgentEnd (via
      // handleEvent on agent_end) and defensively in finish().
      const t0 = Date.now();
      memoryAp.timer = setInterval(() => {
        memoryAp.elapsed = Date.now() - t0;
        this.state.elapsed = memoryAp.elapsed;
        if (Date.now() - lastLineAt > IDLE_TIMEOUT_MS) {
          finish(() => reject(new Error(`memory subprocess idle for more than ${IDLE_TIMEOUT_MS}ms`)));
        }
        this.invalidate();
      }, 500);

      // Readiness probe — mirrors orchestration.ts. Send get_state
      // immediately; the child's stdin pipe buffers it until its RPC reader
      // is up, so no fixed startup delay is needed.
      if (ready) return;
      if (!sub.proc.stdin || !sub.proc.stdin.writable) return;
      try { sub.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n"); } catch { }
    });
  }
}

// ── ESC → abort the running summarizer ──
//
// `escape` resolves to the built-in `app.interrupt` keybinding, which is in
// pi's RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS list — pi.registerShortcut
// ("escape") is skipped with a warning. And the summarizer starts at
// `agent_end`, i.e. while the app is idle, so the turn's abort signal is
// already spent. The supported hook is a custom editor component: subclass
// CustomEditor, intercept ESC, delegate everything else to the base class
// (pi copies onEscape/onCtrlD/actionHandlers onto it, so default behaviour
// is preserved — see interactive-mode setCustomEditorComponent).

let escFactory: ((tui: any, theme: any, keybindings: any) => any) | null = null;

/** Install the ESC interceptor. No-op when another extension already owns the
 *  editor component slot, or when it is already installed. */
export function installMemoryEscEditor(team: AgentTeamContext, ctx: any) {
  const ui = ctx?.ui;
  if (!ui || typeof ui.setEditorComponent !== "function") return;
  if (ui.getEditorComponent?.()) return; // ours (already installed) or foreign — leave it
  if (!escFactory) {
    class MemoryEscEditor extends CustomEditor {
      handleInput(data: string): void {
        const mm = team.memoryManager;
        if (mm && mm.status() === "summarizing"
          && matchesKey(data, Key.escape)
          && !(this as any).isShowingAutocomplete?.()) {
          mm.abort();
          // Idle: consume the key. Streaming (a queued summary running
          // under the next turn): fall through so the turn aborts too.
          let streaming = false;
          try { streaming = team.wCtx?.isIdle?.() === false; } catch { }
          if (!streaming) return;
        }
        super.handleInput(data);
      }
    }
    escFactory = (tui: any, theme: any, keybindings: any) => new MemoryEscEditor(tui, theme, keybindings);
  }
  ui.setEditorComponent(escFactory);
}

/** Restore the default editor when memory is switched off. */
export function removeMemoryEscEditor(ctx: any) {
  const ui = ctx?.ui;
  if (!ui || typeof ui.setEditorComponent !== "function") return;
  if (escFactory && ui.getEditorComponent?.() === escFactory) ui.setEditorComponent(undefined);
}
