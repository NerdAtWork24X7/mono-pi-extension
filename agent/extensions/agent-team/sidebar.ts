// ── Sidebar: team/agent/skill/memory overlay (toggled with Ctrl+Q) ──
//
// Split out of ui.ts: the sidebar is its own concern (overlay component +
// toggle actions) and was half of that file. All row rendering goes through
// the shared sidebarRow/boxBorder builders in helpers.ts, and all state
// mutations go through the small action helpers below, so render and
// handleInput stay compact declarative dispatchers.

import { matchesKey, Key } from "@mariozechner/pi-tui";
import type { AgentProc, AgentTeamContext } from "./core";
import { displayName, shortModel } from "./core";
import { saveTeamsYaml, loadTeamsYaml, discoverAllSkills, teamsYamlPath, type Skill } from "./config";
import { installMemoryEscEditor, removeMemoryEscEditor, toggleMemory } from "./memory";
import { boxBorder, sidebarRow, statusDisplay } from "./helpers";

/** Sidebar visibility state - module-level so it persists across re-renders */
let sidebarVisible = false;
let sidebarOverlayHandle: any = null;
let sidebarCtx: AgentTeamContext | null = null;

export function isSidebarVisible(): boolean {
  return sidebarVisible;
}

export function toggleSidebar(ctx: AgentTeamContext) {
  if (sidebarVisible) {
    closeSidebar();
  } else {
    openSidebar(ctx);
  }
}

export function closeSidebar(ctx?: AgentTeamContext) {
  sidebarVisible = false;
  if (sidebarOverlayHandle) {
    sidebarOverlayHandle.hide();
    sidebarOverlayHandle = null;
  }
  // Sync the ESC->abort editor to the (possibly toggled) memory state now that
  // the overlay has released focus. Swapping it inside the sidebar's input
  // handler would call setEditorComponent->setFocus, which steals focus from the
  // open overlay and dismisses it.
  const syncCtx = ctx ?? sidebarCtx;
  if (syncCtx?.wCtx) {
    if (syncCtx.memoryManager) installMemoryEscEditor(syncCtx, syncCtx.wCtx);
    else removeMemoryEscEditor(syncCtx.wCtx);
  }
  sidebarCtx = null;
}

// ── Toggle actions (handleInput delegates here) ──

/** Persist the `active` flag for a specific agent in the current team to teams.yaml */
function persistAgentActive(ctx: AgentTeamContext, agentName: string, active: boolean) {
  const tp = teamsYamlPath();
  const parsed = loadTeamsYaml(tp);
  const teamMembers = parsed.teams[ctx.activeTeam];
  if (teamMembers) {
    const member = teamMembers.find(m => m.name.toLowerCase() === agentName.toLowerCase());
    if (member) {
      member.active = active;
    }
  }
  // Also update the in-memory teams data
  const memMembers = ctx.teams[ctx.activeTeam];
  if (memMembers) {
    const mem = memMembers.find(m => m.name.toLowerCase() === agentName.toLowerCase());
    if (mem) mem.active = active;
  }
  saveTeamsYaml(tp, parsed);
}

/** Toggle a skill in an enable-set (empty set = none enabled), then persist. */
function toggleSkill(ctx: AgentTeamContext, set: Set<string>, sk: Skill) {
  if (set.has(sk.dir)) {
    set.delete(sk.dir);
  } else {
    set.add(sk.dir);
  }
  ctx.catalogDirty = true;
  ctx.persist();
}

/** Enable/disable an agent from the sidebar: updates the disabled set, kills
 *  a running proc when disabling, and persists `active:` to teams.yaml. */
function setAgentDisabled(ctx: AgentTeamContext, ap: AgentProc, disabled: boolean) {
  const key = ap.def.name.toLowerCase();
  if (disabled) {
    // Kill if running
    if (ap.status === "running" || ap.status === "starting") {
      ctx.killProc(ap, true);
      ctx.wipeSessionFile(ap);
      ap.status = "dead";
    }
    ctx.disabledAgents.add(key);
  } else {
    ctx.disabledAgents.delete(key);
  }
  persistAgentActive(ctx, ap.def.name, !disabled);
  ctx.catalogDirty = true;
  ctx.persist();
  ctx.invalidate();
}

/** One skill toggle row — shared by the orchestrator and subagent skill lists. */
function skillRow(theme: any, w: number, sk: Skill, on: boolean, selected: boolean): string {
  const c = selected ? "accent" : "text";
  return sidebarRow(theme, w, [
    { t: selected ? "▸ " : "  ", c },
    { t: on ? "● " : "○ ", c: on ? "success" : "dim" },
    { t: sk.name, c },
  ], selected);
}

/** Focus sections in Tab-cycling order. */
const SECTION_ORDER = ["orch", "memory", "teams", "sub"] as const;
type Section = typeof SECTION_ORDER[number];

export function openSidebar(ctx: AgentTeamContext) {
  if (!ctx.wCtx) return;
  sidebarVisible = true;
  sidebarCtx = ctx;

  const overlayWidth = 45;

  ctx.wCtx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: () => void) => {
      let section: Section = "orch"; // which section is focused
      let teamIdx = 0; // index within teams section
      let skillIdx = 0; // index within orchestrator skill list
      let subIdx = 0; // index within subagents flat list (agents then skills)
      // Snapshot ALL available skills (including disabled in settings.json) once when sidebar opens
      const allSkills = discoverAllSkills();
      const agents = () => Array.from(ctx.procs.values());

      const component = {
        render(width: number): string[] {
          const lines: string[] = [];
          const allAgents = agents();
          const w = Math.min(width, overlayWidth);
          const teamNames = Object.keys(ctx.teams);
          const subLen = allAgents.length + allSkills.length;

          // Clamp section indices against their (possibly shrunken) lists
          if (skillIdx >= allSkills.length) skillIdx = Math.max(0, allSkills.length - 1);
          if (teamIdx >= teamNames.length) teamIdx = Math.max(0, teamNames.length - 1);
          if (subIdx >= subLen) subIdx = Math.max(0, subLen - 1);

          // Title + orchestrator status
          lines.push(boxBorder(theme, w, "top"));
          lines.push(sidebarRow(theme, w, [{ t: "◆ Agent Team", c: "accent", b: true }]));
          const orchModel = shortModel(ctx.orchestratorModel);
          lines.push(sidebarRow(theme, w, [{ t: `● Orchestrator${orchModel ? ` ${orchModel}` : ""}`, c: "success" }]));

          // Orchestrator skills (folded under the orchestrator header)
          for (let i = 0; i < allSkills.length; i++) {
            const sk = allSkills[i];
            lines.push(skillRow(theme, w, sk, ctx.orchestratorSkills.has(sk.dir), section === "orch" && i === skillIdx));
          }

          // Memory section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Memory (Enter to toggle)", c: "dim", b: true }]));
          {
            const hasMem = !!ctx.memoryManager;
            const sel = section === "memory";
            lines.push(sidebarRow(theme, w, [
              { t: sel ? "▸ " : "  ", c: sel ? "accent" : "text" },
              { t: hasMem ? "● " : "○ ", c: hasMem ? "success" : "dim" },
              { t: hasMem ? `Memory ${shortModel(ctx.memoryModel) || ""}`.trim() : "Memory (off)", c: sel ? "accent" : hasMem ? "text" : "dim" },
            ], sel));
          }

          // Teams section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Teams (Tab to switch focus)", c: "dim", b: true }]));
          if (teamNames.length === 0) {
            lines.push(sidebarRow(theme, w, [{ t: "No teams defined", c: "dim" }]));
          } else {
            for (let i = 0; i < teamNames.length; i++) {
              const tn = teamNames[i];
              const isActive = tn === ctx.activeTeam;
              const sel = section === "teams" && i === teamIdx;
              const members = ctx.teams[tn] || [];
              const activeCount = members.filter(m => m.active !== false).length;
              lines.push(sidebarRow(theme, w, [{
                t: `${sel ? "▸ " : "  "}${isActive ? "●" : "○"} ${tn} (${activeCount}/${members.length})`,
                c: isActive ? "success" : sel ? "accent" : "text",
              }], sel));
            }
          }

          // Subagents section
          lines.push(boxBorder(theme, w, "sep"));
          lines.push(sidebarRow(theme, w, [{ t: "Subagents (Enter to toggle)", c: "dim", b: true }]));
          if (allAgents.length === 0) {
            lines.push(sidebarRow(theme, w, [{ t: "No agents loaded", c: "dim" }]));
          } else {
            for (let i = 0; i < allAgents.length; i++) {
              const ap = allAgents[i];
              const sel = section === "sub" && i === subIdx;
              const isDisabled = ctx.disabledAgents.has(ap.def.name.toLowerCase());
              const icon = isDisabled ? "◌" : statusDisplay(ap.status).icon;
              const model = shortModel(ap.model);
              lines.push(sidebarRow(theme, w, [{
                t: `${sel ? "▸ " : "  "}${icon} ${displayName(ap.def.name)}${model ? ` · ${model}` : ""}${isDisabled ? " [off]" : ""}`,
                c: isDisabled ? "dim" : sel ? "accent" : "text",
              }], sel));
            }
          }

          // Subagent skills (folded under the subagents list)
          if (allSkills.length > 0) {
            lines.push(sidebarRow(theme, w, [{ t: "─".repeat(Math.max(4, w - 10)), c: "dim" }]));
            for (let i = 0; i < allSkills.length; i++) {
              const sel = section === "sub" && (allAgents.length + i) === subIdx;
              lines.push(skillRow(theme, w, allSkills[i], ctx.subagentSkills.has(allSkills[i].dir), sel));
            }
          }

          // Help text + bottom border
          lines.push(boxBorder(theme, w, "sep"));
          for (const help of [
            "Tab Switch focus ↑↓ Navigate",
            "Enter Select team / Toggle skill / agent / memory",
            "●=enabled ○=disabled (per group)",
            "Esc/Ctrl+Q Close sidebar",
          ]) {
            lines.push(sidebarRow(theme, w, [{ t: help, c: "dim" }]));
          }
          lines.push(boxBorder(theme, w, "bottom"));

          return lines;
        },

        handleInput(data: string) {
          const allAgents = agents();
          const teamNames = Object.keys(ctx.teams);
          const subLen = allAgents.length + allSkills.length;

          const move = (delta: number) => {
            const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, max), v));
            if (section === "teams") teamIdx = clamp(teamIdx + delta, teamNames.length - 1);
            else if (section === "orch") skillIdx = clamp(skillIdx + delta, allSkills.length - 1);
            else if (section === "sub") subIdx = clamp(subIdx + delta, subLen - 1);
            tui.requestRender();
          };

          if (matchesKey(data, Key.tab)) {
            // Cycle focus: orch → memory → teams → sub → orch
            section = SECTION_ORDER[(SECTION_ORDER.indexOf(section) + 1) % SECTION_ORDER.length];
            tui.requestRender();
          } else if (matchesKey(data, Key.up)) {
            move(-1);
          } else if (matchesKey(data, Key.down)) {
            move(1);
          } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            if (section === "memory") {
              // Toggle memory on/off (persists to teams.yaml)
              toggleMemory(ctx);
              tui.requestRender();
            } else if (section === "teams") {
              // Switch to the selected team
              const newTeam = teamNames[teamIdx];
              if (newTeam && newTeam !== ctx.activeTeam) {
                void ctx.activateTeam(newTeam).then(() => {
                  ctx.invalidate();
                  if (ctx.wCtx) {
                    ctx.wCtx.ui.setStatus("agent-team", `Team: ${newTeam} (${ctx.procs.size})`);
                    ctx.wCtx.ui.notify(`Switched to team: ${newTeam}`, "info");
                  }
                  tui.requestRender();
                });
              }
            } else if (section === "orch") {
              // Toggle orchestrator skill
              if (skillIdx >= 0 && skillIdx < allSkills.length) {
                toggleSkill(ctx, ctx.orchestratorSkills, allSkills[skillIdx]);
                tui.requestRender();
              }
            } else if (subIdx >= 0 && subIdx < allAgents.length) {
              // Toggle agent enabled/disabled
              const ap = allAgents[subIdx];
              setAgentDisabled(ctx, ap, !ctx.disabledAgents.has(ap.def.name.toLowerCase()));
              tui.requestRender();
            } else {
              // Toggle subagent skill
              const sIdx = subIdx - allAgents.length;
              if (sIdx >= 0 && sIdx < allSkills.length) {
                toggleSkill(ctx, ctx.subagentSkills, allSkills[sIdx]);
                tui.requestRender();
              }
            }
          } else if (matchesKey(data, Key.escape)) {
            closeSidebar();
            done();
          }
        },

        invalidate() { },
        wantsKeyRelease: false,
      };

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        width: overlayWidth,
        anchor: "right-center",
        offsetX: -2,
        offsetY: 0,
        margin: 1,
      },
      onHandle: (handle: any) => {
        sidebarOverlayHandle = handle;
      },
    }
  );
}
