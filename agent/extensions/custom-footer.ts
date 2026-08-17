/**
 * Custom Footer Extension - demonstrates ctx.ui.setFooter()
 *
 * footerData exposes data not otherwise accessible:
 * - getGitBranch(): current git branch
 * - getExtensionStatuses(): texts from ctx.ui.setStatus()
 *
 * Token stats come from ctx.sessionManager/ctx.model (already accessible).
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  let sessionStart = Date.now();

  function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs > 0 ? rs + "s" : ""}`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm > 0 ? rm + "m" : ""}`;
  }

  function fmt(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function contextBar(pct: number, width: number, theme: any): string {
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const color = pct > 90 ? "error" : pct > 70 ? "warning" : "accent";
    return theme.fg(color, bar);
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionStart = Date.now();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);

      return {
        dispose() { unsub(); clearInterval(timer); },
        invalidate() { },
        render(width: number): string[] {
          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cacheRead += m.usage.cacheRead;
              cacheWrite += m.usage.cacheWrite;
              cost += m.usage.cost.total;
            }
          }

          const usage = ctx.getContextUsage();
          const ctxWindow = usage?.contextWindow ?? 0;
          const pct = usage?.percent ?? 0;

          // ── Model + thinking level ──
          const thinking = pi.getThinkingLevel();
          const thinkColor = thinking === "high" ? "warning"
            : thinking === "medium" ? "accent"
              : thinking === "low" ? "dim"
                : "muted";
          const modelId = ctx.model?.id || "no-model";
          const modelBadge = theme.fg("accent", `◆ ${modelId}`) + " " + theme.fg(thinkColor, `● ${thinking}`);

          // ── Token stats ──
          const tokenParts: string[] = [
            theme.fg("accent", `↑${fmt(input)}`) + " " + theme.fg("text", `↓${fmt(output)}`),
          ];
          if (cacheRead > 0 || cacheWrite > 0) {
            const cacheParts: string[] = [];
            if (cacheRead > 0) cacheParts.push(`↺${fmt(cacheRead)}`);
            if (cacheWrite > 0) cacheParts.push(`↻${fmt(cacheWrite)}`);
            tokenParts.push(theme.fg("success", `💾 ${cacheParts.join(" ")}`));
          }
          const tokenStr = tokenParts.join("  ");

          // ── Cost ──
          const costStr = theme.fg("warning", `$${cost.toFixed(2)}`);

          // ── Context usage mini-bar ──
          let contextStr = "";
          if (ctxWindow > 0) {
            const bar = contextBar(pct, 8, theme);
            contextStr = `${bar} ${theme.fg(pct > 75 ? "error" : pct > 50 ? "warning" : "success", `${pct.toFixed(0)}%`)}`;
          }

          // ── Session meta ──
          const elapsed = theme.fg("dim", `⏱ ${formatElapsed(Date.now() - sessionStart)}`);

          const parts = process.cwd().split("/");
          const short = parts.length > 2 ? parts.slice(-2).join("/") : process.cwd();
          const cwdStr = theme.fg("muted", `⌂ ${short}`);

          const branch = footerData.getGitBranch();
          const branchStr = branch ? theme.fg("accent", `⎇ ${branch}`) : "";

          // ── Plan mode status ──
          type PlanEntry = { type: string; customType?: string; data?: { enabled: boolean; executing?: boolean; todos?: { completed: boolean }[] } };
          const allEntries = ctx.sessionManager.getEntries() as PlanEntry[];
          const planEntry = allEntries.filter((e) => e.type === "custom" && e.customType === "plan-mode").pop();
          const planEnabled = planEntry?.data?.enabled ?? false;
          const planExecuting = planEntry?.data?.executing ?? false;
          const planTodos = planEntry?.data?.todos ?? [];
          let planStr = "";
          if (planExecuting && planTodos.length > 0) {
            const completed = planTodos.filter((t) => t.completed).length;
            planStr = theme.fg("accent", `📋 ${completed}/${planTodos.length}`);
          } else if (planEnabled) {
            planStr = theme.fg("warning", "PLAN");
          }

          // ── Assemble with subtle separators ──
          const sep = theme.fg("dim", " · ");
          const sections: string[] = [modelBadge, tokenStr, costStr];
          if (contextStr) sections.push(contextStr);
          sections.push(elapsed, cwdStr);
          if (branchStr) sections.push(branchStr);
          if (planStr) sections.push(planStr);

          const line = theme.fg("accent", "▌ ") + sections.join(sep);

          return [truncateToWidth(line, width)];
        },
      };
    });
  });

  pi.on("session_switch", async (event, _ctx) => {
    if (event.reason === "new") {
      sessionStart = Date.now();
    }
  });
}
