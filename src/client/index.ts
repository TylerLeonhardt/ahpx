/**
 * AhpClient — High-level AHP protocol client.
 *
 * Composes Transport + ProtocolLayer + StateMirror into a single
 * interface for connecting to AHP servers, managing sessions, and
 * dispatching actions.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IActionEnvelope, IStateAction } from "../protocol/actions.js";
import type {
	IBrowseDirectoryResult,
	IFetchContentResult,
	IFetchTurnsResult,
	IInitializeResult,
	IListSessionsResult,
	ISubscribeResult,
} from "../protocol/commands.js";
import type { IProtocolNotification } from "../protocol/notifications.js";
import type { URI } from "../protocol/state.js";
import { PROTOCOL_VERSION } from "../protocol/version/registry.js";
import { ProtocolLayer, type ProtocolLayerOptions } from "./protocol.js";
import { StateMirror } from "./state.js";
import { Transport, type TransportOptions } from "./transport.js";

export interface AhpClientOptions extends TransportOptions, ProtocolLayerOptions {
	/** Unique client identifier (default: random UUID) */
	clientId?: string;
	/** URIs to subscribe to during initialization */
	initialSubscriptions?: URI[];
}

export interface AhpClientEvents {
	action: [envelope: IActionEnvelope];
	notification: [notification: IProtocolNotification];
	connected: [result: IInitializeResult];
	disconnected: [code: number, reason: string];
	error: [error: Error];
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

	/**
	 * Connect to an AHP server and perform the initialization handshake.
	 */
	async connect(url: string): Promise<IInitializeResult> {
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

		transport.on("close", (code, reason) => {
			this._connected = false;
			protocol.cancelAll("Connection closed");
			this.emit("disconnected", code, reason);
		});

		transport.on("error", (err) => {
			this.emit("error", err);
		});

		// Connect WebSocket
		await transport.connect(url, this.options);

		this.transport = transport;
		this.protocol = protocol;

		// Send initialize
		const result = await protocol.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientId: this._clientId,
			initialSubscriptions: this.options.initialSubscriptions ?? ["agenthost:/root"],
		});

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
		if (this.protocol) {
			this.protocol.cancelAll("Client disconnecting");
		}
		if (this.transport) {
			this.transport.close();
			this.transport = undefined;
			this.protocol = undefined;
		}
		this._connected = false;
	}

	// ── Commands ──────────────────────────────────────────────────────────

	/**
	 * Create a new session with the specified agent provider.
	 */
	async createSession(sessionUri: URI, provider?: string, model?: string, workingDirectory?: string): Promise<null> {
		this.ensureConnected();
		return this.protocol!.request("createSession", {
			session: sessionUri,
			provider,
			model,
			workingDirectory,
		});
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
		return result;
	}

	/**
	 * List all sessions on the server.
	 */
	async listSessions(): Promise<IListSessionsResult> {
		this.ensureConnected();
		return this.protocol!.request("listSessions", {});
	}

	/**
	 * Subscribe to a state resource URI.
	 */
	async subscribe(resourceUri: URI): Promise<ISubscribeResult> {
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
	async fetchTurns(sessionUri: URI, before?: string, limit?: number): Promise<IFetchTurnsResult> {
		this.ensureConnected();
		return this.protocol!.request("fetchTurns", {
			session: sessionUri,
			before,
			limit,
		});
	}

	/**
	 * Fetch large content by URI.
	 */
	async fetchContent(uri: string): Promise<IFetchContentResult> {
		this.ensureConnected();
		return this.protocol!.request("fetchContent", { uri });
	}

	/**
	 * Browse a directory on the server's filesystem.
	 */
	async browseDirectory(uri?: URI): Promise<IBrowseDirectoryResult> {
		this.ensureConnected();
		return this.protocol!.request("browseDirectory", { uri: uri ?? "" });
	}

	/**
	 * Dispatch a client-originated action to the server.
	 */
	dispatchAction(action: IStateAction): void {
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
export { StateMirror } from "./state.js";
