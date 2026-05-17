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
		it("auto-approves tool calls with readOnlyHint=true", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("approve-reads", { output: cap.out });
			const result = await handler.handleToolConfirmation(makeToolCall({ annotations: { readOnlyHint: true } }));
			expect(result).toBe(true);
			expect(cap.text()).toContain("[auto-approved read]");
		});

		it("prompts for tool calls with readOnlyHint=false", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handleToolConfirmation(makeToolCall({ annotations: { readOnlyHint: false } }));
			expect(result).toBe(true);
			expect(cap.text()).toContain("Allow Tool");
		});

		it("prompts for tool calls with no annotations", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(true);
		});

		it("prompts for tool calls with annotations but no readOnlyHint", async () => {
			const cap = createCapture();
			const input = createInput("n");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handleToolConfirmation(makeToolCall({ annotations: { destructiveHint: true } }));
			expect(result).toBe(false);
		});
	});
});
