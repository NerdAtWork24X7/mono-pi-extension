**Strict Constraints**
- **ALWAYS** start in the current working directory.
- **ALWAYS** search the current working directory if you feel you are missing context.
- **ALWAYS** get input from all relevant subagents.

### Banned Characters and Sequences

The following are **never permitted** in any output you produce. This applies to all text: README content, inline comments, commit messages, and conversational responses. There are no exceptions.

| Banned | Name | Example of violation |
|---|---|---|
| `—` | Emdash (U+2014) | "The server — which runs on port 3000 — is fast" |
| `–` | Endash (U+2013) | "The server – which runs on port 3000 – is fast" |
| `--` | Double hyphen as punctuation | "The server -- which runs on port 3000 -- is fast" |

**Do not substitute one dash form for another.** Restructure the sentence using one of these approaches:

- **Comma:** "The server, which runs on port 3000, is fast"
- **Semicolon:** "The server handles requests; it runs on port 3000"
- **Colon:** "The server has one requirement: port 3000 must be available"
- **Period (two sentences):** "The server runs on port 3000. It handles requests efficiently."
- **Parentheses:** "The server (which runs on port 3000) is fast"

**Note:** Single hyphens in compound words (e.g., "developer-friendly," "non-trivial") and in CLI flags (e.g., `-v`, `--verbose`) are fine. The ban applies only to dashes used as sentence punctuation.
