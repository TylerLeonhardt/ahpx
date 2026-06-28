/**
 * Regression test for #100 — `server status` (no args, checks ALL configured
 * servers) must NOT crash when a configured server is unreachable.
 *
 * The original bug was an uncaught `'error'` EventEmitter event on the raw `ws`
 * socket: `WsTransport.connect()`'s timeout path removed the `error` listener
 * and then called `socket.close()` on a still-CONNECTING socket, making `ws`
 * emit "WebSocket was closed before the connection was established" with no
 * listener attached. Node rethrows unhandled `'error'` events, crashing the
 * whole process and escaping every per-server try/catch — so a single down
 * server took down the entire `ahpx server status` report.
 *
 * These tests use the REAL `HealthChecker` (no client mocking) against a REAL
 * reachable mock AHP server plus a raw TCP server that accepts connections but
 * never completes the WebSocket handshake (forcing the connect timeout path).
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HealthChecker } from "../../fleet/health.js";
import { type MockServer, createMockServer } from "../helpers/mock-server.js";

/**
 * Start a raw TCP server that accepts connections but never speaks HTTP/WS, so
 * the WebSocket upgrade handshake hangs until the client's connect timeout
 * fires — exactly the condition that triggered the #100 crash.
 */
async function createHangingServer(): Promise<{ url: string; close(): Promise<void> }> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		// Intentionally never respond to the WS upgrade request.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to bind hanging server");
	}
	const url = `ws://127.0.0.1:${address.port}`;
	return {
		url,
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				server.close(() => resolve());
			}),
	};
}

describe("server status resilience to unreachable servers (#100)", () => {
	let reachable: MockServer | undefined;
	let hanging: { url: string; close(): Promise<void> } | undefined;

	afterEach(async () => {
		await reachable?.close();
		await hanging?.close();
		reachable = undefined;
		hanging = undefined;
	});

	it("does not raise an uncaught exception when a configured server hangs/times out", async () => {
		reachable = await createMockServer();
		hanging = await createHangingServer();

		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		const onUnhandled = (reason: unknown) =>
			uncaught.push(reason instanceof Error ? reason : new Error(String(reason)));
		process.on("uncaughtException", onUncaught);
		process.on("unhandledRejection", onUnhandled);

		try {
			// Short timeout so the hanging server hits the connect-timeout path fast.
			const checker = new HealthChecker({ timeout: 300 });
			const results = await checker.checkAll([
				{ name: "reachable", url: reachable.url },
				{ name: "windows-desktop", url: hanging.url },
			]);

			// Give any late async `ws` `error`/`close` events a chance to fire so an
			// unhandled one would surface here rather than leaking into a later test.
			await new Promise((r) => setTimeout(r, 200));

			expect(uncaught).toEqual([]);

			expect(results).toHaveLength(2);
			const byName = Object.fromEntries(results.map((r) => [r.name, r]));

			expect(byName.reachable.status).toBe("healthy");

			expect(byName["windows-desktop"].status).toBe("unreachable");
			expect(byName["windows-desktop"].error).toBeTruthy();
			expect(byName["windows-desktop"].activeSessions).toBe(0);
		} finally {
			process.removeListener("uncaughtException", onUncaught);
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("reports a connection-refused server as unreachable while the reachable one stays healthy", async () => {
		reachable = await createMockServer();

		// Bind then immediately release a port to get one that refuses connections.
		const probe = net.createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const addr = probe.address();
		if (!addr || typeof addr === "string") throw new Error("failed to bind probe");
		const deadUrl = `ws://127.0.0.1:${addr.port}`;
		await new Promise<void>((resolve) => probe.close(() => resolve()));

		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);

		try {
			const checker = new HealthChecker({ timeout: 1000 });
			const results = await checker.checkAll([
				{ name: "reachable", url: reachable.url },
				{ name: "dead", url: deadUrl },
			]);

			await new Promise((r) => setTimeout(r, 100));

			expect(uncaught).toEqual([]);

			const byName = Object.fromEntries(results.map((r) => [r.name, r]));
			expect(byName.reachable.status).toBe("healthy");
			expect(byName.dead.status).toBe("unreachable");
			expect(byName.dead.error).toBeTruthy();
		} finally {
			process.removeListener("uncaughtException", onUncaught);
		}
	});
});
