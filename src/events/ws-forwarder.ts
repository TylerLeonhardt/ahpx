/**
 * WebSocket Forwarder — Stream events over a WebSocket connection.
 *
 * Connects to a WebSocket endpoint and streams events in real-time.
 * Auto-reconnects on disconnect, supports event type filtering,
 * and handles backpressure by buffering when the WebSocket buffer is full.
 */

import WebSocket from "ws";
import { createLogger } from "../logger.js";
import type { AhpxEvent, EventForwarder } from "./forwarder.js";

const log = createLogger("ws-forwarder");

/** Maximum bytes buffered before backpressure kicks in. */
const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1 MB

/** Maximum events to buffer during reconnect. */
const MAX_BUFFER_SIZE = 10_000;

export interface WebSocketForwarderOptions {
	/** WebSocket URL to connect to (ws:// or wss://). */
	url: string;
	/** Custom headers for the WebSocket handshake. */
	headers?: Record<string, string>;
	/** Auto-reconnect on disconnect (default: true). */
	reconnect?: boolean;
	/** Event types to forward. If empty/undefined, forwards all. */
	filter?: string[];
}

export class WebSocketForwarder implements EventForwarder {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private readonly reconnect: boolean;
	private readonly filter: Set<string> | undefined;

	private ws: WebSocket | undefined;
	private buffer: AhpxEvent[] = [];
	private closed = false;
	private reconnecting = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private connectPromise: Promise<void> | undefined;

	constructor(options: WebSocketForwarderOptions) {
		this.url = options.url;
		this.headers = options.headers ?? {};
		this.reconnect = options.reconnect ?? true;
		this.filter = options.filter && options.filter.length > 0 ? new Set(options.filter) : undefined;

		this.connectPromise = this.connect();
	}

	async forward(event: AhpxEvent): Promise<void> {
		if (this.closed) return;
		if (this.filter && !this.filter.has(event.type)) return;

		// Wait for initial connection
		if (this.connectPromise) {
			try {
				await this.connectPromise;
			} catch {
				// Connection failed — buffer the event
			}
		}

		if (this.isConnected()) {
			this.sendOrBuffer(event);
		} else {
			this.addToBuffer(event);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;

		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}

		// Wait for pending connection
		if (this.connectPromise) {
			try {
				await this.connectPromise;
			} catch {
				// Ignore connection errors during close
			}
		}

		// Flush buffer if connected
		if (this.isConnected()) {
			this.drainBuffer();
		}

		// Close WebSocket
		if (this.ws) {
			this.ws.removeAllListeners();
			if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
				this.ws.close(1000, "Forwarder closed");
			}
			this.ws = undefined;
		}

		this.buffer = [];
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.url, { headers: this.headers });
			} catch (err) {
				this.connectPromise = undefined;
				reject(err);
				return;
			}

			this.ws.on("open", () => {
				log.info("connected", { url: this.url });
				this.reconnectAttempt = 0;
				this.reconnecting = false;
				this.connectPromise = undefined;

				// Drain any buffered events
				this.drainBuffer();
				resolve();
			});

			this.ws.on("close", (code, reason) => {
				log.info("disconnected", { url: this.url, code, reason: reason.toString() });

				if (!this.closed && this.reconnect) {
					this.scheduleReconnect();
				}
			});

			this.ws.on("error", (err) => {
				log.info("error", { url: this.url, error: err.message });

				if (this.connectPromise) {
					this.connectPromise = undefined;
					reject(err);
				}
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnecting) return;
		this.reconnecting = true;

		const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
		this.reconnectAttempt++;

		log.info("reconnecting", { attempt: this.reconnectAttempt, delay });

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (!this.closed) {
				this.connectPromise = this.connect().catch(() => {
					// Reconnect failed — will try again via the close handler
				});
			}
		}, delay);
	}

	private isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private sendOrBuffer(event: AhpxEvent): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.addToBuffer(event);
			return;
		}

		// Backpressure: if the send buffer is too full, buffer locally
		if (this.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
			log.info("backpressure", { bufferedAmount: this.ws.bufferedAmount });
			this.addToBuffer(event);
			return;
		}

		try {
			this.ws.send(JSON.stringify(event));
		} catch {
			this.addToBuffer(event);
		}
	}

	private addToBuffer(event: AhpxEvent): void {
		if (this.buffer.length >= MAX_BUFFER_SIZE) {
			// Drop oldest events to prevent unbounded memory growth
			this.buffer.shift();
		}
		this.buffer.push(event);
	}

	private drainBuffer(): void {
		while (this.buffer.length > 0 && this.isConnected()) {
			const event = this.buffer.shift()!;
			try {
				this.ws!.send(JSON.stringify(event));
			} catch {
				// Re-add to front of buffer if send fails
				this.buffer.unshift(event);
				break;
			}
		}
	}
}
