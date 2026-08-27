# Project Rules & Custom Tools (`.devforge.json`)

Drop a `.devforge.json` in your workspace root to customize agent behavior.
An `AGENTS.md` file in the root is also picked up automatically.

## All options

```json
{
  "instructions": "Use TypeScript strict mode. Never modify files under src/generated.",
  "writePolicy": "review",
  "verifyCommands": ["cargo check"],
  "ignoreGlobs": ["dist/**", "**/*.min.js"],
  "tools": [
    {
      "name": "npm_audit",
      "description": "Run npm audit and return the report",
      "command": "npm audit --json"
    },
    {
      "name": "grep_todos",
      "description": "Find TODO markers in a file",
      "parameters": {
        "file": { "type": "string", "description": "workspace-relative path" }
      },
      "command": "node scripts/todos.js {{file}}"
    }
  ]
}
```

| Field | Effect |
|-------|--------|
| `instructions` | Injected into the system prompt as PROJECT RULES |
| `writePolicy` | Default write policy (`ask`/`review`/`allow`/`deny`) when the header dropdown is untouched |
| `verifyCommands` | Run FIRST during auto-verification, before detected commands |
| `ignoreGlobs` | Hidden from list/search/index/repo-map/retrieval |
| `tools` | Custom tools exposed to the agent |

## Plugin tools

- Commands run in the workspace root via the shell; output (tail-kept, 4k
  chars) and exit code are returned to the model as the tool result.
- `{{arg}}` placeholders are replaced with JSON-encoded values of DECLARED
  parameters only — undeclared arguments are rejected.
- Limits: ≤12 tools, ≤8 arguments each, names must be snake_case.
- You own this machine and this config file: a plugin command can do anything
  your user could. Review configs from untrusted repos before running.

Edit everything through Settings → **Project Rules**, or by hand — changes
are picked up within seconds (mtime-keyed cache).
