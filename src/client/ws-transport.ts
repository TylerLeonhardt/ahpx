/**
 * WebSocket transport adapter for the official AHP client.
 *
 * The official `@microsoft/agent-host-protocol/client` `AhpClient` is
 * transport-agnostic — it consumes an {@link AhpTransport} (pull-based
 * `recv()` / serial `send()`). The official `/ws` `WebSocketTransport` is
 * built on the global `WebSocket`, which in Node cannot set custom HTTP
 * headers. ahpx needs `Authorization` / dev-tunnel headers on the handshake,
 * so this adapter wraps the `ws` package (which supports `headers`) and
 * adds a connect timeout.
 *
 * This is one of the few capabilities the official client does not provide
 * out of the box, so it stays in ahpx's thin adapter layer.
 */

import { TransportError } from "@microsoft/agent-host-protocol/client";
import type { AhpTransport, JsonRpcMessage, TransportFrame } from "@microsoft/agent-host-protocol/client";
import WebSocket from "ws";

/** Options for {@link WsTransport.connect}. */
export interface WsTransportOptions {
	/** Connection timeout in ms (default: 10_000). */
	connectTimeout?: number;
	/** Headers to include in the WebSocket handshake (auth / dev-tunnel). */
	headers?: Record<string, string>;
}

interface Waiter {
	resolve: (frame: TransportFrame | null) => void;
	reject: (err: Error) => void;
}

/**
 * An {@link AhpTransport} backed by the `ws` package.
 *
 * Inbound text frames are queued and handed to the official client via
 * `recv()`; a clean close drains pending `recv()` waiters with `null`, an
 * abnormal close/error rejects them with a {@link TransportError} (matching
 * the official `/ws` transport contract).
 */
export class WsTransport implements AhpTransport {
	private readonly inbox: TransportFrame[] = [];
	private waiters: Waiter[] = [];
	private error: Error | null = null;
	private closed = false;
	private _closeCode: number | undefined;
	private _closeReason = "";

	private constructor(private readonly socket: WebSocket) {
		socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
			if (isBinary) {
				this.deliver({ kind: "binary", data: new Uint8Array(raw as Buffer) });
			} else {
				this.deliver({ kind: "text", text: raw.toString() });
			}
		});

		socket.on("error", (err: Error) => {
			// WebSocket errors (e.g. ECONNRESET) may have an empty message.
			const code = (err as NodeJS.ErrnoException).code;
			const detail = err.message || code || "websocket error";
			this.error = new TransportError("io", detail, { cause: err });
			this.drainWithError(this.error);
		});

		socket.on("close", (code: number, reason: Buffer) => {
			this.closed = true;
			this._closeCode = code;
			this._closeReason = reason.toString();
			// 1000 (normal) and 1005 (no status) are clean closes; anything else
			// is abnormal and surfaces as a transport error so the client can
			// distinguish an unplanned drop from a clean EOF.
			if (code === 1000 || code === 1005) {
				this.drainWithNull();
			} else {
				const err = new TransportError("closed", `websocket closed (code=${code}) ${this._closeReason}`.trim());
				this.error = err;
				this.drainWithError(err);
			}
		});
	}

	/** The WebSocket close code, once the socket has closed (else `undefined`). */
	get closeCode(): number | undefined {
		return this._closeCode;
	}

	/** The WebSocket close reason text, once the socket has closed (else ""). */
	get closeReason(): string {
		return this._closeReason;
	}

	/**
	 * Open a new WebSocket connection, resolving once it is OPEN.
	 *
	 * Rejects with a {@link TransportError} on handshake failure or timeout.
	 */
	static connect(url: string, options: WsTransportOptions = {}): Promise<WsTransport> {
		const { connectTimeout = 10_000, headers } = options;

		return new Promise<WsTransport>((resolve, reject) => {
			let socket: WebSocket;
			try {
				socket = new WebSocket(url, { headers });
			} catch (err) {
				reject(new TransportError("io", `failed to construct WebSocket: ${(err as Error).message}`, { cause: err }));
				return;
			}

			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				try {
					socket.close();
				} catch {
					// best-effort
				}
				reject(new TransportError("io", `connection to ${url} timed out after ${connectTimeout}ms`));
			}, connectTimeout);

			// Once the connect promise has settled via a reject path we still keep
			// an `error` listener attached, because the `ws` socket can emit a
			// late asynchronous `error` event after we've given up — e.g. calling
			// `socket.close()` on a still-CONNECTING socket makes `ws` emit
			// "WebSocket was closed before the connection was established", and a
			// refused/reset connection can surface after a timeout. An unhandled
			// `'error'` EventEmitter event is rethrown by Node and would crash the
			// whole process, escaping every per-server try/catch (e.g. taking down
			// `ahpx server status` when one configured server is unreachable). The
			// swallow keeps the socket's error contract satisfied without leaking.
			const swallow = () => {};
			const cleanup = () => {
				clearTimeout(timer);
				socket.removeListener("open", onOpen);
				socket.removeListener("error", onError);
				socket.removeListener("close", onClose);
				socket.on("error", swallow);
			};

			const onOpen = () => {
				if (settled) return;
				settled = true;
				cleanup();
				// Success path: the WsTransport instance installs its own permanent
				// `error` listener, so drop the connect-time swallow to avoid a
				// duplicate no-op handler shadowing real error handling.
				socket.removeListener("error", swallow);
				resolve(new WsTransport(socket));
			};

			const onError = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				const code = (err as NodeJS.ErrnoException).code;
				const detail = err.message || code || "unknown error";
				reject(new TransportError("io", `connection to ${url} failed: ${detail}`, { cause: err }));
			};

			const onClose = (code: number) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new TransportError("closed", `websocket closed before open (code=${code})`));
			};

			socket.on("open", onOpen);
			socket.on("error", onError);
			socket.on("close", onClose);
		});
	}

	send(message: JsonRpcMessage | string): void {
		if (this.closed) throw new TransportError("closed", "transport closed");
		if (this.error) throw this.error;
		const payload = typeof message === "string" ? message : JSON.stringify(message);
		try {
			this.socket.send(payload);
		} catch (err) {
			throw new TransportError("io", `websocket send failed: ${(err as Error).message}`, { cause: err });
		}
	}

	recv(): Promise<TransportFrame | null> {
		if (this.error) return Promise.reject(this.error);
		if (this.inbox.length > 0) {
			return Promise.resolve(this.inbox.shift() ?? null);
		}
		if (this.closed) return Promise.resolve(null);
		return new Promise<TransportFrame | null>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	close(): Promise<void> {
		if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
			try {
				this.socket.close();
			} catch {
				// best-effort
			}
		}
		return Promise.resolve();
	}

	private deliver(frame: TransportFrame): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve(frame);
			return;
		}
		this.inbox.push(frame);
	}

	private drainWithError(error: Error): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w.reject(error);
	}

	private drainWithNull(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w.resolve(null);
	}
}
