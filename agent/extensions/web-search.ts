/**
 * Web Search Tool - Search the web via DuckDuckGo
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-search",
		label: "Web Search",
		description: "Search the web via DuckDuckGo and return results with titles, URLs, and snippets",
		parameters: Type.Object({
			query: Type.String({ description: "Search query terms" }),
			n: Type.Number({ description: "Number of results to return", default: 5, minimum: 1, maximum: 10 }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query, n } = params as { query: string; n: number };

			try {
				const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0",
					},
				});

				if (!res.ok) {
					throw new Error(`HTTP ${res.status}: ${res.statusText}`);
				}

				const html = await res.text();

				const results = [];
				const blockRe = /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
				let m;
				while ((m = blockRe.exec(html)) && results.length < n) {
					const url = decodeURIComponent(m[1]
						.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '')
						.replace(/&amp;rut=.*$/, '')
						.replace(/&rut=.*$/, ''));
					const title = m[2].replace(/<[^>]*>/g, '').trim();
					const snippet = m[3].replace(/<[^>]*>/g, '').trim();
					results.push({ title, url, snippet });
				}

				if (!results.length) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: { query, results: [] },
					};
				}

				const content = results.map((r, i) => `
				${i + 1}. ${r.title}
				   ${r.url}
				   ${r.snippet}
				`).join('\n');

				return {
					content: [{ type: "text", text: content }],
					details: { query, results },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error searching for "${query}": ${error instanceof Error ? error.message : 'Unknown error'}` }],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	});
}