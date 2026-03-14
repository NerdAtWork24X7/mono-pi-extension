/**
 * Web Fetch Tool - Fetch web pages and extract content
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

				if (raw) {
					return {
						content: [{ type: "text", text: html }],
						details: { url, raw: true },
					};
				}

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

				return {
					content: [{ type: "text", text: text }],
					details: { url, raw: false },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error fetching ${url}: ${error instanceof Error ? error.message : 'Unknown error'}` }],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	});
}