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
import type { IActionEnvelope } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import type {
	ISessionDeltaAction,
	ISessionErrorAction,
	ISessionPermissionRequestAction,
	ISessionReasoningAction,
	ISessionTitleChangedAction,
	ISessionToolCallCompleteAction,
	ISessionToolCallDeltaAction,
	ISessionToolCallReadyAction,
	ISessionToolCallStartAction,
	ISessionUsageAction,
} from "../protocol/actions.js";
import { ToolCallCancellationReason, ToolCallConfirmationReason } from "../protocol/state.js";
import type { IMessageAttachment, IUsageInfo, URI } from "../protocol/state.js";

export interface TurnResult {
	turnId: string;
	responseText: string;
	toolCalls: number;
	usage?: { inputTokens: number; outputTokens: number; model?: string };
	state: "complete" | "cancelled" | "error";
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
	async prompt(text: string, attachments?: IMessageAttachment[]): Promise<TurnResult> {
		const turnId = randomUUID();
		this.activeTurnId = turnId;
		this.cancelled = false;

		let responseText = "";
		let toolCallCount = 0;
		let usage: IUsageInfo | undefined;

		return new Promise<TurnResult>((resolve) => {
			const onAction = (envelope: IActionEnvelope) => {
				const action = envelope.action;

				// Only handle actions for our session
				if (!("session" in action) || (action as { session: URI }).session !== this.sessionUri) {
					return;
				}

				// Only handle actions for our turn (where turnId is present)
				if ("turnId" in action && (action as { turnId: string }).turnId !== turnId) {
					return;
				}

				switch (action.type) {
					case ActionType.SessionDelta: {
						const a = action as ISessionDeltaAction;
						responseText += a.content;
						this.renderer.onDelta(a.content);
						break;
					}

					case ActionType.SessionReasoning: {
						const a = action as ISessionReasoningAction;
						this.renderer.onReasoning(a.content);
						break;
					}

					case ActionType.SessionToolCallStart: {
						const a = action as ISessionToolCallStartAction;
						toolCallCount++;
						this.renderer.onToolCallStart(a.toolCallId, a.displayName);
						break;
					}

					case ActionType.SessionToolCallDelta: {
						const a = action as ISessionToolCallDeltaAction;
						this.renderer.onToolCallDelta(a.toolCallId, a.content);
						break;
					}

					case ActionType.SessionToolCallReady: {
						const a = action as ISessionToolCallReadyAction;
						// If already auto-confirmed by the server, no need to prompt
						if (a.confirmed) {
							break;
						}
						const callInfo: ToolCallInfo = {
							toolCallId: a.toolCallId,
							toolName: a.toolCallId, // toolName is on the start action
							displayName: a.toolCallId,
							invocationMessage: a.invocationMessage,
							toolInput: a.toolInput,
						};

						// Look up the actual tool name from state mirror
						const session = this.client.state.getSession(this.sessionUri);
						if (session?.activeTurn?.toolCalls[a.toolCallId]) {
							const tc = session.activeTurn.toolCalls[a.toolCallId];
							callInfo.toolName = tc.toolName;
							callInfo.displayName = tc.displayName;
						}

						this.renderer.onToolCallReady(a.toolCallId, callInfo);

						// Handle confirmation asynchronously
						this.permissionHandler.handleToolConfirmation(callInfo).then((approved) => {
							if (this.cancelled) return;
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
						const a = action as ISessionToolCallCompleteAction;
						this.renderer.onToolCallComplete(a.toolCallId, a.result);
						break;
					}

					case ActionType.SessionPermissionRequest: {
						const a = action as ISessionPermissionRequestAction;
						this.renderer.onPermissionRequest(a.request);

						// Handle permission asynchronously
						this.permissionHandler.handlePermission(a.request).then((approved) => {
							if (this.cancelled) return;
							this.client.dispatchAction({
								type: ActionType.SessionPermissionResolved,
								session: this.sessionUri,
								turnId,
								requestId: a.request.requestId,
								approved,
							});
						});
						break;
					}

					case ActionType.SessionUsage: {
						const a = action as ISessionUsageAction;
						usage = a.usage;
						this.renderer.onUsage(a.usage);
						break;
					}

					case ActionType.SessionTitleChanged: {
						const a = action as ISessionTitleChangedAction;
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
						const a = action as ISessionErrorAction;
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
