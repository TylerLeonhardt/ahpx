import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileServingHandler } from "../file-serving.js";

/**
 * These tests exercise the reverse-RPC file-serving handler directly via
 * `handleServerRequest(method, params)` — the entry point ahpx wires into the
 * official client's `setServerRequestHandler`. Success returns a plain result;
 * failures throw an official {@link RpcError} (which the client turns into a
 * JSON-RPC error response).
 */
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

	describe("resourceRead", () => {
		it("reads an allowed file and returns base64 content", async () => {
			const filePath = path.join(tmpDir, "instructions.md");
			await fs.writeFile(filePath, "Hello, world!");
			handler.addAllowedUris([fileUri(filePath)]);

			const result = (await handler.handleServerRequest("resourceRead", {
				uri: fileUri(filePath),
			})) as { data: string; encoding: string };

			expect(result.encoding).toBe("base64");
			expect(Buffer.from(result.data, "base64").toString()).toBe("Hello, world!");
		});

		it("rejects reads of files not in the allowed set", async () => {
			const filePath = path.join(tmpDir, "secret.md");
			await fs.writeFile(filePath, "top secret");
			// Deliberately NOT adding to allowed set

			await expect(handler.handleServerRequest("resourceRead", { uri: fileUri(filePath) })).rejects.toMatchObject({
				code: -32008,
			});
			await expect(handler.handleServerRequest("resourceRead", { uri: fileUri(filePath) })).rejects.toThrow(
				/Access denied/,
			);
		});

		it("returns error for non-existent files", async () => {
			const filePath = path.join(tmpDir, "missing.md");
			handler.addAllowedUris([fileUri(filePath)]);

			await expect(handler.handleServerRequest("resourceRead", { uri: fileUri(filePath) })).rejects.toMatchObject({
				code: -32008,
			});
		});

		it("reads binary files correctly as base64", async () => {
			const filePath = path.join(tmpDir, "binary.bin");
			const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
			await fs.writeFile(filePath, binaryData);
			handler.addAllowedUris([fileUri(filePath)]);

			const result = (await handler.handleServerRequest("resourceRead", {
				uri: fileUri(filePath),
			})) as { data: string; encoding: string };

			expect(Buffer.from(result.data, "base64")).toEqual(binaryData);
		});
	});

	describe("resourceList", () => {
		it("lists directory contents for a directory containing an allowed file", async () => {
			const subDir = path.join(tmpDir, "agents");
			await fs.mkdir(subDir);
			await fs.writeFile(path.join(subDir, "agent1.md"), "agent 1");
			await fs.writeFile(path.join(subDir, "agent2.md"), "agent 2");
			await fs.mkdir(path.join(subDir, "nested"));

			// Allow a file inside the directory
			handler.addAllowedUris([fileUri(path.join(subDir, "agent1.md"))]);

			const result = (await handler.handleServerRequest("resourceList", {
				uri: fileUri(subDir),
			})) as { entries: Array<{ name: string; type: string }> };

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

			await expect(handler.handleServerRequest("resourceList", { uri: fileUri(subDir) })).rejects.toMatchObject({
				code: -32008,
			});
		});
	});

	describe("unknown methods", () => {
		it("throws -32601 for unknown methods", async () => {
			await expect(handler.handleServerRequest("unknownMethod", {})).rejects.toBeInstanceOf(RpcError);
			await expect(handler.handleServerRequest("unknownMethod", {})).rejects.toMatchObject({
				code: -32601,
			});
			await expect(handler.handleServerRequest("unknownMethod", {})).rejects.toThrow(/Unknown method/);
		});
	});
});
