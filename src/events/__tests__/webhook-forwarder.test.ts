import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhpxEvent } from "../forwarder.js";
import { WebhookForwarder, type WebhookForwarderOptions } from "../webhook-forwarder.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AhpxEvent> = {}): AhpxEvent {
	return {
		type: "turn_complete",
		timestamp: new Date().toISOString(),
		data: { foo: "bar" },
		...overrides,
	};
}

function makeForwarder(overrides: Partial<WebhookForwarderOptions> = {}): WebhookForwarder {
	return new WebhookForwarder({
		url: "https://example.com/events",
		batchSize: 3,
		batchIntervalMs: 500,
		retries: 0,
		...overrides,
	});
}

function okResponse(): Response {
	return new Response(null, { status: 200, statusText: "OK" });
}

function errorResponse(status = 500): Response {
	return new Response(null, { status, statusText: "Internal Server Error" });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
	globalThis.fetch = fetchMock;
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WebhookForwarder", () => {
	// ── Batching ───────────────────────────────────────────────────────────

	describe("batching", () => {
		it("flushes when batch size is reached", async () => {
			const fw = makeForwarder({ batchSize: 3 });

			await fw.forward(makeEvent());
			await fw.forward(makeEvent());
			await fw.forward(makeEvent());

			// Flush is chained as a microtask — drain promise queue
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

			const body = fetchMock.mock.calls[0][1]?.body as string;
			const lines = body.split("\n");
			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}

			await fw.close();
		});

		it("does not flush before batch size is reached", async () => {
			vi.useFakeTimers();
			const fw = makeForwarder({ batchSize: 5 });

			await fw.forward(makeEvent());
			await fw.forward(makeEvent());

			// No immediate flush, only a timer scheduled
			expect(fetchMock).not.toHaveBeenCalled();

			// Clean up: advance timers so the flush timer fires, then close
			await vi.advanceTimersByTimeAsync(1000);
			await fw.close();
		});
	});

	// ── Interval-based flush ───────────────────────────────────────────────

	describe("interval-based flush", () => {
		it("flushes a partial batch after the interval", async () => {
			vi.useFakeTimers();
			const fw = makeForwarder({ batchSize: 10, batchIntervalMs: 500 });

			await fw.forward(makeEvent());
			await fw.forward(makeEvent());

			expect(fetchMock).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(500);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = fetchMock.mock.calls[0][1]?.body as string;
			expect(body.split("\n")).toHaveLength(2);

			await fw.close();
		});
	});

	// ── Retry ──────────────────────────────────────────────────────────────

	describe("retry on HTTP error", () => {
		it("retries failed requests with exponential backoff", async () => {
			vi.useFakeTimers();

			fetchMock
				.mockResolvedValueOnce(errorResponse(500))
				.mockResolvedValueOnce(errorResponse(502))
				.mockResolvedValueOnce(okResponse());

			const fw = makeForwarder({ batchSize: 1, retries: 3 });

			const forwardPromise = fw.forward(makeEvent());

			// Flush is chained — wait for the first attempt
			await vi.advanceTimersByTimeAsync(0);

			// Backoff: attempt 0 fails → sleep(1000)
			await vi.advanceTimersByTimeAsync(1000);

			// Backoff: attempt 1 fails → sleep(2000)
			await vi.advanceTimersByTimeAsync(2000);

			await forwardPromise;
			await fw.close();

			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});

	// ── Filtering ──────────────────────────────────────────────────────────

	describe("event filtering", () => {
		it("only forwards events matching the filter", async () => {
			const fw = makeForwarder({ batchSize: 10, filter: ["turn_complete"] });

			await fw.forward(makeEvent({ type: "turn_complete" }));
			await fw.forward(makeEvent({ type: "session_start" }));
			await fw.forward(makeEvent({ type: "turn_complete" }));
			await fw.forward(makeEvent({ type: "error" }));

			await fw.close();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = fetchMock.mock.calls[0][1]?.body as string;
			const lines = body.split("\n");
			expect(lines).toHaveLength(2);
			for (const line of lines) {
				expect(JSON.parse(line).type).toBe("turn_complete");
			}
		});
	});

	// ── Flush on close ─────────────────────────────────────────────────────

	describe("flush on close", () => {
		it("flushes remaining events when close is called", async () => {
			const fw = makeForwarder({ batchSize: 100 });

			await fw.forward(makeEvent({ data: { id: 1 } }));
			await fw.forward(makeEvent({ data: { id: 2 } }));

			expect(fetchMock).not.toHaveBeenCalled();

			await fw.close();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = fetchMock.mock.calls[0][1]?.body as string;
			expect(body.split("\n")).toHaveLength(2);
		});
	});

	// ── Close idempotency ──────────────────────────────────────────────────

	describe("close idempotency", () => {
		it("can be called twice without errors", async () => {
			const fw = makeForwarder();

			await fw.forward(makeEvent());
			await fw.close();
			await fw.close();

			// Only one flush from the first close
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	// ── Events after close ─────────────────────────────────────────────────

	describe("events after close", () => {
		it("ignores events forwarded after close", async () => {
			const fw = makeForwarder();

			await fw.close();

			await fw.forward(makeEvent());
			await fw.forward(makeEvent());

			// No events sent — forwarder was already closed
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	// ── Custom headers ─────────────────────────────────────────────────────

	describe("custom headers", () => {
		it("includes custom headers in fetch calls", async () => {
			const fw = makeForwarder({
				batchSize: 1,
				headers: { Authorization: "Bearer token-123", "X-Custom": "value" },
			});

			await fw.forward(makeEvent());
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

			const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
			expect(headers).toMatchObject({
				"Content-Type": "application/x-ndjson",
				Authorization: "Bearer token-123",
				"X-Custom": "value",
			});

			await fw.close();
		});
	});

	// ── NDJSON format ──────────────────────────────────────────────────────

	describe("NDJSON format", () => {
		it("sends the body as newline-delimited JSON", async () => {
			const events = [
				makeEvent({ type: "a", data: { x: 1 } }),
				makeEvent({ type: "b", data: { y: 2 } }),
				makeEvent({ type: "c", data: { z: 3 } }),
			];

			const fw = makeForwarder({ batchSize: 3 });

			for (const e of events) {
				await fw.forward(e);
			}

			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

			const body = fetchMock.mock.calls[0][1]?.body as string;
			const lines = body.split("\n");
			expect(lines).toHaveLength(3);

			// Each line is valid JSON matching the original event
			for (let i = 0; i < lines.length; i++) {
				const parsed = JSON.parse(lines[i]);
				expect(parsed).toEqual(events[i]);
			}

			// No trailing newline
			expect(body.endsWith("\n")).toBe(false);

			// Content-Type header is correct
			const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
			expect(headers["Content-Type"]).toBe("application/x-ndjson");

			await fw.close();
		});
	});
});
