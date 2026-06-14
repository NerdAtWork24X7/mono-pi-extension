// ── UI: system prompt builder + widget rendering ──

import { Text } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { displayName, fmtTok, shortModel } from "./core";

// ── System prompt builder ──

export function buildCatalog(ctx: AgentTeamContext): string {
	return Array.from(ctx.procs.values())
		.map(a => {
			const alive = a.proc ? "alive" : "dead";
			return `### ${displayName(a.def.name)}\n**Dispatch as:** \`${a.def.name}\` [${alive}]\n${a.def.description}\n**Tools:** ${a.def.tools}`;
		})
		.join("\n\n");
}

export function buildSystemPrompt(args: {
	catalog: string;
	date: string;
	cwd: string;
	memory?: { file: string } | null;
	agentMd?: string | null;
	skills?: Array<{ name: string; description: string }>;
}): { systemPrompt: string } {
	const memSection = args.memory?.file
		? `\n# Memory Feature\n\nThis project has a memory feature enabled. After each of your turns, a background process summarizes the exchange and appends key context, decisions, and open questions to \`${args.memory.file}\`. You may consult this file via read tool at the start of a task to recall project state, prior decisions, and outstanding follow-ups from earlier turns.\n`
		: "";
	const agentMdSection = args.agentMd
		? `\n## Agent Instructions (AGENTS.md)\n\n${args.agentMd}\n`
		: "";
	const skillsSection = args.skills && args.skills.length > 0
		? `\n## Available Skills\n\nThe following skills are enabled. Use the skill name when invoking them.\n\n${args.skills.map(s => `- **${s.name}**: ${s.description}`).join("\n")}\n`
		: "";
	return {
		systemPrompt: `
You are the primary reasoning agent for this multi-agent team. You orchestrate work, make decisions, and produce the final answer — you do not offload thinking to subagents.

You are a precise, autonomous orchestrator. Your strength is decomposing problems, dispatching the right tools and subagents for each job, verifying results against acceptance criteria, and synthesizing a clean final answer.


# Tone and Style

- Be concise, direct, and to the point. No filler, no apologies, no restating the prompt.
- Your output will be displayed on a command line interface. Responses use GitHub-flavored Markdown rendered in monospace.
- Minimize output tokens while maintaining helpfulness, quality, and accuracy.
- Do not answer with unnecessary preamble or postamble. Get straight to the action or answer.
- Only use emojis if the user explicitly requests it.

# Workflow

1. **Restate the goal** in one line. If ambiguous, ask ONE focused question, then proceed.
2. **Identify missing context.** Call file_reader/searcher ONLY if the current context cannot answer. Dispatch independent lookups in parallel, in a single batch.
3. **Plan the minimal change set** with explicit acceptance criteria (what must be true when done). Prefer editing existing files over creating new ones.
4. **Dispatch coder/documenter/doc_generator.** For any file output (Excel, PDF, Word, HTML, CSV, etc.) dispatch doc_generator — never generate file content as inline text. Wait for results and check them against the acceptance criteria.
5. **Dispatch tester** with the exact commands to run. If failures, send the error excerpt + failing file paths back to coder (max 2 retry cycles). After 2, stop and surface the failure to the user with the evidence — never paper over it.
6. **Summarize:** what changed, what was verified, what is left.

IMPORTANT: Always plan extensively before dispatching. Reflect on subagent outcomes before proceeding. Do not dispatch blindly.

# Dispatch Contract

- ONE agent at a time. Wait for full response before dispatching the next.
- Subagents are stateless — they see nothing but your prompt. Every dispatch must include:
  - The task in one line, plus acceptance criteria
  - All relevant file paths, excerpts, error messages, and decisions already made
  - What to return and in what format
- Never say "as discussed" or reference prior turns — the subagent has no prior turns.
- Skip .venv, .pi, node_modules, __pycache__, .git in all file operations.

# Escalation Protocol

Subagents reply with structured signals. Route them — do not re-dispatch blindly:

- AMBIGUOUS: <question> → answer it yourself if you can; otherwise ask the user. Re-dispatch with the answer baked in.
- NOT FOUND → treat as ground truth for that location; widen the search or change approach.
- BLOCKED: <reason> → resolve the blocker (missing env, flag, permission) before re-dispatching.

# Hard Rules

- Delegate only context-heavy work (large files, web, command execution). Never delegate reasoning, planning, or decisions.
- Never accept a subagent output without checking it fits the goal and acceptance criteria.
- Never modify code yourself — that is coder job.
- Never run tests yourself — that is tester job.
- **Never generate file content as inline tokens.** Any request whose output is a file (.xlsx, .pdf, .docx, .pptx, .html, .csv, .json, etc.) must go to doc_generator. Emitting spreadsheet rows or PDF markup as text wastes tokens and produces nothing usable.
- Never re-dispatch a subagent for a question you can answer from the result you already have.
- Stay in scope: no drive-by refactors, no unrequested features. Note them as suggestions instead.
- For temporary files use ${args.cwd}/tmp directory

# Tool Priority

- grep before read. read with offset/limit before full file. glob before recursive find.
- Quick needle queries (one known file/symbol) you may do yourself; anything broader goes to file_reader.
- Any file-output task (report, export, document) goes to doc_generator regardless of how simple it seems — scripts are cheaper than tokens.
- Any task involving image content (describe, OCR, compare, extract, classify) goes to image_analyzer — never attempt to interpret image paths or filenames as a proxy for visual content.
- If a subagent output looks confused, dispatch a NEW session with a sharper prompt — do not try to steer the broken one.

# Output Contract

Final answer: 3-8 lines.

- Goal recap (1 line)
- What changed (file:line refs) or what was generated (absolute file paths)
- Verification status (which commands passed/failed, or "not verified")
- Open questions or "done"

No filler, no apologies, no restating the prompt.


${memSection}

## Subagents
${args.catalog}

${agentMdSection}

${skillsSection}

Date: ${args.date}
CWD: ${args.cwd}

`,
	};
}

// ── Widget rendering ──

export function initWidget(ctx: AgentTeamContext) {
	if (!ctx.wCtx) return;
	ctx.wInvalidate = null;

	ctx.wCtx.ui.setWidget("agent-team", (tui: any, theme: any) => {
		const text = new Text("", 0, 1);
		ctx.wInvalidate = () => tui.requestRender();

		return {
			render(width: number): string[] {
				if (!ctx.enabled) {
					text.setText(theme.fg("dim", `Agent Team: disabled (team=${ctx.activeTeam || "none"})  /agents-team-toggle on`));
					return text.render(width);
				}
				const hasMemory = !!ctx.memoryManager;
				const totalCount = ctx.procs.size + (hasMemory ? 1 : 0);
				if (!totalCount) {
					text.setText(theme.fg("dim", "No agents. Add .md files to agents/"));
					return text.render(width);
				}

				const cols = Math.min(ctx.gridCols, totalCount);
				const gap = 1;
				const colW = Math.floor((width - gap * (cols - 1)) / cols);

				// Build a unified list of cards: agent cards first, then the
				// single memory pseudo-card at the end (when enabled).
				const cards: string[][] = [];
				for (const ap of ctx.procs.values()) cards.push(renderCard(ctx, ap, colW, theme));
				if (hasMemory) cards.push(renderMemoryCard(ctx, colW, theme));

				const rows: string[][] = [];
				for (let i = 0; i < cards.length; i += cols) {
					const row = cards.slice(i, i + cols);
					while (row.length < cols) row.push([" ".repeat(colW)]);
					const h = Math.max(...row.map(c => c.length));
					for (const c of row) { while (c.length < h) c.push(" ".repeat(colW)); }
					for (let line = 0; line < h; line++) {
						rows.push(row.map(c => c[line] || ""));
					}
				}

				text.setText(rows.map(r => r.join(" ".repeat(gap))).join("\n"));
				return text.render(width);
			},
		};
	});

	process.stdout.off("resize", ctx.resizeHandler);
	process.stdout.on("resize", ctx.resizeHandler);

	// Set a no-op stub so that invalidate() calls arriving before the
	// render closure runs (which sets wInvalidate to the real requestRender
	// callback) don't recurse back into initWidget and re-register the widget.
	if (!ctx.wInvalidate) ctx.wInvalidate = () => {};
}

export function invalidate(ctx: AgentTeamContext) {
	ctx.animFrame++;
	if (!ctx.wCtx) return;
	if (ctx.wInvalidate) ctx.wInvalidate();
	else initWidget(ctx);
}

export function renderCard(ctx: AgentTeamContext, ap: AgentProc, w: number, theme: any): string[] {
	const trunc = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "..." : s;

	const statusColor = ap.status === "idle" ? "dim"
		: ap.status === "starting" ? "warning"
			: ap.status === "running" ? "accent"
				: ap.status === "done" ? "success" : "error";
	const statusIcon = ap.status === "idle" ? "○"
		: ap.status === "starting" ? "◐"
			: ap.status === "running" ? "●"
				: ap.status === "done" ? "✓" : "";

	const name = displayName(ap.def.name);
	const sm = shortModel(ap.model);
	const modelStr = sm ? ` (${sm})` : "";
	const timeStr = (ap.status === "running" || ap.status === "starting") ? ` ${Math.round(ap.elapsed / 1000)}s` : "";
	const plug = ap.status === "running" ? "\u{1F50C}" : ap.status === "dead" ? "\u{1F916}" : "\u{1F50C}";
	const statusStr = `${plug}${statusIcon}${timeStr}`;

	const maxLabel = w - statusStr.length - 2;
	const truncatedName = trunc(name, maxLabel - modelStr.length);
	const label = theme.fg("accent", theme.bold(truncatedName)) + theme.fg("dim", modelStr);
	const dots = Math.max(1, w - truncatedName.length - modelStr.length - statusStr.length - 2);

	const line1 = label + " " + (ap.status === "running"
		? animDots(dots, ctx.animFrame, theme)
		: theme.fg("dim", "·".repeat(dots))) + " " +
		theme.fg(statusColor, statusStr);

	// Token/context usage line
	const lines = [line1];
	if (ap.contextWindow > 0 && (ap.tokensUsed > 0 || ap.tokensOut > 0)) {
		const pct = Math.min(100, Math.round((ap.tokensUsed / ap.contextWindow) * 100));
		const barW = Math.min(12, Math.max(5, Math.floor((w - 20) / 2)));
		const filled = Math.round((pct / 100) * barW);
		const bar = "█".repeat(filled) + "░".repeat(barW - filled);
		const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";

		const tokenStr = `In=${fmtTok(ap.tokensUsed)}  Out=${fmtTok(ap.tokensOut)}`;
		const pctStr = ` Ctx=${pct}%/${fmtTok(ap.contextWindow)}`;

		// Cache stats line — show cache hits when present
		const cacheHit = ap.cacheRead > 0 ? `Hit=${fmtTok(ap.cacheRead)}` : "";
		const total = ap.cacheSavedTotal > 0 ? `Σ=${fmtTok(ap.cacheSavedTotal)}` : "";
		const sep = cacheHit && total ? " " : "";
		const cacheLabel = `Cache: ${cacheHit}${sep}${total}`;

		const line2 = theme.fg(barColor, bar) + " " +
			theme.fg("dim", tokenStr) + " " +
			theme.fg(barColor, pctStr) + " " + theme.fg("success", "  \u{1F4BE} " + cacheLabel);
		lines.push(line2);


	}

	return lines;
}

function animDots(n: number, frame: number, theme: any): string {
	const colors = ["accent", "success", "warning"];
	let r = "";
	for (let i = 0; i < n; i++) {
		const pos = ((i - frame) % 6 + 6) % 6;
		if (pos < 3) {
			const ci = ((Math.floor((i - pos) / 6)) % colors.length + colors.length) % colors.length;
			r += theme.fg(colors[ci], "·");
		} else {
			r += theme.fg("dim", "·");
		}
	}
	return r;
}

/** Compact "X ago" formatter for the memory card timestamp. */
function formatAgo(ms: number): string {
	if (!ms) return "";
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

/** Single pseudo-card representing the project memory feature. */
export function renderMemoryCard(ctx: AgentTeamContext, w: number, theme: any): string[] {
	const trunc = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "..." : s;
	const mm = ctx.memoryManager;
	if (!mm) return [theme.fg("dim", "·".repeat(w))];

	const s = mm.snapshot;
	const status = s.status;
	const statusColor = status === "idle" ? "dim"
		: status === "recording" ? "warning"
		: status === "summarizing" ? "accent"
		: status === "done" ? "success" : "error";
	const statusIcon = status === "idle" ? "○"
		: status === "recording" ? "◐"
		: status === "summarizing" ? "●"
		: status === "done" ? "✓" : "✗";

	const name = "Memory";
	const sm = ctx.memoryModel ? shortModel(ctx.memoryModel) : "";
	const modelStr = sm ? ` (${sm})` : "";
	const timeStr = (status === "summarizing")
		? ` ${Math.round(s.elapsed / 1000)}s`
		: (status === "recording" ? "" : (s.lastSummaryAt ? ` ${formatAgo(s.lastSummaryAt)}` : ""));
	const statusStr = `${statusIcon}${timeStr}`;

	const maxLabel = w - statusStr.length - 2;
	const truncatedName = trunc(name, maxLabel - modelStr.length);
	const label = theme.fg("accent", theme.bold(truncatedName)) + theme.fg("dim", modelStr);
	const dots = Math.max(1, w - truncatedName.length - modelStr.length - statusStr.length - 2);

	const line1 = label + " " + (status === "summarizing"
		? animDots(dots, ctx.animFrame, theme)
		: theme.fg("dim", "·".repeat(dots))) + " " +
		theme.fg(statusColor, statusStr);

	const lines = [line1];

	// Second line carries context appropriate to the current state.
	if (status === "error" && s.lastError) {
		const errText = s.lastError.length > w - 2 ? s.lastError.slice(0, w - 5) + "..." : s.lastError;
		lines.push(theme.fg("error", ` ${errText}`));
	} else if (status === "done" && s.lastSummaryAt) {
		const ts = new Date(s.lastSummaryAt).toISOString().replace("T", " ").slice(0, 19);
		lines.push(theme.fg("dim", ` last: ${ts} · turn ${s.runCount}`));
	} else if (status === "recording") {
		lines.push(theme.fg("dim", " recording turn..."));
	} else if (status === "summarizing") {
		lines.push(theme.fg("dim", " summarizing..."));
	} else {
		lines.push(theme.fg("dim", ` turns: ${s.runCount}`));
	}

	return lines;
}
