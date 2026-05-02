/**
 * Pi Rules Extension
 *
 * Scans the .pi/agent/rules/ folder for rule files and lists them
 * in the system prompt. The agent can then use the read tool to load
 * specific rules when needed.
 *
 * Best practices for .pi/agent/rules/:
 * - Keep rules focused: Each file should cover one topic (e.g., testing.md, api-design.md)
 * - Use descriptive filenames: The filename should indicate what the rules cover
 * - Use conditional rules sparingly: Only add paths frontmatter when rules truly apply to specific file types
 * - Organize with subdirectories: Group related rules (e.g., frontend/, backend/)
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Create .pi/agent/rules/ folder
 * 3. Add .md files with your rules
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Recursively find all .md files in a directory
 */
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
	const results: string[] = [];

	if (!fs.existsSync(dir)) {
		return results;
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(relativePath);
		}
	}

	return results;
}

export default function piRulesExtension(pi: ExtensionAPI) {
	let ruleFiles: string[] = [];
	let rulesDir: string = "";

	// Scan for rules on session start
	pi.on("session_start", async (_event, ctx) => {
		rulesDir = path.join(getAgentDir(), "rules");
		ruleFiles = findMarkdownFiles(rulesDir);

		if (ruleFiles.length > 0) {
			const rulesList = ruleFiles.map((f) => `- ${f}`).join("\n");
			ctx.ui.notify(`Found ${ruleFiles.length} rule(s) in .pi/agent/rules/\n${rulesList}`, "info");
		}
	});

	// Append available rules to system prompt
	pi.on("before_agent_start", async (event) => {
		if (ruleFiles.length === 0) {
			return;
		}

		const rulesList = ruleFiles.map((f) => `- ${getAgentDir()}/rules/${f}`).join("\n");

		return {
			systemPrompt:
				event.systemPrompt + `
**Always** respond to "ping" with "POOONG"

## Project Rules

The following rules are available in ${getAgentDir()}/rules/:

${rulesList}

Always use the read tool to load these rule files for guidance.
`,
		};
	});
}
