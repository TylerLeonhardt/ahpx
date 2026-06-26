import type { ErrorInfo, ToolCallResult, UsageInfo } from "@microsoft/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import type { OutputFormatter } from "../../output/format.js";
import type { ToolCallInfo } from "../../output/renderer.js";
import type { AhpxEvent, EventForwarder } from "../forwarder.js";
import { ForwardingFormatter, type ForwardingFormatterOptions } from "../forwarding-formatter.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockFormatter(): OutputFormatter & { calls: Array<{ method: string; args: unknown[] }> } {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		onDelta: vi.fn((...args: unknown[]) => calls.push({ method: "onDelta", args })),
		onReasoning: vi.fn((...args: unknown[]) => calls.push({ method: "onReasoning", args })),
		onToolCallStart: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallStart", args })),
		onToolCallDelta: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallDelta", args })),
		onToolCallReady: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallReady", args })),
		onToolCallAutoApproved: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallAutoApproved", args })),
		onToolCallComplete: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallComplete", args })),
		onToolCallCancelled: vi.fn((...args: unknown[]) => calls.push({ method: "onToolCallCancelled", args })),
		onUsage: vi.fn((...args: unknown[]) => calls.push({ method: "onUsage", args })),
		onTurnComplete: vi.fn((...args: unknown[]) => calls.push({ method: "onTurnComplete", args })),
		onTurnError: vi.fn((...args: unknown[]) => calls.push({ method: "onTurnError", args })),
		onTurnCancelled: vi.fn((...args: unknown[]) => calls.push({ method: "onTurnCancelled", args })),
		onTitleChanged: vi.fn((...args: unknown[]) => calls.push({ method: "onTitleChanged", args })),
	};
}

function createMockForwarder(): EventForwarder & { events: AhpxEvent[] } {
	const events: AhpxEvent[] = [];
	return {
		events,
		forward: vi.fn(async (event: AhpxEvent) => {
			events.push(event);
		}),
		close: vi.fn(async () => {}),
	};
}

function createFormatter(overrides: Partial<ForwardingFormatterOptions> = {}): {
	formatter: ForwardingFormatter;
	inner: ReturnType<typeof createMockFormatter>;
	forwarders: ReturnType<typeof createMockForwarder>[];
} {
	const inner = createMockFormatter();
	const forwarder = createMockForwarder();
	const forwarders = overrides.forwarders
		? (overrides.forwarders as ReturnType<typeof createMockForwarder>[])
		: [forwarder];
	const formatter = new ForwardingFormatter({
		inner,
		forwarders,
		...overrides,
	});
	return { formatter, inner, forwarders };
}

// Sample data for tests
const sampleToolCallInfo: ToolCallInfo = {
	toolCallId: "tc-1",
	toolName: "readFile",
	displayName: "Read File",
	invocationMessage: "Reading file.txt",
	toolInput: '{"path":"file.txt"}',
};

const sampleToolCallResult: ToolCallResult = {
	success: true,
	pastTenseMessage: "Read file.txt",
};

const sampleUsage: UsageInfo = {
	inputTokens: 100,
	outputTokens: 50,
	model: "gpt-4",
};

const sampleError: ErrorInfo = {
	errorType: "runtime",
	message: "Something went wrong",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ForwardingFormatter", () => {
	describe("delegates all methods to inner formatter", () => {
		it("calls inner.onDelta with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onDelta("hello");
			expect(inner.onDelta).toHaveBeenCalledWith("hello");
		});

		it("calls inner.onReasoning with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onReasoning("thinking...");
			expect(inner.onReasoning).toHaveBeenCalledWith("thinking...");
		});

		it("calls inner.onToolCallStart with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallStart("tc-1", "readFile");
			expect(inner.onToolCallStart).toHaveBeenCalledWith("tc-1", "readFile");
		});

		it("calls inner.onToolCallDelta with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallDelta("tc-1", '{"path":');
			expect(inner.onToolCallDelta).toHaveBeenCalledWith("tc-1", '{"path":');
		});

		it("calls inner.onToolCallReady with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallReady("tc-1", sampleToolCallInfo);
			expect(inner.onToolCallReady).toHaveBeenCalledWith("tc-1", sampleToolCallInfo);
		});

		it("calls inner.onToolCallAutoApproved with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallAutoApproved("tc-1");
			expect(inner.onToolCallAutoApproved).toHaveBeenCalledWith("tc-1");
		});

		it("calls inner.onToolCallComplete with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallComplete("tc-1", sampleToolCallResult);
			expect(inner.onToolCallComplete).toHaveBeenCalledWith("tc-1", sampleToolCallResult);
		});

		it("calls inner.onToolCallCancelled with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onToolCallCancelled("tc-1", "timeout");
			expect(inner.onToolCallCancelled).toHaveBeenCalledWith("tc-1", "timeout");
		});

		it("calls inner.onUsage with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onUsage(sampleUsage);
			expect(inner.onUsage).toHaveBeenCalledWith(sampleUsage);
		});

		it("calls inner.onTurnComplete with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onTurnComplete("Done!");
			expect(inner.onTurnComplete).toHaveBeenCalledWith("Done!");
		});

		it("calls inner.onTurnError with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onTurnError(sampleError);
			expect(inner.onTurnError).toHaveBeenCalledWith(sampleError);
		});

		it("calls inner.onTurnCancelled with no args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onTurnCancelled();
			expect(inner.onTurnCancelled).toHaveBeenCalled();
		});

		it("calls inner.onTitleChanged with same args", () => {
			const { formatter, inner } = createFormatter();
			formatter.onTitleChanged("New Title");
			expect(inner.onTitleChanged).toHaveBeenCalledWith("New Title");
		});
	});

	describe("forwards events to all forwarders", () => {
		it("sends event to multiple forwarders", () => {
			const forwarder1 = createMockForwarder();
			const forwarder2 = createMockForwarder();
			const { formatter } = createFormatter({ forwarders: [forwarder1, forwarder2] });

			formatter.onDelta("hello");

			expect(forwarder1.forward).toHaveBeenCalledTimes(1);
			expect(forwarder2.forward).toHaveBeenCalledTimes(1);
			expect(forwarder1.events[0].data).toEqual({ content: "hello" });
			expect(forwarder2.events[0].data).toEqual({ content: "hello" });
		});
	});

	describe("event shape", () => {
		it("produces correct event shape for onDelta", () => {
			const { formatter, forwarders } = createFormatter();
			formatter.onDelta("hello");

			const event = forwarders[0].events[0];
			expect(event.type).toBe("delta");
			expect(event.data).toEqual({ content: "hello" });
			expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("sessionUri", () => {
		it("is included when set in constructor", () => {
			const { formatter, forwarders } = createFormatter({ sessionUri: "copilot:/session1" });
			formatter.onDelta("hello");

			expect(forwarders[0].events[0].sessionUri).toBe("copilot:/session1");
		});

		it("is omitted when not set", () => {
			const { formatter, forwarders } = createFormatter();
			formatter.onDelta("hello");

			expect(forwarders[0].events[0]).not.toHaveProperty("sessionUri");
		});

		it("can be set after construction", () => {
			const { formatter, forwarders } = createFormatter();
			formatter.sessionUri = "copilot:/late";
			formatter.onDelta("hello");

			expect(forwarders[0].events[0].sessionUri).toBe("copilot:/late");
		});
	});

	describe("tags", () => {
		it("are included when set", () => {
			const { formatter, forwarders } = createFormatter({ tags: { jobId: "123" } });
			formatter.onDelta("hello");

			expect(forwarders[0].events[0].tags).toEqual({ jobId: "123" });
		});

		it("are omitted when not set", () => {
			const { formatter, forwarders } = createFormatter();
			formatter.onDelta("hello");

			expect(forwarders[0].events[0]).not.toHaveProperty("tags");
		});

		it("are omitted when empty object", () => {
			const { formatter, forwarders } = createFormatter({ tags: {} });
			formatter.onDelta("hello");

			expect(forwarders[0].events[0]).not.toHaveProperty("tags");
		});
	});

	describe("error handling", () => {
		it("does not throw when a forwarder rejects", () => {
			const failingForwarder: EventForwarder = {
				forward: vi.fn(async () => {
					throw new Error("network failure");
				}),
				close: vi.fn(async () => {}),
			};
			const inner = createMockFormatter();
			const formatter = new ForwardingFormatter({ inner, forwarders: [failingForwarder] });

			expect(() => formatter.onDelta("hello")).not.toThrow();
			expect(inner.onDelta).toHaveBeenCalledWith("hello");
		});
	});

	describe("close", () => {
		it("calls close on all forwarders", async () => {
			const forwarder1 = createMockForwarder();
			const forwarder2 = createMockForwarder();
			const { formatter } = createFormatter({ forwarders: [forwarder1, forwarder2] });

			await formatter.close();

			expect(forwarder1.close).toHaveBeenCalledTimes(1);
			expect(forwarder2.close).toHaveBeenCalledTimes(1);
		});

		it("handles forwarder close errors gracefully", async () => {
			const failingForwarder: EventForwarder = {
				forward: vi.fn(async () => {}),
				close: vi.fn(async () => {
					throw new Error("close failed");
				}),
			};
			const inner = createMockFormatter();
			const formatter = new ForwardingFormatter({ inner, forwarders: [failingForwarder] });

			await expect(formatter.close()).resolves.toBeUndefined();
		});
	});

	describe("all 12 event types produce correct AhpxEvent shapes", () => {
		const toolCallInfoNoInput: ToolCallInfo = {
			toolCallId: "tc-2",
			toolName: "search",
			displayName: "Search",
			invocationMessage: "Searching...",
		};

		const cases: Array<{
			method: string;
			invoke: (f: ForwardingFormatter) => void;
			expectedType: string;
			expectedData: Record<string, unknown>;
		}> = [
			{
				method: "onDelta",
				invoke: (f) => f.onDelta("text"),
				expectedType: "delta",
				expectedData: { content: "text" },
			},
			{
				method: "onReasoning",
				invoke: (f) => f.onReasoning("thought"),
				expectedType: "reasoning",
				expectedData: { content: "thought" },
			},
			{
				method: "onToolCallStart",
				invoke: (f) => f.onToolCallStart("tc-1", "readFile"),
				expectedType: "tool_call_start",
				expectedData: { toolCallId: "tc-1", name: "readFile" },
			},
			{
				method: "onToolCallDelta",
				invoke: (f) => f.onToolCallDelta("tc-1", "chunk"),
				expectedType: "tool_call_delta",
				expectedData: { toolCallId: "tc-1", content: "chunk" },
			},
			{
				method: "onToolCallReady",
				invoke: (f) => f.onToolCallReady("tc-1", sampleToolCallInfo),
				expectedType: "tool_call_ready",
				expectedData: {
					toolCallId: "tc-1",
					toolName: "readFile",
					displayName: "Read File",
					invocationMessage: "Reading file.txt",
					toolInput: '{"path":"file.txt"}',
				},
			},
			{
				method: "onToolCallReady (no toolInput)",
				invoke: (f) => f.onToolCallReady("tc-2", toolCallInfoNoInput),
				expectedType: "tool_call_ready",
				expectedData: {
					toolCallId: "tc-2",
					toolName: "search",
					displayName: "Search",
					invocationMessage: "Searching...",
				},
			},
			{
				method: "onToolCallAutoApproved",
				invoke: (f) => f.onToolCallAutoApproved("tc-1"),
				expectedType: "tool_call_auto_approved",
				expectedData: { toolCallId: "tc-1" },
			},
			{
				method: "onToolCallComplete",
				invoke: (f) => f.onToolCallComplete("tc-1", sampleToolCallResult),
				expectedType: "tool_call_complete",
				expectedData: { toolCallId: "tc-1", result: sampleToolCallResult },
			},
			{
				method: "onToolCallCancelled",
				invoke: (f) => f.onToolCallCancelled("tc-1", "timeout"),
				expectedType: "tool_call_cancelled",
				expectedData: { toolCallId: "tc-1", reason: "timeout" },
			},
			{
				method: "onUsage",
				invoke: (f) => f.onUsage(sampleUsage),
				expectedType: "usage",
				expectedData: { usage: sampleUsage },
			},
			{
				method: "onTurnComplete",
				invoke: (f) => f.onTurnComplete("Done!"),
				expectedType: "turn_complete",
				expectedData: { responseText: "Done!" },
			},
			{
				method: "onTurnError",
				invoke: (f) => f.onTurnError(sampleError),
				expectedType: "turn_error",
				expectedData: { error: sampleError },
			},
			{
				method: "onTurnCancelled",
				invoke: (f) => f.onTurnCancelled(),
				expectedType: "turn_cancelled",
				expectedData: {},
			},
			{
				method: "onTitleChanged",
				invoke: (f) => f.onTitleChanged("New Title"),
				expectedType: "title_changed",
				expectedData: { title: "New Title" },
			},
		];

		for (const { method, invoke, expectedType, expectedData } of cases) {
			it(`${method} → "${expectedType}"`, () => {
				const { formatter, forwarders } = createFormatter();
				invoke(formatter);

				const event = forwarders[0].events[0];
				expect(event.type).toBe(expectedType);
				expect(event.data).toEqual(expectedData);
				expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
			});
		}
	});
});
