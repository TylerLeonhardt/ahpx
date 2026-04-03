import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * End-to-end tests for the ahpx CLI.
 *
 * These tests invoke the **built** CLI binary (dist/bin.js) as a subprocess
 * and verify its behavior from the outside — the same way a user would run it.
 *
 * Cross-platform considerations:
 * - Uses `process.execPath` for the Node binary (not hardcoded "node")
 * - Uses `path.resolve` for the binary path (not string concatenation)
 * - Normalizes line endings before assertions (Windows emits \r\n)
 * - Avoids path separators in output assertions
 *
 * Prerequisites: `npm run build` must have been run before these tests execute.
 * In CI, the build step runs before the test step.
 */

const BIN = path.resolve("dist", "bin.js");

/** Normalize Windows \r\n to \n for consistent assertions. */
function normalize(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

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

// ── Help & version ──────────────────────────────────────────────────────────

describe("E2E: --help and --version", () => {
	it("ahpx --help exits 0 and prints usage", async () => {
		const { exitCode, stdout } = await runCli("--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage:");
		expect(stdout).toContain("ahpx");
	});

	it("ahpx --version exits 0 and prints a semver string", async () => {
		const { exitCode, stdout } = await runCli("--version");
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

// ── Server management (no server running) ───────────────────────────────────

describe("E2E: server commands without a running server", () => {
	it("server list exits 0 with no connections", async () => {
		const { exitCode } = await runCli("server", "list");
		expect(exitCode).toBe(0);
	});

	it("server list --format json returns valid JSON array", async () => {
		const { exitCode, stdout } = await runCli("--format", "json", "server", "list");
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout.trim());
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("server add without --url exits non-zero with error", async () => {
		const { exitCode, stderr } = await runCli("server", "add", "test-srv");
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--url");
	});

	it("server remove without name exits non-zero", async () => {
		const { exitCode } = await runCli("server", "remove");
		expect(exitCode).not.toBe(0);
	});
});

// ── Session management (no sessions) ────────────────────────────────────────

describe("E2E: session commands without sessions", () => {
	it("session list exits 0", async () => {
		const { exitCode } = await runCli("session", "list");
		expect(exitCode).toBe(0);
	});

	it("session list --format json returns valid JSON array", async () => {
		const { exitCode, stdout } = await runCli("--format", "json", "session", "list");
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout.trim());
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("session show with bogus id exits non-zero", async () => {
		const { exitCode } = await runCli("session", "show", "nonexistent-000-000");
		expect(exitCode).not.toBe(0);
	});

	it("session export without id exits non-zero", async () => {
		const { exitCode } = await runCli("session", "export");
		expect(exitCode).not.toBe(0);
	});
});

// ── Connect command (no server) ─────────────────────────────────────────────

describe("E2E: connect command", () => {
	it("connect --help exits 0 and describes the command", async () => {
		const { exitCode, stdout } = await runCli("connect", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("target");
	});
});

// ── Config commands ─────────────────────────────────────────────────────────

describe("E2E: config commands", () => {
	it("config show exits 0", async () => {
		const { exitCode } = await runCli("config", "show");
		expect(exitCode).toBe(0);
	});

	it("config show --format json outputs valid JSON", async () => {
		const { exitCode, stdout } = await runCli("--format", "json", "config", "show");
		expect(exitCode).toBe(0);
		expect(() => JSON.parse(stdout.trim())).not.toThrow();
	});
});

// ── Completions ─────────────────────────────────────────────────────────────

describe("E2E: shell completions", () => {
	it("completions bash exits 0 and outputs a shell script", async () => {
		const { exitCode, stdout } = await runCli("completions", "bash");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("ahpx");
	});

	it("completions zsh exits 0 and outputs a shell script", async () => {
		const { exitCode, stdout } = await runCli("completions", "zsh");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("ahpx");
	});

	it("completions fish exits 0 and outputs a shell script", async () => {
		const { exitCode, stdout } = await runCli("completions", "fish");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("ahpx");
	});
});

// ── Global options ──────────────────────────────────────────────────────────

describe("E2E: global options", () => {
	it("--verbose flag is accepted", async () => {
		const { exitCode } = await runCli("--verbose", "--help");
		expect(exitCode).toBe(0);
	});

	it("-v shorthand is accepted", async () => {
		const { exitCode } = await runCli("-v", "--help");
		expect(exitCode).toBe(0);
	});

	it("--format json is accepted", async () => {
		const { exitCode } = await runCli("--format", "json", "--help");
		expect(exitCode).toBe(0);
	});
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("E2E: error handling and exit codes", () => {
	it("server add with invalid URL scheme shows error", async () => {
		const { exitCode } = await runCli("server", "add", "bad", "--url", "not-a-url");
		expect(exitCode).not.toBe(0);
	});

	it("session new with remote URL and no --cwd exits with usage error (code 2)", async () => {
		const { exitCode, stderr } = await runCli("session", "new", "--server", "ws://remote.example.com:3000");
		expect(exitCode).toBe(2);
		expect(stderr).toContain("--cwd is required");
	});
});
