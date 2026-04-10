# AHP Spec Sync

Records when ahpx was last synchronized with the [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) specification.

## Last Synced

| Field | Value |
|-------|-------|
| **Spec Commit** | `1f722585c64b18e3e9e02fc6e2f1f7e3bf4eb0be` |
| **Spec Repo** | `microsoft/agent-host-protocol` |
| **Synced On** | 2026-04-10 |
| **ahpx Commit** | *(see PR branch `ahp-spec-sync-1f72258`)* |

## What Was Implemented

### Breaking Changes Applied

- **SessionStatus enum → bitwise flags**: Changed from string enum (`'idle'`, `'in-progress'`, `'error'`) to numeric bitwise enum (`Idle = 1`, `Error = 2`, `InProgress = 8`, `InputNeeded = 24`). All application code updated to use enum values instead of string literals.
- **CustomizationStatus → const enum**: No longer re-exportable as a runtime value; removed from library exports (still available as compile-time type).
- **SessionDelta no-op for nonexistent partId**: `SessionDelta` targeting a `partId` that doesn't exist in `responseParts` is now a no-op. Parts must be created first by `SessionResponsePart`. Tests updated to match.

### Additive Features Added

- **Terminal support**: Full terminal lifecycle management.
  - New types: `ITerminalInfo`, `ITerminalState`, `ITerminalClaim` (discriminated union: `ITerminalClientClaim`, `ITerminalSessionClaim`), `TerminalClaimKind` enum.
  - New actions (8): `terminal/data`, `terminal/input`, `terminal/resized`, `terminal/claimed`, `terminal/titleChanged`, `terminal/cwdChanged`, `terminal/exited`, `terminal/cleared`.
  - New action union types: `ITerminalAction`, `IClientTerminalAction`, `IServerTerminalAction`.
  - New commands: `createTerminal`, `disposeTerminal` on `AhpClient`.
  - New reducer: `terminalReducer()` for terminal-scoped state.
  - `IRootState.terminals` field for server-known terminals.
  - `ISnapshot.state` widened to include `ITerminalState`.
  - `StateMirror` updated with terminal state tracking, snapshot handling, and action routing.

- **Session input / elicitation**: Structured input collection from the user during turns.
  - New types: `ISessionInputRequest`, `ISessionInputQuestion` (6 question kinds: text, number, integer, boolean, single-select, multi-select), `ISessionInputAnswer`, `ISessionInputOption`, `ISessionInputAnswerValue` (5 value kinds).
  - New enums: `SessionInputQuestionKind`, `SessionInputAnswerValueKind`, `SessionInputAnswerState`, `SessionInputResponseKind`.
  - New actions: `session/inputRequested`, `session/inputAnswerChanged` (client-dispatchable), `session/inputCompleted` (client-dispatchable).
  - `ISessionState.inputRequests` field.
  - `SessionStatus.InputNeeded` bitwise flag for pending input.

- **Session metadata enhancements**:
  - `ISessionSummary.isRead`, `isDone`, `diffs`, `project` fields.
  - New types: `ISessionFileDiff`, `IProjectInfo`.
  - New actions: `session/isReadChanged` (client-dispatchable), `session/isDoneChanged` (client-dispatchable), `session/diffsChanged`.
  - New notification: `ISessionSummaryChangedNotification` (`notify/sessionSummaryChanged`).

- **Tool call content updates**: Live partial content during tool execution.
  - New action: `session/toolCallContentChanged`.
  - `IToolCallRunningState.content` field.

- **New tool result content types**:
  - `IToolResultTerminalContent` (`ToolResultContentType.Terminal`).
  - `IToolResultSubagentContent` (`ToolResultContentType.Subagent`).

- **Reducer improvements**:
  - New helpers: `summaryStatus()`, `refreshSummaryStatus()`, `hasPendingToolCallConfirmation()`.
  - Existing session actions wrapped with `refreshSummaryStatus()` for correct status derivation.
  - `isClientDispatchable()` now accepts `ITerminalAction` and returns `IClientTerminalAction`.

### Application Code Updated

- `StateMirror`: Added terminal state storage, snapshot handling, and action routing via `terminalReducer`.
- `AhpClient`: Added `createTerminal()` and `disposeTerminal()` command methods.
- `bin.ts`: Updated session status display to use `SessionStatus` enum values (handles `Idle`, `InProgress`, `InputNeeded`, `Error`).
- `src/index.ts`: Exported all new types, enums, actions, commands, notifications, and `terminalReducer`.
- All 626 tests updated and passing.

## Intentionally Not Implemented

| Feature | Reason |
|---------|--------|
| Terminal CLI commands (`ahpx terminal create/attach/list`) | Additive — terminal UX needs design. Client API methods are exposed; CLI can be added when use case is clearer. |
| Session input/elicitation interactive CLI | Additive — requires significant interactive prompt UX (multi-question forms, select menus). `TurnController` and `OutputFormatter` can be extended when this is prioritized. |
| Session diff display (`ahpx session diffs`) | Additive — can be added as part of `session info` or a dedicated command. |
| `isRead`/`isDone` CLI commands | Additive — `dispatchAction` can already set these via client-dispatchable actions. CLI surface can be added when needed. |
| `SessionSummaryChangedNotification` CLI handling | Additive — notification is emitted on the `notification` event for library consumers. CLI integration can be added for real-time session list updates. |

These are all additive features that don't affect correctness. The protocol types, reducers, client API, and library exports support them — only CLI surface area and turn controller integration are deferred.
