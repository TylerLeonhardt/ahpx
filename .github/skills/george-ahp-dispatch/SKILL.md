---
description: >-
  How to dispatch agents via AHP servers using ahpx. Covers server management,
  one-shot execution, session lifecycle, NDJSON output parsing, and exit code
  handling. Use when George needs to run agents through AHP instead of direct
  CLI spawning.
---

# George AHP Dispatch

ahpx is a CLI client for the Agent Host Protocol. It connects to AHP servers
over WebSocket, manages AI agent sessions, and streams structured output. George
can use ahpx to dispatch agents through AHP servers as an alternative to
spawning Copilot CLI processes directly.

## When to use AHP dispatch

Use AHP dispatch (ahpx) when:

- An AHP server is available (e.g. VS Code Server with `--agent-host-port`)
- You need multi-client observation (watch a session from another process)
- You need structured NDJSON output for reliable event parsing
- You want session persistence across multiple prompts
- You need remote agent execution (server on a different machine)

Use current CLI dispatch when:

- No AHP server is running
- You need a quick local agent run
- The task doesn't require session persistence

## Installation

ahpx is a Node.js CLI. From the ahpx repository:

```bash
npm install && npm run build
npm link   # makes `ahpx` available globally
```

Or invoke directly:

```bash
node /path/to/ahpx/dist/bin.js <command>
```

## Server management

Before dispatching work, configure the target AHP server.

### Add a server

```bash
ahpx server add <name> --url <ws://host:port> [--token <token>] [--default]
```

Example:

```bash
ahpx server add vscode --url ws://localhost:8080 --default
```

### List saved servers

```bash
ahpx server list
```

### Test connectivity

```bash
ahpx connect <name>
```

Connects, performs the AHP initialization handshake, and prints server info
(protocol version, available agents, models). Exit code 0 means the server is
reachable and speaks AHP.

### List available agents

```bash
ahpx agents -s <name>
```

Shows all agent providers and their supported models on the target server.

## One-shot dispatch (`exec`)

The simplest dispatch pattern. Creates a temporary session, runs the prompt,
disposes the session, and exits.

```bash
ahpx exec -s <server> --format json --approve-all "<task description>"
```

### Flags

| Flag | Description |
|------|-------------|
| `-s, --server <name>` | Server name or WebSocket URL |
| `-p, --provider <provider>` | Agent provider (e.g. `copilot`) |
| `-m, --model <model>` | Model to use |
| `--approve-all` | Auto-approve all tool calls and permissions |
| `--approve-reads` | Auto-approve reads, prompt for writes/shell |
| `--deny-all` | Auto-deny all permissions |
| `--format json` | Global option — NDJSON output to stdout |
| `--json-strict` | Global option — suppress non-JSON stderr |

### Example

```bash
ahpx exec \
  -s vscode \
  --format json \
  --json-strict \
  --approve-all \
  "Fix the failing test in src/auth.test.ts. The test expects a 401 status but gets 403."
```

Output is NDJSON on stdout. Exit code indicates success or failure.

## Session-based dispatch

For tasks requiring multiple prompts, observation from other processes, or
persistent context.

### Create a named session

```bash
ahpx session new \
  -s <server> \
  -p <provider> \
  -n <session-name> \
  --cwd <working-directory>
```

Example:

```bash
ahpx session new -s vscode -p copilot -n "job-a1b2c3" --cwd /projects/myapp
```

### Send a prompt to a named session

```bash
ahpx prompt \
  -s <server> \
  -n <session-name> \
  --format json \
  --approve-all \
  "<task description>"
```

### Watch a session from another process

```bash
ahpx watch \
  -s <server> \
  -n <session-name> \
  --format json
```

Attaches as a read-only observer and streams all session activity as NDJSON.
Does not participate in permission confirmations. Press Ctrl+C to detach.

### Close a session

```bash
ahpx session close -s <server> -n <session-name>
```

### Full session lifecycle

```bash
# 1. Create session
ahpx session new -s vscode -p copilot -n "task-42" --cwd /projects/myapp

# 2. Run the task
ahpx prompt -s vscode -n "task-42" --format json --approve-all "implement the feature"

# 3. (Optional) Send follow-up prompts
ahpx prompt -s vscode -n "task-42" --format json --approve-all "now write tests for it"

# 4. Clean up
ahpx session close -s vscode -n "task-42"
```

## NDJSON output format

When `--format json` is set, ahpx writes one JSON object per line to stdout.

### Envelope structure

```json
{ "type": "<event_type>", "timestamp": "<ISO 8601>", "data": { ... } }
```

### Event types

| Type | Data fields | Description |
|------|-------------|-------------|
| `delta` | `{ content: string }` | Streaming text chunk from the model |
| `reasoning` | `{ content: string }` | Model reasoning/thinking text |
| `tool_call_start` | `{ toolCallId, name }` | Tool invocation began |
| `tool_call_delta` | `{ toolCallId, content }` | Streaming tool parameters |
| `tool_call_ready` | `{ toolCallId, toolName, displayName, invocationMessage, toolInput? }` | Tool parameters complete |
| `tool_call_complete` | `{ toolCallId, result }` | Tool execution finished |
| `tool_call_cancelled` | `{ toolCallId, reason }` | Tool call was denied or skipped |
| `permission` | `{ request: IPermissionRequest }` | Permission request (auto-handled in approve-all mode) |
| `usage` | `{ usage: { inputTokens, outputTokens, model? } }` | Token usage report |
| `turn_complete` | `{ responseText }` | Turn finished — contains the full accumulated response |
| `turn_error` | `{ error: { message, code? } }` | Turn failed |
| `turn_cancelled` | `{}` | Turn was cancelled |
| `title_changed` | `{ title }` | Server updated the session title |

### Parsing NDJSON

Each line is independent valid JSON. Parse line by line:

```typescript
for (const line of stdout.split("\n").filter(Boolean)) {
  const event = JSON.parse(line);
  switch (event.type) {
    case "delta":
      // Accumulate streaming text
      text += event.data.content;
      break;
    case "tool_call_start":
      // Track active tool calls
      break;
    case "turn_complete":
      // Final response text in event.data.responseText
      break;
    case "turn_error":
      // Error details in event.data.error
      break;
  }
}
```

### Key events for George

For job status determination:

- **`turn_complete`** → job succeeded, `data.responseText` has the final output
  (including the `## Agent Summary` block)
- **`turn_error`** → job failed, `data.error.message` has the reason
- **`turn_cancelled`** → job was cancelled
- **`delta`** → streaming progress (accumulate for rolling output buffer)
- **`tool_call_start`** / **`tool_call_complete`** → track tool execution for
  activity monitoring

## Exit codes

| Code | Meaning | George job status mapping |
|------|---------|--------------------------|
| `0` | Success | `completed` |
| `1` | Runtime error | `failed` |
| `2` | Usage error (bad args) | `failed` (config issue) |
| `3` | Timeout | `timeout` |
| `4` | No session found | `failed` (session issue) |
| `5` | Permission denied | `failed` (permission issue) |
| `130` | Interrupted (SIGINT) | `cancelled` |

## Configuration for non-interactive use

ahpx supports layered configuration. For automated dispatch, set defaults in
a global config file at `~/.ahpx/config.json`:

```json
{
  "permissions": "approve-all",
  "format": "json",
  "timeout": 300
}
```

Or use project-level config at `.ahpxrc.json` in the working directory.

CLI flags always override config file values.

### Environment variables

- `AHPX_TOKEN` — authentication token (avoids passing `--token` on every call)

## Building the delegation prompt

George's delegation prompt works the same way with ahpx as with direct CLI
dispatch. The task description passed to `ahpx exec` or `ahpx prompt` IS the
user message that starts the agent turn.

```bash
ahpx exec -s vscode --format json --json-strict --approve-all \
  "$(cat <<'EOF'
George (the CTO) has given you this direction:

Fix the authentication bug in src/auth/handler.ts. Users are getting 403
instead of 401 when their token expires.

## Agent Summary format
End your work with:
**Status:** completed (or failed)
**What was done:** ...
**What worked:** ...
**What failed:** ...
**Follow-up recommendations:** ...
EOF
)"
```

The `## Agent Summary` block in `turn_complete.data.responseText` can be parsed
with `parseAgentSummary()` exactly as with current dispatch.

## Dispatch workflow for George

```
┌─────────┐     spawn      ┌──────┐    WebSocket    ┌────────────┐
│  George  │ ──────────────→│ ahpx │ ──────────────→ │ AHP Server │
│  (CTO)   │                │ CLI  │                  │ (VS Code)  │
└─────────┘                └──────┘                  └────────────┘
     │                         │                           │
     │  Read stdout (NDJSON)   │   JSON-RPC / Actions      │
     │ ◄──────────────────────│ ◄─────────────────────────│
     │                         │                           │
     │  Check exit code        │   Session cleanup          │
     │ ◄──────────────────────│ ──────────────────────────→│
```

1. **Spawn**: George spawns `ahpx exec` with the task prompt
2. **Stream**: George reads NDJSON from stdout for progress monitoring
3. **Complete**: George checks exit code for success/failure
4. **Parse**: George extracts `## Agent Summary` from `turn_complete` event
5. **Report**: George updates job status and notifies the user

## Starting an AHP server

To start a VS Code AHP server for ahpx to connect to:

```bash
# From the VS Code repository
./scripts/code-server.sh --agent-host-port 8080
```

Then register it:

```bash
ahpx server add vscode --url ws://localhost:8080 --default
ahpx connect vscode  # verify
```
