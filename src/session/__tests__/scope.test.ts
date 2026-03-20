import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot, resolveSession } from "../scope.js";
import type { SessionRecord } from "../store.js";
import { SessionStore } from "../store.js";

/** Helper to create a minimal session record. */
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

describe("findGitRoot", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-scope-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("finds .git in the same directory", async () => {
		await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });

		const result = await findGitRoot(tmpDir);
		expect(result).toBe(tmpDir);
	});

	it("finds .git in a parent directory", async () => {
		await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
		const subDir = path.join(tmpDir, "src", "lib");
		await fs.mkdir(subDir, { recursive: true });

		const result = await findGitRoot(subDir);
		expect(result).toBe(tmpDir);
	});

	it("returns undefined when no .git found", async () => {
		const noGitDir = path.join(tmpDir, "no-git-here");
		await fs.mkdir(noGitDir, { recursive: true });

		const result = await findGitRoot(noGitDir);
		expect(result).toBeUndefined();
	});

	it("stops at the nearest .git (does not traverse past it)", async () => {
		// Create nested git repos
		const outer = path.join(tmpDir, "outer");
		const inner = path.join(outer, "inner");
		await fs.mkdir(path.join(outer, ".git"), { recursive: true });
		await fs.mkdir(path.join(inner, ".git"), { recursive: true });
		const deepDir = path.join(inner, "src");
		await fs.mkdir(deepDir, { recursive: true });

		const result = await findGitRoot(deepDir);
		expect(result).toBe(inner);
	});
});

describe("resolveSession", () => {
	let tmpDir: string;
	let storeDir: string;
	let store: SessionStore;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-resolve-test-"));
		storeDir = path.join(tmpDir, "store");
		store = new SessionStore(storeDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("matches session at exact cwd", async () => {
		const projectDir = path.join(tmpDir, "project");
		await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });

		await store.save(
			makeSession({
				id: "cwd-match",
				workingDirectory: projectDir,
				serverName: "local",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: projectDir,
			store,
		});
		expect(result).toBeDefined();
		expect(result!.id).toBe("cwd-match");
	});

	it("walks up to find session at parent directory", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		const subDir = path.join(gitRoot, "src", "lib");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });
		await fs.mkdir(subDir, { recursive: true });

		// Session is at the git root level
		await store.save(
			makeSession({
				id: "parent-match",
				workingDirectory: gitRoot,
				serverName: "local",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: subDir,
			store,
		});
		expect(result).toBeDefined();
		expect(result!.id).toBe("parent-match");
	});

	it("prefers closer match (deeper directory wins)", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		const srcDir = path.join(gitRoot, "src");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });
		await fs.mkdir(srcDir, { recursive: true });

		await store.save(
			makeSession({
				id: "root-session",
				workingDirectory: gitRoot,
				serverName: "local",
				createdAt: "2024-01-15T10:00:00.000Z",
			}),
		);
		await store.save(
			makeSession({
				id: "src-session",
				workingDirectory: srcDir,
				serverName: "local",
				createdAt: "2024-01-15T11:00:00.000Z",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: srcDir,
			store,
		});
		expect(result!.id).toBe("src-session");
	});

	it("selects named session within scope", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });

		await store.save(
			makeSession({
				id: "unnamed",
				workingDirectory: gitRoot,
				serverName: "local",
				createdAt: "2024-01-15T11:00:00.000Z",
			}),
		);
		await store.save(
			makeSession({
				id: "named-feature",
				workingDirectory: gitRoot,
				serverName: "local",
				name: "feature",
				createdAt: "2024-01-15T10:00:00.000Z",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: gitRoot,
			name: "feature",
			store,
		});
		expect(result!.id).toBe("named-feature");
	});

	it("skips closed sessions", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });

		await store.save(
			makeSession({
				id: "closed-one",
				workingDirectory: gitRoot,
				serverName: "local",
				status: "closed",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: gitRoot,
			store,
		});
		expect(result).toBeUndefined();
	});

	it("does not walk past git root", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		const subDir = path.join(gitRoot, "deep");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });
		await fs.mkdir(subDir, { recursive: true });

		// Session is ABOVE the git root — should not be found
		await store.save(
			makeSession({
				id: "above-git",
				workingDirectory: tmpDir,
				serverName: "local",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: subDir,
			store,
		});
		expect(result).toBeUndefined();
	});

	it("matches only exact cwd when no git root", async () => {
		const noGitDir = path.join(tmpDir, "no-git", "sub");
		await fs.mkdir(noGitDir, { recursive: true });

		// Session at parent — should NOT match since no git root
		await store.save(
			makeSession({
				id: "parent-session",
				workingDirectory: path.join(tmpDir, "no-git"),
				serverName: "local",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: noGitDir,
			store,
		});
		expect(result).toBeUndefined();
	});

	it("matches exact cwd even without git root", async () => {
		const noGitDir = path.join(tmpDir, "no-git");
		await fs.mkdir(noGitDir, { recursive: true });

		await store.save(
			makeSession({
				id: "exact-match",
				workingDirectory: noGitDir,
				serverName: "local",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: noGitDir,
			store,
		});
		expect(result).toBeDefined();
		expect(result!.id).toBe("exact-match");
	});

	it("filters by server name", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });

		await store.save(
			makeSession({
				id: "wrong-server",
				workingDirectory: gitRoot,
				serverName: "prod",
			}),
		);

		const result = await resolveSession({
			serverName: "local",
			cwd: gitRoot,
			store,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined for empty store", async () => {
		const gitRoot = path.join(tmpDir, "repo");
		await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });

		const result = await resolveSession({
			serverName: "local",
			cwd: gitRoot,
			store,
		});
		expect(result).toBeUndefined();
	});
});
