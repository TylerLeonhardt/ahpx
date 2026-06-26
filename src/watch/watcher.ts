/**
 * SessionWatcher — Attaches to an existing session as an observer.
 *
 * Subscribes to a session URI and streams all incoming actions through
 * an OutputFormatter in real-time. Handles mid-turn join (shows current
 * streaming state) and clean exit on session dispose or SIGINT.
 */

import type { ActionEnvelope } from "@microsoft/agent-host-protocol";
import { ActionType } from "@microsoft/agent-host-protocol";
import type {
	ChatDeltaAction,
	ChatErrorAction,
	ChatReasoningAction,
	ChatToolCallCompleteAction,
	ChatToolCallDeltaAction,
	ChatToolCallReadyAction,
	ChatToolCallStartAction,
	ChatUsageAction,
	SessionTitleChangedAction,
} from "@microsoft/agent-host-protocol";
import type { ChatState, URI } from "@microsoft/agent-host-protocol";
import { ResponsePartKind, ToolCallStatus } from "@microsoft/agent-host-protocol";
import pc from "picocolors";
import type { AhpClient } from "../client/index.js";
import type { OutputFormatter } from "../output/format.js";
import type { ToolCallInfo } from "../output/renderer.js";

/** Writable stream interface for status output. */
export interface StatusOutput {
	write(data: string): void;
}

export interface SessionWatcherOptions {
	/** Stream for status messages (default: process.stderr) */
	statusOut?: StatusOutput;
}

/**
 * Watches an existing AHP session, streaming all activity to a formatter.
 */
export class SessionWatcher {
	private onAction: ((envelope: ActionEnvelope) => void) | undefined;
	private onDisconnect: (() => void) | undefined;
	private stopped = false;
	private resolveWatch: (() => void) | undefined;
	private readonly statusOut: StatusOutput;

	constructor(
		private readonly client: AhpClient,
		private readonly sessionUri: URI,
		private readonly formatter: OutputFormatter,
		options: SessionWatcherOptions = {},
	) {
		this.statusOut = options.statusOut ?? process.stderr;
	}

	/**
	 * Start watching — subscribes to the session and streams all actions.
	 * Resolves when `stop()` is called or the session is disposed.
	 *
	 * Listeners are registered synchronously so callers can emit events
	 * immediately after calling watch() without a microtask gap.
	 */
	async watch(): Promise<void> {
		this.stopped = false;

		// Register listeners synchronously (before any async work) so that
		// events emitted right after watch() are never lost.
		const finished = new Promise<void>((resolve) => {
			this.resolveWatch = resolve;

			this.onAction = (envelope: ActionEnvelope) => {
				if (this.stopped) return;
				this.handleAction(envelope);
			};

			this.client.on("action", this.onAction);

			this.onDisconnect = () => {
				this.cleanup();
				resolve();
			};
			this.client.once("disconnected", this.onDisconnect);
		});

		try {
			// Subscribe to the session (gets current state snapshot)
			await this.client.subscribe(this.sessionUri);
			const sessionState = this.client.state.getSession(this.sessionUri);

			if (!sessionState) {
				this.cleanup();
				throw new Error(`Session ${this.sessionUri} not found after subscribe`);
			}

			// Show current state if there's an active turn (turns live on the chat)
			this.showCurrentState(this.client.state.getChat(this.sessionUri));
		} catch (err) {
			this.cleanup();
			throw err;
		}

		return finished;
	}

	/**
	 * Stop watching and clean up listeners.
	 */
	stop(): void {
		this.cleanup();
	}

	/**
	 * Show the current in-progress state when joining mid-turn.
	 */
	private showCurrentState(state: ChatState | undefined): void {
		const turn = state?.activeTurn;
		if (!turn) return;

		this.statusOut.write(pc.dim("[watch] Joining turn in progress...\n"));

		// Walk response parts to reconstruct current state
		for (const part of turn.responseParts) {
			switch (part.kind) {
				case ResponsePartKind.Markdown:
					if (part.content) {
						this.formatter.onDelta(part.content);
					}
					break;
				case ResponsePartKind.Reasoning:
					if (part.content) {
						this.formatter.onReasoning(part.content);
					}
					break;
				case ResponsePartKind.ToolCall: {
					const tc = part.toolCall;
					if (tc.status === ToolCallStatus.Streaming || tc.status === ToolCallStatus.Running) {
						this.formatter.onToolCallStart(tc.toolCallId, tc.displayName);
					} else if (tc.status === ToolCallStatus.PendingConfirmation) {
						const info: ToolCallInfo = {
							toolCallId: tc.toolCallId,
							toolName: tc.toolName,
							displayName: tc.displayName,
							invocationMessage: tc.invocationMessage,
							toolInput: tc.toolInput,
						};
						this.formatter.onToolCallReady(tc.toolCallId, info);
					} else if (tc.status === ToolCallStatus.Completed) {
						this.formatter.onToolCallComplete(tc.toolCallId, {
							success: tc.success,
							pastTenseMessage: tc.pastTenseMessage,
							content: tc.content,
						});
					}
					break;
				}
			}
		}
	}

	/**
	 * Route an incoming action to the formatter.
	 */
	private handleAction(envelope: ActionEnvelope): void {
		const action = envelope.action;
		// Only handle actions for our session
		if (envelope.channel !== this.sessionUri) {
			return;
		}

		switch (action.type) {
			case ActionType.ChatDelta: {
				const a = action as ChatDeltaAction;
				this.formatter.onDelta(a.content);
				break;
			}

			case ActionType.ChatReasoning: {
				const a = action as ChatReasoningAction;
				this.formatter.onReasoning(a.content);
				break;
			}

			case ActionType.ChatTurnStarted: {
				// Show who started the turn
				const origin = this.getOriginLabel(envelope);
				this.statusOut.write(pc.dim(`[watch] Turn started${origin}\n`));
				break;
			}

			case ActionType.ChatToolCallStart: {
				const a = action as ChatToolCallStartAction;
				this.formatter.onToolCallStart(a.toolCallId, a.displayName);
				break;
			}

			case ActionType.ChatToolCallDelta: {
				const a = action as ChatToolCallDeltaAction;
				this.formatter.onToolCallDelta(a.toolCallId, a.content);
				break;
			}

			case ActionType.ChatToolCallReady: {
				const a = action as ChatToolCallReadyAction;
				const info: ToolCallInfo = {
					toolCallId: a.toolCallId,
					toolName: a.toolCallId,
					displayName: a.toolCallId,
					invocationMessage: a.invocationMessage,
					toolInput: a.toolInput,
				};

				// Try to get actual names from state
				const chat = this.client.state.getChat(this.sessionUri);
				if (chat?.activeTurn) {
					for (const part of chat.activeTurn.responseParts) {
						if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === a.toolCallId) {
							info.toolName = part.toolCall.toolName;
							info.displayName = part.toolCall.displayName;
							break;
						}
					}
				}

				this.formatter.onToolCallReady(a.toolCallId, info);
				break;
			}

			case ActionType.ChatToolCallComplete: {
				const a = action as ChatToolCallCompleteAction;
				this.formatter.onToolCallComplete(a.toolCallId, a.result);
				break;
			}

			case ActionType.ChatUsage: {
				const a = action as ChatUsageAction;
				this.formatter.onUsage(a.usage);
				break;
			}

			case ActionType.SessionTitleChanged: {
				const a = action as SessionTitleChangedAction;
				this.formatter.onTitleChanged(a.title);
				break;
			}

			case ActionType.ChatTurnComplete: {
				const chat = this.client.state.getChat(this.sessionUri);
				const lastTurn = chat?.turns[chat.turns.length - 1];
				// Derive response text from markdown response parts
				let responseText = "";
				if (lastTurn) {
					for (const p of lastTurn.responseParts) {
						if (p.kind === ResponsePartKind.Markdown) {
							responseText += p.content;
						}
					}
				}
				this.formatter.onTurnComplete(responseText);
				break;
			}

			case ActionType.ChatError: {
				const a = action as ChatErrorAction;
				this.formatter.onTurnError(a.error);
				break;
			}

			case ActionType.ChatTurnCancelled: {
				this.formatter.onTurnCancelled();
				break;
			}

			default:
				// Ignore root actions, model changes, etc. in watch mode
				break;
		}
	}

	/**
	 * Get a label describing who started the turn (if from another client).
	 */
	private getOriginLabel(envelope: ActionEnvelope): string {
		if (envelope.origin) {
			return ` (from ${envelope.origin.clientId})`;
		}
		return "";
	}

	/**
	 * Clean up listeners and resolve the watch promise.
	 */
	private cleanup(): void {
		if (this.stopped) return;
		this.stopped = true;

		if (this.onAction) {
			this.client.removeListener("action", this.onAction);
			this.onAction = undefined;
		}

		if (this.onDisconnect) {
			this.client.removeListener("disconnected", this.onDisconnect);
			this.onDisconnect = undefined;
		}

		if (this.resolveWatch) {
			this.resolveWatch();
			this.resolveWatch = undefined;
		}
	}
}
