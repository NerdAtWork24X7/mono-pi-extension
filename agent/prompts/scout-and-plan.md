---
description: Scout gathers context, planner creates implementation plan — no implementation
---

# TASK
Scout and plan: $@

# WHAT THIS WORKFLOW DOES
Two agents run in sequence. The scout maps the codebase. The planner designs the implementation.
STOP after Step 2. Do NOT implement anything. Return the plan only.

# STEPS — RUN IN ORDER USING THE SUBAGENT CHAIN TOOL
## Step 1 — Scout
- Agent: `scout`
- Task: Find all code relevant to: $@
- Depth: Medium (follow imports, read critical functions)
- Rules:
  - Return exact file paths and line ranges — no approximations
  - Paste key interfaces, types, and functions verbatim — do not paraphrase code
  - Identify every file that will likely need to change
- Output: Passed as `{previous}` to Step 2

## Step 2 — Planner
- Agent: `planner`
- Task: Create a step-by-step implementation plan for "$@"
- Input: Use `{previous}` — the scout's full findings
- Rules:
  - Use ONLY the files and interfaces the scout found — do not invent new ones
  - Break the work into tasks: one task = one file or one focused change
  - Order tasks by dependency — tasks others depend on come first
  - Define all interfaces between components before listing implementation steps
  - Do NOT write any implementation code — write what to do, not how to do it
- Output: Final plan returned to the user

# ⚠️ STOP HERE
Do NOT proceed to implementation. Return the plan and wait for user approval.

# CHAIN EXECUTION
Run both steps as a chain using the `subagent` tool with `chain` parameter.
Pass output between steps using the `{previous}` placeholder.
