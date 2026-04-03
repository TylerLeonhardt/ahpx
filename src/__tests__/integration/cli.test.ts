/**
 * CLI integration tests — run the ahpx binary against a real mock AHP server.
 *
 * These tests spawn the actual CLI binary and verify it works end-to-end
 * over real WebSocket connections to a mock server.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MockServer, createMockServer } from "../helpers/mock-server.js";

const BIN = path.resolve("dist", "bin.js");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

/** Run the CLI binary with args and capture output */
function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn(process.execPath, [BIN, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
			timeout: 15_000,
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			resolve({
				stdout: normalize(stdout),
				stderr: normalize(stderr),
				exitCode: code ?? 1,
			});
		});

		child.on("error", () => {
			resolve({
				stdout: normalize(stdout),
				stderr: normalize(stderr),
				exitCode: 1,
			});
		});
	});
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("CLI integration", () => {
	let server: MockServer;

	afterEach(async () => {
		try {
			await server?.close();
		} catch {
			/* best-effort */
		}
	});

	it("ahpx connect succeeds against mock server", async () => {
		server = await createMockServer();

		const result = await runCli("connect", server.url);

		// Connect should succeed (exit 0) or show connection info
		// The exact output depends on the CLI implementation
		expect(result.exitCode).toBe(0);
	});

	it("ahpx agents lists available agents from mock server", async () => {
		server = await createMockServer();

		const result = await runCli("agents", "-s", server.url);

		expect(result.exitCode).toBe(0);
		// Should show the mock agent
		expect(result.stdout).toContain("mock-agent");
	});

	it("ahpx connect to non-existent server fails with error", async () => {
		// Don't start a server - connect to nothing
		server = { close: async () => {} } as MockServer;

		const result = await runCli("connect", "ws://127.0.0.1:1");

		expect(result.exitCode).not.toBe(0);
	});

	it("ahpx agents with --json flag produces JSON output", async () => {
		server = await createMockServer();

		const result = await runCli("agents", "-s", server.url, "--format", "json");

		expect(result.exitCode).toBe(0);
		// JSON output should be parseable
		const lines = result.stdout.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});
