---
description: >-
  Agent Host Protocol fundamentals — state model, actions, JSON-RPC commands,
  connection lifecycle, and write-ahead reconciliation. Use when working on AHP
  client code, debugging protocol issues, or implementing new protocol features.
---

# Agent Host Protocol (AHP)

AHP is a **Redux-inspired state synchronization protocol** built on JSON-RPC 2.0
over WebSocket. A server maintains an authoritative state tree; clients apply
actions optimistically and reconcile when the server echoes them back.

Key design principles:
- **Synchronized multi-client state** — immutable state tree mutated exclusively
  by actions through pure reducers
- **Lazy loading** — clients subscribe to state by URI and load data on demand
- **Write-ahead reconciliation** — clients apply actions optimistically, then
  reconcile with the server's echoed actions
- **Forward-compatible versioning** — newer clients connect to older servers via
  capabilities negotiation

## State tree

The state is addressed by URI. Two resource types exist:

| URI | Type | Contents |
|-----|------|----------|
| `agenthost:/root` | Root state | Available agents, models, active session count |
| `<provider>:/<uuid>` | Session state | Turns, tool calls, permissions, streaming text |

**Root state:**
```
agenthost:/root
├── agents: IAgentInfo[]
│   ├── provider: string          (e.g. "copilot")
│   ├── displayName: string
│   ├── description: string
│   ├── models: ISessionModelInfo[]
│   └── protectedResources?: IProtectedResourceMetadata[]
└── activeSessions?: number
```

**Session state:**
```
<provider>:/<uuid>
├── summary: ISessionSummary
│   ├── resource, provider, title, status, createdAt, modifiedAt, model?
├── lifecycle: "creating" | "ready" | "creationFailed"
├── creationError?: IErrorInfo
├── serverTools?: IToolDefinition[]
├── activeClient?: ISessionActiveClient
├── turns: ITurn[]               (completed turns)
└── activeTurn?: IActiveTurn     (in-progress turn)
    ├── id, userMessage
    ├── streamingText: string    (accumulated deltas)
    ├── responseParts: IResponsePart[]
    ├── toolCalls: Record<string, IToolCallState>
    ├── pendingPermissions: Record<string, IPermissionRequest>
    ├── reasoning: string
    └── usage?: IUsageInfo
```

## Connection lifecycle

### 1. Initialize

First message on a new connection. Negotiates protocol version and optionally
subscribes to initial resources.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientId": "<unique-client-id>",
    "initialSubscriptions": ["agenthost:/root"]
  }
}
```

Response includes `protocolVersion`, `serverSeq`, `snapshots[]` for initial
subscriptions, and optional `defaultDirectory`.

### 2. Subscribe to state

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "subscribe",
  "params": { "resource": "agenthost:/root" }
}
```

Response contains the current state snapshot. After subscribing, mutations arrive
as `action` notifications.

### 3. Create a session

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "createSession",
  "params": {
    "session": "copilot:/<uuid>",
    "provider": "copilot",
    "model": "gpt-4o"
  }
}
```

Then subscribe to the session URI. The session starts in `lifecycle: "creating"`.
Wait for `session/ready` (success) or `session/creationFailed` (failure) action.

### 4. Start a turn

Dispatch a `session/turnStarted` action via fire-and-forget notification:

```json
{
  "jsonrpc": "2.0",
  "method": "dispatchAction",
  "params": {
    "clientSeq": 1,
    "action": {
      "type": "session/turnStarted",
      "session": "copilot:/<uuid>",
      "turnId": "<unique-turn-id>",
      "userMessage": { "text": "Hello, world!" }
    }
  }
}
```

The server streams back `session/delta` actions (text chunks), possibly
`session/toolCallStart` / `session/permissionRequest` actions, and finally
`session/turnComplete`.

### 5. Handle tool calls

Tool call lifecycle:

```
streaming → pending-confirmation → running → completed
                                          → pending-result-confirmation → completed
            OR → cancelled (denied/skipped)
```

When a tool needs confirmation (`session/toolCallReady` without `confirmed`),
dispatch:

```json
{
  "type": "session/toolCallConfirmed",
  "session": "<uri>",
  "turnId": "<turn-id>",
  "toolCallId": "<tool-call-id>",
  "approved": true,
  "confirmed": "user-action"
}
```

### 6. Handle permissions

When the server dispatches `session/permissionRequest`, respond with:

```json
{
  "type": "session/permissionResolved",
  "session": "<uri>",
  "turnId": "<turn-id>",
  "requestId": "<request-id>",
  "approved": true
}
```

Permission kinds: `shell`, `write`, `mcp`, `read`, `url`

### 7. Reconnection

If the connection drops, use `reconnect` instead of `initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "reconnect",
  "params": {
    "clientId": "<same-client-id>",
    "lastSeenServerSeq": 42,
    "subscriptions": ["agenthost:/root", "copilot:/<uuid>"]
  }
}
```

Server responds with either:
- `{ type: "replay", actions: [...] }` — missed actions since `lastSeenServerSeq`
- `{ type: "snapshot", snapshots: [...] }` — fresh state if gap exceeds buffer

Protocol notifications (session added/removed) are **not** replayed on reconnect.
Re-fetch session list via `listSessions()` after reconnecting.

## Actions

Actions are the sole mechanism for state mutation. Each action is wrapped in an
`ActionEnvelope` with a monotonically increasing `serverSeq` and optional
`origin` (client who dispatched it).

### All action types (25 total)

#### Root actions (server-only)
| Type | Payload | Description |
|------|---------|-------------|
| `root/agentsChanged` | `agents: IAgentInfo[]` | Available agents or models changed |
| `root/activeSessionsChanged` | `activeSessions: number` | Active session count changed |

#### Session lifecycle (server-only)
| Type | Payload | Description |
|------|---------|-------------|
| `session/ready` | `session` | Session backend initialized |
| `session/creationFailed` | `session, error` | Session failed to initialize |

#### Turn lifecycle
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `session/turnStarted` | **Yes** | `session, turnId, userMessage` | Start a new turn |
| `session/delta` | No | `session, turnId, content` | Streaming text chunk |
| `session/responsePart` | No | `session, turnId, part` | Structured content part |
| `session/turnComplete` | No | `session, turnId` | Turn finished |
| `session/turnCancelled` | **Yes** | `session, turnId` | Abort in-progress turn |
| `session/error` | No | `session, turnId, error` | Error during turn |

#### Tool calls
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `session/toolCallStart` | No | `session, turnId, toolCallId, toolName, displayName` | Tool invocation began |
| `session/toolCallDelta` | No | `session, turnId, toolCallId, content` | Streaming tool parameters |
| `session/toolCallReady` | No | `session, turnId, toolCallId, invocationMessage, toolInput?` | Parameters complete; ready for execution |
| `session/toolCallConfirmed` | **Yes** | `session, turnId, toolCallId, approved, confirmed/reason` | Approve or deny tool call |
| `session/toolCallComplete` | **Yes** | `session, turnId, toolCallId, result` | Tool execution finished |
| `session/toolCallResultConfirmed` | **Yes** | `session, turnId, toolCallId, approved` | Approve or deny tool result |

#### Permissions
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `session/permissionRequest` | No | `session, turnId, request` | Permission needed from user |
| `session/permissionResolved` | **Yes** | `session, turnId, requestId, approved` | Permission granted or denied |

#### Metadata (server-originated, some client-dispatchable)
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `session/titleChanged` | No | `session, title` | Session title updated |
| `session/usage` | No | `session, turnId, usage` | Token usage report |
| `session/reasoning` | No | `session, turnId, content` | Model reasoning/thinking text |
| `session/modelChanged` | **Yes** | `session, model` | Model changed for session |
| `session/serverToolsChanged` | No | `session, tools` | Server tools changed |
| `session/activeClientChanged` | **Yes** | `session, activeClient` | Active client changed |
| `session/activeClientToolsChanged` | **Yes** | `session, tools` | Active client's tools changed |

### Client-dispatchable actions (9 total)

1. `session/turnStarted`
2. `session/turnCancelled`
3. `session/toolCallConfirmed`
4. `session/toolCallComplete`
5. `session/toolCallResultConfirmed`
6. `session/permissionResolved`
7. `session/modelChanged`
8. `session/activeClientChanged`
9. `session/activeClientToolsChanged`

## JSON-RPC commands

### Requests (client → server, expect response)

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `initialize` | `protocolVersion, clientId, initialSubscriptions?` | `protocolVersion, serverSeq, snapshots[], defaultDirectory?` | Establish connection |
| `reconnect` | `clientId, lastSeenServerSeq, subscriptions[]` | `{type: "replay", actions[]}` or `{type: "snapshot", snapshots[]}` | Re-establish dropped connection |
| `subscribe` | `resource` | `snapshot` | Subscribe to URI state |
| `createSession` | `session, provider?, model?, workingDirectory?` | `null` | Create new session |
| `disposeSession` | `session` | `null` | Dispose session |
| `listSessions` | `{}` | `sessions: ISessionSummary[]` | List all sessions |
| `fetchContent` | `uri` | `data, encoding, mimeType?` | Fetch large content by reference |
| `browseDirectory` | `uri?` | `entries[], canBrowseParent` | List directory entries |
| `fetchTurns` | `session, before?, limit?` | `turns[], hasMore` | Fetch historical turns |
| `authenticate` | `resource, token` | `{}` | Push Bearer token for protected resource |

### Notifications (fire-and-forget)

**Client → Server:**
| Method | Params | Description |
|--------|--------|-------------|
| `unsubscribe` | `resource` | Stop receiving updates for URI |
| `dispatchAction` | `clientSeq, action` | Dispatch state-changing action (write-ahead) |

**Server → Client:**
| Method | Params | Description |
|--------|--------|-------------|
| `action` | `ActionEnvelope` | Broadcast action to subscribed clients |
| `notification` | `IProtocolNotification` | Broadcast notification (session added/removed, auth required) |

## Error codes

### Standard JSON-RPC 2.0
| Code | Name | Meaning |
|------|------|---------|
| `-32700` | `ParseError` | Invalid JSON |
| `-32600` | `InvalidRequest` | Not a valid JSON-RPC request |
| `-32601` | `MethodNotFound` | Unknown method name |
| `-32602` | `InvalidParams` | Invalid method parameters |
| `-32603` | `InternalError` | Unspecified server error |

### AHP application errors
| Code | Name | Meaning |
|------|------|---------|
| `-32001` | `SessionNotFound` | Referenced session URI does not exist |
| `-32002` | `ProviderNotFound` | Requested agent provider not registered |
| `-32003` | `SessionAlreadyExists` | Session with given URI already exists |
| `-32004` | `TurnInProgress` | Operation requires no active turn, but one is running |
| `-32005` | `UnsupportedProtocolVersion` | Client's protocol version not supported |
| `-32006` | `ContentNotFound` | Requested content URI does not exist |
| `-32007` | `AuthRequired` | Client has not authenticated for required resource |

## Write-ahead reconciliation

Clients maintain three pieces of state:
- `confirmedState` — last fully server-acknowledged state
- `pendingActions[]` — optimistically applied, not yet echoed by server
- `optimisticState` (computed) — `confirmedState` with `pendingActions` replayed

When receiving an `ActionEnvelope` from the server:

1. **Own action echoed** (`origin.clientId === myId`): pop from `pendingActions`,
   apply to `confirmedState`
2. **Foreign action** (different origin or server-originated): apply to
   `confirmedState`, rebase remaining `pendingActions`
3. **Rejected action** (echoed with `rejectionReason`): remove from
   `pendingActions` (optimistic effect reverted)
4. Recompute `optimisticState` from `confirmedState` + remaining `pendingActions`

This works because most session actions are **append-only** (add turn, append
delta, add tool call). Rare conflicts resolved by server-wins semantics.

## Authentication

When an agent declares `protectedResources` in its `IAgentInfo`:

1. Server sends `notify/authRequired` notification
2. Client obtains Bearer token from the declared `authorization_servers`
3. Client pushes token via `authenticate` command
4. Server validates and responds with `{}` or error `-32007`

Token expiry triggers a new `notify/authRequired` notification with
`reason: "expired"`.

## Protocol notifications

Three notification types (NOT part of state tree, NOT replayed on reconnect):

| Type | Payload | Description |
|------|---------|-------------|
| `notify/sessionAdded` | `summary: ISessionSummary` | New session created |
| `notify/sessionRemoved` | `session: URI` | Session disposed |
| `notify/authRequired` | `resource, reason` | Authentication needed or expired |

## Testing with an AHP server

To start a VS Code AHP server for testing:

```bash
# From the VS Code repository
./scripts/code-server.sh --agent-host-port 8080
```

Then connect: `ahpx connect ws://localhost:8080`

## Further reading

The full protocol specification lives in the
agent-host-protocol
repository:

- `docs/guide/` — conceptual overviews (getting started, state model,
  reconciliation)
- `docs/specification/` — normative spec (transport, lifecycle, subscriptions,
  versioning)
- `types/` — canonical TypeScript type definitions
