# Mono-Pi Extension

A multi-agent development environment for pi. Drop it into `~/.pi/agent/` and get 11 specialist agents, 11 pre-built teams, and 7 extensions ready to go.

## Installation

```bash
git clone <repo-url> ~/.pi/agent
```

Directory structure after install:
```
~/.pi/agent/
  agents/              # 11 agent .md files + teams.yaml
  extensions/          # 7 extensions (agent-team, pi-rules, custom-footer, etc.)
  models.json          # custom model providers (kilo, xiaomi)
  settings.json        # default config, enabled models, packages
  themes/              # cyberpunk.json
  skills/              # electron-scaffold
  rules/               # system prompt rules (injected by pi-rules)
  prompts/             # custom prompt templates
```

## Quick Start

1. Start pi: `pi`
2. The cyberpunk theme loads automatically
3. The `agent-team` extension activates on session start, selects the first team (`scout`), and locks the primary agent to dispatcher mode
4. Use `/agents-team` to switch teams, then dispatch work via the `dispatch_agent` tool
5. Agent session state (run counts, status) is persisted in `agent-sessions/`

To use an agent directly (without the team orchestrator):
```bash
pi --agent scout "explore the src/ directory"
pi --agent fix "fix the login timeout bug"
```

## Agent Teams

The core of this extension. Teams define groups of specialist agents that work together. The `agent-team` extension manages the orchestration.

### How It Works

1. On session start, the extension scans agent directories, loads `teams.yaml`, and activates the first team
2. The primary agent becomes a dispatcher - its tools are replaced with `dispatch_agent` (plus `askUserQuestion`)
3. Tasks are sent to subagents via RPC to persistent `pi --mode rpc` processes in tmux panes
4. Subagents accumulate context across dispatches - no respawn between tasks
5. Use `/agents-team` to switch teams, `/agents-list` to see status, `/agents-restart` to restart processes

### Teams

| Team | Purpose | Members |
|------|---------|---------|
| `scout` | Quick exploration | scout |
| `fix` | Bug fixes | fix |
| `build` | Code implementation | scout, planner, builder |
| `plan` | Analysis & planning | scout, planner, documenter |
| `plan-build` | Full development | scout, conventions-analyst, planner, greenfield-web, brownfield-planner, ui-designer, builder, reviewer, wcag-auditor |
| `info` | Information gathering | scout, browser, documenter, reviewer, negotiator, agent-builder, agent-researcher |
| `next` | Quick tasks | scout, browser, scheduler |
| `ads` | Ad operations | scout, negotiator, ad-strategist, sales-coach |
| `brand` | Brand management | scout, browser, negotiator, ad-strategist, brand-strategist, personal-brand-strategist, documenter, sales-coach, linkedin-coach, brand-psychologist, storybrand |
| `full` | Complete toolkit | scout, conventions-analyst, planner, builder, reviewer, documenter, scheduler, ad-strategist, negotiator, browser |
| `business` | Business operations | scout, browser, regulatory-specialist, brand-strategist, financial-modeler, distribution-strategist, trade-marketer, consumer-marketer |

**Note:** Some teams reference agents not included in this repo (e.g., `negotiator`, `scheduler`, `ad-strategist`, `brand-strategist`). Those work only if installed separately.

## Agents

11 specialist agents included in `agents/`:

| Agent | Role | Tools | Model | Thinking |
|-------|------|-------|-------|----------|
| `scout` | Codebase exploration. Scores readiness across 5 dimensions, produces context map. Read-only. | read, grep, find, ls, web_search, fetch_content | default | high |
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

All agents use the default model unless listed otherwise. "default" = whatever is set in `settings.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/agents-team` | Open team selector. Switches which team of agents is active. |
| `/agents-list` | List all loaded agents with status, session state, and run count. |
| `/agents-grid <1-6>` | Set the number of columns in the agent dashboard widget. |
| `/agents-team-toggle` | Enable or disable agent teams. |
| `/agents-restart` | Restart all subagent processes. |
| `/agents-autocompact` | Toggle auto-compact for subagents (on/off/status). |
| `/whimsy` | Open the chaos mixer: adjust message bucket weights and spinner preset. |
| `/whimsy on` | Enable whimsical loading messages. |
| `/whimsy off` | Disable whimsical loading messages. |
| `/whimsy status` | Show current weights, spinner preset, and enabled state. |
| `/whimsy reset` | Reset to default weights and spinner. |
| `/exit` | Exit pi with a weighted goodbye message. |
| `/bye` | Alias for `/exit`. |

## Extensions

### agent-team

Multi-agent orchestrator. On session start, it spawns ALL subagents as persistent `pi --mode rpc` processes in tmux panes. Tasks are dispatched via RPC prompt commands and results are streamed back as JSONL events. The same process is reused for every dispatch - no respawn between tasks.

**Features:**
- Persistent subagent processes (no respawn between tasks)
- Tmux pane visualization with live dashboard
- Auto-compact: automatically compacts subagent context when usage exceeds threshold
- Session state persistence (run counts, status)
- Team switching at runtime

**Hooks:** `session_start`, `before_agent_start` (injects dynamic system prompt with agent catalog)

### pi-rules

Scans `~/.pi/agent/rules/` for `.md` files and lists them in the system prompt so the agent can load specific rules on demand.

**Hooks:** `session_start`, `before_agent_start`

### custom-footer

Renders a status bar footer showing: active model, thinking level, token I/O counts, cost, context window percentage, elapsed time, working directory, git branch, and plan mode status.

**Hooks:** `session_start`, `session_switch`

### web-fetch

Registers the `web-fetch` tool. Fetches a URL and extracts readable content (Markdown via Crawl4AI). Pass `raw: true` to get the full HTML response.

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

Default weights: A=10, B=10, C=10, D=10, E=30, F=15, G=15 (Bollywood-heavy). Adjust via `/whimsy`. Includes 5 animated spinner presets. Context-aware overrides apply for morning, late-night, and long-wait scenarios.

## Configuration

### settings.json

```json
{
  "lastChangelogVersion": "0.72.1",
  "doubleEscapeAction": "tree",
  "quietStartup": true,
  "defaultProvider": "zai",
  "defaultModel": "glm-5.1",
  "defaultThinkingLevel": "low",
  "packages": [
    "npm:pi-vitals",
    "npm:pi-peon-ping",
    "npm:@aliou/pi-guardrails",
    "npm:pi-ask-user-question",
    "npm:pi-updater",
    "npm:pi-web-access",
    "npm:@marckrenn/pi-sub-bar"
  ],
  "theme": "cyberpunk",
  "enabledModels": [
    "openrouter/qwen/qwen3.6-plus",
    "zai/glm-5.1",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "xiaomi/mimo-v2.5-pro",
    "xiaomi/mimo-v2.5"
  ]
}
```

### Model Providers (models.json)

| Provider | Base URL | Models |
|----------|----------|--------|
| `kilo` | `https://api.kilo.ai/api/gateway` | qwen/qwen3.6-plus, nvidia/nemotron-3-super-120b-a12b:free, google/gemma-4-26b-a4b-it:free |
| `xiaomi` | `https://token-plan-ams.xiaomimimo.com/v1` | mimo-v2.5-pro, mimo-v2.5 |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | minimaxai/minimax-m2.7, deepseek-ai/deepseek-v4-pro |

All providers use OpenAI-compatible completions API.

### Theme

`themes/cyberpunk.json` - neon/electric/acid color scheme on dark background. Key colors: neon magenta (`#ff00ff`), electric cyan (`#00ffff`), acid green (`#39ff14`), hot pink (`#ff3366`), amber (`#ffaa00`).

### NPM Packages

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

Located at `skills/electron-scaffold/`. A complete guide for scaffolding production-ready Electron applications with security hardening, Vite + TypeScript tooling, proper IPC patterns, auto-updates, native UI elements, and optimal build configuration.