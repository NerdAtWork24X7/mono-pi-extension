import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { MAX_RAW_CHARS, MAX_RESULT_CHARS, SEARCH_TEXT_CHARS, runBatch, shutdownRunner, type Job, type JobResult, type Update } from "./runner";
import { extractUrlsFromDDGMarkdown } from "./ddg";

// ── Result helpers ───────────────────────────────────────────────────────
function errRes(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: text } };
}

const SEARCH_URL = (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

/** Normalize a URL and require http(s); returns null when invalid. */
function validHttpUrl(u: string): string | null {
	try {
		const p = new URL(u);
		return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		shutdownRunner();
	});

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetch web pages as Markdown via a persistent headless browser (one shared session across calls), or search DuckDuckGo via 'query'. " +
			"Pass 'urls' (array) and/or 'queries' (array) to batch many fetches/searches in ONE tool call — everything is crawled in parallel in the same browser session. Singular 'url'/'query' still work.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "A single URL to fetch (omit if using query/queries)", default: "" })),
			urls: Type.Optional(Type.Array(Type.String({ description: "Multiple URLs to fetch in one batch (parallel, shared session)", default: [] }))),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown (default false)", default: false })),
			query: Type.Optional(Type.String({ description: "A single search query to find and fetch top DuckDuckGo results (omit if using url/urls)", default: "" })),
			queries: Type.Optional(Type.Array(Type.String({ description: "Multiple search queries, each returning its top results, all in one batch", default: [] }))),
			maxResults: Type.Optional(Type.Number({ description: "Max search results to fetch per query (1-5, default 5)", default: 5 })),
		}),

		async execute(_toolCallId: unknown, params: { url?: string; urls?: string[]; raw?: boolean; query?: string; queries?: string[]; maxResults?: number }, signal?: AbortSignal, onUpdate?: (u: Update) => void) {
			const raw = params.raw ?? false;
			const maxResults = Math.min(Math.max(params.maxResults ?? 5, 1), 5);

			// Collect + dedupe queries and direct URLs (plural + singular forms).
			const queries = [...(params.query ? [params.query] : []), ...(params.queries ?? [])]
				.map((q) => q.trim()).filter((q) => q.length > 0);
			const urlInputs = [...(params.url ? [params.url] : []), ...(params.urls ?? [])]
				.map((u) => u.trim()).filter((u) => u.length > 0);
			const seenQ = new Set<string>();
			const qList = queries.filter((q) => { const k = q.toLowerCase(); if (seenQ.has(k)) return false; seenQ.add(k); return true; });
			const seenU = new Set<string>();
			const urls: string[] = [];
			const badUrls: string[] = [];
			for (const u of urlInputs) {
				const norm = validHttpUrl(u);
				if (!norm) { badUrls.push(u); continue; }
				if (seenU.has(norm)) continue;
				seenU.add(norm);
				urls.push(norm);
			}

			if (qList.length === 0 && urls.length === 0) {
				return errRes("Error: provide 'url', 'urls', 'query', or 'queries'.");
			}
			if (badUrls.length > 0) {
				return errRes(`Error: invalid URL(s): ${badUrls.join(", ")} (must be valid http(s) URLs).`);
			}

			const details: Record<string, any> = { urlsFetched: 0, urlsFailed: 0 };
			if (qList.length) details.queries = qList;
			if (urls.length) details.urls = urls;

			type Target = { key: number; url: string; raw: boolean; kind: "search" | "source" | "direct"; max: number };
			const targets: Target[] = [];
			const results = new Map<number, JobResult>();
			const keyUrl = new Map<number, string>();
			const byUrl = new Map<string, number>();
			let seq = 0;

			// Register a target for fetching (deduped by URL — two queries that
			// return the same source, or a direct URL that is also a search hit,
			// are crawled ONCE). `max` is the per-job text cap the Python crawler
			// enforces before writing to the pipe.
			const reg = (u: string, r: boolean, kind: Target["kind"]): number => {
				const existing = byUrl.get(u);
				if (existing !== undefined) return existing;
				const k = seq++;
				byUrl.set(u, k);
				keyUrl.set(k, u);
				targets.push({
					key: k, url: u, raw: r, kind,
					max: kind === "search" ? SEARCH_TEXT_CHARS : (r ? MAX_RAW_CHARS : MAX_RESULT_CHARS),
				});
				return k;
			};

			// Crawl every registered target as ONE batch on the warm runner
			// (single Chromium, parallel tabs, shared session).
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

			// ── Register all work up front: every search page + every direct URL ──
			const searchKeys = qList.map((q) => reg(SEARCH_URL(q), false, "search"));
			urls.forEach((u) => reg(u, raw, "direct"));

			if (qList.length) {
				onUpdate?.({ content: [{ type: "text", text: `Searching DuckDuckGo for: ${qList.join(" | ")}` }], details: { queries: qList, phase: "search" } });
			}
			if (urls.length) {
				onUpdate?.({ content: [{ type: "text", text: `Fetching ${urls.length} URL(s): ${urls.join(", ")}` }], details: { phase: "fetch", urls } });
			}

			try {
				await fetchMissing();
			} catch (e) {
				// A dead crawler can't serve anything: report the batch error.
				if (qList.length === 0 && urls.length > 0) {
					return errRes(`Error fetching ${urls.join(", ")}: ${e instanceof Error ? e.message : "batch failed"}`);
				}
			}

			// ── Parse each search page; register its top results as sources ──
			// Per-query outcome: { keys: source keys, hard: hard failure, empty: no results }
			type QueryOutcome = { q: string; keys: number[]; hard: string | null; empty: string | null };
			const outcomes: QueryOutcome[] = [];
			let anySources = false;
			for (let i = 0; i < qList.length; i++) {
				const sr = results.get(searchKeys[i]);
				if (!sr || !sr.ok) {
					outcomes.push({ q: qList[i], keys: [], hard: `Error searching "${qList[i]}": ${sr?.error ?? "unknown"}`, empty: null });
					continue;
				}
				const resultUrls = extractUrlsFromDDGMarkdown(sr.text, maxResults);
				if (resultUrls.length === 0) {
					outcomes.push({
						q: qList[i], keys: [], hard: null,
						empty: `DuckDuckGo search for "${qList[i]}" returned no extractable results.\n\n${sr.text.slice(0, 2000)}`,
					});
					continue;
				}
				const keys = resultUrls.map((ru) => reg(ru, raw, "source"));
				if (keys.length) anySources = true;
				outcomes.push({ q: qList[i], keys, hard: null, empty: null });
			}

			// Second batch: all extracted result pages (sources only).
			try {
				if (anySources) await fetchMissing();
			} catch { /* per-key failures are captured in `results`; surfaced below */ }

			// ── Assemble output ──
			const sections: string[] = [];
			const counted = new Set<number>();
			const count = (k: number, ok: boolean) => {
				if (counted.has(k)) return;
				counted.add(k);
				if (ok) details.urlsFetched++; else details.urlsFailed++;
			};

			for (const o of outcomes) {
				sections.push(`# Search: ${o.q}`);
				if (o.hard) {
					sections.push(`\n_Search failed: ${o.hard}_`);
				} else if (o.empty) {
					sections.push(`\n_${o.empty}_`);
				} else if (o.keys.length === 0) {
					sections.push("\n_No results._");
				} else {
					let n = 0;
					for (const k of o.keys) {
						const r = results.get(k);
						const url = keyUrl.get(k) ?? "?";
						if (r && r.ok && r.text) {
							sections.push(`## Source ${++n}: ${url}\n\n${r.text}`);
							count(k, true);
						} else {
							sections.push(`## Source ${++n}: ${url}\n\n_Fetch failed: ${r?.error ?? "unknown"}_`);
							count(k, false);
						}
					}
				}
			}

			// With no direct URL to fall back on, search failures are fatal.
			if (urls.length === 0 && outcomes.length > 0) {
				const hard = outcomes.find((o) => o.hard);
				const empty = outcomes.find((o) => o.empty);
				if (hard && outcomes.every((o) => o.hard || o.empty)) return errRes(hard.hard!);
				if (empty && outcomes.every((o) => o.hard || o.empty)) {
					return { content: [{ type: "text", text: empty.empty! }], details: { ...details, urlsFound: 0 } };
				}
			}

			for (const u of urls) {
				const k = byUrl.get(u)!;
				const r = results.get(k);
				sections.push(`# Fetch: ${u}`);
				if (r && r.ok && r.text) {
					sections.push(`\n${r.text}`);
					count(k, true);
				} else {
					sections.push(`\n_Fetch failed: ${r?.error ?? "unknown"}_`);
					count(k, false);
				}
			}

			if (sections.length === 0) {
				return errRes(`Error: nothing to fetch (${badUrls.length ? `invalid URLs: ${badUrls.join(", ")}` : "no usable inputs"}).`);
			}

			const header = qList.length ? `# Search${qList.length > 1 ? "es" : ""}: ${qList.join(" | ")}` : `# Fetch: ${urls.join(", ")}`;
			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details,
			};
		},
	});
}