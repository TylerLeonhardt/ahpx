# ahpx

> ⚠️ **Under development** — This project is in early development and not yet ready for production use.

**Agent Host Protocol CLI** — manage AHP server connections, sessions, and agent interactions from the command line.

## What is AHP?

The [Agent Host Protocol](https://github.com/anthropics/agent-host-protocol) (AHP) is a WebSocket-based JSON-RPC protocol for managing AI agent sessions. It provides a standardized way to:

- Connect to agent backends (e.g. GitHub Copilot)
- Create and manage chat sessions
- Stream responses and tool calls in real-time
- Handle permissions and tool confirmations

`ahpx` is a CLI client that speaks this protocol.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
./dist/bin.js connect ws://localhost:3000

# Or link globally
npm link
ahpx connect ws://localhost:3000
```

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Lint
npm run lint

# Watch mode
npm run dev
```

## Contributing

Project knowledge lives in `.github/` so both humans and agents can find it:

- **[`.github/skills/ahp-protocol/`](.github/skills/ahp-protocol/SKILL.md)** — AHP protocol fundamentals: state model, actions, JSON-RPC commands, connection lifecycle
- **[`.github/skills/ahpx-architecture/`](.github/skills/ahpx-architecture/SKILL.md)** — Codebase architecture: 3-layer client, sessions, prompting, config
- **[`.github/agents/team-lead.md`](.github/agents/team-lead.md)** — Team lead agent definition with quality gates and workflow

Before making changes, read the relevant skill docs. They'll save you time and help you make better decisions.

### Quality gates

All must pass before committing:

```bash
npm run typecheck   # Zero type errors
npm run lint        # Zero lint violations
npm test            # All tests pass
npm run build       # Clean build
```

## George Integration

ahpx can be used as an agent dispatch backend for [George](https://github.com/TylerLeonhardt/copilot-chat-bridge) (CTO bot). George spawns `ahpx exec` with `--format json --approve-all` to dispatch agents through AHP servers, getting structured NDJSON output and semantic exit codes.

```bash
ahpx exec -s vscode --format json --json-strict --approve-all "fix the bug"
```

Key capabilities for George:
- **One-shot dispatch** via `ahpx exec` (session lifecycle handled automatically)
- **Session persistence** for multi-turn tasks via `ahpx session new` / `ahpx prompt`
- **Multi-client observation** via `ahpx watch` (monitor from another process)
- **Structured output** — NDJSON events with `{ type, timestamp, data }` envelopes
- **Semantic exit codes** — 0 (success), 1 (error), 3 (timeout), 5 (permission denied)

Resources:
- **[George AHP Dispatch Skill](.github/skills/george-ahp-dispatch/SKILL.md)** — Complete reference for George on using ahpx
- **[Integration Guide](docs/george-integration.md)** — Architecture, workflows, parsing examples, and troubleshooting

## Roadmap

### v0.1 — Foundation (complete ✅)

Phases 0–6 shipped the core AHP client, connection management, session
lifecycle, prompting with streaming, output formatting, multi-client observation,
and George integration. 229 tests pass.

### v0.2 — Agent Dispatch Platform (in progress)

- **Phase 7** — Library Mode: export ahpx as an npm package with typed API
- **Phase 8** — Multi-Session: concurrent sessions on a single connection
- **Phase 9** — Event Forwarding: webhook and WebSocket event streaming
- **Phase 10** — Fleet Management: multi-server health, routing, and dispatch
- **Phase 11** — Robust Multi-Turn: session resume, metadata, system prompts
- **Phase 12** — Production Hardening: bugs, tests, CI/CD, error handling

See **[docs/roadmap.md](docs/roadmap.md)** for the detailed v0.2 roadmap with
acceptance criteria, issue mapping, and protocol dependency analysis.

## License

MIT
