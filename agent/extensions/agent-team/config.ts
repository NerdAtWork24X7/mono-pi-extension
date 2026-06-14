import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { scanDirs } from "./core";
import type { AgentDef, TeamMember, TeamConfig } from "./core";

export interface ParsedTeams {
	teams: Record<string, TeamMember[]>;
	memoryModel?: string;
}

export function parseTeamsYaml(raw: string): ParsedTeams {
	const teams: Record<string, TeamMember[]> = {};
	let memoryModel: string | undefined;
	let cur = "";
	let curMember: TeamMember | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		// Top-level memory_model: <provider>/<model>
		// Must be checked BEFORE the generic team-key match, since the generic
		// pattern would otherwise treat "memory_model" as a team name and create
		// a phantom empty team.
		const mm = line.match(/^memory_model:\s*(.+)$/);
		if (mm) {
			const v = mm[1].trim();
			if (v) memoryModel = v;
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
			curMember = { name: nm[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		// Simple string member: "  - worker"
		const im = line.match(/^\s*-\s+(\S+)$/);
		if (im) {
			curMember = { name: im[1].trim() };
			teams[cur].push(curMember);
			continue;
		}
		// Member property: "    model: foo"  (indented under a named member)
		const pm = line.match(/^\s{2,}(\w+):\s*(.+)$/);
		if (pm && curMember) {
			if (pm[1].trim() === "model") curMember.model = pm[2].trim();
			continue;
		}
	}
	const out: ParsedTeams = { teams };
	if (memoryModel) out.memoryModel = memoryModel;
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
			systemPrompt: m[2].trim(),
			file: fp,
		};
	} catch { return null; }
}

/** Collect extension paths (excluding agent-team and disabled extensions) for -e flags */
export function scanExtensionPaths(cwd: string): string[] {
	const dirs = [
		join(cwd, ".pi", "extensions"),
		join(getAgentDir(), "extensions"),
	];
	const disabled = loadDisabledExtensions();
	const paths: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const f of readdirSync(dir, { withFileTypes: true })) {
				if (f.isDirectory()) {
					const idx = join(dir, f.name, "index.ts");
					if (existsSync(idx) && !isDisabled(idx, disabled)) paths.push(idx);
				} else if (f.isFile() && f.name.endsWith(".ts")) {
					const p = join(dir, f.name);
					if (!isDisabled(p, disabled)) paths.push(p);
				}
			}
		} catch { }
	}
	// Also load absolute-path extensions from settings.json (e.g. observability)
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (existsSync(settingsPath)) {
			const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
			for (const ext of (raw.extensions || [])) {
				if (typeof ext !== "string") continue;
				if (ext.startsWith("-")) continue; // disabled
				const resolved = ext.startsWith("/") ? ext : join(getAgentDir(), ext);
				if (existsSync(resolved) && !paths.includes(resolved)) paths.push(resolved);
			}
		}
	} catch { }
	return paths.filter(p => !p.includes("agent-team"));
}

/** Load disabled extensions from settings.json */
export function loadDisabledExtensions(): Set<string> {
	const disabled = new Set<string>();
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return disabled;
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const exts: string[] = raw.extensions || [];
		for (const e of exts) {
			if (typeof e === "string" && e.startsWith("-")) {
				disabled.add(e.slice(1));
			}
		}
	} catch { }
	return disabled;
}

/** Check if an extension path is disabled. Match is by basename so that
 *  patterns like "foo/index.ts" do not also match "myfoo/index.ts". */
export function isDisabled(extPath: string, disabled: Set<string>): boolean {
	const base = extPath.split(/[/\\]/).pop() || extPath;
	for (const pattern of disabled) {
		// Normalise pattern: if it has no separator, treat it as a basename
		// match. Otherwise require the full path to end with the pattern.
		if (!pattern.includes("/") && !pattern.includes("\\")) {
			if (base === pattern) return true;
		} else if (extPath.endsWith(pattern)) {
			return true;
		}
	}
	return false;
}

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
			if (fm) out.push({ name: fm.name, description: fm.description });
			else out.push({ name: f.name, description: "" });
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

export const CONFIG_FILE = "agent-team-config.json";

export function loadPersistedConfig(): Partial<TeamConfig> {
	const p = join(getAgentDir(), CONFIG_FILE);
	if (!existsSync(p)) return {};
	try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

export function savePersistedConfig(cfg: TeamConfig) {
	writeFileSync(join(getAgentDir(), CONFIG_FILE), JSON.stringify(cfg, null, 2));
}
