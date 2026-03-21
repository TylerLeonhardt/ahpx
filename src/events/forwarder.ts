/**
 * Event Forwarder — Pluggable event forwarding system.
 *
 * Defines the `AhpxEvent` shape and the `EventForwarder` interface.
 * Implementations (WebhookForwarder, WebSocketForwarder) forward events
 * to external consumers: dashboards, log aggregators, monitoring systems.
 *
 * Events match the JsonEnvelope shape from the NDJSON formatter, extended
 * with `sessionUri` for multi-session disambiguation.
 */

import type { JsonEventType } from "../output/json-formatter.js";

/**
 * An event emitted by ahpx, suitable for forwarding to external consumers.
 *
 * Intentionally compatible with `JsonEnvelope` from the NDJSON formatter,
 * but with an additional `sessionUri` field for multi-session support.
 */
export interface AhpxEvent {
	/** Event type (e.g. "delta", "tool_call_complete", "turn_complete"). */
	type: JsonEventType | (string & {});
	/** ISO 8601 timestamp of when the event was generated. */
	timestamp: string;
	/** Optional metadata tags (e.g. jobId, project, environment). */
	tags?: Record<string, string>;
	/** Event payload — raw protocol data, no renaming or reshaping. */
	data: Record<string, unknown>;
	/** Session URI this event belongs to (for multi-session disambiguation). */
	sessionUri?: string;
}

/**
 * Interface for forwarding events to external consumers.
 *
 * Implementations handle transport, batching, retry, and filtering.
 * The `forward()` method may buffer events internally — call `close()`
 * to flush any remaining events and release resources.
 */
export interface EventForwarder {
	/** Forward an event to the external consumer. May buffer internally. */
	forward(event: AhpxEvent): Promise<void>;
	/** Flush buffered events and release resources. */
	close(): Promise<void>;
}
