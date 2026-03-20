---
description: >-
  ahpx codebase architecture — the 3-layer client, session management,
  prompting system, config, and protocol types. Use when implementing features,
  fixing bugs, or understanding how ahpx works.
---

# ahpx Architecture

ahpx is a CLI client for the Agent Host Protocol. It connects to AHP servers via
WebSocket, speaks JSON-RPC 2.0, and manages AI agent sessions with streaming
responses, tool calls, and permissions.

**~8,600 lines of TypeScript** — ~5,200 lines of application code plus ~3,100
lines of vendored AHP protocol type definitions.

## Directory structure

```
src/
├── bin.ts                  CLI entry point (~1,800 lines, 20+ commands)
├── errors.ts               Exit codes and error classes
├── logger.ts               Structured logging to stderr
├── completions.ts          Shell completions (bash/zsh/fish)
│
├── client/                 Three-layer AHP client
│   ├── transport.ts        Layer 1: WebSocket I/O
│   ├── protocol.ts         Layer 2: JSON-RPC 2.0 routing
│   ├── index.ts            Layer 3: High-level typed API
│   ├── state.ts            Client-side state mirror
│   ├── active-client.ts    Session active client management
│   ├── reconnect.ts        Auto-reconnect with backoff
│   └── __tests__/          Tests for all client layers
│
├── session/                Session persistence & scoping
│   ├── store.ts            SessionStore — JSON files in ~/.ahpx/sessions/
│   ├── scope.ts            Directory-walk session resolution
│   ├── connect-helper.ts   Shared connection logic
│   └── __tests__/
│
├── prompt/                 Turn orchestration
│   └── controller.ts       TurnController — drives a single turn end-to-end
│
├── output/                 Output formatting (strategy pattern)
│   ├── format.ts           OutputFormatter interface
│   ├── renderer.ts         PromptRenderer — colored terminal output
│   ├── json-formatter.ts   JsonFormatter — NDJSON output
│   ├── quiet-formatter.ts  QuietFormatter — silent, final-output-only
│   ├── spinner.ts          CLI spinners
│   └── index.ts            Factory (createFormatter)
│
├── permissions/            Tool & permission approval
│   └── handler.ts          PermissionHandler — approve-all/reads/deny-all
│
├── config/                 Layered configuration
│   ├── index.ts            Config loading (default → global → project → CLI)
│   └── connections.ts      ConnectionStore — saved server profiles
│
├── auth/                   Authentication
│   └── handler.ts          Token storage/retrieval (env, file, interactive)
│
├── watch/                  File watching
│   └── watcher.ts          Session file monitoring
│
└── protocol/               Vendored AHP protocol types (~3,100 lines)
    ├── state.ts            State definitions (IRootState, ISessionState, etc.)
    ├── actions.ts          Action types (25 ActionType enum members)
    ├── commands.ts         JSON-RPC command types (ICommandMap)
    ├── reducers.ts         Pure state reducers (rootReducer, sessionReducer)
    ├── messages.ts         JSON-RPC message types
    ├── notifications.ts    Protocol notification types
    ├── errors.ts           Error codes
    ├── action-origin.generated.ts   Client/server action dispatch matrix
    └── version/
        └── registry.ts     Protocol version compatibility maps
```

## Three-layer client architecture

The core client is composed of three independently testable layers:

```
┌──────────────────────────────────────────────┐
│  AhpClient (client/index.ts)                 │
│  High-level API: connect, createSession,     │
│  dispatchAction, subscribe, state mirror     │
├──────────────────────────────────────────────┤
│  ProtocolLayer (client/protocol.ts)          │
│  JSON-RPC 2.0: request/response correlation, │
│  notifications, timeouts, error mapping      │
├──────────────────────────────────────────────┤
│  Transport (client/transport.ts)             │
│  WebSocket: connect, send, close, reconnect  │
│  Events: open, close, error, message         │
└──────────────────────────────────────────────┘
```

### Layer 1: Transport (`client/transport.ts`)

Manages the raw WebSocket connection. Extends `EventEmitter`.

- `connect(url, options?)` — opens WebSocket with configurable timeout
  (default 10s), custom headers, and race between open/error/timeout
- `send(data)` — JSON-serializes and sends, throws if disconnected
- `close()` — tears down the connection
- Events: `open`, `close(code, reason)`, `error(err)`, `message(parsed)`

All incoming messages are JSON-parsed before being emitted.

### Layer 2: Protocol (`client/protocol.ts`)

JSON-RPC 2.0 message correlation on top of Transport. Extends `EventEmitter`.

- `request<M>(method, params, timeout?)` — sends request with auto-incremented
  ID, returns typed promise, default 30s timeout
- `notify(method, params)` — sends notification (no ID, fire-and-forget)
- `cancelAll(reason)` — rejects all pending requests (used on disconnect)
- Events: `action(envelope)`, `notification(notification)`

Handles response routing: messages with `id` + `result`/`error` resolve pending
promises; messages with `method` but no `id` are classified as `action` or
`notification` events.

Error classes: `RpcError` (with `code` and `data`), `RpcTimeoutError`.

### Layer 3: AhpClient (`client/index.ts`)

High-level typed API. Extends `EventEmitter`.

```typescript
class AhpClient {
  async connect(url: string): Promise<IInitializeResult>
  async disconnect(): Promise<void>

  // Commands
  async createSession(uri, provider?, model?, workingDir?): Promise<null>
  async disposeSession(uri): Promise<null>
  async listSessions(): Promise<IListSessionsResult>
  async subscribe(uri): Promise<ISubscribeResult>
  unsubscribe(uri): void
  async fetchTurns(uri, before?, limit?): Promise<IFetchTurnsResult>
  async fetchContent(uri): Promise<IFetchContentResult>
  async browseDirectory(uri?): Promise<IBrowseDirectoryResult>
  async authenticate(resource, token): Promise<void>

  // Actions
  dispatchAction(action: IStateAction): void

  // State
  get state(): StateMirror
  get connected(): boolean
  get clientId(): string
}
```

On `connect()`:
1. Creates Transport and ProtocolLayer
2. Wires events: protocol actions → state mirror + client events
3. Calls `transport.connect(url)`
4. Sends `initialize` request
5. Applies initial snapshots to state mirror
6. Returns `IInitializeResult`

### State mirror (`client/state.ts`)

Tracks server state locally by applying snapshots and actions through the
vendored reducers.

```typescript
class StateMirror {
  get root(): IRootState
  get seq(): number
  getSession(uri: URI): ISessionState | undefined
  get sessionUris(): URI[]
  applySnapshot(snapshot: ISnapshot): void
  applyAction(envelope: IActionEnvelope): void
  removeSession(uri: URI): void
}
```

Routes actions: root actions (`root/agentsChanged`, `root/activeSessionsChanged`)
go through `rootReducer`; all others through `sessionReducer`.

### Auto-reconnect (`client/reconnect.ts`)

Automatic reconnection with exponential backoff. On disconnect, attempts to
reconnect and replays missed actions or receives fresh snapshots.

## Session management

### SessionStore (`session/store.ts`)

Persists session records as JSON files in `~/.ahpx/sessions/`.

```typescript
interface SessionRecord {
  id: string                  // UUID
  sessionUri: string          // "copilot:/<uuid>"
  serverName: string          // Connection name
  serverUrl: string           // ws:// URL
  provider: string
  model?: string
  name?: string               // User-given name
  workingDirectory?: string
  gitRoot?: string
  title?: string              // Server-generated
  status: "active" | "closed"
  createdAt: string           // ISO 8601
  closedAt?: string
  lastPromptAt?: string
}
```

Key operations:
- `save(record)` — atomic write (tmp file + rename)
- `get(id)` / `list(filter?)` / `update(id, updates)` / `close(id)`
- `getByScope({serverName, workingDirectory, name?})` — find session by scope

### Directory-walk scoping (`session/scope.ts`)

Resolves which session to use based on the current directory:

1. `findGitRoot(from)` — walks up from `from` looking for `.git`
2. `resolveSession({serverName, cwd, name?, store})`:
   - If no git root: exact `cwd` match only
   - If git root found: walks from `cwd` up to git root, checking each
     directory for an active session

Example: running from `/project/src/utils` with git root at `/project`:
```
Check /project/src/utils → no match
Check /project/src       → no match
Check /project           → found session → return it
```

### Connection helper (`session/connect-helper.ts`)

Shared logic for establishing connections, used by multiple CLI commands.
Resolves server target, connects `AhpClient`, handles auth notifications.

## Prompting system

### TurnController (`prompt/controller.ts`)

Orchestrates a single turn from user prompt to completion.

```typescript
class TurnController {
  async prompt(text, attachments?): Promise<TurnResult>
  async cancel(): Promise<void>
}

interface TurnResult {
  turnId: string
  responseText: string
  toolCalls: number
  usage?: { inputTokens, outputTokens, model? }
  state: "complete" | "cancelled" | "error"
  error?: string
}
```

Flow:
1. Generate `turnId` (UUID)
2. Register action listener on `AhpClient`
3. Dispatch `session/turnStarted` action
4. Process incoming actions:
   - `session/delta` → accumulate text, call `renderer.onDelta()`
   - `session/reasoning` → call `renderer.onReasoning()`
   - `session/toolCallStart` → increment counter, call `renderer.onToolCallStart()`
   - `session/toolCallReady` → delegate to `PermissionHandler` for confirmation
   - `session/toolCallComplete` → call `renderer.onToolCallComplete()`
   - `session/permissionRequest` → delegate to `PermissionHandler`
   - `session/usage` → capture usage info
   - `session/turnComplete` → resolve promise with `TurnResult`
   - `session/error` → resolve with error state
   - `session/turnCancelled` → resolve with cancelled state
5. Clean up listener

### OutputFormatter (`output/format.ts`)

Strategy pattern interface — all formatters implement these callbacks:

```typescript
interface OutputFormatter {
  onDelta(text: string): void
  onReasoning(text: string): void
  onToolCallStart(id: string, name: string): void
  onToolCallDelta(id: string, paramsDelta: string): void
  onToolCallReady(id: string, call: ToolCallInfo): void
  onToolCallComplete(id: string, result: IToolCallResult): void
  onToolCallCancelled(id: string, reason: string): void
  onPermissionRequest(req: IPermissionRequest): void
  onUsage(usage: IUsageInfo): void
  onTurnComplete(responseText: string): void
  onTurnError(error: IErrorInfo): void
  onTurnCancelled(): void
  onTitleChanged(title: string): void
}
```

Three implementations:

| Formatter | File | Behavior |
|-----------|------|----------|
| `PromptRenderer` | `output/renderer.ts` | Colored terminal output with `[tool]`, `[permission]`, `[done]` labels |
| `JsonFormatter` | `output/json-formatter.ts` | NDJSON — one `JsonEnvelope` per line with `type`, `timestamp`, `data` |
| `QuietFormatter` | `output/quiet-formatter.ts` | Silent accumulation, prints only final response |

### PermissionHandler (`permissions/handler.ts`)

Handles tool confirmation and permission approval with three modes:

| Mode | Reads | Writes | Shell | Tools |
|------|-------|--------|-------|-------|
| `approve-all` | Auto-yes | Auto-yes | Auto-yes | Auto-yes |
| `approve-reads` | Auto-yes | **Prompt** | **Prompt** | **Prompt** |
| `deny-all` | Auto-no | Auto-no | Auto-no | Auto-no |

Interactive prompting uses readline for `y/N` input on non-auto cases.

## Configuration

### Layered loading (`config/index.ts`)

Resolution order (later wins):
1. **Defaults** — `permissions: "approve-reads"`, `timeout: 30`, `format: "text"`
2. **Global** — `~/.ahpx/config.json`
3. **Project** — `./.ahpxrc.json`
4. **CLI flags** — `--format`, `--permissions`, etc.

```typescript
interface AhpxConfig {
  defaultServer?: string
  defaultProvider?: string
  defaultModel?: string
  permissions?: "approve-all" | "approve-reads" | "deny-all"
  timeout?: number
  format?: "text" | "json" | "quiet"
  verbose?: boolean
}
```

Includes source tracking (`ConfigWithSources`) showing where each value came
from: `"default"`, `"global"`, `"project"`, or `"cli"`.

### ConnectionStore (`config/connections.ts`)

Saved server profiles in `~/.ahpx/connections.json`:

```typescript
interface ConnectionProfile {
  name: string
  url: string          // ws:// or wss://
  token?: string
  isDefault?: boolean
}
```

Operations: `add`, `get`, `list`, `remove`, `setDefault`, `getDefault`.

## Authentication (`auth/handler.ts`)

Token resolution flow:
1. Check `--token` CLI flag
2. Check `$AHPX_TOKEN` environment variable
3. Check `~/.ahpx/auth.json` stored token
4. Prompt user interactively (if TTY)
5. Store successful token in `~/.ahpx/auth.json` (0600 permissions, atomic write)

## CLI commands (`bin.ts`)

### Server management
```
ahpx server add <name> --url <url> [--token <token>] [--default]
ahpx server list [--default]
ahpx server remove <name>
ahpx server info [<name>]
ahpx server default <name>
```

### Session management
```
ahpx session new [<name>]
ahpx session list [--server <name>]
ahpx session info [<id>]
ahpx session close [<id>]
ahpx session watch [--server <name>]
```

### Prompting
```
ahpx [<prompt>]          Default command — prompt in current session
ahpx prompt <text>       Explicit prompt
ahpx exec <text>         Execute with approve-all permissions
ahpx history [--limit]   Show turn history
```

### Configuration
```
ahpx config show
ahpx config init
ahpx config set <key> <value>
```

### Utilities
```
ahpx connect [<server>]
ahpx agents [-s <server>]
ahpx content <uri> [-o <file>]
ahpx model <model-id>
ahpx completions bash|zsh|fish
```

### Global options
```
--format <text|json|quiet>    Output format (default: text)
--json-strict                 Suppress non-JSON stderr
-v, --verbose                 Debug logging to stderr
--version / --help
```

## Error handling (`errors.ts`)

Well-defined exit codes for scripting:

| Code | Name | Meaning |
|------|------|---------|
| `0` | Success | Command completed successfully |
| `1` | Error | General error |
| `2` | Usage | Invalid arguments or usage |
| `3` | Timeout | Operation timed out |
| `4` | NoSession | No active session found |
| `5` | PermissionDenied | Permission denied |
| `130` | Interrupted | SIGINT (Ctrl+C) |

Error class hierarchy: `AhpxError` → `UsageError`, `TimeoutError`,
`NoSessionError`, `PermissionDeniedError`.

## Vendored protocol types (`src/protocol/`)

The protocol types are vendored from the
[agent-host-protocol](https://github.com/anthropics/agent-host-protocol)
repository. These are the source of truth for the AHP type system.

Key files:
- `state.ts` — `IRootState`, `ISessionState`, `IActiveTurn`, `ITurn`,
  `IToolCallState` (discriminated union with 6 statuses)
- `actions.ts` — `ActionType` enum (25 members), all action interfaces
- `commands.ts` — `ICommandMap` mapping method names to param/result types
- `reducers.ts` — `rootReducer()` and `sessionReducer()` pure functions
- `messages.ts` — JSON-RPC message types
- `errors.ts` — `ErrorCode` enum (standard + AHP-specific)
- `action-origin.generated.ts` — which actions are client-dispatchable

When updating protocol types, copy from the upstream `types/` directory and
ensure the vendored files stay in sync.

## Logging (`logger.ts`)

Structured logging to **stderr** (never contaminates stdout for JSON piping):

```typescript
const log = createLogger("transport")
log.info("connected", { url: "ws://localhost:3000", seq: 42 })
// → [14:32:15 transport] connected url=ws://localhost:3000 seq=42
```

Verbosity controlled by `--verbose` flag or `setVerbose(true)`.

## Key design patterns

1. **Three-layer composition** — each layer independently testable and replaceable
2. **EventEmitter coupling** — loose coupling between Transport → Protocol → Client
3. **Pure reducers** — immutable state updates enable deterministic testing
4. **Strategy pattern** — OutputFormatter implementations swap rendering behavior
5. **Directory-walk scoping** — smart session resolution within git boundaries
6. **Layered configuration** — global + project + CLI with source tracking
7. **Atomic file writes** — temp file + rename prevents corruption
8. **Exhaustive type maps** — protocol version/action maps catch missing cases at compile time
9. **Exit codes** — well-defined codes (0–5, 130) for scripting and CI

## Build and test

```bash
npm run build       # tsup → dist/bin.js (ESM, node20 target, shebang)
npm run dev         # tsup --watch
npm test            # vitest run
npm run test:watch  # vitest (watch mode)
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm run lint:fix    # biome check --write .
```

**Dependencies:**
- Runtime: `commander`, `picocolors`, `ws`
- Dev: `typescript`, `tsup`, `vitest`, `@biomejs/biome`

**Build output:** Single file `dist/bin.js` with `#!/usr/bin/env node` shebang.
