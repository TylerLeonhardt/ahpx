---
description: >-
  Tool call lifecycle in AHP — state machine, action types, controller routing,
  renderer display, permission handling, and unhandled protocol actions. Use when
  debugging tool call display issues, modifying permission logic, or tracing tool
  execution flow end-to-end.
---

# Tool Call Lifecycle

This document describes how tool calls flow through the AHP protocol, the ahpx
controller, the renderer, and the permission handler.

## AHP tool call state machine

Every tool call progresses through a series of states tracked by `ToolCallStatus`
(from `@microsoft/agent-host-protocol`):

```
Streaming → PendingConfirmation → Running → Completed
                                         → Cancelled
                    → Running → PendingResultConfirmation → Completed
```

| Status | Meaning |
|--------|---------|
| `Streaming` | Server is streaming the tool call parameters (input JSON). |
| `PendingConfirmation` | Parameters are complete; waiting for user/client to confirm. |
| `Running` | Tool is executing (confirmed by user, auto-approved, or not-needed). |
| `PendingResultConfirmation` | Tool produced results that need user review before the model sees them. |
| `Completed` | Tool finished with a `ToolCallResult` (success or failure). |
| `Cancelled` | Tool was denied or cancelled before completion. |

## Protocol action types

Actions are defined in `@microsoft/agent-host-protocol` under `ActionType`.
Tool-call actions are chat-scoped (`chat/*` wire values) and travel on the chat
channel:

| Action | Direction | Purpose |
|--------|-----------|---------|
| `ChatToolCallStart` | Server → Client | Tool call begins; carries `toolName`, `displayName`. State becomes `Streaming`. |
| `ChatToolCallDelta` | Server → Client | Incremental parameter JSON while streaming. |
| `ChatToolCallReady` | Server → Client | Parameters complete. Carries `invocationMessage`, optional `confirmed` field. State becomes `PendingConfirmation` (or `Running` if pre-confirmed). |
| `ChatToolCallConfirmed` | Client → Server | User approved or denied the tool call. |
| `ChatToolCallComplete` | Server → Client | Tool execution finished. Carries `ToolCallResult` with `success`, `pastTenseMessage`, optional `content`. |
| `ChatToolCallResultConfirmed` | Client → Server | **Not yet handled by the controller.** For acknowledging results in `PendingResultConfirmation` state. |
| `ChatToolCallContentChanged` | Server → Client | **Not yet handled by the controller.** Signals that tool output content was updated while running. |

## Server-confirmed vs client-provided tools

### Server-confirmed tools (typical flow)

These are tools whose execution runs on the AHP server (e.g., a server-side
shell, file editor). The full flow is:

```
Start → Delta* → Ready → user confirms → Confirmed → Complete
```

1. `ChatToolCallStart` — controller calls `renderer.onToolCallStart(id, displayName)`.
2. `ChatToolCallDelta` — controller calls `renderer.onToolCallDelta(id, content)`.
3. `ChatToolCallReady` — controller calls `renderer.onToolCallReady(id, callInfo)`,
   then invokes `permissionHandler.handleToolConfirmation(callInfo)`.
4. On approval, controller dispatches `ChatToolCallConfirmed` with `approved: true`.
5. `ChatToolCallComplete` — controller calls `renderer.onToolCallComplete(id, result)`.

### Client-provided tools

These are tools registered by the connecting client (identified by the tool
call's `contributor` being a client contributor whose `clientId` matches
`client.clientId`). The server sets `confirmed` on the Ready action because the
owning client handles execution directly — no user confirmation is needed.

```
Start → Ready(confirmed='not-needed') → [client executes] → Complete
```

**Key difference:** The controller detects `isClientTool` in the
`ChatToolCallReady` handler and `break`s early — it never calls
`renderer.onToolCallReady` or `permissionHandler.handleToolConfirmation`.
This means the **only** renderer output for client tools comes from
`onToolCallStart` (showing `[tool] Name (running)`) and `onToolCallComplete`.

## Controller routing (`src/prompt/controller.ts`)

The `TurnController.prompt()` method listens for `ActionEnvelope` events and
routes each `ActionType` to the appropriate renderer and permission handler
methods:

| ActionType | Controller behavior |
|------------|-------------------|
| `ChatToolCallStart` | Increments `toolCallCount`, calls `renderer.onToolCallStart`. |
| `ChatToolCallDelta` | Calls `renderer.onToolCallDelta`. |
| `ChatToolCallReady` | Looks up the tool call's `contributor` from chat state (via `getChat()`). If it is a client contributor (`{ kind: "client", clientId }`) → break early. Otherwise calls `renderer.onToolCallReady`, then async `permissionHandler.handleToolConfirmation`. On result dispatches `ChatToolCallConfirmed`. |
| `ChatToolCallComplete` | Calls `renderer.onToolCallComplete`. |
| `ChatToolCallResultConfirmed` | **Not handled** — falls through to default case. |
| `ChatToolCallContentChanged` | **Not handled** — falls through to default case. |

## Renderer display (`src/output/renderer.ts`)

The `PromptRenderer` (text mode) renders tool calls as follows:

| Method | Output |
|--------|--------|
| `onToolCallStart(id, name)` | `[tool] Name (running)` — always shown for all tool types. |
| `onToolCallDelta(id, delta)` | Silent — parameter streaming is not displayed. |
| `onToolCallReady(id, call)` | Silent — just tracks state. The permission handler shows any needed prompt. |
| `onToolCallComplete(id, result)` | `[tool] pastTenseMessage (completed)` with optional content preview. Green for success, red for failure. |
| `onToolCallCancelled(id, reason)` | `[tool] cancelled: reason` in red. |

### Terminal output for each tool type

**Server tool requiring confirmation (approve-reads mode, write tool):**
```
[tool] Bash (running)
  Allow Tool: Running `rm -rf build/`? (y/N): y
  [approved]
[tool] Deleted build directory (completed)
```

**Server tool auto-approved (approve-all mode):**
```
[tool] Bash (running)
  [auto-approved]
[tool] Ran npm test (completed)
```

**Client-provided tool:**
```
[tool] Read File (running)
[tool] Read src/index.ts (completed)
```

## Permission handling (`src/permissions/handler.ts`)

Three modes controlled by the `--approve` CLI flag:

| Mode | Behavior |
|------|----------|
| `approve-all` | Auto-approves; prints `[auto-approved]`. |
| `approve-reads` | Auto-approves tools with `readOnlyHint: true` annotation (from `ToolDefinition.annotations`); prompts interactively for others. |
| `deny-all` | Auto-denies; prints `[denied]`. |

The `readOnlyHint` annotation comes from the tool's `ToolDefinition.annotations`
field (mirrors MCP `ToolAnnotations`). The controller looks this up from
`session.serverTools` before constructing the `ToolCallInfo` object.

## Unhandled protocol actions

Two tool call action types exist in the protocol but are **not yet handled** by
the controller:

1. **`ChatToolCallResultConfirmed`** — For the `PendingResultConfirmation`
   state where tool results need user review before being sent to the model.
2. **`ChatToolCallContentChanged`** — Signals that a tool's output content
   was updated while it's still running (e.g., streaming tool output).

Both fall through to the `default` case in the controller's action switch and
are silently ignored.
