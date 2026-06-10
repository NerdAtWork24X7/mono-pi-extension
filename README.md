# Mono Pi Extension

A collection of extensions and agent configurations for the pi-coding-agent system, enabling collaborative agent teams with ephemeral subagent orchestration.

## Requirements

- **Runtime**: Node.js (compatible with pi-coding-agent)
- **tmux**: Required for agent session management and combined logging
- **pi-coding-agent**: Base agent system (`npm install -g @mariozechner/pi-coding-agent`)

## Architecture

- **Ephemeral Subagent System**: Each task spawns a fresh `pi --mode rpc` process with no context accumulation between dispatches
- **Agent Teams**: Configurable teams of specialized agents (file_reader, searcher, coder, tester, documenter)
- **Extension System**: Modular extensions for web fetching, documentation search, UI customization, and agent state management
- **Tmux Integration**: Each agent runs in dedicated tmux panes with combined session logging
- **Model Flexibility**: Support for multiple AI providers (OpenRouter, Xiaomi, NVIDIA, Kilo, local models)

## Project structure

```
mono-pi-extension/
├── agent/
│   ├── agents/              # Agent definition files
│   │   ├── teams.yaml       # Team configurations
│   │   ├── coder.md         # Applies code changes, returns diffs
│   │   ├── documenter.md    # README/API/changelog updates
│   │   ├── file_reader.md   # Large repo/doc scanning, returns paths + minimal excerpts
│   │   ├── searcher.md      # Web/docs lookups, returns sourced findings
│   │   ├── tester.md        # Runs commands, returns pass/fail + evidence
│   │   └── main_agent.md    # Static orchestrator reference (overridden at runtime)
│   ├── extensions/          # Extension modules
│   │   ├── agent-team.ts    # Main agent team orchestrator
│   │   ├── context7.ts      # Documentation search tool
│   │   ├── web-fetch.ts     # Web page fetching
│   │   ├── web-fetch_crawl4ai.ts  # Crawl4AI web fetching
│   │   ├── kilo.ts          # Kilo AI provider integration
│   │   ├── custom-footer.ts # Custom UI footer
│   │   └── herdr-agent-state.ts   # Herdr agent state reporting
│   ├── models.json          # Model provider configurations
│   ├── agent-team-config.json     # Active team and grid settings
│   ├── settings.json        # Global settings and enabled extensions
│   └── themes/
│       └── cyberpunk.json   # Cyberpunk theme configuration
├── .pi/
│   ├── agent-sessions/      # Runtime session data (auto-created)
│   └── agent-logs/          # Session logs (auto-created)
└── README.md
```

## Install

```bash
# Clone the repository
git clone <repository-url>
cd mono-pi-extension

# Copy agent directory to your project
cp -r agent/ /path/to/your/project/.pi/agents/
```

## Configure

### Team Configuration

Edit `agent/agents/teams.yaml` to define your teams:

```yaml
# Simple format
team_name:
  - agent_name

# With model override
team_name:
  - name: agent_name
    model: provider/model-name
```

### Model Configuration

Edit `agent/models.json` to configure AI providers:

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "model-name",
          "reasoning": true,
          "contextWindow": 262144,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

### Settings

Edit `agent/settings.json` to configure:

```json
{
  "defaultProvider": "opencode",
  "defaultModel": "deepseek-v4-flash-free",
  "defaultThinkingLevel": "off",
  "extensions": [
    "+extensions/agent-team.ts",
    "+extensions/custom-footer.ts"
  ],
  "enabledModels": [
    "opencode/deepseek-v4-flash-free",
    "xiaomi/mimo-v2.5-pro"
  ]
}
```

## Run

### Development

1. Start tmux session:
```bash
tmux
```

2. Launch pi coding agent:
```bash
pi
```

3. Enable agent team mode:
```bash
/agents-team-toggle on
```

4. Select a team:
```bash
/agents-team
```

### Production

The agent team extension is designed to run within the pi-coding-agent environment. No separate build process is required.

## Usage

### Available Commands

| Command | Description |
|---------|-------------|
| `/agents-team` | Select an agent team |
| `/agents-list` | List agents and their status |
| `/agents-grid <1-6>` | Set grid display columns |
| `/agents-team-toggle on\|off\|status` | Enable/disable agent teams |
| `/agents-restart` | Kill running subagent processes |

### Agent Types

#### Coder
- **Role**: Applies code changes, returns diffs
- **Tools**: bash, read, grep, find, ls, write, edit
- **Description**: Full executor — reads files, applies edits, reports diffs. No planning or review.

#### Documenter
- **Role**: README/API/changelog updates
- **Tools**: read, grep, find, ls, write, edit
- **Description**: Matches project voice, verifies signatures from source, updates cross-references.

#### File Reader
- **Role**: Large repo/doc scanning, returns paths + minimal excerpts
- **Tools**: read, grep, find, ls, write, edit
- **Description**: Precision scanner — uses grep/glob, skips generated/vendor files, returns excerpted findings.

#### Searcher
- **Role**: Web/docs lookups, returns sourced findings
- **Tools**: read, grep, web-fetch, context7-search, context7-query, write, edit
- **Description**: Primary-source preference, date-sensitive queries, multi-source verification for load-bearing claims.

#### Tester
- **Role**: Runs commands, returns pass/fail + evidence
- **Tools**: bash, read, grep, find, ls, write
- **Description**: Runs specified commands, captures stdout/stderr/exit code, stops at first hard failure unless run-all.

### Team Configurations

Default teams in `teams.yaml`:

- **subagent_team**: file_reader (opencode/deepseek-v4-flash-free), searcher (opencode/deepseek-v4-flash-free), coder (xiaomi/mimo-v2.5-pro), tester (opencode/deepseek-v4-flash-free), documenter (opencode/deepseek-v4-flash-free)
- **test_subagent_team**: coder, documenter, file_reader, searcher, tester

### Extensions

#### agent-team.ts
Main orchestrator for ephemeral subagent management. Handles team activation, process spawning, and result collection.

#### context7.ts
Documentation search tool for querying external documentation via Context7 API.

#### web-fetch.ts
Web page fetching with HTML-to-text conversion. Basic implementation for simple content extraction.

#### web-fetch_crawl4ai.ts
Advanced web fetching using Crawl4AI for better content extraction with markdown output.

#### kilo.ts
Kilo AI provider integration for accessing 300+ models via the Kilo Gateway.

#### custom-footer.ts
Custom UI footer displaying token usage, cost, context window, and other session metrics.

#### herdr-agent-state.ts
Herdr agent state reporting for integration with the Herdr terminal multiplexer.

## Common Operations

### Dispatch an Agent Task

```bash
# From within pi coding agent with agent team enabled
dispatch_agent(agent="file_reader", task="Analyze the project structure and identify key files")
```

### Monitor Agent Activity

```bash
# Check agent status
/agents-list

# Monitor session logs
tail -f .pi/agent-logs/session-*.log
```

### Customize Agent Behavior

Edit agent definition files in `agent/agents/`:

```markdown
---
name: custom-agent
description: Custom agent description
tools: read,write,grep,find,ls
model: provider/model-name
thinking: off
---

# WHO YOU ARE
You are a custom agent with specific capabilities.

# STRICT RULES
- Your specific rules and constraints
- Tools you can and cannot use
- Output format requirements
```

## Known Issues / Gotchas

- **tmux Required**: Agent team functionality requires tmux for session management. Without tmux, extensions will fail to create log panes.
- **Process Cleanup**: Each dispatch spawns a fresh process. If processes aren't properly killed, they may accumulate. Use `/agents-restart` to clean up.
- **Context Isolation**: No context carries over between dispatches. Include all necessary context in task descriptions.
- **Model Compatibility**: Not all models support the same features. Check model capabilities in `models.json` before assigning to agents.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tmux command not found` | tmux not installed | Install tmux (see Requirements) |
| Agent process stuck | Process not responding | Run `/agents-restart` to kill stuck processes |
| Agent team disabled | Agent team mode not enabled | Run `/agents-team-toggle on` |
| No agents loaded | Agent directory structure incorrect | Verify agent files exist in `agent/agents/` |
| Model errors | Invalid model configuration | Check `models.json` for correct provider/model IDs |
| Extension errors | Missing or disabled extensions | Check `settings.json` extensions array |

## Contributing

To extend the agent system:

1. Create new agent definition files in `agent/agents/`
2. Configure teams in `agent/agents/teams.yaml`
3. Add new extensions in `agent/extensions/`
4. Update `agent/settings.json` to enable new extensions
5. Test with existing teams before adding to production configurations