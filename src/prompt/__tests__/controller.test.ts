import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { PromptRenderer } from "../../output/renderer.js";
import type { WritableOutput } from "../../output/renderer.js";
import { PermissionHandler } from "../../permissions/handler.js";
import type { IActionEnvelope, IStateAction } from "../../protocol/actions.js";
import { ActionType } from "../../protocol/actions.js";
import type { ISessionState } from "../../protocol/state.js";
import {
	PermissionKind,
	SessionLifecycle,
	SessionStatus,
	ToolCallConfirmationReason,
	ToolCallStatus,
} from "../../protocol/state.js";
import { TurnController } from "../controller.js";

/** Captures output. */
function createCapture(): { out: WritableOutput; text: () => string } {
	let buf = "";
	return {
		out: {
			write: (s: string) => {
				buf += s;
			},
		},
		text: () => buf,
	};
}

/** Create a minimal session state for the state mirror. */
function makeSessionState(): ISessionState {
	return {
		summary: {
			resource: "copilot:/test",
			provider: "copilot",
			title: "Test",
			status: SessionStatus.Idle,
			createdAt: 1000,
			modifiedAt: 1000,
		},
		lifecycle: SessionLifecycle.Ready,
		turns: [],
	};
}

/**
 * Creates a mock AhpClient that:
 *   - Emits `action` events (via EventEmitter)
 *   - Records dispatched actions
 *   - Has a minimal state mirror
 */
function createMockClient() {
	const emitter = new EventEmitter();
	const dispatched: IStateAction[] = [];
	let seq = 0;

	// Minimal state mock
	const sessionStates = new Map<string, ISessionState>();

	const client = Object.assign(emitter, {
		dispatchAction(action: IStateAction) {
			dispatched.push(action);
		},
		state: {
			getSession(uri: string) {
				return sessionStates.get(uri);
			},
		},
	}) as unknown as AhpClient;

	return {
		client,
		dispatched,
		/** Simulate an action envelope arriving from the server. */
		emitAction(action: IStateAction) {
			seq++;
			const envelope: IActionEnvelope = {
				action,
				serverSeq: seq,
				origin: undefined,
			};
			emitter.emit("action", envelope);
		},
		/** Set a session state for lookups. */
		setSessionState(uri: string, state: ISessionState) {
			sessionStates.set(uri, state);
		},
	};
}

describe("TurnController", () => {
	const SESSION_URI = "copilot:/test-session";

	it("dispatches turnStarted and resolves on turnComplete", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);

		const resultPromise = controller.prompt("Hello");

		// Check that turnStarted was dispatched
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].type).toBe(ActionType.SessionTurnStarted);
		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Simulate server streaming
		emitAction({
			type: ActionType.SessionDelta,
			session: SESSION_URI,
			turnId,
			content: "Hi there!",
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
		expect(result.responseText).toBe("Hi there!");
		expect(result.turnId).toBe(turnId);
		expect(cap.text()).toContain("Hi there!");
		expect(cap.text()).toContain("[done]");
	});

	it("handles error turn", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("fail");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		emitAction({
			type: ActionType.SessionError,
			session: SESSION_URI,
			turnId,
			error: { errorType: "runtime", message: "model overloaded" },
		});

		const result = await resultPromise;
		expect(result.state).toBe("error");
		expect(result.error).toBe("model overloaded");
		expect(cap.text()).toContain("[error]");
	});

	it("handles cancelled turn", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("cancel me");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		emitAction({
			type: ActionType.SessionTurnCancelled,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("cancelled");
		expect(cap.text()).toContain("[cancelled]");
	});

	it("handles reasoning then delta", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("think about this");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		emitAction({
			type: ActionType.SessionReasoning,
			session: SESSION_URI,
			turnId,
			content: "analyzing...",
		});

		emitAction({
			type: ActionType.SessionDelta,
			session: SESSION_URI,
			turnId,
			content: "Here's the answer.",
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
		expect(cap.text()).toContain("[thinking]");
		expect(cap.text()).toContain("analyzing...");
		expect(cap.text()).toContain("Here's the answer.");
	});

	it("tracks usage info", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("usage test");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		emitAction({
			type: ActionType.SessionUsage,
			session: SESSION_URI,
			turnId,
			usage: { inputTokens: 100, outputTokens: 50, model: "gpt-4o" },
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, model: "gpt-4o" });
		expect(cap.text()).toContain("Tokens:");
	});

	it("handles tool call lifecycle", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("run tests");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Tool call start
		emitAction({
			type: ActionType.SessionToolCallStart,
			session: SESSION_URI,
			turnId,
			toolCallId: "tc1",
			toolName: "shell",
			displayName: "Shell",
		});

		// Tool call complete
		emitAction({
			type: ActionType.SessionToolCallComplete,
			session: SESSION_URI,
			turnId,
			toolCallId: "tc1",
			result: { success: true, pastTenseMessage: "Ran npm test" },
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.toolCalls).toBe(1);
		expect(cap.text()).toContain("Shell");
		expect(cap.text()).toContain("(running)");
		expect(cap.text()).toContain("Ran npm test");
	});

	it("handles tool call confirmation in approve-all mode", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		// Set up session state with a tool call for lookup
		setSessionState(SESSION_URI, {
			...makeSessionState(),
			summary: { ...makeSessionState().summary, resource: SESSION_URI },
			activeTurn: {
				id: "placeholder",
				userMessage: { text: "test" },
				streamingText: "",
				responseParts: [],
				toolCalls: {
					tc1: {
						toolCallId: "tc1",
						toolName: "shell",
						displayName: "Run Shell Command",
						status: ToolCallStatus.PendingConfirmation,
						invocationMessage: "npm test",
					},
				},
				pendingPermissions: {},
				reasoning: "",
				usage: undefined,
			},
		});

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("confirm this");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Emit toolCallReady without auto-confirm
		emitAction({
			type: ActionType.SessionToolCallReady,
			session: SESSION_URI,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "npm test --reporter=verbose",
		});

		// Give async handler time to run
		await new Promise((r) => setTimeout(r, 50));

		// Should have dispatched toolCallConfirmed (approve-all)
		const confirmAction = dispatched.find((a) => a.type === ActionType.SessionToolCallConfirmed);
		expect(confirmAction).toBeDefined();

		// Complete the turn
		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		await resultPromise;
	});

	it("handles permission request in approve-all mode", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("need permission");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		emitAction({
			type: ActionType.SessionPermissionRequest,
			session: SESSION_URI,
			turnId,
			request: {
				requestId: "perm1",
				permissionKind: PermissionKind.Shell,
				fullCommandText: "rm -rf /tmp/test",
			},
		});

		// Give async handler time to run
		await new Promise((r) => setTimeout(r, 50));

		// Should have dispatched permissionResolved with approved=true
		const resolveAction = dispatched.find((a) => a.type === ActionType.SessionPermissionResolved);
		expect(resolveAction).toBeDefined();
		expect((resolveAction as { approved: boolean }).approved).toBe(true);

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		await resultPromise;
	});

	it("ignores actions for other sessions", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("test");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Action for a different session — should be ignored
		emitAction({
			type: ActionType.SessionDelta,
			session: "copilot:/other-session",
			turnId,
			content: "wrong session",
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.responseText).toBe("");
		expect(cap.text()).not.toContain("wrong session");
	});

	it("ignores actions for other turns", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("test");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Action for a different turn — should be ignored
		emitAction({
			type: ActionType.SessionDelta,
			session: SESSION_URI,
			turnId: "different-turn-id",
			content: "wrong turn",
		});

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.responseText).toBe("");
	});

	it("cancel dispatches turnCancelled", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("cancellable");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Cancel
		await controller.cancel();

		// Should have dispatched turnCancelled
		const cancelAction = dispatched.find((a) => a.type === ActionType.SessionTurnCancelled);
		expect(cancelAction).toBeDefined();

		// Simulate server acknowledging cancellation
		emitAction({
			type: ActionType.SessionTurnCancelled,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("cancelled");
	});

	it("skips toolCallReady when auto-confirmed by server", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("auto confirm");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Tool call ready with confirmed already set (auto-approved by server)
		emitAction({
			type: ActionType.SessionToolCallReady,
			session: SESSION_URI,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "Read file.ts",
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have dispatched toolCallConfirmed since server already confirmed
		const confirmAction = dispatched.find((a) => a.type === ActionType.SessionToolCallConfirmed);
		expect(confirmAction).toBeUndefined();

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		await resultPromise;
	});

	it("resolves with idle_timeout when no actions arrive within idle timeout", async () => {
		const { client } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const result = await controller.prompt("hello", undefined, { idleTimeout: 50 });

		expect(result.state).toBe("idle_timeout");
		expect(result.turnId).toBeDefined();
	});

	it("resets idle timer on each action", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("hello", undefined, { idleTimeout: 100 });

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Send actions at 30ms intervals — each resets the 100ms timer
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 30));
			emitAction({
				type: ActionType.SessionDelta,
				session: SESSION_URI,
				turnId,
				content: `chunk ${i}`,
			});
		}

		// Complete before idle timeout fires
		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
		expect(result.responseText).toContain("chunk 0");
	});

	it("does not idle-timeout when no idleTimeout option is set", async () => {
		const { client, dispatched, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("hello");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Wait a bit, then complete — should not timeout
		await new Promise((r) => setTimeout(r, 50));

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
	});
});
