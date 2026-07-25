import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Shared on-disk cache ─────────────────────────────────────────────
// Subagents run in separate processes, so an in-memory cache cannot stop
// two parallel searchers from fetching the same URL. We cache results on
// disk (default ~/.pi/web-fetch-cache) with a TTL so fetches are deduplicated
// across processes. Writes are atomic (temp file + rename) to avoid corrupt
// cache entries when multiple processes write concurrently.

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
	pruneCache();
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

function runCrawl(url: string, raw: boolean, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
	// Minify JS and avoid commas to not break the -c flag parser
	const jsCode = `const s='[role="dialog"]|[aria-modal="true"]|.cookie-consent|.consent-popup|#cookieChoiceInfo|.govuk-cookie-banner';s.split('|').forEach(x=>{document.querySelectorAll(x).forEach(y=>y.remove())})`.replace(/"/g, '\\"');

	const crawlerConfig = [
		"remove_overlay_elements=true",
		"magic=true",
		"remove_consent_popups=true",
		"scan_full_page=true",
		"scroll_delay=0.5",
		"delay_before_return_html=2",
		`js_code=${jsCode}`,
	].join(",");

	const format = raw ? "html" : "markdown-fit";
	const args = [url, "-c", crawlerConfig, "-o", format];

	return new Promise((resolve, reject) => {
		const child = spawn("crwl", args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuf = Buffer.alloc(0);
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
			stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
			if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
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
			const stdout = stdoutBuf.toString("utf-8");
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
		description: "Fetch a web page and extract readable content (Markdown via Crawl4AI)",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			raw: Type.Boolean({
				description: "Return raw HTML instead of markdown",
				default: false,
			}),
		}),

		async execute(_toolCallId: unknown, params: { url: string; raw?: boolean }, signal?: AbortSignal) {
			const { url, raw: rawParam } = params;
			const raw = rawParam ?? false;

			try {
				const cached = getCache(url, raw);
				if (cached) return cached;

				const { stdout, stderr } = await runCrawl(url, raw, signal);

				if (stderr) {
					console.warn("Crawl4AI stderr:", stderr);
				}

				const result = {
					content: [{ type: "text", text: stdout }],
					details: { url, format: raw ? "html" : "markdown-fit" },
				};
				setCache(url, raw, result);
				return result;
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error fetching ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
						},
					],
					details: {
						error: error instanceof Error ? error.message : "Unknown error",
					},
				};
			}
		},
	});
}
