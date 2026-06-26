/**
 * Local state mirror — applies incoming actions through the AHP reducers.
 *
 * Maintains a client-side copy of root, session, chat, and terminal states,
 * kept in sync by applying action envelopes from the server.
 *
 * AHP 0.3+ splits a session's coordination state (`ahp-session:` channels) from
 * its conversation state (`ahp-chat:` channels). ahpx is a one-session /
 * one-chat CLI, so it models a session and its default chat as the **same**
 * channel URI: subscribing to the URI yields a `SessionState` snapshot, while
 * the streamed `chat/*` actions build the `ChatState` (turns / activeTurn) under
 * the same key. The two are tracked in separate maps and never collide.
 */

import type {
	ActionEnvelope,
	ChatAction,
	ChatState,
	RootAction,
	RootState,
	SessionAction,
	SessionState,
	SessionStatus,
	Snapshot,
	StateAction,
	TerminalAction,
	TerminalState,
	URI,
} from "@microsoft/agent-host-protocol";
import { ActionType, chatReducer, rootReducer, sessionReducer, terminalReducer } from "@microsoft/agent-host-protocol";

/** Root actions operate on the root state tree. */
const ROOT_ACTION_TYPES = new Set<string>([
	ActionType.RootAgentsChanged,
	ActionType.RootActiveSessionsChanged,
	ActionType.RootTerminalsChanged,
]);

/** Terminal actions have type starting with this prefix. */
const TERMINAL_ACTION_PREFIX = "terminal/";

/** Chat-channel actions (turns, streaming, tool calls) have this prefix. */
const CHAT_ACTION_PREFIX = "chat/";

/** Build a minimal initial `ChatState` so chat actions can be applied lazily. */
function emptyChatState(resource: URI): ChatState {
	return {
		resource,
		title: "",
		// `1` is `SessionStatus.Idle`; const enums aren't usable as values across
		// package boundaries, so the literal is used directly.
		status: 1 as SessionStatus,
		modifiedAt: "",
		turns: [],
	};
}

/**
 * Client-side state mirror that tracks root, session, chat, and terminal states
 * by applying incoming action envelopes through the protocol reducers.
 */
export class StateMirror {
	private rootState: RootState = { agents: [] };
	private sessions = new Map<URI, SessionState>();
	private chats = new Map<URI, ChatState>();
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

	/** Get a chat state (turns / activeTurn) by URI. */
	getChat(uri: URI): ChatState | undefined {
		return this.chats.get(uri);
	}

	/** All tracked chat URIs. */
	get chatUris(): URI[] {
		return [...this.chats.keys()];
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
	 * After registering a resource, replays any actions that arrived before it.
	 */
	applySnapshot(snapshot: Snapshot): void {
		if (snapshot.fromSeq > this.serverSeq) {
			this.serverSeq = snapshot.fromSeq;
		}

		const state = snapshot.state as unknown as Record<string, unknown>;

		// Determine the resource type from the snapshot shape.
		if ("agents" in state) {
			this.rootState = snapshot.state as RootState;
		} else if ("summary" in state) {
			this.sessions.set(snapshot.resource, snapshot.state as SessionState);
			this.replayBuffered(snapshot.resource, snapshot.fromSeq);
		} else if ("turns" in state) {
			this.chats.set(snapshot.resource, snapshot.state as ChatState);
			this.replayBuffered(snapshot.resource, snapshot.fromSeq);
		} else if ("claim" in state) {
			this.terminals.set(snapshot.resource, snapshot.state as TerminalState);
			this.replayBuffered(snapshot.resource, snapshot.fromSeq);
		}
	}

	/** Replay actions buffered for a resource before its snapshot arrived. */
	private replayBuffered(resource: URI, fromSeq: number): void {
		const buffered = this.pendingActions.get(resource);
		if (!buffered) return;
		this.pendingActions.delete(resource);
		for (const env of buffered) {
			if (env.serverSeq > fromSeq) {
				this.routeAction(resource, env.action);
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
			return;
		}

		if (channel) {
			this.routeAction(channel, action);
		}
	}

	/** Route a channel-scoped action to the correct reducer + state map. */
	private routeAction(channel: URI, action: StateAction): void {
		if (action.type.startsWith(TERMINAL_ACTION_PREFIX)) {
			const current = this.terminals.get(channel);
			if (current) {
				this.terminals.set(channel, terminalReducer(current, action as TerminalAction));
			} else {
				this.buffer(channel, action);
			}
			return;
		}

		if (action.type.startsWith(CHAT_ACTION_PREFIX)) {
			const current = this.chats.get(channel) ?? emptyChatState(channel);
			this.chats.set(channel, chatReducer(current, action as ChatAction));
			return;
		}

		// Session-scoped action.
		const current = this.sessions.get(channel);
		if (current) {
			this.sessions.set(channel, sessionReducer(current, action as SessionAction));
		} else {
			this.buffer(channel, action);
		}
	}

	/** Buffer an action whose target resource hasn't been snapshotted yet. */
	private buffer(channel: URI, action: StateAction): void {
		let list = this.pendingActions.get(channel);
		if (!list) {
			list = [];
			this.pendingActions.set(channel, list);
		}
		list.push({ channel, action, serverSeq: this.serverSeq, origin: undefined });
	}

	/**
	 * Remove a session (and its chat) from tracking.
	 */
	removeSession(uri: URI): void {
		this.sessions.delete(uri);
		this.chats.delete(uri);
		this.pendingActions.delete(uri);
	}
}
