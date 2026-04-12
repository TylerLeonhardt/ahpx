/**
 * SessionHandle — Convenience wrapper for a single session on an AhpClient.
 *
 * Filters events by session URI, provides a cleaner API for sending prompts,
 * cancelling turns, and accessing session state. Library consumers work with
 * SessionHandle instead of raw `client.dispatchAction()` calls.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IActionEnvelope, IStateAction } from "../protocol/actions.js";
import { ActionType } from "../protocol/actions.js";
import type { ISessionDeltaAction, ISessionErrorAction, ISessionUsageAction } from "../protocol/actions.js";
import type { IActiveTurn, IMessageAttachment, ISessionState, ITurn, IUsageInfo, URI } from "../protocol/state.js";
import { SessionLifecycle } from "../protocol/state.js";
import type { AhpClient } from "./index.js";

/** Options for sending a prompt via SessionHandle. */
export interface PromptOptions {
	/** File or directory attachments to include with the message. */
	attachments?: IMessageAttachment[];
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
	action: [envelope: IActionEnvelope];
	/** A turn completed successfully. */
	turnComplete: [turn: ITurn];
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

	private _disposed = false;
	private _activeTurnId: string | undefined;
	private readonly _onAction: (envelope: IActionEnvelope) => void;
	private readonly _onDisconnect: (code: number, reason: string) => void;

	constructor(
		private readonly client: AhpClient,
		uri: URI,
		provider: string,
		model?: string,
	) {
		super();
		this.uri = uri;
		this.provider = provider;
		this.model = model;

		// Filter client actions to only this session's events
		this._onAction = (envelope: IActionEnvelope) => {
			const action = envelope.action;
			if (!("session" in action) || (action as { session: URI }).session !== this.uri) {
				return;
			}
			this.emit("action", envelope);

			// Emit higher-level events
			if (action.type === ActionType.SessionTurnComplete) {
				const session = this.state;
				if (session && session.turns.length > 0) {
					this.emit("turnComplete", session.turns[session.turns.length - 1]);
				}
			} else if (action.type === ActionType.SessionError) {
				const a = action as ISessionErrorAction;
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
	get state(): ISessionState | undefined {
		return this.client.state.getSession(this.uri);
	}

	/** Whether the session is ready for prompts. */
	get isReady(): boolean {
		return this.state?.lifecycle === SessionLifecycle.Ready;
	}

	/** The currently active turn, if any. */
	get activeTurn(): IActiveTurn | undefined {
		return this.state?.activeTurn;
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

			const onAction = (envelope: IActionEnvelope) => {
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
		if (!this.isReady) {
			throw new Error("Session is not ready");
		}
		if (this._activeTurnId) {
			throw new Error("A turn is already active");
		}

		const turnId = randomUUID();
		this._activeTurnId = turnId;

		let responseText = "";
		let toolCallCount = 0;
		let usage: IUsageInfo | undefined;

		return new Promise<TurnResult>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;

			const onAction = (envelope: IActionEnvelope) => {
				const action = envelope.action;

				// Only handle actions for our turn (where turnId is present)
				if ("turnId" in action && (action as { turnId: string }).turnId !== turnId) {
					return;
				}

				switch (action.type) {
					case ActionType.SessionDelta: {
						const a = action as ISessionDeltaAction;
						responseText += a.content;
						break;
					}

					case ActionType.SessionToolCallStart:
						toolCallCount++;
						break;

					case ActionType.SessionUsage: {
						const a = action as ISessionUsageAction;
						usage = a.usage;
						break;
					}

					case ActionType.SessionTurnComplete: {
						finish("complete");
						break;
					}

					case ActionType.SessionError: {
						const a = action as ISessionErrorAction;
						finish("error", a.error.message);
						break;
					}

					case ActionType.SessionTurnCancelled: {
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
			this.client.dispatchAction({
				type: ActionType.SessionTurnStarted,
				session: this.uri,
				turnId,
				userMessage: {
					text,
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

		this.client.dispatchAction({
			type: ActionType.SessionTurnCancelled,
			session: this.uri,
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
		this.client.dispatchAction({
			...action,
			session: this.uri,
		} as IStateAction);
	}

	private ensureNotDisposed(): void {
		if (this._disposed) {
			throw new Error("SessionHandle has been disposed");
		}
	}
}
