import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import type { OutputFormatter } from "../../output/format.js";
import type { WritableOutput } from "../../output/renderer.js";
import type { IActionEnvelope, IStateAction } from "../../protocol/actions.js";
import { ActionType } from "../../protocol/actions.js";
import type { ISubscribeResult } from "../../protocol/commands.js";
import type { ISessionState } from "../../protocol/state.js";
import {
	ResponsePartKind,
	SessionLifecycle,
	SessionStatus,
	ToolCallConfirmationReason,
	ToolCallStatus,
	TurnState,
} from "../../protocol/state.js";
import { SessionWatcher } from "../watcher.js";

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

/** Creates a mock formatter that records all calls. */
function createMockFormatter(): OutputFormatter & { calls: Array<{ method: string; args: unknown[] }> } {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
		};
	return {
		calls,
		onDelta: record("onDelta"),
		onReasoning: record("onReasoning"),
		onToolCallStart: record("onToolCallStart"),
		onToolCallDelta: record("onToolCallDelta"),
		onToolCallReady: record("onToolCallReady"),
		onToolCallComplete: record("onToolCallComplete"),
		onToolCallCancelled: record("onToolCallCancelled"),
		onUsage: record("onUsage"),
		onTurnComplete: record("onTurnComplete"),
		onTurnError: record("onTurnError"),
		onTurnCancelled: record("onTurnCancelled"),
		onTitleChanged: record("onTitleChanged"),
	};
}

function makeSessionState(overrides: Partial<ISessionState> = {}): ISessionState {
	return {
		summary: {
			resource: "copilot:/test",
			provider: "copilot",
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

const SESSION_URI = "copilot:/test-session";

/** Flush the microtask queue so watch()'s async setup completes. */
const tick = () => Promise.resolve();

function createMockClient() {
	const emitter = new EventEmitter();
	let seq = 0;
	const sessionStates = new Map<string, ISessionState>();

	const client = Object.assign(emitter, {
		subscribe: async (_uri: string): Promise<ISubscribeResult> => {
			return {
				snapshot: {
					resource: SESSION_URI,
					state: sessionStates.get(SESSION_URI) ?? makeSessionState(),
					fromSeq: seq,
				},
			};
		},
		state: {
			getSession: (uri: string) => sessionStates.get(uri),
			root: { agents: [] },
		},
		connected: true,
	}) as unknown as AhpClient;

	return {
		client,
		emitAction(action: IStateAction) {
			seq++;
			const envelope: IActionEnvelope = { action, serverSeq: seq, origin: undefined };
			emitter.emit("action", envelope);
		},
		setSessionState(uri: string, state: ISessionState) {
			sessionStates.set(uri, state);
		},
	};
}

describe("SessionWatcher", () => {
	it("streams actions to the formatter", async () => {
		const { client, emitAction, setSessionState } = createMockClient();
		setSessionState(SESSION_URI, makeSessionState());
		const formatter = createMockFormatter();
		const statusCap = createCapture();

		const watcher = new SessionWatcher(client, SESSION_URI, formatter, { statusOut: statusCap.out });

		const watchPromise = watcher.watch();
		await tick();

		// Simulate server streaming
		emitAction({
			type: ActionType.SessionDelta,
			session: SESSION_URI,
			turnId: "t1",
			partId: "part-1",
			content: "Hello world",
		});

		emitAction({
			type: ActionType.SessionToolCallStart,
			session: SESSION_URI,
			turnId: "t1",
			toolCallId: "tc1",
			toolName: "readFile",
			displayName: "Read File",
		});

		// Stop and wait
		watcher.stop();
		await watchPromise;

		const deltaCall = formatter.calls.find((c) => c.method === "onDelta");
		expect(deltaCall).toBeDefined();
		expect(deltaCall!.args[0]).toBe("Hello world");

		const toolStartCall = formatter.calls.find((c) => c.method === "onToolCallStart");
		expect(toolStartCall).toBeDefined();
		expect(toolStartCall!.args[1]).toBe("Read File");
	});

	it("shows current state when joining mid-turn", async () => {
		const { client, setSessionState } = createMockClient();

		// Set up a session with an active turn that has streaming text
		setSessionState(
			SESSION_URI,
			makeSessionState({
				summary: { ...makeSessionState().summary, resource: SESSION_URI, status: SessionStatus.InProgress },
				activeTurn: {
					id: "t1",
					userMessage: { text: "Hello" },
					responseParts: [
						{ kind: ResponsePartKind.Reasoning, id: "reason-1", content: "thinking..." },
						{ kind: ResponsePartKind.Markdown, id: "part-1", content: "Existing text" },
						{
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								toolCallId: "tc1",
								toolName: "shell",
								displayName: "Shell",
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

		const formatter = createMockFormatter();
		const statusCap = createCapture();
		const watcher = new SessionWatcher(client, SESSION_URI, formatter, { statusOut: statusCap.out });

		const watchPromise = watcher.watch();
		await tick();
		watcher.stop();
		await watchPromise;

		// Should have shown existing text
		const deltaCall = formatter.calls.find((c) => c.method === "onDelta");
		expect(deltaCall).toBeDefined();
		expect(deltaCall!.args[0]).toBe("Existing text");

		// Should have shown reasoning
		const reasoningCall = formatter.calls.find((c) => c.method === "onReasoning");
		expect(reasoningCall).toBeDefined();
		expect(reasoningCall!.args[0]).toBe("thinking...");

		// Should have shown the running tool call
		const toolCall = formatter.calls.find((c) => c.method === "onToolCallStart");
		expect(toolCall).toBeDefined();

		// Status should show join message
		expect(statusCap.text()).toContain("Joining turn in progress");
	});

	it("exits cleanly on session dispose (disconnect)", async () => {
		const { client, setSessionState } = createMockClient();
		setSessionState(SESSION_URI, makeSessionState());
		const formatter = createMockFormatter();

		const watcher = new SessionWatcher(client, SESSION_URI, formatter);
		const watchPromise = watcher.watch();
		await tick();

		// Simulate disconnect
		(client as unknown as EventEmitter).emit("disconnected", 1000, "Normal closure");

		// Should resolve without error
		await watchPromise;
	});

	it("handles Ctrl+C (stop)", async () => {
		const { client, setSessionState } = createMockClient();
		setSessionState(SESSION_URI, makeSessionState());
		const formatter = createMockFormatter();

		const watcher = new SessionWatcher(client, SESSION_URI, formatter);
		const watchPromise = watcher.watch();
		await tick();

		// Simulate user hitting Ctrl+C
		watcher.stop();

		await watchPromise;
	});

	it("ignores actions for other sessions", async () => {
		const { client, emitAction, setSessionState } = createMockClient();
		setSessionState(SESSION_URI, makeSessionState());
		const formatter = createMockFormatter();

		const watcher = new SessionWatcher(client, SESSION_URI, formatter);
		const watchPromise = watcher.watch();
		await tick();

		emitAction({
			type: ActionType.SessionDelta,
			session: "copilot:/other-session",
			turnId: "t1",
			partId: "part-1",
			content: "Wrong session",
		});

		watcher.stop();
		await watchPromise;

		const deltaCall = formatter.calls.find((c) => c.method === "onDelta");
		expect(deltaCall).toBeUndefined();
	});

	it("streams turn complete and error actions", async () => {
		const { client, emitAction, setSessionState } = createMockClient();
		const state = makeSessionState({
			turns: [
				{
					id: "t1",
					userMessage: { text: "Hello" },
					responseParts: [{ kind: ResponsePartKind.Markdown, id: "part-1", content: "Hi there!" }],
					usage: undefined,
					state: TurnState.Complete,
				},
			],
		});
		setSessionState(SESSION_URI, state);
		const formatter = createMockFormatter();

		const watcher = new SessionWatcher(client, SESSION_URI, formatter);
		const watchPromise = watcher.watch();
		await tick();

		emitAction({
			type: ActionType.SessionTurnComplete,
			session: SESSION_URI,
			turnId: "t2",
		});

		emitAction({
			type: ActionType.SessionError,
			session: SESSION_URI,
			turnId: "t3",
			error: { errorType: "runtime", message: "Something went wrong" },
		});

		emitAction({
			type: ActionType.SessionTurnCancelled,
			session: SESSION_URI,
			turnId: "t4",
		});

		watcher.stop();
		await watchPromise;

		expect(formatter.calls.find((c) => c.method === "onTurnComplete")).toBeDefined();
		expect(formatter.calls.find((c) => c.method === "onTurnError")).toBeDefined();
		expect(formatter.calls.find((c) => c.method === "onTurnCancelled")).toBeDefined();
	});
});
