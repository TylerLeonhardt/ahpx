/**
 * TurnController — Orchestrates a single turn (prompt → response).
 *
 * Sends a user message, listens for incoming actions on the session,
 * routes them to the renderer and permission handler, and resolves
 * when the turn completes, errors, or is cancelled.
 */

import { randomUUID } from "node:crypto";
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
import {
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
} from "@microsoft/agent-host-protocol";
import { MessageKind } from "@microsoft/agent-host-protocol";
import type { MessageAttachment, URI, UsageInfo } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "../client/index.js";
import { textFromResponseParts } from "../client/response-text.js";
import type { OutputFormatter } from "../output/format.js";
import type { ToolCallInfo } from "../output/renderer.js";
import type { PermissionHandler } from "../permissions/handler.js";

export interface TurnResult {
	turnId: string;
	responseText: string;
	toolCalls: number;
	usage?: { inputTokens: number; outputTokens: number; model?: string };
	state: "complete" | "cancelled" | "error" | "idle_timeout";
	error?: string;
}

/**
 * Orchestrates a single prompt → response turn against an AHP session.
 */
export class TurnController {
	private activeTurnId: string | undefined;
	private cancelled = false;

	constructor(
		private readonly client: AhpClient,
		private readonly sessionUri: URI,
		private readonly renderer: OutputFormatter,
		private readonly permissionHandler: PermissionHandler,
		/**
		 * Channel that carries this session's chat (turn) actions. As of protocol
		 * 0.5.0 a session's default chat MAY live on a distinct `ahp-chat://`
		 * channel rather than sharing the session URI. Defaults to the session URI
		 * for hosts that keep the one-session/one-chat model on a single URI.
		 */
		private readonly chatUri: URI = sessionUri,
		/**
		 * Model to attach to each turn's message. As of protocol 0.5.0 the model is
		 * selected per-message via `Message.model`; omit to use the host default.
		 */
		private readonly model?: string,
	) {}

	/** The currently active turn ID, if any. */
	get turnId(): string | undefined {
		return this.activeTurnId;
	}

	/**
	 * Send a message and stream the full response.
	 */
	async prompt(
		text: string,
		attachments?: MessageAttachment[],
		options?: { idleTimeout?: number },
	): Promise<TurnResult> {
		const turnId = randomUUID();
		this.activeTurnId = turnId;
		this.cancelled = false;

		let responseText = "";
		let toolCallCount = 0;
		let usage: UsageInfo | undefined;

		return new Promise<TurnResult>((resolve) => {
			let idleTimer: ReturnType<typeof setTimeout> | undefined;

			const resetIdleTimer = () => {
				if (idleTimer !== undefined) clearTimeout(idleTimer);
				if (options?.idleTimeout) {
					idleTimer = setTimeout(() => {
						cleanup();
						this.renderer.onTurnCancelled();
						resolve({
							turnId,
							responseText,
							toolCalls: toolCallCount,
							usage: usage
								? {
										inputTokens: usage.inputTokens ?? 0,
										outputTokens: usage.outputTokens ?? 0,
										model: usage.model,
									}
								: undefined,
							state: "idle_timeout",
						});
					}, options.idleTimeout);
				}
			};

			const onAction = (envelope: ActionEnvelope) => {
				const action = envelope.action;

				// Only handle actions for our session or its chat channel.
				if (envelope.channel !== this.sessionUri && envelope.channel !== this.chatUri) {
					return;
				}

				// Only handle actions for our turn (where turnId is present)
				if ("turnId" in action && (action as { turnId: string }).turnId !== turnId) {
					return;
				}

				resetIdleTimer();

				switch (action.type) {
					case ActionType.ChatDelta: {
						const a = action as ChatDeltaAction;
						// Prefer the authoritative text assembled in chat state: it includes
						// any first delta(s) the host folded into the subscribe snapshot
						// instead of emitting as chat/delta actions. The state mirror is
						// updated before this listener runs, so emit only the not-yet-shown
						// remainder — this recovers a folded prefix in stream order (e.g.
						// "BANANA" rather than "ANANA"). Falls back to the raw delta content
						// when state is unavailable or has diverged from the stream.
						const authoritative = this.responseTextFromState(turnId);
						if (authoritative.length > 0 && authoritative.startsWith(responseText)) {
							const chunk = authoritative.slice(responseText.length);
							if (chunk) {
								responseText = authoritative;
								this.renderer.onDelta(chunk);
							}
						} else {
							responseText += a.content;
							this.renderer.onDelta(a.content);
						}
						break;
					}

					case ActionType.ChatReasoning: {
						const a = action as ChatReasoningAction;
						this.renderer.onReasoning(a.content);
						break;
					}

					case ActionType.ChatToolCallStart: {
						const a = action as ChatToolCallStartAction;
						toolCallCount++;
						this.renderer.onToolCallStart(a.toolCallId, a.displayName);
						break;
					}

					case ActionType.ChatToolCallDelta: {
						const a = action as ChatToolCallDeltaAction;
						this.renderer.onToolCallDelta(a.toolCallId, a.content);
						break;
					}

					case ActionType.ChatToolCallReady: {
						const a = action as ChatToolCallReadyAction;
						const serverConfirmed = !!a.confirmed;

						// Look up tool call from chat state (for contributor and display info)
						let toolClientId: string | undefined;
						let stateName: string | undefined;
						let stateDisplayName: string | undefined;

						const chat = this.client.state.getChat(this.chatUri);
						if (chat?.activeTurn) {
							for (const part of chat.activeTurn.responseParts) {
								if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === a.toolCallId) {
									const contributor = part.toolCall.contributor;
									toolClientId = contributor && "clientId" in contributor ? contributor.clientId : undefined;
									stateName = part.toolCall.toolName;
									stateDisplayName = part.toolCall.displayName;
									break;
								}
							}
						}

						if (serverConfirmed) {
							// Client-provided tool: the owning client handles execution directly,
							// so skip confirmation entirely (correct per AHP spec).
							const isClientTool = toolClientId !== undefined && toolClientId === this.client.clientId;
							if (isClientTool) {
								break;
							}
						}

						// Look up tool annotations from serverTools
						const toolName = stateName ?? a.toolCallId;

						const callInfo: ToolCallInfo = {
							toolCallId: a.toolCallId,
							toolName,
							displayName: stateDisplayName ?? a.toolCallId,
							invocationMessage: a.invocationMessage,
							toolInput: a.toolInput,
						};

						this.renderer.onToolCallReady(a.toolCallId, callInfo);

						if (serverConfirmed) {
							// Server already confirmed — show auto-approved, skip user prompt
							this.renderer.onToolCallAutoApproved(a.toolCallId);
							break;
						}

						// Only prompt user when server didn't auto-approve
						this.permissionHandler.handleToolConfirmation(callInfo).then((approved) => {
							if (this.cancelled) return;

							if (approved) {
								this.client.dispatchAction(this.chatUri, {
									type: ActionType.ChatToolCallConfirmed,
									turnId,
									toolCallId: a.toolCallId,
									approved: true,
									confirmed: ToolCallConfirmationReason.UserAction,
								});
							} else {
								this.client.dispatchAction(this.chatUri, {
									type: ActionType.ChatToolCallConfirmed,
									turnId,
									toolCallId: a.toolCallId,
									approved: false,
									reason: ToolCallCancellationReason.Denied,
								});
							}
						});
						break;
					}

					case ActionType.ChatToolCallComplete: {
						const a = action as ChatToolCallCompleteAction;
						this.renderer.onToolCallComplete(a.toolCallId, a.result);
						break;
					}

					case ActionType.ChatUsage: {
						const a = action as ChatUsageAction;
						usage = a.usage;
						this.renderer.onUsage(a.usage);
						break;
					}

					case ActionType.SessionTitleChanged: {
						const a = action as SessionTitleChangedAction;
						this.renderer.onTitleChanged(a.title);
						break;
					}

					case ActionType.ChatTurnComplete: {
						cleanup();
						// Prefer the authoritative response text from chat state — deltas
						// folded into a subscribe snapshot never arrive as chat/delta
						// actions, so the accumulated stream can be missing the first
						// chunk(s). Fall back to the streamed text if state is empty.
						const stateText = this.responseTextFromState(turnId);
						if (stateText) responseText = stateText;
						this.renderer.onTurnComplete(responseText);
						resolve({
							turnId,
							responseText,
							toolCalls: toolCallCount,
							usage: usage
								? {
										inputTokens: usage.inputTokens ?? 0,
										outputTokens: usage.outputTokens ?? 0,
										model: usage.model,
									}
								: undefined,
							state: "complete",
						});
						break;
					}

					case ActionType.ChatError: {
						const a = action as ChatErrorAction;
						cleanup();
						this.renderer.onTurnError(a.error);
						resolve({
							turnId,
							responseText,
							toolCalls: toolCallCount,
							usage: usage
								? {
										inputTokens: usage.inputTokens ?? 0,
										outputTokens: usage.outputTokens ?? 0,
										model: usage.model,
									}
								: undefined,
							state: "error",
							error: a.error.message,
						});
						break;
					}

					case ActionType.ChatTurnCancelled: {
						cleanup();
						this.renderer.onTurnCancelled();
						resolve({
							turnId,
							responseText,
							toolCalls: toolCallCount,
							usage: usage
								? {
										inputTokens: usage.inputTokens ?? 0,
										outputTokens: usage.outputTokens ?? 0,
										model: usage.model,
									}
								: undefined,
							state: "cancelled",
						});
						break;
					}

					default:
						// Ignore other action types (session/ready, model changes, etc.)
						break;
				}
			};

			const cleanup = () => {
				if (idleTimer !== undefined) clearTimeout(idleTimer);
				this.client.removeListener("action", onAction);
				this.activeTurnId = undefined;
			};

			// Listen for actions
			this.client.on("action", onAction);

			// Dispatch turn start
			this.client.dispatchAction(this.chatUri, {
				type: ActionType.ChatTurnStarted,
				turnId,
				message: {
					text,
					origin: { kind: MessageKind.User },
					...(this.model ? { model: { id: this.model } } : {}),
					...(attachments && attachments.length > 0 ? { attachments } : {}),
				},
			});

			// Start idle timer after dispatching turn
			resetIdleTimer();
		});
	}

	/**
	 * Cancel the active turn.
	 */
	async cancel(): Promise<void> {
		if (!this.activeTurnId) return;
		this.cancelled = true;
		this.client.dispatchAction(this.chatUri, {
			type: ActionType.ChatTurnCancelled,
			turnId: this.activeTurnId,
		});
	}

	/**
	 * Read the authoritative response text for a turn from the chat state. The
	 * completed turn is normally in `chat.turns`; fall back to `activeTurn` in
	 * case completion ordering differs.
	 */
	private responseTextFromState(turnId: string): string {
		const chat = this.client.state.getChat(this.chatUri);
		if (!chat) return "";
		const turn =
			chat.turns.find((t) => t.id === turnId) ?? (chat.activeTurn?.id === turnId ? chat.activeTurn : undefined);
		return textFromResponseParts(turn?.responseParts);
	}
}
