/**
 * Protocol notification compatibility layer.
 *
 * The official `@microsoft/agent-host-protocol` package models protocol
 * notifications as bare JSON-RPC param types (`SessionAddedParams`, …) whose
 * discriminator is the JSON-RPC *method* name rather than a field on the
 * payload. ahpx, however, surfaces notifications as a single `type`-discriminated
 * union so consumers can `switch` on them. This module layers that `type`
 * discriminator over the official param types, preserving the ahpx convention
 * without re-vendoring the protocol.
 */

import type {
	AuthRequiredParams,
	SessionAddedParams,
	SessionRemovedParams,
	SessionSummaryChangedParams,
} from "@microsoft/agent-host-protocol";

export { AuthRequiredReason } from "@microsoft/agent-host-protocol";

/**
 * Top-level JSON-RPC method names for protocol notifications.
 *
 * Each notification is delivered as a top-level method rather than wrapped in a
 * `notification` envelope.
 */
export enum NotificationType {
	SessionAdded = "root/sessionAdded",
	SessionRemoved = "root/sessionRemoved",
	SessionSummaryChanged = "root/sessionSummaryChanged",
	AuthRequired = "auth/required",
}

/** Params for `root/sessionAdded`, tagged with its notification `type`. */
export type SessionAddedNotification = SessionAddedParams & {
	type: NotificationType.SessionAdded;
};

/** Params for `root/sessionRemoved`, tagged with its notification `type`. */
export type SessionRemovedNotification = SessionRemovedParams & {
	type: NotificationType.SessionRemoved;
};

/** Params for `root/sessionSummaryChanged`, tagged with its notification `type`. */
export type SessionSummaryChangedNotification = SessionSummaryChangedParams & {
	type: NotificationType.SessionSummaryChanged;
};

/** Params for `auth/required`, tagged with its notification `type`. */
export type AuthRequiredNotification = AuthRequiredParams & {
	type: NotificationType.AuthRequired;
};

/** Union of all notification params types, discriminated by `type`. */
export type ProtocolNotification =
	| SessionAddedNotification
	| SessionRemovedNotification
	| SessionSummaryChangedNotification
	| AuthRequiredNotification;
