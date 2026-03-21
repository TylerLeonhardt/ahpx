import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ConnectionPool } from "../connection-pool.js";

// Use vi.hoisted to get EventEmitter available during mock hoisting
const { MockEventEmitter } = vi.hoisted(() => {
	// Re-require EventEmitter inside hoisted context
	const { EventEmitter: EE } = require("node:events");
	return { MockEventEmitter: EE };
});

// We mock AhpClient at the module level since ConnectionPool creates clients internally
vi.mock("../index.js", () => {
	class MockAhpClient extends MockEventEmitter {
		private _connected = false;
		private _sessions = new Map<string, unknown>();

		get connected() {
			return this._connected;
		}

		get sessions(): ReadonlyMap<string, unknown> {
			return this._sessions;
		}

		async connect(_url: string) {
			this._connected = true;
			return { agents: [], snapshots: [] };
		}

		async disconnect() {
			this._connected = false;
		}

		// Test helper to simulate adding sessions
		_addSession(uri: string) {
			this._sessions.set(uri, {});
		}
	}

	return { AhpClient: MockAhpClient };
});

describe("ConnectionPool", () => {
	describe("getClient", () => {
		it("creates a new client for unknown URL", async () => {
			const pool = new ConnectionPool();
			const client = await pool.getClient("ws://localhost:8082");

			expect(client).toBeDefined();
			expect(client.connected).toBe(true);
			expect(pool.activeConnections).toBe(1);
		});

		it("reuses existing connected client for same URL", async () => {
			const pool = new ConnectionPool();
			const client1 = await pool.getClient("ws://localhost:8082");
			const client2 = await pool.getClient("ws://localhost:8082");

			expect(client1).toBe(client2);
			expect(pool.activeConnections).toBe(1);
		});

		it("creates separate clients for different URLs", async () => {
			const pool = new ConnectionPool();
			const client1 = await pool.getClient("ws://server1:8082");
			const client2 = await pool.getClient("ws://server2:8082");

			expect(client1).not.toBe(client2);
			expect(pool.activeConnections).toBe(2);
		});

		it("normalizes trailing slashes", async () => {
			const pool = new ConnectionPool();
			const client1 = await pool.getClient("ws://localhost:8082/");
			const client2 = await pool.getClient("ws://localhost:8082");

			expect(client1).toBe(client2);
			expect(pool.activeConnections).toBe(1);
		});

		it("replaces disconnected client", async () => {
			const pool = new ConnectionPool();
			const client1 = await pool.getClient("ws://localhost:8082");
			await client1.disconnect();

			// Simulate the disconnect event being emitted
			(client1 as EventEmitter).emit("disconnected", 1000, "normal");

			const client2 = await pool.getClient("ws://localhost:8082");
			expect(client2).not.toBe(client1);
			expect(pool.activeConnections).toBe(1);
		});
	});

	describe("closeAll", () => {
		it("disconnects all clients", async () => {
			const pool = new ConnectionPool();
			await pool.getClient("ws://server1:8082");
			await pool.getClient("ws://server2:8082");

			await pool.closeAll();

			expect(pool.activeConnections).toBe(0);
		});

		it("handles empty pool", async () => {
			const pool = new ConnectionPool();
			await expect(pool.closeAll()).resolves.toBeUndefined();
		});
	});

	describe("stats", () => {
		it("tracks activeConnections", async () => {
			const pool = new ConnectionPool();
			expect(pool.activeConnections).toBe(0);

			await pool.getClient("ws://server1:8082");
			expect(pool.activeConnections).toBe(1);

			await pool.getClient("ws://server2:8082");
			expect(pool.activeConnections).toBe(2);

			await pool.closeAll();
			expect(pool.activeConnections).toBe(0);
		});

		it("tracks activeSessions across connections", async () => {
			const pool = new ConnectionPool();
			expect(pool.activeSessions).toBe(0);

			const client1 = await pool.getClient("ws://server1:8082");
			const client2 = await pool.getClient("ws://server2:8082");

			// Simulate sessions via mock helper
			(client1 as unknown as { _addSession: (uri: string) => void })._addSession("copilot:/s1");
			(client1 as unknown as { _addSession: (uri: string) => void })._addSession("copilot:/s2");
			(client2 as unknown as { _addSession: (uri: string) => void })._addSession("copilot:/s3");

			expect(pool.activeSessions).toBe(3);
		});
	});

	describe("disconnect handling", () => {
		it("removes client from pool on disconnect event", async () => {
			const pool = new ConnectionPool();
			const client = await pool.getClient("ws://localhost:8082");
			expect(pool.activeConnections).toBe(1);

			// Simulate disconnect
			(client as EventEmitter).emit("disconnected", 1006, "Connection lost");

			expect(pool.activeConnections).toBe(0);
		});
	});
});
