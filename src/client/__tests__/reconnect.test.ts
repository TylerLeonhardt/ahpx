import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AhpClient } from "../../client/index.js";
import type { WritableOutput } from "../../output/renderer.js";
import { ReconnectManager } from "../reconnect.js";

/** Captures output. */
function createCapture(): { out: WritableOutput; text: () => string } {
	let buf = "";
	return {
		out: {
			write: (s: string) => {
				buf += s;
			},
		},
		text: () => buf,
	};
}

/**
 * Creates a mock AhpClient for reconnection tests.
 * `connectFails` controls how many times connect() fails before succeeding.
 */
function createMockClient(connectFails = 0) {
	let failCount = 0;
	const subscribedUris: string[] = [];

	const client = {
		connect: vi.fn(async (_url: string) => {
			if (failCount < connectFails) {
				failCount++;
				throw new Error("Connection refused");
			}
			return {
				protocolVersion: 1,
				serverSeq: 0,
				snapshots: [],
			};
		}),
		subscribe: vi.fn(async (uri: string) => {
			subscribedUris.push(uri);
			return {
				snapshot: { resource: uri, state: { agents: [] }, fromSeq: 0 },
			};
		}),
		connected: false,
	} as unknown;

	return { client, subscribedUris };
}

describe("ReconnectManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("reconnects successfully with snapshot", async () => {
		const { client, subscribedUris } = createMockClient(0);
		const cap = createCapture();

		const manager = new ReconnectManager("ws://localhost:3000", "client-1", {
			maxRetries: 3,
			backoffMs: 10,
			statusOut: cap.out,
		});

		// Run reconnect in the background
		const promise = manager.reconnect(client as unknown as AhpClient, 5, ["ahp-root://", "copilot:/session1"]);

		// Advance through the backoff timer
		await vi.advanceTimersByTimeAsync(100);

		const result = await promise;

		expect(result).toBe("snapshot");
		expect(subscribedUris).toContain("ahp-root://");
		expect(subscribedUris).toContain("copilot:/session1");
		expect(cap.text()).toContain("Reconnecting (1/3)");
		expect(cap.text()).toContain("Reconnected successfully");
	});

	it("retries with exponential backoff on failure", async () => {
		const { client } = createMockClient(2); // Fail twice, succeed on third
		const cap = createCapture();

		const manager = new ReconnectManager("ws://localhost:3000", "client-1", {
			maxRetries: 5,
			backoffMs: 10,
			statusOut: cap.out,
		});

		const promise = manager.reconnect(client as unknown as AhpClient, 5, ["ahp-root://"]);

		// Advance timers enough for all retries
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(500);
		}

		const result = await promise;

		expect(result).toBe("snapshot");
		expect(cap.text()).toContain("Reconnecting (1/5)");
		expect(cap.text()).toContain("Reconnecting (2/5)");
		expect(cap.text()).toContain("Reconnecting (3/5)");
		expect(cap.text()).toContain("Reconnected successfully");
	});

	it("fails after max retries exceeded", async () => {
		const { client } = createMockClient(10); // Always fail
		const cap = createCapture();

		const manager = new ReconnectManager("ws://localhost:3000", "client-1", {
			maxRetries: 3,
			backoffMs: 10,
			statusOut: cap.out,
		});

		const promise = manager.reconnect(client as unknown as AhpClient, 5, ["ahp-root://"]);

		// Advance timers enough for all retries
		for (let i = 0; i < 20; i++) {
			await vi.advanceTimersByTimeAsync(500);
		}

		const result = await promise;

		expect(result).toBe("failed");
		expect(cap.text()).toContain("Reconnecting (1/3)");
		expect(cap.text()).toContain("Reconnecting (3/3)");
		expect(cap.text()).toContain("Failed to reconnect after 3 attempts");
	});

	it("can be aborted", async () => {
		const { client } = createMockClient(10); // Always fail
		const cap = createCapture();

		const manager = new ReconnectManager("ws://localhost:3000", "client-1", {
			maxRetries: 5,
			backoffMs: 10,
			statusOut: cap.out,
		});

		const promise = manager.reconnect(client as unknown as AhpClient, 5, ["ahp-root://"]);

		// Let first attempt start
		await vi.advanceTimersByTimeAsync(50);

		// Abort
		manager.abort();

		// Advance timers to let it finish
		await vi.advanceTimersByTimeAsync(500);

		const result = await promise;
		expect(result).toBe("failed");
	});

	it("uses default options", () => {
		const manager = new ReconnectManager("ws://localhost:3000", "client-1");
		// Just verify construction works with defaults
		expect(manager).toBeDefined();
	});

	// Clean up
	it("restores real timers", () => {
		vi.useRealTimers();
	});
});
