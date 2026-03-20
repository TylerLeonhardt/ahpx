import { describe, expect, it } from "vitest";
import { ActionType } from "../../protocol/actions.js";
import type { IActionEnvelope } from "../../protocol/actions.js";
import { SessionLifecycle, SessionStatus, ToolCallStatus } from "../../protocol/state.js";
import type { ISessionState, ISnapshot } from "../../protocol/state.js";
import { StateMirror } from "../state.js";

function makeSessionState(overrides: Partial<ISessionState> = {}): ISessionState {
	return {
		summary: {
			resource: "copilot:/test-session",
			provider: "copilot",
			title: "Test Session",
			status: SessionStatus.Idle,
			createdAt: 1000,
			modifiedAt: 1000,
		},
		lifecycle: SessionLifecycle.Creating,
		turns: [],
		...overrides,
	};
}

function envelope(action: IActionEnvelope["action"], seq: number): IActionEnvelope {
	return { action, serverSeq: seq, origin: undefined };
}

describe("StateMirror", () => {
	describe("snapshots", () => {
		it("applies a root snapshot", () => {
			const mirror = new StateMirror();
			const snapshot: ISnapshot = {
				resource: "agenthost:/root",
				state: {
					agents: [
						{
							provider: "copilot",
							displayName: "GitHub Copilot",
							description: "AI pair programmer",
							models: [{ id: "gpt-4o", provider: "copilot", name: "GPT-4o" }],
						},
					],
					activeSessions: 2,
				},
				fromSeq: 5,
			};

			mirror.applySnapshot(snapshot);

			expect(mirror.root.agents).toHaveLength(1);
			expect(mirror.root.agents[0].provider).toBe("copilot");
			expect(mirror.root.activeSessions).toBe(2);
			expect(mirror.seq).toBe(5);
		});

		it("applies a session snapshot", () => {
			const mirror = new StateMirror();
			const state = makeSessionState();
			const snapshot: ISnapshot = {
				resource: "copilot:/test-session",
				state,
				fromSeq: 3,
			};

			mirror.applySnapshot(snapshot);

			expect(mirror.getSession("copilot:/test-session")).toEqual(state);
			expect(mirror.sessionUris).toContain("copilot:/test-session");
		});
	});

	describe("root actions", () => {
		it("handles RootAgentsChanged", () => {
			const mirror = new StateMirror();

			mirror.applyAction(
				envelope(
					{
						type: ActionType.RootAgentsChanged,
						agents: [
							{
								provider: "test",
								displayName: "Test Agent",
								description: "A test agent",
								models: [],
							},
						],
					},
					1,
				),
			);

			expect(mirror.root.agents).toHaveLength(1);
			expect(mirror.root.agents[0].provider).toBe("test");
			expect(mirror.seq).toBe(1);
		});

		it("handles RootActiveSessionsChanged", () => {
			const mirror = new StateMirror();

			mirror.applyAction(
				envelope(
					{
						type: ActionType.RootActiveSessionsChanged,
						activeSessions: 5,
					},
					2,
				),
			);

			expect(mirror.root.activeSessions).toBe(5);
		});
	});

	describe("session actions", () => {
		it("handles SessionReady", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState(),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionReady,
						session: "copilot:/s1",
					},
					1,
				),
			);

			const session = mirror.getSession("copilot:/s1")!;
			expect(session.lifecycle).toBe(SessionLifecycle.Ready);
			expect(session.summary.status).toBe(SessionStatus.Idle);
		});

		it("handles SessionTurnStarted and SessionDelta", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
				fromSeq: 0,
			});

			// Start a turn
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionTurnStarted,
						session: "copilot:/s1",
						turnId: "t1",
						userMessage: { text: "Hello" },
					},
					1,
				),
			);

			let session = mirror.getSession("copilot:/s1")!;
			expect(session.activeTurn).toBeDefined();
			expect(session.activeTurn!.id).toBe("t1");
			expect(session.summary.status).toBe(SessionStatus.InProgress);

			// Stream a delta
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionDelta,
						session: "copilot:/s1",
						turnId: "t1",
						content: "Hi there!",
					},
					2,
				),
			);

			session = mirror.getSession("copilot:/s1")!;
			expect(session.activeTurn!.streamingText).toBe("Hi there!");
		});

		it("handles SessionTurnComplete", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({
					lifecycle: SessionLifecycle.Ready,
					activeTurn: {
						id: "t1",
						userMessage: { text: "Hello" },
						streamingText: "Hi there!",
						responseParts: [],
						toolCalls: {},
						pendingPermissions: {},
						reasoning: "",
						usage: undefined,
					},
				}),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionTurnComplete,
						session: "copilot:/s1",
						turnId: "t1",
					},
					3,
				),
			);

			const session = mirror.getSession("copilot:/s1")!;
			expect(session.activeTurn).toBeUndefined();
			expect(session.turns).toHaveLength(1);
			expect(session.turns[0].id).toBe("t1");
			expect(session.turns[0].responseText).toBe("Hi there!");
			expect(session.summary.status).toBe(SessionStatus.Idle);
		});

		it("handles SessionTitleChanged", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionTitleChanged,
						session: "copilot:/s1",
						title: "New Title",
					},
					1,
				),
			);

			const session = mirror.getSession("copilot:/s1")!;
			expect(session.summary.title).toBe("New Title");
		});

		it("handles SessionToolCallStart", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({
					lifecycle: SessionLifecycle.Ready,
					activeTurn: {
						id: "t1",
						userMessage: { text: "Run a tool" },
						streamingText: "",
						responseParts: [],
						toolCalls: {},
						pendingPermissions: {},
						reasoning: "",
						usage: undefined,
					},
				}),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionToolCallStart,
						session: "copilot:/s1",
						turnId: "t1",
						toolCallId: "tc1",
						toolName: "readFile",
						displayName: "Read File",
					},
					1,
				),
			);

			const session = mirror.getSession("copilot:/s1")!;
			const tc = session.activeTurn!.toolCalls.tc1;
			expect(tc).toBeDefined();
			expect(tc.status).toBe(ToolCallStatus.Streaming);
			expect(tc.toolName).toBe("readFile");
		});
	});

	describe("removeSession", () => {
		it("removes a tracked session", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState(),
				fromSeq: 0,
			});

			expect(mirror.getSession("copilot:/s1")).toBeDefined();

			mirror.removeSession("copilot:/s1");

			expect(mirror.getSession("copilot:/s1")).toBeUndefined();
			expect(mirror.sessionUris).not.toContain("copilot:/s1");
		});
	});
});
