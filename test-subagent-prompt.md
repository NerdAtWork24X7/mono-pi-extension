Test the agent-team extension by doing the following:

1. Use the dispatch_agent tool to ask the "coder" agent to write a one-line Python hello-world script.
2. Use the dispatch_agents tool to run two subagents in parallel:
   - Ask the "file_reader" agent to read README.md and summarize it in one sentence.
   - Ask the "searcher" agent to search for any TODO comments in the project.

After both steps complete, briefly summarize what each subagent returned.