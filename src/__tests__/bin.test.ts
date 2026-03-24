import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Flakiness note (Debt Cycle Round 1, March 2026):
 * Four tests in this file were observed to fail intermittently during full
 * suite runs while passing in isolation. This suggests a test-isolation issue
 * — possibly shared state, temp files, or port conflicts with other test files.
 *
 * Debt Cycle Round 2 ran the full suite 3 consecutive times with zero failures
 * in bin.test.ts (33/33 pass each run). The flakiness was not reproduced.
 *
 * If flakiness resurfaces, investigate:
 *   1. Shared temp directories or files across test suites
 *   2. Process spawn conflicts (port collisions, env leaks)
 *   3. Global mock state bleeding from other test files (vitest runs in parallel)
 *   4. Timing-sensitive assertions on spawned process output
 */

/**
 * Run the CLI via `node dist/bin.js` and capture stdout, stderr, and exit code.
 * Uses spawn with stdin set to "ignore" to prevent the implicit stdin-pipe
 * detection from blocking the process.
 */
function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", ["dist/bin.js", ...args], {
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
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});

		child.on("error", () => {
			resolve({ stdout, stderr, exitCode: 1 });
		});
	});
}

// ── --help / --version ──────────────────────────────────────────────────────

describe("CLI integration: --help and --version", () => {
	it("ahpx --help exits 0 and output contains 'ahpx'", async () => {
		const result = await runCli("--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpx");
	});

	it("ahpx --help describes key subcommands", async () => {
		const result = await runCli("--help");
		expect(result.stdout).toContain("connect");
		expect(result.stdout).toContain("server");
		expect(result.stdout).toContain("session");
		expect(result.stdout).toContain("config");
		expect(result.stdout).toContain("prompt");
		expect(result.stdout).toContain("exec");
	});

	it("ahpx --version exits 0 and outputs a semver string", async () => {
		const result = await runCli("--version");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

// ── Subcommand --help ────────────────────────────────────────────────────────

describe("CLI integration: subcommand --help", () => {
	it("server --help exits 0 and lists subcommands", async () => {
		const result = await runCli("server", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("add");
		expect(result.stdout).toContain("list");
		expect(result.stdout).toContain("remove");
		expect(result.stdout).toContain("test");
		expect(result.stdout).toContain("status");
		expect(result.stdout).toContain("health");
	});

	it("session --help exits 0 and lists subcommands", async () => {
		const result = await runCli("session", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("new");
		expect(result.stdout).toContain("list");
		expect(result.stdout).toContain("show");
		expect(result.stdout).toContain("close");
		expect(result.stdout).toContain("history");
	});

	it("config --help exits 0 and lists subcommands", async () => {
		const result = await runCli("config", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("show");
		expect(result.stdout).toContain("init");
	});

	it("connect --help exits 0 and mentions target", async () => {
		const result = await runCli("connect", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("target");
	});

	it("prompt --help exits 0 and mentions prompt text", async () => {
		const result = await runCli("prompt", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("text");
	});

	it("exec --help exits 0 and describes one-shot", async () => {
		const result = await runCli("exec", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toLowerCase()).toMatch(/one-shot|exec/);
	});

	it("watch --help exits 0", async () => {
		const result = await runCli("watch", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("watch");
	});

	it("completions --help exits 0 and lists shells", async () => {
		const result = await runCli("completions", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("bash");
		expect(result.stdout).toContain("zsh");
		expect(result.stdout).toContain("fish");
	});

	it("model --help exits 0", async () => {
		const result = await runCli("model", "--help");
		expect(result.exitCode).toBe(0);
	});

	it("agents --help exits 0", async () => {
		const result = await runCli("agents", "--help");
		expect(result.exitCode).toBe(0);
	});

	it("cancel --help exits 0", async () => {
		const result = await runCli("cancel", "--help");
		expect(result.exitCode).toBe(0);
	});
});

// ── Error handling / missing args ────────────────────────────────────────────

describe("CLI integration: error handling", () => {
	it("server add without required --url exits non-zero", async () => {
		const result = await runCli("server", "add", "test-server");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("--url");
	});

	it("server add without name argument shows --url error", async () => {
		// Commander reports the first missing required option before checking positional args
		const result = await runCli("server", "add");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("--url");
	});

	it("server remove without name argument exits non-zero", async () => {
		const result = await runCli("server", "remove");
		expect(result.exitCode).not.toBe(0);
	});

	it("session export without id argument exits non-zero", async () => {
		const result = await runCli("session", "export");
		expect(result.exitCode).not.toBe(0);
	});
});

// ── Global options ──────────────────────────────────────────────────────────

describe("CLI integration: global options", () => {
	it("--format json works with --help", async () => {
		const result = await runCli("--format", "json", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpx");
	});

	it("--verbose flag is accepted without error", async () => {
		const result = await runCli("--verbose", "--help");
		expect(result.exitCode).toBe(0);
	});

	it("-v shorthand for verbose is accepted", async () => {
		const result = await runCli("-v", "--help");
		expect(result.exitCode).toBe(0);
	});
});

// ── Output format ────────────────────────────────────────────────────────────

describe("CLI integration: output format", () => {
	it("config show --format json outputs valid JSON", async () => {
		const result = await runCli("--format", "json", "config", "show");
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
	});

	it("server list --format json outputs valid JSON", async () => {
		const result = await runCli("--format", "json", "server", "list");
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
	});

	it("session list --format json outputs valid JSON", async () => {
		const result = await runCli("--format", "json", "session", "list");
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout.trim());
		expect(Array.isArray(parsed)).toBe(true);
	});
});

// ── Completions generation ──────────────────────────────────────────────────

describe("CLI integration: completions", () => {
	it("completions bash outputs shell script", async () => {
		const result = await runCli("completions", "bash");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpx");
	});

	it("completions zsh outputs shell script", async () => {
		const result = await runCli("completions", "zsh");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpx");
	});

	it("completions fish outputs shell script", async () => {
		const result = await runCli("completions", "fish");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpx");
	});
});

// ── Session list (always works) ──────────────────────────────────────────────

describe("CLI integration: session commands", () => {
	it("session list exits 0", async () => {
		const result = await runCli("session", "list");
		expect(result.exitCode).toBe(0);
	});

	it("session show with a bogus id exits non-zero", async () => {
		const result = await runCli("session", "show", "nonexistent-session-id-000");
		expect(result.exitCode).not.toBe(0);
	});

	it("session active --help exits 0", async () => {
		const result = await runCli("session", "active", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("active");
	});
});

// ── Implicit prompt detection ────────────────────────────────────────────────

describe("CLI integration: implicit prompt detection", () => {
	it("known command names are not treated as implicit prompts", async () => {
		const result = await runCli("server", "--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Manage saved server connections");
	});

	it("--help is routed to Commander, not treated as prompt text", async () => {
		const result = await runCli("--help");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage:");
	});

	it("--version is routed to Commander, not treated as prompt text", async () => {
		const result = await runCli("--version");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

// ── Remote server --cwd validation ──────────────────────────────────────────

describe("CLI integration: --cwd required for remote servers", () => {
	it("session new with remote ws:// URL and no --cwd exits with usage error", async () => {
		const result = await runCli("session", "new", "--server", "ws://remote.example.com:3000");
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--cwd is required when targeting a remote server");
	});

	it("session new with remote ws:// URL and --cwd succeeds past validation", async () => {
		// Will fail on connection (no server running), but should NOT fail on --cwd validation
		const result = await runCli("session", "new", "--server", "ws://remote.example.com:3000", "--cwd", "/remote/path");
		expect(result.exitCode).not.toBe(2);
		expect(result.stderr).not.toContain("--cwd is required");
	});

	it("session new with localhost URL and no --cwd does not require --cwd", async () => {
		// Will fail on connection, but should NOT fail on --cwd validation
		const result = await runCli("session", "new", "--server", "ws://localhost:9999");
		expect(result.exitCode).not.toBe(2);
		expect(result.stderr).not.toContain("--cwd is required");
	});

	it("prompt with remote ws:// URL and no --cwd exits with usage error", async () => {
		const result = await runCli("prompt", "hello", "--server", "ws://remote.example.com:3000");
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--cwd is required when targeting a remote server");
	});

	it("exec with remote ws:// URL and no --cwd exits with usage error", async () => {
		const result = await runCli("exec", "hello", "--server", "ws://remote.example.com:3000");
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--cwd is required when targeting a remote server");
	});

	it("error message suggests ahpx browse", async () => {
		const result = await runCli("session", "new", "--server", "ws://remote.example.com:3000");
		expect(result.stderr).toContain("ahpx browse");
	});

	it("session new with no --server does not require --cwd", async () => {
		// Without --server, uses default (local) — no --cwd requirement
		// May fail for other reasons (no default server) but not for --cwd
		const result = await runCli("session", "new");
		expect(result.stderr).not.toContain("--cwd is required");
	});
});
