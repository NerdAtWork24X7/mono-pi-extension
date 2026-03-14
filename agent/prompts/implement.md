---
description: Full implementation workflow — scout finds context, planner designs plan, worker implements
---

# TASK
Implement: $@


# STEPS — RUN IN ORDER USING THE SUBAGENT

## Step 1 — Scout
- Agent: `scout`
- Task: Find all code relevant to: $@
- Depth: Medium (follow imports, read critical functions)
- Output: Passed as `{previous}` to Step 2

## Step 2 — Interview
- **VERY IMPORTANT**: Donot use subagent for this step
- Task: Interview the user to understand the task better based on the scout's findings
- Input: Use `{previous}` — the scout's full findings
- Rules:
  - Ask questions to clarify the task
  - Ask questions to clarify the context
  - Ask questions to clarify the requirements
- Output: Passed as `{previous}` to Step 3
- **VERY IMPORTANT**: write question answers in file <cwd>/tmp/interview.md

## Step 3 — Planner
- Agent: `planner`
- Task: Create a step-by-step implementation plan for "$@"
- Input: Use `{previous}` — the scout's full findings and the user's interview
- Rules:
  - Design the plan using ONLY the files and interfaces the scout found
  - Each step must target one file or one focused change
  - Define interfaces between components before any implementation step
- Output: Passed as `{previous}` to Step 4


## Step 4 — Worker
- Agent: `worker`
- Task: Implement the plan exactly as written
- Input: Use `{previous}` — the planner's full plan
- Rules:
  - Follow the plan exactly — do NOT deviate or improve beyond scope
  - If a step is blocked or unclear, stop and report — do NOT guess
  - Report every file changed in the output


# TASK EXECUTION
Run scout, planner and worker steps as a task using the `subagent` tool with `task` parameter.
Pass output between steps using the `{previous}` placeholder.