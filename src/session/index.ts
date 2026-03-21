/**
 * Session module — session store, scoping, persistence, and connection helpers.
 */

export { SessionStore, truncatePreview, buildTurnSummary } from "./store.js";
export type { SessionRecord, SessionFilter, TurnSummary } from "./store.js";
export { findGitRoot, resolveSession } from "./scope.js";
export { withConnection } from "./connect-helper.js";
export type { WithConnectionOptions } from "./connect-helper.js";
export { SessionPersistence } from "./persistence.js";
export type { ResumeOutcome, SyncResult } from "./persistence.js";
