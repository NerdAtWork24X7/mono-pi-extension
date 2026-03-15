# Mono-Pi Extension

## 1. Overview

This is a comprehensive collection of pi extensions that provide specialized subagent definitions, workflow prompts, and tools for AI-assisted software development. It includes pre-configured agents for code review, testing, documentation, security auditing, refactoring, and task planning, along with a flexible agent management system.

The project solves the problem of quickly delegating specialized development tasks to focused subagents without manually creating and configuring each agent from scratch. It provides a complete toolkit for code quality workflows including implementation planning, code review, security auditing, and documentation generation.

## 2. API Reference

### Subagent Tool

The `subagent` tool enables delegating tasks to specialized agents with isolated context windows.

### Agent Manager Extension

The agent manager provides a CLI interface for managing agent definitions.

**Command:** `/agent [command] [args]`

**Subcommands:**
- `/agent` - Open interactive menu
- `/agent new` - Create a new agent
- `/agent edit <name>` - Edit an agent's system prompt
- `/agent show <name>` - Show an agent's definition
- `/agent delete <name>` - Delete an agent
- `/agent monitor` - Show running subagents

**Agent File Format:**
```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash
model: openrouter/hunter-alpha
---

System prompt for the agent goes here.
```

**Locations:**
- User agents: `~/.pi/agent/agents/*.md`
- Project agents: `.pi/agents/*.md` (with `agentScope: "both"` or `"project"`)

## 3. Usage

### Managing Agents

Create and manage agent definitions:

```bash
# Open agent manager
/agent

# Create a new agent
/agent new

# Edit an existing agent
/agent edit reviewer

# Show agent definition
/agent show worker

# Delete an agent
/agent delete my-agent

```

### Agent-Specific Commands

Each agent defines a command that can be invoked directly:

```typescript
// Commit message generator
/commit Fix memory leak in session handler

// PR description generator
/pr Generate PR description for this branch

// Test case generator
/testcase Generate tests for src/database.ts

// Code explanation
/explain How does the caching logic work?
```

## 4. Configuration

### settings.json

The main configuration file for the pi agent system.

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/hunter-alpha",
  "enabledModels": [
    "zai/glm-4.7-flash",
    "zai/glm-4.7",
    "openrouter/arcee-ai/trinity-mini:free",
    "openrouter/arcee-ai/trinity-large-preview:free",
    "openrouter/openai/gpt-oss-20b:free",
    "openrouter/hunter-alpha"
  ],
  "defaultThinkingLevel": "low",
  "theme": "cyberpunk",
  "whimsical": {
    "enabled": true,
    "weights": {
      "A": 10,
      "B": 10,
      "C": 10,
      "D": 10,
      "E": 30,
      "F": 15,
      "G": 15
    }
  },
  "images": {
    "blockImages": false
  }
}
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"openrouter"` | Default AI provider |
| `defaultModel` | `string` | `"openrouter/hunter-alpha"` | Default model to use |
| `enabledModels` | `string[]` | `[]` | List of enabled models |
| `defaultThinkingLevel` | `"low" \| "medium" \| "high"` | `"low"` | Default thinking depth |
| `theme` | `string` | `"cyberpunk"` | TUI theme name |
| `whimsical.enabled` | `boolean` | `true` | Enable whimsical responses |
| `whimsical.weights` | `object` | `{...}` | Response weighting |
| `images.blockImages` | `boolean` | `false` | Block image generation |

### Agent Configuration per Agent

Each agent can override the default model and tools:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash
model: openrouter/arcee-ai/trinity-large-preview:free
---

System prompt...
```

**Tool Presets:**

| Preset | Tools | Description |
|--------|-------|-------------|
| `(default - all tools)` | `read, bash, grep, find, ls, write, edit` | Full capabilities |
| `read-only` | `read, grep, find, ls` | Read-only access |
| `read+bash` | `read, grep, find, ls, bash` | Read with shell access |

## 6. Available Agents

### Development Workflow Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `worker` | General-purpose | Sonnet | (all default) |

### Quality Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `testcase` | Test generation | Sonnet | read, grep, find, ls, write, context7-search, context7-query |
| `document` | Documentation | Sonnet | read, grep, find, ls, write |
| `explain` | Code explanation | Trinity Mini | read, grep, find, ls, write |

### Code Quality Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `commit` | Conventional commit messages | Hunter Alpha | bash, read, grep, find, ls, write |
| `pr` | Pull request descriptions | Sonnet | read, grep, find, ls, write |
| `optimize` | Performance optimization | Sonnet | read, grep, find, ls, write |
| `refactor` | Code refactoring | Sonnet | read, grep, find, ls, write |
| `security` | Security audit | Sonnet | read, grep, find, ls, write |

### Fix Agent

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `fix` | Bug fixes | Sonnet | read, grep, find, ls, write |

### Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |
| `/fix <query>` | Fix bug with minimal changes |

## 7. Architecture

### Agent Discovery

Agents are discovered from two locations:

1. **User-level** (`~/.pi/agent/agents/*.md`) - Always loaded
2. **Project-level** (`.pi/agents/*.md`) - Only with `agentScope: "project"` or `"both"`

Project agents override user agents with the same name when `agentScope: "both"`.

### Agent Execution Model

Each subagent runs in a separate `pi` subprocess with:
- Isolated context window
- Custom system prompt
- Custom model selection
- Custom tool configuration

### Output Streaming

All agent modes support streaming:
- **Single mode**: Shows tool calls and final output
- **Parallel mode**: Shows progress (done/running) with live updates
- **Chain mode**: Shows each step with `{previous}` injection

### Output Modes

- **Collapsed view** (default): Status icon, last 10 items, usage stats
- **Expanded view** (Ctrl+O): Full task text, all tool calls, Markdown output
- **Parallel streaming**: Live status updates for all tasks

## 8. Best Practices

1. **Choose the right agent**: Each agent has a specific focus - match your task to the appropriate agent
2. **Use chains for complex workflows**: Sequential agents work better together than parallel for dependent tasks
3. **Scope agents appropriately**: Use `agentScope: "project"` for repo-specific agents, `"both"` for user + project agents
4. **Confirm project agents**: Only run project-local agents in trusted repositories
5. **Review agent outputs**: Always expand and review agent outputs before applying changes
6. **Use workflow prompts**: Built-in workflows like `/implement` orchestrate multiple agents correctly
7. **Check error details**: Look at stderr and stopReason for detailed error information
8. **Monitor resource usage**: Watch token usage and cost, especially with long chains
