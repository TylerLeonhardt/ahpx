/**
 * Local state mirror — applies incoming actions through the AHP reducers.
 *
 * Maintains a client-side copy of root state and session states,
 * kept in sync by applying action envelopes from the server.
 */

import type { IRootAction, ISessionAction } from "../protocol/action-origin.generated.js";
import type { IActionEnvelope } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import { rootReducer, sessionReducer } from "../protocol/reducers.js";
import type { IRootState, ISessionState, ISnapshot, URI } from "../protocol/state.js";

/** Root actions operate on the root state tree. */
const ROOT_ACTION_TYPES = new Set<string>([ActionType.RootAgentsChanged, ActionType.RootActiveSessionsChanged]);

/**
 * Client-side state mirror that tracks root and session states
 * by applying incoming action envelopes through the protocol reducers.
 */
export class StateMirror {
	private rootState: IRootState = { agents: [] };
	private sessions = new Map<URI, ISessionState>();
	private serverSeq = 0;

	/** Current root state (agents, active session count). */
	get root(): IRootState {
		return this.rootState;
	}

	/** Current server sequence number. */
	get seq(): number {
		return this.serverSeq;
	}

	/** Get a session state by URI. */
	getSession(uri: URI): ISessionState | undefined {
		return this.sessions.get(uri);
	}

	/** All tracked session URIs. */
	get sessionUris(): URI[] {
		return [...this.sessions.keys()];
	}

	/**
	 * Load a snapshot (from initialize, reconnect, or subscribe).
	 */
	applySnapshot(snapshot: ISnapshot): void {
		if (snapshot.fromSeq > this.serverSeq) {
			this.serverSeq = snapshot.fromSeq;
		}

		// Determine if it's root or session state
		if ("agents" in snapshot.state) {
			this.rootState = snapshot.state as IRootState;
		} else if ("summary" in snapshot.state) {
			const sessionState = snapshot.state as ISessionState;
			this.sessions.set(snapshot.resource, sessionState);
		}
	}

	/**
	 * Apply an incoming action envelope from the server.
	 */
	applyAction(envelope: IActionEnvelope): void {
		this.serverSeq = envelope.serverSeq;

		const action = envelope.action;

		if (ROOT_ACTION_TYPES.has(action.type)) {
			this.rootState = rootReducer(this.rootState, action as IRootAction);
		} else {
			// Session action — find the session by URI
			const sessionAction = action as ISessionAction & { session?: URI };
			const sessionUri = sessionAction.session;
			if (sessionUri) {
				const current = this.sessions.get(sessionUri);
				if (current) {
					this.sessions.set(sessionUri, sessionReducer(current, sessionAction));
				}
			}
		}
	}

	/**
	 * Remove a session from tracking (e.g. after dispose or unsubscribe).
	 */
	removeSession(uri: URI): void {
		this.sessions.delete(uri);
	}
}
