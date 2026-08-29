/**
 * Agent Team - Ephemeral subagent orchestrator
 *
 * Subagents are spawned on-demand per task. A fresh `pi --mode rpc` process
 * is created for each dispatch, the task runs, and the process is killed
 * once the result is reported back to the orchestrator. No context
 * accumulates between dispatches — each task starts with a clean slate.
 *
 * Lifecycle:
 *   session_start  → load agent defs only (NO spawning)
 *   dispatch       → spawn fresh process → send task → await result → kill
 *   session_end    → cleanup any residual processes
 *
 * Commands:
 *   /agents-team          - switch active team
 *   /agents-list          - list agents + process status
 *   /agents-grid N        - set grid columns (default 1)
 *   /agents-team-toggle   - enable/disable (on/off/status)
 *   /agents-restart       - kill any running subagent processes
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { readdir as readdirAsync, stat as statAsync, unlink as unlinkAsync } from "fs/promises";
import { join } from "path";

import type { AgentDef, AgentProc, TeamMember, TeamConfig, AgentTeamContext, BatchDispatchResult } from "./core";
import { displayName, shortModel, SessionLogger, RwLock, filterSkills } from "./core";
import { loadPersistedConfig, savePersistedConfig, scanAgents, loadTeamsYaml, discoverEnabledSkills, loadAgentMd, teamsYamlPath } from "./config";
import { scanExtensionPaths } from "./extensions";
import { ProcessManager, dispatch as dispatchImpl, activateTeam as activateTeamImpl, handleEvent as handleEventImpl, dispatchMany as dispatchManyImpl, dispatchAgentMany as dispatchAgentManyImpl } from "./orchestration";
import { MemoryManager, createMemoryManager, extractLastAssistantText, installMemoryEscEditor } from "./memory";
import { buildSystemPrompt, initWidget as initWidgetImpl, invalidate as invalidateImpl, closeSidebar } from "./ui";
import { registerCustomReadTool, registerCustomWriteTool, registerCustomEditTool, registerDispatchAgentTool, registerDispatchAgentsTool, registerCommands, registerShortcut } from "./integrations";
import { fullModelId } from "./helpers";
import { homedir } from "os";

/** Remove session files older than 24 hours to prevent unbounded disk growth
 *  when the CLI exits abruptly and leaves orphaned files behind.
 *  Uses async I/O to avoid blocking the event loop. */
async function cleanupOldSessionFiles(sessionDir: string) {
  const CUTOFF_MS = 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    const files = await readdirAsync(sessionDir);
    await Promise.all(files.map(async (f) => {
      const p = join(sessionDir, f);
      try {
        const st = await statAsync(p);
        if (now - st.mtimeMs > CUTOFF_MS) await unlinkAsync(p);
      } catch { /* ignore per-file errors */ }
    }));
  } catch { /* ignore directory read errors */ }
}

export class AgentTeam implements AgentTeamContext {
  pi: ExtensionAPI;
  procs = new Map<string, AgentProc>(); // key = lowercase name
  allDefs: AgentDef[] = [];
  teams: Record<string, TeamMember[]> = {};
  saved: Partial<TeamConfig> = {};
  activeTeam = "";
  gridCols = 1;
  animFrame = 0;
  wCtx: any = null;
  wInvalidate: (() => void) | null = null;
  sessionDir = "";
  catalogCache = "";
  catalogDirty = true;
  skillsCache: Array<{ name: string; description: string; dir: string }> = [];
  agentMdCache: string | null = null;
  enabled = true;
  parallelDispatch = true;
  maxParallel = 5;
  destructiveTools: string[] = ["custom_edit", "custom_write"];
  dispatchLock: RwLock = new RwLock();
  batchClones = new Set<AgentProc>();
  /** Set of agent names that are temporarily disabled by the user */
  disabledAgents = new Set<string>();
  /** Skill directory names enabled for orchestrator system prompt. Empty = none. */
  orchestratorSkills = new Set<string>();
  /** Skill directory names available to subagents. Empty = none. */
  subagentSkills = new Set<string>();
  /** Orchestrator tool denylist. Tools listed are hidden from the orchestrator. Empty = all tools shown. */
  skipOrchestratorTools: string[] = [];
  private agentMutexes = new Map<string, Promise<unknown>>();

  cachedExtPaths: string[] = []; // resolved once per session_start

  // Bound once so the same reference can be used for both `on` and `off`,
  // and so `this` is the team (not the WriteStream emitter) on invocation.
  resizeHandler = () => this.handleTerminalResize();
  orchestratorModel = ""; // model id from orchestrator's context

  // Memory feature (only used when memoryModel is set AND active: true in teams.yaml)
  memoryModel = "";
  memoryActive = false;
  originalMemoryModel = ""; // preserved value for re-enabling after toggle off
  memoryFile = "";
  memoryDir = "";
  memoryManager: MemoryManager | null = null;

  logger: SessionLogger;
  procMgr: ProcessManager;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.saved = loadPersistedConfig();
    this.gridCols = this.saved.gridCols ?? 1;
    this.enabled = this.saved.enabled ?? true;
    this.parallelDispatch = this.saved.parallelDispatch ?? true;
    this.maxParallel = this.saved.maxParallel ?? 5;
    this.destructiveTools = this.saved.destructiveTools ?? ["write", "custom_edit"];
    this.disabledAgents = new Set(this.saved.disabledAgents ?? []);
    this.orchestratorSkills = new Set(this.saved.orchestratorSkills ?? []);
    this.subagentSkills = new Set(this.saved.subagentSkills ?? []);
    this.skipOrchestratorTools = this.saved.skipOrchestratorTools ?? [];

    this.logger = new SessionLogger();

    // ProcessManager takes accessor closures so it can read the latest
    // values of sessionDir/cachedExtPaths/orchestratorModel without
    // holding stale references. `this` is stable for invalidate.
    this.procMgr = new ProcessManager(
      () => this.sessionDir,
      () => this.cachedExtPaths,
      () => this.orchestratorModel,
      () => this.invalidate(),
    );
  }

  // ── Orchestration delegation (ctx -> this.procMgr) ──

  killProc(ap: AgentProc, immediate?: boolean) {
    this.procMgr.killProc(ap, immediate);
  }

  async killAll(): Promise<void> {
    await this.procMgr.killAll(this);
  }

  spawnProc(ap: AgentProc): Promise<boolean> {
    return this.procMgr.spawnProc(this, ap);
  }

  wipeSessionFile(ap: AgentProc) {
    this.procMgr.wipeSessionFile(ap);
  }

  resolveIfPending(ap: AgentProc, output: string, code: number) {
    this.procMgr.resolveIfPending(ap, output, code);
  }

  writeSystemPrompt(ap: AgentProc) {
    this.procMgr.writeSystemPrompt(ap);
  }

  cleanSystemPrompt(ap: AgentProc) {
    this.procMgr.cleanSystemPrompt(ap);
  }

  // ── Dispatch / RPC delegation ──

  async dispatch(agentName: string, task: string) {
    return dispatchImpl(this, agentName, task);
  }

  async dispatchMany(tasks: Array<{ agent: string; task: string }>, signal?: AbortSignal): Promise<BatchDispatchResult> {
    return dispatchManyImpl(this, tasks, signal);
  }
  async dispatchAgentMany(agentName: string, tasks: string[], signal?: AbortSignal): Promise<BatchDispatchResult> {
    return dispatchAgentManyImpl(this, agentName, tasks, signal);
  }

  /** Serialize dispatches to the same agent so its shared AgentProc state never collides. */
  serializeAgent(name: string, fn: () => Promise<any>): Promise<any> {
    const prev = this.agentMutexes.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a settled reference that doesn't hold fn's closure.
    // Once the previous chain resolves, remove the entry if it's still
    // the one we stored (avoids unbounded Map growth over long sessions).
    const settled = next.then(() => { }, () => { });
    settled.then(() => {
      if (this.agentMutexes.get(name) === settled) this.agentMutexes.delete(name);
    });
    this.agentMutexes.set(name, settled);
    return next;
  }

  async activateTeam(name: string) {
    return activateTeamImpl(this, name);
  }

  handleEvent(ap: AgentProc, line: string) {
    handleEventImpl(this, ap, line);
  }

  // ── UI delegation ──

  initWidget() {
    initWidgetImpl(this);
  }

  invalidate() {
    invalidateImpl(this);
  }

  // ── Local instance methods ──

  /** Agent header: "[name][model] - heading" */
  tag(ap: AgentProc, heading: string): string {
    return `[${displayName(ap.def.name)}][${shortModel(ap.model)}] - ${heading}`;
  }

  // Persist current runtime state to disk
  persist() {
    // Read the on-disk config so manual edits to keys the runtime doesn't
    // track (and partial writes) survive. savePersistedConfig does a full
    // file rewrite, so without this merge any user edit to skipOrchestratorTools
    // (or other keys) gets clobbered by the stale construction-time snapshot.
    const onDisk = loadPersistedConfig();
    // skipOrchestratorTools has no runtime setter: it is only ever read from
    // the file (constructor). An empty runtime value means "no change", so
    // prefer the on-disk value instead of dropping the key (JSON.stringify
    // omits undefined, which previously deleted a non-empty file entry).
    const skipOrchestratorTools = this.skipOrchestratorTools.length
      ? this.skipOrchestratorTools
      : onDisk.skipOrchestratorTools;
    savePersistedConfig({
      ...onDisk,
      activeTeam: this.activeTeam,
      gridCols: this.gridCols,
      enabled: this.enabled,
      parallelDispatch: this.parallelDispatch,
      maxParallel: this.maxParallel,
      destructiveTools: this.destructiveTools,
      disabledAgents: Array.from(this.disabledAgents),
      orchestratorSkills: Array.from(this.orchestratorSkills),
      subagentSkills: Array.from(this.subagentSkills),
      skipOrchestratorTools,
    });
  }

  /** Active tool allowlist. Includes dispatch_agents when parallel dispatch is on. */
  activeToolList(): string[] {
    const all = this.pi.getAllTools().map(t => t.name);
    // Start from full PI tool set, remove internal routing tools
    let base = all.filter(n => n !== "dispatch_agent" && n !== "dispatch_agents");
    // If skipOrchestratorTools is non-empty, exclude those tools (denylist)
    if (this.skipOrchestratorTools.length) {
      const block = new Set(this.skipOrchestratorTools.map(t => t.toLowerCase()));
      base = base.filter(n => !block.has(n.toLowerCase()));
    }
    if (this.parallelDispatch) base.unshift("dispatch_agents");
    base.unshift("dispatch_agent");
    return base;
  }

  // ── Logging methods (bound to logger) ──

  handleTerminalResize() {
    this.invalidate();
  }

  // ── Agent Loading ───────────────────────────────────────────────

  async loadAgents(cwd: string): Promise<void> {

    this.sessionDir = join(homedir(), ".pi", "agent-team-log", "agent-sessions");
    this.memoryDir = join(cwd, ".pi_memory");
    this.memoryFile = "";
    mkdirSync(this.sessionDir, { recursive: true });
    void cleanupOldSessionFiles(this.sessionDir); // fire-and-forget async cleanup

    this.allDefs = scanAgents(cwd);
    this.cachedExtPaths = scanExtensionPaths(cwd);
    this.skillsCache = discoverEnabledSkills();
    this.agentMdCache = loadAgentMd(cwd);

    const parsed = loadTeamsYaml(teamsYamlPath());
    this.teams = parsed.teams;
    this.memoryModel = parsed.memoryModel || "";
    this.originalMemoryModel = this.memoryModel;
    this.memoryActive = parsed.memoryActive === true;

    // Tear down any prior memory manager and (re)create if the model is set.
    // When memoryModel is empty/undefined the feature is fully disabled:
    // the manager is never constructed and the event hooks are no-ops.
    if (this.memoryManager) {
      await this.memoryManager.awaitIdle(0);
    }
    this.memoryManager = null;
    if (this.memoryModel && this.memoryActive) {
      this.memoryManager = createMemoryManager(this, this.memoryModel);
    }

    if (!Object.keys(this.teams).length) this.teams = { all: this.allDefs.map(d => ({ name: d.name })) };
  }

  // ── Shared enable/disable (used by command + shortcut) ─────────

  async enableAgentTeam(ctx: any) {
    this.enabled = true;
    this.persist();

    await this.killAll();
    this.procs.clear();

    this.loadAgents(ctx.cwd);

    const names = Object.keys(this.teams);
    const teamToActivate = (this.activeTeam && names.includes(this.activeTeam)) ? this.activeTeam : (names[0] || "");
    if (teamToActivate) {
      await this.activateTeam(teamToActivate);
    }

    this.pi.setActiveTools(this.activeToolList());
    this.invalidate();
    this.wCtx = ctx;
    ctx.ui.setStatus("agent-team", `Team: ${this.activeTeam} (${this.procs.size})`);
    setAgentTeamHeader(ctx, true, isContextPrunerEnabled(ctx.cwd));
  }

  async disableAgentTeam(ctx: any) {
    this.enabled = false;
    this.persist();
    await this.killAll();
    this.wCtx = ctx;
    // Restore all tools EXCEPT dispatch_agent / dispatch_agents
    const allNames = this.pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent" && n !== "dispatch_agents");
    this.pi.setActiveTools(allNames);
    this.invalidate();
    setAgentTeamHeader(ctx, false, false);
  }
}

function buildBanner(): string {
  // Rainbow VS banner — each line gets its own 256-color wrap.
  // We embed raw SGR codes so the colors survive the TUI header render.
  const RST = "\x1b[0m";
  const rb = (s: string, i: number) =>
    `\x1b[38;5;${[196, 208, 226, 46, 51, 21, 201][i % 7]}m${s}${RST}`;
  return (
    rb(`VVVVVVVV           VVVVVVVV   SSSSSSSSSSSSSSS `, 0) + "\n" +
    rb(`V::::::V           V::::::V SS:::::::::::::::S`, 1) + "\n" +
    rb(`V::::::V           V::::::VS:::::SSSSSS::::::S`, 2) + "\n" +
    rb(`V::::::V           V::::::VS:::::S     SSSSSSS`, 3) + "\n" +
    rb(` V:::::V           V:::::V S:::::S            `, 4) + "\n" +
    rb(`  V:::::V         V:::::V  S:::::S            `, 5) + "\n" +
    rb(`   V:::::V       V:::::V    S::::SSSS         `, 6) + "\n" +
    rb(`    V:::::V     V:::::V      SS::::::SSSSS    `, 7) + "\n" +
    rb(`     V:::::V   V:::::V         SSS::::::::SS  `, 8) + "\n" +
    rb(`      V:::::V V:::::V             SSSSSS::::S `, 9) + "\n" +
    rb(`       V:::::V:::::V                    S:::::S`, 10) + "\n" +
    rb(`        V:::::::::V                    S:::::S`, 11) + "\n" +
    rb(`         V:::::::V         SSSSSSS     S:::::S`, 12) + "\n" +
    rb(`          V:::::V          S::::::SSSSSS:::::S`, 13) + "\n" +
    rb(`           V:::V           S:::::::::::::::SS `, 14) + "\n" +
    rb(`            VVV             SSSSSSSSSSSSSSS   `, 15) + "\n" +
    `/agents-team           Select a team\n` +
    `Ctrl+Q                 Toggle sidebar\n`
  );
}

/** Read context-pruner state from its persisted config. */
function isContextPrunerEnabled(cwd: string): boolean {
  try {
    const p = join(cwd, ".pi", "context-pruner-config.json");
    if (!existsSync(p)) return false;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return raw.enabled === true;
  } catch {
    return false;
  }
}

function setAgentTeamHeader(ctx: any, enabled: boolean, prunerEnabled: boolean = false) {
  if (!ctx.ui?.setHeader) return;
  if (!enabled) {
    ctx.ui.setHeader(undefined);
    return;
  }
  ctx.ui.setHeader((_tui: any, theme: any) => ({
    render: (_width: number) => {
      const lines = buildBanner().split("\n");
      if (prunerEnabled) {
        lines.push(theme.fg("dim", "🌿"));
      }
      return lines;
    },
    invalidate: () => { },
  }));
}

export default function (pi: ExtensionAPI) {
  const team = new AgentTeam(pi);

  // When the agent team is active, label the orchestrator "orchestrator" in
  // observability so the session list (the table below "clear all agents")
  // shows the main agent distinctly from spawned subagents. Subagents carry
  // their real role via --o-name (see orchestration.ts / memory.ts). Respect
  // any explicit SCOPE_NAME the operator already set.
  if (team.enabled && !process.env.SCOPE_NAME) process.env.SCOPE_NAME = "orchestrator";

  // ── System Prompt Override ──────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!team.enabled) return;

    // Sync orchestrator model on each turn
    // Use provider-prefixed ID (e.g. "zai/glm-5.1") to avoid ambiguous resolution
    // when multiple providers define the same model ID (e.g. "glm-5.1" exists
    // under opencode, opencode-go, and zai providers)
    const newModel = fullModelId(_ctx.model);
    if (newModel && newModel !== team.orchestratorModel) {
      team.orchestratorModel = newModel;
      // Update subagents that don't have their own model
      for (const ap of team.procs.values()) {
        if (!ap.teamModel && !ap.def.model) ap.model = team.orchestratorModel;
      }
    }

    // Memory: capture the user's prompt for this turn. No-op when disabled.
    if (team.memoryManager) {
      team.memoryManager.recordInput((event && event.prompt) || "");
    }

    // buildSystemPrompt reads live team state from ctx, so only pass what
    // it actually consumes. (The skill↔agent map, read-only list, catalog
    // build, etc. that used to be computed here were never read by the
    // prompt builder — dropping them is the per-turn speed win.)
    return buildSystemPrompt({
      ctx: team,
      date: new Date().toISOString().split("T")[0],
      cwd: process.cwd(),
      memory: team.memoryManager ? { file: team.memoryFile } : null,
      agentMd: team.agentMdCache,
      skills: filterSkills(team.skillsCache, team.orchestratorSkills),
    });
  });

  // ── Memory: per-turn background summarization ──

  pi.on("agent_end", async (event, _ctx) => {
    if (!team.enabled) return;
    if (!team.memoryManager) return;
    const text = extractLastAssistantText(event && event.messages);
    // Pass the turn's abort signal so ESC/abort of the turn also cancels
    // the memory summarizer spawned for it (parity with dispatch clones).
    team.memoryManager.recordOutput(text, _ctx.signal);
    team.invalidate();
  });

  // ── Session Start ───────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Clean up any leftover processes
    await team.killAll();

    if (team.wCtx) { team.wCtx.ui.setWidget("agent-team", undefined); team.wInvalidate = null; }
    team.wCtx = _ctx;
    team.orchestratorModel = fullModelId(_ctx.model);

    await team.loadAgents(_ctx.cwd);

    // ESC aborts an in-flight memory summary (the key is reserved, so this
    // goes through a custom editor component rather than registerShortcut).
    if (team.memoryManager) installMemoryEscEditor(team, _ctx);

    team.initWidget();

    if (!team.enabled) {
      // Ensure dispatch_agent is NOT in active tools when disabled
      const allNames = pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
      pi.setActiveTools(allNames);
      setAgentTeamHeader(_ctx, false);
      _ctx.ui.notify(
        "Agent team is disabled. Use /agents-team-toggle on to enable.",
        "info",
      );
      return;
    }

    // Restore saved team or default to first — NO spawning
    const names = Object.keys(team.teams);
    const savedTeam = team.saved.activeTeam || "";
    const restoreTeam = (savedTeam && names.includes(savedTeam)) ? savedTeam : (names[0] || "");
    if (restoreTeam) await team.activateTeam(restoreTeam);

    // Lock to dispatcher-only tools
    pi.setActiveTools(team.activeToolList());

    _ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
    setAgentTeamHeader(_ctx, team.enabled, isContextPrunerEnabled(_ctx.cwd));
    team.invalidate();
  });

  // ── Session Shutdown ────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    process.stdout.off("resize", team.resizeHandler);
    closeSidebar();
    team.persist();
    if (team.memoryManager) await team.memoryManager.awaitIdle(3000);
    await team.killAll();
    if (team.wCtx?.ui?.setHeader) team.wCtx.ui.setHeader(undefined);
  });

  // Register tools, commands, shortcut
  registerCustomReadTool(pi);
  registerCustomWriteTool(pi);
  registerCustomEditTool(pi);
  registerDispatchAgentTool(pi, team);
  registerDispatchAgentsTool(pi, team);
  registerCommands(pi, team);
  registerShortcut(pi, team);
}
