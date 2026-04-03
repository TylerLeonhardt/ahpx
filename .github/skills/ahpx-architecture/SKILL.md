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

**485 tests across 28 test files.** ~9,800 lines of TypeScript — ~6,700 lines of application code plus ~3,100
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
│   ├── session-handle.ts   SessionHandle — per-session convenience wrapper
│   ├── connection-pool.ts  ConnectionPool — URL-keyed connection reuse
│   └── __tests__/          Tests for all client layers
│
├── events/                 Event forwarding (Phase 9)
│   ├── forwarder.ts        AhpxEvent + EventForwarder interface
│   ├── webhook-forwarder.ts WebhookForwarder — batched HTTP POST
│   ├── ws-forwarder.ts     WebSocketForwarder — streaming WebSocket
│   ├── forwarding-formatter.ts ForwardingFormatter — OutputFormatter decorator
│   └── __tests__/
│
├── fleet/                  Fleet management (Phase 10)
│   ├── health.ts           HealthChecker — server health probing
│   ├── manager.ts          FleetManager — routing strategies & server selection
│   └── __tests__/
│
├── session/                Session persistence & scoping
│   ├── store.ts            SessionStore — JSON files in ~/.ahpx/sessions/
│   ├── persistence.ts      SessionPersistence — resume, save turns, sync
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

docs/
├── errors.md               Error catalog and troubleshooting
├── roadmap.md              Phase-by-phase roadmap and protocol dependencies
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

### Session handle (`client/session-handle.ts`)

`SessionHandle` wraps a single session on an `AhpClient`, filtering events by
session URI and providing a cleaner API than raw `dispatchAction()` calls.

```typescript
class SessionHandle extends EventEmitter {
  get sessionUri(): URI
  get sessionState(): ISessionState | undefined

  async sendPrompt(text: string, options?: PromptOptions): Promise<TurnResult>
  async cancelTurn(): Promise<void>
  async waitForReady(timeoutMs?: number): Promise<void>
  dispose(): void
}

interface TurnResult {
  turnId: string
  responseText: string
  toolCalls: number
  usage?: IUsageInfo
  state: "complete" | "cancelled" | "error"
  error?: string
}
```

Library consumers work with `SessionHandle` instead of raw `AhpClient`:
- Events are pre-filtered — only actions for this session are emitted
- `sendPrompt()` drives a full turn and returns a `TurnResult`
- `waitForReady()` blocks until the session reaches `idle` lifecycle
- `dispose()` cleans up listeners and marks the handle as disposed

### Connection pool (`client/connection-pool.ts`)

URL-keyed connection reuse for library consumers managing multiple servers.

```typescript
class ConnectionPool {
  async getClient(url: string, options?: AhpClientOptions): Promise<AhpClient>
  async closeAll(): Promise<void>
  get size(): number
}
```

- `getClient(url)` — returns an existing `AhpClient` for the URL or creates a
  new one, normalizing URLs before comparison
- Removes clients automatically on disconnect
- `closeAll()` disconnects all pooled connections

### Auto-reconnect (`client/reconnect.ts`)

Automatic reconnection with exponential backoff. On disconnect, attempts to
reconnect and replays missed actions or receives fresh snapshots.

## Session management

### SessionStore (`session/store.ts`)

Persists session records as JSON files in `~/.ahpx/sessions/`.

```typescript
interface TurnSummary {
  turnId: string               // UUID from AHP action
  userMessage: string          // First 200 chars
  responsePreview: string      // First 200 chars
  toolCallCount: number
  tokenUsage?: { input: number; output: number; model?: string }
  state: "complete" | "cancelled" | "error"
  timestamp: string            // ISO 8601
}

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
  turns?: TurnSummary[]       // Local turn history (capped at 100)
}
```

Key operations:
- `save(record)` — atomic write (tmp file + rename)
- `get(id)` / `list(filter?)` / `update(id, updates)` / `close(id)`
- `getByScope({serverName, workingDirectory, name?})` — find session by scope
- `appendTurn(id, turn)` — append turn summary, cap at 100 entries

Utility functions:
- `truncatePreview(str, maxLen?)` — truncate to preview length (200 chars)
- `buildTurnSummary(result)` — build TurnSummary from a TurnResult + user message

### SessionPersistence (`session/persistence.ts`)

Bridge between local `SessionStore` and live AHP server connections. Handles
session resume, turn persistence, and local/server sync.

```typescript
type ResumeOutcome =
  | { status: "resumed" }         // Session found on server
  | { status: "not_found" }       // Session disposed on server
  | { status: "error"; message: string }  // Connection/protocol error

interface SyncResult {
  added: string[]     // Session URIs on server but not locally tracked
  removed: string[]   // Local record IDs whose sessions were disposed
  updated: string[]   // Local record IDs with title/status changes
}

class SessionPersistence {
  constructor(store: SessionStore)
  async resume(record: SessionRecord, client: AhpClient): Promise<ResumeOutcome>
  async saveTurn(recordId: string, result: TurnResult & { userMessage: string }): Promise<SessionRecord | undefined>
  async sync(client: AhpClient, serverName: string): Promise<SyncResult>
}
```

- **`resume()`** subscribes to the session URI on the server. If the server
  returns `SessionNotFound` (-32001), returns `not_found` so the CLI can
  warn the user and create a new session.
- **`saveTurn()`** builds a `TurnSummary` from a turn result and appends it
  to the local session record via `SessionStore.appendTurn()`.
- **`sync()`** compares locally-active records for a server against the
  server's `listSessions` result. Closes stale local records, detects new
  server sessions, and updates divergent titles.

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
ahpx session history [<id>] [--local]
ahpx session export <id> [--output <file>]
ahpx session import <file>
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
10. **Decorator forwarding** — `ForwardingFormatter` wraps any formatter, forwarding events fire-and-forget
11. **Connection pooling** — URL-keyed reuse prevents redundant WebSocket connections
12. **Stateless health checks** — each probe creates/destroys a temporary client, no leaked state
13. **Strategy pattern (routing)** — FleetManager routing strategies are pluggable via enum

## Event forwarding (Phase 9)

Pluggable event forwarding system for streaming ahpx events to external
consumers: dashboards, log aggregators, monitoring systems.

### AhpxEvent and EventForwarder

```typescript
interface AhpxEvent {
  type: string            // "delta", "tool_call_complete", "turn_complete", etc.
  timestamp: string       // ISO 8601
  tags?: Record<string, string>
  data: Record<string, unknown>
  sessionUri?: string     // Multi-session disambiguation
}

interface EventForwarder {
  forward(event: AhpxEvent): void | Promise<void>
  close(): Promise<void>
}
```

`AhpxEvent` is compatible with the `JsonEnvelope` shape from the NDJSON
formatter, extended with `sessionUri` for multi-session support.

### WebhookForwarder (`events/webhook-forwarder.ts`)

POSTs events as NDJSON to an HTTP endpoint with batching and retry.

| Option | Default | Description |
|--------|---------|-------------|
| `url` | — | HTTP endpoint to POST to |
| `headers` | `{}` | Custom HTTP headers |
| `batchSize` | `10` | Events per batch before flush |
| `batchIntervalMs` | `1000` | Max ms before flushing a partial batch |
| `retries` | `3` | Retry attempts with exponential backoff |
| `filter` | all | Event types to forward |

Flushes remaining events on `close()`.

### WebSocketForwarder (`events/ws-forwarder.ts`)

Streams events over a WebSocket connection in real-time.

- **Auto-reconnect** with exponential backoff on disconnect
- **Backpressure handling** — pauses sending when buffered amount exceeds 1 MB
- **Disconnect buffering** — buffers up to 10,000 events while reconnecting
- **Event type filtering** via `filter` option

### ForwardingFormatter (`events/forwarding-formatter.ts`)

Decorator pattern: wraps any `OutputFormatter` and forwards events to one or
more `EventForwarder` instances.

```typescript
class ForwardingFormatter implements OutputFormatter {
  constructor(options: {
    inner: OutputFormatter
    forwarders: EventForwarder[]
    sessionUri?: string
    tags?: Record<string, string>
  })

  // Each method delegates to inner + forwards as AhpxEvent
  onDelta(text: string): void    // → inner.onDelta() + forward "delta"
  // ... all OutputFormatter methods ...

  set sessionUri(uri: string)    // Set after construction (for dynamic sessions)
  close(): Promise<void>         // Flush all forwarders
}
```

Fire-and-forget: forwarder errors are logged but never propagate to the inner
formatter or `TurnController`.

### CLI integration

Event forwarding flags are available on both `exec` and `prompt` commands:

```
--forward-webhook <url>     POST events to HTTP endpoint (repeatable)
--forward-ws <url>          Stream events over WebSocket (repeatable)
--forward-filter <types>    Comma-separated event types to forward
--forward-headers <json>    JSON object of custom headers
```

### Library API

Forwarders are standalone utilities exported from `ahpx`:

```typescript
import { WebhookForwarder, WebSocketForwarder, ForwardingFormatter } from 'ahpx';

// Option 1: Use ForwardingFormatter as a decorator
const formatter = new ForwardingFormatter({
  inner: myFormatter,
  forwarders: [new WebhookForwarder({ url: 'https://...' })],
});

// Option 2: Forward manually from session events
session.on('action', (envelope) => {
  forwarder.forward({ type: envelope.action.type, ... });
});
```

## Fleet management (Phase 10)

Multi-server health monitoring, capacity-aware routing, and server grouping.

### Server health checking (`fleet/health.ts`)

`HealthChecker` probes AHP servers for health status. Each check is stateless:
connect → initialize → read root state → disconnect.

```typescript
interface ServerHealth {
  name: string;
  url: string;
  status: 'healthy' | 'degraded' | 'unreachable';
  latencyMs: number;
  protocolVersion?: number;
  agents: { provider: string; models: string[] }[];
  activeSessions: number;
  checkedAt: string;  // ISO 8601
  error?: string;
}

class HealthChecker {
  constructor(options?: { timeout?: number })  // default 10s
  async check(url: string, name: string, timeout?: number): Promise<ServerHealth>
  async checkAll(connections: Array<{ name: string; url: string }>): Promise<ServerHealth[]>
}
```

- `check()` creates a temporary `AhpClient`, connects, reads `state.root` for
  agents/sessions, measures latency via `performance.now()`, disconnects
- On connection error or timeout: returns `status: 'unreachable'` with error
- Always disconnects in `finally` block (best-effort cleanup)
- `checkAll()` runs all checks concurrently via `Promise.all()`

### Fleet manager (`fleet/manager.ts`)

`FleetManager` caches health data and routes dispatches to the best server.

```typescript
type RoutingStrategy = 'least-sessions' | 'round-robin' | 'random' | 'preferred';

interface FleetManagerOptions {
  connections: ConnectionProfile[];
  strategy?: RoutingStrategy;       // default: 'least-sessions'
  preferredServer?: string;
  tags?: Record<string, string[]>;  // tag → server names mapping
  healthCheckTimeout?: number;
}

interface ServerRequirements {
  provider?: string;   // server must have this agent provider
  model?: string;      // server must have this model
  tag?: string;        // server must have this tag
}

class FleetManager {
  async selectServer(requirements?: ServerRequirements): Promise<{ name: string; url: string }>
  async getHealth(): Promise<ServerHealth[]>
  async refresh(): Promise<void>
}
```

Routing strategies:
- **least-sessions** — pick server with fewest `activeSessions`
- **round-robin** — cycle through healthy servers with internal index
- **random** — random selection from healthy candidates
- **preferred** — use `preferredServer` if healthy, fallback to least-sessions

Tag resolution merges `ConnectionProfile.tags` with `FleetManagerOptions.tags`:
```typescript
// Profile: { name: 'cloud', tags: ['gpu'] }
// Options: { tags: { fast: ['cloud'] } }
// → 'cloud' has effective tags: ['gpu', 'fast']
```

### Server tags on ConnectionProfile

`ConnectionProfile` supports optional tags for server grouping:

```typescript
interface ConnectionProfile {
  name: string;
  url: string;
  token?: string;
  default?: boolean;
  tags?: string[];  // e.g., ['gpu', 'cloud']
}
```

CLI: `ahpx server add cloud --url wss://cloud:8082 --tag gpu --tag cloud`

### CLI commands

```
ahpx server status [--all]        Health check all saved servers (table output)
ahpx server health <name>         Detailed health for one server
```

`server status` shows a table:
```
Name    URL                    Status       Latency   Sessions  Agents
local   ws://localhost:8082    healthy      12ms      2         copilot, mock
cloud   wss://cloud:8082       healthy      45ms      0         copilot
```

By default, unreachable servers are hidden unless `--all` is passed.

## Library exports (`src/index.ts`)

ahpx is both a CLI tool (`src/bin.ts`) and an npm library (`src/index.ts`).
The library exports:

| Category | Exports |
|----------|---------|
| Core client | `AhpClient`, `AhpClientOptions`, `AhpClientEvents`, `OpenSessionOptions` |
| Session handle | `SessionHandle`, `SessionHandleEvents`, `PromptOptions`, `SessionTurnResult` |
| Session persistence | `SessionStore`, `SessionPersistence`, `SessionRecord`, `SessionFilter`, `TurnSummary`, `ResumeOutcome`, `SyncResult`, `buildTurnSummary`, `truncatePreview` |
| Connection pool | `ConnectionPool`, `ConnectionPoolOptions` |
| Transport | `Transport`, `TransportOptions` |
| Protocol layer | `ProtocolLayer`, `ProtocolLayerOptions`, `RpcError`, `RpcTimeoutError` |
| State mirror | `StateMirror` |
| Event forwarding | `EventForwarder`, `AhpxEvent`, `WebhookForwarder`, `WebSocketForwarder`, `ForwardingFormatter` |
| Fleet management | `HealthChecker`, `ServerHealth`, `FleetManager`, `FleetManagerOptions`, `RoutingStrategy`, `ServerRequirements` |
| Connection config | `ConnectionProfile` |
| Auth | `AuthHandler`, `AuthHandlerOptions` |
| Protocol types | State types (`IRootState`, `ISessionState`, …), action types, command result types |

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

## CI/CD

GitHub Actions automates quality enforcement and publishing.

**CI workflow** (`.github/workflows/ci.yml`) — runs on every push and pull request:
- Node.js matrix: 20, 22
- Pipeline: typecheck → lint → test → build (sequential, fail-fast)

**Publish workflow** (`.github/workflows/publish.yml`) — automatic on push to master:
- Runs full quality gates: typecheck → lint → test → build
- Compares `package.json` version against npm registry
- Only publishes when version has changed (bumping version in package.json is the trigger)
- Publishes with provenance (`--provenance --access public`) for supply chain security
- Requires `NPM_TOKEN` secret in repo settings

**Quality gates** — all five checks must pass before merge:
1. `npm run typecheck` — `tsc --noEmit`
2. `npm run lint` — Biome check
3. `npm test` — Vitest (485 tests)
4. `npm run build` — tsup production build
5. Node.js version matrix (20 + 22)

## Roadmap (v0.2)

ahpx v0.1 (Phases 0–6) shipped the foundation: core AHP client, connection
management, sessions, prompting, output formatting, observation, and George
integration. Phase 7 added library mode (`import { AhpClient } from 'ahpx'`),
Phase 8 added multi-session support with `SessionHandle` and `ConnectionPool`,
Phase 9 added event forwarding (webhook + WebSocket), Phase 10 added fleet
management (HealthChecker, FleetManager, server tags), and Phase 11 added robust
multi-turn sessions (SessionPersistence, turn history, export/import). 485 tests pass.

v0.2 evolves ahpx from CLI tool to **production-grade agent dispatch platform**:

| Phase | Name | Status |
|-------|------|--------|
| **7** | Library Mode | ✅ Complete — npm package with typed API |
| **8** | Multi-Session | ✅ Complete — SessionHandle, ConnectionPool |
| **9** | Event Forwarding | ✅ Complete — Webhook + WebSocket streaming |
| **10** | Fleet Management | ✅ Complete — HealthChecker, FleetManager, server tags, CLI status/health |
| **11** | Robust Multi-Turn | ✅ Complete — SessionPersistence, turn history, session resume, export/import |
| **12** | Production Hardening | ✅ Complete — CI/CD, 485 tests, npm publish prep, error docs |

### Key architectural implications for v0.2

- **Dual entry points:** `src/index.ts` (library) and `src/bin.ts` (CLI) —
  the client layer is a public API (Phase 7, complete)
- **SessionHandle + ConnectionPool:** Per-session wrappers and URL-keyed
  connection reuse simplify multi-session library usage (Phase 8, complete)
- **Event forwarding:** `ForwardingFormatter` decorator + `WebhookForwarder` /
  `WebSocketForwarder` stream events to external consumers (Phase 9, complete)
- **FleetManager:** Health-aware routing across multiple servers with 4
  strategies and tag-based filtering (Phase 10, complete)
- **SessionPersistence:** Session resume verification, local turn history with
  server fallback, and local/server session sync (Phase 11, complete)
- **Session export/import:** Debug-friendly session sharing via JSON files
  (Phase 11, complete)

### Protocol dependencies

7 open issues require AHP protocol changes. ahpx implements client-side
workarounds where feasible. See [docs/roadmap.md](../../../docs/roadmap.md) for
the full protocol dependency analysis.

### Open issues mapped to remaining phases

- Phase 10: #28, #30
- Phase 11: #5, #6, #10, #25, #26, #29
- Phase 12: #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #27
