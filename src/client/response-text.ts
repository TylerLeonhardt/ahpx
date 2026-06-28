/**
 * Derive a turn's display text from its response parts.
 *
 * The authoritative response text lives in the chat state's turn
 * (`responseParts`), assembled by the state reducer from both the subscribe
 * snapshot and live `chat/delta` actions. Accumulating `chat/delta` action
 * content alone is lossy: when a client subscribes to a chat channel while a
 * turn is starting, the host MAY fold the first delta(s) into the subscribe
 * snapshot's `activeTurn` rather than re-emitting them as `chat/delta` actions.
 * Reading from state recovers that text.
 */

import type { ResponsePart } from "@microsoft/agent-host-protocol";
import { ResponsePartKind } from "@microsoft/agent-host-protocol";

/** Concatenate the markdown content of a turn's response parts in stream order. */
export function textFromResponseParts(parts: ResponsePart[] | undefined): string {
	if (!parts) return "";
	let text = "";
	for (const part of parts) {
		if (part.kind === ResponsePartKind.Markdown) {
			text += part.content;
		}
	}
	return text;
}
