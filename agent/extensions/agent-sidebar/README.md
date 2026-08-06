# Agent Sidebar Extension

Right-side overlay panel for enabling/disabling subagents in the pi TUI.

## Usage

| Action | Command |
|--------|---------|
| Open/close sidebar | `/sidebar` |
| Open/close sidebar | `Ctrl+B` |

## Keyboard Controls (inside sidebar)

| Key | Action |
|-----|--------|
| `↑` / `k` | Navigate up |
| `↓` / `j` | Navigate down |
| `Space` / `Enter` | Toggle agent on/off |
| `a` | Enable all agents |
| `n` | Disable all agents |
| `e` | Enable only current team members |
| `t` | Pick a team (opens team picker) |
| `Esc` / `Ctrl+B` | Close sidebar |

## Agent Discovery

Agents are loaded from:
- `~/.pi/agent/agents/*.md` — user-level agent definitions
- `~/.pi/agent/agents/teams.yaml` — team definitions with model overrides

## State Persistence

Enabled/disabled agent state is saved to:
```
~/.pi/agent/agent-sidebar-config.json
```

This persists across sessions. The config stores:
- `enabledAgents` — array of enabled agent names
- `activeTeam` — the currently selected team

## Installation

This extension is auto-discovered from `~/.pi/agent/extensions/agent-sidebar/index.ts`.
No additional setup needed — just restart pi or use `/reload`.
