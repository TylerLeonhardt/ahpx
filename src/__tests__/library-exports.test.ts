/**
 * Library exports test — verifies the public API surface of ahpx.
 *
 * These tests ensure:
 * 1. All expected exports are accessible from the library entry point
 * 2. Classes can be instantiated
 * 3. No CLI-specific code leaks into the library
 */

import { describe, expect, it } from "vitest";

// Import everything from the library entry point
import * as ahpx from "../index.js";

describe("library exports", () => {
	describe("core client", () => {
		it("exports AhpClient class", () => {
			expect(ahpx.AhpClient).toBeDefined();
			expect(typeof ahpx.AhpClient).toBe("function");
		});

		it("AhpClient is instantiable with no options", () => {
			const client = new ahpx.AhpClient();
			expect(client).toBeInstanceOf(ahpx.AhpClient);
			expect(client.connected).toBe(false);
			expect(client.clientId).toBeDefined();
		});

		it("AhpClient is instantiable with options", () => {
			const client = new ahpx.AhpClient({
				clientId: "test-client",
				initialSubscriptions: ["agenthost:/root"],
			});
			expect(client.clientId).toBe("test-client");
		});

		it("AhpClient exposes state mirror", () => {
			const client = new ahpx.AhpClient();
			expect(client.state).toBeInstanceOf(ahpx.StateMirror);
		});
	});

	describe("transport layer", () => {
		it("exports Transport class", () => {
			expect(ahpx.Transport).toBeDefined();
			expect(typeof ahpx.Transport).toBe("function");
		});

		it("Transport is instantiable", () => {
			const transport = new ahpx.Transport();
			expect(transport).toBeInstanceOf(ahpx.Transport);
			expect(transport.connected).toBe(false);
		});
	});

	describe("protocol layer", () => {
		it("exports ProtocolLayer class", () => {
			expect(ahpx.ProtocolLayer).toBeDefined();
			expect(typeof ahpx.ProtocolLayer).toBe("function");
		});

		it("exports RpcError class", () => {
			expect(ahpx.RpcError).toBeDefined();
			const err = new ahpx.RpcError(-32600, "Invalid Request");
			expect(err).toBeInstanceOf(Error);
			expect(err.code).toBe(-32600);
			expect(err.message).toBe("Invalid Request");
		});

		it("exports RpcTimeoutError class", () => {
			expect(ahpx.RpcTimeoutError).toBeDefined();
			const err = new ahpx.RpcTimeoutError("initialize", 30000);
			expect(err).toBeInstanceOf(Error);
			expect(err.method).toBe("initialize");
			expect(err.timeoutMs).toBe(30000);
		});
	});

	describe("state mirror", () => {
		it("exports StateMirror class", () => {
			expect(ahpx.StateMirror).toBeDefined();
			expect(typeof ahpx.StateMirror).toBe("function");
		});

		it("StateMirror is instantiable", () => {
			const mirror = new ahpx.StateMirror();
			expect(mirror.root).toEqual({ agents: [] });
			expect(mirror.seq).toBe(0);
			expect(mirror.sessionUris).toEqual([]);
		});
	});

	describe("active client manager", () => {
		it("exports ActiveClientManager class", () => {
			expect(ahpx.ActiveClientManager).toBeDefined();
			expect(typeof ahpx.ActiveClientManager).toBe("function");
		});
	});

	describe("session handle", () => {
		it("exports SessionHandle class", () => {
			expect(ahpx.SessionHandle).toBeDefined();
			expect(typeof ahpx.SessionHandle).toBe("function");
		});
	});

	describe("connection pool", () => {
		it("exports ConnectionPool class", () => {
			expect(ahpx.ConnectionPool).toBeDefined();
			expect(typeof ahpx.ConnectionPool).toBe("function");
		});

		it("ConnectionPool is instantiable", () => {
			const pool = new ahpx.ConnectionPool();
			expect(pool.activeConnections).toBe(0);
			expect(pool.activeSessions).toBe(0);
		});
	});

	describe("reconnection", () => {
		it("exports ReconnectManager class", () => {
			expect(ahpx.ReconnectManager).toBeDefined();
			expect(typeof ahpx.ReconnectManager).toBe("function");
		});
	});

	describe("authentication", () => {
		it("exports AuthHandler class", () => {
			expect(ahpx.AuthHandler).toBeDefined();
			expect(typeof ahpx.AuthHandler).toBe("function");
		});
	});

	describe("protocol types — enums", () => {
		it("exports ActionType enum", () => {
			expect(ahpx.ActionType.SessionDelta).toBe("session/delta");
			expect(ahpx.ActionType.SessionTurnStarted).toBe("session/turnStarted");
			expect(ahpx.ActionType.SessionTurnComplete).toBe("session/turnComplete");
		});

		it("exports SessionLifecycle enum", () => {
			expect(ahpx.SessionLifecycle.Creating).toBe("creating");
		});

		it("exports SessionStatus enum", () => {
			expect(ahpx.SessionStatus.Idle).toBe(1);
		});

		it("exports ToolCallStatus enum", () => {
			expect(ahpx.ToolCallStatus.Running).toBe("running");
		});

		it("exports PendingMessageKind enum", () => {
			expect(ahpx.PendingMessageKind.Queued).toBe("queued");
		});

		it("exports ResponsePartKind enum", () => {
			expect(ahpx.ResponsePartKind.Markdown).toBe("markdown");
		});
	});

	describe("session persistence", () => {
		it("exports SessionStore class", () => {
			expect(ahpx.SessionStore).toBeDefined();
			expect(typeof ahpx.SessionStore).toBe("function");
		});

		it("exports SessionPersistence class", () => {
			expect(ahpx.SessionPersistence).toBeDefined();
			expect(typeof ahpx.SessionPersistence).toBe("function");
		});

		it("exports buildTurnSummary function", () => {
			expect(ahpx.buildTurnSummary).toBeDefined();
			expect(typeof ahpx.buildTurnSummary).toBe("function");
		});

		it("exports truncatePreview function", () => {
			expect(ahpx.truncatePreview).toBeDefined();
			expect(typeof ahpx.truncatePreview).toBe("function");
		});

		it("exports session persistence types (compile-time check)", () => {
			const turn: ahpx.TurnSummary = {
				turnId: "t1",
				userMessage: "hello",
				responsePreview: "hi",
				toolCallCount: 0,
				state: "complete",
				timestamp: new Date().toISOString(),
			};
			expect(turn.turnId).toBe("t1");

			const record: ahpx.SessionRecord = {
				id: "s1",
				sessionUri: "copilot:/s1",
				serverName: "local",
				serverUrl: "ws://localhost:3000",
				provider: "copilot",
				status: "active",
				createdAt: new Date().toISOString(),
				turns: [turn],
			};
			expect(record.turns).toHaveLength(1);
		});
	});

	describe("URI utilities", () => {
		it("exports ensureFileUri function", () => {
			expect(ahpx.ensureFileUri).toBeDefined();
			expect(typeof ahpx.ensureFileUri).toBe("function");
		});

		it("exports fileUriToDisplayPath function", () => {
			expect(ahpx.fileUriToDisplayPath).toBeDefined();
			expect(typeof ahpx.fileUriToDisplayPath).toBe("function");
		});
	});

	describe("public API completeness", () => {
		it("exports all expected classes", () => {
			const expectedClasses = [
				"AhpClient",
				"Transport",
				"ProtocolLayer",
				"RpcError",
				"RpcTimeoutError",
				"StateMirror",
				"SessionHandle",
				"ConnectionPool",
				"ActiveClientManager",
				"ReconnectManager",
				"AuthHandler",
				"SessionStore",
				"SessionPersistence",
			];

			for (const name of expectedClasses) {
				expect(ahpx).toHaveProperty(name);
				expect(typeof (ahpx as Record<string, unknown>)[name]).toBe("function");
			}
		});

		it("exports all expected enums", () => {
			const expectedEnums = [
				"ActionType",
				"SessionLifecycle",
				"SessionStatus",
				"ToolCallStatus",
				"PendingMessageKind",
				"ResponsePartKind",
				"SessionInputAnswerState",
				"SessionInputAnswerValueKind",
				"SessionInputQuestionKind",
				"SessionInputResponseKind",
				"TerminalClaimKind",
			];

			for (const name of expectedEnums) {
				expect(ahpx).toHaveProperty(name);
				expect(typeof (ahpx as Record<string, unknown>)[name]).toBe("object");
			}
		});

		it("does NOT export CLI-specific code", () => {
			const cliInternals = [
				// Output formatters
				"PromptRenderer",
				"JsonFormatter",
				"QuietFormatter",
				"createFormatter",
				// Prompt controller
				"TurnController",
				// Permissions
				"PermissionHandler",
				// Config
				"loadConfig",
				"ConnectionStore",
				// CLI utilities
				"createLogger",
				"ExitCode",
			];

			for (const name of cliInternals) {
				expect(ahpx).not.toHaveProperty(name);
			}
		});
	});

	describe("type exports (compile-time verification)", () => {
		// These tests verify that TypeScript type exports are accessible.
		// If this file compiles, the types are exported correctly.
		// We use `expectTypeOf` to verify at the type level.

		it("exports client option and event types", () => {
			const opts: ahpx.AhpClientOptions = { clientId: "test" };
			expect(opts.clientId).toBe("test");
		});

		it("exports transport option types", () => {
			const opts: ahpx.TransportOptions = { connectTimeout: 5000 };
			expect(opts.connectTimeout).toBe(5000);
		});

		it("exports protocol layer option types", () => {
			const opts: ahpx.ProtocolLayerOptions = { requestTimeout: 10000 };
			expect(opts.requestTimeout).toBe(10000);
		});

		it("exports reconnect option types", () => {
			const opts: ahpx.ReconnectOptions = { maxRetries: 3 };
			expect(opts.maxRetries).toBe(3);
		});

		it("exports auth handler option types", () => {
			const opts: ahpx.AuthHandlerOptions = { token: "abc" };
			expect(opts.token).toBe("abc");
		});

		it("exports protocol state types", () => {
			// These type assertions prove the types are importable.
			// They won't exist at runtime — the test passing means compilation succeeded.
			const _rootState: ahpx.RootState = { agents: [] };
			expect(_rootState.agents).toEqual([]);

			const _uri: ahpx.URI = "agenthost:/root";
			expect(_uri).toBe("agenthost:/root");
		});

		it("exports action types", () => {
			const envelope: ahpx.ActionEnvelope = {
				serverSeq: 1,
				action: {
					type: ahpx.ActionType.SessionDelta,
					session: "copilot:/test",
					turnId: "t1",
					partId: "p1",
					content: "hello",
				},
				origin: { clientId: "c1", clientSeq: 1 },
			};
			expect(envelope.serverSeq).toBe(1);
		});
	});
});
