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

type PlanEntry = {
  type: string;
  customType?: string;
  data?: { enabled: boolean; executing?: boolean; todos?: { completed: boolean }[] };
};

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

  // Static for the process lifetime — no need to re-split cwd on every render.
  const cwdParts = process.cwd().split(/[/\\]/);
  const cwdShort = cwdParts.length > 2 ? cwdParts.slice(-2).join("/") : process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    sessionStart = Date.now();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);

      // Token usage accumulates as the branch grows, so only scan entries added
      // since the last render instead of re-walking the whole session each tick.
      let stats = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

      function currentStats() {
        const branch = ctx.sessionManager.getBranch();
        if (branch.length < stats.count) {
          // Branch shrank (undo/checkpoint) — recompute from scratch.
          stats = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        }
        for (let i = stats.count; i < branch.length; i++) {
          const e = branch[i];
          if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            stats.input += m.usage.input;
            stats.output += m.usage.output;
            stats.cacheRead += m.usage.cacheRead;
            stats.cacheWrite += m.usage.cacheWrite;
            stats.cost += m.usage.cost.total;
          }
        }
        stats.count = branch.length;
        return stats;
      }

      // Last matching plan-mode entry, without allocating a filtered array.
      function lastPlanEntry(entries: PlanEntry[]): PlanEntry | undefined {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "custom" && e.customType === "plan-mode") return e;
        }
        return undefined;
      }

      return {
        dispose() {
          unsub();
          clearInterval(timer);
        },
        invalidate() {},
        render(width: number): string[] {
          const { input, output, cacheRead, cacheWrite, cost } = currentStats();

          const usage = ctx.getContextUsage();
          const ctxWindow = usage?.contextWindow ?? 0;
          const pct = usage?.percent ?? 0;

          // ── Model + thinking level ──
          const thinking = pi.getThinkingLevel();
          const thinkColor =
            thinking === "high" ? "warning"
            : thinking === "medium" ? "accent"
            : thinking === "low" ? "dim"
            : "muted";
          const modelId = ctx.model?.id || "no-model";
          const modelBadge =
            theme.fg("accent", `◆ ${modelId}`) + " " + theme.fg(thinkColor, `● ${thinking}`);

          // ── Configured context window + max tokens ──
          const cfgCtx = ctx.model?.contextWindow ?? 0;
          const cfgMax = ctx.model?.maxTokens ?? 0;
          const modelCfg =
            cfgCtx > 0 || cfgMax > 0
              ? theme.fg("dim", `◧ ${cfgCtx > 0 ? fmt(cfgCtx) : "?"} ctx · ${cfgMax > 0 ? fmt(cfgMax) : "?"} max`)
              : "";

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
          const cwdStr = theme.fg("muted", `⌂ ${cwdShort}`);

          const branch = footerData.getGitBranch();
          const branchStr = branch ? theme.fg("accent", `⎇ ${branch}`) : "";

          // ── Plan mode status ──
          const planEntry = lastPlanEntry(ctx.sessionManager.getEntries() as PlanEntry[]);
          const planEnabled = planEntry?.data?.enabled ?? false;
          const planExecuting = planEntry?.data?.executing ?? false;
          const planTodos = planEntry?.data?.todos ?? [];
          let planStr = "";
          if (planExecuting && planTodos.length > 0) {
            let completed = 0;
            for (const t of planTodos) if (t.completed) completed++;
            planStr = theme.fg("accent", `📋 ${completed}/${planTodos.length}`);
          } else if (planEnabled) {
            planStr = theme.fg("warning", "PLAN");
          }

          // ── Assemble with subtle separators ──
          const sep = theme.fg("dim", " · ");
          const sections: string[] = [modelBadge, tokenStr, costStr];
          if (modelCfg) sections.push(modelCfg);
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
