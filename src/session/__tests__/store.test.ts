import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord, TurnSummary } from "../store.js";
import { SessionStore, buildTurnSummary, truncatePreview } from "../store.js";

/** Helper to create a minimal valid session record. */
function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		id: "test-id-1",
		sessionUri: "copilot:/test-1",
		serverName: "local",
		serverUrl: "ws://localhost:3000",
		provider: "copilot",
		status: "active",
		createdAt: "2024-01-15T10:00:00.000Z",
		...overrides,
	};
}

describe("SessionStore", () => {
	let tmpDir: string;
	let store: SessionStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-session-test-"));
		store = new SessionStore(tmpDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("save and get", () => {
		it("saves and retrieves a session record", async () => {
			const record = makeSession();
			await store.save(record);

			const retrieved = await store.get("test-id-1");
			expect(retrieved).toBeDefined();
			expect(retrieved!.id).toBe("test-id-1");
			expect(retrieved!.sessionUri).toBe("copilot:/test-1");
			expect(retrieved!.serverName).toBe("local");
			expect(retrieved!.provider).toBe("copilot");
			expect(retrieved!.status).toBe("active");
		});

		it("returns undefined for non-existent ID", async () => {
			const result = await store.get("nonexistent");
			expect(result).toBeUndefined();
		});

		it("saves all optional fields", async () => {
			const record = makeSession({
				model: "gpt-4o",
				name: "my-session",
				workingDirectory: "/home/user/project",
				gitRoot: "/home/user/project",
				title: "Fix the bug",
				closedAt: "2024-01-15T12:00:00.000Z",
				lastPromptAt: "2024-01-15T11:00:00.000Z",
			});
			await store.save(record);

			const retrieved = await store.get("test-id-1");
			expect(retrieved!.model).toBe("gpt-4o");
			expect(retrieved!.name).toBe("my-session");
			expect(retrieved!.workingDirectory).toBe("/home/user/project");
			expect(retrieved!.gitRoot).toBe("/home/user/project");
			expect(retrieved!.title).toBe("Fix the bug");
			expect(retrieved!.closedAt).toBe("2024-01-15T12:00:00.000Z");
			expect(retrieved!.lastPromptAt).toBe("2024-01-15T11:00:00.000Z");
		});

		it("rejects session IDs with path traversal characters", async () => {
			const traversalIds = ["../evil", "..\\evil", "foo/bar", "foo\\bar", "..", "id\0null"];
			for (const id of traversalIds) {
				await expect(store.save(makeSession({ id }))).rejects.toThrow("Invalid session ID");
			}
			await expect(store.get("../evil")).rejects.toThrow("Invalid session ID");
		});

		it("overwrites an existing record on save", async () => {
			await store.save(makeSession({ title: "v1" }));
			await store.save(makeSession({ title: "v2" }));

			const retrieved = await store.get("test-id-1");
			expect(retrieved!.title).toBe("v2");
		});
	});

	describe("list", () => {
		it("returns empty array when no sessions exist", async () => {
			const result = await store.list();
			expect(result).toEqual([]);
		});

		it("returns all sessions", async () => {
			await store.save(makeSession({ id: "a", createdAt: "2024-01-15T10:00:00.000Z" }));
			await store.save(makeSession({ id: "b", createdAt: "2024-01-15T11:00:00.000Z" }));
			await store.save(makeSession({ id: "c", createdAt: "2024-01-15T09:00:00.000Z" }));

			const result = await store.list();
			expect(result).toHaveLength(3);
			// Sorted by createdAt descending
			expect(result[0].id).toBe("b");
			expect(result[1].id).toBe("a");
			expect(result[2].id).toBe("c");
		});

		it("filters by status", async () => {
			await store.save(makeSession({ id: "active-1", status: "active" }));
			await store.save(makeSession({ id: "closed-1", status: "closed" }));
			await store.save(makeSession({ id: "active-2", status: "active" }));

			const active = await store.list({ status: "active" });
			expect(active).toHaveLength(2);
			expect(active.every((r) => r.status === "active")).toBe(true);

			const closed = await store.list({ status: "closed" });
			expect(closed).toHaveLength(1);
			expect(closed[0].id).toBe("closed-1");
		});

		it("filters by serverName", async () => {
			await store.save(makeSession({ id: "a", serverName: "prod" }));
			await store.save(makeSession({ id: "b", serverName: "local" }));
			await store.save(makeSession({ id: "c", serverName: "prod" }));

			const result = await store.list({ serverName: "prod" });
			expect(result).toHaveLength(2);
			expect(result.every((r) => r.serverName === "prod")).toBe(true);
		});

		it("filters by workingDirectory", async () => {
			await store.save(makeSession({ id: "a", workingDirectory: "/home/user/project-a" }));
			await store.save(makeSession({ id: "b", workingDirectory: "/home/user/project-b" }));

			const result = await store.list({ workingDirectory: "/home/user/project-a" });
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("a");
		});

		it("filters by name", async () => {
			await store.save(makeSession({ id: "a", name: "feature-work" }));
			await store.save(makeSession({ id: "b", name: "bugfix" }));
			await store.save(makeSession({ id: "c" })); // unnamed

			const result = await store.list({ name: "feature-work" });
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("a");
		});

		it("combines multiple filters", async () => {
			await store.save(makeSession({ id: "a", serverName: "prod", status: "active" }));
			await store.save(makeSession({ id: "b", serverName: "prod", status: "closed" }));
			await store.save(makeSession({ id: "c", serverName: "local", status: "active" }));

			const result = await store.list({ serverName: "prod", status: "active" });
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("a");
		});

		it("skips non-JSON files", async () => {
			await store.save(makeSession({ id: "valid" }));

			// Write a non-JSON file in the sessions dir
			const sessionsDir = path.join(tmpDir, "sessions");
			await fs.writeFile(path.join(sessionsDir, "readme.txt"), "not json");

			const result = await store.list();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("valid");
		});

		it("skips corrupt JSON files", async () => {
			await store.save(makeSession({ id: "valid" }));

			// Write a corrupt JSON file
			const sessionsDir = path.join(tmpDir, "sessions");
			await fs.writeFile(path.join(sessionsDir, "corrupt.json"), "{bad json");

			const result = await store.list();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("valid");
		});
	});

	describe("update", () => {
		it("updates specific fields", async () => {
			await store.save(makeSession());

			const updated = await store.update("test-id-1", {
				title: "New Title",
				lastPromptAt: "2024-01-15T12:00:00.000Z",
			});

			expect(updated).toBeDefined();
			expect(updated!.title).toBe("New Title");
			expect(updated!.lastPromptAt).toBe("2024-01-15T12:00:00.000Z");
			// Original fields preserved
			expect(updated!.provider).toBe("copilot");
			expect(updated!.status).toBe("active");
		});

		it("returns undefined for non-existent ID", async () => {
			const result = await store.update("ghost", { title: "nope" });
			expect(result).toBeUndefined();
		});

		it("persists updates to disk", async () => {
			await store.save(makeSession());
			await store.update("test-id-1", { title: "Updated" });

			// Read from a fresh store instance
			const store2 = new SessionStore(tmpDir);
			const retrieved = await store2.get("test-id-1");
			expect(retrieved!.title).toBe("Updated");
		});
	});

	describe("close", () => {
		it("sets status to closed and records timestamp", async () => {
			await store.save(makeSession());

			const closed = await store.close("test-id-1");

			expect(closed).toBeDefined();
			expect(closed!.status).toBe("closed");
			expect(closed!.closedAt).toBeDefined();
			// closedAt should be a valid ISO timestamp
			expect(new Date(closed!.closedAt!).toISOString()).toBe(closed!.closedAt);
		});

		it("preserves the record (soft close)", async () => {
			await store.save(makeSession());
			await store.close("test-id-1");

			const record = await store.get("test-id-1");
			expect(record).toBeDefined();
			expect(record!.status).toBe("closed");
			// All original fields preserved
			expect(record!.sessionUri).toBe("copilot:/test-1");
			expect(record!.provider).toBe("copilot");
		});

		it("returns undefined for non-existent ID", async () => {
			const result = await store.close("ghost");
			expect(result).toBeUndefined();
		});

		it("closed sessions are excluded from active-only list", async () => {
			await store.save(makeSession({ id: "s1" }));
			await store.save(makeSession({ id: "s2" }));
			await store.close("s1");

			const active = await store.list({ status: "active" });
			expect(active).toHaveLength(1);
			expect(active[0].id).toBe("s2");

			// But still visible in unfiltered list
			const all = await store.list();
			expect(all).toHaveLength(2);
		});
	});

	describe("getByScope", () => {
		it("finds active session matching scope", async () => {
			await store.save(
				makeSession({
					id: "match",
					serverName: "local",
					workingDirectory: "/home/user/project",
				}),
			);
			await store.save(
				makeSession({
					id: "other",
					serverName: "prod",
					workingDirectory: "/home/user/project",
				}),
			);

			const result = await store.getByScope({
				serverName: "local",
				workingDirectory: "/home/user/project",
			});
			expect(result).toBeDefined();
			expect(result!.id).toBe("match");
		});

		it("returns the most recent session when no name given", async () => {
			await store.save(
				makeSession({
					id: "older",
					serverName: "local",
					workingDirectory: "/home/user/project",
					createdAt: "2024-01-15T10:00:00.000Z",
				}),
			);
			await store.save(
				makeSession({
					id: "newer",
					serverName: "local",
					workingDirectory: "/home/user/project",
					createdAt: "2024-01-15T11:00:00.000Z",
				}),
			);

			const result = await store.getByScope({
				serverName: "local",
				workingDirectory: "/home/user/project",
			});
			expect(result!.id).toBe("newer");
		});

		it("filters by name when specified", async () => {
			await store.save(
				makeSession({
					id: "unnamed",
					serverName: "local",
					workingDirectory: "/home/user/project",
					createdAt: "2024-01-15T11:00:00.000Z",
				}),
			);
			await store.save(
				makeSession({
					id: "named",
					serverName: "local",
					workingDirectory: "/home/user/project",
					name: "feature",
					createdAt: "2024-01-15T10:00:00.000Z",
				}),
			);

			const result = await store.getByScope({
				serverName: "local",
				workingDirectory: "/home/user/project",
				name: "feature",
			});
			expect(result!.id).toBe("named");
		});

		it("skips closed sessions", async () => {
			await store.save(
				makeSession({
					id: "closed-one",
					serverName: "local",
					workingDirectory: "/home/user/project",
					status: "closed",
				}),
			);

			const result = await store.getByScope({
				serverName: "local",
				workingDirectory: "/home/user/project",
			});
			expect(result).toBeUndefined();
		});

		it("returns undefined when no match", async () => {
			await store.save(makeSession({ id: "a", serverName: "prod" }));

			const result = await store.getByScope({
				serverName: "local",
				workingDirectory: "/somewhere",
			});
			expect(result).toBeUndefined();
		});
	});

	describe("file persistence", () => {
		it("persists as individual JSON files", async () => {
			await store.save(makeSession({ id: "persist-1" }));
			await store.save(makeSession({ id: "persist-2" }));

			const files = await fs.readdir(path.join(tmpDir, "sessions"));
			const jsonFiles = files.filter((f) => f.endsWith(".json"));
			expect(jsonFiles).toHaveLength(2);
			expect(jsonFiles).toContain("persist-1.json");
			expect(jsonFiles).toContain("persist-2.json");
		});

		it("writes valid JSON to disk", async () => {
			await store.save(makeSession({ id: "check-json", title: "Test Title" }));

			const raw = await fs.readFile(path.join(tmpDir, "sessions", "check-json.json"), "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed.id).toBe("check-json");
			expect(parsed.title).toBe("Test Title");
		});

		it("persists across store instances", async () => {
			await store.save(makeSession({ id: "cross-instance", provider: "copilot" }));

			const store2 = new SessionStore(tmpDir);
			const result = await store2.get("cross-instance");
			expect(result).toBeDefined();
			expect(result!.provider).toBe("copilot");
		});

		it("no temp files left after save", async () => {
			await store.save(makeSession({ id: "clean" }));

			const files = await fs.readdir(path.join(tmpDir, "sessions"));
			const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
			expect(tmpFiles).toHaveLength(0);
		});
	});

	describe("appendTurn", () => {
		function makeTurn(overrides: Partial<TurnSummary> = {}): TurnSummary {
			return {
				turnId: "turn-1",
				userMessage: "Hello, agent!",
				responsePreview: "Hi there! How can I help?",
				toolCallCount: 0,
				state: "complete",
				timestamp: "2024-01-15T10:05:00.000Z",
				...overrides,
			};
		}

		it("appends a turn to a session with no existing turns", async () => {
			await store.save(makeSession());
			const turn = makeTurn();

			const updated = await store.appendTurn("test-id-1", turn);

			expect(updated).toBeDefined();
			expect(updated!.turns).toHaveLength(1);
			expect(updated!.turns![0].turnId).toBe("turn-1");
			expect(updated!.turns![0].userMessage).toBe("Hello, agent!");
		});

		it("appends turns in order", async () => {
			await store.save(makeSession());

			await store.appendTurn("test-id-1", makeTurn({ turnId: "t-1", timestamp: "2024-01-15T10:01:00.000Z" }));
			await store.appendTurn("test-id-1", makeTurn({ turnId: "t-2", timestamp: "2024-01-15T10:02:00.000Z" }));
			await store.appendTurn("test-id-1", makeTurn({ turnId: "t-3", timestamp: "2024-01-15T10:03:00.000Z" }));

			const record = await store.get("test-id-1");
			expect(record!.turns).toHaveLength(3);
			expect(record!.turns![0].turnId).toBe("t-1");
			expect(record!.turns![1].turnId).toBe("t-2");
			expect(record!.turns![2].turnId).toBe("t-3");
		});

		it("caps at 100 turns (removes oldest)", async () => {
			await store.save(makeSession());

			// Add 105 turns
			for (let i = 0; i < 105; i++) {
				await store.appendTurn("test-id-1", makeTurn({ turnId: `t-${i}` }));
			}

			const record = await store.get("test-id-1");
			expect(record!.turns).toHaveLength(100);
			// Oldest 5 removed, first remaining is t-5
			expect(record!.turns![0].turnId).toBe("t-5");
			expect(record!.turns![99].turnId).toBe("t-104");
		});

		it("preserves token usage data", async () => {
			await store.save(makeSession());
			const turn = makeTurn({
				tokenUsage: { input: 1500, output: 500, model: "gpt-4o" },
			});

			await store.appendTurn("test-id-1", turn);

			const record = await store.get("test-id-1");
			expect(record!.turns![0].tokenUsage).toEqual({ input: 1500, output: 500, model: "gpt-4o" });
		});

		it("returns undefined for non-existent session", async () => {
			const result = await store.appendTurn("ghost", makeTurn());
			expect(result).toBeUndefined();
		});

		it("persists turns to disk", async () => {
			await store.save(makeSession());
			await store.appendTurn("test-id-1", makeTurn());

			// Fresh store instance
			const store2 = new SessionStore(tmpDir);
			const record = await store2.get("test-id-1");
			expect(record!.turns).toHaveLength(1);
		});

		it("appends to session that already has turns", async () => {
			await store.save(
				makeSession({
					turns: [makeTurn({ turnId: "existing-1" })],
				}),
			);

			await store.appendTurn("test-id-1", makeTurn({ turnId: "new-1" }));

			const record = await store.get("test-id-1");
			expect(record!.turns).toHaveLength(2);
			expect(record!.turns![0].turnId).toBe("existing-1");
			expect(record!.turns![1].turnId).toBe("new-1");
		});
	});
});

describe("truncatePreview", () => {
	it("returns short strings unchanged", () => {
		expect(truncatePreview("hello")).toBe("hello");
	});

	it("truncates strings over the limit", () => {
		const long = "a".repeat(250);
		const result = truncatePreview(long);
		expect(result.length).toBe(200);
		expect(result.endsWith("…")).toBe(true);
	});

	it("respects custom maxLen", () => {
		const result = truncatePreview("hello world", 5);
		expect(result).toBe("hell…");
	});

	it("handles exactly-at-limit strings", () => {
		const exact = "a".repeat(200);
		expect(truncatePreview(exact)).toBe(exact);
	});

	it("handles empty strings", () => {
		expect(truncatePreview("")).toBe("");
	});
});

describe("buildTurnSummary", () => {
	it("builds a TurnSummary from a turn result", () => {
		const result = buildTurnSummary({
			turnId: "turn-abc",
			responseText: "Here is the fix for the bug.",
			toolCalls: 3,
			usage: { inputTokens: 1200, outputTokens: 400, model: "gpt-4o" },
			state: "complete",
			userMessage: "Fix the failing tests",
		});

		expect(result.turnId).toBe("turn-abc");
		expect(result.userMessage).toBe("Fix the failing tests");
		expect(result.responsePreview).toBe("Here is the fix for the bug.");
		expect(result.toolCallCount).toBe(3);
		expect(result.tokenUsage).toEqual({ input: 1200, output: 400, model: "gpt-4o" });
		expect(result.state).toBe("complete");
		expect(result.timestamp).toBeDefined();
	});

	it("truncates long messages", () => {
		const longMsg = "x".repeat(300);
		const result = buildTurnSummary({
			turnId: "t",
			responseText: longMsg,
			toolCalls: 0,
			state: "complete",
			userMessage: longMsg,
		});

		expect(result.userMessage.length).toBe(200);
		expect(result.responsePreview.length).toBe(200);
	});

	it("handles missing usage", () => {
		const result = buildTurnSummary({
			turnId: "t",
			responseText: "done",
			toolCalls: 0,
			state: "complete",
			userMessage: "do it",
		});

		expect(result.tokenUsage).toBeUndefined();
	});

	it("handles empty response", () => {
		const result = buildTurnSummary({
			turnId: "t",
			responseText: "",
			toolCalls: 0,
			state: "error",
			userMessage: "do it",
		});

		expect(result.responsePreview).toBe("(no response)");
	});

	it("preserves error and cancelled states", () => {
		expect(
			buildTurnSummary({
				turnId: "t",
				responseText: "",
				toolCalls: 0,
				state: "error",
				userMessage: "",
			}).state,
		).toBe("error");

		expect(
			buildTurnSummary({
				turnId: "t",
				responseText: "",
				toolCalls: 0,
				state: "cancelled",
				userMessage: "",
			}).state,
		).toBe("cancelled");
	});
});
