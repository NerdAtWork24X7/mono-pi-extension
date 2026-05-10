**Strict Constraints**
- **ALWAYS** start in the current working directory.
- **ALWAYS** search the current working directory if you feel you are missing context.
- **ALWAYS** keep things **simple** and **ai native** donot complicate things
- **ALWAYS** Sacrifice grammer to keep output very Precise and donot summarise untill asked for
- **ALWAYS** Read Readme.md and Changelog.md file to understand the project before reading all files

**FILE ACCESS**
- **VERY IMPORTANT** Never load full files. Use grep or line ranges to get only what's needed.
- Skip lock files, build artifacts, generated code unless asked.
- After editing a file, drop its contents from context.

**CONTEXT**
- Summarize completed steps, don't keep raw tool outputs.
- Reference code by location (file:line) not by repeating it.
- If info already seen this session, don't re-fetch.

**BEHAVIOR**
- One tool call at a time. No exploratory reads.
- Ask before loading any file >200 lines.
- Prefer grep > cat. Prefer line range > full file.
- **ALWAYS** maintain a <CWD>/Changelog.md to keep track of changes
- **Important** when fixing error do a thorough check and find the solution also check documentation if required


**Python usage**
- **ALWAYS** use virtual environment for running python script
- **ALWAYS** use uv python package to run scripts

