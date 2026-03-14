# Mono-Pi Extension

## 1. Overview

This is a comprehensive collection of pi extensions that provide specialized subagent definitions, workflow prompts, and tools for AI-assisted software development. It includes pre-configured agents for code review, testing, documentation, security auditing, refactoring, and task planning, along with a flexible agent management system.

The project solves the problem of quickly delegating specialized development tasks to focused subagents without manually creating and configuring each agent from scratch. It provides a complete toolkit for code quality workflows including implementation planning, code review, security auditing, and documentation generation.

## 2. API Reference

### Subagent Tool

The `subagent` tool enables delegating tasks to specialized agents with isolated context windows.

**Tool Registration:**
```typescript
pi.registerTool({
  name: "subagent",
  label: "Subagent",
  description: [...],
  parameters: SubagentParams,
  async execute(_toolCallId, params, signal, onUpdate, ctx) { ... },
  renderCall(args, theme) { ... },
  renderResult(result, { expanded }, theme) { ... }
});
```

#### execute() Parameters

```typescript
interface SubagentParams {
  // Single mode: invoke one agent with one task
  agent?: string;
  task?: string;
  cwd?: string;

  // Parallel mode: invoke multiple agents concurrently
  tasks?: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;

  // Chain mode: sequential execution with {previous} placeholder
  chain?: Array<{
    agent: string;
    task: string;
    cwd?: string;
  }>;

  // Agent discovery scope
  agentScope?: "user" | "project" | "both";  // Default: "user"
  confirmProjectAgents?: boolean;  // Default: true
}
```

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `agent` | `string \| undefined` | - | Agent name (single mode only) |
| `task` | `string \| undefined` | - | Task to delegate (single mode only) |
| `cwd` | `string \| undefined` | `ctx.cwd` | Working directory for agent process |
| `tasks` | `TaskItem[] \| undefined` | - | Array of parallel tasks |
| `chain` | `ChainItem[] \| undefined` | - | Array of sequential steps |
| `agentScope` | `"user" \| "project" \| "both"` | `"user"` | Which agent directories to load |
| `confirmProjectAgents` | `boolean \| undefined` | `true` | Prompt before running project-local agents |

**Returns:**
```typescript
interface AgentToolResult<SubagentDetails> {
  content: Array<{ type: "text", text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}
```

**Example Usage:**
```typescript
// Single agent invocation
await pi.callTool("subagent", {
  agent: "reviewer",
  task: "Review the auth module for security issues"
});

// Parallel execution
await pi.callTool("subagent", {
  tasks: [
    { agent: "scout", task: "Find all API endpoints" },
    { agent: "scout", task: "Find all database queries" }
  ]
});

// Chain workflow
await pi.callTool("subagent", {
  chain: [
    { agent: "scout", task: "Find all authentication code" },
    { agent: "planner", task: "Design improvements for {previous}" },
    { agent: "worker", task: "Implement {previous}" }
  ]
});
```

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

### Single Agent Delegation

Invoke a specialized agent to handle a specific task:

```typescript
// Find authentication code
await pi.callTool("subagent", {
  agent: "scout",
  task: "Find all authentication code"
});

// Review code quality
await pi.callTool("subagent", {
  agent: "reviewer",
  task: "Review src/auth.ts for bugs and security issues"
});

// Generate tests
await pi.callTool("subagent", {
  agent: "testcase",
  task: "Generate tests for src/auth.ts"
});
```

### Parallel Execution

Run multiple independent agents concurrently:

```typescript
// Multiple scouts for different concerns
await pi.callTool("subagent", {
  tasks: [
    { agent: "scout", task: "Find all API endpoints" },
    { agent: "scout", task: "Find all database queries" },
    { agent: "scout", task: "Find all error handling code" }
  ]
});
```

### Sequential Chain Workflow

Chain agents with `{previous}` placeholder for sequential dependency:

```typescript
await pi.callTool("subagent", {
  chain: [
    { agent: "scout", task: "Find all model definitions" },
    { agent: "planner", task: "Create a refactoring plan for {previous}" },
    { agent: "reviewer", task: "Review the plan for {previous}" },
    { agent: "worker", task: "Implement the approved plan: {previous}" }
  ]
});
```

### Using Workflow Prompts

Pre-configured workflows that orchestrate multiple agents:

```typescript
// Full implementation workflow (scout → planner → worker)
await pi.callTool("subagent", {
  agent: "implement",
  task: "Add Redis caching to the session store"
});

// Scout and plan without implementation
await pi.callTool("subagent", {
  agent: "scout-and-plan",
  task: "Refactor authentication to support OAuth"
});

// Implement with review (worker → reviewer → worker)
await pi.callTool("subagent", {
  agent: "implement-and-review",
  task: "Add input validation to API endpoints"
});
```

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

# List running agents
/agent monitor
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

## 5. Error Handling

### Subagent Execution Errors

The subagent tool returns detailed error information in the result:

```typescript
interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;  // "error", "aborted", "end"
  errorMessage?: string;
  step?: number;
}
```

**Error Conditions:**

| Exit Code | Stop Reason | Error Condition |
|-----------|-------------|-----------------|
| `!= 0` | `undefined` | Non-zero exit from subprocess |
| `0` | `"error"` | LLM model error |
| `0` | `"aborted"` | User pressed Ctrl+C |
| `-1` | `undefined` | Still running (parallel mode) |

### Chain Execution Errors

Chain mode stops at the first failing step:

```typescript
if (isError) {
  const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages);
  return {
    content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${errorMsg}` }],
    isError: true
  };
}
```

**Handling Chain Errors:**
- The chain stops immediately at the failing step
- All previous steps' outputs are included in the error response
- Check `isError` flag to determine if execution succeeded

### Project Agent Confirmation

When running project-local agents with `agentScope: "both"` or `"project"`:

```typescript
const confirmProjectAgents = params.confirmProjectAgents ?? true;

if (confirmProjectAgents && projectAgentsRequested.length > 0) {
  const ok = await ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled.`
  );
  if (!ok) return canceled response;
}
```

**Security:** Project agents contain repo-controlled prompts that can read files and execute commands. Only enable for trusted repositories.

### Agent Not Found

```typescript
if (!agent) {
  const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
  return {
    content: [{ type: "text", text: `Unknown agent: "${agentName}". Available: ${available}` }],
    isError: true
  };
}
```

**Handling:** Always verify agent exists before invocation or check the error message for available agents.

### Parallel Execution Limits

```typescript
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

if (params.tasks.length > MAX_PARALLEL_TASKS) {
  return {
    content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
    isError: true
  };
}
```

**Limit:** Maximum 8 parallel tasks, with 4 running concurrently.

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
