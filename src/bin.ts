#!/usr/bin/env node

/**
 * ahpx — Agent Host Protocol CLI
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
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
import type { AhpxConfig } from "./config/index.js";
import { PromptRenderer } from "./output/index.js";
import { PermissionHandler } from "./permissions/index.js";
import type { PermissionMode } from "./permissions/index.js";
import { TurnController } from "./prompt/index.js";
import { ActionType } from "./protocol/actions.js";
import { SessionStore, findGitRoot, resolveSession, withConnection } from "./session/index.js";
import type { SessionRecord } from "./session/index.js";

const store = new ConnectionStore();
const sessionStore = new SessionStore();

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

// ── session ──────────────────────────────────────────────────────────────────

const session = program.command("session").description("Manage agent sessions");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a relative time string from an ISO timestamp. */
function formatAge(isoTimestamp: string): string {
	const ms = Date.now() - new Date(isoTimestamp).getTime();
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Truncate a string to maxLen, appending ellipsis if needed. */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/** Resolve the server name (from flag, config, or default). */
async function resolveServerName(serverFlag: string | undefined, config: AhpxConfig): Promise<string> {
	if (serverFlag) {
		// If it's a URL, we don't have a name — but check connection store first
		if (isValidWsUrl(serverFlag)) return serverFlag;
		const conn = await store.get(serverFlag);
		if (!conn) {
			throw new Error(
				`Unknown connection "${serverFlag}". Run ${pc.bold("ahpx server list")} to see saved connections.`,
			);
		}
		return conn.name;
	}

	if (config.defaultServer) {
		const conn = await store.get(config.defaultServer);
		if (!conn) {
			throw new Error(
				`Default server "${config.defaultServer}" not found. Run ${pc.bold("ahpx server list")} to check.`,
			);
		}
		return conn.name;
	}

	const def = await store.getDefault();
	if (!def) {
		throw new Error(
			`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
		);
	}
	return def.name;
}

/** Resolve a session from id, name flag, or cwd scope. */
async function resolveSessionRecord(
	id: string | undefined,
	opts: { name?: string; server?: string },
): Promise<SessionRecord> {
	if (id) {
		const record = await sessionStore.get(id);
		if (!record) {
			throw new Error(`Session "${id}" not found.`);
		}
		return record;
	}

	const config = await loadConfig();
	const serverName = await resolveServerName(opts.server, config);
	const cwd = process.cwd();

	const record = await resolveSession({
		serverName,
		cwd,
		name: opts.name,
		store: sessionStore,
	});

	if (!record) {
		const hint = opts.name ? ` named "${opts.name}"` : "";
		throw new Error(
			`No active session${hint} found for ${pc.bold(serverName)} in ${pc.dim(cwd)}.\nRun ${pc.bold("ahpx session new")} to create one.`,
		);
	}
	return record;
}

// ── session new ──────────────────────────────────────────────────────────────

session
	.command("new")
	.description("Create a new agent session")
	.option("-s, --server <name>", "Server name or WebSocket URL")
	.option("-p, --provider <provider>", "Agent provider (e.g. copilot)")
	.option("-m, --model <model>", "Model to use")
	.option("-n, --name <name>", "Name this session (for scoped lookups)")
	.option("--cwd <dir>", "Working directory", process.cwd())
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (opts: {
			server?: string;
			provider?: string;
			model?: string;
			name?: string;
			cwd: string;
			timeout: string;
		}) => {
			try {
				const config = await loadConfig();
				const provider = opts.provider ?? config.defaultProvider;
				const model = opts.model ?? config.defaultModel;
				const cwd = path.resolve(opts.cwd);
				const gitRoot = await findGitRoot(cwd);

				await withConnection(
					{
						server: opts.server,
						config,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client, serverInfo) => {
						// If no provider specified, list available ones from root state
						const rootState = client.state.root;
						const resolvedProvider =
							provider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);

						if (!resolvedProvider) {
							throw new Error("No agent provider available. Specify one with --provider or configure defaultProvider.");
						}

						// Generate a session URI
						const sessionId = randomUUID();
						const sessionUri = `${resolvedProvider}:/${sessionId}`;

						console.log(pc.dim(`Creating session on ${serverInfo.name}...`));

						// Create the session
						await client.createSession(sessionUri, resolvedProvider, model, cwd);

						// Subscribe to the session URI
						await client.subscribe(sessionUri);

						// Wait for session/ready or session/creationFailed
						const ready = await new Promise<boolean>((resolve, reject) => {
							const timeout = setTimeout(() => {
								reject(new Error("Timed out waiting for session to be ready"));
							}, 30_000);

							client.on("action", (envelope) => {
								const action = envelope.action;
								if (action.type === ActionType.SessionReady && action.session === sessionUri) {
									clearTimeout(timeout);
									resolve(true);
								} else if (action.type === ActionType.SessionCreationFailed && action.session === sessionUri) {
									clearTimeout(timeout);
									resolve(false);
								}
							});

							// Also check if already ready from the snapshot
							const sessionState = client.state.getSession(sessionUri);
							if (sessionState?.lifecycle === "ready") {
								clearTimeout(timeout);
								resolve(true);
							} else if (sessionState?.lifecycle === "creationFailed") {
								clearTimeout(timeout);
								resolve(false);
							}
						});

						if (!ready) {
							const sessionState = client.state.getSession(sessionUri);
							const errMsg = sessionState?.creationError?.message ?? "Unknown error";
							throw new Error(`Session creation failed: ${errMsg}`);
						}

						// Get the session state for extra info
						const sessionState = client.state.getSession(sessionUri);

						// Save session record locally
						const record: SessionRecord = {
							id: sessionId,
							sessionUri,
							serverName: serverInfo.name,
							serverUrl: serverInfo.url,
							provider: resolvedProvider,
							model: model ?? sessionState?.summary.model,
							name: opts.name,
							workingDirectory: cwd,
							gitRoot,
							title: sessionState?.summary.title,
							status: "active",
							createdAt: new Date().toISOString(),
						};
						await sessionStore.save(record);

						// Print session info
						console.log(pc.green("✓ Session created"));
						console.log();
						console.log(pc.bold("ID:"), sessionId);
						console.log(pc.bold("URI:"), pc.cyan(sessionUri));
						console.log(pc.bold("Provider:"), resolvedProvider);
						if (record.model) console.log(pc.bold("Model:"), record.model);
						if (opts.name) console.log(pc.bold("Name:"), opts.name);
						console.log(pc.bold("Directory:"), cwd);
						if (gitRoot) console.log(pc.bold("Git root:"), gitRoot);
						console.log(pc.bold("Status:"), pc.green("active"));
					},
				);
			} catch (err) {
				console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);

// ── session list ─────────────────────────────────────────────────────────────

session
	.command("list")
	.description("List sessions (default: active only)")
	.option("-s, --server <name>", "Filter by server name")
	.option("-a, --all", "Include closed sessions")
	.action(async (opts: { server?: string; all?: boolean }) => {
		try {
			const records = await sessionStore.list({
				...(opts.server ? { serverName: opts.server } : {}),
				...(opts.all ? {} : { status: "active" as const }),
			});

			if (records.length === 0) {
				const hint = opts.all ? "" : " active";
				console.log(
					pc.dim(`No${hint} sessions found.`),
					pc.dim("Run"),
					pc.bold("ahpx session new"),
					pc.dim("to create one."),
				);
				return;
			}

			// Table columns
			const idW = 8;
			const nameW = Math.max(4, ...records.map((r) => (r.name ?? "—").length));
			const provW = Math.max(8, ...records.map((r) => r.provider.length));
			const modelW = Math.max(5, ...records.map((r) => (r.model ?? "—").length));
			const titleW = 30;
			const statusW = 6;
			const ageW = 10;

			console.log(
				`  ${pc.bold("ID".padEnd(idW))}  ${pc.bold("Name".padEnd(nameW))}  ${pc.bold("Provider".padEnd(provW))}  ${pc.bold("Model".padEnd(modelW))}  ${pc.bold("Title".padEnd(titleW))}  ${pc.bold("Status".padEnd(statusW))}  ${pc.bold("Age".padEnd(ageW))}`,
			);
			console.log(
				`  ${"─".repeat(idW)}  ${"─".repeat(nameW)}  ${"─".repeat(provW)}  ${"─".repeat(modelW)}  ${"─".repeat(titleW)}  ${"─".repeat(statusW)}  ${"─".repeat(ageW)}`,
			);

			for (const r of records) {
				const status = r.status === "active" ? pc.green("active") : pc.dim("closed");
				const shortId = r.id.slice(0, 8);
				const name = r.name ?? pc.dim("—");
				const model = r.model ?? pc.dim("—");
				const title = truncate(r.title ?? "—", titleW);

				console.log(
					`  ${pc.cyan(shortId.padEnd(idW))}  ${String(name).padEnd(nameW)}  ${r.provider.padEnd(provW)}  ${String(model).padEnd(modelW)}  ${title.padEnd(titleW)}  ${String(status).padEnd(statusW + 10)}  ${formatAge(r.createdAt)}`,
				);
			}
		} catch (err) {
			console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

// ── session show ─────────────────────────────────────────────────────────────

session
	.command("show")
	.description("Show session details")
	.argument("[id]", "Session ID")
	.option("-n, --name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.action(async (id: string | undefined, opts: { name?: string; server?: string }) => {
		try {
			const record = await resolveSessionRecord(id, opts);

			console.log(pc.bold("Session Details"));
			console.log();
			console.log(pc.bold("ID:"), record.id);
			console.log(pc.bold("URI:"), pc.cyan(record.sessionUri));
			console.log(pc.bold("Server:"), record.serverName);
			console.log(pc.bold("Provider:"), record.provider);
			if (record.model) console.log(pc.bold("Model:"), record.model);
			if (record.name) console.log(pc.bold("Name:"), record.name);
			if (record.title) console.log(pc.bold("Title:"), record.title);
			console.log(pc.bold("Status:"), record.status === "active" ? pc.green("active") : pc.dim("closed"));
			if (record.workingDirectory) console.log(pc.bold("Directory:"), record.workingDirectory);
			if (record.gitRoot) console.log(pc.bold("Git root:"), record.gitRoot);
			console.log(pc.bold("Created:"), record.createdAt, pc.dim(`(${formatAge(record.createdAt)})`));
			if (record.lastPromptAt) {
				console.log(pc.bold("Last prompt:"), record.lastPromptAt, pc.dim(`(${formatAge(record.lastPromptAt)})`));
			}
			if (record.closedAt) {
				console.log(pc.bold("Closed:"), record.closedAt, pc.dim(`(${formatAge(record.closedAt)})`));
			}
		} catch (err) {
			console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

// ── session close ────────────────────────────────────────────────────────────

session
	.command("close")
	.description("Close a session (soft-close: keeps record for history)")
	.argument("[id]", "Session ID")
	.option("-n, --name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (id: string | undefined, opts: { name?: string; server?: string; timeout: string }) => {
		try {
			const record = await resolveSessionRecord(id, opts);

			if (record.status === "closed") {
				console.log(pc.dim("Session is already closed."));
				return;
			}

			// Try to dispose on server
			try {
				const config = await loadConfig();
				await withConnection(
					{
						server: record.serverName,
						config,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						await client.disposeSession(record.sessionUri);
					},
				);
			} catch {
				// Server dispose may fail (server unreachable, session already gone)
				// We still soft-close locally
				console.log(pc.yellow("⚠"), "Could not dispose session on server (closing locally only)");
			}

			// Soft-close locally
			const closed = await sessionStore.close(record.id);
			if (closed) {
				console.log(
					pc.green("✓"),
					`Closed session ${pc.bold(record.id.slice(0, 8))}`,
					record.name ? pc.dim(`(${record.name})`) : "",
				);
			}
		} catch (err) {
			console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

// ── session history ──────────────────────────────────────────────────────────

session
	.command("history")
	.description("Show turn history for a session")
	.argument("[id]", "Session ID")
	.option("-n, --name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-l, --limit <n>", "Maximum number of turns to show", "10")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (id: string | undefined, opts: { name?: string; server?: string; limit: string; timeout: string }) => {
		try {
			const record = await resolveSessionRecord(id, opts);
			const config = await loadConfig();
			const limit = Number.parseInt(opts.limit, 10);

			await withConnection(
				{
					server: record.serverName,
					config,
					timeout: Number.parseInt(opts.timeout, 10),
				},
				async (client) => {
					const result = await client.fetchTurns(record.sessionUri, undefined, limit);

					if (result.turns.length === 0) {
						console.log(pc.dim("No turns in this session."));
						return;
					}

					console.log(
						pc.bold(`History for session ${record.id.slice(0, 8)}`),
						result.hasMore ? pc.dim(`(showing last ${result.turns.length}, more available)`) : "",
					);
					console.log();

					for (const turn of result.turns) {
						const userMsg = truncate(turn.userMessage.text, 80);
						const responsePreview = truncate(turn.responseText || "(no response)", 80);
						const toolCount = turn.toolCalls.length;
						const usageStr = turn.usage ? `${turn.usage.inputTokens ?? "?"}→${turn.usage.outputTokens ?? "?"}t` : "";

						console.log(pc.bold(pc.cyan(`  Turn ${turn.id}`)));
						console.log(`    ${pc.bold("User:")} ${userMsg}`);
						console.log(`    ${pc.bold("Response:")} ${responsePreview}`);
						if (toolCount > 0) {
							console.log(`    ${pc.bold("Tool calls:")} ${toolCount}`);
						}
						if (usageStr) {
							console.log(`    ${pc.bold("Tokens:")} ${usageStr}`);
						}
						console.log();
					}
				},
			);
		} catch (err) {
			console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

// ── Prompt Helpers ───────────────────────────────────────────────────────────

/** Read prompt text from a file path, or from stdin if path is "-". */
async function readPromptFile(filePath: string): Promise<string> {
	if (filePath === "-") {
		return readStdin();
	}
	const { readFile } = await import("node:fs/promises");
	const resolved = path.resolve(filePath);
	return (await readFile(resolved, "utf-8")).trim();
}

/** Read all data from stdin (for piped input). */
function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data.trim()));
		process.stdin.on("error", reject);
	});
}

/** Detect if stdin is a pipe (not a TTY). */
function stdinIsPipe(): boolean {
	return !process.stdin.isTTY;
}

/** Resolve permission mode from flags and config. */
function resolvePermissionMode(
	opts: { approveAll?: boolean; approveReads?: boolean; denyAll?: boolean },
	config: AhpxConfig,
): PermissionMode {
	if (opts.approveAll) return "approve-all";
	if (opts.approveReads) return "approve-reads";
	if (opts.denyAll) return "deny-all";
	return config.permissions ?? "approve-reads";
}

/**
 * Core prompt execution logic shared by `prompt`, implicit prompt, and `exec`.
 */
async function runPrompt(opts: {
	text: string;
	server?: string;
	sessionName?: string;
	approveAll?: boolean;
	approveReads?: boolean;
	denyAll?: boolean;
	provider?: string;
	model?: string;
	/** If true, create a temporary session (exec mode). */
	oneShot?: boolean;
}): Promise<void> {
	const config = await loadConfig();
	const cwd = process.cwd();
	const gitRoot = await findGitRoot(cwd);
	const permMode = resolvePermissionMode(opts, config);

	await withConnection(
		{
			server: opts.server,
			config,
		},
		async (client, serverInfo) => {
			let sessionUri: string;
			let sessionRecord: SessionRecord | undefined;

			if (opts.oneShot) {
				// One-shot: create a temporary session
				sessionUri = await createTempSession(client, opts, config, cwd);
			} else {
				// Try to resolve existing session
				const resolved = await resolveOrCreateSession(client, serverInfo, opts, config, cwd, gitRoot);
				sessionUri = resolved.sessionUri;
				sessionRecord = resolved.record;
			}

			// Run the turn
			const renderer = new PromptRenderer();
			const permHandler = new PermissionHandler(permMode);
			const controller = new TurnController(client, sessionUri, renderer, permHandler);

			// Set up Ctrl+C handling
			let sigintCount = 0;
			const sigintHandler = () => {
				sigintCount++;
				if (sigintCount >= 2) {
					process.exit(130);
				}
				console.error(pc.dim("\nCancelling..."));
				controller.cancel();
			};
			process.on("SIGINT", sigintHandler);

			try {
				const result = await controller.prompt(opts.text);

				// Update session record for persistent sessions
				if (sessionRecord) {
					await sessionStore.update(sessionRecord.id, {
						lastPromptAt: new Date().toISOString(),
						title: client.state.getSession(sessionUri)?.summary.title ?? sessionRecord.title,
					});
				}

				if (result.state === "error") {
					process.exitCode = 1;
				}
			} finally {
				process.removeListener("SIGINT", sigintHandler);

				// Dispose temporary session in one-shot mode
				if (opts.oneShot) {
					try {
						await client.disposeSession(sessionUri);
					} catch {
						// Best effort
					}
				}
			}
		},
	);
}

/** Create a temporary session for one-shot exec mode. */
async function createTempSession(
	client: AhpClient,
	opts: { provider?: string; model?: string },
	config: AhpxConfig,
	cwd: string,
): Promise<string> {
	const rootState = client.state.root;
	const provider =
		opts.provider ?? config.defaultProvider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);
	if (!provider) {
		throw new Error("No agent provider available. Specify one with --provider.");
	}
	const sessionId = randomUUID();
	const sessionUri = `${provider}:/${sessionId}`;
	await client.createSession(sessionUri, provider, opts.model ?? config.defaultModel, cwd);
	await client.subscribe(sessionUri);
	await waitForReady(client, sessionUri);
	return sessionUri;
}

/** Resolve an existing session or auto-create one. */
async function resolveOrCreateSession(
	client: AhpClient,
	serverInfo: { name: string; url: string },
	opts: { sessionName?: string; provider?: string; model?: string },
	config: AhpxConfig,
	cwd: string,
	gitRoot: string | undefined,
): Promise<{ sessionUri: string; record: SessionRecord }> {
	const record = await resolveSession({
		serverName: serverInfo.name,
		cwd,
		name: opts.sessionName,
		store: sessionStore,
	});

	if (record) {
		await client.subscribe(record.sessionUri);
		return { sessionUri: record.sessionUri, record };
	}

	// Auto-create a session
	const rootState = client.state.root;
	const provider =
		opts.provider ?? config.defaultProvider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);
	if (!provider) {
		throw new Error("No agent provider available. Specify one with --provider.");
	}
	const sessionId = randomUUID();
	const sessionUri = `${provider}:/${sessionId}`;

	console.error(pc.dim(`Creating session on ${serverInfo.name}...`));
	await client.createSession(sessionUri, provider, opts.model ?? config.defaultModel, cwd);
	await client.subscribe(sessionUri);
	await waitForReady(client, sessionUri);

	const newRecord: SessionRecord = {
		id: sessionId,
		sessionUri,
		serverName: serverInfo.name,
		serverUrl: serverInfo.url,
		provider,
		model: opts.model ?? config.defaultModel ?? client.state.getSession(sessionUri)?.summary.model,
		name: opts.sessionName,
		workingDirectory: cwd,
		gitRoot,
		title: client.state.getSession(sessionUri)?.summary.title,
		status: "active",
		createdAt: new Date().toISOString(),
	};
	await sessionStore.save(newRecord);
	return { sessionUri, record: newRecord };
}

/** Wait for session/ready or session/creationFailed. */
function waitForReady(client: AhpClient, sessionUri: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("Timed out waiting for session to be ready"));
		}, 30_000);

		client.on("action", (envelope) => {
			const action = envelope.action;
			if (action.type === ActionType.SessionReady && action.session === sessionUri) {
				clearTimeout(timeout);
				resolve();
			} else if (action.type === ActionType.SessionCreationFailed && action.session === sessionUri) {
				clearTimeout(timeout);
				const sessionState = client.state.getSession(sessionUri);
				const errMsg = sessionState?.creationError?.message ?? "Unknown error";
				reject(new Error(`Session creation failed: ${errMsg}`));
			}
		});

		// Check if already ready from snapshot
		const sessionState = client.state.getSession(sessionUri);
		if (sessionState?.lifecycle === "ready") {
			clearTimeout(timeout);
			resolve();
		} else if (sessionState?.lifecycle === "creationFailed") {
			clearTimeout(timeout);
			const errMsg = sessionState?.creationError?.message ?? "Unknown error";
			reject(new Error(`Session creation failed: ${errMsg}`));
		}
	});
}

// ── prompt ───────────────────────────────────────────────────────────────────

program
	.command("prompt")
	.description("Send a prompt to an agent session")
	.argument("<text...>", "Prompt text")
	.option("-s, --server <name>", "Server name or WebSocket URL")
	.option("-n, --session-name <name>", "Session name for scoped lookup")
	.option("-f, --file <path>", "Read prompt from file (- for stdin)")
	.option("--approve-all", "Auto-approve all permissions")
	.option("--approve-reads", "Auto-approve read permissions, prompt for others")
	.option("--deny-all", "Auto-deny all permissions")
	.action(
		async (
			textParts: string[],
			opts: {
				server?: string;
				sessionName?: string;
				file?: string;
				approveAll?: boolean;
				approveReads?: boolean;
				denyAll?: boolean;
			},
		) => {
			try {
				let text = textParts.join(" ");
				if (opts.file) {
					text = await readPromptFile(opts.file);
				}
				if (!text) {
					console.error(pc.red("✗"), "No prompt text provided.");
					process.exitCode = 1;
					return;
				}
				await runPrompt({ text, ...opts });
			} catch (err) {
				console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);

// ── exec ─────────────────────────────────────────────────────────────────────

program
	.command("exec")
	.description("One-shot prompt: create temp session, prompt, dispose")
	.argument("<text...>", "Prompt text")
	.option("-s, --server <name>", "Server name or WebSocket URL")
	.option("-p, --provider <provider>", "Agent provider (e.g. copilot)")
	.option("-m, --model <model>", "Model to use")
	.option("--approve-all", "Auto-approve all permissions")
	.option("--approve-reads", "Auto-approve read permissions, prompt for others")
	.option("--deny-all", "Auto-deny all permissions")
	.action(
		async (
			textParts: string[],
			opts: {
				server?: string;
				provider?: string;
				model?: string;
				approveAll?: boolean;
				approveReads?: boolean;
				denyAll?: boolean;
			},
		) => {
			try {
				const text = textParts.join(" ");
				if (!text) {
					console.error(pc.red("✗"), "No prompt text provided.");
					process.exitCode = 1;
					return;
				}
				await runPrompt({ text, oneShot: true, ...opts });
			} catch (err) {
				console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);

// ── cancel ───────────────────────────────────────────────────────────────────

program
	.command("cancel")
	.description("Cancel the active turn in a session")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.action(async (opts: { sessionName?: string; server?: string }) => {
		try {
			const config = await loadConfig();
			const serverName = await resolveServerName(opts.server, config);
			const cwd = process.cwd();

			const record = await resolveSession({
				serverName,
				cwd,
				name: opts.sessionName,
				store: sessionStore,
			});

			if (!record) {
				console.log(pc.dim("No active session found. Nothing to cancel."));
				return;
			}

			await withConnection({ server: opts.server, config }, async (client) => {
				await client.subscribe(record.sessionUri);
				const sessionState = client.state.getSession(record.sessionUri);

				if (!sessionState?.activeTurn) {
					console.log(pc.dim("No active turn. Nothing to cancel."));
					return;
				}

				client.dispatchAction({
					type: ActionType.SessionTurnCancelled,
					session: record.sessionUri,
					turnId: sessionState.activeTurn.id,
				});
				console.log(pc.green("✓"), "Cancellation dispatched.");
			});
		} catch (err) {
			console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});

// ── Implicit prompt (bare text as default verb) ─────────────────────────────

// Check for piped stdin (non-TTY) without explicit command
async function handleImplicitPrompt(): Promise<boolean> {
	const args = process.argv.slice(2);

	// If no args but stdin is piped, read from stdin
	if (args.length === 0 && stdinIsPipe()) {
		const text = await readStdin();
		if (text) {
			await runPrompt({ text });
			return true;
		}
		return false;
	}

	// If the first arg doesn't match any known command, treat as implicit prompt
	if (args.length > 0) {
		const knownCommands = new Set([
			"connect",
			"server",
			"config",
			"session",
			"prompt",
			"exec",
			"cancel",
			"help",
			"--help",
			"-h",
			"--version",
			"-V",
		]);
		if (!knownCommands.has(args[0]) && !args[0].startsWith("-")) {
			// Check for --file flag in the args
			const fileIdx = args.indexOf("--file");
			const fileFlagIdx = args.indexOf("-f");
			const flagIdx = fileIdx !== -1 ? fileIdx : fileFlagIdx;
			let text: string;

			if (flagIdx !== -1 && flagIdx + 1 < args.length) {
				text = await readPromptFile(args[flagIdx + 1]);
			} else {
				// Collect all positional args (stop at flags)
				const textParts: string[] = [];
				const opts: Record<string, string | boolean> = {};
				let i = 0;
				while (i < args.length) {
					if (args[i] === "--server" || args[i] === "-s") {
						opts.server = args[++i];
					} else if (args[i] === "--session-name" || args[i] === "-n") {
						opts.sessionName = args[++i];
					} else if (args[i] === "--approve-all") {
						opts.approveAll = true;
					} else if (args[i] === "--approve-reads") {
						opts.approveReads = true;
					} else if (args[i] === "--deny-all") {
						opts.denyAll = true;
					} else if (!args[i].startsWith("-")) {
						textParts.push(args[i]);
					}
					i++;
				}
				text = textParts.join(" ");
			}

			if (text) {
				await runPrompt({ text });
				return true;
			}
		}
	}

	return false;
}

// Main entry: try implicit prompt first, then fall back to commander
(async () => {
	try {
		const handled = await handleImplicitPrompt();
		if (!handled) {
			program.parse();
		}
	} catch (err) {
		console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
})();
