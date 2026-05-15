# AHP Spec Sync

Records when ahpx was last synchronized with the [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) specification.

## Last Synced

| Field | Value |
|-------|-------|
| **Spec Commit** | `ac3d6f020eb51d1f2a88660f1cc9825fe856b7c7` |
| **Spec Repo** | `microsoft/agent-host-protocol` |
| **Synced On** | 2026-05-15 |
| **ahpx Commit** | *(see PR branch `george/ahp-spec-sync-latest`)* |

## What Was Implemented

### Breaking Changes Applied

- **I-prefix removal**: All protocol interfaces dropped the `I` prefix (e.g. `ISessionState` → `SessionState`, `IActionEnvelope` → `ActionEnvelope`, `ITurn` → `Turn`). ~100 type renames applied across all application code, tests, and library exports.
- **Protocol versioning → SemVer**: `protocolVersion: number` → `protocolVersions: string[]` in `InitializeParams`. `PROTOCOL_VERSION` changed from `1` to `'0.1.0'`. `MIN_PROTOCOL_VERSION` removed. Version negotiation uses SemVer strings.
- **`AttachmentType` → `MessageAttachmentKind`**: Enum renamed with new discriminated union variants (`Simple`, `EmbeddedResource`, `Resource`). New types: `MessageAttachmentBase`, `SimpleMessageAttachment`, `MessageEmbeddedResourceAttachment`, `MessageResourceAttachment`, `TextPosition`, `TextRange`, `TextSelection`.
- **`session/isDoneChanged` → `session/isArchivedChanged`**: Action renamed. `ISessionIsDoneChangedAction` → `SessionIsArchivedChangedAction`.
- **`SessionFileDiff` → `FileEdit`**: Type renamed and restructured.
- **`model` field → `ModelSelection`**: `SessionSummary.model` changed from `string` to `ModelSelection` (object with `id` and optional `config`). `CreateSessionParams.model` and `SessionModelChangedAction.model` also changed. Application code updated to wrap/unwrap `.id`.
- **Session status booleans cleanup**: `isDone` field removed, `isArchived` introduced.
- **Settings type widened**: Settings values changed from `string` to `unknown`.
- **`workingDirectory` removed from `ISessionState`**: Moved to session summary.

### Additive Features Added

- **9 new action types**: `session/customizationUpdated`, `session/isArchivedChanged`, `session/activityChanged`, `session/configChanged`, `session/metaChanged`, `root/configChanged`, `terminal/commandDetectionAvailable`, `terminal/commandExecuted`, `terminal/commandFinished`.
- **8 new command types**: `ping`, `resourceRequest`, `resolveSessionConfig`, `completions`, `sessionConfigCompletions` and related params/results.
- **`SystemNotificationResponsePart`**: New response part kind for system notifications.
- **`ConfirmationOption` / `ConfirmationOptionKind`**: Structured tool call confirmation options with approve/deny/custom kinds.
- **`ModelSelection`**: Structured model selection with per-model configuration.
- **`SessionConfigState` / `RootConfigState`**: New config state types for session and root configuration.
- **Terminal content parts**: `TerminalContentPart`, `TerminalUnclassifiedPart`, `TerminalCommandPart` for structured terminal output.
- **`UnsupportedProtocolVersionErrorData`**: New error data type for version negotiation failures.
- **Provider metadata on `UsageInfo`**: `_meta` field for provider-specific usage metadata.
- **`_meta` on `SessionState`**: Server-owned intrinsic metadata.
- **`SessionInputRequest.message` made optional**.
- **Attachment URI rename**: `path` → `uri` for message attachment paths.

### Application Code Updated

- All 27 application source files updated for I-prefix removal.
- `AhpClient.connect()`: Uses `protocolVersions: [PROTOCOL_VERSION]` (SemVer array).
- `AhpClient.createSession()`: Wraps `model` string as `{ id: model }`.
- `bin.ts`: `printServerInfo` / `serverInfoJson` use `string` protocol version. Model field extracts `.id` from `ModelSelection`. `SessionModelChanged` dispatch wraps model as `{ id: modelId }`.
- `fleet/health.ts`: `ServerHealth.protocolVersion` changed from `number` to `string`.
- `src/index.ts`: Added 30+ new type/enum exports for all additive features.
- All 633 tests passing.

## Intentionally Not Implemented

| Feature | Reason |
|---------|--------|
| Terminal command detection CLI | Additive — new `terminal/commandDetectionAvailable`, `terminal/commandExecuted`, `terminal/commandFinished` actions are handled by reducers. CLI UX for shell integration can be added when needed. |
| Session config CLI commands | Additive — `resolveSessionConfig`, `session/configChanged`, `root/configChanged` are protocol-level. CLI surface for config management can be designed separately. |
| Completions CLI integration | Additive — `completions` and `sessionConfigCompletions` commands are available via client API. Tab-completion UX requires interactive CLI work. |
| Ping CLI command | Additive — `ping` command available via protocol. Could be exposed as `ahpx ping` health check. |
| Resource request CLI | Additive — `resourceRequest` command available via client API. CLI surface can be added as needed. |
| Structured confirmation options UI | Additive — `ConfirmationOption` with `approve`/`deny`/`custom` kinds. Permission handler could be enhanced to show custom options. |
| Session activity display | Additive — `session/activityChanged` action updates state. CLI could display activity status in session info. |
| Session customization update CLI | Additive — `session/customizationUpdated` upserts customization state. Library API supports it; CLI surface deferred. |

These are all additive features that don't affect correctness. The protocol types, reducers, client API, and library exports support them — only CLI surface area and turn controller integration are deferred.
