/**
 * ConnectionPool — Manages reusable AhpClient connections to multiple servers.
 *
 * For library consumers managing multiple servers, the pool ensures
 * that only one WebSocket connection exists per server URL, and provides
 * aggregate stats across all connections and sessions.
 */

import { AhpClient, type AhpClientOptions } from "./index.js";

/** Options for the ConnectionPool. */
export interface ConnectionPoolOptions {
	/** Maximum concurrent connections per server URL (default: 1). */
	maxConnectionsPerServer?: number;
}

/**
 * Pool of AhpClient connections, keyed by server URL.
 *
 * Reuses existing connections to the same server URL. Each connection
 * is an `AhpClient` that can host multiple concurrent sessions.
 *
 * @example
 * ```ts
 * const pool = new ConnectionPool();
 * const client = await pool.getClient("ws://localhost:8082");
 * const session = await client.openSession({ provider: "copilot" });
 * // ... use session ...
 * await pool.closeAll();
 * ```
 */
export class ConnectionPool {
	private readonly _clients = new Map<string, AhpClient>();
	private readonly _maxPerServer: number;

	constructor(options?: ConnectionPoolOptions) {
		this._maxPerServer = options?.maxConnectionsPerServer ?? 1;
	}

	/**
	 * Get or create a connected client for the given server URL.
	 *
	 * If a connected client already exists for this URL, it is returned.
	 * Otherwise a new client is created, connected, and cached.
	 */
	async getClient(url: string, options?: AhpClientOptions): Promise<AhpClient> {
		const normalizedUrl = this.normalizeUrl(url);

		// Return existing connected client
		const existing = this._clients.get(normalizedUrl);
		if (existing?.connected) {
			return existing;
		}

		// Clean up stale entry
		if (existing) {
			this._clients.delete(normalizedUrl);
		}

		// Create and connect new client
		const client = new AhpClient(options);
		await client.connect(url);

		// Remove from pool on disconnect
		client.on("disconnected", () => {
			this._clients.delete(normalizedUrl);
		});

		this._clients.set(normalizedUrl, client);
		return client;
	}

	/**
	 * Close all connections in the pool.
	 */
	async closeAll(): Promise<void> {
		const clients = [...this._clients.values()];
		this._clients.clear();

		await Promise.all(
			clients.map((client) =>
				client.disconnect().catch(() => {
					// Best-effort cleanup
				}),
			),
		);
	}

	/** Number of active connections in the pool. */
	get activeConnections(): number {
		return this._clients.size;
	}

	/** Total number of active sessions across all connections. */
	get activeSessions(): number {
		let total = 0;
		for (const client of this._clients.values()) {
			total += client.sessions.size;
		}
		return total;
	}

	private normalizeUrl(url: string): string {
		// Remove trailing slash for consistent keying
		return url.replace(/\/+$/, "");
	}
}
