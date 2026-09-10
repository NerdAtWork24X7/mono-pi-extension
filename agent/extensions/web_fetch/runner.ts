import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";

// ── Config ──────────────────────────────────────────────────────────────
function envNum(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CRAWL_TIMEOUT_MS = envNum("WEB_FETCH_CRAWL_TIMEOUT_MS", 60_000); // whole-batch cap
export const BATCH_CONCURRENCY = envNum("WEB_FETCH_CONCURRENCY", 4); // parallel tabs in the one Chromium
export const MAX_RESULT_CHARS = envNum("WEB_FETCH_MAX_CHARS", 50_000); // per-page markdown cap
export const MAX_RAW_CHARS = envNum("WEB_FETCH_MAX_RAW_CHARS", 50_000); // raw-HTML cap (raw bypasses the markdown cap)
export const PAGE_DELAY_S = envNum("WEB_FETCH_PAGE_DELAY_S", 2); // per-page settle delay (full fetches)
export const SCAN_FULL_PAGE = (process.env.WEB_FETCH_SCAN_FULL_PAGE ?? "1") !== "0";
// Headroom above the markdown cap for the DDG search page: link extraction
// needs more text than any single result section gets.
export const SEARCH_TEXT_CHARS = Math.max(MAX_RESULT_CHARS * 5, 50_000);
// How long the warm Python/Chromium runner may idle before shutdown. Keeping
// it alive is the main perf win: Python import + browser launch take seconds
// and used to be paid on EVERY batch. Set 0 to disable keep-warm.
const IDLE_MS = (() => {
	const n = Number(process.env.WEB_FETCH_IDLE_MS);
	return Number.isFinite(n) && n >= 0 ? n : 300_000; // 5min
})();
// Persistent Chromium profile dir: cookies/logins/site state live on disk here
// and survive process restarts, so the SAME browser session is reused across
// all tool calls (and after a respawn). Mirrors the Python default.
export const PROFILE_DIR = process.env.WEB_FETCH_PROFILE_DIR
	?? join(process.cwd(), ".pi", "web-fetch-profile");

/** Whole-batch timeout: jobs run BATCH_CONCURRENCY at a time and each job is
 *  bounded by CRAWL_TIMEOUT_MS, so a batch gets one round-trip per wave. */
function batchTimeoutMs(jobCount: number): number {
	const rounds = Math.max(1, Math.ceil(jobCount / BATCH_CONCURRENCY));
	return rounds * CRAWL_TIMEOUT_MS;
}
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // stderr cap (matches old execAsync maxBuffer)

export type Update = { content: Array<{ type: "text"; text: string }>; details: Record<string, any> };

export interface JobResult {
	ok: boolean;
	text: string;
	error: string;
}
export interface Job {
	key: number;
	url: string;
	raw: boolean;
	light: boolean; // cheap config (no human simulation) — used for the search page
	max?: number; // per-job text cap, enforced by Python BEFORE the pipe transfer
}

// ── Python binary resolution ─────────────────────────────────────────────
function resolvePyBin(): string {
	// 1. explicit override
	if (process.env.WEB_FETCH_PY_BIN) return process.env.WEB_FETCH_PY_BIN;
	// 2. this package's local venv (standalone)
	const localVenv = join(dirname(__filename), ".venv", "bin", "python3");
	if (existsSync(localVenv)) return localVenv;
	// 3. last resort
	return "/home/alexa/wk/.venv/bin/python3";
}
const PY_BIN = resolvePyBin();
const PY_SCRIPT = join(dirname(__filename), "web-fetch.py");

// ── Process helpers ──────────────────────────────────────────────────────
/** Kill a spawned crawler and its whole process group (Playwright/Chromium
 *  grandchildren). Returns the SIGKILL fallback timer to cancel on exit. */
function killProcessGroup(child: ChildProcess, sigkillTimer?: ReturnType<typeof setTimeout> | null) {
	if (sigkillTimer) clearTimeout(sigkillTimer);
	const pid = child.pid;
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM"); // negative PID = process group (detached session)
		return setTimeout(() => {
			try { process.kill(-pid, "SIGKILL"); } catch {}
		}, 2000);
	} catch {
		try { child.kill("SIGTERM"); } catch {}
		return undefined;
	}
}

/** Keep the tail of a UTF-8 string within a byte budget without splitting a
 *  multi-byte char. Caps noisy stderr while preserving the most recent bytes. */
function keepTailByBytes(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf-8");
	if (buf.length <= maxBytes) return s;
	let start = buf.length - maxBytes;
	while (start > 0 && (buf[start] & 0xc0) === 0x80) start++;
	return buf.subarray(start).toString("utf-8");
}

interface Flight {
	batch: number;
	out: Map<number, JobResult>;
	settled: boolean;
	resolve: (m: Map<number, JobResult>) => void;
	reject: (e: Error) => void;
	onUpdate?: (u: Update) => void;
	timeout: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * Keeps the Python runner (and its Chromium) alive between tool calls.
 * Batches are serialized by the module-level queue below, so at most one
 * Flight is active; stale lines from aborted/timed-out batches are dropped
 * by batch-id matching. The process is respawned lazily after crashes and
 * killed after IDLE_MS of inactivity or on session_shutdown.
 *
 * The browser runs on PROFILE_DIR (a persistent user-data-dir), so even when
 * the process is killed and respawned the session (cookies/logins) carries
 * over — "same browser session" across every tool call.
 */
class Runner {
	private child: ChildProcess | null = null;
	private buf = "";
	private stderr = "";
	private flight: Flight | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private sigkillTimer: ReturnType<typeof setTimeout> | null = null;
	private batchSeq = 0;

	exec(jobs: Job[], signal: AbortSignal | undefined, onUpdate: ((u: Update) => void) | undefined): Promise<Map<number, JobResult>> {
		this.ensureSpawned();
		this.clearIdle();
		return new Promise((resolve, reject) => {
			const flight: Flight = {
				batch: ++this.batchSeq,
				out: new Map(),
				settled: false,
				resolve,
				reject,
				onUpdate,
				// Whole-batch cap scales with batch size: jobs run BATCH_CONCURRENCY
				// at a time, each job bounded by CRAWL_TIMEOUT_MS, so a multi-URL
				// batch gets ceil(jobs/concurrency) rounds instead of one flat cap.
				timeout: setTimeout(() => this.onTimeout(flight), batchTimeoutMs(jobs.length)),
			};
			this.flight = flight;
			if (signal) {
				flight.signal = signal;
				flight.onAbort = () => this.settle(flight, null, new Error("batch crawl aborted"));
				signal.addEventListener("abort", flight.onAbort, { once: true });
			}
			if (signal?.aborted) {
				this.settle(flight, null, new Error("batch crawl aborted"));
				return;
			}
			const req = JSON.stringify({
				batch: flight.batch,
				concurrency: BATCH_CONCURRENCY,
				timeout_ms: CRAWL_TIMEOUT_MS,
				page_delay_s: PAGE_DELAY_S,
				scan_full_page: SCAN_FULL_PAGE,
				jobs,
			});
			try {
				this.child!.stdin!.write(req + "\n");
			} catch (err) {
				this.settle(flight, null, err instanceof Error ? err : new Error(String(err)));
				this.killChild();
			}
		});
	}

	/** Kill the child; reject any in-flight batch. Safe to call anytime. */
	kill(): void {
		this.clearIdle();
		if (this.flight) this.settle(this.flight, null, new Error("crawler shut down"));
		this.killChild();
	}

	private ensureSpawned(): void {
		if (this.child) return;
		this.buf = "";
		this.stderr = "";
		const child = spawn(PY_BIN, [PY_SCRIPT], {
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			// Tell the crawler which persistent profile dir to launch Chromium on.
			env: { ...process.env, WEB_FETCH_PROFILE_DIR: PROFILE_DIR },
		});
		this.child = child;

		child.stderr?.on("data", (d: Buffer) => {
			this.stderr += d.toString("utf-8");
			if (Buffer.byteLength(this.stderr, "utf-8") > MAX_OUTPUT_BYTES) this.stderr = keepTailByBytes(this.stderr, MAX_OUTPUT_BYTES);
		});
		child.stdout?.on("data", (d: Buffer) => {
			this.buf += d.toString("utf-8");
			let idx: number;
			while ((idx = this.buf.indexOf("\n")) >= 0) {
				let line = this.buf.slice(0, idx);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.buf = this.buf.slice(idx + 1);
				this.onLine(line);
			}
		});

		// Single death path for spawn errors and exits (deduped via `dead`).
		let dead = false;
		const onDeath = (err: Error) => {
			if (dead) return;
			dead = true;
			if (this.sigkillTimer) { clearTimeout(this.sigkillTimer); this.sigkillTimer = null; }
			if (this.child === child) this.child = null;
			this.clearIdle();
			if (this.flight) this.settle(this.flight, null, err);
		};
		child.on("error", () => onDeath(new Error(`failed to start crawler (${PY_BIN}): ${this.stderr.trim().slice(-300)}`)));
		child.on("close", (code) => onDeath(new Error(`crawler exited with code ${code}${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ""}`)));
	}

	private onLine(line: string): void {
		if (!line.startsWith("{")) return; // skip non-JSON lines (browser/playwright startup noise)
		let o: any;
		try { o = JSON.parse(line); } catch { return; }
		const f = this.flight;
		if (!f || o.batch !== f.batch) return; // stale line from an aborted batch
		if (o.done) {
			this.settle(f, f.out, null);
			return;
		}
		if (typeof o.key === "number") {
			f.out.set(o.key, { ok: !!o.ok, text: o.text ?? "", error: o.error ?? "" });
			f.onUpdate?.({
				content: [{ type: "text", text: `${o.ok ? "Fetched" : "Failed"}: ${o.url ?? "?"}` }],
				details: { phase: "fetch", url: o.url, ok: !!o.ok, error: o.error ?? "" },
			});
		}
	}

	private onTimeout(f: Flight): void {
		// A hung batch means the process can't be trusted — kill it; the next
		// exec() respawns a fresh one lazily.
		this.settle(f, null, new Error(`batch crawl timed out after ${CRAWL_TIMEOUT_MS}ms`));
		this.killChild();
	}

	private settle(f: Flight, out: Map<number, JobResult> | null, err: Error | null): void {
		if (f.settled) return;
		f.settled = true;
		clearTimeout(f.timeout);
		if (f.signal && f.onAbort) f.signal.removeEventListener("abort", f.onAbort);
		if (this.flight === f) this.flight = null;
		if (err) f.reject(err);
		else f.resolve(out ?? f.out);
		if (this.child) this.armIdle(); // dead process → respawn on demand, no idle timer
	}

	private killChild(): void {
		if (!this.child) return;
		this.sigkillTimer = killProcessGroup(this.child, this.sigkillTimer) ?? null;
		this.child = null;
	}

	private armIdle(): void {
		this.clearIdle();
		if (IDLE_MS <= 0) {
			this.killChild(); // keep-warm disabled: behave like the old spawn-per-batch
			return;
		}
		this.idleTimer = setTimeout(() => this.killChild(), IDLE_MS);
	}

	private clearIdle(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}

let runner: Runner | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize batches through the single warm runner (tool calls may overlap). */
export function runBatch(jobs: Job[], signal?: AbortSignal, onUpdate?: (u: Update) => void): Promise<Map<number, JobResult>> {
	const p = queue.then(() => {
		runner ??= new Runner();
		return runner.exec(jobs, signal, onUpdate);
	});
	queue = p.catch(() => {}); // a failed batch must not jam the queue
	return p;
}

/** Terminate the warm crawler (session shutdown). */
export function shutdownRunner(): void {
	runner?.kill();
	runner = null;
}
