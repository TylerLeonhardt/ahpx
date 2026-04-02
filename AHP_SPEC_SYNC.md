# AHP Spec Sync

Records when ahpx was last synchronized with the [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) specification.

## Last Synced

| Field | Value |
|-------|-------|
| **Spec Commit** | `bb780aef8e735f78e80c5a86350442e0fbb66462` |
| **Spec Repo** | `microsoft/agent-host-protocol` |
| **Synced On** | 2026-04-02 |
| **ahpx Commit** | *(see PR branch `ahp-spec-sync-bb780ae`)* |

## What Was Implemented

### Breaking Changes Applied

- **State restructuring**: `IActiveTurn.streamingText`, `toolCalls` (Record), `pendingPermissions` (Record), and `reasoning` fields removed. All content now lives in `responseParts[]` as `IMarkdownResponsePart`, `IToolCallResponsePart`, and `IReasoningResponsePart`.
- **ITurn restructured**: `responseText` and `toolCalls` removed; content derives from `responseParts[]`.
- **Permissions removed**: `PermissionKind`, `IPermissionRequest`, `session/permissionRequest`, `session/permissionResolved` all deleted from protocol types and all application code.
- **Commands renamed**: `fetchContent` → `resourceRead`, `browseDirectory` → `resourceList`.
- **IContentRef split**: Plain `IContentRef` interface + `IResourceReponsePart extends IContentRef` for response parts.
- **Tool result types renamed**: `IToolResultBinaryContent` → `IToolResultEmbeddedResourceContent`, `ToolResultContentType.Binary` → `ToolResultContentType.EmbeddedResource`.
- **Content result field renamed**: `mimeType` → `contentType` in resource read results.
- **Response part IDs**: `IMarkdownResponsePart` and `IReasoningResponsePart` now have required `id` fields.
- **Action partId**: `session/delta` and `session/reasoning` actions now require `partId` to target specific response parts.

### Additive Features Added

- **New resource commands**: `resourceWrite`, `resourceCopy`, `resourceDelete`, `resourceMove` on `AhpClient`.
- **New actions**: `session/pendingMessageSet`, `session/pendingMessageRemoved`, `session/queuedMessagesReordered`, `session/customizationsChanged`, `session/customizationToggled`, `session/truncated`.
- **New state fields**: `ISessionState.workingDirectory`, `steeringMessage`, `queuedMessages`, `customizations`; `ISessionSummary.workingDirectory`; `ISessionActiveClient.customizations`; `IAgentInfo.customizations`.
- **New types**: `Icon`, `ICustomizationRef`, `ISessionCustomization`, `IPendingMessage`, `PendingMessageKind`, `CustomizationStatus`.
- **New error codes**: `NotFound` (-32008), `PermissionDenied` (-32009), `AlreadyExists` (-32010).
- **Session forking**: `ICreateSessionParams.fork` with `ISessionForkSource`.
- **Title now client-dispatchable**: `session/titleChanged` can be dispatched by clients.
- **Tool call re-confirmation**: `toolCallReady` can be dispatched for running tools (mid-execution permission checks).
- **Confirmation title**: `IToolCallPendingConfirmationState.confirmationTitle` and `IToolCallReadyAction.confirmationTitle`.
- **Queued messages**: `ISessionTurnStartedAction.queuedMessageId` for auto-started turns.
- **Cache tokens**: `IUsageInfo.cacheReadTokens`.
- **File edit content**: `ToolResultContentType.Resource`, `ToolResultContentType.FileEdit` with `IToolResultResourceContent` and `IToolResultFileEditContent`.

### Application Code Updated

- `AhpClient`: `fetchContent()` → `resourceRead()`, `browseDirectory()` → `resourceList()`, plus new resource commands.
- `TurnController`: Updated to use `responseParts` for tool call lookups; removed permission request/resolved handling.
- `OutputFormatter` interface: `onPermissionRequest()` removed from interface and all implementations.
- `PermissionHandler`: `handlePermission()` method removed (was for `IPermissionRequest`); `handleToolConfirmation()` retained.
- `SessionWatcher`: `showCurrentState()` walks `responseParts` instead of `streamingText`/`toolCalls`/`reasoning`; tool call lookups updated.
- `bin.ts`: Helper functions `turnResponseText()` and `turnToolCallCount()` derive values from `responseParts`.
- Library exports: Updated to new type names, added new exports.
- All 486 tests updated and passing.

## Intentionally Not Implemented

| Feature | Reason |
|---------|--------|
| `session/pendingMessageSet` CLI command | Additive — no existing CLI workflow uses steering/queued messages yet. Can be added as a future `ahpx message` command. |
| `session/truncated` CLI command | Additive — session truncation is a power-user feature. Can be added as `ahpx session truncate`. |
| `session/customizationToggled` CLI command | Additive — customization management UX needs design. |
| Session forking CLI command | Additive — `ahpx session fork` can be added when use case is clearer. |
| `resourceWrite/Copy/Delete/Move` CLI commands | Client API methods are exposed; CLI commands can be added when there's a use case beyond `browse` and `content`. |

These are all additive features that don't affect correctness. The protocol types, reducers, and client API support them — only CLI surface area is deferred.
