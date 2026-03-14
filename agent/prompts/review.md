---
description: Review code for bugs, security issues, and improvements
---

# TASK
Review the provided code. Find real problems — not style nitpicks.

# WHAT TO LOOK FOR — CHECK EVERY CATEGORY
1. **Bugs & Logic Errors** — off-by-one, null/undefined access, race conditions, wrong conditions
2. **Security** — SQL injection, XSS, auth bypass, data exposure, hardcoded secrets
3. **Error Handling** — missing try/catch, unhandled promises, errors that fail silently
4. **Performance** — N+1 queries, unnecessary re-renders, memory leaks
5. **Readability** — confusing names, overly complex logic, dead code

# OUTPUT — ONE ENTRY PER ISSUE, USING THIS FORMAT

**🔴 Critical / 🟡 Warning / 🔵 Info** — `file.ts:42`
- **Problem:** What is wrong and why it matters
- **Fix:** Exactly how to fix it (show code if helpful)

Repeat this block for every issue found.

---
**Summary:** X critical, Y warnings, Z info items. Safe to merge? Yes / No / Needs discussion.

# RULES — NEVER BREAK THESE
- ❌ Do NOT report issues you are not confident about — only real findings
- ❌ Do NOT flag style preferences as warnings
- ✅ Every finding MUST include: severity, location, problem, and fix
- ✅ If you find nothing wrong, say "No issues found" and briefly explain what you checked

# RULES FOR WRITING FINDINGS
- Always include the file name and line number
- Say WHAT is wrong, WHY it is a problem, and HOW to fix it
- Never write vague feedback like "this could be better" — be specific
- **VERY IMPORTANT**: write findings in file <cwd>/tmp/review_findings.md

## USER QUERY
$@
