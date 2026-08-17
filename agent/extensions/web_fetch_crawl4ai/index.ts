import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

// ── Config ──────────────────────────────────────────────────────────────
function envNum(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CACHE_NAMESPACE = "crawl4ai";
const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR
	? resolve(process.env.WEB_FETCH_CACHE_DIR)
	: join(homedir(), ".pi", "web-fetch-cache");
const CACHE_TTL_MS = envNum("WEB_FETCH_CACHE_TTL_MS", 3_600_000); // 1h
const CRAWL_TIMEOUT_MS = envNum("WEB_FETCH_CRAWL_TIMEOUT_MS", 60_000); // whole-batch cap
const BATCH_CONCURRENCY = envNum("WEB_FETCH_CONCURRENCY", 4); // parallel tabs in the one Chromium
const MAX_RESULT_CHARS = envNum("WEB_FETCH_MAX_CHARS", 4000); // per-page text cap (context safety)
const PAGE_DELAY_S = envNum("WEB_FETCH_PAGE_DELAY_S", 2); // per-page settle delay (full fetches)
const SCAN_FULL_PAGE = (process.env.WEB_FETCH_SCAN_FULL_PAGE ?? "1") !== "0";
// How long the warm Python/Chromium runner may idle before shutdown. Keeping
// it alive is the main perf win: Python import + browser launch take seconds
// and used to be paid on EVERY batch. Set 0 to disable keep-warm.
const IDLE_MS = (() => {
	const n = Number(process.env.WEB_FETCH_IDLE_MS);
	return Number.isFinite(n) && n >= 0 ? n : 300_000; // 5min
})();
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // stderr cap (matches old execAsync maxBuffer)

// ── Python runner (persistent process: ONE Chromium, NDJSON batch protocol) ─
function resolvePyBin(): string {
	// 1. explicit override
	if (process.env.WEB_FETCH_PY_BIN) return process.env.WEB_FETCH_PY_BIN;
	// 2. this package's local venv (standalone — no global crwl needed)
	const localVenv = join(dirname(__filename), ".venv", "bin", "python3");
	if (existsSync(localVenv)) return localVenv;
	// 3. fall back to the crwl CLI's interpreter (if still installed globally)
	try {
		const crwl = execSync("command -v crwl", { encoding: "utf-8" }).trim();
		if (crwl) {
			const shebang = readFileSync(crwl, "utf-8").split("\n", 1)[0];
			if (shebang.startsWith("#!")) {
				const bin = shebang.slice(2).trim().split(/\s+/)[0];
				if (bin && existsSync(bin)) return bin;
			}
		}
	} catch { /* fall through */ }
	// 4. last resort
	return "/home/alexa/wk/.venv/bin/python3";
}
const PY_BIN = resolvePyBin();
const PY_SCRIPT = join(dirname(__filename), "web-fetch_crawl4ai.py");

// ── Cache (memory in front of disk; disk dedupes across processes) ──────
// Keyed by url+format. Disk writes are atomic (temp file + rename) so
// concurrent writers can't corrupt an entry. Expired entries are evicted on
// read; this keeps the implementation tiny at the cost of slow churn.
const MEM_CACHE_MAX = 100;
const MEM_CACHE_MAX_ENTRY = 512 * 1024; // big raw HTML stays disk-only
const memCache = new Map<string, { t: number; text: string }>();

function cacheKey(url: string, raw: boolean): string {
	return `${CACHE_NAMESPACE}:${url}:${raw ? "raw" : "text"}`;
}
function cachePath(key: string): string {
	return join(CACHE_DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}
function memSet(key: string, text: string): void {
	if (text.length > MEM_CACHE_MAX_ENTRY) return;
	if (memCache.size >= MEM_CACHE_MAX) memCache.delete(memCache.keys().next().value!); // oldest first
	memCache.set(key, { t: Date.now(), text });
}
function getCache(key: string): string | null {
	const m = memCache.get(key);
	if (m) {
		if (Date.now() - m.t <= CACHE_TTL_MS) return m.text;
		memCache.delete(key);
		return null;
	}
	const p = cachePath(key);
	if (!existsSync(p)) return null;
	try {
		if (Date.now() - statSync(p).mtimeMs > CACHE_TTL_MS) {
			try { unlinkSync(p); } catch {}
			return null;
		}
		const text: unknown = JSON.parse(readFileSync(p, "utf-8"));
		if (typeof text !== "string") return null;
		memSet(key, text);
		return text;
	} catch {
		return null;
	}
}
function setCache(key: string, text: string): void {
	memSet(key, text);
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const p = cachePath(key);
		const tmp = `${p}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(text));
		try {
			renameSync(tmp, p);
		} catch (err: any) {
			// Windows: rename can't overwrite. Remove + retry, else drop write.
			if (err?.code === "EEXIST") {
				try { unlinkSync(p); } catch {}
				try { renameSync(tmp, p); } catch {}
			}
		}
	} catch { /* cache failure must not break the fetch */ }
}

// ── Result helpers ───────────────────────────────────────────────────────
type Update = { content: Array<{ type: "text"; text: string }>; details: Record<string, any> };

function errRes(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: text } };
}

// ── DuckDuckGo search helpers ─────────────────────────────────────────────
const DDG_SKIP_DOMAINS = ["duckduckgo.com", "duck.co", "help.duckduckgo.com", "spreadprivacy.com"];

/** Extract real result URLs from Crawl4AI's markdown rendering of DuckDuckGo. */
function extractUrlsFromDDGMarkdown(md: string, limit: number): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	const patterns = [/\[.*?\]\((https?:\/\/[^)]+)\)/g, /(https?:\/\/[^\s)]+)/g];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(md)) !== null) {
			let raw = m[1] || m[0];
			try {
				const probe = new URL(raw, "https://duckduckgo.com");
				const uddg = probe.searchParams.get("uddg"); // unwrap //duckduckgo.com/l/?uddg=REAL_URL
				if (uddg) raw = uddg;
			} catch { /* not a redirect, keep raw */ }
			try {
				const u = new URL(raw);
				const host = u.hostname.toLowerCase();
				if (DDG_SKIP_DOMAINS.some((d) => host === d || host.endsWith("." + d))) continue;
				if (seen.has(u.href)) continue;
				seen.add(u.href);
				urls.push(u.href);
				if (urls.length >= limit) return urls;
			} catch { /* skip malformed */ }
		}
	}
	return urls;
}

// ── Process helpers ──────────────────────────────────────────────────────
/** Kill a spawned crawler and its whole process group (Playwright/Chromium
 *  grandchildren). Returns the SIGKILL fallback timer to cancel on exit. */
function killCrawler(child: ChildProcess, sigkillTimer?: ReturnType<typeof setTimeout> | null) {
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

// ── Persistent runner: ONE Python process / ONE Chromium per session ────
interface JobResult {
	ok: boolean;
	text: string;
	error: string;
}
interface Job {
	key: number;
	url: string;
	raw: boolean;
	light: boolean; // cheap config (no human simulation) — used for the search page
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
				timeout: setTimeout(() => this.onTimeout(flight), CRAWL_TIMEOUT_MS),
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
		const child = spawn(PY_BIN, [PY_SCRIPT], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;

		child.stderr?.on("data", (d: Buffer) => {
			this.stderr += d.toString("utf-8");
			if (Buffer.byteLength(this.stderr, "utf-8") > MAX_OUTPUT_BYTES) this.stderr = keepTailByBytes(this.stderr, MAX_OUTPUT_BYTES);
		});
		child.stdout?.on("data", (d: Buffer) => {
			this.buf += d.toString("utf-8");
			let idx: number;
			while ((idx = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, idx);
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
		if (!line.startsWith("{")) return; // skip crawl4ai's [INIT] banner etc.
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
		this.sigkillTimer = killCrawler(this.child, this.sigkillTimer) ?? null;
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
function runBatch(jobs: Job[], signal?: AbortSignal, onUpdate?: (u: Update) => void): Promise<Map<number, JobResult>> {
	const p = queue.then(() => {
		runner ??= new Runner();
		return runner.exec(jobs, signal, onUpdate);
	});
	queue = p.catch(() => {}); // a failed batch must not jam the queue
	return p;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		runner?.kill();
		runner = null;
	});

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description: "Fetch a web page (Markdown via Crawl4AI). If 'query' is given, run a DuckDuckGo search and fetch the top results; otherwise fetch 'url' directly.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to fetch. Omit if using query.", default: "" })),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown", default: false })),
			query: Type.Optional(Type.String({ description: "Search query — runs DuckDuckGo first, then fetches top results. Optional.", default: "" })),
			maxResults: Type.Optional(Type.Number({ description: "Max top DuckDuckGo results to fetch (1-5, used with query)", default: 5 })),
		}),

		async execute(_toolCallId: unknown, params: { url?: string; raw?: boolean; query?: string; maxResults?: number }, signal?: AbortSignal, onUpdate?: (u: Update) => void) {
			const raw = params.raw ?? false;
			const query = params.query?.trim() ?? "";
			const url = params.url?.trim() ?? "";
			if (!query && !url) return errRes("Error: provide either 'url' or 'query' parameter.");

			const details: Record<string, any> = { urlsFetched: 0, urlsFailed: 0 };
			type Target = { key: number; url: string; raw: boolean; kind: "search" | "source" | "direct" };
			const targets: Target[] = [];
			const results = new Map<number, JobResult>();
			let seq = 0;

			// Register a target; serve from cache immediately if present.
			const reg = (u: string, r: boolean, kind: Target["kind"]): number => {
				const k = seq++;
				targets.push({ key: k, url: u, raw: r, kind });
				const cached = getCache(cacheKey(u, r));
				if (cached !== null) results.set(k, { ok: true, text: cached, error: "" });
				return k;
			};

			// Fetch every registered target not already satisfied by the cache,
			// as ONE batch on the warm runner (single Chromium, parallel tabs).
			const fetchMissing = async () => {
				const need = targets.filter((t) => !results.has(t.key));
				if (need.length === 0) return;
				const jobs: Job[] = need.map((t) => ({ key: t.key, url: t.url, raw: t.raw, light: t.kind === "search" }));
				try {
					const got = await runBatch(jobs, signal, onUpdate);
					for (const t of need) {
						const r = got.get(t.key);
						if (r && (r.ok || r.text)) {
							results.set(t.key, r);
							if (r.ok) setCache(cacheKey(t.url, t.raw), r.text);
						} else {
							results.set(t.key, { ok: false, text: "", error: r?.error ?? "no result from crawler" });
						}
					}
				} catch (e) {
					// Batch-level failure (timeout/abort/crash): record the reason
					// on every pending target so sections can show it, then rethrow.
					const msg = e instanceof Error ? e.message : "batch failed";
					for (const t of need) results.set(t.key, { ok: false, text: "", error: msg });
					throw e;
				}
			};

			// ── Mode 1: DuckDuckGo search → fetch top results ──
			if (query) {
				const maxResults = Math.min(Math.max(params.maxResults ?? 5, 1), 5);
				const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
				details.query = query;
				details.searchUrl = searchUrl;
				onUpdate?.({ content: [{ type: "text", text: `Searching DuckDuckGo for "${query}"...` }], details: { query, phase: "search" } });

				const searchKey = reg(searchUrl, false, "search");
				if (url) reg(url, raw, "direct"); // fetched in the SAME batch as the search page

				let searchErr: string | null = null; // hard failure (fetch/exception)
				let searchEmpty: string | null = null; // page fetched, but no links extracted
				try {
					await fetchMissing();
					const sr = results.get(searchKey)!;
					if (!sr.ok) {
						searchErr = `Error searching "${query}": ${sr.error}`;
					} else {
						const resultUrls = extractUrlsFromDDGMarkdown(sr.text, maxResults);
						if (resultUrls.length === 0) {
							searchEmpty = `DuckDuckGo search for "${query}" returned no extractable results.\n\n${sr.text.slice(0, 2000)}`;
						} else {
							for (const ru of resultUrls) reg(ru, raw, "source");
							await fetchMissing();
						}
					}
				} catch (error) {
					searchErr = `Error searching "${query}": ${error instanceof Error ? error.message : "Unknown error"}`;
				}
				// With no direct URL to fall back on, search failures are fatal.
				if (!url) {
					if (searchErr) return errRes(searchErr);
					if (searchEmpty) {
						return {
							content: [{ type: "text", text: searchEmpty }],
							details: { query, searchUrl, urlsFound: 0 },
						};
					}
				}
			}

			// ── Mode 2: Direct URL fetch (alone, or alongside a query) ──
			if (url) {
				if (!query) {
					// In query mode the direct URL was already registered + fetched above.
					onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: { phase: "fetch", url } });
					reg(url, raw, "direct");
					try {
						await fetchMissing();
					} catch { /* failures are captured in `results`; surfaced below */ }
				}
				details.url = url;
			}

			// Assemble sections (skip the internal search page; legacy order: sources, then direct).
			const sections: string[] = [];
			let sourceIdx = 0;
			const ordered = [...targets.filter((t) => t.kind === "source"), ...targets.filter((t) => t.kind === "direct")];
			for (const t of ordered) {
				const r = results.get(t.key);
				const label = t.kind === "direct" ? `Direct URL: ${t.url}` : `Source ${++sourceIdx}: ${t.url}`;
				if (r && r.ok && r.text) {
					sections.push(`## ${label}\n\n${t.raw ? r.text : r.text.slice(0, MAX_RESULT_CHARS)}`);
					details.urlsFetched++;
				} else {
					sections.push(`## ${label}\n\n_Fetch failed: ${r?.error ?? "unknown"}_`);
					details.urlsFailed++;
				}
			}

			if (sections.length === 0) {
				const lastKey = targets[targets.length - 1].key;
				return errRes(`Error fetching ${url}: ${results.get(lastKey)?.error ?? "unknown"}`);
			}

			const header = query ? `# Search: ${query}` : `# Fetch: ${url}`;
			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details,
			};
		},
	});
}
