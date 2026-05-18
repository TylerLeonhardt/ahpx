import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileServingHandler } from "../file-serving.js";
import { ProtocolLayer } from "../protocol.js";
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
		receive(msg: unknown) {
			emitter.emit("message", msg);
		},
	};
}

describe("ProtocolLayer — incoming requests", () => {
	let mock: ReturnType<typeof createMockTransport>;
	let protocol: ProtocolLayer;

	beforeEach(() => {
		mock = createMockTransport();
		protocol = new ProtocolLayer(mock.transport);
	});

	it("emits 'request' for messages with both method and id", () => {
		const handler = vi.fn();
		protocol.on("request", handler);

		mock.receive({
			jsonrpc: "2.0",
			id: 42,
			method: "resourceRead",
			params: { uri: "file:///some/path.md" },
		});

		expect(handler).toHaveBeenCalledOnce();
		expect(handler.mock.calls[0][0]).toEqual({
			id: 42,
			method: "resourceRead",
			params: { uri: "file:///some/path.md" },
		});
	});

	it("does not emit 'request' for responses to pending requests", async () => {
		const requestHandler = vi.fn();
		protocol.on("request", requestHandler);

		// Send a request (creates a pending entry with id=1)
		const promise = protocol.request("listSessions", {});

		// Simulate a response — this should resolve the promise, not emit 'request'
		mock.receive({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });

		const result = await promise;
		expect(result).toEqual({ sessions: [] });
		expect(requestHandler).not.toHaveBeenCalled();
	});

	it("sends a success response via respond()", () => {
		protocol.respond(42, { data: "abc", encoding: "base64" });

		expect(mock.sent).toHaveLength(1);
		expect(mock.sent[0]).toEqual({
			jsonrpc: "2.0",
			id: 42,
			result: { data: "abc", encoding: "base64" },
		});
	});

	it("sends an error response via respondError()", () => {
		protocol.respondError(42, -32008, "File not found");

		expect(mock.sent).toHaveLength(1);
		expect(mock.sent[0]).toEqual({
			jsonrpc: "2.0",
			id: 42,
			error: { code: -32008, message: "File not found" },
		});
	});

	it("still handles notifications (method without id) correctly", () => {
		const handler = vi.fn();
		protocol.on("action", handler);

		mock.receive({
			jsonrpc: "2.0",
			method: "action",
			params: {
				action: { type: "root/agentsChanged", agents: [] },
				serverSeq: 1,
			},
		});

		expect(handler).toHaveBeenCalledOnce();
	});
});

describe("FileServingHandler", () => {
	let tmpDir: string;
	let handler: FileServingHandler;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-file-serving-"));
		handler = new FileServingHandler();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function fileUri(filePath: string): string {
		return pathToFileURL(filePath).href;
	}

	describe("addAllowedUris / isAllowed", () => {
		it("adds file URIs to the allowed set", () => {
			const filePath = path.join(tmpDir, "test.md");
			handler.addAllowedUris([fileUri(filePath)]);
			expect(handler.isAllowed(filePath)).toBe(true);
		});

		it("rejects paths not in the allowed set", () => {
			expect(handler.isAllowed(path.join(tmpDir, "secret.md"))).toBe(false);
		});

		it("clears all allowed paths", () => {
			const filePath = path.join(tmpDir, "test.md");
			handler.addAllowedUris([fileUri(filePath)]);
			handler.clearAllowedPaths();
			expect(handler.isAllowed(filePath)).toBe(false);
		});
	});

	describe("resourceRead via protocol", () => {
		it("reads an allowed file and returns base64 content", async () => {
			const filePath = path.join(tmpDir, "instructions.md");
			await fs.writeFile(filePath, "Hello, world!");
			handler.addAllowedUris([fileUri(filePath)]);

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			// Simulate incoming resourceRead request
			mock.receive({
				jsonrpc: "2.0",
				id: 1,
				method: "resourceRead",
				params: { uri: fileUri(filePath) },
			});

			// Wait for async handler
			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(1);
			const result = response.result as { data: string; encoding: string };
			expect(result.encoding).toBe("base64");
			expect(Buffer.from(result.data, "base64").toString()).toBe("Hello, world!");
		});

		it("rejects reads of files not in the allowed set", async () => {
			const filePath = path.join(tmpDir, "secret.md");
			await fs.writeFile(filePath, "top secret");
			// Deliberately NOT adding to allowed set

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 2,
				method: "resourceRead",
				params: { uri: fileUri(filePath) },
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(2);
			const error = response.error as { code: number; message: string };
			expect(error.code).toBe(-32008);
			expect(error.message).toContain("Access denied");
		});

		it("returns error for non-existent files", async () => {
			const filePath = path.join(tmpDir, "missing.md");
			handler.addAllowedUris([fileUri(filePath)]);

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 3,
				method: "resourceRead",
				params: { uri: fileUri(filePath) },
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(3);
			expect(response.error).toBeDefined();
			expect((response.error as { code: number }).code).toBe(-32008);
		});

		it("reads binary files correctly as base64", async () => {
			const filePath = path.join(tmpDir, "binary.bin");
			const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
			await fs.writeFile(filePath, binaryData);
			handler.addAllowedUris([fileUri(filePath)]);

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 4,
				method: "resourceRead",
				params: { uri: fileUri(filePath) },
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const result = (mock.sent[0] as Record<string, unknown>).result as { data: string; encoding: string };
			expect(Buffer.from(result.data, "base64")).toEqual(binaryData);
		});
	});

	describe("resourceList via protocol", () => {
		it("lists directory contents for a directory containing an allowed file", async () => {
			const subDir = path.join(tmpDir, "agents");
			await fs.mkdir(subDir);
			await fs.writeFile(path.join(subDir, "agent1.md"), "agent 1");
			await fs.writeFile(path.join(subDir, "agent2.md"), "agent 2");
			await fs.mkdir(path.join(subDir, "nested"));

			// Allow a file inside the directory
			handler.addAllowedUris([fileUri(path.join(subDir, "agent1.md"))]);

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 5,
				method: "resourceList",
				params: { uri: fileUri(subDir) },
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(5);
			const result = response.result as {
				entries: Array<{ name: string; type: string }>;
			};
			expect(result.entries).toHaveLength(3);

			const names = result.entries.map((e) => e.name).sort();
			expect(names).toEqual(["agent1.md", "agent2.md", "nested"]);

			const nested = result.entries.find((e) => e.name === "nested");
			expect(nested?.type).toBe("directory");

			const file = result.entries.find((e) => e.name === "agent1.md");
			expect(file?.type).toBe("file");
		});

		it("rejects listing directories with no allowed files underneath", async () => {
			const subDir = path.join(tmpDir, "unauthorized");
			await fs.mkdir(subDir);
			await fs.writeFile(path.join(subDir, "secret.md"), "secret");

			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 6,
				method: "resourceList",
				params: { uri: fileUri(subDir) },
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(6);
			expect(response.error).toBeDefined();
			expect((response.error as { code: number }).code).toBe(-32008);
		});
	});

	describe("unknown methods", () => {
		it("responds with -32601 for unknown methods", async () => {
			const mock = createMockTransport();
			const protocol = new ProtocolLayer(mock.transport);
			handler.register(protocol);

			mock.receive({
				jsonrpc: "2.0",
				id: 7,
				method: "unknownMethod",
				params: {},
			});

			await vi.waitFor(() => {
				expect(mock.sent).toHaveLength(1);
			});

			const response = mock.sent[0] as Record<string, unknown>;
			expect(response.id).toBe(7);
			const error = response.error as { code: number; message: string };
			expect(error.code).toBe(-32601);
			expect(error.message).toContain("Unknown method");
		});
	});
});
