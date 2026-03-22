---
description: Worker implements, reviewer reviews, worker applies feedback
---

# TASK

Implement and review: $@

# WHAT THIS WORKFLOW DOES

Three agents run in sequence. The worker builds, the reviewer audits, the worker fixes.
Do NOT skip the review step. Do NOT let the worker self-review its own work.

# STEPS — RUN IN ORDER USING THE SUBAGENT CHAIN TOOL

## Step 1 — Worker (implement)
- **VERY IMPORTANT**: Donot use subagent for this step
- Task: Implement: $@
- Rules:
  - Complete the full implementation before stopping
  - List every file created or changed in your output
  - Note any assumptions made — the reviewer will check them
- Output: Passed as `{previous}` to Step 2

## Step 2 — Reviewer
- Agent: `reviewer`
- Task: Review the implementation from the previous step
- Input: Use `{previous}` — the worker's full output including files changed
- Rules:
  - Read every file the worker changed
  - Check: bugs, security, error handling, performance, readability
  - Label every finding: 🔴 Critical / 🟡 Warning / 🔵 Info
  - Every finding MUST include: file, line number, problem, and exact fix
  - End with: "Approved" or "Changes Required"
- Output: Passed as `{previous}` to Step 3

## Step 3 — Worker (apply feedback)
- **VERY IMPORTANT**: Donot use subagent for this step
- Task: Apply the reviewer's feedback
- Input: Use `{previous}` — the reviewer's full findings
- Rules:
  - Fix every 🔴 Critical and 🟡 Warning item — no exceptions
  - 🔵 Info items are optional — fix only if low risk
  - Do NOT make any changes beyond what the reviewer requested
  - Report each finding and whether it was fixed or skipped (with reason)

# CHAIN EXECUTION

Run all three steps as a chain using the `subagent` tool with `chain` parameter.
Pass output between steps using the `{previous}` placeholder.
