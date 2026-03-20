import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ToolCallInfo, WritableOutput } from "../../output/renderer.js";
import { PermissionKind } from "../../protocol/state.js";
import type { IPermissionRequest } from "../../protocol/state.js";
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

function makePermissionRequest(overrides: Partial<IPermissionRequest> = {}): IPermissionRequest {
	return {
		requestId: "p1",
		permissionKind: PermissionKind.Shell,
		fullCommandText: "npm test",
		...overrides,
	};
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
		it("auto-approves permission requests", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("approve-all", { output: cap.out });
			const result = await handler.handlePermission(makePermissionRequest());
			expect(result).toBe(true);
			expect(cap.text()).toContain("[auto-approved]");
		});

		it("auto-approves tool confirmations", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("approve-all", { output: cap.out });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(true);
			expect(cap.text()).toContain("[auto-approved]");
		});
	});

	describe("deny-all mode", () => {
		it("auto-denies permission requests", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("deny-all", { output: cap.out });
			const result = await handler.handlePermission(makePermissionRequest());
			expect(result).toBe(false);
			expect(cap.text()).toContain("[denied]");
		});

		it("auto-denies tool confirmations", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("deny-all", { output: cap.out });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(false);
			expect(cap.text()).toContain("[denied]");
		});
	});

	describe("approve-reads mode", () => {
		it("auto-approves read permissions", async () => {
			const cap = createCapture();
			const handler = new PermissionHandler("approve-reads", { output: cap.out });
			const result = await handler.handlePermission(makePermissionRequest({ permissionKind: PermissionKind.Read }));
			expect(result).toBe(true);
			expect(cap.text()).toContain("[auto-approved: read]");
		});

		it("prompts for shell permissions and accepts y", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handlePermission(makePermissionRequest({ permissionKind: PermissionKind.Shell }));
			expect(result).toBe(true);
			expect(cap.text()).toContain("Allow");
		});

		it("prompts for shell permissions and denies on N", async () => {
			const cap = createCapture();
			const input = createInput("N");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handlePermission(makePermissionRequest({ permissionKind: PermissionKind.Shell }));
			expect(result).toBe(false);
		});

		it("prompts for write permissions", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handlePermission(
				makePermissionRequest({ permissionKind: PermissionKind.Write, path: "/tmp/file.txt" }),
			);
			expect(result).toBe(true);
		});

		it("prompts for MCP permissions", async () => {
			const cap = createCapture();
			const input = createInput("n");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handlePermission(
				makePermissionRequest({ permissionKind: PermissionKind.Mcp, serverName: "my-mcp" }),
			);
			expect(result).toBe(false);
		});

		it("denies on empty input (enter without y)", async () => {
			const cap = createCapture();
			const input = createInput("");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handlePermission(makePermissionRequest({ permissionKind: PermissionKind.Shell }));
			expect(result).toBe(false);
		});

		it("prompts for tool confirmations", async () => {
			const cap = createCapture();
			const input = createInput("y");
			const handler = new PermissionHandler("approve-reads", { output: cap.out, input });
			const result = await handler.handleToolConfirmation(makeToolCall());
			expect(result).toBe(true);
		});
	});
});
