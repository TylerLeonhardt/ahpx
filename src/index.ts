/**
 * ahpx — Agent Host Protocol client library.
 *
 * Public API entry point. Exports the core client, transport, protocol,
 * state mirror, and key protocol types for TypeScript consumers.
 *
 * @example
 * ```ts
 * import { AhpClient } from 'ahpx';
 *
 * const client = new AhpClient({ initialSubscriptions: ['agenthost:/root'] });
 * const result = await client.connect('ws://localhost:8082');
 * console.log('Agents:', result.agents);
 * ```
 *
 * @module ahpx
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
export type { ProtocolLayerOptions } from "./client/protocol.js";

// ── State mirror ────────────────────────────────────────────────────────

export { StateMirror } from "./client/state.js";

// ── Active client management ────────────────────────────────────────────

export { ActiveClientManager } from "./client/active-client.js";

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

// ── Session persistence ─────────────────────────────────────────────────

export { SessionStore, buildTurnSummary, truncatePreview } from "./session/store.js";
export type { SessionRecord, SessionFilter, TurnSummary } from "./session/store.js";
export { SessionPersistence } from "./session/persistence.js";
export type { ResumeOutcome, SyncResult } from "./session/persistence.js";

// ── Protocol types ──────────────────────────────────────────────────────
//
// Re-export the subset of protocol types that library consumers encounter
// from AhpClient methods, events, and the state mirror.

// State types
export type {
	URI,
	IRootState,
	ISessionState,
	ISessionSummary,
	IActiveTurn,
	ITurn,
	IToolCallState,
	IUserMessage,
	IUsageInfo,
	IErrorInfo,
	ISnapshot,
	IToolDefinition,
	IToolAnnotations,
	IAgentInfo,
	IPendingMessage,
	IResponsePart,
	IMarkdownResponsePart,
	IToolCallResponsePart,
	IReasoningResponsePart,
} from "./protocol/index.js";

export type {
	ICustomizationRef,
	ISessionCustomization,
	Icon,
} from "./protocol/state.js";

// State enums
export {
	SessionLifecycle,
	SessionStatus,
	ToolCallStatus,
	PendingMessageKind,
	ResponsePartKind,
} from "./protocol/index.js";

// Action types
export type { IActionEnvelope, IStateAction } from "./protocol/index.js";
export { ActionType } from "./protocol/index.js";

// Command result types (returned from AhpClient methods)
export type {
	IInitializeResult,
	ICreateSessionParams,
	ISessionForkSource,
	ISubscribeResult,
	IListSessionsResult,
	IFetchTurnsResult,
	IResourceReadResult,
	IResourceWriteParams,
	IResourceWriteResult,
	IResourceListResult,
	IResourceCopyParams,
	IResourceCopyResult,
	IResourceDeleteParams,
	IResourceDeleteResult,
	IResourceMoveParams,
	IResourceMoveResult,
} from "./protocol/index.js";

export { ContentEncoding } from "./protocol/index.js";

// Notification types (emitted by AhpClient 'notification' event)
export type { IProtocolNotification } from "./protocol/index.js";
