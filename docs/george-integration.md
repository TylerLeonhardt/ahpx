# George Integration Guide

How George (the CTO bot) uses ahpx to dispatch agents via AHP servers.

## Overview

George currently dispatches agents by spawning Copilot CLI processes (V1) or
acpx processes (V2). ahpx adds a third dispatch path: agents running through
AHP (Agent Host Protocol) servers. This enables structured NDJSON output,
session persistence, multi-client observation, and remote agent execution.

```
┌─────────┐     spawn      ┌──────┐    WebSocket    ┌────────────┐     AI     ┌───────┐
│  George  │───────────────→│ ahpx │───────────────→ │ AHP Server │ ─────────→│ Agent │
│  (CTO)   │  (child proc)  │ CLI  │  (JSON-RPC 2.0) │ (VS Code)  │           │Backend│
└─────────┘                └──────┘                  └────────────┘           └───────┘
     │                         │                           │
     │  stdout (NDJSON)        │   Actions (streaming)     │
     │ ◄───────────────────── │ ◄─────────────────────── │
     │                         │                           │
     │  exit code              │   Session dispose         │
     │ ◄───────────────────── │ ──────────────────────── →│
```

## Prerequisites

### 1. Build ahpx

```bash
cd /path/to/ahpx
npm install
npm run build
npm link  # optional: makes `ahpx` available on PATH
```

The binary is at `dist/bin.js` with a Node.js shebang. After `npm link`, it's
available as `ahpx`.

### 2. Start an AHP server

ahpx needs an AHP server to connect to. Currently, VS Code Server exposes one:

```bash
# From a VS Code repository checkout
./scripts/code-server.sh --agent-host-port 8080
```

This starts a VS Code Server with an AHP endpoint at `ws://localhost:8080`.

### 3. Register the server

```bash
ahpx server add vscode --url ws://localhost:8080 --default
```

Verify connectivity:

```bash
ahpx connect vscode
# Shows: protocol version, available agents, models
```

## Dispatch workflow

### One-shot dispatch (recommended for most tasks)

The simplest integration. George spawns `ahpx exec`, reads NDJSON from stdout,
and checks the exit code.

```bash
ahpx exec \
  -s vscode \
  --format json \
  --json-strict \
  --approve-all \
  "Fix the failing test in src/auth.test.ts"
```

**What happens:**
1. ahpx connects to the AHP server
2. Creates a temporary session
3. Sends the prompt as a new turn
4. Streams NDJSON events to stdout (deltas, tool calls, completion)
5. Disposes the session
6. Exits with code 0 (success) or non-zero (failure)

**George's responsibilities:**
- Spawn the process with appropriate cwd
- Capture stdout for NDJSON events
- Capture stderr for diagnostics (if not `--json-strict`)
- Check exit code for job status
- Parse `## Agent Summary` from the `turn_complete` event

### Session-based dispatch (for multi-turn tasks)

When a task requires multiple prompts or observation from another process:

```bash
# 1. Create a named session
ahpx session new -s vscode -p copilot -n "job-${JOB_ID}" --cwd "${PROJECT_DIR}"

# 2. Send the task
ahpx prompt -s vscode -n "job-${JOB_ID}" --format json --approve-all "${TASK}"

# 3. (Optional) Watch from another process
ahpx watch -s vscode -n "job-${JOB_ID}" --format json

# 4. (Optional) Send follow-up prompts
ahpx prompt -s vscode -n "job-${JOB_ID}" --format json --approve-all "${FOLLOW_UP}"

# 5. Clean up
ahpx session close -s vscode -n "job-${JOB_ID}"
```

## Configuring ahpx for non-interactive use

When George spawns ahpx, there's no human at the terminal. Configure
accordingly:

### Required flags for automated dispatch

| Flag | Purpose |
|------|---------|
| `--format json` | Structured NDJSON output instead of colored text |
| `--json-strict` | Suppress non-JSON stderr (clean machine-readable output) |
| `--approve-all` | Auto-approve all tool calls and permissions |

### Optional flags

| Flag | Purpose |
|------|---------|
| `-s, --server <name>` | Target server (or uses default) |
| `-p, --provider <provider>` | Agent provider (e.g. `copilot`) |
| `-m, --model <model>` | Override model selection |

### Global config

Instead of passing flags every time, set defaults in `~/.ahpx/config.json`:

```json
{
  "defaultServer": "vscode",
  "permissions": "approve-all",
  "format": "json",
  "timeout": 300
}
```

### Authentication

Set `AHPX_TOKEN` environment variable to provide auth tokens without
interactive prompting:

```bash
AHPX_TOKEN="<token>" ahpx exec -s vscode --format json --approve-all "do the thing"
```

Or store it persistently (auto-handled by ahpx on first interactive auth).

## Parsing NDJSON output

ahpx emits one JSON object per line to stdout when `--format json` is active.

### Envelope format

```json
{ "type": "delta", "timestamp": "2026-03-20T15:00:00.000Z", "data": { "content": "Hello" } }
```

### Event types reference

| Type | Data | Description |
|------|------|-------------|
| `delta` | `{ content }` | Streaming text from the model |
| `reasoning` | `{ content }` | Model thinking/reasoning text |
| `tool_call_start` | `{ toolCallId, name }` | Tool invocation started |
| `tool_call_delta` | `{ toolCallId, content }` | Streaming tool parameters |
| `tool_call_ready` | `{ toolCallId, toolName, displayName, invocationMessage, toolInput? }` | Tool parameters complete |
| `tool_call_complete` | `{ toolCallId, result }` | Tool finished executing |
| `tool_call_cancelled` | `{ toolCallId, reason }` | Tool was denied/skipped |
| `permission` | `{ request }` | Permission request (auto-handled with `--approve-all`) |
| `usage` | `{ usage: { inputTokens, outputTokens, model? } }` | Token usage stats |
| `turn_complete` | `{ responseText }` | Turn finished — full response text |
| `turn_error` | `{ error: { message, code? } }` | Turn failed |
| `turn_cancelled` | `{}` | Turn was cancelled |
| `title_changed` | `{ title }` | Session title updated |

### Events that matter most to George

**For job output collection:**
- `delta` events — accumulate `data.content` for rolling output buffer
- `tool_call_start` / `tool_call_complete` — track tool execution activity

**For job completion:**
- `turn_complete` — job succeeded; `data.responseText` contains the full
  response including the `## Agent Summary` block
- `turn_error` — job failed; `data.error.message` explains why
- `turn_cancelled` — job was cancelled

**For progress monitoring:**
- `delta` events indicate the agent is actively generating text
- `tool_call_start` events indicate tool execution (activity heartbeat)
- Absence of any events for an extended period may indicate a stall

### Parsing example (TypeScript)

```typescript
import { spawn } from "node:child_process";

function dispatchViaAhp(server: string, task: string): Promise<{
  exitCode: number;
  responseText: string;
  events: Array<{ type: string; timestamp: string; data: Record<string, unknown> }>;
}> {
  return new Promise((resolve) => {
    const proc = spawn("ahpx", [
      "exec", "-s", server,
      "--format", "json", "--json-strict", "--approve-all",
      task,
    ], { cwd: projectDir });

    const events: Array<{ type: string; timestamp: string; data: Record<string, unknown> }> = [];
    let responseText = "";
    let buffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);

          if (event.type === "delta") {
            responseText += event.data.content;
          } else if (event.type === "turn_complete") {
            responseText = event.data.responseText;
          }
        } catch {
          // Skip malformed lines
        }
      }
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, responseText, events });
    });
  });
}
```

## Exit codes

| Code | Meaning | George `AgentJobStatus` |
|------|---------|------------------------|
| `0` | Success | `completed` |
| `1` | Runtime error | `failed` |
| `2` | Bad arguments | `failed` |
| `3` | Timeout | `timeout` |
| `4` | No session found | `failed` |
| `5` | Permission denied | `failed` |
| `130` | Interrupted (SIGINT) | `cancelled` |

## Example: George dispatching a bug fix

Here's a complete example of how George would dispatch a bug fix through AHP:

```typescript
// In George's agent dispatcher
const job = createJob({
  projectId: "myapp",
  task: "Fix authentication returning 403 instead of 401 on expired tokens",
  userId: chatUserId,
});

// Build the delegation prompt (same as current dispatch)
const prompt = buildDelegationPrompt({
  task: job.task,
  projectName: "myapp",
  issueNumber: 42,
  branch: "fix/auth-403",
});

// Spawn ahpx
const proc = spawn("ahpx", [
  "exec",
  "-s", "vscode",
  "--format", "json",
  "--json-strict",
  "--approve-all",
  prompt,
], {
  cwd: "/projects/myapp",
  env: { ...process.env, AHPX_TOKEN: authToken },
});

// Capture output
const outputLines: string[] = [];
let lastActivity = Date.now();

proc.stdout.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      lastActivity = Date.now();

      if (event.type === "delta") {
        outputLines.push(event.data.content);
      } else if (event.type === "tool_call_start") {
        // Activity heartbeat — agent is working
      } else if (event.type === "turn_complete") {
        job.result = event.data.responseText;
        job.summary = parseAgentSummary(event.data.responseText);
      } else if (event.type === "turn_error") {
        job.error = event.data.error.message;
      }
    } catch { /* skip */ }
  }
});

// Handle completion
proc.on("close", (exitCode) => {
  job.exitCode = exitCode;
  job.status = exitCode === 0 ? "completed"
    : exitCode === 130 ? "cancelled"
    : exitCode === 3 ? "timeout"
    : "failed";
  job.completedAt = new Date().toISOString();
});

// Inactivity timeout
const timer = setInterval(() => {
  if (Date.now() - lastActivity > job.timeoutMinutes * 60 * 1000) {
    proc.kill("SIGTERM");
    job.status = "timeout";
    clearInterval(timer);
  }
}, 30_000);
```

## Comparison with existing dispatch methods

| Feature | V1 (Copilot CLI) | V2 (acpx) | AHP (ahpx) |
|---------|-------------------|-----------|-------------|
| Protocol | Proprietary PTY | ACP | AHP (WebSocket + JSON-RPC) |
| Output | Raw text (PTY scraping) | NDJSON | NDJSON |
| Session persistence | No | No | Yes |
| Multi-client observation | No | No | Yes (`watch`) |
| Remote execution | No | No | Yes (any WebSocket endpoint) |
| Tool call tracking | Heuristic | Structured | Structured |
| Exit codes | Process-level | Process-level | Semantic (0-5, 130) |
| Permission handling | CLI flags | CLI flags | CLI flags + config file |

## Troubleshooting

### Connection refused

```
Error: connect ECONNREFUSED ws://localhost:8080
```

The AHP server isn't running. Start it:
```bash
./scripts/code-server.sh --agent-host-port 8080
```

### No agents available

```bash
ahpx agents -s vscode
# (empty list)
```

The server has no agent providers registered. This usually means the Copilot
extension isn't loaded in VS Code Server.

### Session not found (exit code 4)

The session was disposed or never created. For one-shot dispatch, use
`ahpx exec` which handles session lifecycle automatically.

### Permission denied (exit code 5)

Running without `--approve-all` in a non-interactive context. Always pass
`--approve-all` for automated dispatch.
