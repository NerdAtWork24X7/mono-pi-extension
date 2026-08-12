import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Shared on-disk cache + cross-process lock ───────────────────────
// Subagents run in separate processes, so an in-memory cache cannot stop
// two parallel searchers from fetching the same URL. We cache results on
// disk (default ~/.pi/web-fetch-cache) with a TTL so fetches are deduplicated
// across processes. Writes are atomic (temp file + rename) to avoid corrupt
// cache entries when multiple processes write concurrently. On top of the
// cache, withFetchLock() holds a per-URL lock directory so concurrent fetches
// of the same URL serialize (the second waiter reads the cache once the first
// writes it) instead of both spawning crwl.

const CACHE_NAMESPACE = "crawl4ai";
const CACHE_DIR = process.env.WEB_FETCH_CACHE_DIR
	? resolve(process.env.WEB_FETCH_CACHE_DIR)
	: join(homedir(), ".pi", "web-fetch-cache");
const CACHE_TTL_MS = (() => {
	const env = process.env.WEB_FETCH_CACHE_TTL_MS;
	if (!env) return 60 * 60 * 1000; // 1 hour
	const n = Number(env);
	return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
})();
const MAX_CACHE_ENTRIES = 2000;
// Throttles pruneCache() to every N cache writes (see setCache).
let pruneCounter = 0;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB buffer (matches old execAsync maxBuffer)
const CRAWL_TIMEOUT_MS = (() => {
	const env = process.env.WEB_FETCH_CRAWL_TIMEOUT_MS;
	if (!env) return 60_000; // 60 seconds
	const n = Number(env);
	return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

interface CacheEntry {
	url: string;
	raw: boolean;
	fetchedAt: number;
	result: any;
}

function cachePath(url: string, raw: boolean): string {
	const hash = createHash("sha256")
		.update(`${CACHE_NAMESPACE}:${url}:${raw ? "raw" : "text"}`)
		.digest("hex");
	return join(CACHE_DIR, `${hash}.json`);
}

function getCache(url: string, raw: boolean): any | null {
	const p = cachePath(url, raw);
	if (!existsSync(p)) return null;
	try {
		const stats = statSync(p);
		if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) {
			try { unlinkSync(p); } catch {}
			return null;
		}
		const entry: CacheEntry = JSON.parse(readFileSync(p, "utf-8"));
		if (!entry || entry.url !== url || entry.raw !== raw || !entry.fetchedAt) {
			return null;
		}
		return entry.result;
	} catch {
		return null;
	}
}

function setCache(url: string, raw: boolean, result: any): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const p = cachePath(url, raw);
		const tmp = `${p}.${process.pid}.tmp`;
		const entry: CacheEntry = {
			url,
			raw,
			fetchedAt: Date.now(),
			result,
		};
		writeFileSync(tmp, JSON.stringify(entry));
		try {
			renameSync(tmp, p);
		} catch (err: any) {
			// On Windows renameSync cannot overwrite; remove the existing entry
			// and retry. If this still fails, drop the cache write rather than
			// failing the fetch.
			if (err?.code === "EEXIST") {
				try { unlinkSync(p); } catch {}
				try { renameSync(tmp, p); } catch {}
			}
		}
	} catch {
		// ignore cache write failures; the fetch itself already succeeded
	}
	// Throttle pruning: once the cache is full, a full dir scan per write is
	// expensive, so only scan every N writes.
	if (++pruneCounter % 20 === 0) pruneCache();
}

function pruneCache(): void {
	try {
		const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
		if (files.length <= MAX_CACHE_ENTRIES) return;
		const withMtime = files.map((name) => ({
			name,
			mtime: statSync(join(CACHE_DIR, name)).mtimeMs,
		}));
		withMtime.sort((a, b) => a.mtime - b.mtime);
		const removeCount = Math.ceil(files.length * 0.1);
		for (const { name } of withMtime.slice(0, removeCount)) {
			try { unlinkSync(join(CACHE_DIR, name)); } catch {}
		}
	} catch {
		// ignore pruning failures
	}
}

// ── Shared helpers ──────────────────────────────────────────────────────

/** Max concurrent result fetches in query mode (each spawns a headless Chromium). */
const FETCH_CONCURRENCY = 4;

/** Build the tool result object for a successful fetch. */
function buildResult(url: string, raw: boolean, stdout: string) {
	return {
		content: [{ type: "text" as const, text: stdout }],
		details: { url, format: raw ? "html" : "markdown-fit" },
	};
}

/** Build the tool result object for an error. */
function errRes(text: string) {
	return { content: [{ type: "text", text }], details: { error: text } };
}

/** Promise.allSettled with bounded concurrency (processes batches of `limit`). */
async function allSettledBatched<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<any>,
): Promise<PromiseSettledResult<any>[]> {
	const out: PromiseSettledResult<any>[] = [];
	for (let start = 0; start < items.length; start += limit) {
		const settled = await Promise.allSettled(items.slice(start, start + limit).map(fn));
		out.push(...settled);
	}
	return out;
}

// ── Cross-process in-flight lock ─────────────────────────────────────────
// The disk cache above dedupes *sequential* fetches but cannot stop two
// processes (parallel subagents) that both miss the cache from fetching the
// same URL at the same time. We add a per-URL lock directory under the cache
// dir: mkdir is atomic and fails with EEXIST while held, so the second
// fetcher waits (polling, with stale-lock cleanup) until the first writes the
// cache. After acquiring the lock we re-check the cache so a waiter that was
// blocked behind a completed fetch returns the cached entry instead.

const LOCK_DIR = join(CACHE_DIR, ".locks");

function lockPathFor(url: string, raw: boolean): string {
	const hash = createHash("sha256")
		.update(`${CACHE_NAMESPACE}:${url}:${raw ? "raw" : "text"}`)
		.digest("hex");
	return join(LOCK_DIR, `${hash}.lock`);
}

async function withFetchLock<T>(
	url: string,
	raw: boolean,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	mkdirSync(LOCK_DIR, { recursive: true });
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	const POLL_MS = 300;
	const maxAttempts = Math.ceil((CRAWL_TIMEOUT_MS + 10000) / POLL_MS);

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (signal?.aborted) throw new Error(`Crawl4AI aborted for ${url}`);
		const cached = getCache(url, raw);
		if (cached) return cached;
		try {
			mkdirSync(lockPathFor(url, raw)); // atomic; EEXIST if held by another process
		} catch (err: any) {
			if (err?.code === "EEXIST") {
				// Break stale locks (e.g. a crashed holder) older than a full crawl.
				try {
					const st = statSync(lockPathFor(url, raw));
					if (Date.now() - st.mtimeMs > CRAWL_TIMEOUT_MS + 5000) {
						rmdirSync(lockPathFor(url, raw));
					}
				} catch {}
				await sleep(POLL_MS);
				continue;
			}
			throw err;
		}
		// Lock acquired — re-check cache (another waiter may have just filled it).
		try {
			const cached2 = getCache(url, raw);
			if (cached2) return cached2;
			return await fn();
		} finally {
			try { rmdirSync(lockPathFor(url, raw)); } catch {}
		}
	}
	// Fallback: avoid hanging on a pathological lock; fetch directly.
	const cached = getCache(url, raw);
	if (cached) return cached;
	return await fn();
}

// ── DuckDuckGo search helpers ────────────────────────────────────────────────

/** Domains to skip when extracting URLs from DuckDuckGo search results. */
const DDG_SKIP_DOMAINS = [
	"duckduckgo.com", "duck.co",
	"help.duckduckgo.com", "spreadprivacy.com",
];

/** Extract real result URLs from Crawl4AI's markdown rendering of DuckDuckGo. */
function extractUrlsFromDDGMarkdown(md: string, limit: number): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	// Match markdown links: [text](url) and raw URLs
	const patterns = [/\[.*?\]\((https?:\/\/[^)]+)\)/g, /(https?:\/\/[^\s)]+)/g];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(md)) !== null) {
			let raw = m[1] || m[0];
			// Unwrap DuckDuckGo redirect: //duckduckgo.com/l/?uddg=REAL_URL&...
			try {
				const probe = new URL(raw, "https://duckduckgo.com");
				const uddg = probe.searchParams.get("uddg");
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

// ── Crawl4AI runner with hard timeout and abort handling ────────────────
/** Kill a spawned crawler and its whole process group to clean up any
 *  Playwright/Chromium children that crwl may have started. Returns the
 *  SIGKILL fallback timer so the caller can cancel it once the child dies. */
function killCrawler(child: ChildProcess, sigkillTimer?: ReturnType<typeof setTimeout> | null) {
	if (sigkillTimer) {
		clearTimeout(sigkillTimer);
	}
	const pid = child.pid;
	if (!pid) return;
	try {
		// Negative PID kills the process group (the shell-less session we
		// created with detached:true). This is the only reliable way to
		// collect Chromium/Playwright grandchildren.
		process.kill(-pid, "SIGTERM");
		// Best-effort SIGKILL after a short grace period.
		return setTimeout(() => {
			try { process.kill(-pid, "SIGKILL"); } catch {}
		}, 2000);
	} catch {
		// Fallback for the rare case the process group already exited.
		try { child.kill("SIGTERM"); } catch {}
		return undefined;
	}
}

/** Keep the tail of a UTF-8 string within a byte budget without splitting a
 *  multi-byte character. Used to cap a noisy stderr while preserving the
 *  most recent bytes. */
function keepTailByBytes(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf-8");
	if (buf.length <= maxBytes) return s;
	let start = buf.length - maxBytes;
	while (start > 0 && (buf[start] & 0xc0) === 0x80) {
		start--;
	}
	return buf.subarray(start).toString("utf-8");
}

// ── Crawl4AI config (constant across calls; hoisted to avoid re-joining per fetch) ──
const CRAWL_JS_CODE = `const s='[role="dialog"]|[aria-modal="true"]|.cookie-consent|.consent-popup|#cookieChoiceInfo|.govuk-cookie-banner';s.split('|').forEach(x=>{document.querySelectorAll(x).forEach(y=>y.remove())})`.replace(/"/g, '\\"');

const CRAWL_BROWSER_CONFIG = [
	"browser_type=chromium",
	"headless=true",
	"enable_stealth=true",
	"viewport_width=1366",
	"viewport_height=768",
	"ignore_https_errors=true",
].join(",");

const CRAWL_CRAWLER_CONFIG = [
	"magic=true",
	"remove_overlay_elements=true",
	"remove_consent_popups=true",
	"scan_full_page=true",
	"scroll_delay=0.5",
	"delay_before_return_html=2",
	"override_navigator=true",
	"simulate_user=true",
	`js_code=${CRAWL_JS_CODE}`,
].join(",");

function runCrawl(url: string, raw: boolean, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
	// NOTE: Crawl4AI splits config into BrowserConfig (-b) and
	// CrawlerRunConfig (-c). BrowserConfig silently drops unknown keys, so
	// passing enable_stealth/headless/browser_type via -c (as before) meant
	// NONE of the stealth was ever applied and the crawler ran with the
	// default headless chromium + stale UA (Chrome/116) -> easy bot detection.
	// Browser-level stealth/identity params must go in -b.

	const format = raw ? "html" : "markdown-fit";
	const args = [url, "-b", CRAWL_BROWSER_CONFIG, "-c", CRAWL_CRAWLER_CONFIG, "-o", format];

	return new Promise((resolve, reject) => {
		const child = spawn("crwl", args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Collect stdout as a chunk list and concat once at the end — repeated
		// Buffer.concat on a growing buffer is O(n^2) and hammers the GC for
		// large (up to 10 MB) pages.
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let finished = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		let timeout: ReturnType<typeof setTimeout>;

		const cleanup = () => {
			clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		};

		const finishWithError = (message: string) => {
			if (finished) return;
			finished = true;
			sigkillTimer = killCrawler(child, sigkillTimer);
			cleanup();
			reject(new Error(message));
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				finishWithError(`Crawl4AI output exceeded ${MAX_OUTPUT_BYTES} bytes for ${url}`);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
			// Keep only the trailing bytes of a very noisy stderr so warnings
			// don't silently fill memory; do not kill the crawl for stderr.
			if (Buffer.byteLength(stderr, "utf-8") > MAX_OUTPUT_BYTES) {
				stderr = keepTailByBytes(stderr, MAX_OUTPUT_BYTES);
			}
		});

		timeout = setTimeout(() => {
			finishWithError(`Crawl4AI timed out after ${CRAWL_TIMEOUT_MS}ms for ${url}`);
		}, CRAWL_TIMEOUT_MS);

		const onAbort = () => {
			finishWithError(`Crawl4AI aborted for ${url}`);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

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
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const detail = stderr ? `: ${stderr.trim().slice(0, 200)}` : "";
				reject(new Error(`Crawl4AI exited with code ${code}${detail}`));
			}
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description: "Fetch a web page and extract readable content (Markdown via Crawl4AI). Optionally perform a DuckDuckGo search first to discover and fetch top results.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to fetch. Omit if using query parameter.",
				default: "",
			}),
			raw: Type.Boolean({
				description: "Return raw HTML instead of markdown",
				default: false,
			}),
			query: Type.String({
				description: "Search query — performs DuckDuckGo search first, then fetches top results. When provided, url is optional.",
				default: "",
			}),
			maxResults: Type.Number({
				description: "Max number of top DuckDuckGo results to fetch (used with query)",
				default: 3,
			}),
		}),

		async execute(_toolCallId: unknown, params: { url?: string; raw?: boolean; query?: string; maxResults?: number }, signal?: AbortSignal) {
			const { url: urlParam, raw: rawParam, query: queryParam, maxResults: maxResultsParam } = params;
			const raw = rawParam ?? false;
			const query = queryParam?.trim() ?? "";
			const url = urlParam?.trim() ?? "";

			// ── Mode 1: DuckDuckGo search → fetch top results ──
			if (query) {
				const maxResults = Math.min(Math.max(maxResultsParam ?? 3, 1), 10);
				const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

				try {
					// Step 1: Crawl DuckDuckGo search results page (cached per query)
					const { stdout: searchMd } = await withFetchLock(searchUrl, false, signal, async () => {
						const { stdout } = await runCrawl(searchUrl, false, signal);
						setCache(searchUrl, false, { stdout });
						return { stdout };
					});

					// Step 2: Extract result URLs from the markdown
					const resultUrls = extractUrlsFromDDGMarkdown(searchMd, maxResults);

					if (resultUrls.length === 0) {
						return {
							content: [{ type: "text", text: `DuckDuckGo search for "${query}" returned no extractable results. Raw page:\n\n${searchMd.slice(0, 2000)}` }],
							details: { query, searchUrl, urlsFound: 0 },
						};
					}

					// Step 3: Fetch each result URL (bounded concurrency)
					const fetched = await allSettledBatched(resultUrls, FETCH_CONCURRENCY, (resultUrl) =>
						withFetchLock(resultUrl, raw, signal, async () => {
							const { stdout } = await runCrawl(resultUrl, raw, signal);
							const entry = buildResult(resultUrl, raw, stdout);
							setCache(resultUrl, raw, entry);
							return { url: resultUrl, ...entry };
						}),
					);

					// Step 4: Aggregate results
					const sections: string[] = [];
					const details: Record<string, any> = { query, searchUrl, urlsFetched: 0, urlsFailed: 0 };

					for (let i = 0; i < fetched.length; i++) {
						const r = fetched[i];
						const resultUrl = resultUrls[i];
						if (r.status === "fulfilled") {
							sections.push(`## Source ${i + 1}: ${resultUrl}\n\n${r.value.content[0].text}`);
							details.urlsFetched++;
						} else {
							sections.push(`## Source ${i + 1}: ${resultUrl}\n\n_Fetch failed: ${r.reason?.message ?? "unknown"}_`);
							details.urlsFailed++;
						}
					}

					return {
						content: [{ type: "text", text: `# Search: ${query}\n\n${sections.join("\n\n---\n\n")}` }],
						details,
					};
				} catch (error) {
					return errRes(`Error searching "${query}": ${error instanceof Error ? error.message : "Unknown error"}`);
				}
			}

			// ── Mode 2: Direct URL fetch (original behavior) ──
			if (!url) {
				return {
					content: [{ type: "text", text: "Error: provide either 'url' or 'query' parameter." }],
					details: { error: "Missing required parameter" },
				};
			}

			try {
				return await withFetchLock(url, raw, signal, async () => {
					const { stdout, stderr } = await runCrawl(url, raw, signal);

					if (stderr) {
						console.warn("Crawl4AI stderr:", stderr);
					}

					const result = buildResult(url, raw, stdout);
					setCache(url, raw, result);
					return result;
				});
			} catch (error) {
				return errRes(`Error fetching ${url}: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		},
	});
}
