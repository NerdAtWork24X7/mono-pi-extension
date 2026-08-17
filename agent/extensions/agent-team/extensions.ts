/**
 * Extension discovery + subagent CLI-arg building.
 *
 * Everything related to "which extensions does a spawned pi subprocess get"
 * lives here: scanning for extension entry points, honouring settings.json
 * disable-lists, detecting the Pi Scope observability extension, and
 * building the actual --extension/-o-name CLI flags that memory.ts and
 * orchestration.ts pass to spawned subprocesses.
 *
 * This was previously split across core.ts (hasPiScopeExtension), config.ts
 * (scanExtensionPaths/loadDisabledExtensions/isDisabled), and duplicated
 * inline in both memory.ts and orchestration.ts (identical arg-building).
 * Consolidating it here means:
 *   - the extension-disable check happens once instead of being re-derived
 *     from settings.json twice per scan (loadDisabledExtensions used to
 *     re-read+re-parse the same file that scanExtensionPaths also read)
 *   - the Pi Scope check is memoized per extPaths array instead of being
 *     re-scanned on every single subagent dispatch (extPaths is a stable,
 *     session-lifetime array — see index.ts loadAgents — so recomputing a
 *     regex scan over it on every dispatch was pure waste)
 *   - the CLI-arg fragments are built in one place instead of two files
 *     drifting out of sync with each other
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

// ── Disabled-extension matching ─────────────────────────────────────────

interface DisabledPatterns {
  /** Bare basename patterns (no path separator) — O(1) membership check. */
  basenames: Set<string>;
  /** Patterns containing a path separator — matched by suffix, checked
   *  only when the (rarer) basename check misses. */
  suffixes: string[];
}

const EMPTY_DISABLED: DisabledPatterns = { basenames: new Set(), suffixes: [] };

/** Read settings.json once. Returns null if missing/unreadable so callers
 *  can short-circuit without re-checking existsSync separately. */
function readSettingsJson(): Record<string, unknown> | null {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return null;
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Load disabled-extension patterns from settings.json's `extensions` list
 *  (entries prefixed with `-`). */
export function loadDisabledExtensions(settings?: Record<string, unknown> | null): Set<string> {
  const raw = settings === undefined ? readSettingsJson() : settings;
  const disabled = new Set<string>();
  const exts = (raw?.extensions as unknown[]) || [];
  for (const e of exts) {
    if (typeof e === "string" && e.startsWith("-")) disabled.add(e.slice(1));
  }
  return disabled;
}

function compilePatterns(disabled: Set<string>): DisabledPatterns {
  if (disabled.size === 0) return EMPTY_DISABLED;
  const basenames = new Set<string>();
  const suffixes: string[] = [];
  for (const pattern of disabled) {
    if (pattern.includes("/") || pattern.includes("\\")) suffixes.push(pattern);
    else basenames.add(pattern);
  }
  return { basenames, suffixes };
}

/** Check if an extension path is disabled. Match is by basename so that
 *  patterns like "foo/index.ts" do not also match "myfoo/index.ts". */
export function isDisabled(extPath: string, disabled: Set<string> | DisabledPatterns): boolean {
  const patterns = disabled instanceof Set ? compilePatterns(disabled) : disabled;
  const base = extPath.split(/[/\\]/).pop() || extPath;
  if (patterns.basenames.has(base)) return true;
  for (const pattern of patterns.suffixes) {
    if (extPath.endsWith(pattern)) return true;
  }
  return false;
}

// ── Extension path scanning ─────────────────────────────────────────────

/** Collect extension paths (excluding agent-team and disabled extensions)
 *  for -e flags. Reads settings.json exactly once — both the disable-list
 *  and the absolute-path extension list are derived from that single read. */
export function scanExtensionPaths(cwd: string): string[] {
  const dirs = [
    join(cwd, ".pi", "extensions"),
    join(getAgentDir(), "extensions"),
  ];
  const settings = readSettingsJson();
  const patterns = compilePatterns(loadDisabledExtensions(settings));

  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) {
          const idx = join(dir, f.name, "index.ts");
          if (existsSync(idx) && !isDisabled(idx, patterns)) add(idx);
        } else if (f.isFile() && f.name.endsWith(".ts")) {
          const p = join(dir, f.name);
          if (!isDisabled(p, patterns)) add(p);
        }
      }
    } catch { /* unreadable extensions dir — skip */ }
  }

  // Also load absolute-path extensions from settings.json (e.g. observability)
  const extEntries = (settings?.extensions as unknown[]) || [];
  for (const ext of extEntries) {
    if (typeof ext !== "string" || ext.startsWith("-")) continue; // not a string, or disabled
    const resolved = ext.startsWith("/") ? ext : join(getAgentDir(), ext);
    if (existsSync(resolved)) add(resolved);
  }

  return paths.filter(p => !p.includes("agent-team"));
}

// ── Pi Scope detection (memoized) ───────────────────────────────────────

/** `extPaths` is a stable, session-lifetime array (assigned once in
 *  index.ts#loadAgents and shared by reference via a closure into
 *  MemoryManager/ProcessManager). A WeakMap lets us cache the boolean per
 *  array *instance* without holding a strong reference to it — if a future
 *  session reload ever produces a new array, the old cache entry is
 *  collected instead of accumulating forever. */
const piScopeCache = new WeakMap<string[], boolean>();

function computeHasPiScopeExtension(extPaths: string[]): boolean {
  return extPaths.some((p) => {
    const normalized = p.replace(/\\/g, "/");
    const base = normalized.split("/").pop()?.replace(/\.((ts|js))$/i, "") ?? "";
    return base === "pi-scope" || /(^|\/)pi-scope\//.test(normalized);
  });
}

/** Returns true if the Pi Scope observability extension is present in the
 *  list of extension entry-point paths. Used to decide whether it is safe
 *  to pass Pi-Scope-specific CLI flags (e.g. --o-name) to spawned pi
 *  subprocesses. Memoized per extPaths array reference so repeated
 *  per-dispatch calls (one per subagent spawn) don't re-scan the same
 *  session-lifetime array every time. */
export function hasPiScopeExtension(extPaths: string[]): boolean {
  const cached = piScopeCache.get(extPaths);
  if (cached !== undefined) return cached;
  const result = computeHasPiScopeExtension(extPaths);
  piScopeCache.set(extPaths, result);
  return result;
}

// ── Shared subprocess CLI-arg builders ──────────────────────────────────

/** `--no-extensions` plus one `--extension <path>` pair per entry. Shared
 *  by memory.ts and orchestration.ts so the two subprocess spawn paths
 *  can't drift out of sync. */
export function buildExtensionCliArgs(extPaths: string[]): string[] {
  return ["--no-extensions", ...extPaths.flatMap(p => ["--extension", p])];
}

/** `--o-name <name>` iff the Pi Scope extension is loaded, else []. */
export function buildScopeNameArgs(extPaths: string[], name: string): string[] {
  return hasPiScopeExtension(extPaths) ? ["--o-name", name] : [];
}
