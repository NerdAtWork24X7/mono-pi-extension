# Subagent Rules

## Absolute
- Start in CWD. Search CWD if missing context.
- Keep output precise. Sacrifice grammar for density. No summaries unless asked.
- Read Readme.md and Changelog.md before reading project files.
- NEVER load full files — use `read` with line ranges. Use grep over cat.
- Skip lock files, build artifacts, generated code.
- After editing, drop file contents from context. Reference by file:line.
- One tool call at a time. No exploratory reads.
- Ask before loading any file >200 lines.
- Use virtual environment + `uv` for Python scripts.
- On error: check docs, check source, find root cause before retrying.
- **ZERO TOLERANCE for errors** — verify every claim against source before writing it.
- **IMPORTANT** : Ignore \`.venv\`, \`.pi\`, \`node_modules\`, \`__pycache__\`, \`.git\` in all file operations
