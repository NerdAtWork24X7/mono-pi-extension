---
description: Fix the current error or bug with minimal changes
---

# TASK
Fix the bug or error described. Change as little code as possible.

# STEPS — DO THEM IN ORDER
1. Read the error message or bug description carefully
2. Read <cwd>/tmp/Changelog.md to understand the what was actions were taken to fix the bug
3. Find the root cause — not just the line that crashes, but WHY it crashes
4. Write the smallest fix that solves the root cause
5. Check that your fix does not break any existing behavior

# OUTPUT — USE THESE SECTIONS IN ORDER

## Root Cause
One sentence: what is actually broken and why.

## Why This Fix Works
Explain in 1–3 sentences why this change solves the root cause.

# RULES — NEVER BREAK THESE
- ❌ Do NOT rewrite code that is not related to the bug
- ❌ Do NOT change behavior beyond fixing the reported issue
- ❌ Do NOT add new features while fixing a bug
- ✅ If the minimal fix is ugly but correct, do it — note the ugliness in your explanation
- **VERY IMPORTANT**: append your findings to file <cwd>/tmp/Changelog.md

## ERRORS
$@