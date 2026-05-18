/**
 * Forwarding Formatter — Decorator that wraps an OutputFormatter and
 * forwards events to one or more EventForwarder instances.
 *
 * Each OutputFormatter method is delegated to the inner formatter AND
 * converted to an AhpxEvent that is forwarded to all registered forwarders.
 *
 * Forwarding is fire-and-forget — errors are logged but never propagate
 * to the formatter or TurnController. This ensures that a flaky endpoint
 * never disrupts the primary output pipeline.
 */

import { createLogger } from "../logger.js";
import type { OutputFormatter } from "../output/format.js";
import type { JsonEventType } from "../output/json-formatter.js";
import type { ToolCallInfo } from "../output/renderer.js";
import type { ErrorInfo, ToolCallResult, UsageInfo } from "../protocol/state.js";
import type { AhpxEvent, EventForwarder } from "./forwarder.js";

const log = createLogger("forwarding-formatter");

export interface ForwardingFormatterOptions {
	/** The inner formatter to delegate rendering to. */
	inner: OutputFormatter;
	/** One or more forwarders to send events to. */
	forwarders: EventForwarder[];
	/** Session URI to attach to forwarded events. */
	sessionUri?: string;
	/** Metadata tags to attach to forwarded events. */
	tags?: Record<string, string>;
}

export class ForwardingFormatter implements OutputFormatter {
	private readonly inner: OutputFormatter;
	private readonly forwarders: EventForwarder[];
	private readonly tags?: Record<string, string>;

	/** Session URI to attach to forwarded events. Can be set after construction. */
	sessionUri?: string;

	constructor(options: ForwardingFormatterOptions) {
		this.inner = options.inner;
		this.forwarders = options.forwarders;
		this.sessionUri = options.sessionUri;
		this.tags = options.tags;
	}

	onDelta(text: string): void {
		this.inner.onDelta(text);
		this.emit("delta", { content: text });
	}

	onReasoning(text: string): void {
		this.inner.onReasoning(text);
		this.emit("reasoning", { content: text });
	}

	onToolCallStart(id: string, name: string): void {
		this.inner.onToolCallStart(id, name);
		this.emit("tool_call_start", { toolCallId: id, name });
	}

	onToolCallDelta(id: string, paramsDelta: string): void {
		this.inner.onToolCallDelta(id, paramsDelta);
		this.emit("tool_call_delta", { toolCallId: id, content: paramsDelta });
	}

	onToolCallReady(id: string, call: ToolCallInfo): void {
		this.inner.onToolCallReady(id, call);
		this.emit("tool_call_ready", {
			toolCallId: id,
			toolName: call.toolName,
			displayName: call.displayName,
			invocationMessage: call.invocationMessage,
			...(call.toolInput !== undefined ? { toolInput: call.toolInput } : {}),
		});
	}

	onToolCallAutoApproved(id: string): void {
		this.inner.onToolCallAutoApproved(id);
		this.emit("tool_call_auto_approved", { toolCallId: id });
	}

	onToolCallComplete(id: string, result: ToolCallResult): void {
		this.inner.onToolCallComplete(id, result);
		this.emit("tool_call_complete", { toolCallId: id, result });
	}

	onToolCallCancelled(id: string, reason: string): void {
		this.inner.onToolCallCancelled(id, reason);
		this.emit("tool_call_cancelled", { toolCallId: id, reason });
	}

	onUsage(usage: UsageInfo): void {
		this.inner.onUsage(usage);
		this.emit("usage", { usage });
	}

	onTurnComplete(responseText: string): void {
		this.inner.onTurnComplete(responseText);
		this.emit("turn_complete", { responseText });
	}

	onTurnError(error: ErrorInfo): void {
		this.inner.onTurnError(error);
		this.emit("turn_error", { error });
	}

	onTurnCancelled(): void {
		this.inner.onTurnCancelled();
		this.emit("turn_cancelled", {});
	}

	onTitleChanged(title: string): void {
		this.inner.onTitleChanged(title);
		this.emit("title_changed", { title });
	}

	/**
	 * Close all forwarders, flushing any buffered events.
	 *
	 * Call this when the session/turn is done to ensure all events
	 * have been delivered.
	 */
	async close(): Promise<void> {
		await Promise.allSettled(this.forwarders.map((f) => f.close()));
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private emit(type: JsonEventType, data: Record<string, unknown>): void {
		const event: AhpxEvent = {
			type,
			timestamp: new Date().toISOString(),
			...(this.tags && Object.keys(this.tags).length > 0 ? { tags: this.tags } : {}),
			data,
			...(this.sessionUri ? { sessionUri: this.sessionUri } : {}),
		};

		// Fire-and-forget — errors logged, never propagated
		for (const forwarder of this.forwarders) {
			forwarder.forward(event).catch((err) => {
				log.info("forward-error", { type, error: err instanceof Error ? err.message : String(err) });
			});
		}
	}
}
