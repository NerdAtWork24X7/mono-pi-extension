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
| 6 | **Batteries included** | Web fetching via Obscura (Rust headless browser — fast startup, low memory) and a persistent headless Chromium via Playwright, Context7 docs lookup, token routing / cost tracking, browser automation, code-scope, and more — all shipped as extensions. |
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
3. **Delegate** — It calls `dispatch_agents(tasks: [{agent, task}, ...])` — one entry per task. A fresh `pi --mode rpc` subprocess boots for each task, runs with only that specialist's allowed tools, and streams results back. Read-only tasks run in parallel when parallel dispatch is ON, and tasks are run one at a time when it is OFF or when any entry targets a writable (edit/write) agent.
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

## Shared page cache (parallel `web-fetch`)

Parallel dispatch runs every subagent as its own pi process, so two agents researching the same page used to crawl it twice — two browser sessions, twice the wall clock. The `web_fetch` extension now coordinates through `<project>/.pi/web-fetch-cache/`, which all agents share because they inherit the project root as their working directory:

- The **first agent to reach a URL** takes a lock, crawls it, and publishes the page text.
- **Every other agent asking for the same URL waits** for that page and reuses it instead of launching a second crawl. They report `Not re-crawled: served from the shared web-fetch cache` in the result.
- URLs are matched after canonicalization (fragment, `www.`, host case and tracking params such as `utm_*` / `gclid` collapsed), so the same page under four different link forms is crawled once. Raw-HTML and Markdown variants are cached separately.
- A page truncated at a smaller cap than a later caller needs is treated as a **miss**, so the caller re-crawls for full text rather than silently returning a short page.
- If the holder crashes or overruns the wait budget its lock is reclaimed (stale after 2 min); locks are always released on success, failure, and abort, and a waiter that gives up never overwrites a page a live holder is about to publish.
- Search-engine SERP pages are **never** cached — they are query-specific and volatile.

Nothing is cached to disk unless this extension runs. Tuning knobs (all env vars, milliseconds):

| Variable | Default | Meaning |
|----------|---------|---------|
| `WEB_FETCH_CACHE_TTL_MS` | `600000` (10 min) | How long a crawled page stays reusable. `0` disables caching and dedupe entirely. |
| `WEB_FETCH_CACHE_WAIT_MS` | `45000` | How long to wait on another agent's in-flight crawl before crawling the URL yourself. |
| `WEB_FETCH_CACHE_STALE_MS` | `120000` | Age at which a lock is assumed abandoned (holder killed). |
| `WEB_FETCH_CACHE_DIR` | `<project>/.pi/web-fetch-cache` | Cache location. |

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
| `/agents-parallel [on|off|status] [max N]` | Toggle global parallelism: ON → independent read-only tasks run in parallel (up to `max N`); OFF → every dispatch is serialized, in the order given |
| `/agents-debug <0\|1\|2\|status>` | Dispatch-pipeline debug level: 0 off, 1 lifecycle log to `~/.pi/agent-team-log/agent-sessions/agent-team-debug.log`, 2 + raw per-agent JSONL traces |
| `dispatch_agents(tasks: [{agent, task}, ...])` | Delegate tasks to specialists — one `{agent, task}` entry per task (a single task is a one-entry array). Read-only entries run in parallel when parallel dispatch is ON; any edit/write entry is always serialized |
| `Ctrl+Q` | Toggle the sidebar (agent grid, skills snapshot, team list) |
| `Ctrl+Shift+E` | Toggle the agent team on/off |
| `Ctrl+Shift+M` | Abort the running memory summarizer |
| `Alt+T` (hold) | Speech-to-text: record while the key is held; release to transcribe via Groq Whisper |
| `/listen` | Speech-to-text: start/stop a recording without holding `Alt+T` |
| `/stt` | Speech-to-text status / `on` / `off` / `lang <code\|auto>` / `model <id>` |

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
    web_fetch/             # Persistent-Chromium web fetch + search (Playwright)
    obscura/              # Web-fetch via Obscura headless browser (setup.sh extracts binaries)
    speech-to-text/        # Alt+T dictation via the Groq Whisper API
    browser.ts, context7.ts, modelcost.ts, pi-scope.ts, ...
    extensions.json        # Which extension runs for the orchestrator / subagents
  skills/                  # Reusable skills (flet, pyside6, electron-scaffold, ...)
.pi/                      # Project configuration
.pi_memory/               # Generated project-memory summaries
```

See `agent/extensions/agent-team/` for the full orchestrator source, and `agent/AGENTS.md` for the subagent contract.

---

## Extension settings (which extension runs where)

One manifest beside the extensions it configures — **`agent/extensions/extensions.json`** (a project that keeps its own extensions gets its own copy under `.pi/extensions/`):

```jsonc
{
  "custom-tools":   { "orchestrator": true, "subagent": true },
  "web_fetch":      { "orchestrator": true, "subagent": true },
  "browser":        { "orchestrator": true, "subagent": true },
  "speech-to-text": { "orchestrator": true, "subagent": false }
}
```

Keys are extension names — the directory name for a directory extension (`web_fetch`), the file stem for a single-file one (`browser`). Per entry:

- **`subagent: false`** — the extension is dropped from every spawned child (dispatch clones and the memory summarizer), so it costs nothing per dispatch.
- **`orchestrator: false`** — the extension's tools are removed from the orchestrator's active tool list (hidden from its prompt and allowlist). A tool stays available if another still-enabled extension provides the same name.
- An extension **omitted** from the manifest, a **missing file**, or **invalid JSON** all mean *enabled for both* — the safe default. `agent-team` itself is orchestrator-only by design and is never passed to children.

This file is only a yes/no gate — it never lists tool names. **What a subagent may call comes from its own `.md` frontmatter** (`tools: bash, custom_read, grep, ...`), which is passed to the child as its `--tools` allowlist. That same list also decides which tool-providing extensions the child needs, so enabling `web_fetch` here does not load it into a `file_reader` that can't call `web-fetch`:

The manifest is re-read live: the orchestrator re-applies its tool list within ~1.5 s of an edit, and subagents pick the change up on their next dispatch. Only the *module load* inside the running orchestrator process still needs `agent/settings.json` (`"extensions"`, applied at startup) — that list decides what the host loads at all.

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
