#!/usr/bin/env node

/**
 * ahpx — Agent Host Protocol CLI
 */

import { Command } from "commander";
import pc from "picocolors";
import { AhpClient } from "./client/index.js";
import {
	ConnectionStore,
	ConnectionValidationError,
	globalConfigPath,
	initGlobalConfig,
	isValidWsUrl,
	loadConfig,
	projectConfigPath,
} from "./config/index.js";

const store = new ConnectionStore();

const program = new Command()
	.name("ahpx")
	.description("Agent Host Protocol CLI — manage AHP server connections, sessions, and agent interactions")
	.version("0.1.0");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a target to a WebSocket URL + optional token.
 *
 * Accepts:
 *   - A ws:// or wss:// URL (used directly)
 *   - A saved connection name (looked up from the store)
 *   - undefined (uses the default connection, if set)
 */
async function resolveTarget(target?: string): Promise<{ url: string; token?: string }> {
	// Explicit ws(s):// URL — use as-is
	if (target && isValidWsUrl(target)) {
		return { url: target };
	}

	// Named connection
	if (target) {
		const conn = await store.get(target);
		if (!conn) {
			throw new Error(`Unknown connection "${target}". Run ${pc.bold("ahpx server list")} to see saved connections.`);
		}
		return { url: conn.url, token: conn.token };
	}

	// No argument — try default
	const def = await store.getDefault();
	if (!def) {
		throw new Error(
			`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
		);
	}
	return { url: def.url, token: def.token };
}

/** Print server information after a successful connect. */
function printServerInfo(
	client: AhpClient,
	result: { protocolVersion: number; serverSeq: number; defaultDirectory?: string },
) {
	console.log(pc.green("✓ Connected"));
	console.log();

	console.log(pc.bold("Protocol version:"), result.protocolVersion);
	console.log(pc.bold("Server seq:"), result.serverSeq);

	if (result.defaultDirectory) {
		console.log(pc.bold("Default directory:"), result.defaultDirectory);
	}

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
}

// ── connect ──────────────────────────────────────────────────────────────────

program
	.command("connect")
	.description("Connect to an AHP server and print server info")
	.argument("[target]", "WebSocket URL or saved connection name (uses default if omitted)")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (target: string | undefined, opts: { timeout: string }) => {
		const client = new AhpClient({
			connectTimeout: Number.parseInt(opts.timeout, 10),
			initialSubscriptions: ["agenthost:/root"],
		});

		try {
			const { url, token } = await resolveTarget(target);

			console.log(pc.dim(`Connecting to ${url}...`));
			const result = await client.connect(url);

			// If the connection profile had a token, authenticate automatically
			if (token) {
				await client.authenticate(url, token);
			}

			printServerInfo(client, result);
		} catch (err) {
			console.error(pc.red("✗ Failed to connect:"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		} finally {
			await client.disconnect();
		}
	});

// ── server ───────────────────────────────────────────────────────────────────

const server = program.command("server").description("Manage saved server connections");

server
	.command("add")
	.description("Save a named connection profile")
	.argument("<name>", "Connection name")
	.requiredOption("--url <url>", "WebSocket URL (ws:// or wss://)")
	.option("--token <token>", "Authentication token")
	.option("--default", "Set as the default server")
	.action(async (name: string, opts: { url: string; token?: string; default?: boolean }) => {
		try {
			await store.add({
				name,
				url: opts.url,
				token: opts.token,
				default: opts.default ?? false,
			});
			console.log(pc.green("✓"), `Saved connection ${pc.bold(name)} → ${pc.dim(opts.url)}`);
			if (opts.default) {
				console.log(pc.dim("  Set as default server"));
			}
		} catch (err) {
			if (err instanceof ConnectionValidationError) {
				console.error(pc.red("✗"), err.message);
				process.exitCode = 1;
			} else {
				throw err;
			}
		}
	});

server
	.command("list")
	.description("List saved connections")
	.action(async () => {
		const connections = await store.list();

		if (connections.length === 0) {
			console.log(pc.dim("No saved connections. Run"), pc.bold("ahpx server add"), pc.dim("to add one."));
			return;
		}

		// Table header
		const nameW = Math.max(4, ...connections.map((c) => c.name.length));
		const urlW = Math.max(3, ...connections.map((c) => c.url.length));

		console.log(`  ${pc.bold("Name".padEnd(nameW))}  ${pc.bold("URL".padEnd(urlW))}  ${pc.bold("Default")}`);
		console.log(`  ${"─".repeat(nameW)}  ${"─".repeat(urlW)}  ${"─".repeat(7)}`);

		for (const c of connections) {
			const def = c.default ? pc.green("  ✓") : pc.dim("  ·");
			console.log(`  ${pc.cyan(c.name.padEnd(nameW))}  ${c.url.padEnd(urlW)}  ${def}`);
		}
	});

server
	.command("remove")
	.description("Remove a saved connection")
	.argument("<name>", "Connection name to remove")
	.action(async (name: string) => {
		const conn = await store.get(name);
		if (!conn) {
			console.error(pc.red("✗"), `Connection "${name}" not found`);
			process.exitCode = 1;
			return;
		}

		if (conn.default) {
			console.log(pc.yellow("⚠"), `"${name}" is the default server.`);
		}

		const removed = await store.remove(name);
		if (removed) {
			console.log(pc.green("✓"), `Removed connection ${pc.bold(name)}`);
		}
	});

server
	.command("test")
	.description("Test connectivity to a server")
	.argument("<target>", "Connection name or WebSocket URL")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (target: string, opts: { timeout: string }) => {
		const client = new AhpClient({
			connectTimeout: Number.parseInt(opts.timeout, 10),
			initialSubscriptions: ["agenthost:/root"],
		});

		try {
			const { url, token } = await resolveTarget(target);
			console.log(pc.dim(`Testing connection to ${url}...`));

			const result = await client.connect(url);

			if (token) {
				await client.authenticate(url, token);
			}

			printServerInfo(client, result);
		} catch (err) {
			console.error(pc.red("✗ Connection failed:"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		} finally {
			await client.disconnect();
		}
	});

// ── config ───────────────────────────────────────────────────────────────────

const config = program.command("config").description("Manage ahpx configuration");

config
	.command("show")
	.description("Print resolved configuration (global + project merged)")
	.action(async () => {
		const resolved = await loadConfig();

		console.log(pc.bold("Resolved configuration:"));
		console.log(pc.dim(`  Global: ${globalConfigPath()}`));
		console.log(pc.dim(`  Project: ${projectConfigPath()}`));
		console.log();

		for (const [key, value] of Object.entries(resolved)) {
			if (value !== undefined) {
				console.log(`  ${pc.cyan(key)}: ${value}`);
			}
		}
	});

config
	.command("init")
	.description("Create ~/.ahpx/config.json with defaults")
	.action(async () => {
		const created = await initGlobalConfig();
		if (created) {
			console.log(pc.green("✓"), `Created ${pc.dim(globalConfigPath())}`);
		} else {
			console.log(pc.dim("Config already exists at"), globalConfigPath());
		}
	});

program.parse();
