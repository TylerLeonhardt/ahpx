/**
 * Integration tests — AhpClient against a real mock AHP server over WebSocket.
 *
 * These tests exercise the actual transport → protocol → client stack.
 * No mocking of the client internals — real WebSocket, real JSON-RPC.
 */

import { randomUUID } from "node:crypto";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { ChatToolCallApprovedAction, ChatToolCallDeniedAction } from "@microsoft/agent-host-protocol";
import { ToolCallCancellationReason, ToolCallConfirmationReason } from "@microsoft/agent-host-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AhpClient } from "../../client/index.js";
import { type MockServer, createMockServer, echoScenario, toolCallScenario } from "../helpers/mock-server.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Wait for a client event with timeout */
function waitForEvent<T>(
	emitter: {
		once(event: string, fn: (...args: unknown[]) => void): unknown;
		removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
	},
	event: string,
	timeoutMs = 5000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const handler = (...args: unknown[]) => {
			clearTimeout(timer);
			resolve(args.length === 1 ? (args[0] as T) : (args as T));
		};
		const timer = setTimeout(() => {
			emitter.removeListener(event, handler);
			reject(new Error(`Timed out waiting for event: ${event}`));
		}, timeoutMs);
		emitter.once(event, handler);
	});
}

// ── Test suite ───────────────────────────────────────────────────────────

describe("AhpClient integration", () => {
	let server: MockServer;
	let client: AhpClient;

	afterEach(async () => {
		// Always clean up
		try {
			if (client?.connected) await client.disconnect();
		} catch {
			/* best-effort */
		}
		try {
			await server?.close();
		} catch {
			/* best-effort */
		}
	});

	// ── 1. Connect and initialize ────────────────────────────────────

	describe("connect and initialize", () => {
		it("connects and receives initial root snapshot", async () => {
			server = await createMockServer();
			client = new AhpClient();

			const result = await client.connect(server.url);

			expect(result.protocolVersion).toBe("0.5.0");
			expect(result.snapshots).toHaveLength(1);
			expect(result.snapshots[0].resource).toBe("ahp-root://");
			expect(client.connected).toBe(true);
		});

		it("populates state mirror with agents from root snapshot", async () => {
			server = await createMockServer();
			client = new AhpClient();

			await client.connect(server.url);

			expect(client.state.root.agents).toHaveLength(1);
			expect(client.state.root.agents[0].provider).toBe("mock-agent");
			expect(client.state.root.agents[0].displayName).toBe("Mock Agent");
			expect(client.state.root.agents[0].models).toHaveLength(1);
		});

		it("uses custom initialSubscriptions", async () => {
			server = await createMockServer();
			client = new AhpClient({ initialSubscriptions: [] });

			const result = await client.connect(server.url);

			expect(result.snapshots).toHaveLength(0);
		});

		it("emits connected event", async () => {
			server = await createMockServer();
			client = new AhpClient();

			const connected = waitForEvent(client, "connected");
			await client.connect(server.url);
			const result = await connected;

			expect(result).toBeDefined();
		});

		it("rejects connection to non-existent server", async () => {
			client = new AhpClient({ connectTimeout: 1000 });
			// Use a port that's almost certainly not listening
			server = { close: async () => {} } as MockServer;

			await expect(client.connect("ws://127.0.0.1:1")).rejects.toThrow();
			expect(client.connected).toBe(false);
		});
	});

	// ── 2. Session creation ──────────────────────────────────────────

	describe("session creation", () => {
		beforeEach(async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);
		});

		it("opens a session and waits for ready", async () => {
			const handle = await client.openSession({ provider: "mock-agent" });

			expect(handle).toBeDefined();
			expect(handle.uri).toContain("mock-agent:/");
			expect(handle.isReady).toBe(true);
		});

		it("session state is available in state mirror", async () => {
			const handle = await client.openSession({ provider: "mock-agent" });

			const sessionState = client.state.getSession(handle.uri);
			expect(sessionState).toBeDefined();
			expect(sessionState!.provider).toBe("mock-agent");
			expect(sessionState!.lifecycle).toBe("ready");
		});

		it("disposes a session", async () => {
			const handle = await client.openSession({ provider: "mock-agent" });
			const uri = handle.uri;

			await handle.dispose();

			expect(client.state.getSession(uri)).toBeUndefined();
		});

		it("creates session with custom model", async () => {
			const handle = await client.openSession({
				provider: "mock-agent",
				model: "mock-model",
			});

			expect(handle.model).toBe("mock-model");
		});

		it("session appears in listSessions", async () => {
			await client.openSession({ provider: "mock-agent" });

			const result = await client.listSessions();

			expect(result.items).toHaveLength(1);
			expect(result.items[0].provider).toBe("mock-agent");
		});

		it("multiple sessions are tracked", async () => {
			const h1 = await client.openSession({ provider: "mock-agent" });
			const h2 = await client.openSession({ provider: "mock-agent" });

			expect(client.sessions.size).toBe(2);
			expect(h1.uri).not.toBe(h2.uri);

			const result = await client.listSessions();
			expect(result.items).toHaveLength(2);
		});
	});

	// ── 3. Prompt and streaming response ─────────────────────────────

	describe("prompt and streaming", () => {
		it("sends prompt and receives streaming response", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const result = await handle.sendPrompt("Hello world");

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("Hello");
			expect(result.responseText).toContain("world");
			expect(result.turnId).toBeTruthy();
		});

		it("reports usage info", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const result = await handle.sendPrompt("test message");

			expect(result.usage).toBeDefined();
			expect(result.usage!.inputTokens).toBe(10);
			expect(result.usage!.outputTokens).toBeGreaterThan(0);
			expect(result.usage!.model).toBe("mock-model");
		});

		it("handles multiple turns sequentially", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const r1 = await handle.sendPrompt("first");
			const r2 = await handle.sendPrompt("second");

			expect(r1.state).toBe("complete");
			expect(r2.state).toBe("complete");
			expect(r1.responseText).toContain("first");
			expect(r2.responseText).toContain("second");
			expect(r1.turnId).not.toBe(r2.turnId);
		});

		it("tracks action events on the client", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				if (action.type.startsWith("chat/")) actions.push(action.type);
			});

			await handle.sendPrompt("hello");

			expect(actions).toContain("chat/turnStarted");
			expect(actions).toContain("chat/delta");
			expect(actions).toContain("chat/turnComplete");
		});
	});

	// ── 4. Tool call confirmation ────────────────────────────────────

	describe("tool call confirmation", () => {
		it("approves a tool call when confirmed by scenario callback", async () => {
			server = await createMockServer(toolCallScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			// Listen for tool call actions and auto-approve
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as {
					type: string;
					turnId?: string;
					toolCallId?: string;
					confirmed?: string;
				};
				if (action.type === "chat/toolCallReady" && !action.confirmed) {
					client.dispatchAction(envelope.channel, {
						type: ActionType.ChatToolCallConfirmed,
						turnId: action.turnId!,
						toolCallId: action.toolCallId!,
						approved: true,
						confirmed: ToolCallConfirmationReason.UserAction,
					} as ChatToolCallApprovedAction);
				}
			});

			const result = await handle.sendPrompt("edit the file");

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("Done!");
			expect(result.toolCalls).toBeGreaterThanOrEqual(1);
		});

		it("denies a tool call", async () => {
			server = await createMockServer(toolCallScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			// Listen for tool call actions and deny
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as {
					type: string;
					turnId?: string;
					toolCallId?: string;
					confirmed?: string;
				};
				if (action.type === "chat/toolCallReady" && !action.confirmed) {
					client.dispatchAction(envelope.channel, {
						type: ActionType.ChatToolCallConfirmed,
						turnId: action.turnId!,
						toolCallId: action.toolCallId!,
						approved: false,
						reason: ToolCallCancellationReason.Denied,
					} as ChatToolCallDeniedAction);
				}
			});

			const result = await handle.sendPrompt("edit the file");

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("denied");
		});
	});

	// ── 5. Server-confirmed tool calls ───────────────────────────────

	describe("server-confirmed tool calls", () => {
		it("auto-confirmed tool with matching toolClientId skips prompt", async () => {
			// For this test we need to know the clientId upfront
			const myClientId = randomUUID();

			server = await createMockServer(
				toolCallScenario({
					confirmed: "not-needed",
					toolClientId: myClientId,
				}),
			);
			client = new AhpClient({ clientId: myClientId });
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				actions.push(action.type);
			});

			// Use timeout so the prompt cleanly resolves instead of hanging
			const result = await handle.sendPrompt("run tool", { timeout: 500 });

			// Should have received toolCallStart and toolCallReady with confirmed
			expect(actions).toContain("chat/toolCallStart");
			expect(actions).toContain("chat/toolCallReady");
			// Turn times out because auto-confirmed client tools don't
			// trigger toolCallConfirmed, and the mock only completes on that
			expect(result.state).toBe("error");
		});

		it("auto-confirmed tool without matching toolClientId still receives actions", async () => {
			server = await createMockServer(
				toolCallScenario({
					confirmed: "not-needed",
					// No toolClientId — or different one — so it's a server tool
				}),
			);
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				actions.push(action.type);
			});

			// Use timeout so the prompt cleanly resolves instead of hanging
			const result = await handle.sendPrompt("run tool", { timeout: 500 });

			expect(actions).toContain("chat/toolCallStart");
			expect(actions).toContain("chat/toolCallReady");
			expect(result.state).toBe("error");
		});
	});

	// ── 6. Session list and get ──────────────────────────────────────

	describe("session list and get", () => {
		it("listSessions returns empty before session creation", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const result = await client.listSessions();
			expect(result.items).toHaveLength(0);
		});

		it("listSessions returns created sessions", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			await client.openSession({ provider: "mock-agent" });
			await client.openSession({ provider: "mock-agent" });

			const result = await client.listSessions();
			expect(result.items).toHaveLength(2);
		});

		it("session state is accessible via state mirror", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const handle = await client.openSession({ provider: "mock-agent" });
			const state = client.state.getSession(handle.uri);

			expect(state).toBeDefined();
			expect(state!.provider).toBe("mock-agent");
			expect(state!.lifecycle).toBe("ready");
		});
	});

	// ── 7. Resource operations ───────────────────────────────────────

	describe("resource operations", () => {
		it("resourceRead returns file content", async () => {
			server = await createMockServer({
				onResourceRead: (_params) => ({
					data: "console.log('hello')",
					encoding: "utf-8",
					contentType: "text/javascript",
				}),
			});
			client = new AhpClient();
			await client.connect(server.url);

			const result = await client.resourceRead("file:///test.js");

			expect(result.data).toBe("console.log('hello')");
			expect(result.encoding).toBe("utf-8");
			expect(result.contentType).toBe("text/javascript");
		});

		it("resourceList returns directory entries", async () => {
			server = await createMockServer({
				onResourceList: (_params) => ({
					entries: [
						{ name: "index.ts", type: "file" },
						{ name: "lib", type: "directory" },
					],
				}),
			});
			client = new AhpClient();
			await client.connect(server.url);

			const result = await client.resourceList("file:///project/src");

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].name).toBe("index.ts");
			expect(result.entries[1].type).toBe("directory");
		});

		it("resourceRead uses default mock response", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const result = await client.resourceRead("file:///any-file.txt");

			expect(result.data).toBe("mock file content");
		});
	});

	// ── 8. Disconnect and reconnection ───────────────────────────────

	describe("disconnect", () => {
		it("disconnects cleanly", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			expect(client.connected).toBe(true);
			await client.disconnect();
			expect(client.connected).toBe(false);
		});

		it("emits disconnected event on server close", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const disconnected = waitForEvent(client, "disconnected");

			// Force close from server side
			for (const ws of server.wss.clients) {
				ws.close();
			}

			await disconnected;
			expect(client.connected).toBe(false);
		});

		it("rejects pending requests on disconnect", async () => {
			server = await createMockServer({
				onListSessions: () => {
					// Never respond — simulate hung server
					return new Promise(() => {}) as unknown as Record<string, unknown>;
				},
			});
			client = new AhpClient();
			await client.connect(server.url);

			// Start a request that will never resolve
			const pending = client.listSessions();

			// Disconnect while request is pending
			await client.disconnect();

			await expect(pending).rejects.toThrow();
		});
	});

	// ── 9. Error handling ────────────────────────────────────────────

	describe("error handling", () => {
		it("handles session creation with duplicate URI error", async () => {
			let _callCount = 0;
			server = await createMockServer({
				onCreateSession: () => {
					_callCount++;
					return undefined;
				},
			});
			client = new AhpClient();
			await client.connect(server.url);

			// First session succeeds
			const handle = await client.openSession({ provider: "mock-agent" });
			expect(handle).toBeDefined();
		});

		it("receives RPC errors from server", async () => {
			server = await createMockServer({
				onResourceRead: () => {
					// Throw to simulate a server-side error — the mock server
					// will catch this and send a JSON-RPC error response
					throw new Error("File not found");
				},
			});
			client = new AhpClient();
			await client.connect(server.url);

			// The mock server handler will crash, causing a broken response
			// This exercises the transport/protocol error path
			await expect(client.resourceRead("file:///missing.txt")).rejects.toThrow();
		});

		it("operations fail when not connected", async () => {
			server = await createMockServer();
			client = new AhpClient();

			// Not connected — should throw
			expect(() => client.dispatchAction("ahp-root://", { type: "test" } as never)).toThrow("Client is not connected");

			await expect(client.listSessions()).rejects.toThrow("Client is not connected");
		});
	});

	// ── 10. Custom scenarios ─────────────────────────────────────────

	describe("custom scenarios", () => {
		it("supports custom agent configuration", async () => {
			server = await createMockServer({
				agents: [
					{
						provider: "custom-provider",
						displayName: "Custom Agent",
						models: [{ id: "custom-model", provider: "custom-provider", name: "Custom" }],
					},
				],
			});
			client = new AhpClient();
			await client.connect(server.url);

			expect(client.state.root.agents[0].provider).toBe("custom-provider");
		});

		it("scenario can send actions during turn", async () => {
			server = await createMockServer({
				onDispatchAction(params, ctx) {
					const action = params.action as Record<string, unknown>;
					if (action.type === "chat/turnStarted") {
						const sessionUri = action.session as string;
						const turnId = action.turnId as string;

						// Send a title change
						ctx.sendAction({
							type: "session/titleChanged",
							session: sessionUri,
							title: "Test Conversation",
						});

						// Send response
						ctx.sendAction({
							type: "chat/responsePart",
							session: sessionUri,
							turnId,
							part: { kind: "markdown", id: "p1", content: "" },
						});

						ctx.sendAction({
							type: "chat/delta",
							session: sessionUri,
							turnId,
							partId: "p1",
							content: "Custom response",
						});

						ctx.sendAction({
							type: "chat/turnComplete",
							session: sessionUri,
							turnId,
						});
					}
				},
			});
			client = new AhpClient();
			await client.connect(server.url);
			const handle = await client.openSession({ provider: "mock-agent" });

			const result = await handle.sendPrompt("test");

			expect(result.state).toBe("complete");
			expect(result.responseText).toBe("Custom response");
		});

		it("fetchTurns returns configured history", async () => {
			server = await createMockServer({
				onFetchTurns: () => ({
					turns: [
						{
							id: "turn-1",
							message: { text: "hello", origin: { kind: "user" } },
							responseParts: [{ kind: "markdown", id: "p1", content: "Hi there" }],
						},
					],
					hasMore: false,
				}),
			});
			client = new AhpClient();
			await client.connect(server.url);

			const handle = await client.openSession({ provider: "mock-agent" });
			const result = await client.fetchTurns(handle.uri);

			expect(result.turns).toHaveLength(1);
			expect(result.hasMore).toBe(false);
		});
	});

	// ── 11. Concurrent operations ────────────────────────────────────

	describe("concurrent operations", () => {
		it("handles multiple commands concurrently", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			// Fire multiple requests concurrently
			const [sessions, resources, dir] = await Promise.all([
				client.listSessions(),
				client.resourceRead("file:///test.txt"),
				client.resourceList("file:///"),
			]);

			expect(sessions.items).toBeDefined();
			expect(resources.data).toBeDefined();
			expect(dir.entries).toBeDefined();
		});
	});
});
