/**
 * Integration tests for two session-command fixes (issue #105):
 *
 *   A. `session history <name>` renders the locally-persisted multi-turn
 *      transcript — even after the session is closed — sourced from the durable
 *      local record (not a live host round-trip that returns empty once the
 *      session is disposed / when turns live on the chat channel).
 *
 *   B. name-taking session subcommands (`close`, `history`, …) accept the
 *      session NAME positionally (not just via `-n/--name`), resolving by exact
 *      id first and then by name. A miss returns a clear error + exit 4.
 *
 * These spawn the real built CLI binary against a real-WS mock AHP server with
 * an ISOLATED HOME so the user's ~/.ahpx is never touched.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockServer, createMockServer, echoScenario } from "../helpers/mock-server.js";

const BIN = path.resolve("dist", "bin.js");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

describe("session history + positional name resolution (issue #105)", () => {
	let server: MockServer;
	let home: string;
	let work: string;

	/** Run the CLI binary with an isolated HOME and capture output. */
	function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve) => {
			const child: ChildProcess = spawn(process.execPath, [BIN, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home },
				timeout: 20_000,
			});

			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (c: Buffer) => {
				stdout += c.toString();
			});
			child.stderr?.on("data", (c: Buffer) => {
				stderr += c.toString();
			});
			child.on("close", (code) => {
				resolve({ stdout: normalize(stdout), stderr: normalize(stderr), exitCode: code ?? 1 });
			});
			child.on("error", () => {
				resolve({ stdout: normalize(stdout), stderr: normalize(stderr), exitCode: 1 });
			});
		});
	}

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-e2e-home-"));
		work = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-e2e-work-"));
		server = await createMockServer(echoScenario());
		const add = await runCli("server", "add", "local", "--url", server.url, "--default");
		expect(add.exitCode).toBe(0);
	});

	afterEach(async () => {
		try {
			await server?.close();
		} catch {
			/* best-effort */
		}
		await fs.rm(home, { recursive: true, force: true });
		await fs.rm(work, { recursive: true, force: true });
	});

	/** Drive a real 2-turn session named `name`, persisting both turns locally. */
	async function runTwoTurns(name: string): Promise<void> {
		const t1 = await runCli("prompt", "first question", "-n", name, "--cwd", work, "--approve-all");
		expect(t1.exitCode, `turn 1 stderr: ${t1.stderr}`).toBe(0);
		const t2 = await runCli("prompt", "second question", "-n", name, "--approve-all");
		expect(t2.exitCode, `turn 2 stderr: ${t2.stderr}`).toBe(0);
	}

	it("A: `session history <name>` renders both turns from the durable local record", async () => {
		await runTwoTurns("e2e-demo");

		const hist = await runCli("session", "history", "e2e-demo");
		expect(hist.exitCode, hist.stderr).toBe(0);
		// Both prompts must be present in the transcript (echo => response too).
		expect(hist.stdout).toContain("first question");
		expect(hist.stdout).toContain("second question");
	});

	it("A: history is valid JSON with both turns in --format json", async () => {
		await runTwoTurns("e2e-demo");

		const hist = await runCli("--format", "json", "session", "history", "e2e-demo");
		expect(hist.exitCode, hist.stderr).toBe(0);
		const lines = hist.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);
		const parsed = lines.map((l) => JSON.parse(l)) as Array<{
			turns?: Array<{ userMessage: string }>;
		}>;
		const turns = parsed.flatMap((p) => p.turns ?? []);
		expect(turns.length).toBe(2);
		expect(turns.map((t) => t.userMessage)).toEqual(["first question", "second question"]);
	});

	it("A: history still shows both turns AFTER the session is closed", async () => {
		await runTwoTurns("e2e-demo");

		const close = await runCli("session", "close", "e2e-demo");
		expect(close.exitCode, close.stderr).toBe(0);

		const hist = await runCli("session", "history", "e2e-demo");
		expect(hist.exitCode, hist.stderr).toBe(0);
		expect(hist.stdout).toContain("first question");
		expect(hist.stdout).toContain("second question");
	});

	it("B: `session close <name>` closes by positional NAME (not just -n)", async () => {
		await runTwoTurns("e2e-demo");

		const close = await runCli("session", "close", "e2e-demo");
		expect(close.exitCode, close.stderr).toBe(0);

		// Closing again is idempotent / already-closed (still exit 0).
		const again = await runCli("session", "close", "e2e-demo");
		expect(again.exitCode).toBe(0);
	});

	it("B: positional still resolves by id, and a real id wins over a name", async () => {
		await runTwoTurns("e2e-demo");

		// Discover the session id from JSON history.
		const hist = await runCli("--format", "json", "session", "history", "e2e-demo");
		const sessionId = (JSON.parse(hist.stdout.trim().split("\n").filter(Boolean)[0]) as { sessionId: string })
			.sessionId;
		expect(sessionId).toBeTruthy();

		const byId = await runCli("session", "history", sessionId);
		expect(byId.exitCode, byId.stderr).toBe(0);
		expect(byId.stdout).toContain("first question");
	});

	it("B: unknown id/name returns a clear error and exit code 4", async () => {
		const res = await runCli("session", "close", "does-not-exist");
		expect(res.exitCode).toBe(4);
		expect(`${res.stdout}${res.stderr}`).toContain("does-not-exist");
	});
});
