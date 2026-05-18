/**
 * AhpClient — High-level AHP protocol client.
 *
 * Composes Transport + ProtocolLayer + StateMirror into a single
 * interface for connecting to AHP servers, managing sessions, and
 * dispatching actions.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ActionEnvelope, StateAction } from "../protocol/actions.js";
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
} from "../protocol/commands.js";
import type { ProtocolNotification } from "../protocol/notifications.js";
import type { SessionActiveClient, TerminalClaim, URI } from "../protocol/state.js";
import { PROTOCOL_VERSION } from "../protocol/version/registry.js";
import { FileServingHandler } from "./file-serving.js";
import { ProtocolLayer, type ProtocolLayerOptions } from "./protocol.js";
import { SessionHandle } from "./session-handle.js";
import { StateMirror } from "./state.js";
import { Transport, type TransportOptions } from "./transport.js";

export interface AhpClientOptions extends TransportOptions, ProtocolLayerOptions {
	/** Unique client identifier (default: random UUID) */
	clientId?: string;
	/** URIs to subscribe to during initialization */
	initialSubscriptions?: URI[];
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
	private transport: Transport | undefined;
	private protocol: ProtocolLayer | undefined;
	private readonly _state = new StateMirror();
	private readonly _sessions = new Map<string, SessionHandle>();
	private readonly _fileServing = new FileServingHandler();
	private _clientId: string;
	private _clientSeq = 0;
	private _connected = false;

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
	async connect(url: string, connectOptions?: TransportOptions): Promise<InitializeResult> {
		const transport = new Transport();
		const protocol = new ProtocolLayer(transport, this.options);

		// Wire up events
		protocol.on("action", (envelope) => {
			this._state.applyAction(envelope);
			this.emit("action", envelope);
		});

		protocol.on("notification", (notification) => {
			this.emit("notification", notification);
		});

		// Register reverse-RPC file serving handler
		this._fileServing.register(protocol);

		transport.on("close", (code, reason) => {
			this._connected = false;
			protocol.cancelAll("Connection closed");
			this.emit("disconnected", code, reason);
		});

		transport.on("error", (err) => {
			this.emit("error", err);
		});

		// Connect WebSocket — merge constructor options with per-connect overrides
		const transportOpts: TransportOptions = {
			...this.options,
			...connectOptions,
			headers: { ...this.options.headers, ...connectOptions?.headers },
		};
		await transport.connect(url, transportOpts);

		this.transport = transport;
		this.protocol = protocol;

		// Send initialize
		const initParams = {
			protocolVersions: [PROTOCOL_VERSION],
			clientId: this._clientId,
			initialSubscriptions: this.options.initialSubscriptions ?? ["agenthost:/root"],
		};

		// DEBUG: Log initialize params
		if (process.env.AHPX_DEBUG_PROTOCOL) {
			console.error("[AHPX_DEBUG] Initialize params:", JSON.stringify(initParams, null, 2));
		}

		const result = await protocol.request("initialize", initParams);

		// DEBUG: Log initialize result
		if (process.env.AHPX_DEBUG_PROTOCOL) {
			console.error("[AHPX_DEBUG] Initialize result:", JSON.stringify(result, null, 2));
		}

		// Apply initial snapshots to state mirror
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

		if (this.protocol) {
			this.protocol.cancelAll("Client disconnecting");
		}
		this._fileServing.clearAllowedPaths();
		if (this.transport) {
			this.transport.close();
			this.transport = undefined;
			this.protocol = undefined;
		}
		this._connected = false;
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

		// Build handle
		const handle = new SessionHandle(this, sessionUri, provider, model, isProvisional);
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
		this.ensureConnected();
		return this.protocol!.request("createSession", {
			session: sessionUri,
			provider,
			model: model ? { id: model } : undefined,
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
	async resolveSessionConfig(params: ResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		this.ensureConnected();
		return this.protocol!.request("resolveSessionConfig", params);
	}

	/**
	 * Query the server for allowed values of a dynamic session config property.
	 */
	async sessionConfigCompletions(params: SessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		this.ensureConnected();
		return this.protocol!.request("sessionConfigCompletions", params);
	}

	/**
	 * Dispose a session and clean up server-side resources.
	 */
	async disposeSession(sessionUri: URI): Promise<null> {
		this.ensureConnected();
		const result = await this.protocol!.request("disposeSession", {
			session: sessionUri,
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
		return this.protocol!.request("createTerminal", {
			terminal: terminalUri,
			claim,
			...options,
		});
	}

	/**
	 * Dispose a terminal and kill its process if still running.
	 */
	async disposeTerminal(terminalUri: string): Promise<null> {
		this.ensureConnected();
		const result = await this.protocol!.request("disposeTerminal", {
			terminal: terminalUri,
		});
		this._state.removeTerminal(terminalUri);
		return result;
	}

	/**
	 * List all sessions on the server.
	 */
	async listSessions(): Promise<ListSessionsResult> {
		this.ensureConnected();
		return this.protocol!.request("listSessions", {});
	}

	/**
	 * Subscribe to a state resource URI.
	 */
	async subscribe(resourceUri: URI): Promise<SubscribeResult> {
		this.ensureConnected();
		const result = await this.protocol!.request("subscribe", {
			resource: resourceUri,
		});
		this._state.applySnapshot(result.snapshot);
		return result;
	}

	/**
	 * Unsubscribe from a state resource URI.
	 */
	unsubscribe(resourceUri: URI): void {
		this.ensureConnected();
		this.protocol!.notify("unsubscribe", { resource: resourceUri });
	}

	/**
	 * Fetch historical turns for a session.
	 */
	async fetchTurns(sessionUri: URI, before?: string, limit?: number): Promise<FetchTurnsResult> {
		this.ensureConnected();
		return this.protocol!.request("fetchTurns", {
			session: sessionUri,
			before,
			limit,
		});
	}

	/**
	 * Read content by URI (files, tool outputs, etc.).
	 */
	async resourceRead(uri: string, encoding?: ContentEncoding): Promise<ResourceReadResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceRead", { uri, ...(encoding ? { encoding } : {}) });
	}

	/**
	 * Write content to a file on the server's filesystem.
	 */
	async resourceWrite(params: ResourceWriteParams): Promise<ResourceWriteResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceWrite", params);
	}

	/**
	 * List directory entries on the server's filesystem.
	 */
	async resourceList(uri: URI): Promise<ResourceListResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceList", { uri });
	}

	/**
	 * Copy a resource from one URI to another.
	 */
	async resourceCopy(params: ResourceCopyParams): Promise<ResourceCopyResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceCopy", params);
	}

	/**
	 * Delete a resource at a URI.
	 */
	async resourceDelete(params: ResourceDeleteParams): Promise<ResourceDeleteResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceDelete", params);
	}

	/**
	 * Move (rename) a resource from one URI to another.
	 */
	async resourceMove(params: ResourceMoveParams): Promise<ResourceMoveResult> {
		this.ensureConnected();
		return this.protocol!.request("resourceMove", params);
	}

	/**
	 * Dispatch a client-originated action to the server.
	 */
	dispatchAction(action: StateAction): void {
		this.ensureConnected();
		this._clientSeq++;
		this.protocol!.notify("dispatchAction", {
			clientSeq: this._clientSeq,
			action,
		});
	}

	/**
	 * Push an authentication token for a protected resource.
	 */
	async authenticate(resource: string, token: string): Promise<void> {
		this.ensureConnected();
		await this.protocol!.request("authenticate", { resource, token });
	}

	private ensureConnected(): void {
		if (!this._connected || !this.protocol) {
			throw new Error("Client is not connected");
		}
	}
}

export { Transport, type TransportOptions } from "./transport.js";
export { ProtocolLayer, RpcError, RpcTimeoutError, type ProtocolLayerOptions } from "./protocol.js";
export type { IncomingRequest } from "./protocol.js";
export { StateMirror } from "./state.js";
export { SessionHandle } from "./session-handle.js";
export type { SessionHandleEvents, PromptOptions, TurnResult as SessionTurnResult } from "./session-handle.js";
export { ActiveClientManager } from "./active-client.js";
export { ReconnectManager } from "./reconnect.js";
export type { ReconnectOptions, ReconnectOutcome } from "./reconnect.js";
export { FileServingHandler } from "./file-serving.js";
