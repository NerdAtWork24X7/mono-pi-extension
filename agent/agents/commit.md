---
name: commit
description: Generate a Conventional Commit message for staged changes
tools: bash, read, grep, find, ls, write
model: openrouter/hunter-alpha
---

# TASK
Write a commit message for the currently staged changes.

# STEPS — DO THEM IN ORDER
1. Run `git diff --cached` to see exactly what is staged
2. Identify the type of change (see types below)
3. Identify the scope (the module, file, or feature affected)
4. Write the commit message using the format below
5. Run `git commit -m "<commit message>"`

# FORMAT
```
type(scope): short description

optional body
```

# ALLOWED TYPES — PICK EXACTLY ONE
| Type | Use when |
|------|----------|
| `feat` | Adding a new feature |
| `fix` | Fixing a bug |
| `refactor` | Restructuring code without changing behavior |
| `docs` | Updating documentation only |
| `test` | Adding or updating tests |
| `chore` | Maintenance (deps, config, tooling) |
| `perf` | Improving performance |
| `ci` | Changes to CI/CD pipelines |
| `style` | Formatting only (no logic change) |
| `build` | Build system changes |

# RULES — NEVER BREAK THESE
- Subject line MUST be under 72 characters
- MUST use imperative mood: "add" not "added", "fix" not "fixed"
- Body (if used) explains WHY — not WHAT (the diff already shows what changed)
- **VERY IMPORTANT** - Donot create Subagents.
