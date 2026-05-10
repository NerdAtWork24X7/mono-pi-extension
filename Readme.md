# Agent Team Extension for Pi Coding Agent

A powerful extension that enables collaborative agent teams with ephemeral subagent orchestration. Each task spawns a fresh process, ensuring clean context and isolated work environments.

## Prerequisites

### System Requirements
- **tmux** - Required for agent session management and combined logging
- **Node.js** - Version compatible with pi-coding-agent
- **pi-coding-agent** - Base agent system

### Install tmux

#### Ubuntu/Debian
```bash
sudo apt update
sudo apt install tmux
```

#### macOS
```bash
brew install tmux
```

#### Windows (WSL2)
```bash
# Install tmux in WSL2
sudo apt update
sudo apt install tmux
```

#### Verify Installation
```bash
tmux -V
```

## Installation

### 1. Install Pi Coding Agent
```bash
# Install globally
npm install -g @mariozechner/pi-coding-agent

# Or install locally
npm install @mariozechner/pi-coding-agent
```

### 2. Setup Agent Directory Structure
Create the following directory structure in your project:

```
your-project/
├── .pi/
│   ├── agents/
│   │   ├── planner.md
│   │   ├── worker.md
│   │   ├── scout.md
│   │   └── reviewer.md
│   ├── agent-sessions/ (auto-created)
│   └── agent-logs/ (auto-created)
├── agents/
│   ├── planner.md
│   ├── worker.md
│   ├── scout.md
│   └── reviewer.md
└── .pi/agents/
    ├── teams.yaml
    └── extensions/
        └── agent-team.ts
```

### 3. Configure Agent Teams
Create `.pi/agents/teams.yaml`:

```yaml
# Define agent teams
planning-team:
  - planner
  - scout

development-team:
  - worker
  - planner

review-team:
  - reviewer
  - scout

full-team:
  - planner
  - worker
  - scout
  - reviewer
```

### 4. Enable Agent Team Extension
The agent-team extension is automatically included with pi-coding-agent. No additional installation required.

## Usage

### Starting with Agent Teams

1. **Launch Pi Coding Agent**
   ```bash
   pi
   ```

2. **Enable Agent Team Mode**
   ```bash
   /agents-team-toggle on
   ```

3. **Select a Team**
   ```bash
   /agents-team
   ```

4. **List Available Agents**
   ```bash
   /agents-list
   ```

### Available Commands

| Command | Description |
|---------|-------------|
| `/agents-team` | Select an agent team |
| `/agents-list` | List agents and their status |
| `/agents-grid <1-6>` | Set grid display columns |
| `/agents-team-toggle on|off|status` | Enable/disable agent teams |
| `/agents-restart` | Kill running subagent processes |

### Agent Types and Their Roles

#### Planner Agent
- **Role**: Creates implementation plans from context and requirements
- **Tools**: bash, read, grep, find, ls, write
- **Output**: Implementation plans in `tmp/plan.md`

#### Worker Agent
- **Role**: General-purpose execution agent with full capabilities
- **Tools**: All available tools including web search and documentation queries
- **Output**: Direct task execution and file modifications

#### Scout Agent
- **Role**: Fast codebase reconnaissance and context gathering
- **Tools**: read, grep, find, ls, bash, write
- **Output**: Compressed context in `tmp/scout_findings.md`

#### Reviewer Agent
- **Role**: Code review and quality assurance
- **Tools**: Code analysis tools
- **Output**: Review reports and suggestions

### Dispatching Tasks

Use the `dispatch_agent` tool to send tasks to specific agents:

```bash
dispatch_agent
  agent: "planner"
  task: "Create a plan for implementing user authentication system"
```

Example workflows:

#### Planning Phase
```bash
dispatch_agent
  agent: "planner"
  task: "Analyze the current codebase and create implementation plan for adding REST API endpoints"
```

#### Development Phase
```bash
dispatch_agent
  agent: "worker"
  task: "Implement user authentication endpoints following the plan in tmp/plan.md"
```

#### Review Phase
```bash
dispatch_agent
  agent: "reviewer"
  task: "Review the newly implemented authentication code for security issues"
```

#### Scouting Phase
```bash
dispatch_agent
  agent: "scout"
  task: "Search for existing configuration files and dependencies in the project"
```

## Agent Session Management

### Tmux Integration
- Each agent runs in a dedicated tmux pane
- Combined session logs are displayed in a shared tmux pane
- Logs are automatically saved to `.pi/agent-logs/`

### Session Lifecycle
1. **Session Start**: Load agent definitions, no spawning
2. **Dispatch**: Spawn fresh process → send task → await result → kill
3. **Session End**: Cleanup residual processes

### Log Files
- **Individual Agent Logs**: `.pi/agent-logs/scout.log`, `.pi/agent-logs/planner.log`, etc.
- **Combined Session Log**: `.pi/agent-logs/session-YYYY-MM-DDTHH-MM-SS.log`
- **Agent Findings**: `tmp/scout_findings.md`, `tmp/plan.md`

## Agent Configuration

### Creating Custom Agents

Create agent files in `.pi/agents/` or `agents/` directories:

```markdown
---
name: custom-agent
description: Your custom agent description
tools: read,write,grep,find,ls
model: google/gemini-2.5-flash
thinking: off
---

# WHO YOU ARE
You are a custom agent with specific capabilities.

# STRICT RULES - NEVER BREAK THESE
- Your specific rules and constraints
- Tools you can and cannot use
- Output format requirements
```

### Tools Configuration
Each agent specifies available tools:
- **Basic**: read, write, grep, find, ls, bash
- **Advanced**: web-search, web-fetch, context7-search, context7-query
- **Custom**: Define tool combinations per agent

## Best Practices

### 1. Agent Selection
- Use **planner** for analysis and planning
- Use **worker** for implementation tasks
- Use **scout** for codebase exploration
- Use **reviewer** for quality assurance

### 2. Task Description
- Include all necessary context in task descriptions
- Each dispatch is isolated - no context carries over
- Be specific about requirements and constraints

### 3. Team Composition
- **Planning Team**: Planner + Scout
- **Development Team**: Worker + Planner
- **Full Team**: All agents for comprehensive projects

### 4. Session Management
- Use `/agents-restart` to clear stuck processes
- Monitor agent status with `/agents-list`
- Adjust grid layout with `/agents-grid <columns>`

## Troubleshooting

### Common Issues

#### Tmux Not Available
```bash
# Error: tmux command not found
# Solution: Install tmux (see prerequisites)
tmux -V
```

#### Agent Process Stuck
```bash
# Kill stuck processes
/agents-restart

# Check status
/agents-list
```

#### Agent Team Disabled
```bash
# Enable agent team mode
/agents-team-toggle on
```

#### No Agents Loaded
1. Check agent directory structure
2. Verify agent files exist
3. Check team configuration in `teams.yaml`

### Debug Commands
```bash
# Check agent team status
/agents-team-toggle status

# List available agents
/agents-list

# Monitor logs
tail -f .pi/agent-logs/session-*.log
```

## Architecture

### Ephemeral Subagent System
- Each task spawns a fresh `pi --mode rpc` process
- No context accumulation between dispatches
- Clean slate for every task
- Processes killed after result returns

### Component Interaction
- **Orchestrator**: Main agent that manages subagents
- **Subagents**: Specialized agents for specific tasks
- **Tmux Manager**: Handles session and pane management
- **Log System**: Centralized logging with combined output

### File Structure
```
.pi/
├── agent-logs/          # Session logs
├── agent-sessions/      # Runtime session data
├── agents/              # Agent definitions
│   ├── agents/          # Agent files
│   ├── extensions/      # Extensions (agent-team.ts)
│   └── teams.yaml       # Team configuration
```

## Advanced Usage

### Custom Teams
Define custom teams in `teams.yaml`:

```yaml
frontend-team:
  - worker
  - scout
  - reviewer

backend-team:
  - worker
  - planner
  - scout

devops-team:
  - worker
  - scout
```

### Model Configuration
Configure specific models for agents:

```markdown
---
name: senior-developer
description: Senior developer with advanced reasoning
tools: read,write,grep,find,ls,web-search
model: openrouter/nvidia/nemotron-3-super-120b-a12b:free
thinking: on
---
```

### Complex Workflows
Combine multiple agents for complex tasks:

1. **Exploration**: Scout → identify codebase structure
2. **Planning**: Planner → create implementation plan
3. **Implementation**: Worker → execute plan
4. **Review**: Reviewer → validate results

## Contributing

To extend the agent system:
1. Add new agent types in agent definition files
2. Configure teams in `teams.yaml`
3. Customize tools and capabilities per agent
4. Extend the agent-team.ts for new features

## License

This extension is part of the pi-coding-agent ecosystem. See the main project for license details.