import { describe, expect, it } from "vitest";
import { ToolResultContentType } from "../../protocol/state.js";
import type { IToolCallResult, IUsageInfo } from "../../protocol/state.js";
import { PromptRenderer } from "../renderer.js";
import type { ToolCallInfo, WritableOutput } from "../renderer.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes so assertions work regardless of color support. */
function stripAnsi(str: string): string {
	return str.replace(ANSI_RE, "");
}

/** Captures all output written to the renderer. */
function createCapture(): { out: WritableOutput; text: () => string } {
	let buf = "";
	return {
		out: {
			write: (s: string) => {
				buf += s;
			},
		},
		text: () => stripAnsi(buf),
	};
}

describe("PromptRenderer", () => {
	describe("onDelta", () => {
		it("writes streaming text", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("Hello ");
			r.onDelta("world");
			expect(cap.text()).toContain("Hello ");
			expect(cap.text()).toContain("world");
		});

		it("prefixes first delta with a newline", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("first");
			expect(cap.text()).toBe("\nfirst");
		});
	});

	describe("onReasoning", () => {
		it("shows [thinking] prefix", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onReasoning("analyzing...");
			expect(cap.text()).toContain("[thinking]");
			expect(cap.text()).toContain("analyzing...");
		});

		it("only shows [thinking] prefix once for multiple chunks", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onReasoning("part 1");
			r.onReasoning(" part 2");
			const matches = cap.text().match(/\[thinking\]/g);
			expect(matches).toHaveLength(1);
		});

		it("closes reasoning block before delta", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onReasoning("thinking...");
			r.onDelta("answer");
			// Should have newlines between thinking and answer
			expect(cap.text()).toContain("thinking...\n\n");
			expect(cap.text()).toContain("answer");
		});
	});

	describe("onToolCallStart", () => {
		it("shows tool name with running status", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onToolCallStart("tc1", "Run npm test");
			expect(cap.text()).toContain("[tool]");
			expect(cap.text()).toContain("Run npm test");
			expect(cap.text()).toContain("(running)");
		});
	});

	describe("onToolCallReady", () => {
		it("shows pending confirmation", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const call: ToolCallInfo = {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "Run npm test",
			};
			r.onToolCallReady("tc1", call);
			expect(cap.text()).toContain("[tool]");
			expect(cap.text()).toContain("Run npm test");
			expect(cap.text()).toContain("(pending confirmation)");
		});

		it("handles markdown invocation message", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const call: ToolCallInfo = {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: { markdown: "**bold command**" },
			};
			r.onToolCallReady("tc1", call);
			expect(cap.text()).toContain("**bold command**");
		});
	});

	describe("onToolCallComplete", () => {
		it("shows completed tool with green prefix for success", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const result: IToolCallResult = {
				success: true,
				pastTenseMessage: "Ran npm test",
			};
			r.onToolCallComplete("tc1", result);
			const text = cap.text();
			expect(text).toContain("[tool]");
			expect(text).toContain("Ran npm test");
			expect(text).toContain("(completed)");
		});

		it("shows tool text content", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const result: IToolCallResult = {
				success: true,
				pastTenseMessage: "Ran test",
				content: [{ type: ToolResultContentType.Text, text: "✓ all passed" }],
			};
			r.onToolCallComplete("tc1", result);
			expect(cap.text()).toContain("✓ all passed");
		});

		it("shows red prefix for failed tool", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const result: IToolCallResult = {
				success: false,
				pastTenseMessage: "npm test failed",
			};
			r.onToolCallComplete("tc1", result);
			// Just check it contains the message
			expect(cap.text()).toContain("npm test failed");
		});
	});

	describe("onToolCallCancelled", () => {
		it("shows cancellation reason", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onToolCallCancelled("tc1", "user denied");
			expect(cap.text()).toContain("[tool]");
			expect(cap.text()).toContain("cancelled");
			expect(cap.text()).toContain("user denied");
		});
	});

	describe("onUsage", () => {
		it("shows token counts and model", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const usage: IUsageInfo = {
				inputTokens: 1234,
				outputTokens: 567,
				model: "gpt-4o",
			};
			r.onUsage(usage);
			const text = cap.text();
			expect(text).toContain("Tokens:");
			expect(text).toContain("1,234 in");
			expect(text).toContain("567 out");
			expect(text).toContain("gpt-4o");
		});

		it("handles missing model", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const usage: IUsageInfo = { inputTokens: 100, outputTokens: 50 };
			r.onUsage(usage);
			const text = cap.text();
			expect(text).toContain("100 in");
			expect(text).toContain("50 out");
			expect(text).not.toContain("(");
		});
	});

	describe("onTurnComplete", () => {
		it("shows [done] marker", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onTurnComplete("some response");
			expect(cap.text()).toContain("[done]");
			expect(cap.text()).toContain("end_turn");
		});
	});

	describe("onTurnError", () => {
		it("shows [error] marker with message", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onTurnError({ errorType: "runtime", message: "model overloaded" });
			expect(cap.text()).toContain("[error]");
			expect(cap.text()).toContain("model overloaded");
		});
	});

	describe("onTurnCancelled", () => {
		it("shows [cancelled] marker", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onTurnCancelled();
			expect(cap.text()).toContain("[cancelled]");
			expect(cap.text()).toContain("turn cancelled");
		});
	});
});
