/**
 * Web Fetch Tool - Fetch web pages and extract content
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Shared on-disk cache ─────────────────────────────────────────────
// Subagents run in separate processes, so an in-memory cache cannot stop
// two parallel searchers from fetching the same URL. We cache results on
// disk (default ~/.pi/web-fetch-cache) with a TTL so fetches are deduplicated
// across processes. Writes are atomic (temp file + rename) to avoid corrupt
// cache entries when multiple processes write concurrently.

const CACHE_NAMESPACE = "default";
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description: "Fetch a web page and extract readable text content",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			raw: Type.Boolean({ description: "Return raw HTML instead of extracted text", default: false }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { url, raw } = params as { url: string; raw: boolean };

			try {
				const cached = getCache(url, raw);
				if (cached) return cached;

				const res = await fetch(url, {
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0",
						"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					},
				});

				if (!res.ok) {
					throw new Error(`HTTP ${res.status}: ${res.statusText}`);
				}

				const html = await res.text();

				let result;
				if (raw) {
					result = {
						content: [{ type: "text", text: html }],
						details: { url, raw: true },
					};
				} else {
					const text = html
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<[^>]+>/g, " ")
						.replace(/&nbsp;/g, " ")
						.replace(/&amp;/g, "&")
						.replace(/&lt;/g, "<")
						.replace(/&gt;/g, ">")
						.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
						.replace(/[ \t]+/g, " ")
						.replace(/\n\s*\n/g, "\n")
						.trim();

					result = {
						content: [{ type: "text", text: text }],
						details: { url, raw: false },
					};
				}

				setCache(url, raw, result);
				return result;
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error fetching ${url}: ${error instanceof Error ? error.message : 'Unknown error'}` }],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	});
}
