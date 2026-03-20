import { describe, expect, it } from "vitest";
import { PermissionKind } from "../../protocol/state.js";
import { QuietFormatter } from "../quiet-formatter.js";
import type { WritableOutput } from "../renderer.js";

/** Captures output written to a stream. */
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

describe("QuietFormatter", () => {
	describe("silent during streaming", () => {
		it("does not output deltas", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onDelta("Hello ");
			fmt.onDelta("world");

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});

		it("does not output reasoning", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onReasoning("thinking...");

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});

		it("does not output tool calls", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onToolCallStart("tc1", "shell");
			fmt.onToolCallDelta("tc1", '{"cmd": "npm');
			fmt.onToolCallReady("tc1", {
				toolCallId: "tc1",
				toolName: "shell",
				displayName: "Shell",
				invocationMessage: "Run npm test",
			});
			fmt.onToolCallComplete("tc1", { success: true, pastTenseMessage: "Ran npm test" });
			fmt.onToolCallCancelled("tc2", "user denied");

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});

		it("does not output permission requests", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onPermissionRequest({
				requestId: "p1",
				permissionKind: PermissionKind.Shell,
				fullCommandText: "npm test",
			});

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});

		it("does not output usage", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onUsage({ inputTokens: 100, outputTokens: 50 });

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});

		it("does not output title changes", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onTitleChanged("New Title");

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});
	});

	describe("onTurnComplete", () => {
		it("prints only the final response text to stdout", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			// All these should be silent
			fmt.onReasoning("thinking...");
			fmt.onDelta("Hello ");
			fmt.onDelta("world");
			fmt.onToolCallStart("tc1", "shell");
			fmt.onToolCallComplete("tc1", { success: true, pastTenseMessage: "done" });
			fmt.onUsage({ inputTokens: 100, outputTokens: 50 });

			// Only this should produce output
			fmt.onTurnComplete("Hello world");

			expect(stdout.text()).toBe("Hello world\n");
			expect(stderr.text()).toBe("");
		});

		it("prints nothing for empty response", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onTurnComplete("");

			expect(stdout.text()).toBe("");
		});
	});

	describe("onTurnError", () => {
		it("prints error message to stderr", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onTurnError({ errorType: "runtime", message: "model overloaded" });

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("model overloaded\n");
		});
	});

	describe("onTurnCancelled", () => {
		it("is silent", () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const fmt = new QuietFormatter(stdout.out, stderr.out);

			fmt.onTurnCancelled();

			expect(stdout.text()).toBe("");
			expect(stderr.text()).toBe("");
		});
	});
});
