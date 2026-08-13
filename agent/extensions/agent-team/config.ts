import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { scanDirs } from "./core";
import type { AgentDef, TeamMember, TeamConfig } from "./core";

export interface ParsedTeams {
	teams: Record<string, TeamMember[]>;
	memoryModel?: string;
	memoryActive?: boolean;
}

export function parseTeamsYaml(raw: string): ParsedTeams {
	// Normalize Windows line endings (CRLF) and stray CR so the line-based
	// regexes below match. parseAgentFile does the same; without this, a
	// CRLF file makes the `team:` header fail to match (trailing \r) and
	// member names/models capture a trailing \r.
	raw = raw.replace(/\r\n?/g, "\n");
	const teams: Record<string, TeamMember[]> = {};
	let memoryModel: string | undefined;
	let memoryActive: boolean | undefined;
	let cur = "";
	let curMember: TeamMember | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		// Nested memory_model block: "memory_model:" followed by indented model:/active:
		const mmBlock = line.match(/^memory_model:\s*$/);
		if (mmBlock) {
			cur = "memory_model";
			curMember = null;
			// Opt-in: enabled only by an explicit active: true below; no default-on.
			continue;
		}
		const mm = line.match(/^memory_model:\s*(.+)$/);
		if (mm) {
			const v = mm[1].trim();
			if (v) memoryModel = v;
			// Opt-in: inline `memory_model: <model>` alone does NOT enable memory.
			cur = "";
			curMember = null;
			continue;
		}
		const tm = line.match(/^(\S[^:]*):$/);
		if (tm) { cur = tm[1].trim(); teams[cur] = []; curMember = null; continue; }
		if (!cur) continue;
		// Named member: "  - name: worker"
		const nm = line.match(/^\s*-\s+name:\s*(.+)$/);
		if (nm) {
			curMember = { name: nm[1].trim(), active: true };
			teams[cur].push(curMember);
			continue;
		}
		// Simple string member: "  - worker"
		const im = line.match(/^\s*-\s+(\S+)$/);
		if (im) {
			curMember = { name: im[1].trim(), active: true };
			teams[cur].push(curMember);
			continue;
		}
		// Member property: "    model: foo" or "    active: false"  (indented under a named member)
		const pm = line.match(/^\s{2,}(\w+):\s*(.+)$/);
		if (pm && curMember) {
			const key = pm[1].trim();
			if (key === "model") curMember.model = pm[2].trim();
			else if (key === "active") curMember.active = pm[2].trim().toLowerCase() !== "false";
			continue;
		}
		if (pm && cur === "memory_model" && !curMember) {
			const key = pm[1].trim();
			if (key === "model") memoryModel = pm[2].trim();
			else if (key === "active") memoryActive = pm[2].trim().toLowerCase() === "true";
			continue;
		}
	}
	const out: ParsedTeams = { teams };
	if (memoryModel) out.memoryModel = memoryModel;
	if (memoryActive !== undefined) out.memoryActive = memoryActive;
	return out;
}

export function parseAgentFile(fp: string): AgentDef | null {
	try {
		let raw = readFileSync(fp, "utf-8");
		raw = raw.replace(/\r\n/g, "\n"); // Normalize Windows line endings
		const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!m) return null;
		const fm: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const i = line.indexOf(":");
			if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		if (!fm.name) return null;
		// Tool allowlist comes strictly from the frontmatter `tools:` key.
		// The body is intentionally NOT scanned — prose examples routinely
		// contain backtick-wrapped identifiers (Python libs, skill names,
		// sample tool names) that are NOT actual tools, and silently adding
		// them would widen the agent's permissions in surprising ways.
		const tools = new Set(
			(fm.tools || "read,grep,find,ls").split(",").map(s => s.replace(/\s+/g, "")).filter(Boolean)
		);
		return {
			name: fm.name,
			description: fm.description || "",
			tools: [...tools].join(","),
			model: fm.model,
			thinking: fm.thinking || undefined,
			skills: parseAgentSkills(fm.skills),
			systemPrompt: m[2].trim(),
			file: fp,
		};
	} catch { return null; }
}

/** Parse a frontmatter `skills:` value into short skill names.
 *  Empty/whitespace entries are ignored. */
function parseAgentSkills(raw?: string): string[] | undefined {
	if (raw === undefined) return undefined;
	const names: string[] = [];
	for (const name of raw.split(",")) {
		const trimmed = name.trim();
		if (trimmed) names.push(trimmed);
	}
	return names;
}

/** Resolve a skill short name to an absolute SKILL.md path.
 *  Returns undefined if the skill directory does not exist. */
export function resolveSkillPath(name: string): string | undefined {
	const p = join(getAgentDir(), "skills", name, "SKILL.md");
	return existsSync(p) ? p : undefined;
}

// Extension discovery (scanExtensionPaths / loadDisabledExtensions / isDisabled)
// now lives in ./extensions — see that file for rationale.

export function scanAgents(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		join(getAgentDir(), "agents"),
	];
	const agents: AgentDef[] = [];
	const seen = new Set<string>();
	for (const fp of scanDirs(dirs, f => f.endsWith(".md"))) {
		const def = parseAgentFile(fp);
		if (def && !seen.has(def.name.toLowerCase())) {
			seen.add(def.name.toLowerCase());
			agents.push(def);
		}
	}
	return agents;
}

export interface Skill {
	name: string;
	description: string;
	/** Directory name under getAgentDir()/skills/. Used for path resolution. */
	dir: string;
}

/** Parse YAML frontmatter (very limited: just `name:` and `description:`) */
function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
	const m = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	let name = "";
	let description = "";
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		const key = line.slice(0, i).trim();
		const val = line.slice(i + 1).trim();
		if (key === "name") name = val;
		else if (key === "description") description = val;
	}
	return name ? { name, description } : null;
}

/** Convert settings.json `skills` entry to a skill name.
 *  Entries look like:
 *    "-skills/electron-scaffold/SKILL.md"  -> disabled
 *    "+skills/foo/SKILL.md" or "skills/foo/SKILL.md" -> enabled
 *  Returns { name, disabled } or null if the entry doesn't look like a skill. */
function parseSkillSettingEntry(entry: string): { name: string; disabled: boolean } | null {
	const m = entry.match(/^([-+]?)skills\/([^/]+)\/SKILL\.md$/);
	if (!m) return null;
	return { name: m[2], disabled: m[1] === "-" };
}

/** Discover all skills in getAgentDir()/skills/, filtered by settings.json `skills` field.
 *  Skills listed with `-` prefix are disabled; unlisted skills default to enabled. */
/** Cached result keyed by mtimeMs of settings.json + skills dir mtime. */
let skillsCache: { mtime: number; skills: Skill[] } | null = null;

export function discoverEnabledSkills(): Skill[] {
	const skillsDir = join(getAgentDir(), "skills");
	if (!existsSync(skillsDir)) return [];
	// Composite mtime key: max of settings.json mtime and skills dir mtime.
	let cacheKey = 0;
	const settingsPath = join(getAgentDir(), "settings.json");
	if (existsSync(settingsPath)) {
		try { cacheKey = Math.max(cacheKey, statSync(settingsPath).mtimeMs); } catch { /* ignore */ }
	}
	try { cacheKey = Math.max(cacheKey, statSync(skillsDir).mtimeMs); } catch { /* ignore */ }
	if (skillsCache && skillsCache.mtime === cacheKey) return skillsCache.skills;
	const result = computeEnabledSkills();
	skillsCache = { mtime: cacheKey, skills: result };
	return result;
}

function computeEnabledSkills(): Skill[] {
	const skillsDir = join(getAgentDir(), "skills");
	if (!existsSync(skillsDir)) return [];
	const settingsPath = join(getAgentDir(), "settings.json");
	const disabled = new Set<string>();
	if (existsSync(settingsPath)) {
		try {
			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const list: string[] = Array.isArray(raw?.skills) ? raw.skills : [];
			for (const entry of list) {
				if (typeof entry !== "string") continue;
				const parsed = parseSkillSettingEntry(entry);
				if (!parsed) continue;
				if (parsed.disabled) disabled.add(parsed.name);
			}
		} catch { /* ignore */ }
	}
	const out: Skill[] = [];
	for (const f of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!f.isDirectory()) continue;
		const skillMd = join(skillsDir, f.name, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		if (disabled.has(f.name)) continue;
		try {
			const raw = readFileSync(skillMd, "utf-8");
			const fm = parseSkillFrontmatter(raw);
			if (fm) out.push({ name: fm.name, description: fm.description, dir: f.name });
			else out.push({ name: f.name, description: "", dir: f.name });
		} catch { /* skip unreadable */ }
	}
	return out;
}

/** Discover ALL skills in getAgentDir()/skills/, including those disabled in settings.json.
 *  Used by the sidebar so users can toggle skills on/off. */
export function discoverAllSkills(): Skill[] {
	const skillsDir = join(getAgentDir(), "skills");
	if (!existsSync(skillsDir)) return [];
	const out: Skill[] = [];
	for (const f of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!f.isDirectory()) continue;
		const skillMd = join(skillsDir, f.name, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		try {
			const raw = readFileSync(skillMd, "utf-8");
			const fm = parseSkillFrontmatter(raw);
			if (fm) out.push({ name: fm.name, description: fm.description, dir: f.name });
			else out.push({ name: f.name, description: "", dir: f.name });
		} catch { /* skip unreadable */ }
	}
	return out;
}

/** Load AGENTS.md content. Tries cwd first, then falls back to getAgentDir()/AGENTS.md.
 *  Returns the trimmed content, or null if neither file exists.
 *  Cached by mtimeMs of the chosen candidate; re-reads only if the file changes. */
/** Cached result keyed by candidate mtimeMs. */
let agentMdCache: { key: number; content: string | null } | null = null;

export function loadAgentMd(cwd: string): string | null {
	const candidates = [join(cwd, "AGENTS.md"), join(getAgentDir(), "AGENTS.md")];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		let mtime = 0;
		try { mtime = statSync(p).mtimeMs; } catch { continue; }
		if (agentMdCache && agentMdCache.key === mtime) return agentMdCache.content;
		try {
			const raw = readFileSync(p, "utf-8").trim();
			const content = raw || null;
			agentMdCache = { key: mtime, content };
			return content;
		} catch { /* try next */ }
	}
	return null;
}

// ── Config Persistence ────────────────────────────────────────────────

/** Cached result keyed by mtimeMs. Invalidates when teams.yaml changes. */
let teamsYamlCache: { key: number; parsed: ParsedTeams } | null = null;

/** Load and parse teams.yaml, cached by mtimeMs so `loadAgents` doesn't
 *  re-read+re-parse on every toggle. Returns an empty ParsedTeams when
 *  the file doesn't exist. */
export function loadTeamsYaml(filePath: string): ParsedTeams {
	if (!existsSync(filePath)) {
		teamsYamlCache = null;
		return { teams: {} };
	}
	let mtime = 0;
	try { mtime = statSync(filePath).mtimeMs; } catch { /* fall through */ }
	if (teamsYamlCache && teamsYamlCache.key === mtime) return teamsYamlCache.parsed;
	const parsed = parseTeamsYaml(readFileSync(filePath, "utf-8"));
	teamsYamlCache = { key: mtime, parsed };
	return parsed;
}

/** Serialize a ParsedTeams structure back to YAML and write to disk.
 *  Preserves comments and ordering is best-effort (teams are rebuilt from
 *  the in-memory data). */
export function saveTeamsYaml(filePath: string, data: ParsedTeams): void {
	const lines: string[] = [];
	lines.push("# Agent Team Definitions");
	lines.push("# ---------------------------------------------");
	lines.push("# Simple format:");
	lines.push("#   team_name:");
	lines.push("#     - agent_name");
	lines.push("#");
	lines.push("# With model override (takes precedence over .md frontmatter model):");
	lines.push("#   team_name:");
	lines.push("#     - name: agent_name");
	lines.push("#       model: provider/model-name");
	lines.push("#");
	lines.push("# Top-level keys:");
	lines.push("#   memory_model:");
	lines.push("#       model: <provider>/<model>  - summarizer model; memory runs only when active: true.");
	lines.push("#       active: true|false         - persistent on/off switch (must be true to run; sidebar toggle).");
	lines.push("#       A background subprocess summarizes each orchestrator turn and appends");
	lines.push("#       the result to <cwd>/.pi_memory/project_memory.md.");
	lines.push("");
	if (data.memoryModel) {
		lines.push("memory_model:");
		lines.push(`  model: ${data.memoryModel}`);
		lines.push(`  active: ${data.memoryActive === true ? "true" : "false"}`);
		lines.push("");
	}
	for (const [teamName, members] of Object.entries(data.teams)) {
		lines.push(`${teamName}:`);
		for (const m of members) {
			// Always use named format so we can include model and active
			lines.push(`  - name: ${m.name}`);
			if (m.model) lines.push(`    model: ${m.model}`);
			if (m.active === false) lines.push(`    active: false`);
		}
		lines.push("");
	}
	// Invalidate the in-memory cache since we just wrote new content.
	teamsYamlCache = null;
	writeFileSync(filePath, lines.join("\n") + "\n");
}

export const CONFIG_FILE = "agent-team-config.json";

export function loadPersistedConfig(): Partial<TeamConfig> {
	const p = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(p)) return {};
	try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

export function savePersistedConfig(cfg: TeamConfig) {
	writeFileSync(join(getAgentDir(), CONFIG_FILE), JSON.stringify(cfg, null, 2));
}
