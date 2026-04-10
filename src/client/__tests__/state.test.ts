import { describe, expect, it } from "vitest";
import { ActionType } from "../../protocol/actions.js";
import type { IActionEnvelope } from "../../protocol/actions.js";
import {
	PendingMessageKind,
	ResponsePartKind,
	SessionLifecycle,
	SessionStatus,
	ToolCallStatus,
	TurnState,
} from "../../protocol/state.js";
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

		it("treats SessionDelta targeting a nonexistent partId as a no-op", () => {
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

			// Delta arrives BEFORE the SessionResponsePart — should be a no-op
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionDelta,
						session: "copilot:/s1",
						turnId: "t1",
						partId: "part-1",
						content: "First words",
					},
					2,
				),
			);

			const session = mirror.getSession("copilot:/s1")!;
			// No part should be created — delta targeting nonexistent partId is a no-op
			expect(session.activeTurn!.responseParts).toHaveLength(0);
		});

		it("creates part via SessionResponsePart then appends via delta", () => {
			const mirror = new StateMirror();
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
				fromSeq: 0,
			});

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

			// SessionResponsePart creates the part first
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionResponsePart,
						session: "copilot:/s1",
						turnId: "t1",
						part: { kind: ResponsePartKind.Markdown, id: "part-1", content: "" },
					},
					2,
				),
			);

			let session = mirror.getSession("copilot:/s1")!;
			expect(session.activeTurn!.responseParts).toHaveLength(1);

			// Now delta appends to the existing part
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionDelta,
						session: "copilot:/s1",
						turnId: "t1",
						partId: "part-1",
						content: "Hello world",
					},
					3,
				),
			);

			session = mirror.getSession("copilot:/s1")!;
			const mdPart = session.activeTurn!.responseParts.find(
				(p) => p.kind === ResponsePartKind.Markdown && p.id === "part-1",
			);
			expect(mdPart).toBeDefined();
			expect((mdPart as { content: string }).content).toBe("Hello world");
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

			// Add a markdown response part
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionResponsePart,
						session: "copilot:/s1",
						turnId: "t1",
						part: { kind: ResponsePartKind.Markdown, id: "part-1", content: "" },
					},
					2,
				),
			);

			// Stream a delta
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionDelta,
						session: "copilot:/s1",
						turnId: "t1",
						partId: "part-1",
						content: "Hi there!",
					},
					3,
				),
			);

			session = mirror.getSession("copilot:/s1")!;
			const mdPart = session.activeTurn!.responseParts.find(
				(p) => p.kind === ResponsePartKind.Markdown && p.id === "part-1",
			);
			expect(mdPart).toBeDefined();
			expect((mdPart as { content: string }).content).toBe("Hi there!");
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
						responseParts: [{ kind: ResponsePartKind.Markdown, id: "part-1", content: "Hi there!" }],
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
			const mdParts = session.turns[0].responseParts.filter((p) => p.kind === ResponsePartKind.Markdown);
			expect(mdParts).toHaveLength(1);
			expect((mdParts[0] as { content: string }).content).toBe("Hi there!");
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
						responseParts: [],
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
			const tcPart = session.activeTurn!.responseParts.find(
				(p) => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === "tc1",
			);
			expect(tcPart).toBeDefined();
			const tc = (tcPart as { toolCall: { status: string; toolName: string } }).toolCall;
			expect(tc.status).toBe(ToolCallStatus.Streaming);
			expect(tc.toolName).toBe("readFile");
		});

		describe("pending messages", () => {
			it("sets a steering message", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Steering,
							id: "s1",
							userMessage: { text: "steer this" },
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.steeringMessage).toBeDefined();
				expect(session.steeringMessage!.id).toBe("s1");
				expect(session.steeringMessage!.userMessage.text).toBe("steer this");
			});

			it("sets a queued message", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "queued msg" },
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].id).toBe("q1");
			});

			it("appends multiple queued messages", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "first" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q2",
							userMessage: { text: "second" },
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(2);
			});

			it("updates existing queued message by id", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "original" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "updated" },
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].userMessage.text).toBe("updated");
			});

			it("removes a steering message", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Steering,
							id: "s1",
							userMessage: { text: "steer" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageRemoved,
							session: "copilot:/s1",
							kind: PendingMessageKind.Steering,
							id: "s1",
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.steeringMessage).toBeUndefined();
			});

			it("removes a queued message", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "first" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q2",
							userMessage: { text: "second" },
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageRemoved,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
						},
						3,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].id).toBe("q2");
			});

			it("ignores removal of non-matching steering message", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Steering,
							id: "s1",
							userMessage: { text: "steer" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageRemoved,
							session: "copilot:/s1",
							kind: PendingMessageKind.Steering,
							id: "s2",
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.steeringMessage).toBeDefined();
			});

			it("reorders queued messages", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "first" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q2",
							userMessage: { text: "second" },
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q3",
							userMessage: { text: "third" },
						},
						3,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionQueuedMessagesReordered,
							session: "copilot:/s1",
							order: ["q3", "q1", "q2"],
						},
						4,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages!.map((m) => m.id)).toEqual(["q3", "q1", "q2"]);
			});

			it("preserves unlisted messages during reorder", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q1",
							userMessage: { text: "first" },
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q2",
							userMessage: { text: "second" },
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionPendingMessageSet,
							session: "copilot:/s1",
							kind: PendingMessageKind.Queued,
							id: "q3",
							userMessage: { text: "third" },
						},
						3,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionQueuedMessagesReordered,
							session: "copilot:/s1",
							order: ["q2"],
						},
						4,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages!.map((m) => m.id)).toEqual(["q2", "q1", "q3"]);
			});
		});

		describe("customizations", () => {
			it("sets customizations via SessionCustomizationsChanged", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							session: "copilot:/s1",
							customizations: [
								{ customization: { uri: "https://example.com/plugin", displayName: "Test Plugin" }, enabled: true },
							],
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations).toHaveLength(1);
				expect(session.customizations![0].enabled).toBe(true);
			});

			it("replaces customizations on second change", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							session: "copilot:/s1",
							customizations: [{ customization: { uri: "https://example.com/a", displayName: "A" }, enabled: true }],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							session: "copilot:/s1",
							customizations: [
								{ customization: { uri: "https://example.com/b", displayName: "B" }, enabled: false },
								{ customization: { uri: "https://example.com/c", displayName: "C" }, enabled: true },
							],
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations).toHaveLength(2);
				expect(session.customizations![0].customization.displayName).toBe("B");
				expect(session.customizations![1].customization.displayName).toBe("C");
			});

			it("toggles a customization", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							session: "copilot:/s1",
							customizations: [
								{ customization: { uri: "https://example.com/plugin", displayName: "Test Plugin" }, enabled: true },
							],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationToggled,
							session: "copilot:/s1",
							uri: "https://example.com/plugin",
							enabled: false,
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations![0].enabled).toBe(false);
			});

			it("ignores toggle for unknown customization URI", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							session: "copilot:/s1",
							customizations: [
								{ customization: { uri: "https://example.com/plugin", displayName: "Test Plugin" }, enabled: true },
							],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationToggled,
							session: "copilot:/s1",
							uri: "https://example.com/unknown",
							enabled: false,
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations![0].enabled).toBe(true);
			});

			it("ignores toggle when no customizations set", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationToggled,
							session: "copilot:/s1",
							uri: "https://example.com/plugin",
							enabled: false,
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations).toBeUndefined();
			});
		});

		describe("truncation", () => {
			it("clears all turns when turnId is undefined", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						turns: [
							{
								id: "t1",
								userMessage: { text: "msg1" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								userMessage: { text: "msg2" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
						],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTruncated,
							session: "copilot:/s1",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.turns).toHaveLength(0);
				expect(session.activeTurn).toBeUndefined();
				expect(session.summary.status).toBe(SessionStatus.Idle);
			});

			it("keeps turns up to and including specified turnId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						turns: [
							{
								id: "t1",
								userMessage: { text: "msg1" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								userMessage: { text: "msg2" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t3",
								userMessage: { text: "msg3" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
						],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTruncated,
							session: "copilot:/s1",
							turnId: "t2",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.turns).toHaveLength(2);
				expect(session.turns[0].id).toBe("t1");
				expect(session.turns[1].id).toBe("t2");
			});

			it("clears activeTurn on truncation", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						turns: [
							{
								id: "t1",
								userMessage: { text: "msg1" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
						],
						activeTurn: {
							id: "t2",
							userMessage: { text: "in progress" },
							responseParts: [],
							usage: undefined,
						},
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTruncated,
							session: "copilot:/s1",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.activeTurn).toBeUndefined();
				expect(session.turns).toHaveLength(0);
			});

			it("returns state unchanged for unknown turnId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						turns: [
							{
								id: "t1",
								userMessage: { text: "msg1" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								userMessage: { text: "msg2" },
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
						],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTruncated,
							session: "copilot:/s1",
							turnId: "nonexistent",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.turns).toHaveLength(2);
			});
		});

		describe("confirmationTitle on toolCallReady", () => {
			it("stores confirmationTitle on pending confirmation tool call", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						activeTurn: {
							id: "t1",
							userMessage: { text: "Run a tool" },
							responseParts: [
								{
									kind: ResponsePartKind.ToolCall,
									toolCall: {
										toolCallId: "tc1",
										toolName: "runCommand",
										displayName: "Run Command",
										status: ToolCallStatus.Streaming,
									},
								},
							],
							usage: undefined,
						},
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionToolCallReady,
							session: "copilot:/s1",
							turnId: "t1",
							toolCallId: "tc1",
							confirmed: undefined,
							confirmationTitle: "Run in terminal",
							invocationMessage: "Run command",
							toolInput: "ls -la",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				const tcPart = session.activeTurn!.responseParts.find(
					(p) => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === "tc1",
				);
				expect(tcPart).toBeDefined();
				const tc = (tcPart as { toolCall: { status: string; confirmationTitle?: string } }).toolCall;
				expect(tc.status).toBe(ToolCallStatus.PendingConfirmation);
				expect(tc.confirmationTitle).toBe("Run in terminal");
			});
		});

		describe("queuedMessageId on turnStarted", () => {
			it("removes steering message when turn started with matching queuedMessageId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						steeringMessage: { id: "s1", userMessage: { text: "steer" } },
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTurnStarted,
							session: "copilot:/s1",
							turnId: "t1",
							userMessage: { text: "steer" },
							queuedMessageId: "s1",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.steeringMessage).toBeUndefined();
			});

			it("removes queued message when turn started with matching queuedMessageId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						queuedMessages: [
							{ id: "q1", userMessage: { text: "first" } },
							{ id: "q2", userMessage: { text: "second" } },
						],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTurnStarted,
							session: "copilot:/s1",
							turnId: "t1",
							userMessage: { text: "first" },
							queuedMessageId: "q1",
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].id).toBe("q2");
			});

			it("does not remove messages when queuedMessageId is not provided", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeSessionState({
						lifecycle: SessionLifecycle.Ready,
						steeringMessage: { id: "s1", userMessage: { text: "steer" } },
						queuedMessages: [{ id: "q1", userMessage: { text: "queued" } }],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionTurnStarted,
							session: "copilot:/s1",
							turnId: "t1",
							userMessage: { text: "hello" },
						},
						1,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.steeringMessage).toBeDefined();
				expect(session.queuedMessages).toHaveLength(1);
			});
		});
	});

	describe("action buffering", () => {
		it("buffers actions for unknown sessions and replays them on applySnapshot", () => {
			const mirror = new StateMirror();

			// Actions arrive BEFORE the snapshot (race condition during subscribe)
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionReady,
						session: "copilot:/s1",
					},
					2,
				),
			);

			// Session should not exist yet
			expect(mirror.getSession("copilot:/s1")).toBeUndefined();

			// Now the snapshot arrives (subscribe response)
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Creating }),
				fromSeq: 1,
			});

			// The buffered SessionReady action should have been replayed
			const session = mirror.getSession("copilot:/s1")!;
			expect(session).toBeDefined();
			expect(session.lifecycle).toBe(SessionLifecycle.Ready);
		});

		it("replays multiple buffered actions in order", () => {
			const mirror = new StateMirror();

			// Multiple actions arrive before snapshot
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionTurnStarted,
						session: "copilot:/s1",
						turnId: "t1",
						userMessage: { text: "Hello" },
					},
					2,
				),
			);
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionResponsePart,
						session: "copilot:/s1",
						turnId: "t1",
						part: { kind: ResponsePartKind.Markdown, id: "part-1", content: "" },
					},
					3,
				),
			);
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionDelta,
						session: "copilot:/s1",
						turnId: "t1",
						partId: "part-1",
						content: "Hello world",
					},
					4,
				),
			);

			// Snapshot arrives with fromSeq=1 (all buffered actions are newer)
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Ready }),
				fromSeq: 1,
			});

			const session = mirror.getSession("copilot:/s1")!;
			expect(session.activeTurn).toBeDefined();
			expect(session.activeTurn!.id).toBe("t1");
			const mdPart = session.activeTurn!.responseParts.find(
				(p) => p.kind === ResponsePartKind.Markdown && p.id === "part-1",
			);
			expect(mdPart).toBeDefined();
			expect((mdPart as { content: string }).content).toBe("Hello world");
		});

		it("skips buffered actions with serverSeq <= snapshot.fromSeq", () => {
			const mirror = new StateMirror();

			// Action arrives at seq=1
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionReady,
						session: "copilot:/s1",
					},
					1,
				),
			);

			// Snapshot arrives with fromSeq=2 (already includes the action)
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Creating }),
				fromSeq: 2,
			});

			// The SessionReady should NOT have been replayed (seq 1 <= fromSeq 2)
			const session = mirror.getSession("copilot:/s1")!;
			expect(session.lifecycle).toBe(SessionLifecycle.Creating);
		});

		it("clears the action buffer on removeSession", () => {
			const mirror = new StateMirror();

			// Buffer an action
			mirror.applyAction(
				envelope(
					{
						type: ActionType.SessionReady,
						session: "copilot:/s1",
					},
					2,
				),
			);

			// Remove before snapshot arrives
			mirror.removeSession("copilot:/s1");

			// Now apply snapshot — the buffered action should be gone
			mirror.applySnapshot({
				resource: "copilot:/s1",
				state: makeSessionState({ lifecycle: SessionLifecycle.Creating }),
				fromSeq: 1,
			});

			const session = mirror.getSession("copilot:/s1")!;
			expect(session.lifecycle).toBe(SessionLifecycle.Creating);
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
