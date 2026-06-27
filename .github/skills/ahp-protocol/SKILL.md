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

The state is addressed by URI. The main resource types are:

| URI | Type | Contents |
|-----|------|----------|
| `ahp-root://` | Root state | Available agents, models, active session count |
| `<provider>:/<uuid>` | Session state | Summary, lifecycle, chats catalog, active client, customizations |
| chat channel | Chat state | Turns, the active turn, tool calls, streaming response parts |

> **Session / chat split (0.3+).** A session's *coordination* state (its
> metadata, lifecycle, the catalogue of chats, and active clients) is separate
> from a chat's *conversation* state (turns and the in-progress turn). A session
> lists its chats in `chats` and names a `defaultChat`. **As of 0.5.0 the default
> chat MAY be a distinct channel** (e.g. `ahp-chat://default/<id>`) rather than
> sharing the session URI, so ahpx resolves `defaultChat` from the session
> snapshot, subscribes to it, and dispatches turn (`chat/*`) actions there. When a
> host keeps chat on the session URI, `defaultChat` equals the session URI and the
> two views share one key.

**Root state:**
```
ahp-root://
├── agents: AgentInfo[]
│   ├── provider: string          (e.g. "copilot")
│   ├── displayName: string
│   ├── description: string
│   ├── models: SessionModelInfo[]
│   └── protectedResources?: ProtectedResourceMetadata[]
└── activeSessions?: number
```

**Session state** (coordination — `SessionState`):
```
<provider>:/<uuid>
├── provider, title, status, activity?    (SessionMetadata, inlined flat — no nested `summary`)
├── lifecycle: "creating" | "ready" | "creationFailed"
├── serverTools?: ToolDefinition[]
├── activeClients: SessionActiveClient[]   (clients providing tools + customizations)
├── customizations?: Customization[]
├── config?: SessionConfigState
├── changesets?: Changeset[]
├── chats: ChatSummary[]                    (catalogue of this session's chats)
└── defaultChat?: URI                       (the chat channel turns are dispatched on)
```

> **0.5.0 shape changes.** `SessionState` now **inlines** every `SessionMetadata`
> field (`provider`, `title`, `status`, `activity`, `workingDirectory`, …)
> directly — there is no nested `summary` object (read `state.title`, not
> `state.summary.title`). The single `activeClient` became an **`activeClients`
> array** (a session can have several). `SessionStatus` is a **bitset** (`Idle=1`,
> `Error=2`, `InProgress=8`, `InputNeeded=24`, `IsRead=32`, `IsArchived=64`) — use
> bitwise checks, not equality. There is **no session-level `model`** anymore;
> model selection is carried per-message on `Message.model` (a `ModelSelection`
> `{ id, config? }`). The lightweight catalog entry on the root channel is still
> `SessionSummary` (which also extends `SessionMetadata`).

**Chat state** (conversation — `ChatState`):
```
chat channel
├── resource, title, status, modifiedAt
├── turns: Turn[]                 (completed turns)
│   └── { id, message, responseParts[], usage, state, error? }
├── activeTurn?: ActiveTurn       (in-progress turn)
│   ├── id
│   ├── message: Message          ({ text, origin: { kind }, attachments? })
│   ├── responseParts: ResponsePart[]   (markdown, toolCall, reasoning, …)
│   └── usage?: UsageInfo
├── steeringMessage?: PendingMessage
├── queuedMessages?: PendingMessage[]
└── inputRequests?: ChatInputRequest[]
```

> **Response-parts model.** Streaming text, tool calls, and reasoning are not
> separate maps on the turn — they are ordered entries in `responseParts[]`,
> discriminated by `kind` (`ResponsePartKind.Markdown`, `.ToolCall`,
> `.Reasoning`, …). A tool call is a `ResponsePart` whose `toolCall` carries a
> `ToolCallState` (a status discriminated union with an optional `contributor`).
> Derive a turn's text by concatenating its markdown parts; iterate
> `responseParts` filtered by kind to find tool calls.

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
    "initialSubscriptions": ["ahp-root://"]
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
  "params": { "resource": "ahp-root://" }
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
    "channel": "copilot:/<uuid>",
    "provider": "copilot",
    "workingDirectory": "file:///path/to/project",
    "config": {}
  }
}
```

`createSession` no longer accepts a `model` (model is per-message — see step 4).
Then subscribe to the session URI. The session starts in `lifecycle: "creating"`.
Wait for `session/ready` (success) or `session/creationFailed` (failure) action.

### 4. Start a turn

Dispatch a `chat/turnStarted` action via fire-and-forget notification. The
target channel is carried in `params.channel` — the chat URI, which is the
session's `defaultChat` (a distinct `ahp-chat://` channel on hosts that split it,
or the session URI when they don't). The action no longer carries a `session`
field. The chosen model rides on `message.model` (`{ id, config? }`); omit it to
use the host default:

```json
{
  "jsonrpc": "2.0",
  "method": "dispatchAction",
  "params": {
    "channel": "ahp-chat://default/<id>",
    "clientSeq": 1,
    "action": {
      "type": "chat/turnStarted",
      "turnId": "<unique-turn-id>",
      "message": {
        "text": "Hello, world!",
        "origin": { "kind": "user" },
        "model": { "id": "gpt-4o" }
      }
    }
  }
}
```

The server streams back `chat/responsePart` / `chat/delta` actions (text chunks),
possibly `chat/toolCallStart` / `chat/toolCallReady` actions, a `chat/usage`
action, and finally `chat/turnComplete`.

### 5. Handle tool calls

Tool call lifecycle:

```
streaming → pending-confirmation → running → completed
                                          → pending-result-confirmation → completed
            OR → cancelled (denied/skipped)
```

When a tool needs confirmation (`chat/toolCallReady` without `confirmed`),
dispatch on the chat channel:

```json
{
  "type": "chat/toolCallConfirmed",
  "turnId": "<turn-id>",
  "toolCallId": "<tool-call-id>",
  "approved": true,
  "reason": "user-action"
}
```

### 6. Permissions via tool-call confirmation

There is no separate permission action pair. A tool call that requires user
approval surfaces as `chat/toolCallReady` (without `confirmed`); the client
approves or denies by dispatching `chat/toolCallConfirmed` as above. Some tools
also require result approval — the server sends `chat/toolCallComplete` with
`requiresResultConfirmation`, and the client replies with
`chat/toolCallResultConfirmed`.

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
    "subscriptions": ["ahp-root://", "copilot:/<uuid>"]
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

### Action types

Channel-scoped: an action no longer carries a `session` field — the target
channel travels in the envelope (`ActionEnvelope.channel`) and in
`dispatchAction`'s `params.channel`. Turn, streaming, tool-call, usage,
reasoning, and error actions live on the **chat** channel (`chat/*`); session
lifecycle and metadata actions live on the **session** channel (`session/*`).

#### Root actions (server-only)
| Type | Payload | Description |
|------|---------|-------------|
| `root/agentsChanged` | `agents: AgentInfo[]` | Available agents or models changed |
| `root/activeSessionsChanged` | `activeSessions: number` | Active session count changed |

#### Session lifecycle & metadata (`session/*`)
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `session/ready` | No | — | Session backend initialized |
| `session/creationFailed` | No | `error` | Session failed to initialize |
| `session/titleChanged` | No | `title` | Session title updated |
| `session/activityChanged` | No | `activity` | Human-readable "what it's doing" string changed |
| `session/metaChanged` | No | `_meta` | Provider-specific session metadata changed |
| `session/isReadChanged` | **Yes** | `isRead` | Read/unread flag toggled (status bit) |
| `session/isArchivedChanged` | **Yes** | `isArchived` | Archived flag toggled (status bit) |
| `session/agentChanged` | **Yes** | `agent` | Custom agent changed |
| `session/serverToolsChanged` | No | `tools` | Server tools changed |
| `session/activeClientSet` | **Yes** | `activeClient` | Add/refresh an active client (tools + customizations), keyed by `clientId` |
| `session/activeClientRemoved` | **Yes** | `clientId` | Remove an active client by id |
| `session/customizationsChanged` | No | `customizations` | Full customization list replaced |
| `session/customizationToggled` | **Yes** | `id, enabled` | Enable/disable a container customization |
| `session/customizationUpdated` / `customizationRemoved` | No | `customization` / `id` | A single customization changed or was removed |
| `session/mcpServerStateChanged` | No | `id, state` | An MCP server customization's runtime state changed |
| `session/changesetsChanged` | No | `changesets` | Catalogue of subscribable changesets changed |
| `session/configChanged` | No | `config` | Session config schema/values changed |
| `session/chatAdded` / `chatRemoved` / `chatUpdated` | No | `chat` | Session's chat catalogue changed |
| `session/defaultChatChanged` | No | `defaultChat` | Default chat pointer changed |

> **Removed in 0.5.0:** `session/modelChanged` (no session-level model — model is
> per-message), `session/activeClientChanged` and `session/activeClientToolsChanged`
> (replaced by the `activeClientSet` / `activeClientRemoved` pair over the
> `activeClients` array).

#### Turn lifecycle (`chat/*`)
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `chat/turnStarted` | **Yes** | `turnId, message` | Start a new turn (`message: { text, origin: { kind } }`) |
| `chat/delta` | No | `turnId, partId, content` | Streaming text chunk appended to a response part |
| `chat/responsePart` | No | `turnId, part` | Structured response part (markdown / toolCall / reasoning) |
| `chat/usage` | No | `turnId, usage` | Token usage report |
| `chat/reasoning` | No | `turnId, content` | Model reasoning/thinking text |
| `chat/turnComplete` | No | `turnId` | Turn finished |
| `chat/turnCancelled` | **Yes** | `turnId` | Abort in-progress turn |
| `chat/error` | No | `turnId, error` | Error during turn |
| `chat/truncated` | **Yes** | `turnId?` | Truncate turns from history |

#### Tool calls (`chat/*`)
| Type | Client? | Payload | Description |
|------|---------|---------|-------------|
| `chat/toolCallStart` | No | `turnId, toolCallId, toolName, displayName, contributor?` | Tool invocation began |
| `chat/toolCallDelta` | No | `turnId, toolCallId, content` | Streaming tool parameters |
| `chat/toolCallReady` | No | `turnId, toolCallId, invocationMessage, toolInput?, confirmed?` | Parameters complete; ready (or auto-confirmed) |
| `chat/toolCallConfirmed` | **Yes** | `turnId, toolCallId, approved, reason?` | Approve or deny a tool call |
| `chat/toolCallComplete` | **Yes** | `turnId, toolCallId, result` | Tool execution finished |
| `chat/toolCallResultConfirmed` | **Yes** | `turnId, toolCallId, approved` | Approve or deny a tool result |

> Permissions are expressed through the tool-call confirmation flow
> (`chat/toolCallReady` → `chat/toolCallConfirmed`), not a separate permission
> action pair. The `contributor` on a tool call identifies who provides the tool
> (`{ kind: "client", clientId }` for client-contributed tools).

#### Pending / queued messages & input (`chat/*`)
`chat/pendingMessageSet`, `chat/pendingMessageRemoved`,
`chat/queuedMessagesReordered`, `chat/inputRequested`, `chat/inputAnswerChanged`,
`chat/inputCompleted`.

Client-dispatchability is encoded in the package's `IS_CLIENT_DISPATCHABLE` map
(`isClientDispatchable(type)`); the **Client?** columns above reflect it.

## JSON-RPC commands

### Requests (client → server, expect response)

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `initialize` | `protocolVersion, clientId, initialSubscriptions?` | `protocolVersion, serverSeq, snapshots[], defaultDirectory?` | Establish connection |
| `reconnect` | `clientId, lastSeenServerSeq, subscriptions[]` | `{type: "replay", actions[]}` or `{type: "snapshot", snapshots[]}` | Re-establish dropped connection |
| `subscribe` | `channel` | `snapshot` | Subscribe to URI state |
| `createSession` | `channel, provider?, workingDirectory?, config?, activeClient?, fork?` | `null` | Create new session (no `model` — model is per-message) |
| `disposeSession` | `channel` | `null` | Dispose session |
| `listSessions` | `{}` | `sessions: SessionSummary[]` | List all sessions |
| `resourceRead` | `channel/uri` | `data, encoding, mimeType?` | Read a resource / large content by reference |
| `resourceList` | `uri?` | `entries[]` | List directory entries |
| `fetchTurns` | `channel, before?, limit?` | `turns[], hasMore` | Fetch historical turns |
| `authenticate` | `resource, token` | `{}` | Push Bearer token for protected resource |

Most command params extend `BaseParams`, which carries the target `channel` URI.

### Notifications (fire-and-forget)

**Client → Server:**
| Method | Params | Description |
|--------|--------|-------------|
| `unsubscribe` | `channel` | Stop receiving updates for URI |
| `dispatchAction` | `channel, clientSeq, action` | Dispatch state-changing action (write-ahead) |

**Server → Client:**
| Method | Params | Description |
|--------|--------|-------------|
| `action` | `ActionEnvelope` | Broadcast action to subscribed clients |
| `root/sessionAdded` / `root/sessionRemoved` / `root/sessionSummaryChanged` / `auth/required` | `*Params` | Notifications (session list churn, auth required) |

> The package discriminates notifications by JSON-RPC **method** — its
> notification param types carry no `type` field. ahpx layers a `type`
> discriminator on top in `src/notifications.ts` (see the architecture skill).

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

When an agent declares `protectedResources` in its `AgentInfo`:

1. Server sends an `auth/required` notification
2. Client obtains Bearer token from the declared `authorization_servers`
3. Client pushes token via `authenticate` command
4. Server validates and responds with `{}` or error `-32007`

Token expiry triggers a new `auth/required` notification with
`reason: AuthRequiredReason.Expired`.

## Protocol notifications

Notifications are addressed by JSON-RPC method (NOT part of the state tree, NOT
replayed on reconnect):

| Method | Payload | Description |
|------|---------|-------------|
| `root/sessionAdded` | `summary: SessionSummary` | New session created |
| `root/sessionRemoved` | `session: URI` | Session disposed |
| `root/sessionSummaryChanged` | `summary` | Session summary changed |
| `auth/required` | `resource, reason` | Authentication needed or expired |

Re-fetch the session list via `listSessions()` after reconnecting, since
notifications are not replayed.

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
