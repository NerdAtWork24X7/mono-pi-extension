# Mono Pi Extension

> Turn one coding agent into a self-organizing **team**. A frontier-model orchestrator delegates well-scoped work to specialized subagents that run on **low-cost / free models**, behind a **built-in quality gate** and **persistent project memory**.

Mono Pi Extension is a subagent-orchestrator plugin for [`pi-coding-agent`](https://kilo.ai) (the Kilo/PI coding agent). Instead of one model doing everything in a single context, the orchestrator plans the work and hands each piece to a focused specialist running in its own isolated process.

---

## Why Mono Pi is different

Most "multi-agent" setups on the internet do one of two things: (a) run every agent on the **same expensive model**, or (b) just paste role instructions into one shared context. Mono Pi is built differently, on purpose:

| # | What makes it different | What that means in practice |
|---|--------------------------|-----------------------------|
| 1 | **Cost-aware routing is the default, not an add-on** | Grunt work — file search, web research, testing, docs — runs on cheap/free models (e.g. `deepseek-v4-flash-free`, `mimo-v2.5`). The frontier model is reserved for orchestration and coding. You save tokens on the 80% of work that doesn't need a frontier model. |
| 2 | **Real OS-process isolation** | Each subagent is a fresh `pi --mode rpc` subprocess with a constrained tool allowlist and its own system prompt, talking over line-delimited JSON. No shared context, no cross-contamination, with a 10-minute activity timeout and guaranteed `SIGTERM`+`SIGKILL` cleanup. |
| 3 | **A structural quality gate** | `harsh_critic` reviews every worker deliverable and loops *revise → critique → revise* until `VERDICT: APPROVED` — **before** anything is tested or shipped. Quality control is built into the workflow, not left to chance. |
| 4 | **Persistent project memory** | A background summarizer distills each turn into per-category files under `.pi_memory/` (Folder Structure, Architecture, Design Decisions, Facts, User Taste & Preferences, User Suggestions, Failures & Solutions); the orchestrator's system prompt points to those files every turn so it can read accumulated context when relevant. The agent "remembers" across sessions without bloating the live context. |
| 5 | **Runtime team switching + parallel fan-out** | Define teams in YAML, switch them live with `/agents-team`, and fan one agent across many tasks — read-only agents run in parallel, writable ones serialize automatically. |
| 6 | **Batteries included** | Web fetching via Obscura (Rust headless browser — fast startup, low memory) and Crawl4AI (persistent Chromium), Context7 docs lookup, token routing / cost tracking, browser automation, code-scope, and more — all shipped as extensions. |
| 7 | **It's an extension, not a new runtime** | It layers on top of `pi-coding-agent`. You keep the agent's existing tools, shortcuts, and UX, and gain orchestration. |

---

## Advantages of using Mono Pi

- **Lower cost.** Frontier-model tokens are spent only where they matter. Cheap/free models absorb the repetitive context-heavy work.
- **Higher quality.** The `harsh_critic` gate catches bad deliverables before they reach tests or the user.
- **Cleaner context.** Subagents are stateless and isolated, so the orchestrator's context stays small and focused; memory is compressed, not hoarded.
- **Resilient.** A stuck or crashed subagent can't take down the session — it's killed, logged, and replaced.
- **Flexible.** Per-agent model overrides, on/off toggles, runtime team swaps, and a global parallelism switch adapt to any task.
- **Multi-provider.** Works across OpenRouter, Cloudflare Workers AI, NVIDIA, Cline, and local model servers via `agent/models.json`.
- **AI-agent friendly.** The repo ships an [`llms.txt`](llms.txt) and a structured layout so other AI agents can fetch and understand it in one pass (see [For AI agents](#for-ai-agents)).

---

## How it works (in one minute)

1. **Session start** — The extension loads agent definitions (`agent/agents/*.md`) and teams (`agent/agents/teams.yaml`). Nothing is spawned yet.
2. **Plan** — The orchestrator (frontier model) breaks the request into tasks.
3. **Delegate** — For each task it calls `dispatch_agent(agent, task)`. A fresh `pi --mode rpc` subprocess boots for that specialist, runs with only its allowed tools, and streams results back.
4. **Gate** — Worker output goes to `harsh_critic`. It loops until `VERDICT: APPROVED`.
5. **Verify** — Approved work is handed to `tester` with exact commands; pass/fail evidence is captured.
6. **Remember** — Each turn is summarized into project memory for the next session.

Subagents are **stateless**: every dispatch is a brand-new process, so all needed context must be in the prompt. Session files are wiped after each dispatch.

---

## Quick start

Mono Pi is enabled as a `pi-coding-agent` extension. The relevant switches live in `agent/settings.json`:

```jsonc
"extensions": [
  "+extensions/agent-team/index.ts",   // the orchestrator
  "+extensions/obscura/index.ts",      // web fetch via Obscura headless browser
  "+extensions/browser.ts"
  // ...
]
```

1. **Enable the extension** — make sure `+extensions/agent-team/index.ts` and `+extensions/obscura/index.ts` are present in `agent/settings.json` → `extensions`. The Obscura web-fetch tool needs its headless-browser binary; see [Obscura web-fetch (binary setup)](#obscura-web-fetch-binary-setup).
2. **Define your team** — edit `agent/agents/teams.yaml`. Assign cheap/free models to grunt agents and leave `coder` / orchestration on the frontier model:

   ```yaml
   subagent_team:
     - name: file_reader
       model: opencode/deepseek-v4-flash-free
     - name: searcher
       model: opencode/deepseek-v4-flash-free
     - name: coder          # inherits the frontier orchestrator model
     - name: tester
       model: opencode/deepseek-v4-flash-free
     - name: harsh_critic
       model: opencode/deepseek-v4-flash-free
   ```
3. **Define subagents** — each lives in `agent/agents/<name>.md` with a YAML frontmatter (name, description, tools, optional model) and a system prompt body.
4. **Use it** — start `pi-coding-agent` and drive the team with slash commands (below).

> Models shown are examples. The free/frontier models available to you are listed in `agent/settings.json` → `enabledModels` and `agent/models.json`.

---

## Obscura web-fetch (binary setup)

The web-fetch tool uses **Obscura**, a Rust-based headless browser (V8 JavaScript, ~85 ms startup, ~30 MB memory) that renders JS-heavy pages with better stealth than Chromium. The Obscura executables (`obscura`, `obscura-worker`) are **git-ignored** because they exceed GitHub's 100 MB file limit, so the compressed tarballs (`obscura.tar.gz`, `obscura-worker.tar.gz`) are committed in their place.

After cloning, extract the binaries once:

```bash
agent/extensions/obscura/setup.sh
```

This unpacks the tarballs next to `agent/extensions/obscura/index.ts` and makes the binaries executable. Re-run with `--force` to re-extract. To use a system-installed Obscura instead, set `OBSCURA_BIN` to its path.

---

## Subagents at a glance

| Agent | Tools | Role |
|-------|-------|------|
| `file_reader` | read, grep, find, ls | Scan codebases, return minimal excerpts with line numbers |
| `searcher` | read, grep, web-fetch, context7-search, context7-query | Research docs, fetch web content, verify library usage |
| `coder` | bash, read, grep, find, ls, write, edit, browser | Implement changes, return unified diffs |
| `tester` | bash, read, grep, find, ls, browser | Run commands/tests, report pass/fail with evidence |
| `documenter` | read, grep, find, ls, write, edit | Update docs, READMEs, changelogs |
| `doc_generator` | bash, read, write, edit | Produce `.xlsx/.pdf/.docx/.pptx/.html/.csv/.json` |
| `image_analyzer` | bash, read | Describe, extract text from, and classify images |
| `harsh_critic` | read, grep, find, ls | Gatekeeper — returns `VERDICT: APPROVED` / `REJECTED` |

Add your own by dropping a `.md` file into `agent/agents/` with the same frontmatter format.

---

## Commands & shortcuts

| Command / Key | Action |
|---------------|--------|
| `/agents-team` | Select and activate a different team |
| `/agents-list` | List agents with process status and run counts |
| `/agents-grid <1-6>` | Set UI grid columns for the agent status widgets |
| `/agents-team-toggle on|off|status` | Enable/disable the agent team |
| `/agents-parallel [on|off|status] [max N]` | Toggle global parallelism (subagent dispatch + read-only host tool calls) |
| `dispatch_agent(agent, task)` | Send one task to a specialist |
| `dispatch_agent(agent, tasks: [...])` | Fan the same agent across many tasks (parallel for read-only, serialized for writable) |
| `Ctrl+Q` | Toggle the sidebar (agent grid, skills snapshot, team list) |
| `Ctrl+Shift+E` | Toggle the agent team on/off |
| `Ctrl+Shift+M` | Abort the running memory summarizer |

---

## Quality gate (harsh_critic)

After **any** worker subagent (coder, documenter, doc_generator, …) produces a deliverable, the orchestrator dispatches `harsh_critic` with the original task, the worker's output, and any prior critique. It loops *revise → critique → revise* until `VERDICT: APPROVED` — and **only then** is the work tested or shown. A `REJECTED` verdict is never overridden without fixing every listed issue (respecting a 2-retry cap).

## Persistent memory

When `memory_model.active: true` in `teams.yaml`, each turn's input + output is summarized into per-category files under `.pi_memory/`. On every turn, the orchestrator's system prompt includes a **Project Memory** section that points to that directory, so it knows where accumulated context lives and can read the relevant category file (via `read`) when folder structure, architecture, prior decisions, facts, or user preferences are relevant. Categories maintained: **Folder Structure, Architecture, Design Decisions, Facts, User Taste & Preferences, User Suggestions, Failures & Solutions**. Merely setting `model` does **not** enable memory — `active: true` is required.

---

## Project structure

```
agent/
  AGENTS.md                # Operating rules for the orchestrator + subagents
  settings.json            # pi-coding-agent config (extensions, models, theme)
  models.json              # Model providers and model IDs
  agents/
    teams.yaml             # Team definitions + per-agent model overrides
    *.md                   # Per-subagent definitions (frontmatter + prompt)
  extensions/
    agent-team/            # Core orchestrator extension (TypeScript source)
    obscura/              # Web-fetch via Obscura headless browser (setup.sh extracts binaries)
    web_fetch_crawl4ai/    # Persistent-Chromium web fetch (setup-web-fetch.sh)
    browser.ts, context7.ts, modelcost.ts, pi-scope.ts, TokenRouter.ts, ...
  skills/                  # Reusable skills (flet, pyside6, electron-scaffold, ...)
.pi/                      # Project configuration
.pi_memory/               # Generated project-memory summaries
```

See `agent/extensions/agent-team/` for the full orchestrator source, and `agent/AGENTS.md` for the subagent contract.

---

## For AI agents

This repository is designed to be **fetched and understood by other AI agents in a single pass**:

- **[`llms.txt`](llms.txt)** — the canonical entry point. It lists this README, `agent/AGENTS.md`, `teams.yaml`, the per-agent definitions, the orchestrator source, and `models.json`, each with a one-line description and a relative link.
- **Structured layout** — every subagent is a self-describing `.md` file; teams and models are declarative YAML/JSON; the orchestrator is isolated under `agent/extensions/agent-team/`.
- **Stable pointers** — when ingesting this repo, start from `llms.txt` (or this README), then read `agent/AGENTS.md` for operating rules.

---

## Where to look next

- `agent/AGENTS.md` — subagent rules and interfaces
- `agent/agents/teams.yaml` — team and model configuration
- `agent/extensions/agent-team/` — orchestrator source (TypeScript)
- `agent/agents/*.md` — individual subagent definitions
