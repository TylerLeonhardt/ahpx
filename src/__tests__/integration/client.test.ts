/**
 * Integration tests — the low-level `AhpClient` (the CLI's client surface) and
 * the real `TurnController` against a mock AHP server over an actual WebSocket.
 *
 * These tests exercise the full stack the CLI uses: ahpx's thin adapter wraps
 * the OFFICIAL `@microsoft/agent-host-protocol` client, which speaks real
 * JSON-RPC over a real `ws` socket to the mock server. Turns are driven exactly
 * the way the CLI drives them — `createSession` + `subscribe` to open a session,
 * then a `TurnController` to run each prompt (which dispatches `chat/turnStarted`
 * and routes streamed actions through the renderer + permission handler).
 *
 * No mocking of client internals; the dead `SessionHandle`/`openSession` SDK is
 * gone, so coverage now targets what the CLI actually runs.
 */

import { randomUUID } from "node:crypto";
import type { URI } from "@microsoft/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AhpClient } from "../../client/index.js";
import { PromptRenderer } from "../../output/renderer.js";
import type { WritableOutput } from "../../output/renderer.js";
import { PermissionHandler } from "../../permissions/handler.js";
import type { PermissionMode } from "../../permissions/handler.js";
import { TurnController } from "../../prompt/controller.js";
import type { TurnResult } from "../../prompt/controller.js";
import { type MockServer, createMockServer, echoScenario, toolCallScenario } from "../helpers/mock-server.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Wait for a client event with timeout. */
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

/** Capture renderer/permission output to a string buffer. */
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

/**
 * Open a session the way the CLI does: `createSession` + `subscribe`, then
 * subscribe to the default chat channel if the host puts it on a distinct URI.
 * The subscribe snapshot carries `lifecycle: "ready"`, so the session is ready
 * to prompt once this resolves.
 */
async function openSession(
	client: AhpClient,
	provider = "mock-agent",
	model?: string,
): Promise<{ uri: URI; chatUri: URI; model?: string }> {
	const uri: URI = `${provider}:/${randomUUID()}`;
	await client.createSession(uri, provider, model);
	await client.subscribe(uri);

	let chatUri = uri;
	const defaultChat = client.state.getSession(uri)?.defaultChat;
	if (defaultChat && defaultChat !== uri) {
		await client.subscribe(defaultChat);
		chatUri = defaultChat;
	}
	return { uri, chatUri, model };
}

/**
 * Run a single turn through the real `TurnController` (the CLI's turn path) and
 * return the structured result plus captured render output.
 */
async function runTurn(
	client: AhpClient,
	session: { uri: URI; chatUri: URI; model?: string },
	text: string,
	opts: { permission?: PermissionMode; idleTimeout?: number } = {},
): Promise<{ result: TurnResult; output: string }> {
	const cap = createCapture();
	const renderer = new PromptRenderer(cap.out);
	const handler = new PermissionHandler(opts.permission ?? "approve-all", { output: cap.out });
	const controller = new TurnController(client, session.uri, renderer, handler, session.chatUri, session.model);
	const result = await controller.prompt(
		text,
		undefined,
		opts.idleTimeout ? { idleTimeout: opts.idleTimeout } : undefined,
	);
	return { result, output: cap.text() };
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

			expect(client.connected).toBe(true);
			expect(result.snapshots.length).toBeGreaterThan(0);
		});

		it("populates state mirror with agents from root snapshot", async () => {
			server = await createMockServer();
			client = new AhpClient();

			await client.connect(server.url);

			expect(client.state.root.agents.length).toBeGreaterThan(0);
		});

		it("uses custom initialSubscriptions", async () => {
			server = await createMockServer();
			client = new AhpClient({ initialSubscriptions: ["ahp-root://"] });

			const result = await client.connect(server.url);
			expect(result.snapshots.length).toBeGreaterThan(0);
		});

		it("emits connected event", async () => {
			server = await createMockServer();
			client = new AhpClient();

			const connectedPromise = waitForEvent(client, "connected");
			await client.connect(server.url);

			await expect(connectedPromise).resolves.toBeDefined();
		});

		it("rejects connection to non-existent server", async () => {
			client = new AhpClient({ connectTimeout: 500 });

			await expect(client.connect("ws://127.0.0.1:1")).rejects.toThrow();
		});
	});

	// ── 2. Session creation ──────────────────────────────────────────

	describe("session creation", () => {
		it("opens a session and reaches ready", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const { uri } = await openSession(client, "mock-agent");

			expect(uri).toContain("mock-agent:/");
			expect(client.state.getSession(uri)?.lifecycle).toBe("ready");
		});

		it("session state is available in state mirror", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const { uri } = await openSession(client, "mock-agent");

			const sessionState = client.state.getSession(uri);
			expect(sessionState).toBeDefined();
			expect(sessionState!.provider).toBe("mock-agent");
			expect(sessionState!.lifecycle).toBe("ready");
		});

		it("disposes a session", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const { uri } = await openSession(client, "mock-agent");
			await client.disposeSession(uri);

			expect(client.state.getSession(uri)).toBeUndefined();
		});

		it("passes the per-message model on the turn (0.5.0 wire shape)", async () => {
			let seenModel: string | undefined;
			server = await createMockServer({
				onDispatchAction(params, ctx) {
					const action = params.action as Record<string, unknown>;
					if (action.type === "chat/turnStarted") {
						const sessionUri = action.session as string;
						const turnId = action.turnId as string;
						const message = action.message as { model?: { id: string } };
						seenModel = message.model?.id;
						ctx.sendAction({ type: "chat/turnComplete", session: sessionUri, turnId });
					}
				},
			});
			client = new AhpClient();
			await client.connect(server.url);

			const session = await openSession(client, "mock-agent", "mock-model");
			const { result } = await runTurn(client, session, "hello");

			expect(result.state).toBe("complete");
			expect(seenModel).toBe("mock-model");
		});

		it("session appears in listSessions", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			await openSession(client, "mock-agent");

			const result = await client.listSessions();
			expect(result.items).toHaveLength(1);
			expect(result.items[0].provider).toBe("mock-agent");
		});

		it("multiple sessions are tracked by the server", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const s1 = await openSession(client, "mock-agent");
			const s2 = await openSession(client, "mock-agent");

			expect(s1.uri).not.toBe(s2.uri);

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
			const session = await openSession(client, "mock-agent");

			const { result } = await runTurn(client, session, "Hello world");

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("Hello");
			expect(result.responseText).toContain("world");
			expect(result.turnId).toBeTruthy();
		});

		it("reports usage info", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const { result } = await runTurn(client, session, "test message");

			expect(result.usage).toBeDefined();
			expect(result.usage!.inputTokens).toBe(10);
			expect(result.usage!.outputTokens).toBeGreaterThan(0);
			expect(result.usage!.model).toBe("mock-model");
		});

		it("handles multiple turns sequentially", async () => {
			server = await createMockServer(echoScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const { result: r1 } = await runTurn(client, session, "first");
			const { result: r2 } = await runTurn(client, session, "second");

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
			const session = await openSession(client, "mock-agent");

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				if (action.type.startsWith("chat/")) actions.push(action.type);
			});

			await runTurn(client, session, "hello");

			expect(actions).toContain("chat/turnStarted");
			expect(actions).toContain("chat/delta");
			expect(actions).toContain("chat/turnComplete");
		});
	});

	// ── 4. Tool call confirmation (via PermissionHandler) ────────────

	describe("tool call confirmation", () => {
		it("approves a tool call with approve-all", async () => {
			server = await createMockServer(toolCallScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const { result } = await runTurn(client, session, "edit the file", { permission: "approve-all" });

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("Done!");
			expect(result.toolCalls).toBeGreaterThanOrEqual(1);
		});

		it("denies a tool call with deny-all", async () => {
			server = await createMockServer(toolCallScenario());
			client = new AhpClient();
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const { result } = await runTurn(client, session, "edit the file", { permission: "deny-all" });

			expect(result.state).toBe("complete");
			expect(result.responseText).toContain("denied");
		});
	});

	// ── 5. Server-confirmed / client tool calls ──────────────────────

	describe("server-confirmed tool calls", () => {
		it("client-owned tool (matching clientId) is NOT auto-approve-rendered", async () => {
			// A tool contributed by THIS client is executed by us, so the
			// controller skips the confirmation/permission path entirely and does
			// not render an "[auto-approved]" indicator. (Contrast with the
			// server-auto-confirmed case below, which does.) The mock never
			// completes the turn without a confirmation, so the turn idles out.
			const myClientId = randomUUID();

			server = await createMockServer(
				toolCallScenario({
					confirmed: "not-needed",
					toolClientId: myClientId,
				}),
			);
			client = new AhpClient({ clientId: myClientId });
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				actions.push(action.type);
			});

			const { result, output } = await runTurn(client, session, "run tool", { idleTimeout: 500 });

			expect(actions).toContain("chat/toolCallStart");
			expect(actions).toContain("chat/toolCallReady");
			// Client-owned tools are NOT surfaced as auto-approved.
			expect(output).not.toContain("auto-approved");
			expect(result.state).toBe("idle_timeout");
		});

		it("server-auto-confirmed tool renders an auto-approved indicator", async () => {
			server = await createMockServer(
				toolCallScenario({
					confirmed: "not-needed",
					// No matching toolClientId — server-side auto-confirmed tool.
				}),
			);
			client = new AhpClient();
			await client.connect(server.url);
			const session = await openSession(client, "mock-agent");

			const actions: string[] = [];
			client.on("action", (envelope) => {
				const action = envelope.action as unknown as { type: string };
				actions.push(action.type);
			});

			const { result, output } = await runTurn(client, session, "run tool", { idleTimeout: 500 });

			expect(actions).toContain("chat/toolCallStart");
			expect(actions).toContain("chat/toolCallReady");
			// A server-auto-confirmed tool (not owned by this client) surfaces
			// the auto-approved indicator — the distinguishing behavior from the
			// client-owned case above.
			expect(output).toContain("auto-approved");
			expect(result.state).toBe("idle_timeout");
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

			await openSession(client, "mock-agent");
			await openSession(client, "mock-agent");

			const result = await client.listSessions();
			expect(result.items).toHaveLength(2);
		});

		it("session state is accessible via state mirror", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const { uri } = await openSession(client, "mock-agent");
			const state = client.state.getSession(uri);

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

	// ── 8. Disconnect ────────────────────────────────────────────────

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
			// Attach the rejection expectation *before* disconnecting so the
			// handler is registered when shutdown rejects the pending request
			// with ClientClosedError (otherwise it surfaces as a transient
			// unhandled rejection).
			const assertion = expect(pending).rejects.toThrow();

			// Disconnect while request is pending
			await client.disconnect();

			await assertion;
		});
	});

	// ── 9. Error handling ────────────────────────────────────────────

	describe("error handling", () => {
		it("creates a session successfully (low-level path)", async () => {
			server = await createMockServer();
			client = new AhpClient();
			await client.connect(server.url);

			const { uri } = await openSession(client, "mock-agent");
			expect(client.state.getSession(uri)).toBeDefined();
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

			// The mock server handler will crash, causing an error response.
			// This exercises the transport/protocol error path.
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
			const session = await openSession(client, "mock-agent");

			const { result } = await runTurn(client, session, "test");

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

			const { uri } = await openSession(client, "mock-agent");
			const result = await client.fetchTurns(uri);

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
