/**
 * PromptRenderer — Streaming terminal renderer for AHP turn output.
 *
 * Renders deltas, reasoning blocks, tool calls, permissions, usage,
 * and turn lifecycle events to stdout with color formatting via picocolors.
 */

import pc from "picocolors";
import type {
	IErrorInfo,
	IPermissionRequest,
	IToolCallResult,
	IUsageInfo,
	StringOrMarkdown,
} from "../protocol/state.js";
import type { OutputFormatter } from "./format.js";

/** Minimal info about a tool call ready for display. */
export interface ToolCallInfo {
	toolCallId: string;
	toolName: string;
	displayName: string;
	invocationMessage: StringOrMarkdown;
	toolInput?: string;
}

/** Writable stream interface for testability. */
export interface WritableOutput {
	write(data: string): void;
}

/** Extract the text from a StringOrMarkdown value. */
function textOf(v: StringOrMarkdown): string {
	return typeof v === "string" ? v : v.markdown;
}

/**
 * Streaming text renderer for the terminal.
 *
 * Call the `on*` methods as actions arrive from the server to
 * produce formatted output on the target stream.
 */
export class PromptRenderer implements OutputFormatter {
	private hasStreamedText = false;
	private reasoningOpen = false;

	constructor(private readonly out: WritableOutput = process.stdout) {}

	/** Append streaming text delta. */
	onDelta(text: string): void {
		if (!this.hasStreamedText) {
			this.out.write("\n");
			this.hasStreamedText = true;
		}
		this.closeReasoningIfNeeded();
		this.out.write(text);
	}

	/** Show [thinking] block text. */
	onReasoning(text: string): void {
		if (!this.reasoningOpen) {
			this.out.write(`${pc.dim("[thinking]")} `);
			this.reasoningOpen = true;
		}
		this.out.write(pc.dim(text));
	}

	/** Tool call started (streaming parameters). */
	onToolCallStart(_id: string, name: string): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		this.out.write(`${pc.yellow("[tool]")} ${name} ${pc.dim("(running)")}\n`);
	}

	/** Tool call streaming parameter delta — silent, state tracked internally. */
	onToolCallDelta(_id: string, _paramsDelta: string): void {
		// Parameter streaming is silent in text mode; the state mirror tracks it.
	}

	/** Tool call parameters complete, pending confirmation. */
	onToolCallReady(_id: string, call: ToolCallInfo): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		const msg = textOf(call.invocationMessage);
		this.out.write(`${pc.yellow("[tool]")} ${msg} ${pc.dim("(pending confirmation)")}\n`);
	}

	/** Tool call completed with result. */
	onToolCallComplete(_id: string, result: IToolCallResult): void {
		const msg = textOf(result.pastTenseMessage);
		const color = result.success ? pc.green : pc.red;
		this.out.write(`${color("[tool]")} ${msg} ${pc.dim("(completed)")}\n`);

		// Show text content if available
		if (result.content) {
			for (const block of result.content) {
				if ("text" in block && block.text) {
					const preview = block.text.length > 200 ? `${block.text.slice(0, 200)}…` : block.text;
					for (const line of preview.split("\n")) {
						this.out.write(`  ${pc.dim(line)}\n`);
					}
				}
			}
		}
	}

	/** Tool call was cancelled. */
	onToolCallCancelled(_id: string, reason: string): void {
		this.out.write(`${pc.red("[tool]")} cancelled: ${reason}\n`);
	}

	/** Permission request received. */
	onPermissionRequest(req: IPermissionRequest): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		const label = req.permissionKind.charAt(0).toUpperCase() + req.permissionKind.slice(1);
		const detail = req.fullCommandText ?? req.path ?? req.intention ?? req.toolName ?? "";
		this.out.write(`${pc.magenta("[permission]")} ${label}: ${detail}\n`);
	}

	/** Token usage report. */
	onUsage(usage: IUsageInfo): void {
		const parts: string[] = [];
		if (usage.inputTokens != null) {
			parts.push(`${usage.inputTokens.toLocaleString()} in`);
		}
		if (usage.outputTokens != null) {
			parts.push(`${usage.outputTokens.toLocaleString()} out`);
		}
		const model = usage.model ? ` (${usage.model})` : "";
		if (parts.length > 0) {
			this.out.write(pc.dim(`Tokens: ${parts.join(" / ")}${model}\n`));
		}
	}

	/** Turn completed successfully. */
	onTurnComplete(_responseText: string): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		this.out.write(`\n${pc.green("[done]")} end_turn\n`);
	}

	/** Turn ended with an error. */
	onTurnError(error: IErrorInfo): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		this.out.write(`\n${pc.red("[error]")} ${error.message}\n`);
	}

	/** Turn was cancelled. */
	onTurnCancelled(): void {
		this.closeReasoningIfNeeded();
		this.ensureNewline();
		this.out.write(`\n${pc.yellow("[cancelled]")} turn cancelled\n`);
	}

	/** Session title changed. */
	onTitleChanged(_title: string): void {
		// Silent in streaming mode — title is tracked in the session store.
	}

	// ── Private helpers ───────────────────────────────────────────────────

	private closeReasoningIfNeeded(): void {
		if (this.reasoningOpen) {
			this.out.write("\n\n");
			this.reasoningOpen = false;
		}
	}

	private ensureNewline(): void {
		// No-op in line-based output; each section writes its own newlines.
	}
}
