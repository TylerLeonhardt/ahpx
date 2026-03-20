import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { AuthHandler } from "../handler.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-auth-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function createMockClient(authenticateResult = true) {
	const emitter = new EventEmitter();
	const authenticateCalls: Array<{ resource: string; token: string }> = [];

	const client = Object.assign(emitter, {
		authenticate: async (resource: string, token: string) => {
			authenticateCalls.push({ resource, token });
			if (!authenticateResult) {
				throw new Error("Invalid token");
			}
		},
		connected: true,
	}) as unknown as AhpClient;

	return { client, authenticateCalls };
}

describe("AuthHandler", () => {
	describe("token storage", () => {
		it("stores and loads a token", async () => {
			const { client } = createMockClient();
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			await handler.storeToken("https://api.github.com", "gho_test123");

			const loaded = await handler.loadToken("https://api.github.com");
			expect(loaded).toBe("gho_test123");
		});

		it("returns undefined for missing tokens", async () => {
			const { client } = createMockClient();
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			const loaded = await handler.loadToken("https://unknown.example.com");
			expect(loaded).toBeUndefined();
		});

		it("stores tokens with correct file permissions", async () => {
			const { client } = createMockClient();
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			await handler.storeToken("https://api.github.com", "test-token");

			const authFile = path.join(tmpDir, "auth.json");
			const stat = await fs.stat(authFile);
			// Check that it's not world-readable (0600 = owner rw only)
			const mode = stat.mode & 0o777;
			expect(mode).toBe(0o600);
		});

		it("overwrites existing tokens for same resource", async () => {
			const { client } = createMockClient();
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			await handler.storeToken("https://api.github.com", "old-token");
			await handler.storeToken("https://api.github.com", "new-token");

			const loaded = await handler.loadToken("https://api.github.com");
			expect(loaded).toBe("new-token");
		});

		it("stores multiple tokens for different resources", async () => {
			const { client } = createMockClient();
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			await handler.storeToken("https://api.github.com", "github-token");
			await handler.storeToken("https://api.example.com", "example-token");

			expect(await handler.loadToken("https://api.github.com")).toBe("github-token");
			expect(await handler.loadToken("https://api.example.com")).toBe("example-token");
		});
	});

	describe("handleAuthRequired", () => {
		it("uses explicit token from options", async () => {
			const { client, authenticateCalls } = createMockClient(true);
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				token: "explicit-token",
				interactive: false,
			});

			const result = await handler.handleAuthRequired({
				resource: "https://api.github.com",
			});

			expect(result).toBe(true);
			expect(authenticateCalls).toHaveLength(1);
			expect(authenticateCalls[0].token).toBe("explicit-token");
		});

		it("falls back to env var", async () => {
			const { client, authenticateCalls } = createMockClient(true);

			const originalEnv = process.env.AHPX_TOKEN;
			process.env.AHPX_TOKEN = "env-token";

			try {
				const handler = new AuthHandler(client, {
					configDir: tmpDir,
					interactive: false,
				});

				const result = await handler.handleAuthRequired({
					resource: "https://api.github.com",
				});

				expect(result).toBe(true);
				expect(authenticateCalls[0].token).toBe("env-token");
			} finally {
				if (originalEnv === undefined) {
					Reflect.deleteProperty(process.env, "AHPX_TOKEN");
				} else {
					process.env.AHPX_TOKEN = originalEnv;
				}
			}
		});

		it("uses stored token when available", async () => {
			const { client, authenticateCalls } = createMockClient(true);
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				interactive: false,
			});

			// Pre-store a token
			await handler.storeToken("https://api.github.com", "stored-token");

			const result = await handler.handleAuthRequired({
				resource: "https://api.github.com",
			});

			expect(result).toBe(true);
			expect(authenticateCalls[0].token).toBe("stored-token");
		});

		it("returns false when no token available and not interactive", async () => {
			const { client } = createMockClient(true);

			const originalEnv = process.env.AHPX_TOKEN;
			Reflect.deleteProperty(process.env, "AHPX_TOKEN");

			try {
				const handler = new AuthHandler(client, {
					configDir: tmpDir,
					interactive: false,
				});

				const result = await handler.handleAuthRequired({
					resource: "https://api.github.com",
				});

				expect(result).toBe(false);
			} finally {
				if (originalEnv !== undefined) {
					process.env.AHPX_TOKEN = originalEnv;
				}
			}
		});

		it("returns false when authentication fails", async () => {
			const { client } = createMockClient(false);
			const handler = new AuthHandler(client, {
				configDir: tmpDir,
				token: "bad-token",
				interactive: false,
			});

			const result = await handler.handleAuthRequired({
				resource: "https://api.github.com",
			});

			expect(result).toBe(false);
		});
	});
});
