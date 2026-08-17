# Mono Pi Extension - Multi-Agent System

## Overview
Primary reasoning agent orchestrates a multi-agent team to perform complex software development tasks with delegation to specialized subagents.

## How Agent Extension Works

The Agent Team extension (`agent/extensions/agent-team/`) is a TypeScript plugin for `pi-coding-agent` that implements a **subagent orchestrator** pattern. Here's how it works:

### Highlight
- Use free models for subagents for fetching data
- Use frontier model for orchestration and coder 
- This helps to save tons of token on low hanging tasks

### Architecture

- **index.ts** - Entry point: registers lifecycle hooks (`before_agent_start`, `agent_end`, `session_start`, `session_end`), tool registration, slash commands, and keyboard shortcuts
- **orchestration.ts** - Process manager: spawns/fresh `pi --mode rpc` processes per task, readiness probing, dispatch lifecycle, RPC event handling, 10-min pong timeout
- **config.ts** - Agent definition parsing (YAML frontmatter from `.md` files), team YAML loading, skill discovery, extension path scanning, config persistence
- **core.ts** - Type definitions (`AgentDef`, `AgentProc`, `TeamMember`, `TerminalBackend`), terminal backends (tmux/herdr), session logging, RPC subprocess spawner
- **memory.ts** - Per-turn background memory summarizer: captures input/output, spawns a summarizer subprocess, maintains `.pi_memory/project_memory.md`
- **ui.ts** - TUI widget + sidebar overlay: agent status grid, anim dots, tool counts, token usage display; the sidebar (opens via `Ctrl+Q`) shows the agent status grid, a snapshot of all available skills, and the team list, closing with Esc/Ctrl+Q
- **integrations.ts** - Tool registration (`dispatch_agent`), slash commands (`/agents-team`, `/agents-list`, `/agents-grid`, `/agents-team-toggle`, `/agents-parallel`), keyboard shortcuts (`Ctrl+Q` sidebar toggle, `Ctrl+Shift+E` agent team on/off, `Ctrl+Shift+M` abort the running memory summarizer)

### Lifecycle

1. **Session start** - Load agent definitions only (NO spawning) (`.md` files from `agent/agents/`, `.pi/agents/`, `.claude/agents/`), parse `teams.yaml`, initialize process registry, create combined session log pane
2. **Before agent start** - Override system prompt: inject agent catalog (available agents + their descriptions), project memory content (if enabled), AGENTS.md rules, and enabled skills
3. **Dispatch** - Tool call `dispatch_agent(agent, task)` triggers a fresh `pi --mode rpc` subprocess spawn, readiness probe (get_state), task injection via JSON stdin, streaming RPC event handling (response, message_update, message_end, tool_execution, agent_end), 10-min activity timeout, session log recording — or `dispatch_agent(agent, tasks: [...])` to fan out the same agent across many tasks in isolated subprocesses.
4. **Agent end** - Cleanup: kill subprocess (SIGTERM + 2s SIGKILL backstop), wipe session files, log done box with elapsed time/tool count. If memory feature enabled: trigger background summarization of the turn
5. **Session end** - Cleanup any residual subprocesses: persist config, await memory idle, kill leftover processes, close session log, kill terminal pane

### Team System

Teams are defined in `agent/agents/teams.yaml`. Each team is a named group of agents with optional model overrides:

```yaml
memory_model:
  model: opencode/mimo-v2.5-free
  active: true

subagent_team:
  - name: file_reader
    model: opencode/deepseek-v4-flash-free
  - name: searcher
    model: opencode/deepseek-v4-flash-free
  - name: coder
  - name: tester
    model: opencode/deepseek-v4-flash-free
  - name: documenter
    model: opencode/deepseek-v4-flash-free
    active: false
  - name: doc_generator
    model: opencode/deepseek-v4-flash-free
    active: false
  - name: image_analyzer
    model: opencode/mimo-v2.5-free
    active: false
  - name: harsh_critic
    model: opencode/deepseek-v4-flash-free

test_subagent_team:
  - name: coder
  - name: documenter
  - name: file_reader
  - name: searcher
  - name: tester
  - name: image_analyzer
  - name: doc_generator
```

- Agents without a `model` key inherit the current orchestrator model
- Agents can carry `active: true|false` - inactive agents are not dispatched
- Team model overrides (`teamModel`) take highest precedence
- Teams can be switched at runtime via `/agents-team` command

### Memory Feature (Background Summarization)

When `memory_model` is configured with `active: true` in `teams.yaml`, the extension captures every turn's user input + assistant output and spawns a summarizer subprocess that updates `.pi_memory/project_memory.md`. The `memory_model.active` key is a persistent on/off switch (`active: true` required to run; toggled from the sidebar). Merely setting `model` does NOT enable memory — `active: true` must be present. The memory file is reinjected into the orchestrator's system prompt on subsequent turns. Sections maintained: Design Decisions, Facts, User Taste, User Suggestions.

### RPC Subprocess Model

Each subagent runs in its own `pi --mode rpc` process:

```
pi --mode rpc -p --no-extensions \
  --extension <ext-path> ... \
  --provider <provider> \
  --model <model> \
  --tools <agent-tools> \
  --system-prompt <prompt-file> \
  --session <session-file>
```

- Communication is line-delimited JSON over stdin/stdout
- Events: `response`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `agent_end`
- Subprocesses are ephemeral: spawned per task, killed after completion

## Usage Guide

### Core Workflow Commands

- `task <action> <description>` - Create and manage tasks with status tracking
- `dispatch_agent(agent, task)` / `dispatch_agent(agent, tasks: [...])` - Send work to a specialized subagent; pass `tasks` (array of strings) to spawn the same agent once per task (isolated clones, parallel for read-only agents, serialized for writable ones)
- `execute <command>` - Run shell commands and test verification

### Dispatch Lifecycle

Each `dispatch_agent` call follows a strict lifecycle:

1. **Spawn** - A fresh `pi --mode rpc` process is spawned for the target agent
2. **Ready probe** - `get_state` probe sent 500ms after spawn; agent must respond within 15s
3. **Task injection** - Task prompt is written as JSON to stdin
4. **Execution** - Agent works autonomously, streaming text and tool events back via RPC
5. **Activity timeout** - If no RPC event for 10 minutes, the process is force-killed
6. **Cleanup** - On completion/error, process is killed (SIGTERM + 2s SIGKILL backstop), session files wiped

**Key properties:**
- Subagents are **stateless** - each dispatch spawns a fresh process, no context carries over
- All context must be included in every dispatch prompt
- Session files (`~/.pi/agent-team-log/agent-sessions/`) are cleaned after each dispatch
- Combined session log (`~/.pi/agent-team-log/`) tracks all activity chronologically

### Multi-Task Dispatch (same agent)

- Pass `tasks` (array of strings) instead of `task` to spawn the same agent once per item; each runs in its own isolated `pi --mode rpc` clone
- **Read-only agents** (e.g. `file_reader`, `searcher`) run in **parallel**, capped by `maxParallel` in agent config or `/agents-parallel` — falls back to sequential when the global switch is off
- **`/agents-parallel` is a GLOBAL switch**: `off` also forces the orchestrator to serialize its own parallel read-only host tool calls (`read`/`grep`/`find`/`ls`) within a turn, not just subagent dispatch. Writes/edits are always serialized regardless.
- **Writable agents** (e.g. `coder`, `documenter`, `doc_generator`) are **always serialized** (one at a time) so file writes never collide
- **ESC/abort** kills all spawned clones (and the per-turn memory summarizer) ; results are aggregated and returned in a single response

### Subagent System

**Primary Subagents:**
- **file_reader** (tools: read, grep, find, ls) - Scan codebases, find files, return minimal excerpts with line numbers
- **searcher** (tools: read, grep, web-fetch, context7-search, context7-query) - Research external docs, fetch web content, verify library usage
- **coder** (tools: bash, read, grep, find, ls, write, edit, browser) - Implement code changes, apply edits, return unified diffs
- **tester** (tools: bash, read, grep, find, ls, browser) - Execute commands, run tests, verify results with pass/fail evidence
- **documenter** (tools: read, grep, find, ls, write, edit) - Update documentation, write README files, maintain changelogs
- **doc_generator** (tools: bash, read, write, edit) - Create structured documents (`.xlsx`, `.pdf`, `.docx`, `.pptx`, `.html`, `.csv`, `.json`)
- **image_analyzer** (tools: bash, read) - Analyze, describe, extract text from, and classify images
- **harsh_critic** (tools: read, grep, find, ls) - Gatekeeper review subagent; critiques Worker deliverables, returns `VERDICT: APPROVED`/`REJECTED`

### Agent Definition Format

Agents are defined by `.md` files with YAML frontmatter:

```markdown
---
name: agent_name
description: What this agent does
tools: read,write,edit,grep,find,ls
model: provider/model-id   # optional - defaults to orchestrator model
thinking: on/off            # optional
---

Agent system prompt in markdown body...
```

### Slash Commands

- `/agents-team` - Select and activate a different team
- `/agents-list` - List agents with process status and run counts
- `/agents-grid <1-6>` - Set UI grid columns for agent status widgets
- `/agents-team-toggle on|off|status` - Enable/disable the agent team
- `/agents-parallel [on|off|status] [max N]` - Toggle global parallelism (subagent dispatch + read-only host tool calls)
- `Ctrl+Q` - Toggle the sidebar overlay (agent status grid, skills snapshot, team list)
- `Ctrl+Shift+E` - Toggle agent team on/off

### Example Workflow

1. **Planning:** Use task system to break down requirements
2. **Research:** Dispatch searcher for external API docs, file_reader for code context
3. **Implementation:** Dispatch coder with specific edits and acceptance criteria
4. **Critique:** Dispatch `harsh_critic` as the gatekeeper BEFORE testing — loop revise→critique→revise until `VERDICT: APPROVED`
5. **Verification:** Dispatch tester with exact commands to validate passing/failing
6. **Documentation:** Dispatch documenter to update project docs
7. **Reporting:** Dispatch doc_generator for structured output (`.xlsx`, `.pdf`, `.html`)

### Error Handling & Escalation Protocol

Subagents reply with structured signals. Route them appropriately:

- `AMBIGUOUS: <question>` - Answer it yourself if you can; otherwise ask the user
- `NOT FOUND` - Treat as ground truth; widen search or change approach
- `BLOCKED: <reason>` - Resolve the blocker before re-dispatching

**Retry limit:** Max 2 retry cycles for failures. After 2, surface the failure with evidence.

**Harsh Critic Gate:** After ANY Worker subagent (coder, documenter, doc_generator, …) produces a deliverable, the orchestrator dispatches `harsh_critic` with the original task, the Worker's output, and any prior critique. It loops revise→critique→revise until the critic returns `VERDICT: APPROVED` before the output is shown or shipped. The gate runs **before** tester verification — only APPROVED deliverables are tested. Never override a `REJECTED` verdict without addressing every listed issue; rejected issues are handed back to the Worker verbatim (respecting the 2-retry cap).

## Key Rules & Best Practices

- ONE agent at a time - wait for full response before dispatching next
- Subagents are stateless - include all context in each dispatch prompt
- Always check acceptance criteria before proceeding
- Skip `.venv`, `.pi`, `node_modules`, `__pycache__`, `.git` directories
- Use `grep` over `cat` for file searches, limit reads to specific line ranges
- Never generate file content as inline tokens - use doc_generator for all file outputs
- Delegate only context-heavy work (large files, web, command execution). Never delegate reasoning, planning, or decisions
- If a subagent output looks confused, dispatch a new session with a sharper prompt - do not try to steer the broken one

## Getting Started

1. Install project dependencies
2. Set up virtual environment with `uv`
3. Use task system to plan your work
4. Dispatch appropriate subagents based on needs
5. Verify all changes before finalization

## Project Structure

- `/agent/` - Agent definitions, skills, extensions, and team configuration
- `/agent/agents/` - Agent `.md` definition files, `teams.yaml` team definitions
- `/agent/extensions/agent-team/` - Agent team extension implementation (orchestrator)
- `/agent/extensions/` - Extension modules (agent-team, browser, context7, custom-footer, herdr-agent-state, kilo, modelcost, pi-scope, TokenRouter, web-fetch, web_fetch_crawl4ai)
- `/agent/skills/` - Skill definitions (flet, pyside6, electron-scaffold, improve-codebase-architecture)
- `/.pi/` - Project configuration
- `~/.pi/agent-team-log/agent-sessions/` - Subagent session files (JSON/RPC state), cleaned after each dispatch; files older than 24 hours are purged
- `~/.pi/agent-team-log/` - Combined session log files (chronological activity)
- `/.pi_memory/` - Project memory file (per-turn background summarization)

## Web Fetch (Crawl4AI) extension — standalone setup

`agent/extensions/web_fetch_crawl4ai/index.ts` (+ `web-fetch_crawl4ai.py`) fetches pages with a
single Chromium instance running multiple tabs via Crawl4AI's `AsyncWebCrawler.arun_many`.
The Python runner stays alive between tool calls (idle-timeout, default 5 min), so the
Python/Chromium startup cost is paid once per session instead of once per fetch.
It is fully self-contained in its own folder: all Python dependencies live in
`agent/extensions/web_fetch_crawl4ai/.venv` (no global `crwl` needed).

```bash
agent/extensions/web_fetch_crawl4ai/setup-web-fetch.sh   # creates .venv, pip installs requirements.txt, downloads Chromium
```

The Python interpreter is resolved at runtime as: `WEB_FETCH_PY_BIN` env → package `.venv/bin/python3`
→ `crwl` shebang → `/home/alexa/wk/.venv/bin/python3`. Chromium is located via
`PLAYWRIGHT_BROWSERS_PATH` (set in the environment; `playwright install chromium` reuses it).

Tuning knobs (env): `WEB_FETCH_CACHE_DIR`, `WEB_FETCH_CACHE_TTL_MS` (1h), `WEB_FETCH_CRAWL_TIMEOUT_MS` (60s,
per batch), `WEB_FETCH_CONCURRENCY` (4 tabs), `WEB_FETCH_MAX_CHARS` (4000, per-page text cap),
`WEB_FETCH_IDLE_MS` (300000; 0 disables the warm runner), `WEB_FETCH_PAGE_DELAY_S` (2, per-page settle
delay — lower for faster but less thorough renders), `WEB_FETCH_SCAN_FULL_PAGE` (1; 0 skips full-page scrolling).

## Quick Reference

- **Problem decomposition** → Dispatch file_reader/searcher for context
- **Code changes** → Dispatch coder with specific edits and acceptance criteria
- **Critique** → Dispatch harsh_critic as gatekeeper before testing (loop until `VERDICT: APPROVED`)
- **Testing** → Dispatch tester with exact commands to verify
- **Documentation** → Dispatch documenter with update requirements
- **Report generation** → Dispatch doc_generator with output format
- **Image analysis** → Dispatch image_analyzer for visual content extraction
- **Team selection** → `/agents-team` command
- **Toggle agent team** → `Ctrl+Shift+E` or `/agents-team-toggle`
- **Abort memory summarizer** → `Ctrl+Shift+M` (ESC only aborts streaming/bash; the memory summarizer runs in the idle gap between turns, so it gets its own key)
- **Sidebar** → `Ctrl+Q` (Esc closes it)

See `agent/AGENTS.md` for detailed subagent rules and interfaces.
See `agent/extensions/agent-team/` for the full extension source code (TypeScript).
See `agent/agents/teams.yaml` for team configuration.
