---
description: >-
  How to use the ahpx CLI to orchestrate AI agents via the Agent Host Protocol.
  Covers server management, session lifecycle, dispatching work, watching events,
  and fleet health. Use when any agent needs to dispatch, monitor, or manage
  AHP agent sessions from the command line.
applyTo: '**'
---

# Use ahpx CLI — Portable Agent Orchestration

ahpx is a CLI client for the Agent Host Protocol (AHP). It connects to AHP
servers over WebSocket, manages AI agent sessions, and streams structured output.
Any agent can use ahpx to dispatch work, monitor progress, and collect results.

Key capabilities:
- **Dispatch agents** — one-shot execution or persistent sessions
- **Stream events** — real-time NDJSON output of deltas, tool calls, usage
- **Manage fleet** — multiple servers, health checks, connection profiles
- **Observe sessions** — attach to running sessions as a read-only watcher

## Quick Reference

| Task | Command |
|------|---------|
| One-shot agent dispatch | `ahpx exec "do the thing"` |
| Send prompt to existing session | `ahpx prompt "continue working"` |
| Create a named session | `ahpx session new -n my-task` |
| Watch a session live | `ahpx watch -n my-task` |
| Cancel active turn | `ahpx cancel` |
| List active sessions | `ahpx session list` |
| Check server health | `ahpx server status` |
| Add a server | `ahpx server add local --url ws://localhost:8082` |

## Installation

ahpx is an npm package. Run directly with `npx`:

```bash
npx ahpx --help
```

Or install globally:

```bash
npm install -g ahpx
```

Version check:

```bash
ahpx --version
# 0.1.0
```

## Global Options

These flags apply to ALL commands:

| Flag | Description | Default |
|------|-------------|---------|
| `--format <text\|json\|quiet>` | Output format | `text` |
| `--json-strict` | Suppress non-JSON stderr (use with `--format json`) | off |
| `-v, --verbose` | Debug logging to stderr | off |
| `--version` | Print version | — |
| `--help` | Show help | — |

**Format modes:**
- `text` — colored terminal output with `[tool]`, `[permission]`, `[done]` labels
- `json` — NDJSON (one JSON object per line) for programmatic consumption
- `quiet` — silent until completion, then prints only the final response

**When automating, always use `--format json`** for structured, parseable output.

## Server Management

Servers are AHP-compatible WebSocket endpoints. ahpx stores connection profiles
in `~/.ahpx/connections.json`.

### Add a server

```bash
ahpx server add <name> --url <ws-url> [--token <token>] [--default] [--tag <tag>]
```

Examples:

```bash
# Add a local dev server
ahpx server add local --url ws://localhost:8082 --default

# Add a cloud server with auth and tags
ahpx server add cloud --url wss://cloud.example.com:8082 --token $TOKEN --tag gpu --tag fast
```

Tags are repeatable — use them for grouping servers by capability.

### List saved servers

```bash
ahpx server list
```

Expected output:

```
Saved connections:

  local (default)
    URL: ws://localhost:8082

  cloud
    URL: wss://cloud.example.com:8082
    Tags: gpu, fast
```

### Remove a server

```bash
ahpx server remove <name>
```

### Test connectivity

```bash
ahpx server test <name-or-url> [-t <timeout-ms>]
```

Tests a WebSocket connection to the server. Use this to verify a server is
reachable before dispatching work.

### Health check all servers

```bash
ahpx server status [--all] [-t <timeout-ms>]
```

Shows a table of all saved servers with health status:

```
Name    URL                    Status       Latency   Sessions  Agents
local   ws://localhost:8082    healthy      12ms      2         copilot, mock
cloud   wss://cloud:8082       healthy      45ms      0         copilot
```

By default, unreachable servers are hidden. Pass `--all` to show them.

### Detailed health for one server

```bash
ahpx server health <name> [-t <timeout-ms>]
```

Returns detailed health information including protocol version, available agents
and models, active session count, and latency.

### Connection file format

Connections are stored in `~/.ahpx/connections.json`:

```json
{
  "connections": [
    {
      "name": "local",
      "url": "ws://localhost:8082",
      "default": true
    },
    {
      "name": "cloud",
      "url": "wss://cloud.example.com:8082",
      "token": "secret",
      "tags": ["gpu", "fast"]
    }
  ]
}
```

### Server resolution order

When you specify `-s <server>`, ahpx resolves it as:

1. If it's a `ws://` or `wss://` URL → use directly
2. If it's a name → look up in `~/.ahpx/connections.json`
3. If omitted → use `config.defaultServer` from ahpx config
4. If no config default → use the connection marked `default: true`
5. If nothing resolves → error (exit code 2)

## Connecting to a Server

```bash
ahpx connect [<name-or-url>] [-t <timeout-ms>]
```

Connects to an AHP server and prints server info (agents, models, sessions).
Useful for verifying connectivity and discovering available capabilities.

```bash
# Connect to default server
ahpx connect

# Connect to a named server
ahpx connect cloud

# Connect to a URL directly
ahpx connect ws://localhost:8082
```

## Discovering Agents and Models

```bash
ahpx agents [-s <server>]
```

Lists all available agent providers and their models on the server. Use this to
discover which `-p <provider>` and `-m <model>` values to pass when creating
sessions or dispatching work.

## Session Management

Sessions are persistent agent conversations on an AHP server. ahpx tracks
sessions locally in `~/.ahpx/sessions/` and syncs with the server.

### Create a session

```bash
ahpx session new [-s <server>] [-p <provider>] [-m <model>] [-n <name>] [--cwd <dir>]
```

Options:
- `-s, --server <name>` — server name or WebSocket URL
- `-p, --provider <provider>` — agent provider (e.g., `copilot`)
- `-m, --model <model>` — model to use
- `-n, --name <name>` — human-readable name for scoped lookups
- `--cwd <dir>` — working directory (defaults to current directory)
- `-t, --timeout <ms>` — connection timeout (default: 10000)

Example:

```bash
ahpx session new -s local -p copilot -n refactor-task --cwd /path/to/project
```

Naming sessions with `-n` is important — it enables scoped lookups so you can
reference sessions by name instead of UUID.

### List sessions

```bash
ahpx session list [-s <server>] [-a]
```

Lists locally-tracked sessions. By default shows only active sessions.
Pass `-a` to include closed sessions.

### Show session details

```bash
ahpx session show [<id>] [-n <name>] [-s <server>]
```

Shows detailed information about a session: URI, server, provider, model,
working directory, status, and creation time. Can look up by ID or name.

### List active server sessions

```bash
ahpx session active [-s <server>] [-t <timeout-ms>]
```

Queries the server directly for all active sessions (live query, not local
cache). Useful when local session records may be stale.

### Close a session

```bash
ahpx session close [<id>] [-n <name>] [-s <server>] [-t <timeout-ms>]
```

Soft-closes a session — disposes it on the server but keeps the local record
for history. Can look up by ID or name.

### Turn history

```bash
ahpx session history [<id>] [-n <name>] [-s <server>] [-l <limit>] [--local]
```

Shows turn history for a session. Default limit is 10 turns.
Pass `--local` to show only locally-cached history (no server connection needed).

### Export a session

```bash
ahpx session export <id> [-o <file>]
```

Exports a session record (with local turn history) to JSON. Writes to stdout
by default; use `-o` to write to a file.

### Import a session

```bash
ahpx session import <file>
```

Imports a session record from a JSON file into the local session store.

### Session scoping

ahpx uses directory-walk scoping to find the right session for your context.
When you run a command without specifying a session ID:

1. Check current directory for an active session
2. Walk up to the git root, checking each parent directory
3. Use the first matching session found

This means sessions created with `--cwd /project` will be found from
`/project/src/utils/` automatically.

## Sending Prompts

### Implicit prompt (default command)

```bash
ahpx "<prompt text>"
```

When you pass text without a subcommand, ahpx sends it as a prompt to the
current session (resolved by scoping). If no session exists, one is created
automatically.

### Explicit prompt

```bash
ahpx prompt <text...> [options]
```

Options:
- `-s, --server <name>` — server name or URL
- `-n, --session-name <name>` — session name for scoped lookup
- `-f, --file <path>` — read prompt from file (`-` for stdin)
- `--cwd <dir>` — working directory for auto-created sessions
- `--approve-all` — auto-approve all tool permissions
- `--approve-reads` — auto-approve reads, prompt for writes/shell
- `--deny-all` — deny all tool permissions
- `--idle-timeout <seconds>` — cancel if no events within N seconds
- `--tag <key=value>` — metadata tags for JSON events (repeatable)
- `--forward-webhook <url>` — POST events to HTTP endpoint (repeatable)
- `--forward-ws <url>` — stream events over WebSocket (repeatable)
- `--forward-filter <types>` — comma-separated event types to forward
- `--forward-headers <json>` — custom headers for forwarders (JSON object)

Example:

```bash
ahpx prompt -n my-session --approve-all "fix the failing tests"
```

### Piping input

ahpx supports reading prompts from stdin:

```bash
echo "review this code" | ahpx
cat instructions.md | ahpx prompt -f -
```

## One-Shot Execution

`exec` is the primary command for dispatching autonomous agent work. It creates
a temporary session, sends the prompt, streams the response, and disposes the
session automatically.

```bash
ahpx exec <text...> [options]
```

Options (same as `prompt` plus session creation options):
- `-s, --server <name>` — server name or URL
- `-p, --provider <provider>` — agent provider
- `-m, --model <model>` — model to use
- `--cwd <dir>` — working directory
- `--approve-all` — auto-approve all permissions
- `--approve-reads` — auto-approve reads only
- `--deny-all` — deny all permissions
- `--idle-timeout <seconds>` — cancel on idle
- `--tag <key=value>` — metadata tags (repeatable)
- `--forward-webhook <url>` — webhook forwarding (repeatable)
- `--forward-ws <url>` — WebSocket forwarding (repeatable)
- `--forward-filter <types>` — event type filter
- `--forward-headers <json>` — forwarder headers

### Basic dispatch

```bash
ahpx exec "summarize this repository"
```

### Dispatch with full automation

```bash
ahpx exec -s local --approve-all --format json "fix the failing tests in src/"
```

### Dispatch with model selection

```bash
ahpx exec -s cloud -m claude-sonnet-4 --approve-all "refactor the auth module"
```

### Dispatch with working directory

```bash
ahpx exec --cwd /path/to/project --approve-all "run the test suite and fix failures"
```

### Key differences between `exec` and `prompt`

| | `exec` | `prompt` |
|---|--------|---------|
| Session | Creates temporary, disposes after | Uses existing or auto-creates persistent |
| Use case | One-shot autonomous tasks | Multi-turn conversations |
| Provider/model | Can specify `-p` and `-m` | Uses session's existing provider/model |
| Session name | N/A (temporary) | Can target by `-n` name |

## Watching Sessions

### Watch command

```bash
ahpx watch [<id>] [-n <name>] [-s <server>]
```

Attaches to a session as a read-only observer and streams all activity in
real-time. The output format follows the global `--format` flag.

```bash
# Watch by session name
ahpx watch -n my-task

# Watch with JSON output for parsing
ahpx --format json watch -n my-task

# Watch by session ID
ahpx watch abc123
```

The watch command streams until the session completes or you press Ctrl+C.

### Event forwarding

Both `prompt` and `exec` support forwarding events to external endpoints:

```bash
# Forward to a webhook
ahpx exec --forward-webhook https://hooks.example.com/events --approve-all "task"

# Forward to WebSocket
ahpx exec --forward-ws ws://dashboard:9090/events --approve-all "task"

# Filter which events to forward
ahpx exec --forward-webhook https://hooks.example.com \
  --forward-filter "turn_complete,turn_error,tool_call_complete" \
  --approve-all "task"
```

## Cancelling a Turn

```bash
ahpx cancel [-n <name>] [-s <server>]
```

Cancels the currently active turn in a session. Useful when an agent is stuck
or working on the wrong thing.

## Switching Models

```bash
ahpx model <model-id> [-n <name>] [-s <server>]
```

Switches the model for an existing session mid-conversation.

## Browsing Server Filesystem

```bash
ahpx browse [<directory>] [-s <server>]
```

Lists files and directories visible to the server. Useful for understanding
what the agent can see.

## NDJSON Output Format

When using `--format json`, ahpx outputs one JSON object per line (NDJSON).
Each line is a `JsonEnvelope`:

```json
{"type":"<event_type>","timestamp":"<ISO 8601>","data":{...}}
```

With `--tag` flags, envelopes include a `tags` field:

```json
{"type":"delta","timestamp":"2026-03-23T10:00:00.000Z","tags":{"job":"abc"},"data":{"content":"Hello"}}
```

### Event types

| Type | Data Fields | Meaning |
|------|-------------|---------|
| `delta` | `{ content: string }` | Streaming text chunk from the agent |
| `reasoning` | `{ content: string }` | Model thinking/reasoning text |
| `tool_call_start` | `{ toolCallId, name }` | Tool invocation began |
| `tool_call_delta` | `{ toolCallId, content }` | Streaming tool parameters |
| `tool_call_ready` | `{ toolCallId, toolName, displayName, invocationMessage, toolInput? }` | Tool parameters complete, ready for approval |
| `tool_call_complete` | `{ toolCallId, result }` | Tool execution finished |
| `tool_call_cancelled` | `{ toolCallId, reason }` | Tool call denied or skipped |
| `permission` | `{ request }` | Permission request from agent |
| `usage` | `{ usage }` | Token usage report |
| `turn_complete` | `{ responseText }` | Turn finished — `responseText` has the full response |
| `turn_error` | `{ error }` | Turn failed — `error` has the error details |
| `turn_cancelled` | `{}` | Turn was cancelled |
| `title_changed` | `{ title }` | Session title updated by server |

### Parsing NDJSON

Each line is independent valid JSON. Parse line-by-line:

```bash
# Stream and filter for turn completion
ahpx --format json exec --approve-all "do something" | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type')
  if [ "$type" = "turn_complete" ]; then
    echo "$line" | jq -r '.data.responseText'
  fi
done
```

```bash
# Extract just the final response
ahpx --format json exec --approve-all "summarize this" \
  | grep '"type":"turn_complete"' \
  | jq -r '.data.responseText'
```

### Key events for monitoring agent progress

- **`delta`** — streaming response text, indicates the agent is actively generating
- **`tool_call_start`** / **`tool_call_complete`** — track which tools the agent invokes
- **`turn_complete`** — the turn finished; `data.responseText` has the full output
- **`turn_error`** — the turn failed; `data.error` has error details
- **`usage`** — token consumption for billing/tracking

## Configuration

ahpx uses layered configuration (later wins):

1. **Defaults** — `permissions: "approve-reads"`, `timeout: 30`, `format: "text"`
2. **Global** — `~/.ahpx/config.json`
3. **Project** — `./.ahpxrc.json` (in project root)
4. **CLI flags** — `--format`, `--approve-all`, etc.

### Show current config

```bash
ahpx config show
```

Prints resolved configuration with source annotations showing where each value
came from (`default`, `global`, `project`, or `cli`).

### Initialize global config

```bash
ahpx config init
```

Creates `~/.ahpx/config.json` with default values.

### Config file format

```json
{
  "defaultServer": "local",
  "defaultProvider": "copilot",
  "defaultModel": "claude-sonnet-4",
  "permissions": "approve-all",
  "timeout": 30,
  "format": "text",
  "verbose": false
}
```

### Project-level config

Create `.ahpxrc.json` in your project root to set project-specific defaults:

```json
{
  "defaultServer": "cloud",
  "permissions": "approve-reads"
}
```

## Exit Codes

ahpx uses well-defined exit codes for scripting:

| Code | Name | Meaning |
|------|------|---------|
| `0` | Success | Command completed successfully |
| `1` | Error | General runtime error |
| `2` | Usage | Invalid arguments or usage |
| `3` | Timeout | Operation timed out |
| `4` | NoSession | No active session found |
| `5` | PermissionDenied | Permission denied |
| `130` | Interrupted | SIGINT (Ctrl+C) |

Check exit codes after commands:

```bash
ahpx exec --approve-all "fix tests"
exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "Agent completed successfully"
elif [ $exit_code -eq 1 ]; then
  echo "Agent encountered an error"
elif [ $exit_code -eq 3 ]; then
  echo "Agent timed out"
elif [ $exit_code -eq 130 ]; then
  echo "Agent was interrupted"
fi
```

## Shell Completions

```bash
# Bash
ahpx completions bash >> ~/.bashrc

# Zsh
ahpx completions zsh >> ~/.zshrc

# Fish
ahpx completions fish > ~/.config/fish/completions/ahpx.fish
```

## Common Patterns

### Pattern 1: Dispatch an agent and get the result

The simplest pattern — fire-and-forget with structured output:

```bash
result=$(ahpx --format json exec --approve-all "summarize this repository" \
  | grep '"type":"turn_complete"' \
  | jq -r '.data.responseText')

echo "$result"
```

### Pattern 2: Dispatch and monitor progress

Stream events while an agent works, reacting to tool calls:

```bash
ahpx --format json exec --approve-all "fix failing tests" | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type')
  case "$type" in
    tool_call_start)
      name=$(echo "$line" | jq -r '.data.name')
      echo "🔧 Agent calling tool: $name"
      ;;
    tool_call_complete)
      echo "✅ Tool call completed"
      ;;
    turn_complete)
      echo "🎉 Agent finished!"
      echo "$line" | jq -r '.data.responseText'
      ;;
    turn_error)
      echo "❌ Agent failed:"
      echo "$line" | jq -r '.data.error'
      ;;
  esac
done
```

### Pattern 3: Long-running session with multiple prompts

Create a persistent session and send multiple prompts:

```bash
# Create a named session
ahpx session new -s local -n feature-work --cwd /path/to/project

# Send first prompt
ahpx prompt -n feature-work --approve-all "analyze the codebase and create a plan"

# Send follow-up prompt (same session, maintains context)
ahpx prompt -n feature-work --approve-all "implement the plan"

# Check what happened
ahpx session history -n feature-work

# Clean up
ahpx session close -n feature-work
```

### Pattern 4: Watch what another agent is doing

If a session is already running (dispatched elsewhere), attach as an observer:

```bash
# Find the session
ahpx session list

# Watch it in real-time
ahpx --format json watch <session-id>
```

### Pattern 5: Check if a session is still running

```bash
ahpx session show -n my-task
```

The output includes the session status (`active` or `closed`).

Or query the server directly for live session state:

```bash
ahpx session active -s local
```

### Pattern 6: Get output of a completed session

```bash
# View turn history
ahpx session history -n completed-task --local

# Or export the full session record
ahpx session export <session-id> -o session.json
cat session.json | jq '.turns[-1].responsePreview'
```

### Pattern 7: Fleet health check before dispatching

```bash
# Check all servers are healthy
ahpx server status

# Dispatch to a specific healthy server
ahpx exec -s cloud --approve-all "deploy the release"
```

### Pattern 8: Dispatch with idle timeout

Protect against stuck agents by setting an idle timeout:

```bash
# Cancel if no events received for 120 seconds
ahpx exec --approve-all --idle-timeout 120 "run the full test suite"
```

### Pattern 9: Dispatch with event forwarding

Stream events to external systems for monitoring:

```bash
ahpx exec --approve-all \
  --forward-webhook https://hooks.slack.com/workflows/abc \
  --forward-filter "turn_complete,turn_error" \
  "deploy to staging"
```

### Pattern 10: Tag events for tracking

Add metadata tags to JSON events for correlation:

```bash
ahpx --format json exec --approve-all \
  --tag job=build-123 --tag repo=my-app \
  "build and test"
```

Events will include the tags:

```json
{"type":"turn_complete","timestamp":"...","tags":{"job":"build-123","repo":"my-app"},"data":{"responseText":"..."}}
```

## Authentication

ahpx resolves authentication tokens in this order:

1. `--token <token>` CLI flag (on `server add`)
2. `$AHPX_TOKEN` environment variable
3. `~/.ahpx/auth.json` stored token
4. Interactive prompt (if TTY available)

For non-interactive (agent) use, set the token via environment variable:

```bash
export AHPX_TOKEN=your-token
ahpx exec --approve-all "do work"
```

Or store it in the connection profile:

```bash
ahpx server add myserver --url wss://server:8082 --token $TOKEN
```

## File Locations

| Path | Contents |
|------|----------|
| `~/.ahpx/connections.json` | Saved server connection profiles |
| `~/.ahpx/config.json` | Global configuration |
| `~/.ahpx/auth.json` | Stored authentication tokens |
| `~/.ahpx/sessions/` | Local session records (one JSON file per session) |
| `.ahpxrc.json` | Project-level configuration (in project root) |

## Permission Modes

When an agent wants to run tools (read files, write files, execute commands),
ahpx controls approval:

| Flag | Reads | Writes | Shell | Use Case |
|------|-------|--------|-------|----------|
| `--approve-all` | ✅ Auto | ✅ Auto | ✅ Auto | Autonomous agents, CI/CD |
| `--approve-reads` | ✅ Auto | ❓ Prompt | ❓ Prompt | Interactive with safety (default) |
| `--deny-all` | ❌ Deny | ❌ Deny | ❌ Deny | Read-only analysis |

**For agent-to-agent dispatch, always use `--approve-all`** unless you have a
specific reason to restrict permissions.

## Troubleshooting

### "No active session found" (exit code 4)

The CLI couldn't find a session for the current directory. Fix:

```bash
# Check what sessions exist
ahpx session list

# Create one explicitly
ahpx session new -s local -n my-session --cwd $(pwd)
```

### Connection timeout (exit code 3)

The server didn't respond within the timeout. Fix:

```bash
# Test connectivity
ahpx server test local

# Increase timeout
ahpx connect local -t 30000

# Check server health
ahpx server status --all
```

### Permission denied (exit code 5)

Authentication failed. Fix:

```bash
# Set token via environment
export AHPX_TOKEN=your-token

# Or add token to server profile
ahpx server remove myserver
ahpx server add myserver --url wss://server:8082 --token $TOKEN
```

### Agent seems stuck

```bash
# Cancel the active turn
ahpx cancel -n my-session

# Or set idle timeout on future dispatches
ahpx exec --approve-all --idle-timeout 120 "task"
```

## Complete Command Reference

### Top-level commands

| Command | Description |
|---------|-------------|
| `ahpx <prompt>` | Send prompt (implicit, uses current session) |
| `ahpx prompt <text>` | Send prompt (explicit, with options) |
| `ahpx exec <text>` | One-shot: create → prompt → dispose |
| `ahpx connect [target]` | Connect and show server info |
| `ahpx watch [id]` | Observe a session in real-time |
| `ahpx cancel` | Cancel active turn |
| `ahpx browse [dir]` | Browse server filesystem |
| `ahpx content <uri>` | Fetch content by URI |
| `ahpx model <model-id>` | Switch session model |
| `ahpx agents` | List available agents/models |
| `ahpx completions` | Shell completion scripts |

### Server commands (`ahpx server`)

| Command | Description |
|---------|-------------|
| `server add <name>` | Save a connection profile |
| `server list` | List saved connections |
| `server remove <name>` | Remove a connection |
| `server test <target>` | Test connectivity |
| `server status` | Health check all servers |
| `server health <name>` | Detailed health for one server |

### Session commands (`ahpx session`)

| Command | Description |
|---------|-------------|
| `session new` | Create a new session |
| `session list` | List sessions (active by default) |
| `session show [id]` | Show session details |
| `session close [id]` | Close a session |
| `session history [id]` | Show turn history |
| `session active` | Live query of server sessions |
| `session export <id>` | Export session to JSON |
| `session import <file>` | Import session from JSON |

### Config commands (`ahpx config`)

| Command | Description |
|---------|-------------|
| `config show` | Print resolved config with sources |
| `config init` | Create `~/.ahpx/config.json` |

## Further Reading

- AHP protocol fundamentals: `.github/skills/ahp-protocol/SKILL.md`
- ahpx architecture internals: `.github/skills/ahpx-architecture/SKILL.md`
- Dispatching agents via AHP (George-specific): `.github/skills/george-ahp-dispatch/SKILL.md`
- Error catalog and troubleshooting: `docs/errors.md`
