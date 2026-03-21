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
export type { AhpClientOptions, AhpClientEvents } from "./client/index.js";

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

// ── Authentication ──────────────────────────────────────────────────────

export { AuthHandler } from "./auth/handler.js";
export type { AuthHandlerOptions } from "./auth/handler.js";

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
	IPermissionRequest,
	IUserMessage,
	IUsageInfo,
	IErrorInfo,
	ISnapshot,
	IToolDefinition,
	IToolAnnotations,
	IAgentInfo,
} from "./protocol/index.js";

// State enums
export {
	SessionLifecycle,
	SessionStatus,
	ToolCallStatus,
	PermissionKind,
} from "./protocol/index.js";

// Action types
export type { IActionEnvelope, IStateAction } from "./protocol/index.js";
export { ActionType } from "./protocol/index.js";

// Command result types (returned from AhpClient methods)
export type {
	IInitializeResult,
	ICreateSessionParams,
	ISubscribeResult,
	IListSessionsResult,
	IFetchTurnsResult,
	IFetchContentResult,
	IBrowseDirectoryResult,
} from "./protocol/index.js";

// Notification types (emitted by AhpClient 'notification' event)
export type { IProtocolNotification } from "./protocol/index.js";
