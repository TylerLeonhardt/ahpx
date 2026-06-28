import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { RpcError } from "../../client/index.js";
import { SessionPersistence } from "../persistence.js";
import type { SessionRecord } from "../store.js";
import { SessionStore } from "../store.js";

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

/** Create a mock AhpClient with controllable behavior. */
function createMockClient(opts: {
	subscribeResult?: { snapshot?: { resource: string; state: unknown } };
	subscribeError?: Error;
	listSessionsResult?: {
		items: Array<{
			resource: string;
			provider: string;
			title: string;
			status: string;
			createdAt: number;
			modifiedAt: number;
		}>;
	};
}) {
	const emitter = new EventEmitter();
	const client = Object.assign(emitter, {
		connected: true,
		subscribe: opts.subscribeError
			? vi.fn().mockRejectedValue(opts.subscribeError)
			: vi.fn().mockResolvedValue(opts.subscribeResult ?? { snapshot: { resource: "copilot:/test-1", state: {} } }),
		listSessions: vi.fn().mockResolvedValue(opts.listSessionsResult ?? { items: [] }),
		state: {
			root: { agents: [] },
			getSession: vi.fn().mockReturnValue(undefined),
		},
	}) as unknown as AhpClient;

	return client;
}

describe("SessionPersistence", () => {
	let tmpDir: string;
	let store: SessionStore;
	let persistence: SessionPersistence;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-persistence-test-"));
		store = new SessionStore(tmpDir);
		persistence = new SessionPersistence(store);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("resume", () => {
		it("returns 'resumed' when subscribe succeeds", async () => {
			const record = makeSession();
			const client = createMockClient({});

			const outcome = await persistence.resume(record, client);

			expect(outcome.status).toBe("resumed");
			expect(client.subscribe).toHaveBeenCalledWith("copilot:/test-1");
		});

		it("returns 'not_found' when server returns SessionNotFound", async () => {
			const record = makeSession();
			const client = createMockClient({
				subscribeError: new RpcError(-32001, "Session not found"),
			});

			const outcome = await persistence.resume(record, client);

			expect(outcome.status).toBe("not_found");
		});

		it("returns 'error' for non-session-not-found RPC errors", async () => {
			const record = makeSession();
			const client = createMockClient({
				subscribeError: new RpcError(-32000, "Internal error"),
			});

			const outcome = await persistence.resume(record, client);

			expect(outcome.status).toBe("error");
			if (outcome.status === "error") {
				expect(outcome.message).toContain("Internal error");
			}
		});

		it("returns 'error' for generic errors", async () => {
			const record = makeSession();
			const client = createMockClient({
				subscribeError: new Error("Connection refused"),
			});

			const outcome = await persistence.resume(record, client);

			expect(outcome.status).toBe("error");
			if (outcome.status === "error") {
				expect(outcome.message).toContain("Connection refused");
			}
		});
	});

	describe("saveTurn", () => {
		it("appends a turn summary to a session record", async () => {
			await store.save(makeSession());

			const updated = await persistence.saveTurn("test-id-1", {
				turnId: "turn-abc",
				responseText: "Done!",
				toolCalls: 2,
				usage: { inputTokens: 100, outputTokens: 50 },
				state: "complete",
				userMessage: "Fix the tests",
			});

			expect(updated).toBeDefined();
			expect(updated!.turns).toHaveLength(1);
			expect(updated!.turns![0].turnId).toBe("turn-abc");
			expect(updated!.turns![0].userMessage).toBe("Fix the tests");
			expect(updated!.turns![0].responsePreview).toBe("Done!");
			expect(updated!.turns![0].toolCallCount).toBe(2);
			expect(updated!.turns![0].tokenUsage).toEqual({ input: 100, output: 50 });
			expect(updated!.turns![0].state).toBe("complete");
		});

		it("returns undefined for non-existent session", async () => {
			const result = await persistence.saveTurn("ghost", {
				turnId: "t",
				responseText: "",
				toolCalls: 0,
				state: "complete",
				userMessage: "",
			});
			expect(result).toBeUndefined();
		});

		it("persists multiple turns in order", async () => {
			await store.save(makeSession());

			await persistence.saveTurn("test-id-1", {
				turnId: "t-1",
				responseText: "First",
				toolCalls: 0,
				state: "complete",
				userMessage: "Q1",
			});
			await persistence.saveTurn("test-id-1", {
				turnId: "t-2",
				responseText: "Second",
				toolCalls: 1,
				state: "complete",
				userMessage: "Q2",
			});

			const record = await store.get("test-id-1");
			expect(record!.turns).toHaveLength(2);
			expect(record!.turns![0].turnId).toBe("t-1");
			expect(record!.turns![1].turnId).toBe("t-2");
		});
	});

	describe("sync", () => {
		it("detects sessions on server not in local store", async () => {
			const client = createMockClient({
				listSessionsResult: {
					items: [
						{
							resource: "copilot:/server-only",
							provider: "copilot",
							title: "Server Session",
							status: "idle",
							createdAt: Date.now(),
							modifiedAt: Date.now(),
						},
					],
				},
			});

			const result = await persistence.sync(client, "local");

			expect(result.added).toContain("copilot:/server-only");
			expect(result.removed).toHaveLength(0);
			expect(result.updated).toHaveLength(0);
		});

		it("closes local records whose sessions no longer exist on server", async () => {
			await store.save(makeSession({ id: "stale", sessionUri: "copilot:/stale" }));

			const client = createMockClient({
				listSessionsResult: { items: [] },
			});

			const result = await persistence.sync(client, "local");

			expect(result.removed).toContain("stale");
			// Verify record was actually closed
			const record = await store.get("stale");
			expect(record!.status).toBe("closed");
		});

		it("detects title changes", async () => {
			await store.save(
				makeSession({
					id: "has-session",
					sessionUri: "copilot:/has-session",
					title: "Old Title",
				}),
			);

			const client = createMockClient({
				listSessionsResult: {
					items: [
						{
							resource: "copilot:/has-session",
							provider: "copilot",
							title: "New Title",
							status: "idle",
							createdAt: Date.now(),
							modifiedAt: Date.now(),
						},
					],
				},
			});

			const result = await persistence.sync(client, "local");

			expect(result.updated).toContain("has-session");
			const record = await store.get("has-session");
			expect(record!.title).toBe("New Title");
		});

		it("handles mixed state (added, removed, updated, unchanged)", async () => {
			await store.save(
				makeSession({
					id: "existing",
					sessionUri: "copilot:/existing",
					title: "Same",
				}),
			);
			await store.save(
				makeSession({
					id: "stale",
					sessionUri: "copilot:/stale",
				}),
			);
			await store.save(
				makeSession({
					id: "updated",
					sessionUri: "copilot:/updated",
					title: "Old",
				}),
			);

			const client = createMockClient({
				listSessionsResult: {
					items: [
						{
							resource: "copilot:/existing",
							provider: "copilot",
							title: "Same",
							status: "idle",
							createdAt: Date.now(),
							modifiedAt: Date.now(),
						},
						{
							resource: "copilot:/updated",
							provider: "copilot",
							title: "New",
							status: "idle",
							createdAt: Date.now(),
							modifiedAt: Date.now(),
						},
						{
							resource: "copilot:/brand-new",
							provider: "copilot",
							title: "Fresh",
							status: "idle",
							createdAt: Date.now(),
							modifiedAt: Date.now(),
						},
					],
				},
			});

			const result = await persistence.sync(client, "local");

			expect(result.added).toContain("copilot:/brand-new");
			expect(result.removed).toContain("stale");
			expect(result.updated).toContain("updated");
			// "existing" has same title — should not be in updated
			expect(result.updated).not.toContain("existing");
		});

		it("only processes records for the specified server", async () => {
			await store.save(
				makeSession({
					id: "other-server",
					sessionUri: "copilot:/other-server",
					serverName: "prod",
				}),
			);
			await store.save(
				makeSession({
					id: "this-server",
					sessionUri: "copilot:/this-server",
					serverName: "local",
				}),
			);

			const client = createMockClient({
				listSessionsResult: { items: [] },
			});

			const result = await persistence.sync(client, "local");

			// Should only close the 'local' server's record
			expect(result.removed).toContain("this-server");
			expect(result.removed).not.toContain("other-server");

			// prod session untouched
			const prodRecord = await store.get("other-server");
			expect(prodRecord!.status).toBe("active");
		});
	});
});
