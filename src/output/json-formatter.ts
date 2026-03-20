/**
 * JSON Formatter — NDJSON output (one JSON object per line).
 *
 * Each event has a stable envelope:
 * ```json
 * { "type": "delta", "timestamp": "<ISO>", "data": { ... } }
 * ```
 *
 * Raw protocol data goes in `data` — no renaming or reshaping.
 *
 * When `strict` mode is enabled, non-JSON stderr output is suppressed.
 */

import type { IErrorInfo, IPermissionRequest, IToolCallResult, IUsageInfo } from "../protocol/state.js";
import type { OutputFormatter, WritableOutput } from "./format.js";
import type { ToolCallInfo } from "./renderer.js";

export type JsonEventType =
	| "delta"
	| "reasoning"
	| "tool_call_start"
	| "tool_call_delta"
	| "tool_call_ready"
	| "tool_call_complete"
	| "tool_call_cancelled"
	| "permission"
	| "usage"
	| "turn_complete"
	| "turn_error"
	| "turn_cancelled"
	| "title_changed";

export interface JsonEnvelope {
	type: JsonEventType;
	timestamp: string;
	data: Record<string, unknown>;
}

/**
 * Emits NDJSON events to stdout.
 *
 * @param strict - When true, suppress all non-JSON stderr output.
 */
export class JsonFormatter implements OutputFormatter {
	constructor(
		private readonly out: WritableOutput = process.stdout,
		private readonly strict: boolean = false,
	) {}

	/** Whether strict mode is active (suppresses non-JSON stderr). */
	get isStrict(): boolean {
		return this.strict;
	}

	onDelta(text: string): void {
		this.emit("delta", { content: text });
	}

	onReasoning(text: string): void {
		this.emit("reasoning", { content: text });
	}

	onToolCallStart(id: string, name: string): void {
		this.emit("tool_call_start", { toolCallId: id, name });
	}

	onToolCallDelta(id: string, paramsDelta: string): void {
		this.emit("tool_call_delta", { toolCallId: id, content: paramsDelta });
	}

	onToolCallReady(id: string, call: ToolCallInfo): void {
		this.emit("tool_call_ready", {
			toolCallId: id,
			toolName: call.toolName,
			displayName: call.displayName,
			invocationMessage: call.invocationMessage,
			...(call.toolInput !== undefined ? { toolInput: call.toolInput } : {}),
		});
	}

	onToolCallComplete(id: string, result: IToolCallResult): void {
		this.emit("tool_call_complete", { toolCallId: id, result });
	}

	onToolCallCancelled(id: string, reason: string): void {
		this.emit("tool_call_cancelled", { toolCallId: id, reason });
	}

	onPermissionRequest(req: IPermissionRequest): void {
		this.emit("permission", { request: req });
	}

	onUsage(usage: IUsageInfo): void {
		this.emit("usage", { usage });
	}

	onTurnComplete(responseText: string): void {
		this.emit("turn_complete", { responseText });
	}

	onTurnError(error: IErrorInfo): void {
		this.emit("turn_error", { error });
	}

	onTurnCancelled(): void {
		this.emit("turn_cancelled", {});
	}

	onTitleChanged(title: string): void {
		this.emit("title_changed", { title });
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	private emit(type: JsonEventType, data: Record<string, unknown>): void {
		const envelope: JsonEnvelope = {
			type,
			timestamp: new Date().toISOString(),
			data,
		};
		this.out.write(`${JSON.stringify(envelope)}\n`);
	}
}
