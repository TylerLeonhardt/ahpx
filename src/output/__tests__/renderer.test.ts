import { ToolResultContentType } from "@microsoft/agent-host-protocol";
import type { ToolCallResult, UsageInfo } from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";
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
		it("shows [tool] name (running)", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onToolCallStart("tc1", "Shell");
			expect(cap.text()).toContain("[tool]");
			expect(cap.text()).toContain("Shell");
			expect(cap.text()).toContain("(running)");
		});
	});

	describe("onToolCallReady", () => {
		it("produces no output (permission handler shows prompt)", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const call: ToolCallInfo = {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "Run npm test",
			};
			r.onToolCallReady("tc1", call);
			expect(cap.text()).toBe("");
		});
	});

	describe("onToolCallAutoApproved", () => {
		it("shows [auto-approved] indicator", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onToolCallAutoApproved("tc1");
			expect(cap.text()).toContain("[auto-approved]");
		});
	});

	describe("onToolCallComplete", () => {
		it("shows completed tool with green prefix for success", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			const result: ToolCallResult = {
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
			const result: ToolCallResult = {
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
			const result: ToolCallResult = {
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
			const usage: UsageInfo = {
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
			const usage: UsageInfo = { inputTokens: 100, outputTokens: 50 };
			r.onUsage(usage);
			const text = cap.text();
			expect(text).toContain("100 in");
			expect(text).toContain("50 out");
			expect(text).not.toContain("(");
		});

		it("separates the stats line from streamed reply text with a newline (#103)", () => {
			// Regression: the final delta carries no trailing newline, so the reply
			// text used to abut the stats line ("ELEPHANTTokens: …"). The stats line
			// must start on its own line.
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("ELEPHANT");
			r.onUsage({ inputTokens: 24588, outputTokens: 1 });
			const text = stripAnsi(cap.text());
			expect(text).toContain("ELEPHANT\nTokens:");
			expect(text).not.toContain("ELEPHANTTokens:");
		});

		it("does not add a leading newline when no reply text was streamed", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onUsage({ inputTokens: 100, outputTokens: 50 });
			// Without streamed text there is nothing to separate from.
			expect(stripAnsi(cap.text())).toBe("Tokens: 100 in / 50 out\n");
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

		it("renders authoritative text that was never streamed (fully folded first delta)", () => {
			// Host folded the entire short reply into the subscribe snapshot, so no
			// chat/delta actions arrived — onTurnComplete must still display it. (#86/#92)
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onTurnComplete("ELEPHANT");
			expect(cap.text()).toContain("ELEPHANT");
			expect(cap.text()).toContain("[done]");
		});

		it("renders only the not-yet-streamed remainder", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("ELEP");
			r.onTurnComplete("ELEPHANT");
			// "ELEP" already streamed; only "HANT" should be appended (no duplication).
			expect(stripAnsi(cap.text()).split("[done]")[0]).toBe("\nELEPHANT\n");
		});

		it("does not duplicate when the full text was already streamed", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("BANANA");
			r.onTurnComplete("BANANA");
			const before = stripAnsi(cap.text()).split("[done]")[0];
			expect(before).toBe("\nBANANA\n");
		});

		it("does not garble when streamed text is not a prefix of the authoritative text", () => {
			const cap = createCapture();
			const r = new PromptRenderer(cap.out);
			r.onDelta("ANANA");
			r.onTurnComplete("BANANA");
			// Defensive: a non-prefix mismatch must not append garbled text.
			const before = stripAnsi(cap.text()).split("[done]")[0];
			expect(before).toBe("\nANANA\n");
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
