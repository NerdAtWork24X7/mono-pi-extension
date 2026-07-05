// ── UI: system prompt builder + widget rendering ──

import { Text } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { displayName, fmtTok, hrPad, shortModel } from "./core";

const ansiRe = /\x1b\[[0-9;]*m/g;

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
- lazy senior developer. Lazy means efficient, not careless. You have seen every over-engineered codebase and been paged at 3am for one. The best code is the code never written.
- Concise, direct. No filler, apologies, or restating the prompt.
- Output renders as GitHub-flavored Markdown in a monospace CLI — minimize tokens without sacrificing accuracy.
- No emojis unless explicitly requested.
- If something is ambiguous, ask ONE focused question, then proceed.
- If stuck beyond current knowledge, dispatch \`searcher\` (web/context7) rather than guessing.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Stdlib does it?** Use it.
3. **Native platform feature covers it?** \`<input type="date">\` over a picker lib, CSS over JS, DB constraint over app code.
4. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
5. **Can it be one line?** One line.
6. **Only then:** the minimum code that works.

# Workflow

1. **Restate the goal** in one line. If ambiguous, ask ONE focused question, then proceed.
2. **Fill context gaps.** Dispatch \`file_reader\`/\`searcher\` only if current context can't answer; batch independent lookups into one round.
3. **Plan the minimal change set** with explicit acceptance criteria (what must be true when done). Prefer editing existing files over creating new ones
4. **Dispatch the right subagent** , Wait for the result; check it against acceptance criteria before proceeding.
5. **Dispatch \`documenter\`** if the change touches public surface (CLI flags, env vars, exported functions, config keys, breaking changes) — even if the user didn't explicitly ask. Skip otherwise.
6. **Dispatch \`tester\`** with the exact commands to run. On failure, send the error excerpt + failing file paths back to \`coder\` (max 2 retry cycles). After 2, stop and surface the failure to the user with evidence — never paper over it.
7. **Summarize**: what changed, what was verified, what's left.

Plan before dispatching. Reflect on each subagent's output before proceeding — never dispatch blindly.

# Dispatch Contract
- Subagents are stateless and see only your prompt. Every dispatch must include: the task + acceptance criteria in one line, all relevant file paths/excerpts/errors/decisions already made, and the expected return format.
- Never say "as discussed" or reference prior turns — they have none.


# Escalation Protocol

Subagents reply with structured signals — route them, don't blindly re-dispatch:

- \`AMBIGUOUS: <question>\` → answer it yourself if possible, else ask the user; re-dispatch with the answer baked in.
- \`NOT FOUND\` → treat as ground truth for that location; widen the search or change approach.
- \`BLOCKED: <reason>\` → resolve the blocker (missing env/flag/permission) before re-dispatching.
- \`TIMEOUT\` (tester) → treat as a real failure, not a glitch. Report partial output to the user; only re-dispatch if you can name why it hung (e.g. missing flag) — never retry the identical command.
- Raw error output with no keyword (e.g. \`doc_generator\`'s stderr tail, \`image_analyzer\`'s surfaced error field) → treat as \`BLOCKED\`: extract the root cause, fix the input/spec if that's yours to fix, and re-dispatch once. If it fails again, stop and surface the evidence verbatim to the user.

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
- Follow YAGNI principles, and prefer one-liner solutions

# Tool Priority

- **IMPORTANT** : \`grep\` before \`read\`; \`read\` with offset/limit before a full file; \`find\` for filename-pattern matches.
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
			render(width: number): string[] {				const hasMemory = !!ctx.memoryManager;
				const totalCount = ctx.procs.size + (hasMemory ? 1 : 0);

			if (!ctx.enabled) {
				text.setText(theme.fg("dim", "Agent team disabled. /agents-team-toggle on"));
				return text.render(width);
			}

			if (!totalCount) {
				const hint = "No agents. Add subagent to agent.yml files to agents/";
				const hintVis = [...hint].length;
				const hintLine =
					theme.fg("border", "│   ") +
					theme.fg("dim", hint) +
					theme.fg("border", " ".repeat(Math.max(0, width - 4 - hintVis - 2)) + " │");
				const topBorder = theme.fg("border", hrPad("", width, "╭", "╮", "─"));
				const bottomBorder = theme.fg("border", hrPad("", width, "╰", "╯", "─"));
				text.setText([topBorder, hintLine, bottomBorder].join("\n"));
				return text.render(width);
			}

				const boxPad = 4;
				const innerW = width - boxPad;
				const cols = Math.min(ctx.gridCols, totalCount);
				const cardGap = 1;
				const colW = Math.floor((innerW - cardGap * (cols - 1)) / cols);

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

			const topBorder = theme.fg("border", hrPad("", width, "╭", "╮", "─"));
			// ── Header: "Subagent Team" sits inside the box, left-aligned after the border ──
			const headerText = "Subagent Team";
			const headerPad = Math.max(0, innerW - [...headerText].length);
			const headerLine =
				theme.fg("border", "│ ") +
				theme.fg("accent", theme.bold(headerText)) +
				" ".repeat(headerPad) +
				" " + theme.fg("border", "│");
			const sepLine = theme.fg("border", hrPad("", width, "├", "┤", "─"));
			const boxedRows = rows.map(r => {
					const rowStr = r.join(" ".repeat(cardGap));
					const rowVis = [...rowStr.replace(ansiRe, "")].length;
					const padded = rowStr + " ".repeat(Math.max(0, innerW - rowVis));
					return theme.fg("border", "│") + " " + padded + " " + theme.fg("border", "│");
				});
				const bottomBorder = theme.fg("border", hrPad("", width, "╰", "╯", "─"));

			text.setText([topBorder, headerLine, sepLine, ...boxedRows, bottomBorder].join("\n"));
			return text.render(width);
			},
		};
	}, { placement: "aboveEditor" });

	process.stdout.off("resize", ctx.resizeHandler);
	process.stdout.on("resize", ctx.resizeHandler);

	if (!ctx.wInvalidate) ctx.wInvalidate = () => {};
}

export function invalidate(ctx: AgentTeamContext) {
	ctx.animFrame++;
	if (!ctx.wCtx) return;
	if (ctx.wInvalidate) ctx.wInvalidate();
	else initWidget(ctx);
}

// ── Card rendering (modern compact — thin accent bar, pill-like stats) ──

const trunc = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;

/** Pad a coloured string to exactly `targetW` visible cells with trailing spaces. */
function padToVis(colored: string, targetW: number): string {
	const v = [...colored.replace(ansiRe, "")].length;
	return colored + " ".repeat(Math.max(0, targetW - v));
}

/** 1–2 line agent card: accent bar + icon + name + time, optional stats row. */
export function renderCard(ctx: AgentTeamContext, ap: AgentProc, w: number, theme: any): string[] {
	const statusColor = ap.status === "idle" ? "dim"
		: ap.status === "starting" ? "warning"
			: ap.status === "running" ? "accent"
				: ap.status === "done" ? "success" : "error";
	const statusIcon = ap.status === "idle" ? "○"
		: ap.status === "starting" ? "◐"
			: ap.status === "running" ? "●"
				: ap.status === "done" ? "✓" : "✗";

	const name = displayName(ap.def.name);
	const sm = shortModel(ap.model);
	const modelStr = sm ? ` ${sm}` : "";
	const timeStr = ["running", "starting", "done"].includes(ap.status)
		? `${Math.round(ap.elapsed / 1000)}s` : "";

	// ── Line 1: ▌ ● Coder claude-3.5              12s ──
	const prefixLen = 4; // "▌ ● "
	const maxLabel = Math.max(1, w - prefixLen - [...timeStr].length - 1);
	const truncatedName = trunc(name, maxLabel - modelStr.length);
	const visibleL1 = prefixLen + [...truncatedName].length + [...modelStr].length;
	const spacing = Math.max(1, w - visibleL1 - [...timeStr].length);

	const line1 =
		theme.fg(statusColor, "▌ ") +
		theme.fg(statusColor, statusIcon + " ") +
		theme.fg("text", theme.bold(truncatedName)) +
		theme.fg("dim", modelStr) +
		" ".repeat(spacing) +
		theme.fg("dim", timeStr);

	const lines = [line1];

	// ── Line 2: ▌   ████░░░░  45% · In 1.2k · Out 400 · 💾 H=500 ──
	if (ap.contextWindow > 0 && (ap.tokensUsed > 0 || ap.tokensOut > 0)) {
		const pct = Math.min(100, Math.round((ap.tokensUsed / ap.contextWindow) * 100));
		const barW = Math.min(10, Math.max(4, Math.floor((w - 4) / 4)));
		const filled = Math.round((pct / 100) * barW);
		const bar = "█".repeat(filled) + "░".repeat(barW - filled);
		const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "accent";

		let statStr = `${pct}% · In ${fmtTok(ap.tokensUsed)} · Out ${fmtTok(ap.tokensOut)}`;
		let cachePill = "";
		if (ap.cacheRead > 0 || ap.cacheSavedTotal > 0) {
			const parts: string[] = [];
			if (ap.cacheRead > 0) parts.push(`H=${fmtTok(ap.cacheRead)}`);
			if (ap.cacheSavedTotal > 0) parts.push(`Σ=${fmtTok(ap.cacheSavedTotal)}`);
			cachePill = ` · 💾 ${parts.join(" ")}`;
		}

		// Drop cache pill if it would overflow; fall back to compact if still too wide
		const bareLen = 4 + barW + 2 + [...statStr].length; // "▌   " + bar + "  " + statStr
		if (4 + barW + 2 + [...statStr].length + [...cachePill].length > w) cachePill = "";
		if (4 + barW + 2 + [...statStr].length > w) {
			// Still overflowing — drop to bar + percentage only
			statStr = `${pct}%`;
		}

		const line2 = padToVis(
			theme.fg(statusColor, "▌   ") +
			theme.fg(barColor, bar) + "  " +
			theme.fg("dim", statStr) +
			theme.fg("success", cachePill),
			w,
		);

		lines.push(line2);
	}

	return lines;
}

// ── Memory card ──

function formatAgo(ms: number): string {
	if (!ms) return "";
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

export function renderMemoryCard(ctx: AgentTeamContext, w: number, theme: any): string[] {
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

	const sm = ctx.memoryModel ? shortModel(ctx.memoryModel) : "";
	const modelStr = sm ? ` ${sm}` : "";

	const timeStr = (status === "summarizing") ? `${Math.round(s.elapsed / 1000)}s`
		: (s.lastSummaryAt ? formatAgo(s.lastSummaryAt) : "");

	// Line 1: ▌ ✓ Memory claude-3.5            5m
	const prefixLen = 4;
	const maxLabel = Math.max(1, w - prefixLen - [...timeStr].length - 1);
	const truncatedName = trunc("Memory", maxLabel - modelStr.length);
	const visibleL1 = prefixLen + [...truncatedName].length + [...modelStr].length;
	const spacing = Math.max(1, w - visibleL1 - [...timeStr].length);

	const line1 =
		theme.fg(statusColor, "▌ ") +
		theme.fg(statusColor, statusIcon + " ") +
		theme.fg("text", theme.bold(truncatedName)) +
		theme.fg("dim", modelStr) +
		" ".repeat(spacing) +
		theme.fg("dim", timeStr);

	// Line 2: ▌   last: 2025-01-01 12:00 · turn 3
	let detail = "";
	if (status === "error" && s.lastError) {
		detail = s.lastError.length > w - 5 ? s.lastError.slice(0, w - 6) + "…" : s.lastError;
	} else if (status === "done" && s.lastSummaryAt) {
		const ts = new Date(s.lastSummaryAt).toISOString().replace("T", " ").slice(0, 19);
		detail = `last: ${ts} · turn ${s.runCount}`;
	} else if (status === "recording") {
		detail = "recording turn…";
	} else if (status === "summarizing") {
		detail = "summarizing…";
	} else {
		detail = `turns: ${s.runCount}`;
	}
	const detailColor = status === "error" ? "error" : "dim";
	const line2 = padToVis(
		theme.fg(statusColor, "▌   ") + theme.fg(detailColor, detail),
		w,
	);

	return [line1, line2];
}
