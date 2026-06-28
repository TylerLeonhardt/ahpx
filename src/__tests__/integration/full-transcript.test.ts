/**
 * Integration tests for full-transcript support (issue #107):
 *
 *   1. A multi-turn session persists the COMPLETE per-turn response text (not
 *      just the 200-char preview). `session history --full` and `--format json`
 *      surface the full response; the compact default stays truncated.
 *   2. `session export <name>` produces a complete transcript in both markdown
 *      (per-turn prompt + full response) and json (re-importable record whose
 *      turns carry the full text). Name is accepted positionally.
 *   3. Backward compatibility: a record written before 0.4.0 (only
 *      `responsePreview`, no `response`) renders without crashing and shows the
 *      "full text not recorded" legacy note.
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

/** A clearly->200-char prompt; the echo server returns it verbatim as the response. */
const LONG_PROMPT = Array.from({ length: 60 }, (_, i) => `paragraph-word-${i}`).join(" ");
/** A token that only appears well past character 200 (i.e. only in the FULL text). */
const TAIL_MARKER = "paragraph-word-59";

describe("full transcript support (issue #107)", () => {
	let server: MockServer;
	let home: string;
	let work: string;

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

	/** Drive a real 2-turn session named `name`, the first turn being a long prompt. */
	async function runLongSession(name: string): Promise<void> {
		const t1 = await runCli("prompt", LONG_PROMPT, "-n", name, "--cwd", work, "--approve-all");
		expect(t1.exitCode, `turn 1 stderr: ${t1.stderr}`).toBe(0);
		const t2 = await runCli("prompt", "short follow-up", "-n", name, "--approve-all");
		expect(t2.exitCode, `turn 2 stderr: ${t2.stderr}`).toBe(0);
	}

	it("persists the FULL response: `session history --full` shows text past char 200", async () => {
		await runLongSession("xscript");

		const full = await runCli("session", "history", "xscript", "--full");
		expect(full.exitCode, full.stderr).toBe(0);
		// The tail marker only exists beyond char 200 — proving the full text (not
		// the 200-char preview) was persisted and rendered.
		expect(full.stdout).toContain(TAIL_MARKER);
		expect(full.stdout).toContain("short follow-up");
	});

	it("compact default history stays truncated (does NOT include the tail marker)", async () => {
		await runLongSession("xscript");

		const compact = await runCli("session", "history", "xscript");
		expect(compact.exitCode, compact.stderr).toBe(0);
		expect(compact.stdout).not.toContain(TAIL_MARKER);
	});

	it("`--format json` history includes the full `response` field", async () => {
		await runLongSession("xscript");

		const hist = await runCli("--format", "json", "session", "history", "xscript");
		expect(hist.exitCode, hist.stderr).toBe(0);
		const parsed = hist.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l)) as Array<{ turns?: Array<{ response?: string; responsePreview: string }> }>;
		const turns = parsed.flatMap((p) => p.turns ?? []);
		expect(turns.length).toBe(2);
		// Full response present and complete...
		expect(turns[0].response).toContain(TAIL_MARKER);
		expect(turns[0].response!.length).toBeGreaterThan(200);
		// ...while responsePreview (additive, kept for 0.3.4 consumers) stays capped.
		expect(turns[0].responsePreview.length).toBeLessThanOrEqual(200);
		expect(turns[0].responsePreview).not.toContain(TAIL_MARKER);
	});

	it("`session export --format markdown` renders a complete per-turn transcript", async () => {
		await runLongSession("xscript");

		const md = await runCli("session", "export", "xscript", "--format", "markdown");
		expect(md.exitCode, md.stderr).toBe(0);
		expect(md.stdout).toContain("# Session Transcript:");
		expect(md.stdout).toContain("## Turn 1");
		expect(md.stdout).toContain("## Turn 2");
		expect(md.stdout).toContain("**Prompt:**");
		expect(md.stdout).toContain("**Response:**");
		// Full prompt + full response both present (tail marker is past char 200).
		expect(md.stdout).toContain(TAIL_MARKER);
		expect(md.stdout).toContain("short follow-up");
	});

	it("`session export --format json` is parseable and contains full responses", async () => {
		await runLongSession("xscript");

		const out = await runCli("session", "export", "xscript", "--format", "json");
		expect(out.exitCode, out.stderr).toBe(0);
		const record = JSON.parse(out.stdout) as {
			id: string;
			turns: Array<{ response?: string; prompt?: string }>;
		};
		expect(record.id).toBeTruthy();
		expect(record.turns.length).toBe(2);
		expect(record.turns[0].response).toContain(TAIL_MARKER);
		expect(record.turns[0].prompt).toContain(TAIL_MARKER);
	});

	it("`session export` defaults to json and writes to a file with --out", async () => {
		await runLongSession("xscript");

		const outFile = path.join(work, "transcript.json");
		const res = await runCli("session", "export", "xscript", "--out", outFile);
		expect(res.exitCode, res.stderr).toBe(0);
		const written = JSON.parse(await fs.readFile(outFile, "utf-8")) as { turns: Array<{ response?: string }> };
		expect(written.turns[0].response).toContain(TAIL_MARKER);
	});

	it("transcript survives `session close` (durable local record)", async () => {
		await runLongSession("xscript");

		const close = await runCli("session", "close", "xscript");
		expect(close.exitCode, close.stderr).toBe(0);

		const full = await runCli("session", "history", "xscript", "--full");
		expect(full.exitCode, full.stderr).toBe(0);
		expect(full.stdout).toContain(TAIL_MARKER);

		const md = await runCli("session", "export", "xscript", "--format", "markdown");
		expect(md.exitCode, md.stderr).toBe(0);
		expect(md.stdout).toContain(TAIL_MARKER);
	});

	it("backward-compat: a pre-0.4.0 record (no `response`) renders the legacy note, no crash", async () => {
		// Write a legacy record directly: turns have only responsePreview, no full text.
		const id = "11111111-1111-4111-8111-111111111111";
		const legacy = {
			id,
			sessionUri: "copilot:/legacy",
			serverName: "local",
			serverUrl: server.url,
			provider: "copilot",
			name: "legacy-session",
			status: "closed",
			createdAt: new Date().toISOString(),
			closedAt: new Date().toISOString(),
			turns: [
				{
					turnId: "legacy-turn-1",
					userMessage: "old prompt",
					responsePreview: "an old truncated preview",
					toolCallCount: 0,
					state: "complete",
					timestamp: new Date().toISOString(),
				},
			],
		};
		const dir = path.join(home, ".ahpx", "sessions");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(legacy, null, "\t"), "utf-8");

		// history --full must not crash and must surface the legacy note.
		const full = await runCli("session", "history", id, "--full");
		expect(full.exitCode, full.stderr).toBe(0);
		expect(full.stdout).toContain("an old truncated preview");
		expect(full.stdout).toContain("full text not recorded");

		// export markdown also tolerates the missing field + shows the note.
		const md = await runCli("session", "export", id, "--format", "markdown");
		expect(md.exitCode, md.stderr).toBe(0);
		expect(md.stdout).toContain("full text not recorded");
		expect(md.stdout).toContain("an old truncated preview");

		// JSON history reports response: null for legacy turns (full text unknown).
		const json = await runCli("--format", "json", "session", "history", id);
		expect(json.exitCode, json.stderr).toBe(0);
		const parsed = json.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l)) as Array<{
			turns?: Array<{ response: string | null; prompt: string | null; responsePreview: string }>;
		}>;
		const turns = parsed.flatMap((p) => p.turns ?? []);
		expect(turns[0].response).toBeNull();
		expect(turns[0].prompt).toBeNull();
		expect(turns[0].responsePreview).toBe("an old truncated preview");
	});
});
