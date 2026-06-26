/**
 * ahpx — Agent Host Protocol client library.
 *
 * Public API entry point. Exports the core client, transport, protocol,
 * state mirror, and key protocol types for TypeScript consumers.
 *
 * @example
 * ```ts
 * import { AhpClient } from '@tylerl0706/ahpx';
 *
 * const client = new AhpClient({ initialSubscriptions: ['ahp-root://'] });
 * const result = await client.connect('ws://localhost:8082');
 * console.log('Agents:', result.agents);
 * ```
 *
 * @module @tylerl0706/ahpx
 */

// ── Core client ──────────────────────────────────────────────────────────

export { AhpClient } from "./client/index.js";
export type { AhpClientOptions, AhpClientEvents, OpenSessionOptions } from "./client/index.js";

// ── Session handle ──────────────────────────────────────────────────────

export { SessionHandle } from "./client/session-handle.js";
export type { SessionHandleEvents, PromptOptions, TurnResult as SessionTurnResult } from "./client/session-handle.js";

// ── Connection pool ─────────────────────────────────────────────────────

export { ConnectionPool } from "./client/connection-pool.js";
export type { ConnectionPoolOptions } from "./client/connection-pool.js";

// ── Transport layer (advanced use) ──────────────────────────────────────

export { Transport } from "./client/transport.js";
export type { TransportOptions } from "./client/transport.js";

// ── Protocol layer (advanced use) ───────────────────────────────────────

export { ProtocolLayer, RpcError, RpcTimeoutError } from "./client/protocol.js";
export type { ProtocolLayerOptions, IncomingRequest } from "./client/protocol.js";

// ── State mirror ────────────────────────────────────────────────────────

export { StateMirror } from "./client/state.js";

// ── Active client management ────────────────────────────────────────────

export { ActiveClientManager } from "./client/active-client.js";

// ── File serving (reverse-RPC) ──────────────────────────────────────────

export { FileServingHandler } from "./client/file-serving.js";

// ── Reconnection ────────────────────────────────────────────────────────

export { ReconnectManager } from "./client/reconnect.js";
export type { ReconnectOptions, ReconnectOutcome } from "./client/reconnect.js";

// ── Event forwarding ────────────────────────────────────────────────────

export type { AhpxEvent, EventForwarder } from "./events/forwarder.js";
export { WebhookForwarder } from "./events/webhook-forwarder.js";
export type { WebhookForwarderOptions } from "./events/webhook-forwarder.js";
export { WebSocketForwarder } from "./events/ws-forwarder.js";
export type { WebSocketForwarderOptions } from "./events/ws-forwarder.js";
export { ForwardingFormatter } from "./events/forwarding-formatter.js";
export type { ForwardingFormatterOptions } from "./events/forwarding-formatter.js";

// ── Authentication ──────────────────────────────────────────────────────

export { AuthHandler } from "./auth/handler.js";
export type { AuthHandlerOptions } from "./auth/handler.js";

// ── Fleet management ────────────────────────────────────────────────────

export { HealthChecker } from "./fleet/health.js";
export type { ServerHealth } from "./fleet/health.js";
export { FleetManager } from "./fleet/manager.js";
export type { FleetManagerOptions, RoutingStrategy, ServerRequirements } from "./fleet/manager.js";

// ── Connection config ───────────────────────────────────────────────────

export type { ConnectionProfile } from "./config/connections.js";

// ── Tunnel discovery ────────────────────────────────────────────────────

export {
	AHP_TUNNEL_PORT,
	AHP_TUNNEL_LABEL,
	listAgentHostTunnels,
	getTunnelById,
	resolveTunnelUrl,
	resolveGitHubToken,
} from "./tunnel/index.js";
export type { TunnelInfo } from "./tunnel/index.js";

// ── Session persistence ─────────────────────────────────────────────────

export { SessionStore, buildTurnSummary, truncatePreview } from "./session/store.js";
export type { SessionRecord, SessionFilter, TurnSummary } from "./session/store.js";
export { SessionPersistence } from "./session/persistence.js";
export type { ResumeOutcome, SyncResult } from "./session/persistence.js";

// ── URI utilities ───────────────────────────────────────────────────────

export { ensureFileUri, fileUriToDisplayPath } from "./uri.js";

// ── Protocol types ──────────────────────────────────────────────────────
//
// Re-export the subset of protocol types that library consumers encounter
// from AhpClient methods, events, and the state mirror.

// State types
export type {
	URI,
	RootState,
	RootConfigState,
	SessionState,
	SessionSummary,
	SessionConfigState,
	ActiveTurn,
	Turn,
	ToolCallState,
	Message,
	MessageAttachment,
	MessageAttachmentBase,
	SimpleMessageAttachment,
	MessageEmbeddedResourceAttachment,
	MessageResourceAttachment,
	TextPosition,
	TextRange,
	TextSelection,
	UsageInfo,
	ErrorInfo,
	Snapshot,
	ToolDefinition,
	ToolAnnotations,
	AgentInfo,
	ModelSelection,
	PendingMessage,
	ResponsePart,
	MarkdownResponsePart,
	ToolCallResponsePart,
	ReasoningResponsePart,
	SystemNotificationResponsePart,
	ProjectInfo,
	FileEdit,
	ConfirmationOption,
	TerminalInfo,
	TerminalClientClaim,
	TerminalSessionClaim,
	TerminalClaim,
	TerminalState,
	TerminalContentPart,
	TerminalUnclassifiedPart,
	TerminalCommandPart,
	ChatInputRequest,
	ChatInputQuestion,
	ChatInputTextQuestion,
	ChatInputNumberQuestion,
	ChatInputBooleanQuestion,
	ChatInputSingleSelectQuestion,
	ChatInputMultiSelectQuestion,
	ChatInputOption,
	ChatInputAnswer,
	ChatInputAnswered,
	ChatInputSkipped,
	ChatInputAnswerValue,
	ToolCallResult,
	ToolResultContent,
	ToolResultTextContent,
	ToolResultTerminalContent,
	ToolResultSubagentContent,
	ToolResultFileEditContent,
} from "@microsoft/agent-host-protocol";

export type { CustomizationRef, Icon } from "./customizations/types.js";
/** A customization active in a session (official `Customization` union element). */
export type SessionCustomization = NonNullable<
	import("@microsoft/agent-host-protocol").SessionState["customizations"]
>[number];

// State enums
export {
	PolicyState,
	SessionLifecycle,
	SessionStatus,
	TurnState,
	MessageAttachmentKind,
	ResponsePartKind,
	ToolCallStatus,
	ToolCallConfirmationReason,
	ToolCallCancellationReason,
	ConfirmationOptionKind,
	ToolResultContentType,
	PendingMessageKind,
	ChatInputAnswerState,
	ChatInputAnswerValueKind,
	ChatInputQuestionKind,
	ChatInputResponseKind,
	TerminalClaimKind,
} from "@microsoft/agent-host-protocol";

// Action types
export type { ActionEnvelope, StateAction } from "@microsoft/agent-host-protocol";
export { ActionType } from "@microsoft/agent-host-protocol";

// Action interfaces
export type {
	ChatToolCallContentChangedAction,
	ChatInputRequestedAction,
	ChatInputAnswerChangedAction,
	ChatInputCompletedAction,
	SessionIsReadChangedAction,
	SessionIsArchivedChangedAction,
	SessionActivityChangedAction,
	SessionConfigChangedAction,
	ChangesetStatusChangedAction,
	RootTerminalsChangedAction,
	RootConfigChangedAction,
	TerminalAction,
	ClientTerminalAction,
	ServerTerminalAction,
	TerminalDataAction,
	TerminalInputAction,
	TerminalResizedAction,
	TerminalClaimedAction,
	TerminalTitleChangedAction,
	TerminalCwdChangedAction,
	TerminalExitedAction,
	TerminalClearedAction,
	TerminalCommandDetectionAvailableAction,
	TerminalCommandExecutedAction,
	TerminalCommandFinishedAction,
} from "@microsoft/agent-host-protocol";

// Command result types (returned from AhpClient methods)
export type {
	InitializeResult,
	CreateSessionParams,
	SessionForkSource,
	SubscribeResult,
	ListSessionsResult,
	FetchTurnsResult,
	PingParams,
	ResourceReadResult,
	ResourceWriteParams,
	ResourceWriteResult,
	ResourceListResult,
	ResourceCopyParams,
	ResourceCopyResult,
	ResourceDeleteParams,
	ResourceDeleteResult,
	ResourceMoveParams,
	ResourceMoveResult,
	ResourceRequestParams,
	ResourceRequestResult,
	ResolveSessionConfigParams,
	ResolveSessionConfigResult,
	CompletionsParams,
	CompletionsResult,
	SessionConfigCompletionsParams,
	SessionConfigCompletionsResult,
	CreateTerminalParams,
	DisposeTerminalParams,
} from "@microsoft/agent-host-protocol";

export { ContentEncoding, ReconnectResultType } from "@microsoft/agent-host-protocol";

// Protocol version constants
export { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";

// Notification types (emitted by AhpClient 'notification' event)
export type { ProtocolNotification, SessionSummaryChangedNotification } from "./notifications.js";

// Notification enums
export { NotificationType, AuthRequiredReason } from "./notifications.js";

// Reducers
export { terminalReducer } from "@microsoft/agent-host-protocol";
