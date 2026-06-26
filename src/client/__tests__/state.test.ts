import { ActionType } from "@microsoft/agent-host-protocol";
import type { ActionEnvelope } from "@microsoft/agent-host-protocol";
import {
	MessageKind,
	PendingMessageKind,
	ResponsePartKind,
	SessionLifecycle,
	SessionStatus,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import type { ChatState, Message, SessionState, Snapshot } from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";
import { StateMirror } from "../state.js";

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
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
		chats: [],
		...overrides,
	};
}

function message(text: string): Message {
	return { text, origin: { kind: MessageKind.User } };
}

function makeChatState(overrides: Partial<ChatState> = {}): ChatState {
	return {
		resource: "copilot:/s1",
		title: "Test Session",
		status: SessionStatus.Idle,
		modifiedAt: "2026-01-01T00:00:00.000Z",
		turns: [],
		...overrides,
	};
}

type Customization = NonNullable<SessionState["customizations"]>[number];

function pluginCustomization(
	id: string,
	name: string,
	enabled: boolean,
	uri = `https://example.com/${id}`,
): Customization {
	return { id, type: "plugin", uri, name, enabled } as Customization;
}

function envelope(
	action: ActionEnvelope["action"],
	seq: number,
	channel = action.type.startsWith("root/") ? "ahp-root://" : "copilot:/s1",
): ActionEnvelope {
	return { channel, action, serverSeq: seq, origin: undefined };
}

describe("StateMirror", () => {
	describe("snapshots", () => {
		it("applies a root snapshot", () => {
			const mirror = new StateMirror();
			const snapshot: Snapshot = {
				resource: "ahp-root://",
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
			const snapshot: Snapshot = {
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
						type: ActionType.ChatTurnStarted,
						turnId: "t1",
						message: message("Hello"),
					},
					1,
				),
			);

			// Delta arrives BEFORE the SessionResponsePart — should be a no-op
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatDelta,
						turnId: "t1",
						partId: "part-1",
						content: "First words",
					},
					2,
				),
			);

			const session = mirror.getChat("copilot:/s1")!;
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
						type: ActionType.ChatTurnStarted,
						turnId: "t1",
						message: message("Hello"),
					},
					1,
				),
			);

			// SessionResponsePart creates the part first
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatResponsePart,
						turnId: "t1",
						part: { kind: ResponsePartKind.Markdown, id: "part-1", content: "" },
					},
					2,
				),
			);

			let session = mirror.getChat("copilot:/s1")!;
			expect(session.activeTurn!.responseParts).toHaveLength(1);

			// Now delta appends to the existing part
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatDelta,
						turnId: "t1",
						partId: "part-1",
						content: "Hello world",
					},
					3,
				),
			);

			session = mirror.getChat("copilot:/s1")!;
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
						type: ActionType.ChatTurnStarted,
						turnId: "t1",
						message: message("Hello"),
					},
					1,
				),
			);

			let session = mirror.getChat("copilot:/s1")!;
			expect(session.activeTurn).toBeDefined();
			expect(session.activeTurn!.id).toBe("t1");
			expect(session.status).toBe(SessionStatus.InProgress);

			// Add a markdown response part
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatResponsePart,
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
						type: ActionType.ChatDelta,
						turnId: "t1",
						partId: "part-1",
						content: "Hi there!",
					},
					3,
				),
			);

			session = mirror.getChat("copilot:/s1")!;
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
				state: makeChatState({
					activeTurn: {
						id: "t1",
						message: message("Hello"),
						responseParts: [{ kind: ResponsePartKind.Markdown, id: "part-1", content: "Hi there!" }],
						usage: undefined,
					},
				}),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatTurnComplete,
						turnId: "t1",
					},
					3,
				),
			);

			const session = mirror.getChat("copilot:/s1")!;
			expect(session.activeTurn).toBeUndefined();
			expect(session.turns).toHaveLength(1);
			expect(session.turns[0].id).toBe("t1");
			const mdParts = session.turns[0].responseParts.filter((p) => p.kind === ResponsePartKind.Markdown);
			expect(mdParts).toHaveLength(1);
			expect((mdParts[0] as { content: string }).content).toBe("Hi there!");
			expect(session.status).toBe(SessionStatus.Idle);
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
				state: makeChatState({
					activeTurn: {
						id: "t1",
						message: message("Run a tool"),
						responseParts: [],
						usage: undefined,
					},
				}),
				fromSeq: 0,
			});

			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatToolCallStart,
						turnId: "t1",
						toolCallId: "tc1",
						toolName: "readFile",
						displayName: "Read File",
					},
					1,
				),
			);

			const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Steering,
							id: "s1",
							message: message("steer this"),
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.steeringMessage).toBeDefined();
				expect(session.steeringMessage!.id).toBe("s1");
				expect(session.steeringMessage!.message.text).toBe("steer this");
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("queued msg"),
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("first"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q2",
							message: message("second"),
						},
						2,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("original"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("updated"),
						},
						2,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].message.text).toBe("updated");
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Steering,
							id: "s1",
							message: message("steer"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageRemoved,
							kind: PendingMessageKind.Steering,
							id: "s1",
						},
						2,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("first"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q2",
							message: message("second"),
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageRemoved,
							kind: PendingMessageKind.Queued,
							id: "q1",
						},
						3,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Steering,
							id: "s1",
							message: message("steer"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageRemoved,
							kind: PendingMessageKind.Steering,
							id: "s2",
						},
						2,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("first"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q2",
							message: message("second"),
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q3",
							message: message("third"),
						},
						3,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatQueuedMessagesReordered,
							order: ["q3", "q1", "q2"],
						},
						4,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q1",
							message: message("first"),
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q2",
							message: message("second"),
						},
						2,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatPendingMessageSet,
							kind: PendingMessageKind.Queued,
							id: "q3",
							message: message("third"),
						},
						3,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatQueuedMessagesReordered,
							order: ["q2"],
						},
						4,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
							customizations: [pluginCustomization("plugin", "Test Plugin", true, "https://example.com/plugin")],
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
							customizations: [pluginCustomization("a", "A", true, "https://example.com/a")],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationsChanged,
							customizations: [
								pluginCustomization("b", "B", false, "https://example.com/b"),
								pluginCustomization("c", "C", true, "https://example.com/c"),
							],
						},
						2,
					),
				);

				const session = mirror.getSession("copilot:/s1")!;
				expect(session.customizations).toHaveLength(2);
				expect(session.customizations![0].name).toBe("B");
				expect(session.customizations![1].name).toBe("C");
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
							customizations: [pluginCustomization("plugin", "Test Plugin", true, "https://example.com/plugin")],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationToggled,
							id: "plugin",
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
							customizations: [pluginCustomization("plugin", "Test Plugin", true, "https://example.com/plugin")],
						},
						1,
					),
				);
				mirror.applyAction(
					envelope(
						{
							type: ActionType.SessionCustomizationToggled,
							id: "unknown",
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
							id: "plugin",
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
					state: makeChatState({
						turns: [
							{
								id: "t1",
								message: message("msg1"),
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								message: message("msg2"),
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
							type: ActionType.ChatTruncated,
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.turns).toHaveLength(0);
				expect(session.activeTurn).toBeUndefined();
				expect(session.status).toBe(SessionStatus.Idle);
			});

			it("keeps turns up to and including specified turnId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						turns: [
							{
								id: "t1",
								message: message("msg1"),
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								message: message("msg2"),
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t3",
								message: message("msg3"),
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
							type: ActionType.ChatTruncated,
							turnId: "t2",
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.turns).toHaveLength(2);
				expect(session.turns[0].id).toBe("t1");
				expect(session.turns[1].id).toBe("t2");
			});

			it("clears activeTurn on truncation", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						turns: [
							{
								id: "t1",
								message: message("msg1"),
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
						],
						activeTurn: {
							id: "t2",
							message: message("in progress"),
							responseParts: [],
							usage: undefined,
						},
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatTruncated,
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.activeTurn).toBeUndefined();
				expect(session.turns).toHaveLength(0);
			});

			it("returns state unchanged for unknown turnId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						turns: [
							{
								id: "t1",
								message: message("msg1"),
								responseParts: [],
								usage: undefined,
								state: TurnState.Complete,
							},
							{
								id: "t2",
								message: message("msg2"),
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
							type: ActionType.ChatTruncated,
							turnId: "nonexistent",
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.turns).toHaveLength(2);
			});
		});

		describe("confirmationTitle on toolCallReady", () => {
			it("stores confirmationTitle on pending confirmation tool call", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						activeTurn: {
							id: "t1",
							message: message("Run a tool"),
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
							type: ActionType.ChatToolCallReady,
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

				const session = mirror.getChat("copilot:/s1")!;
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
					state: makeChatState({
						steeringMessage: { id: "s1", message: message("steer") },
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatTurnStarted,
							turnId: "t1",
							message: message("steer"),
							queuedMessageId: "s1",
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.steeringMessage).toBeUndefined();
			});

			it("removes queued message when turn started with matching queuedMessageId", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						queuedMessages: [
							{ id: "q1", message: message("first") },
							{ id: "q2", message: message("second") },
						],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatTurnStarted,
							turnId: "t1",
							message: message("first"),
							queuedMessageId: "q1",
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
				expect(session.queuedMessages).toHaveLength(1);
				expect(session.queuedMessages![0].id).toBe("q2");
			});

			it("does not remove messages when queuedMessageId is not provided", () => {
				const mirror = new StateMirror();
				mirror.applySnapshot({
					resource: "copilot:/s1",
					state: makeChatState({
						steeringMessage: { id: "s1", message: message("steer") },
						queuedMessages: [{ id: "q1", message: message("queued") }],
					}),
					fromSeq: 0,
				});

				mirror.applyAction(
					envelope(
						{
							type: ActionType.ChatTurnStarted,
							turnId: "t1",
							message: message("hello"),
						},
						1,
					),
				);

				const session = mirror.getChat("copilot:/s1")!;
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
						type: ActionType.ChatTurnStarted,
						turnId: "t1",
						message: message("Hello"),
					},
					2,
				),
			);
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatResponsePart,
						turnId: "t1",
						part: { kind: ResponsePartKind.Markdown, id: "part-1", content: "" },
					},
					3,
				),
			);
			mirror.applyAction(
				envelope(
					{
						type: ActionType.ChatDelta,
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

			const session = mirror.getChat("copilot:/s1")!;
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
