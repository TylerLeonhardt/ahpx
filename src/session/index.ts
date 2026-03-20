/**
 * Session module — session store, scoping, and connection helpers.
 */

export { SessionStore } from "./store.js";
export type { SessionRecord, SessionFilter } from "./store.js";
export { findGitRoot, resolveSession } from "./scope.js";
export { withConnection } from "./connect-helper.js";
export type { WithConnectionOptions } from "./connect-helper.js";
