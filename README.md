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

## Phase Roadmap

- **Phase 0** — Project scaffold & core client ✅
- **Phase 1** — Interactive session mode (send messages, stream responses)
- **Phase 2** — Tool call handling (confirm/deny, view results)
- **Phase 3** — Session management (list, resume, dispose)
- **Phase 4** — Configuration & profiles (saved server connections)
- **Phase 5** — Rich TUI (full terminal UI with panels)

## License

MIT
