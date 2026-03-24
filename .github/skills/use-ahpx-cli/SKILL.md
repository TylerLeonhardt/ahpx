---
applyTo: '**'
---

# Skill: Orchestrate Agents with ahpx

Your primary job is dispatching and managing AI agents. ahpx is how you do it.

ahpx connects to AHP servers over WebSocket, dispatches agent work, streams
structured output, and manages session lifecycle. This playbook covers the
commands you'll use daily, in the order you'll reach for them.

## 1. Dispatch Work

`exec` is the command you'll use most. It creates a temporary session, sends
your prompt, streams the response, and cleans up automatically.

### Basic dispatch

```bash
ahpx exec "summarize this repository"
```

This dispatches to your default server using the current directory as the
working directory. The agent runs, you see streaming output, and the session
is disposed when it finishes.

### Dispatch with full automation

When you're dispatching as an agent (not a human), always approve all
permissions and use JSON output:

```bash
ahpx exec --approve-all --format json "fix the failing tests in src/"
```

### Dispatch to a specific server

Target a named server with `--server` (shorthand `-s`):

```bash
ahpx exec -s windows-desktop --approve-all "build the .NET project and run tests"
```

### Dispatch with a working directory

Use `--cwd` to tell the agent where to work:

```bash
ahpx exec --cwd /path/to/project --approve-all "run the test suite and fix failures"
```

**`--cwd` is required when targeting a remote server.** Local servers default
to your current directory, but remote servers don't know where your project is.
Use `ahpx browse` to find paths on the remote machine (see Section 5).

```bash
# Find where the project lives on the remote server
ahpx browse --server windows-desktop
ahpx browse /Users/tyler/Code --server windows-desktop

# Then dispatch with the correct path
ahpx exec -s windows-desktop --cwd /Users/tyler/Code/my-project --approve-all \
  "run the full test suite"
```

### Choose a model

```bash
ahpx exec -s cloud -m claude-sonnet-4 --approve-all "refactor the auth module"
```

### Protect against stuck agents

Set an idle timeout to cancel if the agent stops producing events:

```bash
ahpx exec --approve-all --idle-timeout 120 "run the full test suite"
```

### Tag events for tracking

Add metadata to JSON events for correlation across systems:

```bash
ahpx --format json exec --approve-all \
  --tag job=build-123 --tag repo=my-app \
  "build and test"
```

### Forward events to external systems

Stream events to webhooks or WebSockets for monitoring dashboards:

```bash
ahpx exec --approve-all \
  --forward-webhook https://hooks.slack.com/workflows/abc \
  --forward-filter "turn_complete,turn_error" \
  "deploy to staging"
```

### exec flag reference

| Flag | Description |
|------|-------------|
| `-s, --server <name>` | Server name or WebSocket URL |
| `-p, --provider <provider>` | Agent provider (e.g., `copilot`) |
| `-m, --model <model>` | Model to use |
| `--cwd <dir>` | Working directory (required for remote servers) |
| `--approve-all` | Auto-approve all tool permissions |
| `--approve-reads` | Auto-approve reads, prompt for writes/shell |
| `--deny-all` | Deny all tool permissions |
| `--idle-timeout <seconds>` | Cancel if idle for N seconds |
| `--tag <key=value>` | Metadata tags for JSON events (repeatable) |
| `--forward-webhook <url>` | POST events to URL (repeatable) |
| `--forward-ws <url>` | Stream events over WebSocket (repeatable) |
| `--forward-filter <types>` | Comma-separated event types to forward |
| `--forward-headers <json>` | Custom headers for forwarders |

### When to use `exec` vs `prompt`

Use `exec` for one-shot tasks — it creates a temporary session and cleans up.
Use `prompt` for multi-turn conversations on persistent sessions.

| | `exec` | `prompt` |
|---|--------|---------|
| Session | Creates temporary, disposes after | Uses existing or creates persistent |
| Use case | One-shot autonomous tasks | Multi-turn conversations |
| Provider/model | Can specify `-p` and `-m` | Uses session's provider/model |

## 2. Monitor Running Work

### Watch a session live

Attach as a read-only observer and stream all activity in real-time:

```bash
ahpx watch <sessionId>
```

You can also watch by session name:

```bash
ahpx watch -n my-task
```

Watch with JSON output for programmatic parsing:

```bash
ahpx --format json watch -n my-task
```

The watch command streams until the session completes or you press Ctrl+C.

### Show session details

Check whether a session is still active, what server it's on, and its
working directory:

```bash
ahpx session show -n my-task
```

Or by session ID:

```bash
ahpx session show <sessionId>
```

### List all active sessions

```bash
ahpx session list
```

Include closed sessions with `-a`:

```bash
ahpx session list -a
```

### Query the server for live session state

Local session records can be stale. Query the server directly:

```bash
ahpx session active -s local
```

## 3. Get Results

### View turn history

See what the agent did, turn by turn:

```bash
ahpx session history -s <sessionId>
```

Or by name:

```bash
ahpx session history -n my-task
```

Limit how many turns to show:

```bash
ahpx session history -n my-task -l 5
```

View locally-cached history without connecting to the server:

```bash
ahpx session history -n my-task --local
```

### Export a session

Export the full session record (with turn history) to JSON:

```bash
ahpx session export <sessionId> -o session.json
```

Without `-o`, writes to stdout — useful for piping:

```bash
ahpx session export <sessionId> | jq '.turns[-1].responsePreview'
```

### Extract results from JSON output

When using `--format json`, ahpx outputs NDJSON (one JSON object per line).
The `turn_complete` event contains the full response:

```bash
ahpx --format json exec --approve-all "summarize this repository" \
  | grep '"type":"turn_complete"' \
  | jq -r '.data.responseText'
```

### Key NDJSON event types

| Type | What it means |
|------|---------------|
| `delta` | Streaming text chunk — agent is actively generating |
| `tool_call_start` | Agent is invoking a tool |
| `tool_call_complete` | Tool execution finished |
| `turn_complete` | Turn finished — `data.responseText` has the full output |
| `turn_error` | Turn failed — `data.error` has details |
| `usage` | Token consumption for billing/tracking |

## 4. Manage Sessions

### Close a session

Soft-close a session — disposes it on the server but keeps the local record:

```bash
ahpx session close -n my-task
```

Or by ID:

```bash
ahpx session close <sessionId>
```

### Cancel an active turn

When an agent is stuck or working on the wrong thing:

```bash
ahpx cancel -n my-session
```

### Create a persistent session

For multi-turn work, create a named session first:

```bash
ahpx session new -s local -p copilot -n feature-work --cwd /path/to/project
```

Then send prompts to it:

```bash
ahpx prompt -n feature-work --approve-all "analyze the codebase and create a plan"
ahpx prompt -n feature-work --approve-all "implement the plan"
```

### Switch models mid-conversation

```bash
ahpx model claude-sonnet-4 -n my-session
```

### Import/export sessions

```bash
ahpx session export <id> -o backup.json
ahpx session import backup.json
```

## 5. Fleet Awareness

### List saved servers

```bash
ahpx server list
```

### Health check all servers

```bash
ahpx server status
```

Shows a table with health, latency, session count, and available agents.
Pass `--all` to include unreachable servers.

### Test connectivity to a specific server

```bash
ahpx server test windows-desktop
```

### Browse remote filesystems

When dispatching to a remote server, you need to know where projects live.
`ahpx browse` lists files and directories visible to the server:

```bash
# Browse the server's default directory
ahpx browse --server windows-desktop

# Browse a specific path
ahpx browse /Users/tyler/Code --server windows-desktop
```

This is essential for finding the right `--cwd` value when targeting remote
servers.

### Add a server

```bash
ahpx server add my-server --url ws://192.168.1.50:8082 --default
ahpx server add cloud --url wss://cloud.example.com:8082 --token $TOKEN --tag gpu
```

### Discover available agents and models

```bash
ahpx agents -s my-server
```

## Common Patterns

### Dispatch → get result (one-liner)

Fire-and-forget with structured output:

```bash
result=$(ahpx --format json exec --approve-all "summarize this repository" \
  | grep '"type":"turn_complete"' \
  | jq -r '.data.responseText')
echo "$result"
```

### Dispatch → monitor progress → react

Stream events and react to tool calls as they happen:

```bash
ahpx --format json exec --approve-all "fix failing tests" | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type')
  case "$type" in
    tool_call_start)
      echo "🔧 $(echo "$line" | jq -r '.data.name')"
      ;;
    turn_complete)
      echo "✅ Done"
      ;;
    turn_error)
      echo "❌ $(echo "$line" | jq -r '.data.error')"
      ;;
  esac
done
```

### Multi-turn persistent session

Create a session, send multiple prompts, review results, clean up:

```bash
ahpx session new -s local -n feature-work --cwd /path/to/project
ahpx prompt -n feature-work --approve-all "analyze the codebase"
ahpx prompt -n feature-work --approve-all "implement the changes"
ahpx session history -n feature-work
ahpx session close -n feature-work
```

### Cross-machine dispatch

Dispatch work to a remote server — browse first to find the right path:

```bash
ahpx browse --server windows-desktop
ahpx exec -s windows-desktop --cwd /Users/tyler/Code/dotnet-app --approve-all \
  "build the solution and run all tests"
```

### Fleet health check before dispatching

```bash
ahpx server status
ahpx exec -s cloud --approve-all "deploy the release"
```

### Check on a running session

```bash
ahpx session show -n my-task        # Is it still active?
ahpx watch -n my-task               # Attach and watch live
ahpx session history -n my-task     # What has it done so far?
```

## Output Formats

| Format | Flag | Use when |
|--------|------|----------|
| Text | `--format text` (default) | Interactive terminal use |
| JSON | `--format json` | Programmatic parsing, agent-to-agent |
| Quiet | `--format quiet` | Only care about the final response |

Add `--json-strict` with `--format json` to suppress non-JSON stderr output.

**When automating, always use `--format json`** for structured, parseable output.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error |
| `2` | Invalid arguments |
| `3` | Timeout |
| `4` | No active session found |
| `5` | Permission denied |
| `130` | Interrupted (Ctrl+C) |

## Permission Modes

| Flag | Behavior | Use when |
|------|----------|----------|
| `--approve-all` | Auto-approve everything | Agent-to-agent dispatch, CI/CD |
| `--approve-reads` | Auto reads, prompt for writes | Interactive with safety (default) |
| `--deny-all` | Deny everything | Read-only analysis |

**For agent-to-agent dispatch, always use `--approve-all`.**

## Further Reading

- AHP protocol fundamentals: `.github/skills/ahp-protocol/SKILL.md`
- ahpx architecture internals: `.github/skills/ahpx-architecture/SKILL.md`
- Dispatching agents via AHP: `.github/skills/george-ahp-dispatch/SKILL.md`
