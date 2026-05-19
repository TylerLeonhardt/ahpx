#!/usr/bin/env npx tsx
/**
 * debug-tool-confirmation.ts — Diagnostic script to observe raw server
 * tool-call confirmation behavior.
 *
 * Connects to an AHP server via WebSocket, creates a session with
 * autoApprove=default, sends a prompt asking to run `echo test`, and
 * logs every raw JSON-RPC message to inspect the `confirmed` field on
 * `session/toolCallReady` actions.
 *
 * Usage:
 *   npx tsx scripts/debug-tool-confirmation.ts [ws://host:port]
 *
 * The script will:
 *   1. Connect and initialize the protocol
 *   2. Create a session with autoApprove=default, isolation=folder
 *   3. Dispatch a turn asking to run `echo test`
 *   4. Log ALL incoming actions, highlighting tool call confirmation fields
 *   5. Auto-approve tool calls so the turn can complete
 *   6. Exit after turn completes or timeout
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVER_URL = process.argv[2] ?? "ws://127.0.0.1:8090";
const TIMEOUT_MS = 60_000;
const SESSION_CONFIG_AUTO_APPROVE = process.argv[3] ?? "default"; // try "default", "autopilot", or omit

// ─── Helpers ─────────────────────────────────────────────────────────────────

const clientId = randomUUID();
let clientSeq = 0;
let requestId = 0;

function dim(s: string) {
	return `\x1b[2m${s}\x1b[0m`;
}
function bold(s: string) {
	return `\x1b[1m${s}\x1b[0m`;
}
function red(s: string) {
	return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string) {
	return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string) {
	return `\x1b[33m${s}\x1b[0m`;
}
function cyan(s: string) {
	return `\x1b[36m${s}\x1b[0m`;
}

function log(label: string, ...args: unknown[]) {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`${dim(ts)} ${label}`, ...args);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	log(bold("CONFIG"), `Server: ${SERVER_URL}`);
	log(bold("CONFIG"), `autoApprove: ${SESSION_CONFIG_AUTO_APPROVE}`);
	log(bold("CONFIG"), `clientId: ${clientId}`);

	const ws = new WebSocket(SERVER_URL);

	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	// Track tool calls we've seen
	const toolCallsObserved: Array<{
		toolCallId: string;
		confirmed?: string;
		confirmationTitle?: string;
		hasOptions: boolean;
		invocationMessage?: string;
	}> = [];

	let sessionUri: string | undefined;
	let turnId: string | undefined;
	let turnComplete = false;

	function send(msg: Record<string, unknown>) {
		const raw = JSON.stringify(msg);
		log(cyan(">>>"), dim(raw.slice(0, 200)));
		ws.send(raw);
	}

	function request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = ++requestId;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			send({ jsonrpc: "2.0", id, method, params });
		});
	}

	function notify(method: string, params: Record<string, unknown>) {
		send({ jsonrpc: "2.0", method, params });
	}

	function dispatchAction(action: Record<string, unknown>) {
		clientSeq++;
		notify("dispatchAction", { clientSeq, action });
	}

	// ── Message handler ──────────────────────────────────────────────────────

	ws.on("message", (raw) => {
		const data = JSON.parse(raw.toString());

		// Response to a request
		if ("id" in data && typeof data.id === "number") {
			const p = pending.get(data.id);
			if (p) {
				pending.delete(data.id);
				if ("error" in data) {
					log(red("ERR"), JSON.stringify(data.error));
					p.reject(new Error(data.error.message));
				} else {
					log(green("RES"), `id=${data.id}`, dim(JSON.stringify(data.result).slice(0, 200)));
					p.resolve(data.result);
				}
			}
			return;
		}

		// Notification — action from server
		if (data.method === "action" && data.params?.action) {
			const action = data.params.action;
			const type = action.type as string;

			// Always log every action
			log(yellow("ACT"), bold(type), dim(JSON.stringify(action).slice(0, 300)));

			// ─── Highlight tool call ready actions ─────────────────────────────
			if (type === "session/toolCallReady") {
				const entry = {
					toolCallId: action.toolCallId,
					confirmed: action.confirmed,
					confirmationTitle:
						typeof action.confirmationTitle === "string"
							? action.confirmationTitle
							: action.confirmationTitle?.markdown,
					hasOptions: !!action.options?.length,
					invocationMessage:
						typeof action.invocationMessage === "string"
							? action.invocationMessage
							: action.invocationMessage?.markdown,
				};
				toolCallsObserved.push(entry);

				console.log("");
				console.log(bold("  ╔══════════════════════════════════════════════════════════"));
				console.log(bold("  ║ SESSION/TOOLCALLREADY — CONFIRMATION ANALYSIS"));
				console.log(bold("  ╠══════════════════════════════════════════════════════════"));
				console.log(`  ║ toolCallId:        ${entry.toolCallId}`);
				console.log(
					`  ║ confirmed:         ${
						entry.confirmed !== undefined
							? red(JSON.stringify(entry.confirmed))
							: green("undefined (client must confirm)")
					}`,
				);
				console.log(`  ║ confirmationTitle: ${entry.confirmationTitle ?? dim("(none)")}`);
				console.log(`  ║ hasOptions:        ${entry.hasOptions}`);
				console.log(`  ║ invocationMessage: ${entry.invocationMessage?.slice(0, 100) ?? dim("(none)")}`);

				if (entry.confirmed) {
					console.log(`  ║ ${red("⚠ SERVER AUTO-APPROVED THIS TOOL CALL")}`);
					console.log(`  ║ ${red("  The tool is already executing on the server.")}`);
					console.log(`  ║ ${red("  Client prompting is cosmetic — deny won't stop execution.")}`);
				} else {
					console.log(`  ║ ${green("✓ Server is waiting for client confirmation.")}`);
					// Auto-approve so the turn can complete
					dispatchAction({
						type: "session/toolCallConfirmed",
						session: sessionUri,
						turnId,
						toolCallId: action.toolCallId,
						approved: true,
						confirmed: "user-action",
					});
					log(dim("  → Auto-dispatched SessionToolCallConfirmed (approved)"));
				}
				console.log(bold("  ╚══════════════════════════════════════════════════════════"));
				console.log("");
			}

			// ─── Track turn completion ─────────────────────────────────────────
			if (type === "session/turnComplete" || type === "session/error" || type === "session/turnCancelled") {
				turnComplete = true;
				printSummary();
			}
		}

		// Other notifications
		if (data.method === "notification") {
			log(dim("NTF"), JSON.stringify(data.params).slice(0, 200));
		}
	});

	// ── Connect ────────────────────────────────────────────────────────────────

	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	log(green("OK"), "WebSocket connected");

	// ── Initialize ─────────────────────────────────────────────────────────────

	const initResult = (await request("initialize", {
		clientId,
		protocolVersions: ["0.1.0"],
		initialSubscriptions: ["agenthost:/root"],
	})) as { protocolVersion: string; serverSeq: number; snapshots?: unknown[] };

	log(green("OK"), `Protocol v${initResult.protocolVersion}`);

	// ── Create Session ─────────────────────────────────────────────────────────

	const provider = "copilotcli";
	sessionUri = `${provider}:/${randomUUID()}`;
	const cwd = `file://${process.cwd()}`;

	const sessionConfig: Record<string, unknown> = {
		autoApprove: SESSION_CONFIG_AUTO_APPROVE,
		isolation: "folder",
	};

	log(bold("SESSION"), `Creating session: ${sessionUri}`);
	log(bold("SESSION"), `Config: ${JSON.stringify(sessionConfig)}`);

	await request("createSession", {
		session: sessionUri,
		provider,
		workingDirectory: cwd,
		config: sessionConfig,
	});

	log(green("OK"), "Session created");

	// Wait briefly for session/ready
	await new Promise((r) => setTimeout(r, 2000));

	// ── Subscribe to session ───────────────────────────────────────────────────

	await request("subscribe", {
		resources: [sessionUri],
	});

	log(green("OK"), "Subscribed to session");

	// ── Send Prompt ────────────────────────────────────────────────────────────

	turnId = randomUUID();
	const prompt = "Run this command: echo test";

	log(bold("PROMPT"), `Sending: "${prompt}"`);

	dispatchAction({
		type: "session/turnStarted",
		session: sessionUri,
		turnId,
		userMessage: { text: prompt },
	});

	// ── Wait for completion or timeout ─────────────────────────────────────────

	const deadline = Date.now() + TIMEOUT_MS;
	while (!turnComplete && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
	}

	if (!turnComplete) {
		log(red("TIMEOUT"), `Turn did not complete within ${TIMEOUT_MS / 1000}s`);
		printSummary();
	}

	// Cleanup
	ws.close();
	process.exit(0);

	// ── Summary ────────────────────────────────────────────────────────────────

	function printSummary() {
		console.log("");
		console.log(bold("═══════════════════════════════════════════════════════════"));
		console.log(bold("  SUMMARY: Tool Call Confirmation Behavior"));
		console.log(bold("═══════════════════════════════════════════════════════════"));
		console.log(`  autoApprove config:  ${SESSION_CONFIG_AUTO_APPROVE}`);
		console.log(`  Tool calls observed: ${toolCallsObserved.length}`);
		console.log("");

		for (const tc of toolCallsObserved) {
			const verdict = tc.confirmed
				? red(`SERVER AUTO-APPROVED (confirmed: '${tc.confirmed}')`)
				: green("CLIENT MUST CONFIRM (confirmed: undefined)");
			console.log(`  [${tc.toolCallId.slice(0, 8)}] ${verdict}`);
			if (tc.invocationMessage) {
				console.log(`    ${dim(tc.invocationMessage.slice(0, 120))}`);
			}
		}

		if (toolCallsObserved.length === 0) {
			console.log(yellow("  No tool calls were observed — the model may not have tried to run echo."));
		}

		const autoApproved = toolCallsObserved.filter((tc) => tc.confirmed);
		if (autoApproved.length > 0) {
			console.log("");
			console.log(red(`  ⚠ ${autoApproved.length} tool call(s) were auto-approved by the server.`));
			console.log(red("  The server called respondToPermissionRequest(true) before sending"));
			console.log(red("  SessionToolCallReady. The tool was already executing when the client"));
			console.log(red("  received the action. Client-side denial cannot stop execution."));
			console.log("");
			console.log(yellow("  ROOT CAUSE: Server's CommandAutoApprover has 'echo' in its allow list."));
			console.log(yellow("  With autoApprove=default, reads in CWD + safe shell commands are"));
			console.log(yellow("  auto-approved server-side. This is INTENTIONAL VS Code behavior."));
			console.log(yellow("  See: src/vs/platform/agentHost/node/commandAutoApprover.ts"));
		}

		console.log(bold("═══════════════════════════════════════════════════════════"));
		console.log("");
	}
}

main().catch((err) => {
	console.error(red("FATAL:"), err);
	process.exit(1);
});
