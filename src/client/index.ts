/**
 * AhpClient — High-level AHP protocol client.
 *
 * A thin EventEmitter-based facade over the **official**
 * `@microsoft/agent-host-protocol` async-iterator client. ahpx's CLI,
 * `TurnController`, connect-helper, watcher, health, auth, and persistence all
 * consume this surface (`connect`/`createSession`/`subscribe`/`dispatchAction`,
 * `on('action'|'notification'|'disconnected')`, `state.{root,getSession,getChat}`,
 * …). This adapter preserves that surface while delegating protocol/transport to
 * the official client.
 *
 * What stays in this adapter (capabilities the official client does not provide):
 * - {@link WsTransport} — a `ws`-based transport with custom headers (auth /
 *   dev-tunnel), since the official `/ws` transport uses the header-less global
 *   `WebSocket`.
 * - {@link StateMirror} — the official `AhpStateMirror` tracks sessions/terminals/
 *   changesets but not `ahp-chat://` chat state, which the folded-first-delta
 *   recovery depends on.
 * - EventEmitter bridge — fans the official `events()` / `stateChanges()` async
 *   iterators out as `action` / `notification` / `disconnected` events.
 * - reverse-RPC file serving — bridges `setServerRequestHandler` to
 *   {@link FileServingHandler}.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ActionEnvelope, StateAction } from "@microsoft/agent-host-protocol";
import type {
	ContentEncoding,
	FetchTurnsResult,
	InitializeResult,
	ListSessionsResult,
	ResolveSessionConfigParams,
	ResolveSessionConfigResult,
	ResourceCopyParams,
	ResourceCopyResult,
	ResourceDeleteParams,
	ResourceDeleteResult,
	ResourceListResult,
	ResourceMoveParams,
	ResourceMoveResult,
	ResourceReadResult,
	ResourceWriteParams,
	ResourceWriteResult,
	SessionConfigCompletionsParams,
	SessionConfigCompletionsResult,
	SubscribeResult,
} from "@microsoft/agent-host-protocol";
import type { SessionActiveClient, TerminalClaim, URI } from "@microsoft/agent-host-protocol";
import { PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
import { AhpClient as OfficialAhpClient } from "@microsoft/agent-host-protocol/client";
import type {
	ClientEvent,
	ClosedReason,
	ServerRequestHandler,
	SubscriptionEvent,
} from "@microsoft/agent-host-protocol/client";
import type { ProtocolNotification } from "../notifications.js";
import { NotificationType } from "../notifications.js";
import { FileServingHandler } from "./file-serving.js";
import { SessionHandle } from "./session-handle.js";
import { StateMirror } from "./state.js";
import { WsTransport } from "./ws-transport.js";

/** Options for opening a WebSocket connection (subset of {@link AhpClientOptions}). */
export interface ConnectOptions {
	/** Connection timeout in ms (default: 10_000). */
	connectTimeout?: number;
	/** Headers to include in the WebSocket handshake (auth / dev-tunnel). */
	headers?: Record<string, string>;
}

export interface AhpClientOptions {
	/** Unique client identifier (default: random UUID) */
	clientId?: string;
	/** URIs to subscribe to during initialization */
	initialSubscriptions?: URI[];
	/** Connection timeout in ms (default: 10_000) */
	connectTimeout?: number;
	/** Default request timeout in ms (default: 30_000) */
	requestTimeout?: number;
	/** Headers to include in the WebSocket handshake */
	headers?: Record<string, string>;
}

export interface AhpClientEvents {
	action: [envelope: ActionEnvelope];
	notification: [notification: ProtocolNotification];
	connected: [result: InitializeResult];
	disconnected: [code: number, reason: string];
	error: [error: Error];
}

/** Options for opening a session via `AhpClient.openSession()`. */
export interface OpenSessionOptions {
	/** Agent provider (e.g. "copilot"). If omitted, uses the first available. */
	provider?: string;
	/** Model to use for the session. */
	model?: string;
	/** Working directory for the session. */
	workingDirectory?: string;
	/** Agent-specific configuration values collected via `resolveSessionConfig`. */
	config?: Record<string, unknown>;
	/** Eagerly claim the active client role with tools and customizations. */
	activeClient?: SessionActiveClient;
	/** Whether to wait for the session to be ready (default: true). */
	waitForReady?: boolean;
	/** Timeout in ms for waiting for ready state (default: 30000). */
	readyTimeout?: number;
}

/**
 * High-level AHP client.
 *
 * Usage:
 * ```ts
 * const client = new AhpClient();
 * const result = await client.connect("ws://localhost:3000");
 * console.log(result.snapshots[0].state);
 * await client.disconnect();
 * ```
 */
export class AhpClient extends EventEmitter<AhpClientEvents> {
	private official: OfficialAhpClient | undefined;
	private transport: WsTransport | undefined;
	private readonly _state = new StateMirror();
	private readonly _sessions = new Map<string, SessionHandle>();
	private readonly _fileServing = new FileServingHandler();
	private _clientId: string;
	private _connected = false;
	private _disconnectedEmitted = false;

	constructor(private readonly options: AhpClientOptions = {}) {
		super();
		this._clientId = options.clientId ?? randomUUID();
	}

	/** Whether the client is currently connected. */
	get connected(): boolean {
		return this._connected;
	}

	/** The local state mirror. */
	get state(): StateMirror {
		return this._state;
	}

	/** The client identifier. */
	get clientId(): string {
		return this._clientId;
	}

	/** All active session handles. */
	get sessions(): ReadonlyMap<string, SessionHandle> {
		return this._sessions;
	}

	/** The file serving handler for reverse-RPC requests. */
	get fileServing(): FileServingHandler {
		return this._fileServing;
	}

	/**
	 * Connect to an AHP server and perform the initialization handshake.
	 */
	async connect(url: string, connectOptions?: ConnectOptions): Promise<InitializeResult> {
		// Merge constructor headers with per-connect overrides.
		const headers = { ...this.options.headers, ...connectOptions?.headers };
		const connectTimeout = connectOptions?.connectTimeout ?? this.options.connectTimeout;

		const transport = await WsTransport.connect(url, {
			connectTimeout,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
		});
		this.transport = transport;

		const official = new OfficialAhpClient(transport, {
			requestTimeoutMs: this.options.requestTimeout ?? 30_000,
		});
		this.official = official;
		this._disconnectedEmitted = false;

		// Bridge reverse-RPC server requests (file serving) to the official client.
		official.setServerRequestHandler(((method: string, params: unknown) =>
			this._fileServing.handleServerRequest(method, params)) as ServerRequestHandler);

		// Start the receive loop and begin draining event/state streams BEFORE
		// `initialize` so no inbound action is missed (the initialize snapshots
		// themselves are applied from the result below).
		official.connect();
		this.startStreams(official);

		const initParams = {
			protocolVersions: [PROTOCOL_VERSION],
			clientId: this._clientId,
			initialSubscriptions: this.options.initialSubscriptions ?? ["ahp-root://"],
		};

		if (process.env.AHPX_DEBUG_PROTOCOL) {
			console.error("[AHPX_DEBUG] Initialize params:", JSON.stringify(initParams, null, 2));
		}

		let result: InitializeResult;
		try {
			result = await official.initialize(initParams);
		} catch (err) {
			await official.shutdown().catch(() => {});
			this.official = undefined;
			this.transport = undefined;
			this._connected = false;
			throw err;
		}

		if (process.env.AHPX_DEBUG_PROTOCOL) {
			console.error("[AHPX_DEBUG] Initialize result:", JSON.stringify(result, null, 2));
		}

		for (const snapshot of result.snapshots) {
			this._state.applySnapshot(snapshot);
		}

		this._connected = true;
		this.emit("connected", result);

		return result;
	}

	/**
	 * Gracefully disconnect from the server.
	 */
	async disconnect(): Promise<void> {
		// Dispose all session handles
		const handles = [...this._sessions.values()];
		for (const handle of handles) {
			try {
				await handle.dispose();
			} catch {
				// Best-effort cleanup
			}
		}
		this._sessions.clear();

		this._fileServing.clearAllowedPaths();
		if (this.official) {
			await this.official.shutdown();
			this.official = undefined;
		}
		this._connected = false;
	}

	// ── Official client event/state stream bridge ────────────────────────────

	/**
	 * Drain the official client's `events()` and `stateChanges()` async
	 * iterators, fanning them out as EventEmitter events ahpx consumers expect.
	 */
	private startStreams(official: OfficialAhpClient): void {
		void (async () => {
			try {
				for await (const event of official.events()) {
					this.handleClientEvent(event);
				}
			} catch (err) {
				this.emit("error", err instanceof Error ? err : new Error(String(err)));
			}
		})();

		void (async () => {
			try {
				for await (const st of official.stateChanges()) {
					if (st.status === "closed") {
						this.handleClosed(st.reason);
					}
				}
			} catch {
				// stateChanges terminating is not itself an error condition.
			}
		})();
	}

	/** Route a single fanned-in client event to state mirror + emitters. */
	private handleClientEvent(event: ClientEvent): void {
		const sub = event.event;
		if (sub.type === "action") {
			this._state.applyAction(sub.params);
			this.emit("action", sub.params);
			return;
		}
		const notification = toNotification(sub);
		if (notification) {
			this.emit("notification", notification);
		}
	}

	/** Map a connection-closed reason to a `disconnected` emission (once). */
	private handleClosed(reason: ClosedReason): void {
		if (this._disconnectedEmitted) return;
		this._disconnectedEmitted = true;
		this._connected = false;
		if (reason.type === "transport") {
			// Prefer the real WebSocket close code/reason (preserving the prior
			// behavior where the raw `ws` close code was surfaced); fall back to
			// 1006 (abnormal closure) when the socket closed without a code.
			const code = this.transport?.closeCode ?? 1006;
			const text = this.transport?.closeReason || reason.error.message;
			this.emit("disconnected", code, text);
		} else {
			this.emit("disconnected", 1000, "shutdown");
		}
	}

	// ── Session management ────────────────────────────────────────────────

	/**
	 * Create a session and return a handle for interacting with it.
	 *
	 * Creates the session on the server, subscribes to its state, and
	 * (by default) waits for it to reach the "ready" lifecycle state.
	 */
	async openSession(options: OpenSessionOptions = {}): Promise<SessionHandle> {
		this.ensureConnected();

		const {
			provider: requestedProvider,
			model,
			workingDirectory,
			config,
			activeClient,
			waitForReady = true,
			readyTimeout = 30_000,
		} = options;

		// Resolve provider
		const provider =
			requestedProvider ?? (this._state.root.agents.length > 0 ? this._state.root.agents[0].provider : undefined);

		if (!provider) {
			throw new Error("No agent provider available. Specify one in options or ensure the server has agents.");
		}

		// Generate session URI
		const sessionId = randomUUID();
		const sessionUri = `${provider}:/${sessionId}`;

		// Create + subscribe
		await this.createSession(sessionUri, provider, model, workingDirectory, config, activeClient);
		await this.subscribe(sessionUri);

		// Check if session is provisional (lifecycle stays "creating" after subscribe)
		const sessionState = this._state.getSession(sessionUri);
		const isProvisional = sessionState?.lifecycle === "creating";

		// As of protocol 0.5.0 a session's default chat MAY live on a distinct
		// `ahp-chat://` channel. When known up front, subscribe to it so turn and
		// streaming actions are delivered. Provisional sessions may not expose it
		// until the first prompt materializes them — SessionHandle resolves it
		// lazily in that case.
		let chatUri = sessionUri;
		const defaultChat = sessionState?.defaultChat;
		if (defaultChat && defaultChat !== sessionUri) {
			await this.subscribe(defaultChat);
			chatUri = defaultChat;
		}

		// Build handle
		const handle = new SessionHandle(this, sessionUri, provider, model, isProvisional, chatUri);
		this._sessions.set(sessionUri, handle);

		// Clean up tracking when handle is disposed
		handle.on("disposed", () => {
			this._sessions.delete(sessionUri);
		});

		// Wait for ready (clean up on failure).
		// Provisional sessions skip this — they stay in "creating" until the first prompt.
		if (waitForReady && !isProvisional) {
			try {
				await handle.waitForReady(readyTimeout);
			} catch (err) {
				await handle.dispose().catch(() => {});
				throw err;
			}
		}

		return handle;
	}

	// ── Commands ──────────────────────────────────────────────────────────

	/**
	 * Create a new session with the specified agent provider.
	 */
	async createSession(
		sessionUri: URI,
		provider?: string,
		model?: string,
		workingDirectory?: string,
		config?: Record<string, unknown>,
		activeClient?: SessionActiveClient,
	): Promise<null> {
		// As of protocol 0.5.0 the model is no longer a session-level concept;
		// it is carried per-message on `Message.model`. The `model` parameter is
		// retained on the handle (see SessionHandle) and attached to each turn.
		void model;
		this.ensureConnected();
		return this.official!.request("createSession", {
			channel: sessionUri,
			provider,
			workingDirectory,
			...(config && Object.keys(config).length > 0 ? { config } : {}),
			...(activeClient ? { activeClient } : {}),
		});
	}

	/**
	 * Resolve session configuration schema from the server.
	 *
	 * Iteratively resolves available config options. The server returns a
	 * JSON Schema describing what configuration properties are available
	 * given the current context (provider, working directory, partial config).
	 */
	async resolveSessionConfig(params: Omit<ResolveSessionConfigParams, "channel">): Promise<ResolveSessionConfigResult> {
		this.ensureConnected();
		return this.official!.request("resolveSessionConfig", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * Query the server for allowed values of a dynamic session config property.
	 */
	async sessionConfigCompletions(
		params: Omit<SessionConfigCompletionsParams, "channel">,
	): Promise<SessionConfigCompletionsResult> {
		this.ensureConnected();
		return this.official!.request("sessionConfigCompletions", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * Dispose a session and clean up server-side resources.
	 */
	async disposeSession(sessionUri: URI): Promise<null> {
		this.ensureConnected();
		const result = await this.official!.request("disposeSession", {
			channel: sessionUri,
		});
		this._state.removeSession(sessionUri);
		// Remove tracked handle if one exists (may not if using low-level API)
		this._sessions.delete(sessionUri);
		return result;
	}

	/**
	 * Create a new terminal on the server.
	 */
	async createTerminal(
		terminalUri: string,
		claim: TerminalClaim,
		options?: { name?: string; cwd?: string; cols?: number; rows?: number },
	): Promise<null> {
		this.ensureConnected();
		return this.official!.request("createTerminal", {
			channel: terminalUri,
			claim,
			...options,
		});
	}

	/**
	 * Dispose a terminal and kill its process if still running.
	 */
	async disposeTerminal(terminalUri: string): Promise<null> {
		this.ensureConnected();
		const result = await this.official!.request("disposeTerminal", {
			channel: terminalUri,
		});
		this._state.removeTerminal(terminalUri);
		return result;
	}

	/**
	 * List all sessions on the server.
	 */
	async listSessions(): Promise<ListSessionsResult> {
		this.ensureConnected();
		return this.official!.request("listSessions", { channel: "ahp-root://" as const });
	}

	/**
	 * Subscribe to a state resource URI.
	 */
	async subscribe(channelUri: URI): Promise<SubscribeResult> {
		this.ensureConnected();
		const result = await this.official!.request("subscribe", {
			channel: channelUri,
		});
		if (result.snapshot) {
			this._state.applySnapshot(result.snapshot);
		}
		return result;
	}

	/**
	 * Unsubscribe from a channel URI.
	 */
	unsubscribe(channelUri: URI): void {
		this.ensureConnected();
		void this.official!.unsubscribe(channelUri);
	}

	/**
	 * Fetch historical turns for a session.
	 */
	async fetchTurns(sessionUri: URI, before?: string, limit?: number): Promise<FetchTurnsResult> {
		this.ensureConnected();
		return this.official!.request("fetchTurns", {
			channel: sessionUri,
			before,
			limit,
		});
	}

	/**
	 * Read content by URI (files, tool outputs, etc.).
	 */
	async resourceRead(uri: string, encoding?: ContentEncoding): Promise<ResourceReadResult> {
		this.ensureConnected();
		return this.official!.request("resourceRead", {
			channel: "ahp-root://" as const,
			uri,
			...(encoding ? { encoding } : {}),
		});
	}

	/**
	 * Write content to a file on the server's filesystem.
	 */
	async resourceWrite(params: Omit<ResourceWriteParams, "channel">): Promise<ResourceWriteResult> {
		this.ensureConnected();
		return this.official!.request("resourceWrite", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * List directory entries on the server's filesystem.
	 */
	async resourceList(uri: URI): Promise<ResourceListResult> {
		this.ensureConnected();
		return this.official!.request("resourceList", { channel: "ahp-root://" as const, uri });
	}

	/**
	 * Copy a resource from one URI to another.
	 */
	async resourceCopy(params: Omit<ResourceCopyParams, "channel">): Promise<ResourceCopyResult> {
		this.ensureConnected();
		return this.official!.request("resourceCopy", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * Delete a resource at a URI.
	 */
	async resourceDelete(params: Omit<ResourceDeleteParams, "channel">): Promise<ResourceDeleteResult> {
		this.ensureConnected();
		return this.official!.request("resourceDelete", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * Move (rename) a resource from one URI to another.
	 */
	async resourceMove(params: Omit<ResourceMoveParams, "channel">): Promise<ResourceMoveResult> {
		this.ensureConnected();
		return this.official!.request("resourceMove", { ...params, channel: "ahp-root://" as const });
	}

	/**
	 * Dispatch a client-originated action to the server.
	 *
	 * Write-ahead `dispatchAction` notification — the official client assigns the
	 * monotonic client sequence number internally.
	 */
	dispatchAction(channel: URI, action: StateAction): void {
		this.ensureConnected();
		this.official!.dispatch(channel, action);
	}

	/**
	 * Push an authentication token for a protected resource.
	 */
	async authenticate(resource: string, token: string): Promise<void> {
		this.ensureConnected();
		await this.official!.request("authenticate", { channel: "ahp-root://" as const, resource, token });
	}

	private ensureConnected(): void {
		if (!this._connected || !this.official) {
			throw new Error("Client is not connected");
		}
	}
}

/** Map an official client {@link SubscriptionEvent} to an ahpx notification. */
function toNotification(sub: SubscriptionEvent): ProtocolNotification | undefined {
	switch (sub.type) {
		case "sessionAdded":
			return { ...sub.params, type: NotificationType.SessionAdded };
		case "sessionRemoved":
			return { ...sub.params, type: NotificationType.SessionRemoved };
		case "sessionSummaryChanged":
			return { ...sub.params, type: NotificationType.SessionSummaryChanged };
		case "authRequired":
			return { ...sub.params, type: NotificationType.AuthRequired };
		default:
			return undefined;
	}
}

// `RpcError` / `RpcTimeoutError` now come from the official client; re-exported
// here so existing ahpx imports (`bin.ts`, `session/persistence.ts`) keep working.
export { RpcError, RpcTimeoutError } from "@microsoft/agent-host-protocol/client";
export { WsTransport, type WsTransportOptions } from "./ws-transport.js";
export { StateMirror } from "./state.js";
export { SessionHandle } from "./session-handle.js";
export type { SessionHandleEvents, PromptOptions, TurnResult as SessionTurnResult } from "./session-handle.js";
export { ActiveClientManager } from "./active-client.js";
export { ReconnectManager } from "./reconnect.js";
export type { ReconnectOptions, ReconnectOutcome } from "./reconnect.js";
export { FileServingHandler } from "./file-serving.js";
