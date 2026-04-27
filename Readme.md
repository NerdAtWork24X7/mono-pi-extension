# Mono-Pi Extension

A collection of pi agent definitions, extensions, teams, and configuration that turns pi into a multi-agent development environment. Drop it into `~/.pi/agent/` and get 11 specialist agents, 11 pre-built teams, 7 extensions, and a cyberpunk theme out of the box.

## Installation

Clone or copy this repository into your pi agent directory:

```bash
git clone <repo-url> ~/.pi/agent
```

After installation, your directory structure should look like:

```
~/.pi/agent/
  agents/          # 11 agent .md files + teams.yaml
  extensions/      # 7 extensions (agent-team, pi-rules, custom-footer, etc.)
  models.json      # custom model providers (kilo, xiaomi)
  settings.json    # default config, enabled models, packages
  themes/          # cyberpunk.json
  skills/          # electron-scaffold
  rules/           # system prompt rules (injected by pi-rules)
```

## Quick Start

1. Start pi: `pi`
2. The cyberpunk theme loads automatically
3. The `agent-team` extension activates on session start, selects the first team (scout), and locks the primary agent to dispatcher mode
4. Use `/agents-team` to switch teams, then dispatch work via the `dispatch_agent` tool

To use an agent directly (without the team orchestrator), run pi with the agent flag:

```bash
pi --agent scout "explore the src/ directory"
pi --agent fix "fix the login timeout bug"
pi --agent documenter "write a README for this project"
```

## Commands

All registered slash commands from the extensions in this repo:

| Command | Extension | Description |
|---------|-----------|-------------|
| `/agents-team` | agent-team | Open team selector. Switches which team of agents is active. |
| `/agents-list` | agent-team | List all loaded agents with status, session state, and run count. |
| `/agents-grid <1-6>` | agent-team | Set the number of columns in the agent dashboard widget. |
| `/whimsy` | whimsical | Open the chaos mixer: adjust message bucket weights and spinner preset interactively. |
| `/whimsy on` | whimsical | Enable whimsical loading messages. |
| `/whimsy off` | whimsical | Disable whimsical loading messages. |
| `/whimsy status` | whimsical | Show current weights, spinner preset, and enabled state. |
| `/whimsy reset` | whimsical | Reset to default weights and spinner. |
| `/exit` | whimsical | Exit pi with a weighted goodbye message. |
| `/bye` | whimsical | Alias for `/exit`. |

## Agents

11 agent definitions included in `agents/`:

| Agent | Role | Tools | Model | Thinking |
|-------|------|-------|-------|----------|
| `scout` | Confidence-gated codebase exploration. Scores readiness across 5 dimensions, produces a context map. Read-only. | read, grep, find, ls, web_search, fetch_content | default | high |
| `planner` | Read-only analysis and planning. Reads files, answers questions, reasons about strategy. | read, grep, find, ls, web_search, fetch_content | default | none |
| `builder` | Implements code from a plan. Reads files, makes changes, verifies. | read, write, edit, bash, web_search, fetch_content | default | none |
| `reviewer` | Spec-aware code review. Reads git diff, produces structured findings. Read-only. | read, grep, bash, web_search, fetch_content | default | high |
| `fix` | Minimal bug fixes. Finds root cause, writes the smallest fix. | read, write, edit, bash | default | low |
| `documenter` | README and documentation generation. Matches existing doc style. | read, write, edit, grep, find, ls, web_search, fetch_content | xiaomi/mimo-v2.5 | none |
| `browser` | Web automation via playwright-cli. Navigates, interacts, screenshots, extracts data. | read, bash, web_search, fetch_content | default | none |
| `greenfield-web` | Scaffolds Astro + Vue + Tailwind projects. Handles init, directory structure, layouts. | read, grep, find, ls, bash, write, web_search, fetch_content | default | none |
| `conventions-analyst` | Reverse-engineers codebase patterns into a conventions reference. Read-only. | read, grep, find, ls, web_search, fetch_content | default | none |
| `ui-designer` | UI/UX design intelligence. Generates design systems across 13 tech stacks. | read, grep, find, ls, bash, write, web_search, fetch_content | default | none |
| `wcag-auditor` | WCAG 2.1 accessibility auditing. Reviews code against all 78 success criteria. | read, grep, find, ls, bash, write, web_search, fetch_content | default | none |

All agents use the default model unless listed otherwise. "default" means whichever model is set in `settings.json` (currently `kilo/zai-coding/glm-5.1`).

## Teams

Teams are defined in `agents/teams.yaml`. The `agent-team` extension loads teams at session start and lets you switch between them. Only team members are available for dispatch.

| Team | Members (local .md files only) |
|------|-------------------------------|
| `scout` | scout |
| `fix` | fix |
| `build` | scout, planner, builder |
| `plan` | scout, planner, documenter |
| `plan-build` | scout, conventions-analyst, planner, greenfield-web, ui-designer, builder, reviewer, wcag-auditor |
| `info` | scout, browser, documenter, reviewer |
| `next` | scout, browser |
| `ads` | scout |
| `brand` | scout, browser, documenter |
| `full` | scout, conventions-analyst, planner, builder, reviewer, documenter, browser |
| `business` | scout, browser |

**Note:** Teams in `teams.yaml` can reference agents not included in this repo (e.g., `negotiator`, `scheduler`, `ad-strategist`). Those agents work only if installed separately at `~/.pi/agent/agents/` or `.pi/agents/`. The table above shows only agents that ship with this repo.

## Extensions

### agent-team

Multi-agent orchestrator. On session start, it scans agent directories, loads `teams.yaml`, activates the first team, and replaces the primary agent's tools with `dispatch_agent` (plus `askUserQuestion`). The primary agent becomes a pure dispatcher that spawns pi subprocesses for each specialist.

Renders a live dashboard widget showing agent status (idle, running, done, error), elapsed time, and animated progress indicators.

Hooks: `session_start`, `before_agent_start` (injects dynamic system prompt with agent catalog).

### pi-rules

Scans `~/.pi/agent/rules/` for `.md` files and lists them in the system prompt so the agent can load specific rules on demand. Supports subdirectories for grouped rules.

Hooks: `session_start`, `before_agent_start`.

### custom-footer

Renders a status bar footer showing: active model, thinking level, token I/O counts, cost, context window percentage, elapsed time, working directory, git branch, and plan mode status.

Hooks: `session_start`, `session_switch`.

### web-fetch

Registers the `web-fetch` tool. Fetches a URL and extracts readable text by stripping HTML tags, scripts, and styles. Pass `raw: true` to get the full HTML response.

### web-search

Registers the `web-search` tool. Queries DuckDuckGo and returns up to 10 results with titles, URLs, and snippets. Default result count is 5.

### context7

Registers two tools:
- `context7-search`: Resolves a library name to a Context7 library ID
- `context7-query`: Queries documentation for a library using its Context7 ID

### whimsical

A chaos loader extension. Replaces standard loading messages with weighted, humorous alternatives from 7 buckets:

| Bucket | Name | Examples |
|--------|------|---------|
| A | Absurd Nerd Lines | "Grepping the void for meaning..." |
| B | Boss Progression | Phase-based messages by wait duration |
| C | Fake Compiler Panic | "warning TS9999: vibes are not strongly typed" |
| D | Terminal Meme Lines | "sudo rm -rf stress" |
| E | Bollywood & Hinglish | Classic dialogues and desi dev humor |
| F | Pi Tips | Helpful tips for using pi |
| G | Whimsical Verbs | "Combobulating... Skedaddling..." |

Default weights: A=10, B=10, C=10, D=10, E=30, F=15, G=15 (Bollywood-heavy). Adjust via `/whimsy`. Includes 5 animated spinner presets (Sleek Orbit, Neon Pulse, Scanline, Chevron Flow, Matrix Glyph). Context-aware overrides apply for morning, late-night, and long-wait scenarios. Goodbye messages on `/exit` and `/bye` use the same weighted buckets.

Settings persist in `~/.pi/agent/settings.json` under the `whimsical` key.

## Configuration

### settings.json

```json
{
  "defaultProvider": "kilo",
  "defaultModel": "zai-coding/glm-5.1",
  "defaultThinkingLevel": "low",
  "theme": "cyberpunk",
  "quietStartup": true,
  "hideThinkingBlock": false,
  "doubleEscapeAction": "tree",
  "enabledModels": [
    "kilo/qwen/qwen3.6-plus",
    "kilo/zai-coding/glm-5.1",
    "kilo/nvidia/nemotron-3-super-120b-a12b:free",
    "xiaomi/mimo-v2.5-pro",
    "xiaomi/mimo-v2.5"
  ],
  "packages": [
    "npm:pi-vitals",
    "npm:pi-peon-ping",
    "npm:@aliou/pi-guardrails",
    "npm:pi-ask-user-question",
    "npm:pi-updater",
    "npm:pi-web-access",
    "npm:@marckrenn/pi-sub-bar"
  ],
  "skills": [".claude/skills", "~/.claude/skills"]
}
```

### Model Providers (models.json)

| Provider | Base URL | Models |
|----------|----------|--------|
| `kilo` | `https://api.kilo.ai/api/gateway` | zai-coding/glm-5.1, qwen/qwen3.6-plus, nvidia/nemotron-3-super-120b-a12b:free, google/gemma-4-26b-a4b-it:free |
| `xiaomi` | `https://token-plan-ams.xiaomimimo.com/v1` | mimo-v2.5-pro, mimo-v2.5 |

Both providers use OpenAI-compatible completions API.

### Theme

`themes/cyberpunk.json` provides a neon/electric/acid color scheme on a dark background. Key colors: neon magenta (`#ff00ff`), electric cyan (`#00ffff`), acid green (`#39ff14`), hot pink (`#ff3366`), amber (`#ffaa00`). Includes full syntax highlighting, diff colors, markdown rendering, and thinking-level indicators.

### NPM Packages

Loaded automatically via the `packages` array in `settings.json`:

| Package | Purpose |
|---------|---------|
| `pi-vitals` | System vitals monitoring |
| `pi-peon-ping` | Health check / ping utility |
| `@aliou/pi-guardrails` | Safety and guardrail enforcement |
| `pi-ask-user-question` | Interactive user question prompting |
| `pi-updater` | Self-update mechanism |
| `pi-web-access` | Web access utilities |
| `@marckrenn/pi-sub-bar` | Configurable status bar with provider awareness |

## Skills

### electron-scaffold

Located at `skills/electron-scaffold/`. A complete guide for scaffolding production-ready Electron applications with security hardening, Vite + TypeScript tooling, proper IPC patterns, auto-updates, native UI elements, and optimal build configuration. The skill directory contains `SKILL.md` (instructions), `references/` (pattern examples), and `scripts/scaffold.sh` (automated setup).
