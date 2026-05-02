import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

		async execute(_toolCallId, params) {
			const { url, raw } = params as { url: string; raw: boolean };

			try {
				// Minify JS and avoid commas to not break the -c flag parser
				const jsCode = `const s='[role="dialog"]|[aria-modal="true"]|.cookie-consent|.consent-popup|#cookieChoiceInfo|.govuk-cookie-banner';s.split('|').forEach(x=>{document.querySelectorAll(x).forEach(y=>y.remove())})`.replace(/"/g, '\\"');

				const crawlerConfig = [
					"remove_overlay_elements=true",
					"magic=true",
					"remove_consent_popups=true",
					"scan_full_page=true",
					"scroll_delay=0.5",
					"delay_before_return_html=2",
					`js_code=${jsCode}`
				].join(",");

				// Choose format
				const format = raw ? "html" : "markdown-fit";

				// Crawl4AI CLI command using -c (crawler config string) instead of -C (file)
				const cmd = `crwl "${url}" -c "${crawlerConfig}" -o ${format}`;

				const { stdout, stderr } = await execAsync(cmd, {
					maxBuffer: 10 * 1024 * 1024, // 10MB buffer
				});

				if (stderr) {
					console.warn("Crawl4AI stderr:", stderr);
				}

				return {
					content: [{ type: "text", text: stdout }],
					details: { url, format },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error fetching ${url}: ${error instanceof Error ? error.message : "Unknown error"
								}`,
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
