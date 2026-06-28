import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ToolCallInfo, WritableOutput } from "../../output/renderer.js";
import { PermissionHandler } from "../handler.js";

/** Captures all output. */
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

/** Creates a readable stream that emits a line. */
function createInput(answer: string): NodeJS.ReadableStream {
	const stream = new Readable({ read() {} });
	// Push the answer asynchronously to simulate user input
	setTimeout(() => {
		stream.push(`${answer}\n`);
		stream.push(null);
	}, 10);
	return stream;
}

function makeToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
	return {
		toolCallId: "tc1",
		toolName: "shell",
		displayName: "Shell",
		invocationMessage: "Run npm test",
		...overrides,
	};
}

describe("PermissionHandler", () => {
	describe("approve-all mode", () => {
		it("auto-approves tool confirmations", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("approve-all", { output: cap.out });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(true);
			expect(cap.text()).toContain("[auto-approved]");
		});
	});

	describe("deny-all mode", () => {
		it("auto-denies tool confirmations", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("deny-all", { output: cap.out });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(false);
			expect(cap.text()).toContain("[denied]");
		});
	});

	describe("approve-reads mode", () => {
		it("prompts the user for all tool calls", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(true);
			expect(cap.text()).toContain("Allow Tool");
		});
	});

	describe("format-aware chatter routing (#103)", () => {
		it("text mode writes [auto-approved] to stdout (unchanged)", async () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const handler = new PermissionHandler("approve-all", {
				output: stdout.out,
				errorOutput: stderr.out,
				format: "text",
			});
			await handler.handleToolConfirmation(makeToolCall());
			expect(stdout.text()).toContain("[auto-approved]");
			expect(stderr.text()).toBe("");
		});

		for (const format of ["json", "quiet"] as const) {
			it(`${format} mode keeps stdout clean and routes chatter to stderr`, async () => {
				const stdout = createCapture();
				const stderr = createCapture();
				const handler = new PermissionHandler("approve-all", {
					output: stdout.out,
					errorOutput: stderr.out,
					format,
				});
				const result = await handler.handleToolConfirmation(makeToolCall());
				expect(result).toBe(true);
				// stdout must stay pure (no human chatter) so NDJSON / the answer is clean.
				expect(stdout.text()).toBe("");
				expect(stderr.text()).toContain("[auto-approved]");
			});
		}

		it("deny-all chatter is also kept off stdout in json mode", async () => {
			const stdout = createCapture();
			const stderr = createCapture();
			const handler = new PermissionHandler("deny-all", {
				output: stdout.out,
				errorOutput: stderr.out,
				format: "json",
			});
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(false);
			expect(stdout.text()).toBe("");
			expect(stderr.text()).toContain("[denied]");
		});
	});
});
