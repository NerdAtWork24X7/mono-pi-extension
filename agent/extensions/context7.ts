/**
 * Context7 Tool - Search and query documentation
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

async function callContext7(method: string, args: Record<string, any>) {
	const res = await fetch("https://mcp.context7.com/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream"
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: method,
				arguments: args
			}
		})
	});

	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${res.statusText}`);
	}

	const text = await res.text();
	let data: any;

	try {
		data = JSON.parse(text);
	} catch (e) {
		// If not valid JSON, try parsing as SSE
		const lines = text.split("\n");
		let dataBuffer = "";
		for (const line of lines) {
			if (line.startsWith("data: ")) {
				dataBuffer += line.substring(6);
			} else if (line.trim() === "") {
				if (dataBuffer) {
					try {
						const parsed = JSON.parse(dataBuffer);
						if (parsed.id === 1 || (parsed.result && !parsed.id)) {
							data = parsed;
							break;
						}
					} catch (err) {
						// ignore
					}
					dataBuffer = "";
				}
			}
		}
		// Final attempt if no empty line at the end
		if (!data && dataBuffer) {
			try {
				const parsed = JSON.parse(dataBuffer);
				if (parsed.id === 1 || (parsed.result && !parsed.id)) {
					data = parsed;
				}
			} catch (err) {
				// ignore
			}
		}
	}

	if (!data) {
		throw new Error(`Failed to parse response from Context7 API. Raw response: ${text.substring(0, 100)}...`);
	}

	if (data.error) {
		throw new Error(data.error.message);
	}

	if (!data.result || !data.result.content || !data.result.content[0]) {
		throw new Error("Invalid response from Context7 API");
	}

	return data.result.content[0].text;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "context7-search",
		label: "Context7 Search",
		description: "Search for a library and resolve its Context7 library ID for documentation queries.",
		parameters: Type.Object({
			libraryName: Type.String({ description: "The name of the library (e.g. 'react')" }),
			query: Type.String({ description: "Optional query to help find the library. If not provided, libraryName is used.", default: "" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { libraryName, query } = params as { libraryName: string; query?: string };
			const searchQuery = query || libraryName;

			try {
				const text = await callContext7("resolve-library-id", { query: searchQuery, libraryName });
				return {
					content: [{ type: "text", text }],
					details: { libraryName, query: searchQuery },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	});

	pi.registerTool({
		name: "context7-query",
		label: "Context7 Query",
		description: "Query documentation for a specific library using its Context7 library ID.",
		parameters: Type.Object({
			libraryId: Type.String({ description: "The Context7 library ID (e.g. '/websites/react_dev')" }),
			query: Type.String({ description: "Your question or search term for the documentation" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { libraryId, query } = params as { libraryId: string; query: string };

			try {
				const text = await callContext7("query-docs", { libraryId, query });
				return {
					content: [{ type: "text", text }],
					details: { libraryId, query },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
					details: { error: error instanceof Error ? error.message : 'Unknown error' },
				};
			}
		},
	});
}
