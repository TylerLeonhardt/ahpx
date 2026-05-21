/**
 * Notification Types — Source of truth for all AHP notification definitions.
 *
 * @module notifications
 * @description In the channel-based protocol (0.2.0+), notifications are
 * top-level JSON-RPC methods, not wrapped in a `notification` envelope.
 * Each notification carries a `channel` field identifying its scope.
 */

import type { URI, SessionSummary } from './state.js';

/**
 * Reason why authentication is required.
 *
 * @category Protocol Notifications
 */
export const enum AuthRequiredReason {
  /** The client has not yet authenticated for the resource */
  Required = 'required',
  /** A previously valid token has expired or been revoked */
  Expired = 'expired',
}

// ─── Notification Method Names ───────────────────────────────────────────────

/**
 * Top-level JSON-RPC method names for protocol notifications.
 *
 * In AHP 0.2.0+, each notification is a top-level method rather than
 * being wrapped in a `notification` envelope.
 *
 * @category Protocol Notifications
 */
export const enum NotificationType {
  SessionAdded = 'root/sessionAdded',
  SessionRemoved = 'root/sessionRemoved',
  SessionSummaryChanged = 'root/sessionSummaryChanged',
  AuthRequired = 'auth/required',
}

// ─── Notification Params ─────────────────────────────────────────────────────

/**
 * Params for `root/sessionAdded` — broadcast when a new session is created.
 *
 * @category Protocol Notifications
 * @version 2
 */
export interface SessionAddedNotification {
  type: NotificationType.SessionAdded;
  /** Channel URI (always `ahp-root://` for root notifications) */
  channel: URI;
  /** Summary of the new session */
  summary: SessionSummary;
}

/**
 * Params for `root/sessionRemoved` — broadcast when a session is disposed.
 *
 * @category Protocol Notifications
 * @version 2
 */
export interface SessionRemovedNotification {
  type: NotificationType.SessionRemoved;
  /** Channel URI (always `ahp-root://` for root notifications) */
  channel: URI;
  /** URI of the removed session */
  session: URI;
}

/**
 * Params for `root/sessionSummaryChanged` — broadcast when a session's
 * summary mutates.
 *
 * @category Protocol Notifications
 * @version 2
 */
export interface SessionSummaryChangedNotification {
  type: NotificationType.SessionSummaryChanged;
  /** Channel URI (always `ahp-root://` for root notifications) */
  channel: URI;
  /** URI of the session whose summary changed */
  session: URI;
  /**
   * Mutable summary fields that changed; omitted fields are unchanged.
   */
  changes: Partial<SessionSummary>;
}

/**
 * Params for `auth/required` — sent when a resource requires (re-)authentication.
 *
 * @category Protocol Notifications
 * @version 2
 */
export interface AuthRequiredNotification {
  type: NotificationType.AuthRequired;
  /** Channel URI (always `ahp-root://` for auth notifications) */
  channel: URI;
  /** The protected resource identifier that requires authentication */
  resource: string;
  /** Why authentication is required */
  reason?: AuthRequiredReason;
}

/**
 * Union of all notification params types.
 *
 * In AHP 0.2.0+, each notification is delivered as a top-level JSON-RPC
 * method. This union is kept for code that handles multiple notification
 * types generically.
 */
export type ProtocolNotification =
  | SessionAddedNotification
  | SessionRemovedNotification
  | SessionSummaryChangedNotification
  | AuthRequiredNotification;
