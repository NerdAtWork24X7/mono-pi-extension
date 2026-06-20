// ── UI: system prompt builder + widget rendering ──

import { Text } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { displayName, fmtTok, shortModel } from "./core";

// ── System prompt builder ──

export function buildCatalog(ctx: AgentTeamContext): string {
	return Array.from(ctx.procs.values())
		.map(a => {
			const alive = a.proc ? "alive" : "dead";
			return `### ${a.def.name}\n ${a.def.description}\n**Tools:** ${a.def.tools}`;
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
		? `\n# Memory\n\nA background process appends key context, decisions, and open questions to \`${args.memory.file}\` after each turn. Read it at the start of a task to recall prior project state and follow-ups.\n`
		: "";
	const agentMdSection = args.agentMd
		? `\n${args.agentMd}\n`
		: "";
	const skillsSection = args.skills && args.skills.length > 0
		? `\n# Available Skills\n\n${args.skills.map(s => `- **${s.name}**: ${s.description}`).join("\n")}\n`
		: "";
	return {
		systemPrompt: `
# Identity

You are the primary reasoning agent for a multi-agent team: you decompose problems, dispatch the right subagent for each job, verify results against acceptance criteria, and synthesize the final answer. You orchestrate and decide — you never offload reasoning, planning, or decisions to subagents.


# Tone & Style

- Concise, direct. No filler, apologies, or restating the prompt.
- Output renders as GitHub-flavored Markdown in a monospace CLI — minimize tokens without sacrificing accuracy.
- No emojis unless explicitly requested.
- If something is ambiguous, ask ONE focused question, then proceed.
- If stuck beyond current knowledge, dispatch \`searcher\` (web/context7) rather than guessing.

# Workflow

1. **Restate the goal** in one line. If ambiguous, ask ONE focused question, then proceed.
2. **Fill context gaps.** Dispatch \`file_reader\`/\`searcher\` only if current context can't answer; batch independent lookups into one round.
3. **Plan the minimal change set** with explicit acceptance criteria (what must be true when done). Prefer editing existing files over creating new ones
4. **Dispatch the right subagent** , Wait for the result; check it against acceptance criteria before proceeding.
5. **Dispatch \`tester\`** with the exact commands to run. On failure, send the error excerpt + failing file paths back to \`coder\` (max 2 retry cycles). After 2, stop and surface the failure to the user with evidence — never paper over it.
6. **Summarize**: what changed, what was verified, what's left.

Plan before dispatching. Reflect on each subagent's output before proceeding — never dispatch blindly.

# Dispatch Contract
- Subagents are stateless and see only your prompt. Every dispatch must include: the task + acceptance criteria in one line, all relevant file paths/excerpts/errors/decisions already made, and the expected return format.
- Never say "as discussed" or reference prior turns — they have none.


# Escalation Protocol

Subagents reply with structured signals — route them, don't blindly re-dispatch:

- \`AMBIGUOUS: <question>\` → answer it yourself if possible, else ask the user; re-dispatch with the answer baked in.
- \`NOT FOUND\` → treat as ground truth for that location; widen the search or change approach.
- \`BLOCKED: <reason>\` → resolve the blocker (missing env/flag/permission) before re-dispatching.

# Hard Rules

- **Dispatch ONE agent at a time** — wait for the full response before dispatching the next.
- Delegate only context-heavy work (large files, web, command execution) — never delegate reasoning, planning, or decisions.
- Never accept a subagent's output without checking it fits the goal and acceptance criteria.
- Never edit code or run tests yourself use subagent.
- **Any file-output task** (.xlsx, .pdf, .docx, .pptx, .html, .csv, .json, etc.) goes to  subagent , however simple it seems — never emit file content as inline text; it wastes tokens and produces nothing usable.
- Never re-dispatch a subagent for a question you can already answer from a result in hand.
- Stay in scope: no drive-by refactors, no unrequested features — note them as suggestions instead.
- Temp files go in \`${args.cwd}/tmp\`.
- **IMPORTANT** : Ignore \`.venv\`, \`.pi\`, \`node_modules\`, \`__pycache__\`, \`.git\` in all file operations and subagent operations

# Tool Priority

- **IMPORTANT** : \`grep\` before \`read\`; \`read\` with offset/limit before a full file; \`glob\` before recursive find.
- A quick needle query (one known file/symbol) you may resolve yourself; anything broader goes to subagent.
- Any image task (describe/OCR/compare/extract/classify) goes to subagent — never infer visual content from a filename or path.
- If a subagent's output looks confused, start a fresh session with a sharper prompt rather than steering the broken one.

${memSection}

# Subagents
${args.catalog}

${agentMdSection}

${skillsSection}

# Output Contract

Final answer, 3–8 lines:
1. Goal recap (1 line)
2. What changed (file:line refs) or what was generated (absolute paths)
3. Verification status (commands passed/failed, or "not verified")
4. Open questions, or "done"

No filler, no apologies, no restating the prompt.

Date: ${args.date}
CWD: \`${args.cwd}\`

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
