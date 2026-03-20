# AHP Protocol Feedback for Agent Dispatch

## Executive Summary

The Agent Host Protocol (AHP) provides a solid foundation for agent dispatch: synchronized multi-client state, structured streaming, session persistence, and reconnection support. For George's use case — dispatching coding agents to projects — **the transport and observation layers work well**. However, the protocol has significant gaps in **agent configuration**, **session metadata**, and **operational visibility** that make production-grade dispatch difficult without workarounds.

The most impactful gaps are:
1. **No system prompt or agent persona configuration** at session creation — George can't give agents cultural identity through the protocol.
2. **No custom metadata on sessions** — George can't correlate AHP sessions to his internal job tracking.
3. **No turn-level retry mechanism** — if the agent crashes mid-turn, recovery is manual.

These gaps don't block adoption — ahpx already works around some of them at the CLI layer — but addressing them in the protocol would make AHP a first-class dispatch mechanism rather than a transport layer that dispatch systems build on top of.

## What Works Well

### Session lifecycle management
`createSession` / `disposeSession` / `listSessions` provide clean lifecycle control. The session URI scheme (`provider:/<uuid>`) gives clients full control over session identity. The `notify/sessionAdded` and `notify/sessionRemoved` notifications keep all connected clients in sync.

### Streaming and observation
The action-based streaming model (`session/delta`, `session/toolCallStart`, etc.) is excellent for both interactive and non-interactive clients. A watcher can subscribe to any session and receive the full action stream without participating in permissions or tool calls. This is exactly what George needs for progress monitoring.

### Reconnection
The `reconnect` command with `lastSeenServerSeq` and action replay (or snapshot fallback) handles dropped connections gracefully. George's dispatch processes can survive transient network issues without losing session state.

### Client-provided tools
The `session/activeClientToolsChanged` action and `ISessionActiveClient` model allow clients to register tools that the agent can invoke. This is well-designed: the client claims the active role via `session/activeClientChanged`, registers tools via `session/activeClientToolsChanged`, and receives tool calls with `toolClientId` set to its `clientId`. The owning client executes the tool and dispatches `session/toolCallComplete`. This enables George to provide project-specific tools (e.g., CI triggers, deployment commands) to agents.

### Authentication foundation
The `authenticate` command with RFC 9728 `IProtectedResourceMetadata` and RFC 6750 Bearer tokens provides a standards-based authentication flow. The `notify/authRequired` notification with expiry handling covers token lifecycle.

### Protocol versioning
`protocolVersion` negotiation in `initialize` and the `UnsupportedProtocolVersion` error code provide a clean upgrade path for protocol evolution.

## Protocol Gaps

### Gap 1: No System Prompt or Agent Persona Configuration

**Impact:** High

**Current behavior:** `ICreateSessionParams` accepts `session`, `provider`, `model`, and `workingDirectory`. There is no field for a system prompt, custom instructions, or agent persona. The only way to influence agent behavior is through the user message text in `session/turnStarted` (the `IUserMessage.text` field).

**What George needs:** George uses `--agent team-lead` to give agents a cultural identity — development values, quality standards, communication style, tool preferences. Today he embeds this in the user message, but this conflates the task description with the agent configuration. A system prompt is a session-level concern, not a per-turn concern.

**Why it matters:**
- System prompts should persist across turns in a multi-turn session. Embedding them in every user message wastes tokens and is fragile.
- Different dispatchers may want different personas for the same agent provider and model.
- The user message should be the *task*, not the task plus 500 lines of agent configuration.

**Suggested protocol change:** Add an optional `instructions` field to `ICreateSessionParams`:

```typescript
export interface ICreateSessionParams {
  session: URI;
  provider?: string;
  model?: string;
  workingDirectory?: string;
  /** Optional system-level instructions prepended to the agent's context */
  instructions?: string;
}
```

Alternatively, support a richer configuration object:

```typescript
export interface ICreateSessionParams {
  session: URI;
  provider?: string;
  model?: string;
  workingDirectory?: string;
  /** Session configuration passed to the agent backend */
  config?: {
    /** System prompt / custom instructions */
    instructions?: string;
    /** Agent persona identifier (provider-specific) */
    agentId?: string;
  };
}
```

**Reference:** `ICreateSessionParams` in `src/protocol/commands.ts:166-175`

---

### Gap 2: No Custom Metadata on Sessions

**Impact:** High

**Current behavior:** `ISessionSummary` contains `resource`, `provider`, `title`, `status`, `createdAt`, `modifiedAt`, and `model`. There is no mechanism to attach arbitrary key-value metadata to a session. The `ICreateSessionParams` also has no metadata field.

**What George needs:** George needs to correlate AHP sessions to his internal tracking:
- **Job ID** — which George job dispatched this session
- **Project name** — which repository/project this agent is working on
- **User ID** — which user requested this work
- **Branch name** — the git branch the agent should work on
- **Dispatch reason** — why this job was created (issue fix, feature request, etc.)

Without session metadata, George must maintain a separate mapping table from session URIs to job metadata. This mapping is fragile — if George crashes and restarts, he can list sessions via `listSessions` but has no way to identify which session belongs to which job.

**Suggested protocol change:** Add optional `metadata` to both `ICreateSessionParams` and `ISessionSummary`:

```typescript
export interface ICreateSessionParams {
  session: URI;
  provider?: string;
  model?: string;
  workingDirectory?: string;
  /** Client-defined metadata. Opaque to the server — stored and returned as-is. */
  metadata?: Record<string, string>;
}

export interface ISessionSummary {
  resource: URI;
  provider: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  modifiedAt: number;
  model?: string;
  /** Client-defined metadata from session creation */
  metadata?: Record<string, string>;
}
```

**Reference:** `ICreateSessionParams` in `src/protocol/commands.ts:166-175`, `ISessionSummary` in `src/protocol/state.ts:222-237`

---

### Gap 3: No Job-Level Abstraction

**Impact:** Medium

**Current behavior:** AHP models two levels: **sessions** (long-lived conversation containers) and **turns** (individual request/response cycles within a session). There is no concept of a "job" or "task" that groups related turns into a logical unit of work.

**What George needs:** George thinks in terms of *jobs*: "fix the auth bug on branch `fix/auth-403`". A job might be:
- A single turn in a one-shot `exec` dispatch
- Multiple turns in a session-based dispatch (implement, then test, then fix)
- A turn that fails and gets retried

George currently builds this abstraction himself, tracking job state externally. This works but means job status lives outside AHP — you can't ask the AHP server "what jobs are running?"

**Why this is medium, not high:** George already handles job tracking. The real cost is operational: without server-side job awareness, you can't build dashboards, set job-level timeouts, or correlate observability data to jobs from the server's perspective. This is a "nice to have" for V1, but will become important at scale.

**Suggested protocol change:** This could be addressed without a new abstraction by combining Gap 2 (session metadata) with a convention:

```json
{
  "metadata": {
    "job.id": "j-a1b2c3",
    "job.project": "myapp",
    "job.dispatched-by": "george"
  }
}
```

If the protocol team wants a first-class concept, consider an optional `jobId` field on `ICreateSessionParams` that groups sessions, with a `listJobs` command.

**Reference:** `ICreateSessionParams` in `src/protocol/commands.ts:166-175`

---

### Gap 4: Working Directory Is Unenforceable Metadata

**Impact:** Medium

**Current behavior:** `ICreateSessionParams.workingDirectory` is an optional `string`. The protocol defines no semantics around it — it's not clear whether the server uses it as the agent's working directory, whether the agent is constrained to it, or whether it's purely informational. There is no mention of sandboxing, chroot, or filesystem access boundaries.

**What George needs:** When George dispatches an agent to work on project X, the agent should operate within project X's directory. More importantly, George needs confidence that the agent won't accidentally modify files in project Y. This isn't about security (agents run with George's permissions) — it's about **blast radius containment**.

**Suggested protocol change:** Two levels of improvement:

1. **Minimum:** Document that `workingDirectory` MUST be used as the initial working directory for the agent's tool execution (shell commands, file operations). Make it a SHOULD-level requirement in the spec.

2. **Better:** Add an optional `sandboxOptions` field:

```typescript
export interface ICreateSessionParams {
  session: URI;
  provider?: string;
  model?: string;
  workingDirectory?: string;
  /** Filesystem access constraints (advisory; enforcement is server-dependent) */
  sandbox?: {
    /** Restrict file operations to these directories */
    allowedPaths?: string[];
    /** Deny shell access entirely */
    denyShell?: boolean;
  };
}
```

**Reference:** `ICreateSessionParams` in `src/protocol/commands.ts:166-175`

---

### Gap 5: No Lightweight Progress Polling

**Impact:** Low

**Current behavior:** Progress monitoring requires a WebSocket subscription. A client subscribes to a session URI and receives streaming `action` notifications. The `watch` command in ahpx implements this. There is no HTTP endpoint, no polling API, and no way to get session status without a persistent WebSocket connection.

**What George needs:** George's primary dispatch mode already uses a persistent connection (the ahpx process). However, for operational dashboards, health checks, and monitoring systems that are separate from the dispatch process, requiring a WebSocket subscription per session is heavyweight. A simple "GET session status" endpoint would be useful.

**Why this is low impact:** George already has the WebSocket connection through ahpx. The NDJSON output provides real-time progress. The gap is more about operational tooling than core dispatch.

**Suggested protocol change:** Add an optional `getSessionStatus` command:

```typescript
export interface IGetSessionStatusParams {
  session: URI;
}

export interface IGetSessionStatusResult {
  summary: ISessionSummary;
  lifecycle: SessionLifecycle;
  /** Whether a turn is currently in progress */
  hasActiveTurn: boolean;
}
```

This doesn't require subscription and returns a point-in-time snapshot. Clients can poll it at intervals for lightweight monitoring.

**Reference:** `ISessionState` in `src/protocol/state.ts:185-200`, `IListSessionsParams` in `src/protocol/commands.ts:210-214`

---

### Gap 6: Session Transfer Is Implicit, Not Explicit

**Impact:** Medium

**Current behavior:** Session "ownership" in AHP has two dimensions:
1. **Subscription** — any client can subscribe to any session URI and observe it.
2. **Active client** — one client at a time can be the "active client" providing tools and interactive capabilities, controlled via `session/activeClientChanged`.

If George's dispatch process (client A) creates a session and then crashes, the session survives on the server. A new process (client B) can subscribe, dispatch turns, and claim the active client role. However:
- Client B must know the session URI (can discover via `listSessions`, but see Gap 2 — no metadata to identify which session is which).
- The `reconnect` command requires the same `clientId` to get action replay. A different `clientId` gets a fresh `subscribe` snapshot, losing the pending action queue.
- There is no explicit "transfer session" or "claim session" command.

**What George needs:** If George's dispatch worker crashes and a replacement starts, it needs to:
1. Find the orphaned session (requires metadata — Gap 2)
2. Attach to it as the new active client
3. Understand the current state (what turn is in progress, what tool calls are pending)
4. Resume operations

Steps 2-3 work today via `subscribe` + `session/activeClientChanged`. Step 1 is blocked by Gap 2. The gap is primarily about **discoverability of orphaned sessions**, not about the transfer mechanism itself.

**Suggested protocol change:** Addressing Gap 2 (session metadata) mostly solves this. Additionally, the server could automatically release the active client role when the active client disconnects (the `ISessionActiveClientChangedAction` docs say "The server SHOULD automatically dispatch this action with `activeClient: null` when the active client disconnects" — this is good, but should be a MUST).

**Reference:** `ISessionActiveClient` in `src/protocol/state.ts:210-217`, `ISessionActiveClientChangedAction` in `src/protocol/actions.ts:510-527`, `IReconnectParams` in `src/protocol/commands.ts:74-81`

---

### Gap 7: No Turn Retry Mechanism

**Impact:** High

**Current behavior:** If an error occurs during a turn, the server dispatches `session/error` with `IErrorInfo` (containing `errorType`, `message`, optional `stack`). The turn transitions to the error state. There is no protocol-level mechanism to retry a failed turn.

To "retry," the client must dispatch a new `session/turnStarted` action with a new `turnId` and the same (or modified) user message. This is technically possible but:
- The client must detect that the error is retryable (transient LLM failure vs. permanent configuration error). `IErrorInfo.errorType` is a string with no defined taxonomy.
- The client must wait for the errored turn to fully settle (receive `session/turnComplete` or `session/error`) before starting a new turn — the server returns `TurnInProgress` (-32004) if a turn is already active.
- There is no way to tell the server "retry the last turn" — the client must reconstruct the user message.

**What George needs:** Agents occasionally fail due to transient issues (rate limits, model timeouts, network errors). George needs:
1. A defined error taxonomy so he can distinguish retryable from fatal errors.
2. Ideally, a `retryTurn` command that re-executes the last turn without the client reconstructing it.
3. At minimum, clear guidance on the retry protocol pattern (wait for error action, dispatch new turn).

**Suggested protocol change:**

1. **Define error categories** in `IErrorInfo`:
```typescript
export interface IErrorInfo {
  errorType: string;
  message: string;
  stack?: string;
  /** Whether the error is transient and the operation may succeed on retry */
  retryable?: boolean;
  /** Suggested retry delay in milliseconds */
  retryAfterMs?: number;
}
```

2. **Add a `retryTurn` command** (optional, lower priority):
```typescript
export interface IRetryTurnParams {
  session: URI;
  /** ID of the failed turn to retry */
  turnId: string;
  /** New turn ID for the retry attempt */
  newTurnId: string;
}
```

**Reference:** `IErrorInfo` in `src/protocol/state.ts:763-770`, `ISessionErrorAction` in `src/protocol/actions.ts:418-430`, `AhpErrorCodes.TurnInProgress` in `src/protocol/errors.ts:43`

---

### Gap 8: No Concurrent Session Limits or Quotas

**Impact:** Low

**Current behavior:** `IRootState.activeSessions` reports the count of active sessions, but the protocol defines no limits. There is no maximum sessions per server, per client, or per provider. There is no quota or rate-limiting mechanism.

**What George needs:** For production dispatch, George needs to know:
- How many concurrent sessions the server can handle
- Whether creating "too many" sessions will degrade performance or be rejected
- Per-client fairness guarantees if multiple dispatchers share a server

**Why this is low impact:** In practice, the AHP server (VS Code Server) likely has practical limits. George can manage concurrency on his side (limiting how many ahpx processes he spawns). The protocol doesn't *need* to define limits — but it should provide a way for servers to communicate them.

**Suggested protocol change:** Add optional capacity info to `IInitializeResult`:

```typescript
export interface IInitializeResult {
  protocolVersion: number;
  serverSeq: number;
  snapshots: ISnapshot[];
  defaultDirectory?: URI;
  /** Server capacity hints (advisory) */
  limits?: {
    /** Maximum concurrent sessions (server-wide) */
    maxSessions?: number;
    /** Maximum concurrent sessions per client */
    maxSessionsPerClient?: number;
  };
}
```

**Reference:** `IRootState` in `src/protocol/state.ts:105-110`, `IInitializeResult` in `src/protocol/commands.ts:40-49`

---

### Gap 9: Authentication Is Connection-Scoped, Not Identity-Scoped

**Impact:** Medium

**Current behavior:** Authentication uses the `authenticate` command to push Bearer tokens for protected resources. Tokens are scoped to the connection — if the client reconnects, it must re-authenticate. The protocol has no concept of client identity beyond `clientId` (an opaque string). There are no service accounts, API keys, or mutual TLS.

**What George needs:** For remote dispatch, George needs:
- **Service identity:** George is a bot, not a human. He needs to authenticate as a service, not go through OAuth flows designed for interactive users.
- **Token persistence:** Pushing tokens on every connection is overhead. George wants to authenticate once and have the server remember.
- **Authorization:** Today, any authenticated client can do anything. George may want to dispatch agents that have restricted permissions (e.g., read-only access to certain repos).

**Current workaround:** George uses `AHPX_TOKEN` environment variable, and ahpx handles the `authenticate` command automatically on connection. This works but is a client-side workaround, not protocol-level support.

**Suggested protocol change:**

1. **Add connection-level auth to `initialize`:**
```typescript
export interface IInitializeParams {
  protocolVersion: number;
  clientId: string;
  initialSubscriptions?: URI[];
  /** Pre-authenticate with a service token during handshake */
  authentication?: {
    /** Bearer token */
    token: string;
    /** Resource the token is for */
    resource: string;
  };
}
```

2. **Long-term:** Define a service account model where `clientId` maps to a set of permissions, independent of individual resource tokens.

**Reference:** `IAuthenticateParams` in `src/protocol/commands.ts:461-469`, `IInitializeParams` in `src/protocol/commands.ts:25-32`, `IProtectedResourceMetadata` in `src/protocol/state.ts:33-85`

---

### Gap 10: No Agent Crash Detection or Health Signaling

**Impact:** Medium

**Current behavior:** If the agent backend crashes mid-turn:
- The server may detect the crash and dispatch `session/error` — but this behavior is not specified.
- The session remains in `lifecycle: "ready"` with an `activeTurn` that never completes.
- The client has no heartbeat or health check mechanism to detect a stalled agent.
- The `session/error` action's `IErrorInfo` has no defined error types for agent crashes vs. normal errors.

**What George needs:** George monitors agent activity via NDJSON events. If no events arrive for an extended period, George's inactivity timeout kills the process. But this is a blunt instrument — the agent might be legitimately thinking (long model inference) vs. actually crashed.

A reliable detection mechanism would:
1. Let the server signal agent health proactively
2. Distinguish between "agent is thinking" and "agent is dead"
3. Give the client confidence to either wait or take recovery action

**Suggested protocol change:**

1. **Add a heartbeat action:**
```typescript
export interface ISessionHeartbeatAction {
  type: 'session/heartbeat';
  session: URI;
  turnId: string;
  /** What the agent is doing */
  status: 'thinking' | 'executing-tool' | 'waiting-for-confirmation';
}
```

2. **Define agent crash semantics:** Specify that if the agent backend terminates unexpectedly, the server MUST dispatch `session/error` with `errorType: "agent-crash"` within a bounded time (e.g., 30 seconds).

3. **Add a `ping` command** for client-initiated health checks:
```typescript
export interface IPingParams {}
export interface IPingResult {
  /** Server uptime in milliseconds */
  uptime: number;
  /** Number of healthy agent backends */
  healthyAgents: number;
}
```

**Reference:** `ISessionErrorAction` in `src/protocol/actions.ts:418-430`, `IErrorInfo` in `src/protocol/state.ts:763-770`

## Recommendations

Priority order for addressing these gaps:

### P0 — Address before production dispatch
1. **Gap 1: System prompt / agent persona** — Highest impact. Add `instructions` to `ICreateSessionParams`. This unblocks George's agent identity model without requiring protocol-breaking changes.
2. **Gap 2: Session metadata** — Highest operational impact. Add `metadata` to `ICreateSessionParams` and `ISessionSummary`. Required for session-to-job correlation and orphan recovery.
3. **Gap 7: Turn retry mechanism** — Add `retryable` and `retryAfterMs` to `IErrorInfo`. The retry command itself can wait, but error categorization is critical now.

### P1 — Address for production readiness
4. **Gap 10: Agent crash detection** — Define crash signaling semantics. Consider heartbeat action.
5. **Gap 4: Working directory enforcement** — Clarify semantics in the spec. Sandboxing can be server-implementation-specific.
6. **Gap 6: Session transfer** — Mostly solved by Gap 2. Promote the "server SHOULD release active client on disconnect" to MUST.
7. **Gap 9: Authentication model** — Add `authentication` to `IInitializeParams` for connection-time auth.

### P2 — Nice to have
8. **Gap 3: Job-level abstraction** — Solvable via metadata convention. First-class support can come later.
9. **Gap 8: Concurrent session limits** — Add capacity hints to `IInitializeResult`.
10. **Gap 5: Lightweight polling** — Low urgency given WebSocket subscriptions work well.

## Appendix: Protocol Type References

| Type | File | Line |
|------|------|------|
| `ICreateSessionParams` | `src/protocol/commands.ts` | 166–175 |
| `ISessionSummary` | `src/protocol/state.ts` | 222–237 |
| `ISessionState` | `src/protocol/state.ts` | 185–200 |
| `ISessionActiveClient` | `src/protocol/state.ts` | 210–217 |
| `IErrorInfo` | `src/protocol/state.ts` | 763–770 |
| `IInitializeParams` | `src/protocol/commands.ts` | 25–32 |
| `IInitializeResult` | `src/protocol/commands.ts` | 40–49 |
| `IAuthenticateParams` | `src/protocol/commands.ts` | 461–469 |
| `ISessionActiveClientChangedAction` | `src/protocol/actions.ts` | 510–527 |
| `ISessionActiveClientToolsChangedAction` | `src/protocol/actions.ts` | 530–546 |
| `ISessionErrorAction` | `src/protocol/actions.ts` | 418–430 |
| `IRootState` | `src/protocol/state.ts` | 105–110 |
