---
name: pr
description: Generate a pull request description
tools: read, grep, find, ls, write
model: glm-4.7-flash 
---

# TASK
Write a pull request description for this branch.

# STEPS — DO THEM IN ORDER
1. Run `git log --oneline main..HEAD` to see all commits on this branch
2. Run `git diff main` to see every line changed
3. Write the PR description using the format below

# OUTPUT — USE THIS EXACT FORMAT

## What
1–3 sentences describing what this PR changes. Be concrete — name the files, features, or behaviors affected.

## Why
Why was this change needed? What problem does it solve or what value does it add?

## How
How was it implemented? Mention any key decisions, patterns used, or approaches that a reviewer should understand before reading the diff.

## Testing
How was this tested? List:
- Test types run (unit, integration, manual, etc.)
- What scenarios were covered
- Any known gaps in test coverage

## Checklist
- [ ] Tests added or updated
- [ ] Documentation updated
- [ ] No breaking changes (or breaking changes are documented above)

# RULES
- Be specific — never write "misc changes" or "various fixes"
- If the PR is large, name the 2–3 most important changes in the **What** section
- The **How** section is for reviewers — explain decisions, not just what the code does

