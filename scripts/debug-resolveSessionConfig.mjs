#!/usr/bin/env node
/**
 * Raw WebSocket test: Connect to an AHP server and test resolveSessionConfig.
 *
 * Usage:
 *   node scripts/debug-resolveSessionConfig.mjs [ws://127.0.0.1:8090]
 *
 * This script sends the EXACT same messages VS Code sends and logs every
 * byte on the wire. Compare the output with what ahpx sends to find the bug.
 */

import WebSocket from "ws";

const url = process.argv[2] || "ws://127.0.0.1:8090";
let nextId = 1;

function sendRequest(ws, method, params) {
	const msg = { jsonrpc: "2.0", id: nextId++, method, params };
	const json = JSON.stringify(msg);
	console.log(`\n>>> SEND [id=${msg.id}] ${method}:`);
	console.log(json);
	ws.send(json);
	return msg.id;
}

function waitForResponse(ws, expectedId, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout waiting for response id=${expectedId}`)), timeoutMs);

		function onMessage(data) {
			const text = typeof data === "string" ? data : data.toString("utf-8");
			let msg;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}

			// Log ALL incoming messages
			if (msg.id === expectedId) {
				clearTimeout(timer);
				ws.removeListener("message", onMessage);
				console.log(`\n<<< RECV [id=${msg.id}]:`);
				console.log(JSON.stringify(msg, null, 2));
				resolve(msg);
			} else if (msg.method) {
				// Server notification (action, notification, etc.)
				console.log(`\n<<< NOTIFICATION [${msg.method}]: (${text.length} bytes)`);
			} else if (msg.id !== undefined) {
				console.log(`\n<<< RECV [id=${msg.id}] (unexpected):`);
				console.log(JSON.stringify(msg, null, 2));
			}
		}

		ws.on("message", onMessage);
	});
}

async function main() {
	console.log("=== AHP resolveSessionConfig Debug Test ===");
	console.log(`Connecting to: ${url}`);

	const ws = new WebSocket(url);

	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	console.log("✓ WebSocket connected\n");

	// ─── Step 1: Initialize (matching VS Code's exact format) ───
	console.log("--- Step 1: Initialize ---");
	const initId = sendRequest(ws, "initialize", {
		protocolVersions: ["0.1.0"],
		clientId: `debug-test-${Date.now()}`,
		initialSubscriptions: ["agenthost:/root"],
	});
	const initResp = await waitForResponse(ws, initId);

	if (initResp.error) {
		console.error("\n✗ Initialize FAILED:", initResp.error);
		ws.close();
		process.exit(1);
	}

	console.log(`\n✓ Negotiated protocol version: ${initResp.result?.protocolVersion}`);
	console.log(`  Server seq: ${initResp.result?.serverSeq}`);
	console.log(`  Snapshots: ${initResp.result?.snapshots?.length ?? 0}`);

	// Extract available agents from root state
	const rootSnapshot = initResp.result?.snapshots?.find((s) => s.resource === "agenthost:/root");
	const agents = rootSnapshot?.state?.agents ?? [];
	console.log(`  Agents: ${agents.map((a) => a.provider).join(", ") || "(none)"}`);

	// ─── Step 2: resolveSessionConfig (exact VS Code format) ───
	console.log("\n--- Step 2: resolveSessionConfig ---");
	const provider = agents[0]?.provider || "copilot";
	const configId = sendRequest(ws, "resolveSessionConfig", {
		provider: provider,
		workingDirectory: `file://${process.cwd()}`,
		config: {},
	});
	const configResp = await waitForResponse(ws, configId);

	if (configResp.error) {
		console.error("\n✗ resolveSessionConfig FAILED:");
		console.error(`  Code: ${configResp.error.code}`);
		console.error(`  Message: ${configResp.error.message}`);
		console.error(`  Data: ${JSON.stringify(configResp.error.data)}`);

		// ─── Step 2b: Try without provider to see if it's a provider issue ───
		console.log("\n--- Step 2b: Try without provider ---");
		const config2Id = sendRequest(ws, "resolveSessionConfig", {});
		const config2Resp = await waitForResponse(ws, config2Id);
		if (config2Resp.error) {
			console.error(`  Also failed: ${config2Resp.error.message}`);
		} else {
			console.log("  ✓ Succeeded without provider!");
			console.log(JSON.stringify(config2Resp.result, null, 2));
		}
	} else {
		console.log("\n✓ resolveSessionConfig succeeded:");
		console.log(JSON.stringify(configResp.result, null, 2));
	}

	// ─── Step 3: Also try a known-good method to verify the connection ───
	console.log("\n--- Step 3: Control test - listSessions ---");
	const listId = sendRequest(ws, "listSessions", {});
	const listResp = await waitForResponse(ws, listId);

	if (listResp.error) {
		console.error(`✗ listSessions FAILED: ${listResp.error.message}`);
		console.error("  THIS IS SUSPICIOUS — listSessions should always work after initialize");
	} else {
		console.log(`✓ listSessions succeeded: ${listResp.result?.items?.length ?? 0} sessions`);
	}

	// ─── Step 4: Try intentionally wrong method to see error format ───
	console.log("\n--- Step 4: Control test - intentionally wrong method ---");
	const badId = sendRequest(ws, "thisMethodDoesNotExist", {});
	const badResp = await waitForResponse(ws, badId);

	if (badResp.error) {
		console.log("✓ Expected error for bad method:");
		console.log(`  Code: ${badResp.error.code}`);
		console.log(`  Message: ${badResp.error.message}`);
		console.log("  Compare with resolveSessionConfig error above ^^^");
	}

	ws.close();
	console.log("\n=== Done ===");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
