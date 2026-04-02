import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentEncoding } from "../../protocol/commands.js";
import { ProtocolLayer, RpcError, RpcTimeoutError } from "../protocol.js";
import type { Transport } from "../transport.js";

/**
 * Creates a mock Transport that records sent messages and
 * allows simulating incoming messages.
 */
function createMockTransport() {
	const emitter = new EventEmitter();
	const sent: unknown[] = [];

	const transport = Object.assign(emitter, {
		send(data: unknown) {
			sent.push(data);
		},
		connect: vi.fn(),
		close: vi.fn(),
		connected: true,
	});

	return {
		transport: transport as unknown as Transport,
		sent,
		/** Simulate an incoming message from the server */
		receive(msg: unknown) {
			emitter.emit("message", msg);
		},
	};
}

describe("ProtocolLayer", () => {
	let mock: ReturnType<typeof createMockTransport>;
	let protocol: ProtocolLayer;

	beforeEach(() => {
		mock = createMockTransport();
		protocol = new ProtocolLayer(mock.transport);
	});

	describe("request/response", () => {
		it("sends a JSON-RPC request and resolves on success response", async () => {
			const promise = protocol.request("initialize", {
				protocolVersion: 1,
				clientId: "test-client",
			});

			// Verify the request was sent
			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.jsonrpc).toBe("2.0");
			expect(sent.id).toBe(1);
			expect(sent.method).toBe("initialize");

			// Simulate success response
			mock.receive({
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: 1,
					serverSeq: 0,
					snapshots: [],
				},
			});

			const result = await promise;
			expect(result.protocolVersion).toBe(1);
			expect(result.serverSeq).toBe(0);
		});

		it("sends workingDirectory in createSession request params", async () => {
			const promise = protocol.request("createSession", {
				session: "copilot:/test-session",
				provider: "copilot",
				model: "gpt-4o",
				workingDirectory: "/tmp/my-project",
			});

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.method).toBe("createSession");
			const params = sent.params as Record<string, unknown>;
			expect(params.session).toBe("copilot:/test-session");
			expect(params.workingDirectory).toBe("/tmp/my-project");

			mock.receive({ jsonrpc: "2.0", id: 1, result: null });
			const result = await promise;
			expect(result).toBeNull();
		});

		it("omits workingDirectory from createSession when not provided", async () => {
			const promise = protocol.request("createSession", {
				session: "copilot:/test-session",
				provider: "copilot",
			});

			const sent = mock.sent[0] as Record<string, unknown>;
			const params = sent.params as Record<string, unknown>;
			expect(params.workingDirectory).toBeUndefined();

			mock.receive({ jsonrpc: "2.0", id: 1, result: null });
			await promise;
		});

		it("rejects with RpcError on error response", async () => {
			const promise = protocol.request("createSession", {
				session: "copilot:/test",
			});

			mock.receive({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32002, message: "No agent for provider" },
			});

			await expect(promise).rejects.toThrow(RpcError);
			await expect(promise).rejects.toMatchObject({
				code: -32002,
				message: "No agent for provider",
			});
		});

		it("rejects with RpcTimeoutError after timeout", async () => {
			vi.useFakeTimers();

			const promise = protocol.request(
				"initialize",
				{
					protocolVersion: 1,
					clientId: "test-client",
				},
				100,
			);

			vi.advanceTimersByTime(101);

			await expect(promise).rejects.toThrow(RpcTimeoutError);
			await expect(promise).rejects.toMatchObject({
				method: "initialize",
				timeoutMs: 100,
			});

			vi.useRealTimers();
		});

		it("auto-increments request IDs", () => {
			// Fire off two requests (don't await — they'll time out)
			protocol.request("listSessions", {}).catch(() => {});
			protocol.request("listSessions", {}).catch(() => {});

			expect(mock.sent).toHaveLength(2);
			expect((mock.sent[0] as Record<string, unknown>).id).toBe(1);
			expect((mock.sent[1] as Record<string, unknown>).id).toBe(2);

			// Cancel to clean up
			protocol.cancelAll("test cleanup");
		});
	});

	describe("notifications", () => {
		it("sends a notification (no id)", () => {
			protocol.notify("unsubscribe", { resource: "agenthost:/root" });

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.jsonrpc).toBe("2.0");
			expect(sent.method).toBe("unsubscribe");
			expect(sent).not.toHaveProperty("id");
		});
	});

	describe("incoming routing", () => {
		it("emits 'action' for action notifications", () => {
			const handler = vi.fn();
			protocol.on("action", handler);

			mock.receive({
				jsonrpc: "2.0",
				method: "action",
				params: {
					action: { type: "root/agentsChanged", agents: [] },
					serverSeq: 1,
					origin: undefined,
				},
			});

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0]).toMatchObject({
				action: { type: "root/agentsChanged" },
				serverSeq: 1,
			});
		});

		it("emits 'notification' for protocol notifications", () => {
			const handler = vi.fn();
			protocol.on("notification", handler);

			mock.receive({
				jsonrpc: "2.0",
				method: "notification",
				params: {
					notification: {
						type: "notify/sessionAdded",
						summary: {
							resource: "copilot:/test",
							provider: "copilot",
							title: "Test",
							status: "idle",
							createdAt: 1000,
							modifiedAt: 1000,
						},
					},
				},
			});

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0]).toMatchObject({
				type: "notify/sessionAdded",
			});
		});

		it("ignores unrecognized messages", () => {
			const handler = vi.fn();
			protocol.on("action", handler);
			protocol.on("notification", handler);

			mock.receive({ jsonrpc: "2.0", method: "unknown", params: {} });
			mock.receive("not an object");
			mock.receive(null);

			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe("cancelAll", () => {
		it("rejects all pending requests", async () => {
			const p1 = protocol.request("listSessions", {});
			const p2 = protocol.request("listSessions", {});

			protocol.cancelAll("shutting down");

			await expect(p1).rejects.toThrow("shutting down");
			await expect(p2).rejects.toThrow("shutting down");
		});
	});

	describe("resource commands", () => {
		it("sends resourceWrite with correct params", async () => {
			const promise = protocol.request("resourceWrite", {
				uri: "file:///workspace/hello.txt",
				data: "SGVsbG8=",
				encoding: ContentEncoding.Base64,
				contentType: "text/plain",
			});

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.method).toBe("resourceWrite");
			const params = sent.params as Record<string, unknown>;
			expect(params.uri).toBe("file:///workspace/hello.txt");
			expect(params.data).toBe("SGVsbG8=");
			expect(params.encoding).toBe("base64");
			expect(params.contentType).toBe("text/plain");

			mock.receive({ jsonrpc: "2.0", id: 1, result: {} });
			const result = await promise;
			expect(result).toEqual({});
		});

		it("sends resourceCopy with correct params", async () => {
			const promise = protocol.request("resourceCopy", {
				source: "file:///a.txt",
				destination: "file:///b.txt",
				failIfExists: true,
			});

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.method).toBe("resourceCopy");
			const params = sent.params as Record<string, unknown>;
			expect(params.source).toBe("file:///a.txt");
			expect(params.destination).toBe("file:///b.txt");
			expect(params.failIfExists).toBe(true);

			mock.receive({ jsonrpc: "2.0", id: 1, result: {} });
			const result = await promise;
			expect(result).toEqual({});
		});

		it("sends resourceDelete with correct params", async () => {
			const promise = protocol.request("resourceDelete", {
				uri: "file:///workspace/old.txt",
				recursive: true,
			});

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.method).toBe("resourceDelete");
			const params = sent.params as Record<string, unknown>;
			expect(params.uri).toBe("file:///workspace/old.txt");
			expect(params.recursive).toBe(true);

			mock.receive({ jsonrpc: "2.0", id: 1, result: {} });
			const result = await promise;
			expect(result).toEqual({});
		});

		it("sends resourceMove with correct params", async () => {
			const promise = protocol.request("resourceMove", {
				source: "file:///old.txt",
				destination: "file:///new.txt",
			});

			expect(mock.sent).toHaveLength(1);
			const sent = mock.sent[0] as Record<string, unknown>;
			expect(sent.method).toBe("resourceMove");
			const params = sent.params as Record<string, unknown>;
			expect(params.source).toBe("file:///old.txt");
			expect(params.destination).toBe("file:///new.txt");

			mock.receive({ jsonrpc: "2.0", id: 1, result: {} });
			const result = await promise;
			expect(result).toEqual({});
		});
	});
});
