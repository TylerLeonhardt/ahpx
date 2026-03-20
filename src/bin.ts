#!/usr/bin/env node

/**
 * ahpx — Agent Host Protocol CLI
 */

import { Command } from "commander";
import pc from "picocolors";
import { AhpClient } from "./client/index.js";

const program = new Command()
	.name("ahpx")
	.description("Agent Host Protocol CLI — manage AHP server connections, sessions, and agent interactions")
	.version("0.1.0");

program
	.command("connect")
	.description("Connect to an AHP server and print server info")
	.argument("<url>", "WebSocket URL of the AHP server (e.g. ws://localhost:3000)")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (url: string, opts: { timeout: string }) => {
		const client = new AhpClient({
			connectTimeout: Number.parseInt(opts.timeout, 10),
			initialSubscriptions: ["agenthost:/root"],
		});

		try {
			console.log(pc.dim(`Connecting to ${url}...`));
			const result = await client.connect(url);

			console.log(pc.green("✓ Connected"));
			console.log();

			console.log(pc.bold("Protocol version:"), result.protocolVersion);
			console.log(pc.bold("Server seq:"), result.serverSeq);

			if (result.defaultDirectory) {
				console.log(pc.bold("Default directory:"), result.defaultDirectory);
			}

			// Print root state from snapshots
			const rootState = client.state.root;
			if (rootState.agents.length > 0) {
				console.log();
				console.log(pc.bold("Agents:"));
				for (const agent of rootState.agents) {
					console.log(`  ${pc.cyan(agent.provider)} — ${agent.displayName}`);
					if (agent.models.length > 0) {
						console.log(`    Models: ${agent.models.map((m) => m.name || m.id).join(", ")}`);
					}
				}
			}

			if (rootState.activeSessions !== undefined) {
				console.log();
				console.log(pc.bold("Active sessions:"), rootState.activeSessions);
			}
		} catch (err) {
			console.error(pc.red("✗ Failed to connect:"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		} finally {
			await client.disconnect();
		}
	});

program.parse();
