/**
 * Local state mirror — applies incoming actions through the AHP reducers.
 *
 * Maintains a client-side copy of root state and session states,
 * kept in sync by applying action envelopes from the server.
 */

import type { RootAction, SessionAction, TerminalAction } from "../protocol/action-origin.generated.js";
import type { ActionEnvelope } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import { rootReducer, sessionReducer, terminalReducer } from "../protocol/reducers.js";
import type { RootState, SessionState, Snapshot, TerminalState, URI } from "../protocol/state.js";

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
	private rootState: RootState = { agents: [] };
	private sessions = new Map<URI, SessionState>();
	private terminals = new Map<URI, TerminalState>();
	private serverSeq = 0;
	private pendingActions = new Map<URI, ActionEnvelope[]>();

	/** Current root state (agents, active session count). */
	get root(): RootState {
		return this.rootState;
	}

	/** Current server sequence number. */
	get seq(): number {
		return this.serverSeq;
	}

	/** Get a session state by URI. */
	getSession(uri: URI): SessionState | undefined {
		return this.sessions.get(uri);
	}

	/** All tracked session URIs. */
	get sessionUris(): URI[] {
		return [...this.sessions.keys()];
	}

	/** Get a terminal state by URI. */
	getTerminal(uri: URI): TerminalState | undefined {
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
	applySnapshot(snapshot: Snapshot): void {
		if (snapshot.fromSeq > this.serverSeq) {
			this.serverSeq = snapshot.fromSeq;
		}

		// Determine if it's root or session state
		if ("agents" in snapshot.state) {
			this.rootState = snapshot.state as RootState;
		} else if ("summary" in snapshot.state) {
			const sessionState = snapshot.state as SessionState;
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
							this.sessions.set(snapshot.resource, sessionReducer(current, env.action as SessionAction));
						}
					}
				}
			}
		} else if ("claim" in snapshot.state) {
			const terminalState = snapshot.state as TerminalState;
			this.terminals.set(snapshot.resource, terminalState);

			// Replay any buffered terminal actions
			const buffered = this.pendingActions.get(snapshot.resource);
			if (buffered) {
				this.pendingActions.delete(snapshot.resource);
				for (const env of buffered) {
					if (env.serverSeq > snapshot.fromSeq) {
						const current = this.terminals.get(snapshot.resource);
						if (current) {
							this.terminals.set(snapshot.resource, terminalReducer(current, env.action as TerminalAction));
						}
					}
				}
			}
		}
	}

	/**
	 * Apply an incoming action envelope from the server.
	 */
	applyAction(envelope: ActionEnvelope): void {
		this.serverSeq = envelope.serverSeq;

		const action = envelope.action;
		const channel = envelope.channel;

		if (ROOT_ACTION_TYPES.has(action.type)) {
			this.rootState = rootReducer(this.rootState, action as RootAction);
		} else if (action.type.startsWith(TERMINAL_ACTION_PREFIX)) {
			const terminalAction = action as TerminalAction;
			if (channel) {
				const current = this.terminals.get(channel);
				if (current) {
					this.terminals.set(channel, terminalReducer(current, terminalAction));
				} else {
					// Terminal not yet registered — buffer for replay after applySnapshot
					let buffer = this.pendingActions.get(channel);
					if (!buffer) {
						buffer = [];
						this.pendingActions.set(channel, buffer);
					}
					buffer.push(envelope);
				}
			}
		} else {
			// Session action — route by channel URI
			if (channel) {
				const current = this.sessions.get(channel);
				if (current) {
					this.sessions.set(channel, sessionReducer(current, action as SessionAction));
				} else {
					// Session not yet registered — buffer for replay after applySnapshot
					let buffer = this.pendingActions.get(channel);
					if (!buffer) {
						buffer = [];
						this.pendingActions.set(channel, buffer);
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
