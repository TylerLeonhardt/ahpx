/**
 * Acceptance test for the persistent `defaultSessionConfig` feature.
 *
 * Proves the feature from the user's perspective, end-to-end, by spawning the
 * actual CLI binary against a real mock AHP server over a real WebSocket:
 *
 *   1. `ahpx config set defaultSessionConfig.isolation folder`  (persist a default)
 *   2. `ahpx exec ...`                                          (create a session, no -c)
 *   3. Assert the `config` the server received on `createSession` reflects the
 *      persisted default — i.e. `{ isolation: "folder" }`.
 *
 * A second case proves precedence: an explicit `-c isolation=worktree` always
 * wins over the persisted default.
 *
 * HOME is isolated to a temp dir so the real `~/.ahpx/config.json` is untouched.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockServer, createMockServer, echoScenario } from "../helpers/mock-server.js";

const BIN = path.resolve("dist", "bin.js");

function runCli(
	args: string[],
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn(process.execPath, [BIN, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", ...env },
			timeout: 15_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString();
		});
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
	});
}

describe("defaultSessionConfig acceptance (live CLI + mock server)", () => {
	let server: MockServer;
	let homeDir: string;
	let env: Record<string, string>;
	let capturedConfigs: Array<Record<string, unknown> | undefined>;

	beforeEach(async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-dsc-home-"));
		env = { HOME: homeDir, USERPROFILE: homeDir };
		capturedConfigs = [];
	});

	afterEach(async () => {
		try {
			await server?.close();
		} catch {
			/* best-effort */
		}
		await fs.rm(homeDir, { recursive: true, force: true });
	});

	async function startServer(): Promise<void> {
		server = await createMockServer({
			...echoScenario(),
			onCreateSession: (params) => {
				capturedConfigs.push(params.config as Record<string, unknown> | undefined);
				return undefined;
			},
		});
	}

	it("persists a default and applies it to a new session created WITHOUT -c", async () => {
		await startServer();

		// 1. Persist the default via the config CLI.
		const set = await runCli(["config", "set", "defaultSessionConfig.isolation", "folder"], env);
		expect(set.exitCode).toBe(0);

		// It really landed in the isolated global config.
		const persisted = JSON.parse(await fs.readFile(path.join(homeDir, ".ahpx", "config.json"), "utf-8"));
		expect(persisted.defaultSessionConfig).toEqual({ isolation: "folder" });

		// 2. Create a session via exec — note: NO -c flag.
		const exec = await runCli(["exec", "say hi", "-s", server.url, "--approve-all", "--format", "json"], env);
		expect(exec.exitCode).toBe(0);

		// 3. The server saw the persisted default on createSession.
		expect(capturedConfigs.length).toBeGreaterThan(0);
		expect(capturedConfigs[0]).toEqual({ isolation: "folder" });
	});

	it("lets an explicit -c flag override the persisted default", async () => {
		await startServer();

		const set = await runCli(["config", "set", "defaultSessionConfig.isolation", "folder"], env);
		expect(set.exitCode).toBe(0);

		const exec = await runCli(
			["exec", "say hi", "-s", server.url, "-c", "isolation=worktree", "--approve-all", "--format", "json"],
			env,
		);
		expect(exec.exitCode).toBe(0);

		expect(capturedConfigs[0]).toEqual({ isolation: "worktree" });
	});

	it("sends no config when nothing is persisted and no -c is passed", async () => {
		await startServer();

		const exec = await runCli(["exec", "say hi", "-s", server.url, "--approve-all", "--format", "json"], env);
		expect(exec.exitCode).toBe(0);

		// No defaultSessionConfig + no -c → server receives an undefined config.
		expect(capturedConfigs[0]).toBeUndefined();
	});

	it("config get reports the persisted nested value", async () => {
		await startServer();

		await runCli(["config", "set", "defaultSessionConfig.isolation", "folder"], env);
		const get = await runCli(["config", "get", "defaultSessionConfig.isolation"], env);
		expect(get.exitCode).toBe(0);
		expect(get.stdout.trim()).toBe("folder");
	});
});
