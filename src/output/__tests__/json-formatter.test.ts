import { describe, expect, it } from "vitest";
import type { ToolCallResult, UsageInfo } from "../../protocol/state.js";
import { JsonFormatter } from "../json-formatter.js";
import type { JsonEnvelope } from "../json-formatter.js";
import type { WritableOutput } from "../renderer.js";
import type { ToolCallInfo } from "../renderer.js";

/** Captures all output written by the formatter. */
function createCapture(): { out: WritableOutput; lines: () => string[]; envelopes: () => JsonEnvelope[] } {
	let buf = "";
	return {
		out: {
			write: (s: string) => {
				buf += s;
			},
		},
		lines: () => buf.trim().split("\n").filter(Boolean),
		envelopes: () =>
			buf
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonEnvelope),
	};
}

describe("JsonFormatter", () => {
	describe("NDJSON format", () => {
		it("emits one JSON object per line", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);

			fmt.onDelta("Hello ");
			fmt.onDelta("world");

			const lines = cap.lines();
			expect(lines).toHaveLength(2);
			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});

		it("each line is parseable as JSON", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);

			fmt.onDelta("test");
			fmt.onReasoning("thinking");
			fmt.onToolCallStart("tc1", "shell");
			fmt.onTurnComplete("done");

			const envelopes = cap.envelopes();
			expect(envelopes).toHaveLength(4);
		});
	});

	describe("envelope structure", () => {
		it("has type, timestamp, and data fields", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onDelta("hello");

			const env = cap.envelopes()[0];
			expect(env).toHaveProperty("type");
			expect(env).toHaveProperty("timestamp");
			expect(env).toHaveProperty("data");
		});

		it("timestamp is a valid ISO 8601 string", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onDelta("hello");

			const env = cap.envelopes()[0];
			const parsed = new Date(env.timestamp);
			expect(parsed.toISOString()).toBe(env.timestamp);
		});
	});

	describe("event types", () => {
		it("delta event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onDelta("Hello world");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("delta");
			expect(env.data).toEqual({ content: "Hello world" });
		});

		it("reasoning event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onReasoning("analyzing...");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("reasoning");
			expect(env.data).toEqual({ content: "analyzing..." });
		});

		it("tool_call_start event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onToolCallStart("tc1", "shell");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("tool_call_start");
			expect(env.data).toEqual({ toolCallId: "tc1", name: "shell" });
		});

		it("tool_call_delta event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onToolCallDelta("tc1", '{"cmd": "npm');

			const env = cap.envelopes()[0];
			expect(env.type).toBe("tool_call_delta");
			expect(env.data).toEqual({ toolCallId: "tc1", content: '{"cmd": "npm' });
		});

		it("tool_call_ready event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			const call: ToolCallInfo = {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "Run npm test",
				toolInput: '{"command": "npm test"}',
			};
			fmt.onToolCallReady("tc1", call);

			const env = cap.envelopes()[0];
			expect(env.type).toBe("tool_call_ready");
			expect(env.data.toolCallId).toBe("tc1");
			expect(env.data.toolName).toBe("shell");
			expect(env.data.displayName).toBe("Shell");
			expect(env.data.invocationMessage).toBe("Run npm test");
			expect(env.data.toolInput).toBe('{"command": "npm test"}');
		});

		it("tool_call_ready omits toolInput when undefined", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			const call: ToolCallInfo = {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "Run npm test",
			};
			fmt.onToolCallReady("tc1", call);

			const env = cap.envelopes()[0];
			expect(env.data).not.toHaveProperty("toolInput");
		});

		it("tool_call_complete event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			const result: ToolCallResult = {
				success: true,
				pastTenseMessage: "Ran npm test",
			};
			fmt.onToolCallComplete("tc1", result);

			const env = cap.envelopes()[0];
			expect(env.type).toBe("tool_call_complete");
			expect(env.data.toolCallId).toBe("tc1");
			expect((env.data.result as ToolCallResult).success).toBe(true);
		});

		it("tool_call_cancelled event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onToolCallCancelled("tc1", "user denied");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("tool_call_cancelled");
			expect(env.data).toEqual({ toolCallId: "tc1", reason: "user denied" });
		});

		it("usage event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			const usage: UsageInfo = { inputTokens: 100, outputTokens: 50, model: "gpt-4o" };
			fmt.onUsage(usage);

			const env = cap.envelopes()[0];
			expect(env.type).toBe("usage");
			expect((env.data.usage as UsageInfo).inputTokens).toBe(100);
			expect((env.data.usage as UsageInfo).outputTokens).toBe(50);
			expect((env.data.usage as UsageInfo).model).toBe("gpt-4o");
		});

		it("turn_complete event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onTurnComplete("Here is the answer.");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("turn_complete");
			expect(env.data).toEqual({ responseText: "Here is the answer." });
		});

		it("turn_error event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onTurnError({ errorType: "runtime", message: "model overloaded" });

			const env = cap.envelopes()[0];
			expect(env.type).toBe("turn_error");
			expect((env.data.error as { message: string }).message).toBe("model overloaded");
		});

		it("turn_cancelled event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onTurnCancelled();

			const env = cap.envelopes()[0];
			expect(env.type).toBe("turn_cancelled");
			expect(env.data).toEqual({});
		});

		it("title_changed event", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);
			fmt.onTitleChanged("New Title");

			const env = cap.envelopes()[0];
			expect(env.type).toBe("title_changed");
			expect(env.data).toEqual({ title: "New Title" });
		});
	});

	describe("json-strict mode", () => {
		it("reports strict mode via isStrict", () => {
			const cap = createCapture();
			const strict = new JsonFormatter(cap.out, true);
			const normal = new JsonFormatter(cap.out, false);

			expect(strict.isStrict).toBe(true);
			expect(normal.isStrict).toBe(false);
		});

		it("still emits events in strict mode", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out, true);
			fmt.onDelta("hello");
			fmt.onTurnComplete("world");

			const envelopes = cap.envelopes();
			expect(envelopes).toHaveLength(2);
			expect(envelopes[0].type).toBe("delta");
			expect(envelopes[1].type).toBe("turn_complete");
		});
	});

	describe("full turn sequence", () => {
		it("produces valid NDJSON for a complete turn", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);

			fmt.onReasoning("thinking about it");
			fmt.onDelta("First ");
			fmt.onDelta("part.");
			fmt.onToolCallStart("tc1", "shell");
			fmt.onToolCallReady("tc1", {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "npm test",
			});
			fmt.onToolCallComplete("tc1", { success: true, pastTenseMessage: "Ran npm test" });
			fmt.onDelta(" Second part.");
			fmt.onUsage({ inputTokens: 200, outputTokens: 100 });
			fmt.onTurnComplete("First part. Second part.");

			const envelopes = cap.envelopes();
			expect(envelopes).toHaveLength(9);

			// Verify type sequence
			const types = envelopes.map((e) => e.type);
			expect(types).toEqual([
				"reasoning",
				"delta",
				"delta",
				"tool_call_start",
				"tool_call_ready",
				"tool_call_complete",
				"delta",
				"usage",
				"turn_complete",
			]);

			// All timestamps should be valid dates
			for (const env of envelopes) {
				expect(() => new Date(env.timestamp)).not.toThrow();
			}
		});
	});

	describe("tags", () => {
		it("includes tags in every envelope when provided", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out, false, { jobId: "abc", project: "myapp" });

			fmt.onDelta("hello");
			fmt.onToolCallStart("tc1", "shell");
			fmt.onTurnComplete("done");

			const envelopes = cap.envelopes();
			expect(envelopes).toHaveLength(3);
			for (const env of envelopes) {
				expect(env.tags).toEqual({ jobId: "abc", project: "myapp" });
			}
		});

		it("omits tags field when no tags provided", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out);

			fmt.onDelta("hello");

			const env = cap.envelopes()[0];
			expect(env).not.toHaveProperty("tags");
		});

		it("omits tags field when tags is empty object", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out, false, {});

			fmt.onDelta("hello");

			const env = cap.envelopes()[0];
			expect(env).not.toHaveProperty("tags");
		});

		it("preserves tag values with special characters", () => {
			const cap = createCapture();
			const fmt = new JsonFormatter(cap.out, false, { path: "/home/user/project=test", "key.with.dots": "value" });

			fmt.onDelta("test");

			const env = cap.envelopes()[0];
			expect(env.tags).toEqual({ path: "/home/user/project=test", "key.with.dots": "value" });
		});
	});
});
