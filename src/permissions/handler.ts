/**
 * PermissionHandler — Interactive permission prompting for tool calls.
 *
 * Three modes:
 *   - approve-all:   auto-approve everything
 *   - approve-reads: auto-approve read-only operations, prompt for writes/shell/mcp
 *   - deny-all:      auto-deny everything
 */

import * as readline from "node:readline";
import pc from "picocolors";
import type { ToolCallInfo, WritableOutput } from "../output/renderer.js";

export type PermissionMode = "approve-all" | "approve-reads" | "deny-all";

export interface PermissionHandlerOptions {
	/** Input stream for interactive prompts (default: process.stdin) */
	input?: NodeJS.ReadableStream;
	/** Output stream for messages (default: process.stdout) */
	output?: WritableOutput;
}

/**
 * Handles permission prompts for tool calls.
 */
export class PermissionHandler {
	private readonly input: NodeJS.ReadableStream;
	private readonly output: WritableOutput;

	constructor(
		readonly mode: PermissionMode,
		options?: PermissionHandlerOptions,
	) {
		this.input = options?.input ?? process.stdin;
		this.output = options?.output ?? process.stdout;
	}

	/**
	 * Handle tool call confirmation.
	 * Returns true (approved) or false (denied).
	 */
	async handleToolConfirmation(toolCall: ToolCallInfo): Promise<boolean> {
		if (this.mode === "approve-all") {
			this.output.write(`${pc.dim("  [auto-approved]")}\n`);
			return true;
		}

		if (this.mode === "deny-all") {
			this.output.write(`${pc.dim("  [denied]")}\n`);
			return false;
		}

		// approve-reads mode — use tool annotations to decide
		if (toolCall.annotations?.readOnlyHint === true) {
			this.output.write(`${pc.dim("  [auto-approved read]")}\n`);
			return true;
		}
		const msg =
			typeof toolCall.invocationMessage === "string" ? toolCall.invocationMessage : toolCall.invocationMessage.markdown;
		return this.promptUser("tool", msg);
	}

	/**
	 * Interactive y/N prompt.
	 */
	private promptUser(kind: string, detail: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let resolved = false;

			const label = kind.charAt(0).toUpperCase() + kind.slice(1);
			this.output.write(`  Allow ${label}: ${detail}? (y/N): `);

			const rl = readline.createInterface({
				input: this.input,
				terminal: false,
			});

			rl.once("line", (answer) => {
				if (resolved) return;
				resolved = true;
				rl.close();
				const approved = answer.trim().toLowerCase() === "y";
				if (approved) {
					this.output.write(`${pc.dim("  [approved]")}\n`);
				} else {
					this.output.write(`${pc.dim("  [denied]")}\n`);
				}
				resolve(approved);
			});

			// If input closes without a line, deny
			rl.once("close", () => {
				if (resolved) return;
				resolved = true;
				resolve(false);
			});
		});
	}
}
