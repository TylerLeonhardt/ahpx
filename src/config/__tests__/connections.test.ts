import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore, ConnectionValidationError, isValidWsUrl } from "../connections.js";

describe("isValidWsUrl", () => {
	it("accepts ws:// URLs", () => {
		expect(isValidWsUrl("ws://localhost:3000")).toBe(true);
		expect(isValidWsUrl("ws://example.com/path")).toBe(true);
	});

	it("accepts wss:// URLs", () => {
		expect(isValidWsUrl("wss://example.com")).toBe(true);
		expect(isValidWsUrl("wss://example.com:8443/ahp")).toBe(true);
	});

	it("rejects http:// URLs", () => {
		expect(isValidWsUrl("http://example.com")).toBe(false);
		expect(isValidWsUrl("https://example.com")).toBe(false);
	});

	it("rejects garbage input", () => {
		expect(isValidWsUrl("not-a-url")).toBe(false);
		expect(isValidWsUrl("")).toBe(false);
		expect(isValidWsUrl("ftp://files.example.com")).toBe(false);
	});
});

describe("ConnectionStore", () => {
	let tmpDir: string;
	let store: ConnectionStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-test-"));
		store = new ConnectionStore(tmpDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("list", () => {
		it("returns empty array when no connections file exists", async () => {
			const result = await store.list();
			expect(result).toEqual([]);
		});

		it("returns saved connections", async () => {
			await store.add({ name: "local", url: "ws://localhost:3000" });
			await store.add({ name: "prod", url: "wss://prod.example.com" });

			const result = await store.list();
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("local");
			expect(result[1].name).toBe("prod");
		});
	});

	describe("add", () => {
		it("adds a connection profile", async () => {
			await store.add({ name: "dev", url: "ws://localhost:3000" });

			const conn = await store.get("dev");
			expect(conn).toBeDefined();
			expect(conn!.name).toBe("dev");
			expect(conn!.url).toBe("ws://localhost:3000");
		});

		it("stores optional token", async () => {
			await store.add({ name: "auth", url: "wss://example.com", token: "secret-token" });

			const conn = await store.get("auth");
			expect(conn!.token).toBe("secret-token");
		});

		it("throws on duplicate name", async () => {
			await store.add({ name: "dup", url: "ws://localhost:3000" });

			await expect(store.add({ name: "dup", url: "ws://localhost:4000" })).rejects.toThrow(ConnectionValidationError);
		});

		it("throws on invalid URL", async () => {
			await expect(store.add({ name: "bad", url: "http://example.com" })).rejects.toThrow(ConnectionValidationError);
			await expect(store.add({ name: "bad", url: "not-a-url" })).rejects.toThrow(ConnectionValidationError);
		});

		it("sets default and clears previous default", async () => {
			await store.add({ name: "first", url: "ws://localhost:3000", default: true });
			await store.add({ name: "second", url: "ws://localhost:4000", default: true });

			const all = await store.list();
			expect(all.find((c) => c.name === "first")!.default).toBe(false);
			expect(all.find((c) => c.name === "second")!.default).toBe(true);
		});
	});

	describe("get", () => {
		it("returns undefined for missing connection", async () => {
			const result = await store.get("nonexistent");
			expect(result).toBeUndefined();
		});

		it("returns the correct connection", async () => {
			await store.add({ name: "a", url: "ws://a.com" });
			await store.add({ name: "b", url: "ws://b.com" });

			const result = await store.get("b");
			expect(result!.url).toBe("ws://b.com");
		});
	});

	describe("getDefault", () => {
		it("returns undefined when no default is set", async () => {
			await store.add({ name: "nodef", url: "ws://localhost:3000" });
			const result = await store.getDefault();
			expect(result).toBeUndefined();
		});

		it("returns the default connection", async () => {
			await store.add({ name: "def", url: "ws://localhost:3000", default: true });
			const result = await store.getDefault();
			expect(result).toBeDefined();
			expect(result!.name).toBe("def");
		});
	});

	describe("remove", () => {
		it("removes an existing connection", async () => {
			await store.add({ name: "victim", url: "ws://localhost:3000" });
			const removed = await store.remove("victim");

			expect(removed).toBe(true);
			expect(await store.get("victim")).toBeUndefined();
		});

		it("returns false for non-existent connection", async () => {
			const removed = await store.remove("ghost");
			expect(removed).toBe(false);
		});
	});

	describe("setDefault", () => {
		it("sets a connection as default", async () => {
			await store.add({ name: "a", url: "ws://a.com" });
			await store.add({ name: "b", url: "ws://b.com" });
			await store.setDefault("b");

			const all = await store.list();
			expect(all.find((c) => c.name === "a")!.default).toBe(false);
			expect(all.find((c) => c.name === "b")!.default).toBe(true);
		});

		it("throws when connection not found", async () => {
			await expect(store.setDefault("ghost")).rejects.toThrow(ConnectionValidationError);
		});
	});

	describe("tags", () => {
		it("stores tags on a connection", async () => {
			await store.add({ name: "cloud", url: "ws://cloud.example.com", tags: ["gpu", "cloud"] });

			const conn = await store.get("cloud");
			expect(conn).toBeDefined();
			expect(conn!.tags).toEqual(["gpu", "cloud"]);
		});

		it("persists tags across store instances", async () => {
			await store.add({ name: "tagged", url: "ws://tagged.example.com", tags: ["local"] });

			const store2 = new ConnectionStore(tmpDir);
			const conn = await store2.get("tagged");
			expect(conn!.tags).toEqual(["local"]);
		});

		it("omits tags when not provided", async () => {
			await store.add({ name: "notags", url: "ws://notags.example.com" });

			const conn = await store.get("notags");
			expect(conn!.tags).toBeUndefined();
		});
	});

	describe("file persistence", () => {
		it("persists across store instances", async () => {
			await store.add({ name: "persisted", url: "ws://localhost:3000" });

			// Create a new store pointing at the same directory
			const store2 = new ConnectionStore(tmpDir);
			const conn = await store2.get("persisted");
			expect(conn).toBeDefined();
			expect(conn!.name).toBe("persisted");
		});

		it("writes valid JSON to disk", async () => {
			await store.add({ name: "check", url: "ws://localhost:3000" });

			const raw = await fs.readFile(path.join(tmpDir, "connections.json"), "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed.connections).toHaveLength(1);
			expect(parsed.connections[0].name).toBe("check");
		});
	});
});
