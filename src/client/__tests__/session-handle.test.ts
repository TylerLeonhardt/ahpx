import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AhpClient } from "../../client/index.js";
import type { IActionEnvelope, IStateAction } from "../../protocol/actions.js";
import { ActionType } from "../../protocol/actions.js";
import type { IActiveTurn, ISessionState, ITurn } from "../../protocol/state.js";
import { ResponsePartKind, SessionLifecycle, SessionStatus, TurnState } from "../../protocol/state.js";
import { SessionHandle } from "../session-handle.js";

const SESSION_URI = "copilot:/test-session";
const OTHER_SESSION_URI = "copilot:/other-session";
const PROVIDER = "copilot";
const MODEL = "gpt-4";

function makeSessionState(overrides: Partial<ISessionState> = {}): ISessionState {
	return {
		summary: {
			resource: SESSION_URI,
			provider: PROVIDER,
			title: "Test Session",
			status: SessionStatus.Idle,
			createdAt: 1000,
			modifiedAt: 1000,
		},
		lifecycle: SessionLifecycle.Ready,
		turns: [],
		...overrides,
	};
}

function envelope(action: IActionEnvelope["action"], seq = 1): IActionEnvelope {
	return { action, serverSeq: seq, origin: undefined };
}

function createMockClient() {
	const emitter = new EventEmitter();
	const dispatched: IStateAction[] = [];
	const sessionStates = new Map<string, ISessionState>();
	let connected = true;

	const client = Object.assign(emitter, {
		get connected() {
			return connected;
		},
		dispatchAction(action: IStateAction) {
			dispatched.push(action);
		},
		state: {
			getSession(uri: string) {
				return sessionStates.get(uri);
			},
		},
		disposeSession: vi.fn().mockResolvedValue(null),
	}) as unknown as AhpClient;

	return {
		client,
		dispatched,
		setSessionState(uri: string, state: ISessionState) {
			sessionStates.set(uri, state);
		},
		setConnected(value: boolean) {
			connected = value;
		},
		emitAction(env: IActionEnvelope) {
			emitter.emit("action", env);
		},
		emitDisconnected(code: number, reason: string) {
			emitter.emit("disconnected", code, reason);
		},
	};
}

describe("SessionHandle", () => {
	describe("construction and state", () => {
		it("stores uri, provider, and model", () => {
			const { client } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER, MODEL);

			expect(handle.uri).toBe(SESSION_URI);
			expect(handle.provider).toBe(PROVIDER);
			expect(handle.model).toBe(MODEL);
			expect(handle.disposed).toBe(false);
		});

		it("reads state from client state mirror", () => {
			const { client, setSessionState } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			// No state yet
			expect(handle.state).toBeUndefined();
			expect(handle.isReady).toBe(false);

			// Set ready state
			setSessionState(SESSION_URI, makeSessionState());
			expect(handle.state).toBeDefined();
			expect(handle.isReady).toBe(true);
		});

		it("reads activeTurn from session state", () => {
			const { client, setSessionState } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const activeTurn: IActiveTurn = {
				id: "turn-1",
				userMessage: { text: "Hello" },
				responseParts: [],
				usage: undefined,
			};

			setSessionState(SESSION_URI, makeSessionState({ activeTurn }));
			expect(handle.activeTurn).toBe(activeTurn);
		});
	});

	describe("event filtering", () => {
		it("only emits actions for its own session", () => {
			const { client, emitAction } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			const handler = vi.fn();
			handle.on("action", handler);

			// Action for our session — should emit
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId: "t1",
					partId: "part-1",
					content: "hello",
				}),
			);

			// Action for another session — should NOT emit
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: OTHER_SESSION_URI,
					turnId: "t2",
					partId: "part-1",
					content: "world",
				}),
			);

			// Root action (no session) — should NOT emit
			emitAction(
				envelope({
					type: ActionType.RootAgentsChanged,
					agents: [],
				}),
			);

			expect(handler).toHaveBeenCalledOnce();
		});

		it("emits turnComplete when a turn completes", () => {
			const { client, setSessionState, emitAction } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const completedTurn: ITurn = {
				id: "turn-1",
				userMessage: { text: "Hello" },
				responseParts: [{ kind: ResponsePartKind.Markdown, id: "part-1", content: "Hi there!" }],
				usage: undefined,
				state: TurnState.Complete,
			};

			setSessionState(SESSION_URI, makeSessionState({ turns: [completedTurn] }));

			const handler = vi.fn();
			handle.on("turnComplete", handler);

			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId: "turn-1",
				}),
			);

			expect(handler).toHaveBeenCalledOnce();
			expect(handler).toHaveBeenCalledWith(completedTurn);
		});

		it("emits error on session error action", () => {
			const { client, emitAction } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const handler = vi.fn();
			handle.on("error", handler);

			emitAction(
				envelope({
					type: ActionType.SessionError,
					session: SESSION_URI,
					turnId: "t1",
					error: { errorType: "error", message: "Something went wrong" },
				}),
			);

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
			expect(handler.mock.calls[0][0].message).toBe("Something went wrong");
		});

		it("emits error on disconnect", () => {
			const { client, emitDisconnected } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const handler = vi.fn();
			handle.on("error", handler);

			emitDisconnected(1006, "Connection lost");

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].message).toContain("Connection lost");
		});
	});

	describe("multi-session event routing", () => {
		it("routes events to correct session handles", () => {
			const { client, emitAction } = createMockClient();
			const handle1 = new SessionHandle(client, SESSION_URI, PROVIDER);
			const handle2 = new SessionHandle(client, OTHER_SESSION_URI, PROVIDER);

			const handler1 = vi.fn();
			const handler2 = vi.fn();
			handle1.on("action", handler1);
			handle2.on("action", handler2);

			// Action for session 1
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId: "t1",
					partId: "part-1",
					content: "for session 1",
				}),
			);

			// Action for session 2
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: OTHER_SESSION_URI,
					turnId: "t2",
					partId: "part-1",
					content: "for session 2",
				}),
			);

			expect(handler1).toHaveBeenCalledOnce();
			expect(handler2).toHaveBeenCalledOnce();

			// Verify no cross-talk
			const env1 = handler1.mock.calls[0][0] as IActionEnvelope;
			expect((env1.action as { content: string }).content).toBe("for session 1");

			const env2 = handler2.mock.calls[0][0] as IActionEnvelope;
			expect((env2.action as { content: string }).content).toBe("for session 2");
		});
	});

	describe("waitForReady", () => {
		it("resolves immediately if already ready", async () => {
			const { client, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			await expect(handle.waitForReady()).resolves.toBeUndefined();
		});

		it("rejects immediately if already failed", async () => {
			const { client, setSessionState } = createMockClient();
			setSessionState(
				SESSION_URI,
				makeSessionState({
					lifecycle: SessionLifecycle.CreationFailed,
					creationError: { errorType: "error", message: "Provider unavailable" },
				}),
			);
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			await expect(handle.waitForReady()).rejects.toThrow("Provider unavailable");
		});

		it("waits for session/ready action", async () => {
			const { client, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState({ lifecycle: SessionLifecycle.Creating }));
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const readyPromise = handle.waitForReady(5000);

			// Simulate ready action
			setSessionState(SESSION_URI, makeSessionState());
			emitAction(
				envelope({
					type: ActionType.SessionReady,
					session: SESSION_URI,
				}),
			);

			await expect(readyPromise).resolves.toBeUndefined();
		});

		it("rejects on creation failure action", async () => {
			const { client, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState({ lifecycle: SessionLifecycle.Creating }));
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const readyPromise = handle.waitForReady(5000);

			// Simulate creation failure
			setSessionState(
				SESSION_URI,
				makeSessionState({
					lifecycle: SessionLifecycle.CreationFailed,
					creationError: { errorType: "error", message: "Model not found" },
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionCreationFailed,
					session: SESSION_URI,
					error: { errorType: "error", message: "Model not found" },
				}),
			);

			await expect(readyPromise).rejects.toThrow("Model not found");
		});

		it("rejects on timeout", async () => {
			vi.useFakeTimers();
			try {
				const { client, setSessionState } = createMockClient();
				setSessionState(SESSION_URI, makeSessionState({ lifecycle: SessionLifecycle.Creating }));
				const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

				const readyPromise = handle.waitForReady(1000);

				vi.advanceTimersByTime(1001);

				await expect(readyPromise).rejects.toThrow("Timed out");
			} finally {
				vi.useRealTimers();
			}
		});

		it("rejects if handle is disposed", async () => {
			const { client, setSessionState, setConnected } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);
			await handle.dispose();

			await expect(handle.waitForReady()).rejects.toThrow("disposed");
		});
	});

	describe("sendPrompt", () => {
		it("dispatches turnStarted and resolves on turnComplete", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Hello");

			// Should have dispatched turnStarted
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0].type).toBe(ActionType.SessionTurnStarted);
			const startAction = dispatched[0] as { session: string; turnId: string; userMessage: { text: string } };
			expect(startAction.session).toBe(SESSION_URI);
			expect(startAction.userMessage.text).toBe("Hello");

			const turnId = startAction.turnId;

			// Simulate response
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "Hi ",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "there!",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.state).toBe("complete");
			expect(result.responseText).toBe("Hi there!");
			expect(result.turnId).toBe(turnId);
		});

		it("counts tool calls", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Do something");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			emitAction(
				envelope({
					type: ActionType.SessionToolCallStart,
					session: SESSION_URI,
					turnId,
					toolCallId: "tc-1",
					toolName: "readFile",
					displayName: "Read File",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionToolCallStart,
					session: SESSION_URI,
					turnId,
					toolCallId: "tc-2",
					toolName: "writeFile",
					displayName: "Write File",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.toolCalls).toBe(2);
		});

		it("captures usage info", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			emitAction(
				envelope({
					type: ActionType.SessionUsage,
					session: SESSION_URI,
					turnId,
					usage: { inputTokens: 100, outputTokens: 50, model: "gpt-4" },
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, model: "gpt-4" });
		});

		it("resolves with error state on session error", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			// Add error listener to prevent unhandled error throw
			handle.on("error", () => {});

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			emitAction(
				envelope({
					type: ActionType.SessionError,
					session: SESSION_URI,
					turnId,
					error: { errorType: "error", message: "Rate limited" },
				}),
			);

			const result = await promptPromise;
			expect(result.state).toBe("error");
			expect(result.error).toBe("Rate limited");
		});

		it("resolves with cancelled state on turn cancelled", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			emitAction(
				envelope({
					type: ActionType.SessionTurnCancelled,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.state).toBe("cancelled");
		});

		it("ignores actions from different turns", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			// Delta from a different turn — should be ignored
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId: "different-turn",
					partId: "part-1",
					content: "stale data",
				}),
			);

			// Our turn completes
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "correct",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.responseText).toBe("correct");
		});

		it("throws if session is not ready", async () => {
			const { client, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState({ lifecycle: SessionLifecycle.Creating }));
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			await expect(handle.sendPrompt("Hello")).rejects.toThrow("not ready");
		});

		it("throws if a turn is already active", async () => {
			const { client, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			// Start a turn (don't complete it)
			handle.sendPrompt("First");

			await expect(handle.sendPrompt("Second")).rejects.toThrow("already active");
		});

		it("throws if disposed", async () => {
			const { client, setSessionState, setConnected } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);
			await handle.dispose();

			await expect(handle.sendPrompt("Hello")).rejects.toThrow("disposed");
		});

		it("resolves with error on timeout", async () => {
			vi.useFakeTimers();
			try {
				const { client, setSessionState } = createMockClient();
				setSessionState(SESSION_URI, makeSessionState());
				const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

				const promptPromise = handle.sendPrompt("Hello", { timeout: 5000 });

				vi.advanceTimersByTime(5001);

				const result = await promptPromise;
				expect(result.state).toBe("error");
				expect(result.error).toContain("timed out");
			} finally {
				vi.useRealTimers();
			}
		});

		it("resolves with error state on disconnect mid-turn", async () => {
			const { client, emitAction, dispatched, emitDisconnected, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			// Prevent unhandled error from _onDisconnect propagating
			handle.on("error", () => {});

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			// Simulate partial response before disconnect
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "partial ",
				}),
			);

			// Simulate WebSocket disconnect
			emitDisconnected(1006, "Connection reset");

			const result = await promptPromise;
			expect(result.state).toBe("error");
			expect(result.error).toContain("Connection lost");
			expect(result.turnId).toBe(turnId);
		});

		it("preserves accumulated text on disconnect", async () => {
			const { client, emitAction, dispatched, emitDisconnected, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			handle.on("error", () => {});

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			// Accumulate several deltas
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "Hello, ",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "I am working on ",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "your request",
				}),
			);

			// Disconnect mid-stream
			emitDisconnected(1006, "Connection lost");

			const result = await promptPromise;
			expect(result.responseText).toBe("Hello, I am working on your request");
			expect(result.state).toBe("error");
		});

		it("cleans up listeners after disconnect", async () => {
			const { client, emitDisconnected, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			handle.on("error", () => {});

			const actionListenersBefore = handle.listenerCount("action");
			const errorListenersBefore = handle.listenerCount("error");

			const promptPromise = handle.sendPrompt("Hello");

			// sendPrompt adds one action listener and one error listener
			expect(handle.listenerCount("action")).toBe(actionListenersBefore + 1);
			expect(handle.listenerCount("error")).toBe(errorListenersBefore + 1);

			// Disconnect triggers cleanup
			emitDisconnected(1006, "gone");

			await promptPromise;

			// Listeners should be back to pre-sendPrompt counts
			expect(handle.listenerCount("action")).toBe(actionListenersBefore);
			expect(handle.listenerCount("error")).toBe(errorListenersBefore);
		});

		it("normal completion still works (no regression from error listener)", async () => {
			const { client, dispatched, emitAction, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const promptPromise = handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId,
					partId: "part-1",
					content: "All done!",
				}),
			);
			emitAction(
				envelope({
					type: ActionType.SessionTurnComplete,
					session: SESSION_URI,
					turnId,
				}),
			);

			const result = await promptPromise;
			expect(result.state).toBe("complete");
			expect(result.responseText).toBe("All done!");
			expect(result.error).toBeUndefined();

			// Error listener should be cleaned up
			// Only the base error handler from the test remains
			expect(handle.listenerCount("error")).toBe(0);
		});
	});

	describe("cancelTurn", () => {
		it("dispatches turnCancelled for active turn", async () => {
			const { client, dispatched, setSessionState } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			// Start a turn
			handle.sendPrompt("Hello");
			const turnId = (dispatched[0] as { turnId: string }).turnId;

			// Cancel it
			await handle.cancelTurn();

			expect(dispatched).toHaveLength(2);
			expect(dispatched[1].type).toBe(ActionType.SessionTurnCancelled);
			expect((dispatched[1] as { turnId: string }).turnId).toBe(turnId);
		});

		it("does nothing if no active turn", async () => {
			const { client, dispatched } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			await handle.cancelTurn();

			expect(dispatched).toHaveLength(0);
		});
	});

	describe("dispatchAction", () => {
		it("auto-injects session URI", () => {
			const { client, dispatched } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			handle.dispatchAction({
				type: ActionType.SessionModelChanged,
				model: "claude-3",
			});

			expect(dispatched).toHaveLength(1);
			expect((dispatched[0] as { session: string }).session).toBe(SESSION_URI);
			expect((dispatched[0] as { model: string }).model).toBe("claude-3");
		});

		it("throws if disposed", async () => {
			const { client, setSessionState, setConnected } = createMockClient();
			setSessionState(SESSION_URI, makeSessionState());
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);
			await handle.dispose();

			expect(() => handle.dispatchAction({ type: ActionType.SessionModelChanged, model: "x" })).toThrow("disposed");
		});
	});

	describe("dispose", () => {
		it("removes listeners from client", async () => {
			const { client, emitAction, setConnected } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			const handler = vi.fn();
			handle.on("action", handler);

			setConnected(false);
			await handle.dispose();

			// Should no longer receive events
			emitAction(
				envelope({
					type: ActionType.SessionDelta,
					session: SESSION_URI,
					turnId: "t1",
					partId: "part-1",
					content: "late",
				}),
			);

			expect(handler).not.toHaveBeenCalled();
		});

		it("calls client.disposeSession when connected", async () => {
			const { client } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);

			await handle.dispose();

			expect((client as unknown as { disposeSession: ReturnType<typeof vi.fn> }).disposeSession).toHaveBeenCalledWith(
				SESSION_URI,
			);
		});

		it("emits disposed event", async () => {
			const { client, setConnected } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);

			const handler = vi.fn();
			handle.on("disposed", handler);

			await handle.dispose();

			expect(handler).toHaveBeenCalledOnce();
		});

		it("is idempotent", async () => {
			const { client, setConnected } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);

			await handle.dispose();
			await handle.dispose();

			expect(handle.disposed).toBe(true);
		});

		it("marks handle as disposed", async () => {
			const { client, setConnected } = createMockClient();
			const handle = new SessionHandle(client, SESSION_URI, PROVIDER);
			setConnected(false);

			expect(handle.disposed).toBe(false);
			await handle.dispose();
			expect(handle.disposed).toBe(true);
		});
	});
});
