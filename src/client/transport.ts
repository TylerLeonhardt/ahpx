/**
 * WebSocket transport layer for AHP protocol communication.
 *
 * Handles connection lifecycle, reconnection, and raw message framing.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface TransportOptions {
	/** Connection timeout in ms (default: 10_000) */
	connectTimeout?: number;
	/** Headers to include in the WebSocket handshake */
	headers?: Record<string, string>;
}

export interface TransportEvents {
	open: [];
	close: [code: number, reason: string];
	error: [error: Error];
	message: [data: unknown];
}

/**
 * Low-level WebSocket transport. Sends and receives JSON text frames.
 */
export class Transport extends EventEmitter<TransportEvents> {
	private ws: WebSocket | undefined;
	private _connected = false;

	get connected(): boolean {
		return this._connected;
	}

	/**
	 * Open a WebSocket connection to the given URL.
	 */
	async connect(url: string, options: TransportOptions = {}): Promise<void> {
		const { connectTimeout = 10_000, headers } = options;

		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url, { headers });
			let settled = false;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					ws.close();
					reject(new Error(`Connection to ${url} timed out after ${connectTimeout}ms`));
				}
			}, connectTimeout);

			ws.on("open", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.ws = ws;
				this._connected = true;
				this.attachListeners(ws);
				this.emit("open");
				resolve();
			});

			ws.on("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					// WebSocket errors (e.g. ECONNREFUSED) may have empty .message
					const code = (err as NodeJS.ErrnoException).code;
					const detail = err.message || code || "unknown error";
					reject(new Error(`Connection to ${url} failed: ${detail}`));
				}
			});
		});
	}

	/**
	 * Send a JSON-serializable value over the WebSocket.
	 */
	send(data: unknown): void {
		if (!this.ws || !this._connected) {
			throw new Error("Transport is not connected");
		}
		this.ws.send(JSON.stringify(data));
	}

	/**
	 * Gracefully close the connection.
	 */
	close(): void {
		if (this.ws) {
			this._connected = false;
			this.ws.close();
			this.ws = undefined;
		}
	}

	private attachListeners(ws: WebSocket): void {
		ws.on("message", (raw) => {
			try {
				const data: unknown = JSON.parse(raw.toString());
				this.emit("message", data);
			} catch {
				this.emit("error", new Error(`Failed to parse message: ${raw.toString().slice(0, 200)}`));
			}
		});

		ws.on("close", (code, reason) => {
			this._connected = false;
			this.ws = undefined;
			this.emit("close", code, reason.toString());
		});

		ws.on("error", (err) => {
			this.emit("error", err);
		});
	}
}
