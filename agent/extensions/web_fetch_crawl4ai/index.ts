import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

// ── Config ──────────────────────────────────────────────────────────────
const CACHE_NAMESPACE = "crawl4ai";
const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR
	? resolve(process.env.WEB_FETCH_CACHE_DIR)
	: join(homedir(), ".pi", "web-fetch-cache");
const CACHE_TTL_MS = (() => {
	const n = Number(process.env.WEB_FETCH_CACHE_TTL_MS);
	return Number.isFinite(n) && n > 0 ? n : 3_600_000; // 1h
})();
const CRAWL_TIMEOUT_MS = (() => {
	const n = Number(process.env.WEB_FETCH_CRAWL_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : 60_000; // 60s
})();
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // matches old execAsync maxBuffer
// Cap per-page text so multi-result searches don't blow up the context window.
const MAX_RESULT_CHARS = Number(process.env.WEB_FETCH_MAX_CHARS) > 0 ? Number(process.env.WEB_FETCH_MAX_CHARS) : 4000;
// Concurrency for the single Chromium instance (tabs opened in parallel).
const BATCH_CONCURRENCY = (() => {
	const n = Number(process.env.WEB_FETCH_CONCURRENCY);
	return Number.isFinite(n) && n > 0 ? n : 4;
})();

// ── Python runner (single Chromium, multiple tabs via crawl4ai.arun_many) ─
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

// ── Disk cache (dedupes across processes / parallel subagents) ──────────
// Cache is keyed by url+format. Writes are atomic (temp file + rename) so
// concurrent writers can't corrupt an entry. Expired entries are evicted on
// read; this keeps the implementation tiny at the cost of slow churn.
function cacheKey(url: string, raw: boolean): string {
	return `${CACHE_NAMESPACE}:${url}:${raw ? "raw" : "text"}`;
}
function cachePath(key: string): string {
	return join(CACHE_DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}
function getCache(key: string): any | null {
	const p = cachePath(key);
	if (!existsSync(p)) return null;
	try {
		if (Date.now() - statSync(p).mtimeMs > CACHE_TTL_MS) {
			try { unlinkSync(p); } catch {}
			return null;
		}
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}
function setCache(key: string, value: any): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const p = cachePath(key);
		const tmp = `${p}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(value));
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

// ── Crawl4AI runner (single Chromium, multiple tabs) ─────────────────────
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

interface JobResult {
	ok: boolean;
	text: string;
	error: string;
}
interface Job {
	key: number;
	url: string;
	raw: boolean;
}

/**
 * Crawl a batch of URLs with ONE Chromium instance (multiple tabs) by spawning
 * the Python runner once. Streams one JSON line per completed job on stdout.
 * Per-job timeouts are enforced inside Python (CrawlerRunConfig.page_timeout);
 * the TS timeout/abort applies to the whole batch. Returns a key→result map.
 */
function runBatch(
	jobs: Job[],
	signal?: AbortSignal,
	onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: Record<string, any> }) => void,
): Promise<Map<number, JobResult>> {
	const out = new Map<number, JobResult>();
	if (jobs.length === 0) return Promise.resolve(out);

	const req = JSON.stringify({ jobs, concurrency: BATCH_CONCURRENCY, timeout_ms: CRAWL_TIMEOUT_MS });
	return new Promise((resolve, reject) => {
		const child = spawn(PY_BIN, [PY_SCRIPT], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
		child.stdin?.write(req);
		child.stdin?.end();

		let buf = "";
		let finished = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		let stderr = "";

		const cleanup = () => { clearTimeout(timeout); if (signal) signal.removeEventListener("abort", onAbort); };
		const finishErr = (message: string) => {
			if (finished) return;
			finished = true;
			sigkillTimer = killCrawler(child, sigkillTimer);
			cleanup();
			reject(new Error(message));
		};
		const timeout = setTimeout(() => finishErr(`batch crawl timed out after ${CRAWL_TIMEOUT_MS}ms`), CRAWL_TIMEOUT_MS);
		const onAbort = () => finishErr(`batch crawl aborted`);
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf-8");
			if (Buffer.byteLength(stderr, "utf-8") > MAX_OUTPUT_BYTES) stderr = keepTailByBytes(stderr, MAX_OUTPUT_BYTES);
		});
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString("utf-8");
			let idx: number;
			while ((idx = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (!line.startsWith("{")) continue; // skip crawl4ai's [INIT] banner etc.
				try {
					const o = JSON.parse(line);
					out.set(o.key, { ok: !!o.ok, text: o.text ?? "", error: o.error ?? "" });
					onUpdate?.({
						content: [{ type: "text", text: `${o.ok ? "Fetched" : "Failed"}: ${o.url ?? "?"}` }],
						details: { phase: "fetch", url: o.url, ok: !!o.ok, error: o.error ?? "" },
					});
				} catch { /* skip malformed line */ }
			}
		});
		child.on("error", (err) => {
			if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
			if (finished) return;
			finished = true;
			cleanup();
			reject(err);
		});
		child.on("close", (code) => {
			if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
			if (finished) return;
			finished = true;
			cleanup();
			if (buf.trim()) {
				try { const o = JSON.parse(buf); out.set(o.key, { ok: !!o.ok, text: o.text ?? "", error: o.error ?? "" }); } catch {}
			}
			if (code !== 0 && out.size === 0) {
				reject(new Error(`crawler exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`));
				return;
			}
			resolve(out);
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description: "Fetch a web page (Markdown via Crawl4AI). If 'query' is given, run a DuckDuckGo search and fetch the top results; otherwise fetch 'url' directly.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to fetch. Omit if using query.", default: "" })),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown", default: false })),
			query: Type.Optional(Type.String({ description: "Search query — runs DuckDuckGo first, then fetches top results. Optional.", default: "" })),
			maxResults: Type.Optional(Type.Number({ description: "Max top DuckDuckGo results to fetch (1-10, used with query)", default: 10 })),
		}),

		async execute(_toolCallId: unknown, params: { url?: string; raw?: boolean; query?: string; maxResults?: number }, signal?: AbortSignal, onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: Record<string, any> }) => void) {
			const raw = params.raw ?? false;
			const query = params.query?.trim() ?? "";
			const url = params.url?.trim() ?? "";

			// Accumulate result sections across modes (search and/or direct URL).
			const sections: string[] = [];
			const details: Record<string, any> = { urlsFetched: 0, urlsFailed: 0 };

			type Target = { key: number; url: string; raw: boolean; kind: "search" | "source" | "direct" };
			const targets: Target[] = [];
			let seq = 0;
			const results = new Map<number, JobResult>();

			// Register a target; serve from disk cache immediately if present.
			const reg = (u: string, r: boolean, kind: Target["kind"]): number => {
				const k = seq++;
				targets.push({ key: k, url: u, raw: r, kind });
				const cached = getCache(cacheKey(u, r));
				if (typeof cached === "string") results.set(k, { ok: true, text: cached, error: "" });
				return k;
			};
			// Fetch every registered target not already satisfied by the cache,
			// in a single Chromium instance (multiple tabs via arun_many).
			const fetchMissing = async () => {
				const need = targets.filter((t) => !results.has(t.key));
				if (need.length === 0) return;
				const got = await runBatch(need, signal, onUpdate);
				for (const t of need) {
					const r = got.get(t.key);
					if (r && (r.ok || r.text)) {
						results.set(t.key, r);
						if (r.ok) setCache(cacheKey(t.url, t.raw), r.text);
					} else {
						results.set(t.key, { ok: false, text: "", error: r?.error ?? "no result from crawler" });
					}
				}
			};

			// ── Mode 1: DuckDuckGo search → fetch top results ──
			if (query) {
				const maxResults = Math.min(Math.max(params.maxResults ?? 5, 1), 5);
				const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
				try {
					onUpdate?.({ content: [{ type: "text", text: `Searching DuckDuckGo for "${query}"...` }], details: { query, phase: "search" } });
					reg(searchUrl, false, "search");
					await fetchMissing();
					const searchKey = targets.find((t) => t.kind === "search")!.key;
					const sr = results.get(searchKey)!;
					if (!sr.ok) {
						// If a direct URL was also provided, fall through to it instead of erroring.
						if (!url) return errRes(`Error searching "${query}": ${sr.error}`);
					} else {
						const resultUrls = extractUrlsFromDDGMarkdown(sr.text, maxResults);
						if (resultUrls.length === 0) {
							// If a direct URL was also provided, fall through to it instead of erroring.
							if (!url) {
								return {
									content: [{ type: "text", text: `DuckDuckGo search for "${query}" returned no extractable results.\n\n${sr.text.slice(0, 2000)}` }],
									details: { query, searchUrl, urlsFound: 0 },
								};
							}
						} else {
							for (const ru of resultUrls) reg(ru, raw, "source");
							await fetchMissing();
						}
					}
					details.query = query;
					details.searchUrl = searchUrl;
				} catch (error) {
					// If a direct URL was also provided, fall through to it instead of erroring.
					if (!url) return errRes(`Error searching "${query}": ${error instanceof Error ? error.message : "Unknown error"}`);
				}
			}

			// ── Mode 2: Direct URL fetch (used alone, or alongside a query) ──
			if (url) {
				onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: { phase: "fetch", url } });
				reg(url, raw, "direct");
				try {
					await fetchMissing();
				} catch (error) {
					// Individual failures are captured in `results`; surface below.
				}
			}

			if (targets.length === 0) return errRes("Error: provide either 'url' or 'query' parameter.");

			// Assemble sections in registration order (skip the internal search page).
			let sourceIdx = 0;
			for (const t of targets) {
				if (t.kind === "search") continue;
				const r = results.get(t.key);
				const label = t.kind === "direct" ? `Direct URL: ${t.url}` : `Source ${++sourceIdx}: ${t.url}`;
				if (r && r.ok && r.text) {
					const block = t.raw ? r.text : r.text.slice(0, MAX_RESULT_CHARS);
					sections.push(`## ${label}\n\n${block}`);
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
			if (url) details.url = url;
			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details,
			};
		},
	});
}
