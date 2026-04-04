# ahpx

**Agent Host Protocol client** — CLI and Node.js library for managing AHP server connections, sessions, and agent interactions.

[![CI](https://github.com/TylerLeonhardt/ahpx/actions/workflows/ci.yml/badge.svg)](https://github.com/TylerLeonhardt/ahpx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tylerl0706/ahpx)](https://www.npmjs.com/package/@tylerl0706/ahpx)

## What is ahpx?

ahpx is a client for the [Agent Host Protocol](https://github.com/anthropics/agent-host-protocol) (AHP) — a WebSocket-based JSON-RPC protocol for managing AI agent sessions. Use ahpx to connect to AHP servers, create sessions, send prompts, stream responses, and handle tool confirmations, either from the command line or programmatically as a Node.js library.

## Features

- 🔌 **Connect to AHP servers** via WebSocket with saved connection profiles
- 💬 **Interactive and one-shot prompting** with streaming output
- 📡 **Multi-session management** — concurrent sessions on a single connection
- 🔄 **Event forwarding** — webhook and WebSocket targets for dashboards and pipelines
- 🏗️ **Fleet management** — health checks, status monitoring, and server tagging
- 💾 **Session persistence** — resume sessions, export/import history
- 📦 **Use as CLI or Node.js library** with full TypeScript types
- 🔒 **Configurable permission modes** — approve-all, approve-reads, deny-all

## Quick Start

```bash
npm install -g @tylerl0706/ahpx

# Add a server
ahpx server add local --url ws://localhost:8082 --default

# Start prompting
ahpx "what files are in this directory?"
```

Or use `exec` for one-shot tasks that create and dispose of a session automatically:

```bash
ahpx exec "summarize this repo"
```

## CLI Commands

### Prompting

| Command | Description |
|---------|-------------|
| `ahpx <text>` | Send a prompt (implicit — any text that isn't a command) |
| `ahpx prompt <text>` | Send a prompt to an existing session |
| `ahpx exec <text>` | One-shot: create a temp session, prompt, dispose |
| `ahpx cancel` | Cancel the active turn in a session |

Prompt options: `-s <server>`, `-n <session-name>`, `-f <file>`, `--cwd <dir>`, `--approve-all`, `--approve-reads`, `--deny-all`, `--idle-timeout <seconds>`, `--tag <key=value>`, `--forward-webhook <url>`, `--forward-ws <url>`, `--forward-filter <types>`, `--forward-headers <json>`

`exec` also accepts: `-p <provider>`, `-m <model>`

### Server Management

| Command | Description |
|---------|-------------|
| `ahpx server add <name> --url <url>` | Save a named connection profile |
| `ahpx server list` | List saved connections |
| `ahpx server remove <name>` | Remove a saved connection |
| `ahpx server test <target>` | Test connectivity to a server |
| `ahpx server status` | Health check all saved servers |
| `ahpx server health <name>` | Detailed health check for a single server |

`server add` options: `--token <token>`, `--default`, `--tag <tag>` (repeatable)

### Session Management

| Command | Description |
|---------|-------------|
| `ahpx session new` | Create a new agent session |
| `ahpx session list` | List sessions (default: active only) |
| `ahpx session show [id]` | Show session details |
| `ahpx session close [id]` | Close a session (keeps record for history) |
| `ahpx session history [id]` | Show turn history for a session |
| `ahpx session active` | Show all active sessions on the server (live query) |
| `ahpx session export <id>` | Export a session record to JSON |
| `ahpx session import <file>` | Import a session record from JSON |

`session new` options: `-s <server>`, `-p <provider>`, `-m <model>`, `-n <name>`, `--cwd <dir>`, `-t <timeout>`

### Configuration

| Command | Description |
|---------|-------------|
| `ahpx config show` | Print resolved config with source annotations |
| `ahpx config init` | Create `~/.ahpx/config.json` with defaults |

### Utilities

| Command | Description |
|---------|-------------|
| `ahpx connect [target]` | Connect to a server and print server info |
| `ahpx agents` | List available agents and models on the server |
| `ahpx content <uri>` | Fetch content by URI from the server |
| `ahpx model <model-id>` | Switch the model for a session |
| `ahpx watch [id]` | Attach to a session as an observer and stream activity |
| `ahpx browse [directory]` | Browse server filesystem |
| `ahpx completions bash\|zsh\|fish` | Generate shell completion scripts |

### Global Options

| Flag | Description |
|------|-------------|
| `--format <format>` | Output format: `text`, `json`, or `quiet` (default: `text`) |
| `--json-strict` | Suppress non-JSON stderr output (use with `--format json`) |
| `-v, --verbose` | Enable debug logging to stderr |
| `--version` | Print version |
| `--help` | Show help |

## Library Usage

ahpx exports a full TypeScript API. Install it as a dependency:

```bash
npm install @tylerl0706/ahpx
```

### Connect and list agents

```typescript
import { AhpClient } from '@tylerl0706/ahpx';

const client = new AhpClient({ initialSubscriptions: ['agenthost:/root'] });
const result = await client.connect('ws://localhost:8082');

console.log('Agents:', result.agents);
console.log('Connected:', client.connected);

await client.disconnect();
```

### Create a session and send a prompt

```typescript
import { AhpClient, ActionType } from '@tylerl0706/ahpx';
import { randomUUID } from 'node:crypto';

const client = new AhpClient({ initialSubscriptions: ['agenthost:/root'] });
await client.connect('ws://localhost:8082');

// Create a session
const sessionUri = `copilot:/${randomUUID()}`;
await client.createSession(sessionUri, { provider: 'copilot' });
await client.subscribe(sessionUri);

// Listen for streaming events
client.on('action', (envelope) => {
  const { action } = envelope;
  switch (action.type) {
    case ActionType.SessionDelta:
      process.stdout.write(action.content);
      break;
    case ActionType.SessionTurnComplete:
      console.log('\n--- Turn complete ---');
      break;
    case ActionType.SessionError:
      console.error('Error:', action.error);
      break;
  }
});

// Send a prompt
client.dispatchAction({
  type: ActionType.SessionTurnStarted,
  session: sessionUri,
  turnId: randomUUID(),
  userMessage: { text: 'Fix the failing test' },
});
```

### Handle authentication

```typescript
import { AhpClient, AuthHandler } from '@tylerl0706/ahpx';

const client = new AhpClient();
const auth = new AuthHandler(client, { token: process.env.MY_TOKEN });

client.on('notification', async (notification) => {
  if (notification.type === 'authRequired') {
    await auth.handleAuthRequired(notification.resource);
  }
});

await client.connect('ws://localhost:8082');
```

### Read state from the state mirror

```typescript
const client = new AhpClient();
await client.connect('ws://localhost:8082');

// Root state (agents, active sessions)
console.log('Agents:', client.state.root.agents);

// Session state (after subscribing)
const session = client.state.getSession('copilot:/my-session');
console.log('Title:', session?.summary?.title);
console.log('Active turn:', session?.activeTurn);
```

### Error handling

```typescript
import { AhpClient, RpcError, RpcTimeoutError } from '@tylerl0706/ahpx';

const client = new AhpClient();

try {
  await client.connect('ws://localhost:8082');
} catch (err) {
  if (err instanceof RpcTimeoutError) {
    console.error(`Request ${err.method} timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof RpcError) {
    console.error(`RPC error ${err.code}: ${err.message}`);
  }
}
```

### Additional APIs

- **`SessionHandle`** — per-session wrapper with scoped event listeners and lifecycle management
- **`ConnectionPool`** — connection reuse across multiple sessions to the same server
- **`WebhookForwarder` / `WebSocketForwarder`** — forward NDJSON events to external targets
- **`HealthChecker`** — fleet-level health monitoring across saved servers

See the exported TypeScript declarations for the full API reference.

## Exit Codes

ahpx uses semantic exit codes so scripts and automation can react to failures:

| Code | Meaning | Description |
|------|---------|-------------|
| `0` | Success | Command completed successfully |
| `1` | Runtime error | Unexpected error during execution |
| `2` | Usage error | Bad CLI arguments or missing required flags |
| `3` | Timeout | Connection or request timed out |
| `4` | No session | Session not found — run `session new` first |
| `5` | Permission denied | All permission requests were denied |
| `130` | Interrupted | Process was interrupted (Ctrl+C) |

See [docs/errors.md](docs/errors.md) for the full error reference.

## Configuration

ahpx uses a layered configuration system. Settings are resolved in order of precedence:

1. **CLI flags** — highest priority (e.g. `--format json`)
2. **Project config** — `.ahpxrc.json` in the current directory or git root
3. **Global config** — `~/.ahpx/config.json`
4. **Defaults** — built-in fallback values

```bash
# Initialize global config
ahpx config init

# View resolved config with source annotations
ahpx config show
```

## Documentation

| Document | Description |
|----------|-------------|
| [PUBLISHING.md](PUBLISHING.md) | Publishing setup — OIDC trusted publishers, auto-bump pipeline, first-time config |
| [docs/quick-reference.md](docs/quick-reference.md) | One-page command cheat sheet |
| [docs/user-guide.md](docs/user-guide.md) | Comprehensive user guide — CLI reference, SDK API, architecture |
| [docs/roadmap.md](docs/roadmap.md) | v0.2 roadmap with phase details and acceptance criteria |
| [docs/errors.md](docs/errors.md) | Error catalog and exit code reference |
| [docs/george-integration.md](docs/george-integration.md) | Integration guide for George agent dispatch |
| [docs/protocol-feedback.md](docs/protocol-feedback.md) | AHP protocol gap analysis and workarounds |

## Development

Requires Node.js ≥ 20.

```bash
npm install          # Install dependencies
npm run build        # Build with tsup
npm run dev          # Watch mode
npm run typecheck    # Type check with tsc
npm run lint         # Lint with Biome
npm test             # Run tests with Vitest
```

All four quality gates must pass before committing:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Contributing

Project knowledge lives in `.github/` so both humans and agents can find it:

- **[`.github/skills/ahp-protocol/`](.github/skills/ahp-protocol/SKILL.md)** — AHP protocol fundamentals
- **[`.github/skills/ahpx-architecture/`](.github/skills/ahpx-architecture/SKILL.md)** — Codebase architecture and design
- **[`.github/agents/team-lead.md`](.github/agents/team-lead.md)** — Team lead agent with quality gates and workflow

Read the relevant skill docs before making changes — they'll save you time.

## License

MIT
