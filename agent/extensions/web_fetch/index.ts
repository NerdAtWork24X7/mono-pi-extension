import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { MAX_RAW_CHARS, MAX_RESULT_CHARS, SEARCH_TEXT_CHARS, runBatch, shutdownRunner, type Job, type JobResult, type Update } from "./runner";
import { extractUrlsFromDDGMarkdown } from "./ddg";

// ── Result helpers ───────────────────────────────────────────────────────
function errRes(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: text } };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		shutdownRunner();
	});

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description: "Fetch a web page (Markdown via headless Chromium/Playwright). If 'query' is given, run a DuckDuckGo search and fetch the top results; otherwise fetch 'url' directly.",
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
			if (url) {
				let scheme = "";
				try { scheme = new URL(url).protocol; } catch { /* invalid URL */ }
				if (scheme !== "http:" && scheme !== "https:") {
					return errRes(`Error: 'url' must be a valid http(s) URL, got "${url}".`);
				}
			}

			const details: Record<string, any> = { urlsFetched: 0, urlsFailed: 0 };
			type Target = { key: number; url: string; raw: boolean; kind: "search" | "source" | "direct"; max: number };
			const targets: Target[] = [];
			const results = new Map<number, JobResult>();
			let seq = 0;

			// Register a target for fetching. `max` is the per-job text cap the
			// Python crawler enforces before writing to the pipe.
			const reg = (u: string, r: boolean, kind: Target["kind"]): number => {
				const k = seq++;
				targets.push({
					key: k, url: u, raw: r, kind,
					max: kind === "search" ? SEARCH_TEXT_CHARS : (r ? MAX_RAW_CHARS : MAX_RESULT_CHARS),
				});
				return k;
			};

			// Fetch every registered target as ONE batch on the warm runner
			// (single Chromium, parallel tabs).
			const fetchMissing = async () => {
				const need = targets.filter((t) => !results.has(t.key));
				if (need.length === 0) return;
				const jobs: Job[] = need.map((t) => ({ key: t.key, url: t.url, raw: t.raw, light: t.kind === "search", max: t.max }));
				try {
					const got = await runBatch(jobs, signal, onUpdate);
					for (const t of need) {
						const r = got.get(t.key);
						if (r && (r.ok || r.text)) {
							results.set(t.key, r);
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

			// Assemble sections (skip the internal search page; sources first, then direct).
			// Text caps were already enforced per-job by the Python crawler.
			const sections: string[] = [];
			let sourceIdx = 0;
			const ordered = [...targets.filter((t) => t.kind === "source"), ...targets.filter((t) => t.kind === "direct")];
			for (const t of ordered) {
				const r = results.get(t.key);
				const label = t.kind === "direct" ? `Direct URL: ${t.url}` : `Source ${++sourceIdx}: ${t.url}`;
				if (r && r.ok && r.text) {
					sections.push(`## ${label}\n\n${r.text}`);
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
