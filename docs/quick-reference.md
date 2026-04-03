# ahpx Quick Reference

One-page cheat sheet for the most common ahpx commands.

## Getting Started

```bash
npm install -g @tylerl0706/ahpx
ahpx server add local --url ws://localhost:8082 --default
ahpx "hello world"
```

## Core Commands

### Connecting & Servers

| Command | What it does | Key options |
|---------|-------------|-------------|
| `ahpx connect [target]` | Connect to a server and print info | `-t <timeout>` |
| `ahpx server add <name> --url <url>` | Save a named server connection | `--token`, `--default`, `--tag` |
| `ahpx server list` | List saved server connections | |
| `ahpx server remove <name>` | Remove a saved connection | |
| `ahpx server status` | Health-check all saved servers | `--all` (include unreachable) |

### Sessions

| Command | What it does | Key options |
|---------|-------------|-------------|
| `ahpx session new` | Create a new agent session | `-s`, `-p <provider>`, `-m <model>`, `-n <name>` |
| `ahpx session list` | List sessions | `-s <server>`, `-a` (include closed) |
| `ahpx session close [id]` | Close a session | `-n <name>`, `-s <server>` |
| `ahpx session history [id]` | Show turn history | `-l <limit>`, `--local` |
| `ahpx session export <id>` | Export session to JSON | `-o <file>` |
| `ahpx session import <file>` | Import session from JSON | |

### Prompting

| Command | What it does | Key options |
|---------|-------------|-------------|
| `ahpx <text>` | Send a prompt (default command) | `-s`, `-n`, `-f <file>`, `--cwd` |
| `ahpx prompt <text>` | Send a prompt (explicit) | `-s`, `-n`, `-f <file>`, `--cwd` |
| `ahpx exec <text>` | One-shot: create → prompt → dispose | `-s`, `-p`, `-m`, `--cwd` |
| `ahpx cancel` | Cancel the active turn | `-n <name>`, `-s <server>` |

### Utilities

| Command | What it does | Key options |
|---------|-------------|-------------|
| `ahpx agents` | List available agents and models | `-s <server>` |
| `ahpx watch [id]` | Observe a session and stream activity | `-n <name>`, `-s <server>` |
| `ahpx model <model-id>` | Switch model for a session | `-n <name>`, `-s <server>` |
| `ahpx content <uri>` | Fetch content by URI from server | `-s <server>`, `-o <file>` |
| `ahpx browse [directory]` | Browse server filesystem | `-s <server>` |

## Permission Modes

| Flag | Behavior |
|------|----------|
| `--approve-reads` | Auto-approve reads, prompt for writes **(default)** |
| `--approve-all` | Auto-approve all tool calls |
| `--deny-all` | Deny all tool calls |

## Output Formats

| Flag | Behavior |
|------|----------|
| `--format text` | Colored terminal output **(default)** |
| `--format json` | NDJSON — one event per line |
| `--format quiet` | Print only the final response |
| `--json-strict` | Suppress non-JSON stderr (pair with `--format json`) |

## Event Forwarding

Available on `prompt` and `exec` commands.

| Flag | Description |
|------|-------------|
| `--forward-webhook <url>` | POST events to an HTTP endpoint (repeatable) |
| `--forward-ws <url>` | Stream events over WebSocket (repeatable) |
| `--forward-filter <types>` | Comma-separated event types to forward |
| `--forward-headers <json>` | Custom HTTP headers (JSON object) |

## Common Workflows

```bash
# One-shot task (no session management needed)
ahpx exec "summarize this repo"

# Interactive session
ahpx session new -n my-task
ahpx "fix the failing tests"
ahpx "now add error handling"
ahpx session close

# Watch another session
ahpx watch <session-id>

# Check fleet health
ahpx server status

# Pipe a file as prompt input
ahpx -f prompt.txt

# Export session for sharing
ahpx session export <id> -o session.json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error |
| `2` | Usage error (bad arguments) |
| `3` | Timeout |
| `4` | No session found |
| `5` | Permission denied |
| `130` | Interrupted (Ctrl+C) |

## Global Flags

`--format <text|json|quiet>` · `--json-strict` · `-v, --verbose` · `--version` · `--help`

## More Info

- [User Guide](user-guide.md) — full CLI and SDK reference
- [Error Reference](errors.md) — detailed error catalog
- [Roadmap](roadmap.md) — project phases and status
