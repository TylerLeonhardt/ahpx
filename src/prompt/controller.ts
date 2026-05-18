/**
 * TurnController — Orchestrates a single turn (prompt → response).
 *
 * Sends a user message, listens for incoming actions on the session,
 * routes them to the renderer and permission handler, and resolves
 * when the turn completes, errors, or is cancelled.
 */

import { randomUUID } from "node:crypto";
import type { AhpClient } from "../client/index.js";
import type { OutputFormatter } from "../output/format.js";
import type { ToolCallInfo } from "../output/renderer.js";
import type { PermissionHandler } from "../permissions/handler.js";
import type { ActionEnvelope } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import type {
	SessionDeltaAction,
	SessionErrorAction,
	SessionReasoningAction,
	SessionTitleChangedAction,
	SessionToolCallCompleteAction,
	SessionToolCallDeltaAction,
	SessionToolCallReadyAction,
	SessionToolCallStartAction,
	SessionUsageAction,
} from "../protocol/actions.js";
import { ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason } from "../protocol/state.js";
import type { MessageAttachment, URI, UsageInfo } from "../protocol/state.js";

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

				// Only handle actions for our session
				if (!("session" in action) || (action as { session: URI }).session !== this.sessionUri) {
					return;
				}

				// Only handle actions for our turn (where turnId is present)
				if ("turnId" in action && (action as { turnId: string }).turnId !== turnId) {
					return;
				}

				resetIdleTimer();

				switch (action.type) {
					case ActionType.SessionDelta: {
						const a = action as SessionDeltaAction;
						responseText += a.content;
						this.renderer.onDelta(a.content);
						break;
					}

					case ActionType.SessionReasoning: {
						const a = action as SessionReasoningAction;
						this.renderer.onReasoning(a.content);
						break;
					}

					case ActionType.SessionToolCallStart: {
						const a = action as SessionToolCallStartAction;
						toolCallCount++;
						this.renderer.onToolCallStart(a.toolCallId, a.displayName);
						break;
					}

					case ActionType.SessionToolCallDelta: {
						const a = action as SessionToolCallDeltaAction;
						this.renderer.onToolCallDelta(a.toolCallId, a.content);
						break;
					}

					case ActionType.SessionToolCallReady: {
						const a = action as SessionToolCallReadyAction;
						const serverConfirmed = !!a.confirmed;

						// Look up tool call from session state (for toolClientId and display info)
						let toolClientId: string | undefined;
						let stateName: string | undefined;
						let stateDisplayName: string | undefined;

						const session = this.client.state.getSession(this.sessionUri);
						if (session?.activeTurn) {
							for (const part of session.activeTurn.responseParts) {
								if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === a.toolCallId) {
									toolClientId = part.toolCall.toolClientId;
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
							// Server tool: fall through to consult the user's permission mode.
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

						// Handle confirmation asynchronously
						this.permissionHandler.handleToolConfirmation(callInfo).then((approved) => {
							if (this.cancelled) return;

							if (serverConfirmed && approved) {
								// Server already confirmed and user approves — nothing to dispatch.
								return;
							}

							if (approved) {
								this.client.dispatchAction({
									type: ActionType.SessionToolCallConfirmed,
									session: this.sessionUri,
									turnId,
									toolCallId: a.toolCallId,
									approved: true,
									confirmed: ToolCallConfirmationReason.UserAction,
								});
							} else {
								this.client.dispatchAction({
									type: ActionType.SessionToolCallConfirmed,
									session: this.sessionUri,
									turnId,
									toolCallId: a.toolCallId,
									approved: false,
									reason: ToolCallCancellationReason.Denied,
								});
							}
						});
						break;
					}

					case ActionType.SessionToolCallComplete: {
						const a = action as SessionToolCallCompleteAction;
						this.renderer.onToolCallComplete(a.toolCallId, a.result);
						break;
					}

					case ActionType.SessionUsage: {
						const a = action as SessionUsageAction;
						usage = a.usage;
						this.renderer.onUsage(a.usage);
						break;
					}

					case ActionType.SessionTitleChanged: {
						const a = action as SessionTitleChangedAction;
						this.renderer.onTitleChanged(a.title);
						break;
					}

					case ActionType.SessionTurnComplete: {
						cleanup();
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

					case ActionType.SessionError: {
						const a = action as SessionErrorAction;
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

					case ActionType.SessionTurnCancelled: {
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
			this.client.dispatchAction({
				type: ActionType.SessionTurnStarted,
				session: this.sessionUri,
				turnId,
				userMessage: {
					text,
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
		this.client.dispatchAction({
			type: ActionType.SessionTurnCancelled,
			session: this.sessionUri,
			turnId: this.activeTurnId,
		});
	}
}
