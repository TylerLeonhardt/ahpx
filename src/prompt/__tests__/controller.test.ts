import { EventEmitter } from "node:events";
import type { ActionEnvelope, StateAction } from "@microsoft/agent-host-protocol";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { ChatState, Message, SessionState } from "@microsoft/agent-host-protocol";
import {
	MessageKind,
	ResponsePartKind,
	SessionStatus,
	ToolCallConfirmationReason,
	ToolCallStatus,
} from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { PromptRenderer } from "../../output/renderer.js";
import type { WritableOutput } from "../../output/renderer.js";
import { PermissionHandler } from "../../permissions/handler.js";
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

function message(text: string): Message {
	return { text, origin: { kind: MessageKind.User } };
}

/** Create a minimal chat state for the state mirror. */
function makeChatState(overrides: Partial<ChatState> = {}): ChatState {
	return {
		resource: "copilot:/test-session",
		title: "Test",
		status: SessionStatus.Idle,
		modifiedAt: "2026-01-01T00:00:00.000Z",
		turns: [],
		...overrides,
	};
}

type ToolCallPart = Extract<ChatState["turns"][number]["responseParts"][number], { toolCall: unknown }>;
type ClientContributor = Extract<NonNullable<ToolCallPart["toolCall"]["contributor"]>, { clientId: string }>;

function clientContributor(clientId: string): ClientContributor {
	return { kind: "client" as ClientContributor["kind"], clientId };
}

/**
 * Creates a mock AhpClient that:
 *   - Emits `action` events (via EventEmitter)
 *   - Records dispatched actions
 *   - Has a minimal state mirror
 */
function createMockClient() {
	const emitter = new EventEmitter();
	const dispatched: StateAction[] = [];
	const dispatchedChannels: string[] = [];
	let seq = 0;

	// Minimal state mock
	const sessionStates = new Map<string, SessionState>();
	const chatStates = new Map<string, ChatState>();

	const client = Object.assign(emitter, {
		clientId: "test-client-id",
		dispatchAction(channel: string, action: StateAction) {
			dispatchedChannels.push(channel);
			dispatched.push(action);
		},
		state: {
			getSession(uri: string) {
				return sessionStates.get(uri);
			},
			getChat(uri: string) {
				return chatStates.get(uri);
			},
		},
	}) as unknown as AhpClient;

	return {
		client,
		dispatched,
		dispatchedChannels,
		/** Simulate an action envelope arriving from the server. */
		emitAction(action: StateAction, channel = "copilot:/test-session") {
			seq++;
			const envelope: ActionEnvelope = {
				channel,
				action,
				serverSeq: seq,
				origin: undefined,
			};
			emitter.emit("action", envelope);
		},
		/** Set a session state for lookups. */
		setSessionState(uri: string, state: SessionState | ChatState) {
			if ("lifecycle" in state) sessionStates.set(uri, state);
			if ("turns" in state) chatStates.set(uri, state);
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
		expect(dispatched[0].type).toBe(ActionType.ChatTurnStarted);
		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Simulate server streaming
		emitAction({
			type: ActionType.ChatDelta,
			turnId,
			partId: "part-1",
			content: "Hi there!",
		});

		emitAction({
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
		expect(result.responseText).toBe("Hi there!");
		expect(result.turnId).toBe(turnId);
		expect(cap.text()).toContain("Hi there!");
		expect(cap.text()).toContain("[done]");
	});

	it("attaches a per-message model and routes turns to a distinct chat channel", async () => {
		const CHAT_URI = "ahp-chat://default/test-session";
		const { client, dispatched, dispatchedChannels, emitAction } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler, CHAT_URI, "claude-opus-4.8");

		const resultPromise = controller.prompt("Hello");

		// turnStarted dispatched on the chat channel, not the session URI
		expect(dispatchedChannels[0]).toBe(CHAT_URI);
		const started = dispatched[0] as { turnId: string; message: Message };
		expect(started.message.model).toEqual({ id: "claude-opus-4.8" });
		const turnId = started.turnId;

		// Stream + complete on the chat channel
		emitAction({ type: ActionType.ChatDelta, turnId, partId: "part-1", content: "Hi!" }, CHAT_URI);
		emitAction({ type: ActionType.ChatTurnComplete, turnId }, CHAT_URI);

		const result = await resultPromise;
		expect(result.state).toBe("complete");
		expect(result.responseText).toBe("Hi!");
	});

	it("omits message.model when no model is provided", async () => {
		const { client, dispatched } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		void controller.prompt("Hello");

		const started = dispatched[0] as { message: Message };
		expect(started.message.model).toBeUndefined();
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
			type: ActionType.ChatError,
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
			type: ActionType.ChatTurnCancelled,
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
			type: ActionType.ChatReasoning,
			turnId,
			partId: "reason-1",
			content: "analyzing...",
		});

		emitAction({
			type: ActionType.ChatDelta,
			turnId,
			partId: "part-1",
			content: "Here's the answer.",
		});

		emitAction({
			type: ActionType.ChatTurnComplete,
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
			type: ActionType.ChatUsage,
			turnId,
			usage: { inputTokens: 100, outputTokens: 50, model: "gpt-4o" },
		});

		emitAction({
			type: ActionType.ChatTurnComplete,
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
			type: ActionType.ChatToolCallStart,
			turnId,
			toolCallId: "tc1",
			toolName: "shell",
			displayName: "Shell",
		});

		// Tool call complete
		emitAction({
			type: ActionType.ChatToolCallComplete,
			turnId,
			toolCallId: "tc1",
			result: { success: true, pastTenseMessage: "Ran npm test" },
		});

		emitAction({
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		const result = await resultPromise;
		expect(result.toolCalls).toBe(1);
		// onToolCallStart shows tool name with (running) status
		expect(cap.text()).toContain("(running)");
		expect(cap.text()).toContain("Ran npm test");
	});

	it("handles tool call confirmation in approve-all mode", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		// Set up session state with a tool call for lookup
		setSessionState(
			SESSION_URI,
			makeChatState({
				activeTurn: {
					id: "placeholder",
					message: message("test"),
					responseParts: [
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "shell",
								displayName: "Run Shell Command",
								status: ToolCallStatus.PendingConfirmation,
								invocationMessage: "npm test",
							},
						},
					],
					usage: undefined,
				},
			}),
		);

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("confirm this");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Emit toolCallReady without auto-confirm
		emitAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "npm test --reporter=verbose",
		});

		// Give async handler time to run
		await new Promise((r) => setTimeout(r, 50));

		// Should have dispatched toolCallConfirmed (approve-all)
		const confirmAction = dispatched.find((a) => a.type === ActionType.ChatToolCallConfirmed);
		expect(confirmAction).toBeDefined();

		// Complete the turn
		emitAction({
			type: ActionType.ChatTurnComplete,
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
		emitAction(
			{
				type: ActionType.ChatDelta,
				turnId,
				partId: "part-1",
				content: "wrong session",
			},
			"copilot:/other-session",
		);

		emitAction({
			type: ActionType.ChatTurnComplete,
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
			type: ActionType.ChatDelta,
			turnId: "different-turn-id",
			partId: "part-1",
			content: "wrong turn",
		});

		emitAction({
			type: ActionType.ChatTurnComplete,
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
		const cancelAction = dispatched.find((a) => a.type === ActionType.ChatTurnCancelled);
		expect(cancelAction).toBeDefined();

		// Simulate server acknowledging cancellation
		emitAction({
			type: ActionType.ChatTurnCancelled,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("cancelled");
	});

	it("skips confirmation for client-provided tool when auto-confirmed by server", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		// Set up session state with a client-provided tool (toolClientId matches client)
		setSessionState(
			SESSION_URI,
			makeChatState({
				activeTurn: {
					id: "placeholder",
					message: message("test"),
					responseParts: [
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "read_file",
								displayName: "Read File",
								status: ToolCallStatus.Running,
								contributor: clientContributor("test-client-id"),
								invocationMessage: "Read file.ts",
								confirmed: ToolCallConfirmationReason.NotNeeded,
							},
						},
					],
					usage: undefined,
				},
			}),
		);

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("auto confirm");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Tool call ready with confirmed set — client-provided tool
		emitAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "Read file.ts",
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have dispatched toolCallConfirmed — client tool skips entirely
		const confirmAction = dispatched.find((a) => a.type === ActionType.ChatToolCallConfirmed);
		expect(confirmAction).toBeUndefined();

		// Should NOT have consulted permission handler (no auto-approved/denied output)
		expect(cap.text()).not.toContain("[auto-approved]");
		expect(cap.text()).not.toContain("[denied]");

		emitAction({
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		await resultPromise;
	});

	it("skips permission handler for server-confirmed tools (deny-all mode)", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("deny-all", { output: cap.out });

		// Set up session state with a server tool (no toolClientId)
		setSessionState(
			SESSION_URI,
			makeChatState({
				activeTurn: {
					id: "placeholder",
					message: message("test"),
					responseParts: [
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "server_shell",
								displayName: "Server Shell",
								status: ToolCallStatus.Running,
								invocationMessage: "npm test",
								confirmed: ToolCallConfirmationReason.NotNeeded,
							},
						},
					],
					usage: undefined,
				},
			}),
		);

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("run server tool");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Server tool auto-confirmed — permission handler should be skipped entirely
		emitAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "npm test",
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have dispatched toolCallConfirmed — server already handled it
		const confirmAction = dispatched.find((a) => a.type === ActionType.ChatToolCallConfirmed);
		expect(confirmAction).toBeUndefined();

		// Renderer should show auto-approved (not denied, because permission handler was skipped)
		expect(cap.text()).toContain("[auto-approved]");
		expect(cap.text()).not.toContain("[denied]");

		emitAction({
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		await resultPromise;
	});

	it("shows auto-approved for server-confirmed tools without dispatching", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("approve-all", { output: cap.out });

		// Set up session state with a server tool (no toolClientId)
		setSessionState(
			SESSION_URI,
			makeChatState({
				activeTurn: {
					id: "placeholder",
					message: message("test"),
					responseParts: [
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "server_read",
								displayName: "Server Read",
								status: ToolCallStatus.Running,
								invocationMessage: "Read config.json",
								confirmed: ToolCallConfirmationReason.NotNeeded,
							},
						},
					],
					usage: undefined,
				},
			}),
		);

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("run server tool");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Server tool auto-confirmed, user has approve-all
		emitAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "Read config.json",
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have dispatched toolCallConfirmed — server already running
		const confirmAction = dispatched.find((a) => a.type === ActionType.ChatToolCallConfirmed);
		expect(confirmAction).toBeUndefined();

		// Renderer should show auto-approved (permission handler was not called)
		expect(cap.text()).toContain("[auto-approved]");

		emitAction({
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		await resultPromise;
	});

	it("treats tool with non-matching toolClientId as server tool and auto-approves", async () => {
		const { client, dispatched, emitAction, setSessionState } = createMockClient();
		const cap = createCapture();
		const renderer = new PromptRenderer(cap.out);
		const handler = new PermissionHandler("deny-all", { output: cap.out });

		// Set up session state with a tool owned by a different client
		setSessionState(
			SESSION_URI,
			makeChatState({
				activeTurn: {
					id: "placeholder",
					message: message("test"),
					responseParts: [
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "other_tool",
								displayName: "Other Tool",
								status: ToolCallStatus.Running,
								contributor: clientContributor("different-client-id"),
								invocationMessage: "Do something",
								confirmed: ToolCallConfirmationReason.NotNeeded,
							},
						},
					],
					usage: undefined,
				},
			}),
		);

		const controller = new TurnController(client, SESSION_URI, renderer, handler);
		const resultPromise = controller.prompt("other client tool");

		const turnId = (dispatched[0] as { turnId: string }).turnId;

		// Auto-confirmed but toolClientId doesn't match → treated as server tool, auto-approved
		emitAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: "tc1",
			invocationMessage: "Do something",
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});

		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have dispatched any confirmation — server already confirmed
		const confirmAction = dispatched.find((a) => a.type === ActionType.ChatToolCallConfirmed);
		expect(confirmAction).toBeUndefined();

		// Renderer should show auto-approved
		expect(cap.text()).toContain("[auto-approved]");

		emitAction({
			type: ActionType.ChatTurnComplete,
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
				type: ActionType.ChatDelta,
				turnId,
				partId: "part-1",
				content: `chunk ${i}`,
			});
		}

		// Complete before idle timeout fires
		emitAction({
			type: ActionType.ChatTurnComplete,
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
			type: ActionType.ChatTurnComplete,
			turnId,
		});

		const result = await resultPromise;
		expect(result.state).toBe("complete");
	});
});
