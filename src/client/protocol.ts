/**
 * JSON-RPC 2.0 message routing layer for AHP protocol.
 *
 * Handles request/response correlation, notification dispatch,
 * and incoming action/notification routing.
 */

import { EventEmitter } from "node:events";
import type { IActionEnvelope } from "../protocol/actions.js";
import type { ICommandMap, IJsonRpcErrorResponse } from "../protocol/messages.js";
import type { IProtocolNotification } from "../protocol/notifications.js";
import type { Transport } from "./transport.js";

/** Error thrown when a JSON-RPC request receives an error response. */
export class RpcError extends Error {
	constructor(
		public readonly code: number,
		message: string,
		public readonly data?: unknown,
	) {
		super(message);
		this.name = "RpcError";
	}
}

/** Error thrown when a request times out. */
export class RpcTimeoutError extends Error {
	constructor(
		public readonly method: string,
		public readonly timeoutMs: number,
	) {
		super(`Request '${method}' timed out after ${timeoutMs}ms`);
		this.name = "RpcTimeoutError";
	}
}

export interface ProtocolLayerOptions {
	/** Default request timeout in ms (default: 30_000) */
	requestTimeout?: number;
}

export interface ProtocolLayerEvents {
	action: [envelope: IActionEnvelope];
	notification: [notification: IProtocolNotification];
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 protocol layer over a Transport.
 *
 * - Sends requests with auto-incrementing IDs and returns Promises
 * - Sends notifications (fire-and-forget, no ID)
 * - Routes incoming messages to pending request resolvers or event emitters
 */
export class ProtocolLayer extends EventEmitter<ProtocolLayerEvents> {
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private readonly requestTimeout: number;

	constructor(
		private readonly transport: Transport,
		options: ProtocolLayerOptions = {},
	) {
		super();
		this.requestTimeout = options.requestTimeout ?? 30_000;
		this.transport.on("message", (data) => this.handleMessage(data));
	}

	/**
	 * Send a typed JSON-RPC request and await the response.
	 */
	async request<M extends keyof ICommandMap>(
		method: M,
		params: ICommandMap[M]["params"],
		timeoutMs?: number,
	): Promise<ICommandMap[M]["result"]> {
		const id = this.nextId++;
		const timeout = timeoutMs ?? this.requestTimeout;

		return new Promise<ICommandMap[M]["result"]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcTimeoutError(method, timeout));
			}, timeout);

			this.pending.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timer,
			});

			this.transport.send({
				jsonrpc: "2.0",
				id,
				method,
				params,
			});
		});
	}

	/**
	 * Send a JSON-RPC notification (no response expected).
	 */
	notify(method: string, params: unknown): void {
		this.transport.send({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	/**
	 * Cancel all pending requests (e.g. on disconnect).
	 */
	cancelAll(reason: string): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.pending.delete(id);
		}
	}

	private handleMessage(data: unknown): void {
		if (!data || typeof data !== "object") return;

		const msg = data as Record<string, unknown>;

		// Response (has `id` and either `result` or `error`)
		if ("id" in msg && typeof msg.id === "number") {
			const pending = this.pending.get(msg.id);
			if (!pending) return;

			this.pending.delete(msg.id);
			clearTimeout(pending.timer);

			if ("error" in msg) {
				const errPayload = (msg as unknown as IJsonRpcErrorResponse).error;
				pending.reject(new RpcError(errPayload.code, errPayload.message, errPayload.data));
			} else if ("result" in msg) {
				pending.resolve(msg.result);
			}
			return;
		}

		// Notification (has `method` but no `id`)
		if ("method" in msg && typeof msg.method === "string") {
			if (msg.method === "action") {
				this.emit("action", msg.params as IActionEnvelope);
			} else if (msg.method === "notification") {
				const params = msg.params as { notification: IProtocolNotification };
				this.emit("notification", params.notification);
			}
		}
	}
}
