/**
 * Local state mirror — applies incoming actions through the AHP reducers.
 *
 * Maintains a client-side copy of root state and session states,
 * kept in sync by applying action envelopes from the server.
 */

import type { IRootAction, ISessionAction, ITerminalAction } from "../protocol/action-origin.generated.js";
import type { IActionEnvelope } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import { rootReducer, sessionReducer, terminalReducer } from "../protocol/reducers.js";
import type { IRootState, ISessionState, ISnapshot, ITerminalState, URI } from "../protocol/state.js";

/** Root actions operate on the root state tree. */
const ROOT_ACTION_TYPES = new Set<string>([
	ActionType.RootAgentsChanged,
	ActionType.RootActiveSessionsChanged,
	ActionType.RootTerminalsChanged,
]);

/** Terminal actions have type starting with this prefix. */
const TERMINAL_ACTION_PREFIX = "terminal/";

/**
 * Client-side state mirror that tracks root and session states
 * by applying incoming action envelopes through the protocol reducers.
 */
export class StateMirror {
	private rootState: IRootState = { agents: [] };
	private sessions = new Map<URI, ISessionState>();
	private terminals = new Map<URI, ITerminalState>();
	private serverSeq = 0;
	private pendingActions = new Map<URI, IActionEnvelope[]>();

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

	/** Get a terminal state by URI. */
	getTerminal(uri: URI): ITerminalState | undefined {
		return this.terminals.get(uri);
	}

	/** All tracked terminal URIs. */
	get terminalUris(): URI[] {
		return [...this.terminals.keys()];
	}

	/** Remove a terminal from tracking. */
	removeTerminal(uri: URI): void {
		this.terminals.delete(uri);
		this.pendingActions.delete(uri);
	}

	/**
	 * Load a snapshot (from initialize, reconnect, or subscribe).
	 * After registering a session, replays any actions that arrived before the snapshot.
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

			// Replay any actions that arrived before this snapshot
			const buffered = this.pendingActions.get(snapshot.resource);
			if (buffered) {
				this.pendingActions.delete(snapshot.resource);
				for (const env of buffered) {
					// Only replay actions with serverSeq > snapshot.fromSeq
					// (earlier actions are already reflected in the snapshot)
					if (env.serverSeq > snapshot.fromSeq) {
						const current = this.sessions.get(snapshot.resource);
						if (current) {
							this.sessions.set(
								snapshot.resource,
								sessionReducer(current, env.action as ISessionAction & { session?: URI }),
							);
						}
					}
				}
			}
		} else if ("claim" in snapshot.state) {
			const terminalState = snapshot.state as ITerminalState;
			this.terminals.set(snapshot.resource, terminalState);

			// Replay any buffered terminal actions
			const buffered = this.pendingActions.get(snapshot.resource);
			if (buffered) {
				this.pendingActions.delete(snapshot.resource);
				for (const env of buffered) {
					if (env.serverSeq > snapshot.fromSeq) {
						const current = this.terminals.get(snapshot.resource);
						if (current) {
							this.terminals.set(
								snapshot.resource,
								terminalReducer(current, env.action as ITerminalAction & { terminal?: URI }),
							);
						}
					}
				}
			}
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
		} else if (action.type.startsWith(TERMINAL_ACTION_PREFIX)) {
			const terminalAction = action as ITerminalAction & { terminal?: URI };
			const terminalUri = terminalAction.terminal;
			if (terminalUri) {
				const current = this.terminals.get(terminalUri);
				if (current) {
					this.terminals.set(terminalUri, terminalReducer(current, terminalAction));
				} else {
					// Terminal not yet registered — buffer for replay after applySnapshot
					let buffer = this.pendingActions.get(terminalUri);
					if (!buffer) {
						buffer = [];
						this.pendingActions.set(terminalUri, buffer);
					}
					buffer.push(envelope);
				}
			}
		} else {
			// Session action — find the session by URI
			const sessionAction = action as ISessionAction & { session?: URI };
			const sessionUri = sessionAction.session;
			if (sessionUri) {
				const current = this.sessions.get(sessionUri);
				if (current) {
					this.sessions.set(sessionUri, sessionReducer(current, sessionAction));
				} else {
					// Session not yet registered — buffer for replay after applySnapshot
					let buffer = this.pendingActions.get(sessionUri);
					if (!buffer) {
						buffer = [];
						this.pendingActions.set(sessionUri, buffer);
					}
					buffer.push(envelope);
				}
			}
		}
	}

	/**
	 * Remove a session from tracking (e.g. after dispose or unsubscribe).
	 */
	removeSession(uri: URI): void {
		this.sessions.delete(uri);
		this.pendingActions.delete(uri);
	}
}
