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
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { mkdirSync, type WriteStream } from "fs";
import { join } from "path";

import type { AgentDef, AgentProc, TeamMember, TeamConfig, AgentTeamContext, TerminalBackend } from "./core";
import { displayName, shortModel, TmuxBackend, HerdrBackend, SessionLogger } from "./core";
import { loadPersistedConfig, savePersistedConfig, scanAgents, scanExtensionPaths, loadTeamsYaml, discoverEnabledSkills, loadAgentMd } from "./config";
import { ProcessManager, dispatch as dispatchImpl, activateTeam as activateTeamImpl, handleEvent as handleEventImpl, makeHandleEvent } from "./orchestration";
import { MemoryManager, extractLastAssistantText } from "./memory";
import { buildCatalog, buildSystemPrompt, initWidget as initWidgetImpl, invalidate as invalidateImpl } from "./ui";
import { registerDispatchAgentTool, registerCommands, registerShortcut } from "./integrations";
import { homedir } from "os";

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
	logDir = "";
	enabled = true;

	tmuxCwd = "";
	cachedExtPaths: string[] = []; // resolved once per session_start

	// Bound once so the same reference can be used for both `on` and `off`,
	// and so `this` is the team (not the WriteStream emitter) on invocation.
	resizeHandler = () => this.handleTerminalResize();
	orchestratorModel = ""; // model id from orchestrator's context
	sharedPaneId: string | null = null; // single terminal pane for combined session log
	sessionLogFile = "";           // single combined log file path
	sessionLogStream: WriteStream | null = null; // single combined log stream

	// Memory feature (only used when memoryModel is set in teams.yaml)
	memoryModel = "";
	memoryFile = "";
	memoryDir = "";
	memoryManager: MemoryManager | null = null;

	// Backends
	herdrBackend = new HerdrBackend();
	tmuxBackend = new TmuxBackend();
	terminal: TerminalBackend;
	logger: SessionLogger;
	procMgr: ProcessManager;
	lastDispatchedAp: AgentProc | null = null;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.saved = loadPersistedConfig();
		this.gridCols = this.saved.gridCols ?? 1;
		this.enabled = this.saved.enabled ?? true;

		// Auto-detect terminal backend at construction time
		this.terminal = this.herdrBackend.detect() ? this.herdrBackend
			: this.tmuxBackend.detect() ? this.tmuxBackend
				: this.tmuxBackend; // fallback to tmux (will be no-op if tmux not available)

		this.logger = new SessionLogger(this.terminal, "");

		// ProcessManager takes accessor closures so it can read the latest
		// values of sessionDir/cachedExtPaths/orchestratorModel without
		// holding stale references. `this` is stable for invalidate.
		this.procMgr = new ProcessManager(
			() => this.sessionDir,
			() => this.cachedExtPaths,
			() => this.orchestratorModel,
			this.logger,
			() => this.invalidate(),
		);
	}

	// ── Orchestration delegation (ctx -> this.procMgr) ──

	killProc(ap: AgentProc, immediate?: boolean) {
		this.procMgr.killProc(this, ap, immediate);
	}

	async killAll(killPanesToo?: boolean): Promise<void> {
		await this.procMgr.killAll(this, killPanesToo);
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
		savePersistedConfig({
			activeTeam: this.activeTeam,
			gridCols: this.gridCols,
			enabled: this.enabled,
		});
	}

	// ── Logging methods (bound to logger) ──

	getTerminalWidth(): number {
		return this.terminal.getTerminalWidth();
	}

	updateLogWidth() {
		this.logger.updateWidth();
	}

	openSessionLog() {
		this.logger.setLogDir(this.logDir);
		this.logger.open();
		this.sessionLogFile = this.logger.getLogFile();
		this.sessionLogStream = this.logger.getStream();
	}

	closeSessionLog() {
		this.logger.close();
		this.sessionLogStream = null;
	}

	// ── Terminal Panes ──────────────────────────────────────────────────

	resizeSharedPane() {
		if (!this.sharedPaneId || !this.terminal.isValidPaneId(this.sharedPaneId)) return;
		const tw = this.terminal.getTerminalWidth();
		if (tw <= 0) return;
		this.terminal.resizePane(this.sharedPaneId, tw);
	}

	handleTerminalResize() {
		this.updateLogWidth();
		this.resizeSharedPane();
		this.invalidate();
	}

	createSessionPane() {
		if (!this.enabled) return;
		if (!this.terminal.detect()) return;
		if (!this.sessionLogFile) return;
		if (this.sharedPaneId) return; // pane already exists

		const cwd = (this.tmuxCwd || process.cwd());
		const origPane = process.env.TMUX_PANE || process.env.HERDR_PANE_ID || "";
		const id = this.terminal.createLogPane(cwd, this.sessionLogFile, origPane);
		if (id && this.terminal.isValidPaneId(id)) this.sharedPaneId = id;
	}

	killPanes() {
		this.closeSessionLog();
		if (this.sharedPaneId && this.terminal.isValidPaneId(this.sharedPaneId)) {
			const id = this.sharedPaneId;
			this.sharedPaneId = null;
			this.terminal.killPane(id);
		}
	}

	// ── Agent Loading ───────────────────────────────────────────────

	async loadAgents(cwd: string): Promise<void> {

		this.sessionDir = join(homedir(), ".pi","agent-team-log","agent-sessions");
		this.logDir = join(homedir(), ".pi","agent-team-log","agent-logs");
		const AgentCmdDir = join(homedir(), ".pi","agent-team-log","agent-cmd");
		this.memoryDir = join(cwd, ".pi_memory");
		this.memoryFile = "";
		mkdirSync(this.sessionDir, { recursive: true });
		mkdirSync(this.logDir, { recursive: true });
		mkdirSync(AgentCmdDir, { recursive: true });
		this.updateLogWidth();

		this.allDefs = scanAgents(cwd);
		this.cachedExtPaths = scanExtensionPaths(cwd);

		const tp = join(getAgentDir(), "agents", "teams.yaml");
		const parsed = loadTeamsYaml(tp);
		this.teams = parsed.teams;
		this.memoryModel = parsed.memoryModel || "";

		// Tear down any prior memory manager and (re)create if the model is set.
		// When memoryModel is empty/undefined the feature is fully disabled:
		// the manager is never constructed and the event hooks are no-ops.
		if (this.memoryManager) {
			await this.memoryManager.awaitIdle(0);
		}
		this.memoryManager = null;
		if (this.memoryModel) {
			mkdirSync(this.memoryDir, { recursive: true });
			this.memoryFile = join(this.memoryDir, "project_memory.md");
			this.memoryManager = new MemoryManager({
				model: this.memoryModel,
				memoryFile: this.memoryFile,
				sessionDir: this.sessionDir,
				logger: this.logger,
				invalidate: () => this.invalidate(),
				cachedExtPaths: () => this.cachedExtPaths,
				def: {
					name: "memory-summarizer",
					description: "Per-turn memory summarizer spawned alongside the orchestrator.",
					tools: "read,write,edit",
					systemPrompt: "",
					file: "",
				},
				handleEvent: makeHandleEvent(this),
			});
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
		this.tmuxCwd = ctx.cwd;

		const names = Object.keys(this.teams);
		const teamToActivate = (this.activeTeam && names.includes(this.activeTeam)) ? this.activeTeam : (names[0] || "");
		if (teamToActivate) {
			await this.activateTeam(teamToActivate);
		}

		this.openSessionLog();
		this.createSessionPane();

		this.pi.setActiveTools(["dispatch_agent", "ask_user_question", "todo", "read", "bash", "grep", "find", "ls", "write", "edit"]);
		this.invalidate();
		const members = Array.from(this.procs.values()).map(a => displayName(a.def.name)).join(", ");
		this.wCtx = ctx;
		ctx.ui.setStatus("agent-team", `Team: ${this.activeTeam} (${this.procs.size})`);
	}

	async disableAgentTeam(ctx: any) {
		this.enabled = false;
		this.persist();
		await this.killAll();
		this.wCtx = ctx;
		// Restore all tools EXCEPT dispatch_agent
		const allNames = this.pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
		this.pi.setActiveTools(allNames);
		this.invalidate();
	}
}

export default function (pi: ExtensionAPI) {
	const team = new AgentTeam(pi);

	// ── System Prompt Override ──────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!team.enabled) return;

		// Sync orchestrator model on each turn
		// Use provider-prefixed ID (e.g. "zai/glm-5.1") to avoid ambiguous resolution
		// when multiple providers define the same model ID (e.g. "glm-5.1" exists
		// under opencode, opencode-go, and zai providers)
		const m = _ctx.model;
		const newModel = m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : "";
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

		// Build catalog of available agents
		const catalog = buildCatalog(team);
		const t0 = Date.now();
		const cwd = process.cwd();
		return buildSystemPrompt({
			catalog,
			date: new Date(t0).toISOString().split("T")[0],
			cwd,
			memory: team.memoryManager ? { file: team.memoryFile } : null,
			agentMd: loadAgentMd(cwd),
			skills: discoverEnabledSkills(),
		});
	});

	// ── Memory: per-turn background summarization ──

	pi.on("agent_end", async (event, _ctx) => {
		if (!team.enabled) return;
		if (!team.memoryManager) return;
		const text = extractLastAssistantText(event && event.messages);
		team.memoryManager.recordOutput(text);
		team.invalidate();
	});

	// ── Session Start ───────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clean up any leftover processes
		await team.killAll();

		if (team.wCtx) { team.wCtx.ui.setWidget("agent-team", undefined); team.wInvalidate = null; }
		team.wCtx = _ctx;
		const m0 = _ctx.model;
		team.orchestratorModel = m0 ? (m0.provider ? `${m0.provider}/${m0.id}` : m0.id) : "";

		await team.loadAgents(_ctx.cwd);
		team.tmuxCwd = _ctx.cwd;

		team.initWidget();

		if (!team.enabled) {
			// Ensure dispatch_agent is NOT in active tools when disabled
			const allNames = pi.getAllTools().map(t => t.name).filter(n => n !== "dispatch_agent");
			pi.setActiveTools(allNames);
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

		// Open combined session log + create log pane
		team.openSessionLog();
		team.createSessionPane();

		// Lock to dispatcher-only tools
		pi.setActiveTools(["dispatch_agent", "ask_user_question", "todo", "read", "bash", "grep", "find", "ls", "write", "edit"]);

		_ctx.ui.setStatus("agent-team", `Team: ${team.activeTeam} (${team.procs.size})`);
		const members = Array.from(team.procs.values()).map(a => displayName(a.def.name)).join(", ");
		_ctx.ui.notify(
			`Team: ${team.activeTeam} (${members}) — agents spawn on-demand per task\n\n` +
			`/agents-team          Select a team\n` +
			`/Ctrl+q                Toggle agent mode`,
			"info",
		);
		team.invalidate();
	});

	// ── Session Shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		process.stdout.off("resize", team.resizeHandler);
		team.persist();
		if (team.memoryManager) await team.memoryManager.awaitIdle(3000);
		await team.killAll(true);
	});

	// Register tool, commands, shortcut
	registerDispatchAgentTool(pi, team);
	registerCommands(pi, team);
	registerShortcut(pi, team);
}
