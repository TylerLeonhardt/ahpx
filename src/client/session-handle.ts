/**
 * SessionHandle — Convenience wrapper for a single session on an AhpClient.
 *
 * Filters events by session URI, provides a cleaner API for sending prompts,
 * cancelling turns, and accessing session state. Library consumers work with
 * SessionHandle instead of raw `client.dispatchAction()` calls.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ActionEnvelope, StateAction } from "@microsoft/agent-host-protocol";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { ChatDeltaAction, ChatErrorAction, ChatUsageAction } from "@microsoft/agent-host-protocol";
import type {
	ActiveTurn,
	ChatState,
	MessageAttachment,
	SessionState,
	Turn,
	URI,
	UsageInfo,
} from "@microsoft/agent-host-protocol";
import { MessageKind, SessionLifecycle } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "./index.js";

/** Options for sending a prompt via SessionHandle. */
export interface PromptOptions {
	/** File or directory attachments to include with the message. */
	attachments?: MessageAttachment[];
	/** Timeout in ms for the entire turn (default: none). */
	timeout?: number;
}

/** Result of a completed turn. */
export interface TurnResult {
	turnId: string;
	responseText: string;
	toolCalls: number;
	usage?: { inputTokens: number; outputTokens: number; model?: string };
	state: "complete" | "cancelled" | "error";
	error?: string;
}

/** Events emitted by SessionHandle, scoped to a single session. */
export interface SessionHandleEvents {
	/** Any action for this session. */
	action: [envelope: ActionEnvelope];
	/** A turn completed successfully. */
	turnComplete: [turn: Turn];
	/** An error occurred on this session. */
	error: [error: Error];
	/** Session was disposed. */
	disposed: [];
}

/**
 * A handle to a single session on an AhpClient.
 *
 * Provides a session-scoped view: events are filtered to only this session,
 * state accessors read from the client's state mirror, and action dispatch
 * auto-injects the session URI.
 */
export class SessionHandle extends EventEmitter<SessionHandleEvents> {
	readonly uri: URI;
	readonly provider: string;
	readonly model?: string;
	readonly provisional: boolean;

	private _disposed = false;
	private _activeTurnId: string | undefined;
	private readonly _onAction: (envelope: ActionEnvelope) => void;
	private readonly _onDisconnect: (code: number, reason: string) => void;

	constructor(
		private readonly client: AhpClient,
		uri: URI,
		provider: string,
		model?: string,
		provisional = false,
	) {
		super();
		this.uri = uri;
		this.provider = provider;
		this.model = model;
		this.provisional = provisional;

		// Filter client actions to only this session's events
		this._onAction = (envelope: ActionEnvelope) => {
			if (envelope.channel !== this.uri) {
				return;
			}
			const action = envelope.action;
			this.emit("action", envelope);

			// Emit higher-level events
			if (action.type === ActionType.ChatTurnComplete) {
				const chat = this.chat;
				if (chat && chat.turns.length > 0) {
					this.emit("turnComplete", chat.turns[chat.turns.length - 1]);
				}
			} else if (action.type === ActionType.ChatError) {
				const a = action as ChatErrorAction;
				this.emit("error", new Error(a.error.message));
			}
		};

		this._onDisconnect = (_code: number, reason: string) => {
			this.emit("error", new Error(`Connection lost: ${reason}`));
		};

		this.client.on("action", this._onAction);
		this.client.on("disconnected", this._onDisconnect);
	}

	// ── State accessors ────────────────────────────────────────────────────

	/** Current session state from the state mirror. */
	get state(): SessionState | undefined {
		return this.client.state.getSession(this.uri);
	}

	/** Current chat state (turns / activeTurn) from the state mirror. */
	get chat(): ChatState | undefined {
		return this.client.state.getChat(this.uri);
	}

	/** Whether the session is ready for prompts. */
	get isReady(): boolean {
		return this.state?.lifecycle === SessionLifecycle.Ready;
	}

	/** The currently active turn, if any. */
	get activeTurn(): ActiveTurn | undefined {
		return this.chat?.activeTurn;
	}

	/** Whether this handle has been disposed. */
	get disposed(): boolean {
		return this._disposed;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Wait for the session to reach the "ready" lifecycle state.
	 *
	 * Resolves immediately if already ready. Rejects on creation failure
	 * or timeout.
	 */
	async waitForReady(timeout = 30_000): Promise<void> {
		this.ensureNotDisposed();

		// Provisional sessions are valid immediately — they stay in "creating"
		// until the first prompt triggers materialization.
		if (this.provisional) return;

		// Already ready?
		if (this.isReady) return;

		// Already failed?
		const current = this.state;
		if (current?.lifecycle === SessionLifecycle.CreationFailed) {
			throw new Error(`Session creation failed: ${current.creationError?.message ?? "Unknown error"}`);
		}

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for session to be ready (${timeout}ms)`));
			}, timeout);

			const onAction = (envelope: ActionEnvelope) => {
				const action = envelope.action;
				if (action.type === ActionType.SessionReady) {
					cleanup();
					resolve();
				} else if (action.type === ActionType.SessionCreationFailed) {
					cleanup();
					const session = this.state;
					reject(new Error(`Session creation failed: ${session?.creationError?.message ?? "Unknown error"}`));
				}
			};

			const cleanup = () => {
				clearTimeout(timer);
				this.removeListener("action", onAction);
			};

			this.on("action", onAction);
		});
	}

	/**
	 * Dispose this session handle and clean up server-side resources.
	 */
	async dispose(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;

		// Remove listeners from parent client
		this.client.removeListener("action", this._onAction);
		this.client.removeListener("disconnected", this._onDisconnect);

		// Dispose server-side session (only if still connected)
		if (this.client.connected) {
			try {
				await this.client.disposeSession(this.uri);
			} catch {
				// Best-effort — connection may be lost
			}
		}

		this.emit("disposed");
		this.removeAllListeners();
	}

	// ── Turns ──────────────────────────────────────────────────────────────

	/**
	 * Send a prompt and wait for the turn to complete.
	 *
	 * Returns a `TurnResult` when the turn finishes (complete, error, or cancelled).
	 * Tool call confirmations and permissions are NOT handled automatically —
	 * library consumers should listen to `handle.on('action', ...)` and use
	 * `handle.dispatchAction()` for tool/permission responses.
	 */
	async sendPrompt(text: string, options?: PromptOptions): Promise<TurnResult> {
		this.ensureNotDisposed();
		// Provisional sessions are usable — the first prompt triggers materialization.
		if (!this.isReady && !this.provisional) {
			throw new Error("Session is not ready");
		}
		if (this._activeTurnId) {
			throw new Error("A turn is already active");
		}

		const turnId = randomUUID();
		this._activeTurnId = turnId;

		let responseText = "";
		let toolCallCount = 0;
		let usage: UsageInfo | undefined;

		return new Promise<TurnResult>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;

			const onAction = (envelope: ActionEnvelope) => {
				const action = envelope.action;

				// Only handle actions for our turn (where turnId is present)
				if ("turnId" in action && (action as { turnId: string }).turnId !== turnId) {
					return;
				}

				switch (action.type) {
					case ActionType.ChatDelta: {
						const a = action as ChatDeltaAction;
						responseText += a.content;
						break;
					}

					case ActionType.ChatToolCallStart:
						toolCallCount++;
						break;

					case ActionType.ChatUsage: {
						const a = action as ChatUsageAction;
						usage = a.usage;
						break;
					}

					case ActionType.ChatTurnComplete: {
						finish("complete");
						break;
					}

					case ActionType.ChatError: {
						const a = action as ChatErrorAction;
						finish("error", a.error.message);
						break;
					}

					case ActionType.ChatTurnCancelled: {
						finish("cancelled");
						break;
					}
				}
			};

			const finish = (state: TurnResult["state"], error?: string) => {
				cleanup();
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
					state,
					error,
				});
			};

			const onError = (err: Error) => {
				finish("error", err.message);
			};

			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				this.removeListener("action", onAction);
				this.removeListener("error", onError);
				this._activeTurnId = undefined;
			};

			// Set up timeout — on timeout, cancel the turn on the server
			// and resolve immediately. The server-side turn may still complete
			// but the promise is already settled.
			if (options?.timeout) {
				timer = setTimeout(() => {
					// Send cancel to server so it stops processing
					this.cancelTurn().catch(() => {});
					cleanup();
					resolve({
						turnId,
						responseText,
						toolCalls: toolCallCount,
						state: "error",
						error: `Turn timed out after ${options.timeout}ms`,
					});
				}, options.timeout);
			}

			// Listen for session-scoped actions and connection errors
			this.on("action", onAction);
			this.on("error", onError);

			// Dispatch turn start
			this.client.dispatchAction(this.uri, {
				type: ActionType.ChatTurnStarted,
				turnId,
				message: {
					text,
					origin: { kind: MessageKind.User },
					...(this.model ? { model: { id: this.model } } : {}),
					...(options?.attachments && options.attachments.length > 0 ? { attachments: options.attachments } : {}),
				},
			});
		});
	}

	/**
	 * Cancel the currently active turn.
	 */
	async cancelTurn(): Promise<void> {
		this.ensureNotDisposed();
		if (!this._activeTurnId) return;

		this.client.dispatchAction(this.uri, {
			type: ActionType.ChatTurnCancelled,
			turnId: this._activeTurnId,
		});
	}

	// ── Action dispatch ────────────────────────────────────────────────────

	/**
	 * Dispatch a client action for this session.
	 *
	 * Automatically injects the session URI into the action. Use this for
	 * tool call confirmations, permission responses, model changes, etc.
	 */
	dispatchAction(action: Record<string, unknown> & { type: string }): void {
		this.ensureNotDisposed();
		this.client.dispatchAction(this.uri, action as StateAction);
	}

	private ensureNotDisposed(): void {
		if (this._disposed) {
			throw new Error("SessionHandle has been disposed");
		}
	}
}
