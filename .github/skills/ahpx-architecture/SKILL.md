---
description: >-
  ahpx codebase architecture — the official-client adapter, session management,
  prompting system, config, and the official AHP protocol package. Use when
  implementing features, fixing bugs, or understanding how ahpx works.
---

# ahpx Architecture

ahpx is a CLI client for the Agent Host Protocol. It connects to AHP servers via
WebSocket, speaks JSON-RPC 2.0, and manages AI agent sessions with streaming
responses, tool calls, and permissions.

**700+ tests across 30+ test files.** ~9,600 lines of application TypeScript.
Protocol types, reducers, constants — **and now the client, transport, and state
machinery** — come from the official
[`@microsoft/agent-host-protocol`](https://www.npmjs.com/package/@microsoft/agent-host-protocol)
npm package (pinned at `^0.5.0`) — ahpx no longer vendors them.

## Directory structure

```
src/
├── bin.ts                  CLI entry point (~1,800 lines, 20+ commands)
├── errors.ts               Exit codes and error classes
├── logger.ts               Structured logging to stderr
├── completions.ts          Shell completions (bash/zsh/fish)
│
├── client/                 Thin adapter over the official AHP client
│   ├── index.ts            AhpClient — EventEmitter facade wrapping the
│   │                       official async-iterator client (the CLI surface)
│   ├── ws-transport.ts     WsTransport — `ws`-based AhpTransport with custom
│   │                       headers (auth / dev-tunnel); the official `/ws`
│   │                       transport uses the header-less global WebSocket
│   ├── state.ts            Client-side state mirror (incl. ahp-chat:// chat
│   │                       state the official AhpStateMirror does not track)
│   ├── response-text.ts    Folded-first-delta recovery from chat responseParts
│   ├── file-serving.ts     Reverse-RPC file serving (resourceRead/List)
│   └── __tests__/          Adapter + real-WS integration tests
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
├── customizations/         Workspace customization discovery
│   ├── discovery.ts        Scans for instructions/agents/prompts/skills
│   └── types.ts            ahpx-local CustomizationRef + mapper to the
│                           official ClientPluginCustomization wire shape
│
└── notifications.ts        ahpx-local notification compat — layers a `type`
                            discriminator over the package's `*Params` types
                            (the package discriminates by JSON-RPC method)

# Protocol types, the ActionType enum, reducers (rootReducer, sessionReducer,
# chatReducer, terminalReducer), notification params, version constants, AND the
# JSON-RPC client/transport/state machinery are all imported from
# `@microsoft/agent-host-protocol`. The official client, WebSocket transport, and
# multi-host helpers live under its `/client`, `/ws`, and `/hosts` subpaths. ahpx
# wraps the official `/client` in a thin EventEmitter adapter (see below).

docs/
├── errors.md               Error catalog and troubleshooting
├── roadmap.md              Phase-by-phase roadmap and protocol dependencies
```

## Client architecture: a thin adapter over the official client

ahpx no longer hand-rolls its transport/JSON-RPC/state machinery. `client/index.ts`
is a **thin `EventEmitter` adapter** that wraps the official async-iterator
`@microsoft/agent-host-protocol/client` `AhpClient`, preserving the low-level
surface every CLI consumer (bin.ts, `TurnController`, connect-helper, watcher,
health, auth, persistence) already depends on.

```
┌──────────────────────────────────────────────────────────┐
│  AhpClient (client/index.ts) — EventEmitter facade        │
│  connect / createSession / subscribe / dispatchAction /   │
│  on('action'|'notification'|'disconnected') / state / …   │
│                                                            │
│  bridges the official client's async iterators:           │
│   • events()        → 'action' / 'notification' events    │
│   • stateChanges()  → 'disconnected' event                │
│   • setServerRequestHandler() → FileServingHandler        │
├──────────────────────────────────────────────────────────┤
│  official @microsoft/agent-host-protocol/client AhpClient │
│  JSON-RPC 2.0, request/notify/subscribe/dispatch,         │
│  per-URI subscriptions + top-level events() fan-in        │
├──────────────────────────────────────────────────────────┤
│  WsTransport (client/ws-transport.ts) — AhpTransport      │
│  `ws`-based socket with custom headers (auth / tunnel)    │
└──────────────────────────────────────────────────────────┘
```

### What the adapter adds (gaps the official client does not cover)

The official client owns the wire protocol; ahpx keeps **only** the pieces it
genuinely needs on top:

1. **`WsTransport` (`client/ws-transport.ts`)** — implements the official
   `AhpTransport` interface over the `ws` package so the WebSocket handshake can
   carry custom **headers** (`Authorization`, dev-tunnel auth). The official
   `/ws` `WebSocketTransport` uses the header-less global `WebSocket`. Static
   `connect(url, { headers, connectTimeout })` resolves on open, rejects with the
   official `TransportError` on timeout/error; `send`/`recv`/`close` follow the
   transport contract (clean close drains `recv()` waiters with `null`).
2. **Chat state in `StateMirror` (`client/state.ts`)** — the official
   `AhpStateMirror` tracks sessions/terminals/changesets but **not** `ahp-chat://`
   chat state (turns / activeTurn / responseParts). The folded-first-delta
   recovery depends on chat state, so ahpx keeps its own `StateMirror`.
3. **EventEmitter ergonomics** — `startStreams()` drains the official
   `events()` and `stateChanges()` async iterators and re-emits them as the
   `action` / `notification` / `disconnected` events consumers expect. The
   `events()` drain loop is started **before** `initialize()` so no inbound
   action is missed (initialize snapshots are applied from the result).
4. **Reverse-RPC file serving (`client/file-serving.ts`)** — bridges the official
   `setServerRequestHandler` to `FileServingHandler.handleServerRequest(method,
   params)`, which serves allowed `file://` customizations back to the server
   (`resourceRead`/`resourceList`), throwing the official `RpcError`
   (`-32601` unknown method, `-32008` access denied) on failure.

`RpcError` / `RpcTimeoutError` are re-exported from `client/index.ts` (sourced
from the official `/client`) so existing imports keep working.

### AhpClient surface (`client/index.ts`)

```typescript
class AhpClient extends EventEmitter {
  async connect(url, { headers?, connectTimeout? }?): Promise<InitializeResult>
  async disconnect(): Promise<void>

  // Commands → delegate to official.request(...) / official.dispatch(...)
  async createSession(uri, provider?, model?, workingDir?, config?): Promise<null>
  async disposeSession(uri): Promise<null>
  async listSessions(): Promise<ListSessionsResult>
  async subscribe(uri): Promise<SubscribeResult>   // applies snapshot to mirror
  unsubscribe(uri): void
  async fetchTurns(uri, before?, limit?): Promise<FetchTurnsResult>
  async resourceRead/Write/List/Copy/Delete/Move(...): Promise<...>
  async authenticate(resource, token): Promise<void>
  dispatchAction(channel, action): void            // official.dispatch (write-ahead)

  get state(): StateMirror
  get connected(): boolean
  get clientId(): string
  get fileServing(): FileServingHandler
}
```

On `connect()`:
1. `WsTransport.connect(url, { headers, connectTimeout })` opens the socket
2. Constructs the official `AhpClient(transport, { requestTimeoutMs })`
3. Installs the reverse-RPC handler via `setServerRequestHandler`
4. `official.connect()` starts the receive loop; `startStreams()` begins draining
   `events()` / `stateChanges()` **before** initialize
5. `official.initialize(...)` handshake; applies returned snapshots to the mirror
6. Emits `connected`, returns `InitializeResult`

### State mirror (`client/state.ts`)

Tracks server state locally by applying snapshots and actions through the
package's reducers.

AHP 0.3+ splits a session's coordination state (`ahp-session:` channels) from
its conversation state (`ahp-chat:` channels): turns and the active turn moved
off `SessionState` onto a new `ChatState`. ahpx is a one-session / one-chat CLI,
so it models a session and its default chat as the **same** channel URI —
`getSession(uri)` returns the `SessionState` (summary, lifecycle, chats catalog)
and `getChat(uri)` returns the `ChatState` (turns, activeTurn, pending/queued
messages). The two are tracked in separate maps and never collide.

```typescript
class StateMirror {
  get root(): RootState
  get seq(): number
  getSession(uri: URI): SessionState | undefined
  get sessionUris(): URI[]
  getChat(uri: URI): ChatState | undefined
  get chatUris(): URI[]
  getTerminal(uri: URI): TerminalState | undefined
  get terminalUris(): URI[]
  applySnapshot(snapshot: Snapshot): void
  applyAction(envelope: ActionEnvelope): void
  removeSession(uri: URI): void
  removeTerminal(uri: URI): void
}
```

Routes actions by channel/type: root actions (`root/*`) go through `rootReducer`;
chat actions (`chat/*` — turns, streaming, tool calls) build/update `ChatState`
via `chatReducer` (lazily creating an empty chat state on first chat action);
terminal actions (`terminal/*`) go through `terminalReducer`; all remaining
`session/*` actions go through `sessionReducer`.

### Driving turns (`prompt/controller.ts`)

ahpx no longer ships a high-level `SessionHandle`/`ConnectionPool`/reconnect SDK
— it is a CLI-only wrapper. The CLI opens a session with the low-level client
(`createSession` + `subscribe`, resolving the `ahp-chat://` channel) and drives
each turn through a `TurnController`:

```typescript
class TurnController {
  constructor(
    client: AhpClient,
    sessionUri: URI,
    renderer: PromptRenderer,
    permission: PermissionHandler,
    chatUri?: URI,         // defaults to sessionUri
    model?: string,        // sent per-message as message.model = { id }
  )
  async prompt(text, attachments?, opts?): Promise<TurnResult>
}

interface TurnResult {
  turnId: string
  responseText: string   // authoritative, rebuilt from chat responseParts
  toolCalls: number
  usage?: UsageInfo
  state: "complete" | "cancelled" | "error" | "idle_timeout"
  error?: string
}
```

The controller generates the `turnId` client-side, dispatches
`chat/turnStarted` on the chat channel, filters incoming actions by
channel + turnId, handles tool-call confirmation via the `PermissionHandler`
(skipping confirmation for client-owned tools), and at completion rebuilds the
authoritative `responseText` from chat-state `Turn.responseParts` — recovering
any folded first delta the host never emitted as a `chat/delta`.

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

## Official protocol package (`@microsoft/agent-host-protocol`)

ahpx imports the AHP type system, reducers, and constants directly from the
official npm package — there is no vendored copy. Everything comes from the root
entrypoint:

- **State**: `RootState`, `SessionState`, `ChatState`, `TerminalState`,
  `Turn`, `ActiveTurn`, `Message` (+ `MessageOrigin`), `ToolCallState`
  (discriminated union of statuses with a `contributor?` field),
  `ChatInputRequest` and related input/elicitation types
- **Actions**: the `ActionType` enum and all action interfaces. Turn/streaming/
  tool-call actions are `Chat*` (`ChatTurnStarted`, `ChatDelta`,
  `ChatResponsePart`, `ChatToolCall*`, `ChatUsage`, `ChatError`, …); session
  coordination actions stay `Session*` (`SessionReady`, `SessionTitleChanged`,
  `SessionActiveClientChanged`, `SessionCustomization*`, `SessionChatAdded`, …)
- **Commands**: `CommandMap` mapping method names to param/result types
- **Reducers**: `rootReducer`, `sessionReducer`, `chatReducer`, `terminalReducer`
  (pure functions)
- **Version**: `PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS`
  (includes `0.4.0`, `0.3.0`)

Subpath entrypoints provide the official client (`/client` — `AhpClient`,
`AhpStateMirror`, `InMemoryTransport`), the WebSocket transport (`/ws`), and
multi-host helpers (`/hosts`). ahpx **wraps the official `/client`** in a thin
EventEmitter adapter (see "Client architecture" above) and also consumes
types/reducers/constants from the package.

### ahpx-local compat shims

A few concepts the package doesn't expose the way ahpx needs are recreated
locally:

- `src/notifications.ts` — the package's notification `*Params` carry no `type`
  field (it discriminates by JSON-RPC method). ahpx defines a `NotificationType`
  enum and `*Notification` types (params intersected with `{ type }`), and the
  adapter's `toNotification()` injects the method as `type` so consumers keep a
  `type`-switch.
- `src/customizations/types.ts` — `CustomizationRef`/`Icon` for workspace
  discovery, plus `toClientCustomization()` which maps a discovered file to the
  official `ClientPluginCustomization` (Open Plugins container) wire shape before
  it's published in `activeClient.customizations`.

Some types (e.g. `Customization`, `ClientPluginCustomization`,
`CustomizationType`) are not re-exported from the package root; derive them from
exported types, e.g.
`NonNullable<SessionState["customizations"]>[number]`.

To upgrade the package, use the **`ahp-package-upgrader`** agent.

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
import { WebhookForwarder, WebSocketForwarder, ForwardingFormatter } from '@tylerl0706/ahpx';

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

## Internal client modules (no public SDK)

ahpx is **CLI-only** — there is no `src/index.ts` and no published library surface
(removed in v0.3.0). The modules under `src/client/*` are internal to the CLI and
are not an exported SDK. The notable internal building blocks:

| Category | Modules |
|----------|---------|
| Client adapter | `AhpClient` (`client/index.ts`) — EventEmitter facade over the official `/client` |
| WS transport | `WsTransport` (`client/ws-transport.ts`) — `ws`-based `AhpTransport` with headers |
| State mirror | `StateMirror` (`client/state.ts`) — incl. `ahp-chat://` chat state |
| File serving | `FileServingHandler` (`client/file-serving.ts`) — reverse-RPC `resourceRead`/`List` |
| RPC errors | `RpcError`, `RpcTimeoutError` — re-exported from the official `/client` |
| Session persistence | `SessionStore`, `SessionPersistence`, `SessionRecord` (`session/*`) |
| Event forwarding | `EventForwarder`, `WebhookForwarder`, `WebSocketForwarder`, `ForwardingFormatter` |
| Fleet management | `HealthChecker`, `FleetManager`, `RoutingStrategy` |
| Auth | `AuthHandler` |
| Protocol types | imported from `@microsoft/agent-host-protocol` (`RootState`, `SessionState`, `ChatState`, action/command types) |

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
- Auto-bumps patch version (`npm version patch`), commits, and pushes back to master
- Skips runs triggered by version-bump commits (`chore: bump version`) to prevent infinite loops
- Serialized via `concurrency: publish-npm` to avoid race conditions on concurrent merges
- Publishes with provenance (`--provenance --access public`) for supply chain security
- Authenticates via OIDC trusted publishers (no `NPM_TOKEN` secret needed)
- Requires `contents: write` and `id-token: write` permissions

**Quality gates** — all five checks must pass before merge:
1. `npm run typecheck` — `tsc --noEmit`
2. `npm run lint` — Biome check
3. `npm test` — Vitest (485 tests)
4. `npm run build` — tsup production build
5. Node.js version matrix (20 + 22)

## Roadmap (v0.2)

> **Historical.** The phases below describe ahpx's v0.1/v0.2 evolution and are
> kept for context. Several are now superseded: **Phase 7 (Library Mode) and
> Phase 8's `SessionHandle`/`ConnectionPool` were removed** — ahpx is now a
> **CLI-only** wrapper around the official `@microsoft/agent-host-protocol`
> client (no exported SDK, no `src/index.ts`). The CLI drives turns via the
> low-level client + `TurnController` (see "Driving turns" above).

ahpx v0.1 (Phases 0–6) shipped the foundation: core AHP client, connection
management, sessions, prompting, output formatting, observation, and George
integration. Phase 7 added library mode (`import { AhpClient } from '@tylerl0706/ahpx'`),
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
