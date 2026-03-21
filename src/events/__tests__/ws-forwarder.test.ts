import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhpxEvent } from "../forwarder.js";

// ── Mock WebSocket ───────────────────────────────────────────────────────────

const { MockWebSocket } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { EventEmitter } = require("node:events") as typeof import("node:events");

	class MockWebSocket extends EventEmitter {
		static OPEN = 1;
		static CONNECTING = 0;
		static CLOSING = 2;
		static CLOSED = 3;
		static instances: MockWebSocket[] = [];

		readyState = MockWebSocket.CONNECTING;
		bufferedAmount = 0;
		sent: string[] = [];
		url: string;
		opts: unknown;

		constructor(url: string, opts?: unknown) {
			super();
			this.url = url;
			this.opts = opts;
			MockWebSocket.instances.push(this);
		}

		send(data: string) {
			this.sent.push(data);
		}

		close(_code?: number, _reason?: string) {
			this.readyState = MockWebSocket.CLOSED;
		}

		simulateOpen() {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open");
		}

		simulateClose(code = 1000, reason = "") {
			this.readyState = MockWebSocket.CLOSED;
			this.emit("close", code, Buffer.from(reason));
		}

		simulateError(err: Error) {
			this.emit("error", err);
		}
	}

	return { MockWebSocket };
});

vi.mock("ws", () => {
	const WS = MockWebSocket as unknown as typeof import("ws").default;
	Object.assign(WS, {
		OPEN: MockWebSocket.OPEN,
		CONNECTING: MockWebSocket.CONNECTING,
		CLOSING: MockWebSocket.CLOSING,
		CLOSED: MockWebSocket.CLOSED,
	});
	return { default: WS };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AhpxEvent> = {}): AhpxEvent {
	return {
		type: "turn_complete",
		timestamp: new Date().toISOString(),
		data: { foo: "bar" },
		...overrides,
	};
}

function latestWs(): InstanceType<typeof MockWebSocket> {
	return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	MockWebSocket.instances = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

// Import after mock is registered
const { WebSocketForwarder } = await import("../ws-forwarder.js");

describe("WebSocketForwarder", () => {
	// ── Event streaming ───────────────────────────────────────────────────

	describe("event streaming", () => {
		it("sends events as JSON when connected", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			ws.simulateOpen();

			const event = makeEvent({ type: "delta", data: { text: "hello" } });
			await fw.forward(event);

			expect(ws.sent).toHaveLength(1);
			expect(JSON.parse(ws.sent[0])).toEqual(event);

			await fw.close();
		});
	});

	// ── Reconnect on disconnect ───────────────────────────────────────────

	describe("reconnect on disconnect", () => {
		it("creates a new WebSocket after disconnect", async () => {
			vi.useFakeTimers();

			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws1 = latestWs();
			ws1.simulateOpen();

			expect(MockWebSocket.instances).toHaveLength(1);

			// Simulate disconnect — triggers reconnect schedule
			ws1.simulateClose(1006, "abnormal");

			// First reconnect delay is 1000ms (1000 * 2^0)
			await vi.advanceTimersByTimeAsync(1000);

			expect(MockWebSocket.instances).toHaveLength(2);
			const ws2 = latestWs();
			expect(ws2).not.toBe(ws1);
			expect(ws2.url).toBe("ws://localhost:9000");

			// Clean up
			ws2.simulateOpen();
			await fw.close();
		});

		it("reconnects again after a second disconnect", async () => {
			vi.useFakeTimers();

			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws1 = latestWs();
			ws1.simulateOpen();

			// First disconnect → reconnect at 1000ms
			ws1.simulateClose();
			await vi.advanceTimersByTimeAsync(999);
			expect(MockWebSocket.instances).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(MockWebSocket.instances).toHaveLength(2);

			// Second connection opens, then closes → another reconnect at 1000ms
			const ws2 = latestWs();
			ws2.simulateOpen();
			ws2.simulateClose();
			await vi.advanceTimersByTimeAsync(1000);
			expect(MockWebSocket.instances).toHaveLength(3);

			const ws3 = latestWs();
			ws3.simulateOpen();
			await fw.close();
		});
	});

	// ── Event filtering ───────────────────────────────────────────────────

	describe("event filtering", () => {
		it("only forwards events matching the filter", async () => {
			const fw = new WebSocketForwarder({
				url: "ws://localhost:9000",
				filter: ["turn_complete", "error"],
			});
			const ws = latestWs();
			ws.simulateOpen();

			await fw.forward(makeEvent({ type: "turn_complete" }));
			await fw.forward(makeEvent({ type: "delta" }));
			await fw.forward(makeEvent({ type: "error" }));
			await fw.forward(makeEvent({ type: "session_start" }));

			expect(ws.sent).toHaveLength(2);
			expect(JSON.parse(ws.sent[0]).type).toBe("turn_complete");
			expect(JSON.parse(ws.sent[1]).type).toBe("error");

			await fw.close();
		});

		it("forwards all events when no filter is set", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			ws.simulateOpen();

			await fw.forward(makeEvent({ type: "a" }));
			await fw.forward(makeEvent({ type: "b" }));
			await fw.forward(makeEvent({ type: "c" }));

			expect(ws.sent).toHaveLength(3);

			await fw.close();
		});
	});

	// ── Backpressure handling ─────────────────────────────────────────────

	describe("backpressure handling", () => {
		it("buffers events when backpressure threshold is exceeded", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			ws.simulateOpen();

			// Set bufferedAmount above the 1MB threshold
			ws.bufferedAmount = 1024 * 1024 + 1;

			const event = makeEvent({ type: "backpressured" });
			await fw.forward(event);

			// Event should NOT be sent directly
			expect(ws.sent).toHaveLength(0);

			// Reset backpressure, send another event — that one goes through
			ws.bufferedAmount = 0;
			const event2 = makeEvent({ type: "ok" });
			await fw.forward(event2);

			expect(ws.sent).toHaveLength(1);
			expect(JSON.parse(ws.sent[0]).type).toBe("ok");

			await fw.close();
		});
	});

	// ── Buffer during disconnect ──────────────────────────────────────────

	describe("buffer during disconnect", () => {
		it("drains buffered events when connection opens", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();

			const event1 = makeEvent({ type: "a", data: { id: 1 } });
			const event2 = makeEvent({ type: "b", data: { id: 2 } });

			// Start forwards while still CONNECTING — they await connectPromise internally
			const p1 = fw.forward(event1);
			const p2 = fw.forward(event2);

			// Fail the connection — forward() catches via try/catch around await
			ws.simulateError(new Error("connection failed"));
			await p1;
			await p2;

			// Nothing sent yet — events are buffered
			expect(ws.sent).toHaveLength(0);

			// Now simulate connection opening — the open handler drains the buffer
			ws.simulateOpen();

			expect(ws.sent).toHaveLength(2);
			expect(JSON.parse(ws.sent[0])).toEqual(event1);
			expect(JSON.parse(ws.sent[1])).toEqual(event2);

			await fw.close();
		});
	});

	// ── Close flushes and closes ──────────────────────────────────────────

	describe("close", () => {
		it("flushes buffer and closes WebSocket with code 1000", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			const closeSpy = vi.spyOn(ws, "close");
			ws.simulateOpen();

			await fw.forward(makeEvent({ data: { id: 1 } }));
			await fw.forward(makeEvent({ data: { id: 2 } }));

			await fw.close();

			expect(closeSpy).toHaveBeenCalledWith(1000, "Forwarder closed");
		});

		it("is idempotent", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			const closeSpy = vi.spyOn(ws, "close");
			ws.simulateOpen();

			await fw.close();
			await fw.close();

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});
	});

	// ── Events after close ────────────────────────────────────────────────

	describe("events after close", () => {
		it("ignores events forwarded after close", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();
			ws.simulateOpen();

			await fw.close();

			await fw.forward(makeEvent());
			await fw.forward(makeEvent());

			// Only events sent before close (none) — nothing new
			expect(ws.sent).toHaveLength(0);
		});
	});

	// ── Reconnect disabled ────────────────────────────────────────────────

	describe("reconnect disabled", () => {
		it("does not reconnect when reconnect is false", async () => {
			vi.useFakeTimers();

			const fw = new WebSocketForwarder({
				url: "ws://localhost:9000",
				reconnect: false,
			});
			const ws = latestWs();
			ws.simulateOpen();

			expect(MockWebSocket.instances).toHaveLength(1);

			ws.simulateClose(1006, "gone");

			// Advance well past any reconnect delay
			await vi.advanceTimersByTimeAsync(60_000);

			// No new WebSocket created
			expect(MockWebSocket.instances).toHaveLength(1);

			await fw.close();
		});
	});

	// ── Buffer size limit ─────────────────────────────────────────────────

	describe("buffer size limit", () => {
		it("drops oldest events when buffer exceeds MAX_BUFFER_SIZE", async () => {
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000" });
			const ws = latestWs();

			// Start first forward to attach a handler to the connect promise
			const firstForward = fw.forward(makeEvent({ data: { seq: 0 } }));

			// Fail the connection — caught by forward()'s try/catch
			ws.simulateError(new Error("connection failed"));
			await firstForward;

			// Forward remaining events while disconnected (connectPromise is now undefined)
			for (let i = 1; i < 10_005; i++) {
				await fw.forward(makeEvent({ data: { seq: i } }));
			}

			// Open the connection — drains the buffer
			ws.simulateOpen();

			// Buffer was capped at 10,000 — oldest 5 events were dropped
			expect(ws.sent).toHaveLength(10_000);
			expect(JSON.parse(ws.sent[0]).data.seq).toBe(5);
			expect(JSON.parse(ws.sent[ws.sent.length - 1]).data.seq).toBe(10_004);

			await fw.close();
		});
	});

	// ── Headers ───────────────────────────────────────────────────────────

	describe("custom headers", () => {
		it("passes headers to the WebSocket constructor", async () => {
			const headers = { Authorization: "Bearer token-123", "X-Custom": "value" };
			const fw = new WebSocketForwarder({ url: "ws://localhost:9000", headers });
			const ws = latestWs();

			expect((ws.opts as { headers: Record<string, string> }).headers).toEqual(headers);

			ws.simulateOpen();
			await fw.close();
		});
	});
});
