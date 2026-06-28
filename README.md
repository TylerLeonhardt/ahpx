# ahpx

**Agent Host Protocol CLI** — a thin command-line wrapper around the official [`@microsoft/agent-host-protocol`](https://www.npmjs.com/package/@microsoft/agent-host-protocol) client for managing AHP server connections, sessions, and agent interactions.

[![CI](https://github.com/TylerLeonhardt/ahpx/actions/workflows/ci.yml/badge.svg)](https://github.com/TylerLeonhardt/ahpx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tylerl0706/ahpx)](https://www.npmjs.com/package/@tylerl0706/ahpx)

## What is ahpx?

ahpx is a **command-line client** for the Agent Host Protocol (AHP) — a WebSocket-based JSON-RPC protocol for managing AI agent sessions. Use ahpx to connect to AHP servers, create sessions, send prompts, stream responses, and handle tool confirmations from your terminal.

ahpx is a thin CLI wrapper: the protocol client itself is the official
`@microsoft/agent-host-protocol` package. ahpx focuses on the command-line
experience — connection profiles, session persistence, output formatting, fleet
health, dev tunnels — and delegates the wire protocol to the official client.

> **Not a library.** ahpx no longer ships an exported SDK. If you need to speak
> AHP programmatically, depend on
> [`@microsoft/agent-host-protocol`](https://www.npmjs.com/package/@microsoft/agent-host-protocol)
> directly. ahpx exposes only the `ahpx` CLI.

## Features

- 🔌 **Connect to AHP servers** via WebSocket with saved connection profiles
- 💬 **Interactive and one-shot prompting** with streaming output
- 📡 **Multi-session management** — concurrent sessions on a single connection
- 🔄 **Event forwarding** — webhook and WebSocket targets for dashboards and pipelines
- 🏗️ **Fleet management** — health checks, status monitoring, and server tagging
- 💾 **Session persistence** — resume sessions, export/import history
- 🔒 **Configurable permission modes** — approve-all, approve-reads, deny-all, autopilot
- 🔑 **Automatic auth** — token resolution from env vars, CLI, or interactive prompt
- 🌐 **Dev Tunnel support** — connect to remote agent hosts via Dev Tunnels
- ⚙️ **Session config** — agent-specific settings (auto-approve, isolation, mode)
- 🧩 **Customizations** — auto-discovered agent and skill files from `.github/`

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

Prompt options: `-s <server>`, `-n <session-name>`, `-S <session-id>`, `-f <file>`, `--cwd <dir>`, `--config <key=value>` (repeatable), `--approve-all`, `--approve-reads`, `--deny-all`, `--idle-timeout <seconds>`, `--tag <key=value>`, `--forward-webhook <url>`, `--forward-ws <url>`, `--forward-filter <types>`, `--forward-headers <json>`

Use `-S <session-id>` to target a session by its ID instead of name — useful for scripting and automation.

`exec` also accepts: `-p <provider>`, `-m <model>`, `--config <key=value>`

### Server Management

| Command | Description |
|---------|-------------|
| `ahpx server add <name> --url <url>` | Save a named connection profile |
| `ahpx server list` | List saved connections |
| `ahpx server remove <name>` | Remove a saved connection |
| `ahpx server test <target>` | Test connectivity to a server |
| `ahpx server status` | Health check all saved servers |
| `ahpx server health <name>` | Detailed health check for a single server |

`server add` options: `--token <token>`, `--default`, `--tag <tag>` (repeatable), `--tunnel <tunnel-id>`

### Dev Tunnels

Connect to remote AHP agent hosts via Dev Tunnels. Discovers tunnels tagged with `protocolv5`. Requires `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`.

| Command | Description |
|---------|-------------|
| `ahpx tunnel list` | List remote agent hosts |
| `ahpx tunnel connect <tunnel-id>` | Connect to a remote agent host |

```bash
# Save a tunnel as a named server connection
ahpx server add my-remote --tunnel <tunnel-id>

# Use the remote server for sessions
ahpx session new -s my-remote -n remote-session --cwd C:/Users/me/project
ahpx prompt -s my-remote -n remote-session "fix the bug"
```

### Session Management

| Command | Description |
|---------|-------------|
| `ahpx session new` | Create a new agent session |
| `ahpx session list` | List sessions (default: active only) |
| `ahpx session show [id]` | Show session details |
| `ahpx session close [id]` | Close a session (keeps record for history) |
| `ahpx session history [id]` | Show turn history for a session (`--full` for complete transcript) |
| `ahpx session active` | Show all active sessions on the server (live query) |
| `ahpx session config` | View session configuration |
| `ahpx session config set <key> <value>` | Set a mutable config property |
| `ahpx session customization list` | List customizations on a session |
| `ahpx session customization toggle <uri>` | Toggle a customization on/off |
| `ahpx session export <id\|name>` | Export a session's full transcript (json record or markdown) |
| `ahpx session import <file>` | Import a session record from JSON |

`session new` options: `-s <server>`, `-p <provider>`, `-m <model>`, `-n <name>`, `--cwd <dir>`, `-t <timeout>`, `--config <key=value>` (repeatable), `--no-customizations`

#### Session Config

Set agent-specific configuration at session creation or modify it on an active session.

```bash
ahpx session new -n my-session --cwd /path/to/repo --config autoApprove=autopilot --config isolation=worktree
ahpx session config -n my-session              # view config
ahpx session config set autoApprove autopilot -n my-session   # update config
```

Available config keys depend on the agent. For `copilotcli`: `autoApprove` (default/autoApprove/autopilot), `isolation` (folder/worktree), `mode` (interactive/plan), `branch`, `permissions`.

#### Transcripts & history

Every completed turn is persisted locally with its **complete** prompt and response text
(not just a preview), so the full transcript survives `session close` and host disposal.

```bash
ahpx session history my-session                 # compact: one truncated line per turn
ahpx session history my-session --full          # complete prompt + response for every turn
ahpx --format json session history my-session   # adds the full `response`/`prompt` per turn

ahpx session export my-session                          # json record (re-importable, full turns)
ahpx session export my-session --format markdown        # human-readable transcript to stdout
ahpx session export my-session --format markdown --out transcript.md
```

`session export` and `session history` accept the session **name** positionally. Records
written before 0.4.0 only have a 200-char preview; those turns render the preview with a
clear "full text not recorded — pre-0.4.0 session" note (no migration required).

#### Customizations

ahpx automatically discovers `.github/agents/*.md` and `.github/skills/*/SKILL.md` files in the workspace and loads them into the agent session. Use `--no-customizations` to skip discovery.

```bash
ahpx session customization list -n my-session
ahpx session customization toggle <uri> -n my-session
```

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

## Using AHP programmatically

ahpx is a CLI, not a library — it does not export an SDK. To speak the Agent
Host Protocol from your own Node.js or TypeScript code, depend on the official
client directly:

```bash
npm install @microsoft/agent-host-protocol
```

```typescript
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';

// See the @microsoft/agent-host-protocol docs for the full client API.
```

ahpx itself is built on top of this package and simply adds a polished
command-line experience (connection profiles, session persistence, output
formatting, fleet health, dev tunnels) around it.

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

## Authentication

ahpx resolves auth tokens automatically, checked in order:

1. Connection profile token (from `ahpx server add --token`)
2. `AHPX_TOKEN` env var
3. `GITHUB_TOKEN` env var
4. `GH_TOKEN` env var
5. `gh auth token` CLI output
6. Interactive prompt

No explicit login command is needed — just ensure one of the above is available.

## Approval Flow

When an agent calls a tool, ahpx handles approval based on the tool's confirmation status:

- **Server-confirmed tools** — show `[auto-approved]` and proceed without prompting.
- **Unconfirmed tools** — show `Allow Tool: ...? (y/N):` and wait for user input.

Override with flags or session config:

```bash
ahpx exec --approve-all "fix the tests"                         # skip all prompts
ahpx exec --config autoApprove=autopilot "fix the tests"        # server-side auto-approval
```

## Documentation

| Document | Description |
|----------|-------------|
| [PUBLISHING.md](PUBLISHING.md) | Publishing setup — OIDC trusted publishers, auto-bump pipeline, first-time config |
| [docs/quick-reference.md](docs/quick-reference.md) | One-page command cheat sheet |
| [docs/user-guide.md](docs/user-guide.md) | Comprehensive user guide — CLI reference and architecture |
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
