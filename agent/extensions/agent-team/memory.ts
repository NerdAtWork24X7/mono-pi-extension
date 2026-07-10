import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve as resolvePath } from "path";
import type { SessionLogger } from "./core";
import type { AgentDef, AgentProc, MemoryState } from "./core";
import { blankProcState } from "./core";
import { spawnRpcSubprocess, type RpcSubprocess } from "./core";

/** Tight system prompt for the memory updater subprocess. The LLM is the
 *  sole writer of the memory file; the host only observes that a write
 *  occurred via tool_execution_start events. */

function buildMemorySystemPrompt(memoryFilePath: string): string {
	return `You are a highly skilled memory updater for Project,Analyse the latest conversation and update  ${memoryFilePath} with relevant information.
---

# Project Memory File Structure

## Design Decisions
Architectural and structural choices. Update or replace superseded entries.

## Facts
Concrete facts (file:line refs, configs, APIs, constraints). Correct if changed.

## User Taste
Observed preferences: style, tone, formatting habits.

## User Suggestions
Explicit ideas or requests for future consideration.

## Failures and solutions
what failures occurs and what solution fixed

---

Rules (strictly enforced):
- Only add project specific information rest can be ignored
- Merge new info; remove superseded entries
- No dates, no preamble, no fences, no commentary
- No new sections
- Total output under 500 words
- Only write to the path above`
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

/** Truncate a string to at most `n` graphemes, appending "..." when cut. */
function truncate(s: string, n: number): string {
	if (n <= 0) return "";
	if (!s) return "";
	return [...s].length > n ? [...s].slice(0, n - 1).join("") + "..." : s;
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
	private currentSessionFile = "";
	private currentSystemPromptFile = "";
	private busy = false;
	private pendingSummaries: Array<{ input: string; output: string }> = [];
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
		if (this.currentSub) {
			this.currentSub.kill();
			this.currentSub = null;
		}
		this.pendingInput = text || "";
		this.pendingOutput = "";
		this.state.runCount++;
		this.setStatus("recording");
	}

	/** Called from agent_end with the final assistant text (or "" if none). */
	recordOutput(text: string) {
		if (this.state.status !== "recording") return;
		const trimmed = (text || "").trim();
		if (!trimmed) {
			// No assistant output → nothing to summarize
			this.setStatus("idle");
			return;
		}
		this.enqueueSummary(this.pendingInput, trimmed);
		this.setStatus("summarizing");
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

	private enqueueSummary(input: string, output: string) {
		this.pendingSummaries.push({ input, output });
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
					const { wroteFile } = await this.runSubprocess();
					this.state.lastSummaryAt = Date.now();
					this.state.lastError = "";
					this.setStatus("done");
					if (!wroteFile) {							this.logger.logBoxed(`memory: no update needed for turn #${this.state.runCount}`, this.logAgent ?? undefined);
					}
				} catch (err: any) {
					const msg = (err && err.message) ? err.message : String(err);
					this.setStatus("error", msg);
				} finally {
					this.busy = false;
					this.currentSub = null;
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

	private runSubprocess(): Promise<{ wroteFile: boolean }> {
		this.writeSystemPromptFile();

		// Snapshot the memory file's mtime so we can fall back to it
		// when the LLM writes via a tool call we couldn't attribute
		// (e.g. relative path, symlink, or arg under a key we don't
		// recognise). File may not exist yet — treat as 0.
		let preMtime = 0;
		try { preMtime = statSync(this.memoryFile).mtimeMs; } catch { /* file may not exist yet */ }

		// Split provider from model on first "/" (matches process.ts pattern)
		const slashIdx = this.model.indexOf("/");
		const hasProvider = slashIdx > 0;
		const provider = hasProvider ? this.model.slice(0, slashIdx) : undefined;
		const modelName = hasProvider ? this.model.slice(slashIdx + 1) : this.model;

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

		const cliArgs = [
			"--mode", "rpc",
			"-p",
			"--no-extensions",
			...this.cachedExtPaths().flatMap(p => ["--extension", p]),
			...(provider ? ["--provider", provider] : []),
			"--no-skills",
			"--no-context-files",
			"--model", modelName,
			"--tools", memoryAp.def.tools,
			"--system-prompt", memoryAp.systemPromptFile,
			"--session", memoryAp.sessionFile,
		];

		const bin = process.platform === "win32" ? "pi.cmd" : "pi";

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

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (memoryAp.timer) { clearInterval(memoryAp.timer); memoryAp.timer = undefined; }
				if (settleTimer) { clearTimeout(settleTimer); settleTimer = undefined; }
				if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
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
								`User: ${truncate(this.pendingInput, 200)}\n` +
								`Assistant: ${truncate(this.pendingOutput, 200)}`;
							memoryAp.task = taskText;
							this.logger.logTaskBox(memoryAp, this.state.runCount, taskText);
							const inlinedContent = (() => {
								try {
									if (existsSync(this.memoryFile)) {
										const buf = readFileSync(this.memoryFile);
										const text = buf.toString("utf8");
										if (text.trim().length > 0) return text;
									}
								} catch { }
								return `(file is empty or does not exist yet — start a fresh document with the "# Project Memory" title)`;
							})();
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

			// Readiness probe — mirrors process.ts. Wait 500ms, then ask for state.
			setTimeout(() => {
				if (ready) return;
				if (!sub.proc.stdin || !sub.proc.stdin.writable) return;
				try { sub.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n"); } catch { }
			}, 500);
		});
	}
}
