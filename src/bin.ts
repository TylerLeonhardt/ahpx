#!/usr/bin/env node

/**
 * ahpx — Agent Host Protocol CLI
 *
 * Usage:
 *   ahpx <prompt>                  Send a prompt (implicit)
 *   ahpx prompt <text>             Send a prompt (explicit)
 *   ahpx exec <text>               One-shot prompt
 *   ahpx session new               Create a new session
 *   ahpx server add <name> --url   Save a server connection
 *   ahpx connect [server]          Connect and show server info
 *
 * Examples:
 *   ahpx "fix the failing tests"
 *   ahpx --format json exec "summarize this repo"
 *   echo "review changes" | ahpx
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { AhpClient } from "./client/index.js";
import { bashCompletion, fishCompletion, zshCompletion } from "./completions.js";
import {
	ConnectionStore,
	ConnectionValidationError,
	globalConfigPath,
	initGlobalConfig,
	isValidWsUrl,
	loadConfig,
	loadConfigWithSources,
} from "./config/index.js";
import type { AhpxConfig, ConfigSource } from "./config/index.js";
import { AhpxError, ExitCode, NoSessionError, TimeoutError, UsageError } from "./errors.js";
import { setVerbose } from "./logger.js";
import { createFormatter, startSpinner } from "./output/index.js";
import type { OutputFormat, OutputFormatter } from "./output/index.js";
import { PermissionHandler } from "./permissions/index.js";
import type { PermissionMode } from "./permissions/index.js";
import { TurnController } from "./prompt/index.js";
import { ActionType } from "./protocol/actions.js";
import { SessionStore, findGitRoot, resolveSession, withConnection } from "./session/index.js";
import type { SessionRecord } from "./session/index.js";

const store = new ConnectionStore();
const sessionStore = new SessionStore();

// ── Global options (parsed before Commander routes to a subcommand) ──────────

interface GlobalOpts {
	format: OutputFormat;
	jsonStrict: boolean;
	verbose: boolean;
}

function parseGlobalOpts(cmd: Command): GlobalOpts {
	const opts = cmd.optsWithGlobals();
	return {
		format: opts.format ?? "text",
		jsonStrict: opts.jsonStrict ?? false,
		verbose: opts.verbose ?? false,
	};
}

/** Create an OutputFormatter from resolved global options. */
function formatterFromOpts(globalOpts: GlobalOpts): OutputFormatter {
	return createFormatter(globalOpts.format, { jsonStrict: globalOpts.jsonStrict });
}

/** Whether to show spinners (text mode + TTY). */
function spinnersEnabled(globalOpts: GlobalOpts): boolean {
	return globalOpts.format === "text" && !!process.stdout.isTTY;
}

// ── Program ──────────────────────────────────────────────────────────────────

const program = new Command()
	.name("ahpx")
	.description(
		`Agent Host Protocol CLI — manage AHP server connections, sessions, and agent interactions

Usage:
  ahpx <prompt>                  Send a prompt (implicit)
  ahpx prompt <text>             Send a prompt (explicit)
  ahpx exec <text>               One-shot prompt
  ahpx session new               Create a new session
  ahpx server add <name> --url   Save a server connection
  ahpx connect [server]          Connect and show server info

Examples:
  ahpx "fix the failing tests"
  ahpx --format json exec "summarize this repo"
  echo "review changes" | ahpx`,
	)
	.version("0.1.0")
	.option("--format <format>", "Output format: text, json, or quiet", "text")
	.option("--json-strict", "Suppress non-JSON stderr output (only with --format json)")
	.option("-v, --verbose", "Enable debug logging to stderr");

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
			throw new AhpxError(
				`Unknown connection "${target}". Run ${pc.bold("ahpx server list")} to see saved connections.`,
				ExitCode.Error,
			);
		}
		return { url: conn.url, token: conn.token };
	}

	// No argument — try default
	const def = await store.getDefault();
	if (!def) {
		throw new AhpxError(
			`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
			ExitCode.Error,
		);
	}
	return { url: def.url, token: def.token };
}

/** Print server information after a successful connect (text mode). */
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

/** Format server info as a JSON-serializable object. */
function serverInfoJson(
	client: AhpClient,
	result: { protocolVersion: number; serverSeq: number; defaultDirectory?: string },
): Record<string, unknown> {
	const rootState = client.state.root;
	return {
		protocolVersion: result.protocolVersion,
		serverSeq: result.serverSeq,
		defaultDirectory: result.defaultDirectory,
		agents: rootState.agents.map((a) => ({
			provider: a.provider,
			displayName: a.displayName,
			models: a.models.map((m) => ({ id: m.id, name: m.name })),
		})),
		activeSessions: rootState.activeSessions,
	};
}

/** Output data respecting the chosen format. */
function outputResult(globalOpts: GlobalOpts, textFn: () => void, data: unknown): void {
	if (globalOpts.format === "json") {
		console.log(JSON.stringify(data));
	} else if (globalOpts.format === "quiet") {
		// quiet mode for non-prompt commands: output JSON for machine parsing
		console.log(JSON.stringify(data));
	} else {
		textFn();
	}
}

// ── Error handling ───────────────────────────────────────────────────────────

/**
 * Catch and exit with the correct exit code.
 * All command actions should use this wrapper.
 */
function handleError(err: unknown, globalOpts?: GlobalOpts): void {
	const message = err instanceof Error ? err.message : String(err);
	const exitCode = err instanceof AhpxError ? err.exitCode : ExitCode.Error;

	if (globalOpts?.format === "json") {
		console.log(JSON.stringify({ error: message, exitCode }));
	} else if (globalOpts?.format !== "quiet" || exitCode !== ExitCode.Success) {
		console.error(pc.red("✗"), message);
	}

	process.exitCode = exitCode;
}

// ── connect ──────────────────────────────────────────────────────────────────

program
	.command("connect")
	.description("Connect to an AHP server and print server info")
	.argument("[target]", "WebSocket URL or saved connection name (uses default if omitted)")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (target: string | undefined, opts: { timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		const client = new AhpClient({
			connectTimeout: Number.parseInt(opts.timeout, 10),
			initialSubscriptions: ["agenthost:/root"],
		});

		try {
			const { url, token } = await resolveTarget(target);
			const spinner = startSpinner(`Connecting to ${url}...`, spinnersEnabled(globalOpts));

			try {
				const result = await client.connect(url);
				spinner.stop();

				// If the connection profile had a token, authenticate automatically
				if (token) {
					await client.authenticate(url, token);
				}

				outputResult(globalOpts, () => printServerInfo(client, result), serverInfoJson(client, result));
			} catch (err) {
				spinner.stop();
				throw err;
			}
		} catch (err) {
			handleError(err, globalOpts);
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
	.action(async (name: string, opts: { url: string; token?: string; default?: boolean }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			await store.add({
				name,
				url: opts.url,
				token: opts.token,
				default: opts.default ?? false,
			});
			outputResult(
				globalOpts,
				() => {
					console.log(pc.green("✓"), `Saved connection ${pc.bold(name)} → ${pc.dim(opts.url)}`);
					if (opts.default) {
						console.log(pc.dim("  Set as default server"));
					}
				},
				{ name, url: opts.url, default: opts.default ?? false },
			);
		} catch (err) {
			if (err instanceof ConnectionValidationError) {
				handleError(new UsageError(err.message), globalOpts);
			} else {
				handleError(err, globalOpts);
			}
		}
	});

server
	.command("list")
	.description("List saved connections")
	.action(async (_opts: Record<string, unknown>, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const connections = await store.list();

			outputResult(
				globalOpts,
				() => {
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
				},
				connections.map((c) => ({ name: c.name, url: c.url, default: c.default ?? false })),
			);
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

server
	.command("remove")
	.description("Remove a saved connection")
	.argument("<name>", "Connection name to remove")
	.action(async (name: string, _opts: Record<string, unknown>, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const conn = await store.get(name);
			if (!conn) {
				throw new AhpxError(`Connection "${name}" not found`, ExitCode.Error);
			}

			if (conn.default && globalOpts.format === "text") {
				console.log(pc.yellow("⚠"), `"${name}" is the default server.`);
			}

			const removed = await store.remove(name);
			if (removed) {
				outputResult(globalOpts, () => console.log(pc.green("✓"), `Removed connection ${pc.bold(name)}`), {
					removed: name,
				});
			}
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

server
	.command("test")
	.description("Test connectivity to a server")
	.argument("<target>", "Connection name or WebSocket URL")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (target: string, opts: { timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		const client = new AhpClient({
			connectTimeout: Number.parseInt(opts.timeout, 10),
			initialSubscriptions: ["agenthost:/root"],
		});

		try {
			const { url, token } = await resolveTarget(target);
			const spinner = startSpinner(`Testing connection to ${url}...`, spinnersEnabled(globalOpts));

			try {
				const result = await client.connect(url);
				spinner.stop();

				if (token) {
					await client.authenticate(url, token);
				}

				outputResult(globalOpts, () => printServerInfo(client, result), serverInfoJson(client, result));
			} catch (err) {
				spinner.stop();
				throw err;
			}
		} catch (err) {
			handleError(err, globalOpts);
		} finally {
			await client.disconnect();
		}
	});

// ── config ───────────────────────────────────────────────────────────────────

const config = program.command("config").description("Manage ahpx configuration");

config
	.command("show")
	.description("Print resolved configuration with source annotations")
	.action(async (_opts: Record<string, unknown>, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const result = await loadConfigWithSources({
				overrides: buildConfigOverrides(globalOpts),
			});

			const sourceLabel = (src: ConfigSource): string => {
				switch (src) {
					case "default":
						return pc.dim("(default)");
					case "global":
						return pc.blue(`(global: ${result.globalPath})`);
					case "project":
						return pc.green(`(project: ${result.projectPath})`);
					case "cli":
						return pc.yellow("(cli flag)");
				}
			};

			outputResult(
				globalOpts,
				() => {
					console.log(pc.bold("Resolved configuration:"));
					console.log(pc.dim(`  Global: ${result.globalPath}`));
					console.log(pc.dim(`  Project: ${result.projectPath}`));
					console.log();

					for (const [key, value] of Object.entries(result.config)) {
						if (value !== undefined) {
							const src = result.sources[key] ?? "default";
							console.log(`  ${pc.cyan(key)}: ${value}  ${sourceLabel(src)}`);
						}
					}
				},
				{
					config: result.config,
					sources: result.sources,
					globalPath: result.globalPath,
					projectPath: result.projectPath,
				},
			);
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

config
	.command("init")
	.description("Create ~/.ahpx/config.json with defaults")
	.action(async (_opts: Record<string, unknown>, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const created = await initGlobalConfig();
			outputResult(
				globalOpts,
				() => {
					if (created) {
						console.log(pc.green("✓"), `Created ${pc.dim(globalConfigPath())}`);
					} else {
						console.log(pc.dim("Config already exists at"), globalConfigPath());
					}
				},
				{ created, path: globalConfigPath() },
			);
		} catch (err) {
			handleError(err, globalOpts);
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
async function resolveServerName(serverFlag: string | undefined, cfg: AhpxConfig): Promise<string> {
	if (serverFlag) {
		// If it's a URL, we don't have a name — but check connection store first
		if (isValidWsUrl(serverFlag)) return serverFlag;
		const conn = await store.get(serverFlag);
		if (!conn) {
			throw new AhpxError(
				`Unknown connection "${serverFlag}". Run ${pc.bold("ahpx server list")} to see saved connections.`,
				ExitCode.Error,
			);
		}
		return conn.name;
	}

	if (cfg.defaultServer) {
		const conn = await store.get(cfg.defaultServer);
		if (!conn) {
			throw new AhpxError(
				`Default server "${cfg.defaultServer}" not found. Run ${pc.bold("ahpx server list")} to check.`,
				ExitCode.Error,
			);
		}
		return conn.name;
	}

	const def = await store.getDefault();
	if (!def) {
		throw new AhpxError(
			`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
			ExitCode.Error,
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
			throw new NoSessionError(`Session "${id}" not found.`);
		}
		return record;
	}

	const cfg = await loadConfig();
	const serverName = await resolveServerName(opts.server, cfg);
	const cwd = process.cwd();

	const record = await resolveSession({
		serverName,
		cwd,
		name: opts.name,
		store: sessionStore,
	});

	if (!record) {
		const hint = opts.name ? ` named "${opts.name}"` : "";
		throw new NoSessionError(
			`No active session${hint} found for ${pc.bold(serverName)} in ${pc.dim(cwd)}.\nRun ${pc.bold("ahpx session new")} to create one.`,
		);
	}
	return record;
}

/** Build config overrides from global CLI opts. */
function buildConfigOverrides(globalOpts: GlobalOpts): Partial<AhpxConfig> {
	const overrides: Partial<AhpxConfig> = {};
	if (globalOpts.format !== "text") overrides.format = globalOpts.format;
	if (globalOpts.verbose) overrides.verbose = true;
	return overrides;
}

/** Apply global options (verbose mode, etc.) */
function applyGlobalOpts(globalOpts: GlobalOpts): void {
	setVerbose(globalOpts.verbose);
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
		async (
			opts: {
				server?: string;
				provider?: string;
				model?: string;
				name?: string;
				cwd: string;
				timeout: string;
			},
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				const provider = opts.provider ?? cfg.defaultProvider;
				const model = opts.model ?? cfg.defaultModel;
				const cwd = path.resolve(opts.cwd);
				const gitRoot = await findGitRoot(cwd);

				await withConnection(
					{
						server: opts.server,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client, serverInfo) => {
						// If no provider specified, list available ones from root state
						const rootState = client.state.root;
						const resolvedProvider =
							provider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);

						if (!resolvedProvider) {
							throw new UsageError(
								"No agent provider available. Specify one with --provider or configure defaultProvider.",
							);
						}

						// Generate a session URI
						const sessionId = randomUUID();
						const sessionUri = `${resolvedProvider}:/${sessionId}`;

						const spinner = startSpinner(`Creating session on ${serverInfo.name}...`, spinnersEnabled(globalOpts));

						try {
							// Create the session
							await client.createSession(sessionUri, resolvedProvider, model, cwd);

							// Subscribe to the session URI
							await client.subscribe(sessionUri);

							spinner.update("Waiting for session ready...");

							// Wait for session/ready or session/creationFailed
							const ready = await new Promise<boolean>((resolve, reject) => {
								const timeout = setTimeout(() => {
									reject(new TimeoutError("Timed out waiting for session to be ready"));
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

							spinner.stop();

							if (!ready) {
								const sessionState = client.state.getSession(sessionUri);
								const errMsg = sessionState?.creationError?.message ?? "Unknown error";
								throw new AhpxError(`Session creation failed: ${errMsg}`, ExitCode.Error);
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

							outputResult(
								globalOpts,
								() => {
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
								{
									id: sessionId,
									sessionUri,
									provider: resolvedProvider,
									model: record.model,
									name: opts.name,
									workingDirectory: cwd,
									gitRoot,
									status: "active",
								},
							);
						} catch (err) {
							spinner.stop();
							throw err;
						}
					},
				);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

// ── session list ─────────────────────────────────────────────────────────────

session
	.command("list")
	.description("List sessions (default: active only)")
	.option("-s, --server <name>", "Filter by server name")
	.option("-a, --all", "Include closed sessions")
	.action(async (opts: { server?: string; all?: boolean }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const records = await sessionStore.list({
				...(opts.server ? { serverName: opts.server } : {}),
				...(opts.all ? {} : { status: "active" as const }),
			});

			outputResult(
				globalOpts,
				() => {
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
				},
				records.map((r) => ({
					id: r.id,
					sessionUri: r.sessionUri,
					serverName: r.serverName,
					provider: r.provider,
					model: r.model,
					name: r.name,
					title: r.title,
					status: r.status,
					workingDirectory: r.workingDirectory,
					createdAt: r.createdAt,
				})),
			);
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── session show ─────────────────────────────────────────────────────────────

session
	.command("show")
	.description("Show session details")
	.argument("[id]", "Session ID")
	.option("-n, --name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.action(async (id: string | undefined, opts: { name?: string; server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const record = await resolveSessionRecord(id, opts);

			outputResult(
				globalOpts,
				() => {
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
				},
				record,
			);
		} catch (err) {
			handleError(err, globalOpts);
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
	.action(async (id: string | undefined, opts: { name?: string; server?: string; timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const record = await resolveSessionRecord(id, opts);

			if (record.status === "closed") {
				if (globalOpts.format === "text") {
					console.log(pc.dim("Session is already closed."));
				}
				return;
			}

			// Try to dispose on server
			const spinner = startSpinner("Disposing session...", spinnersEnabled(globalOpts));
			try {
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				await withConnection(
					{
						server: record.serverName,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						await client.disposeSession(record.sessionUri);
					},
				);
				spinner.stop();
			} catch {
				spinner.stop();
				// Server dispose may fail (server unreachable, session already gone)
				// We still soft-close locally
				if (globalOpts.format === "text") {
					console.log(pc.yellow("⚠"), "Could not dispose session on server (closing locally only)");
				}
			}

			// Soft-close locally
			const closed = await sessionStore.close(record.id);
			if (closed) {
				outputResult(
					globalOpts,
					() =>
						console.log(
							pc.green("✓"),
							`Closed session ${pc.bold(record.id.slice(0, 8))}`,
							record.name ? pc.dim(`(${record.name})`) : "",
						),
					{ closed: record.id },
				);
			}
		} catch (err) {
			handleError(err, globalOpts);
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
	.action(
		async (
			id: string | undefined,
			opts: { name?: string; server?: string; limit: string; timeout: string },
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const record = await resolveSessionRecord(id, opts);
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				const limit = Number.parseInt(opts.limit, 10);

				await withConnection(
					{
						server: record.serverName,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						const result = await client.fetchTurns(record.sessionUri, undefined, limit);

						outputResult(
							globalOpts,
							() => {
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
									const usageStr = turn.usage
										? `${turn.usage.inputTokens ?? "?"}→${turn.usage.outputTokens ?? "?"}t`
										: "";

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
							{
								sessionId: record.id,
								hasMore: result.hasMore,
								turns: result.turns.map((t) => ({
									id: t.id,
									userMessage: t.userMessage.text,
									responseText: t.responseText,
									toolCalls: t.toolCalls.length,
									usage: t.usage,
								})),
							},
						);
					},
				);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

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
	cfg: AhpxConfig,
): PermissionMode {
	if (opts.approveAll) return "approve-all";
	if (opts.approveReads) return "approve-reads";
	if (opts.denyAll) return "deny-all";
	return cfg.permissions ?? "approve-reads";
}

/**
 * Core prompt execution logic shared by `prompt`, implicit prompt, and `exec`.
 */
async function runPrompt(
	opts: {
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
	},
	globalOpts: GlobalOpts,
): Promise<void> {
	const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
	const cwd = process.cwd();
	const gitRoot = await findGitRoot(cwd);
	const permMode = resolvePermissionMode(opts, cfg);
	const formatter = formatterFromOpts(globalOpts);

	await withConnection(
		{
			server: opts.server,
			config: cfg,
		},
		async (client, serverInfo) => {
			let sessionUri: string;
			let sessionRecord: SessionRecord | undefined;

			if (opts.oneShot) {
				// One-shot: create a temporary session
				const spinner = startSpinner("Creating session...", spinnersEnabled(globalOpts));
				try {
					sessionUri = await createTempSession(client, opts, cfg, cwd);
					spinner.stop();
				} catch (err) {
					spinner.stop();
					throw err;
				}
			} else {
				// Try to resolve existing session
				const resolved = await resolveOrCreateSession(client, serverInfo, opts, cfg, cwd, gitRoot, globalOpts);
				sessionUri = resolved.sessionUri;
				sessionRecord = resolved.record;
			}

			// Run the turn
			const permHandler = new PermissionHandler(permMode);
			const controller = new TurnController(client, sessionUri, formatter, permHandler);

			// Set up Ctrl+C handling
			let sigintCount = 0;
			const sigintHandler = () => {
				sigintCount++;
				if (sigintCount >= 2) {
					process.exitCode = ExitCode.Interrupted;
					process.exit(ExitCode.Interrupted);
				}
				if (globalOpts.format === "text") {
					console.error(pc.dim("\nCancelling..."));
				}
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
					process.exitCode = ExitCode.Error;
				}
			} finally {
				process.removeListener("SIGINT", sigintHandler);

				// Dispose temporary session in one-shot mode
				if (opts.oneShot) {
					const spinner = startSpinner("Disposing session...", spinnersEnabled(globalOpts));
					try {
						await client.disposeSession(sessionUri);
						spinner.stop();
					} catch {
						spinner.stop();
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
	cfg: AhpxConfig,
	cwd: string,
): Promise<string> {
	const rootState = client.state.root;
	const provider =
		opts.provider ?? cfg.defaultProvider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);
	if (!provider) {
		throw new UsageError("No agent provider available. Specify one with --provider.");
	}
	const sessionId = randomUUID();
	const sessionUri = `${provider}:/${sessionId}`;
	await client.createSession(sessionUri, provider, opts.model ?? cfg.defaultModel, cwd);
	await client.subscribe(sessionUri);
	await waitForReady(client, sessionUri);
	return sessionUri;
}

/** Resolve an existing session or auto-create one. */
async function resolveOrCreateSession(
	client: AhpClient,
	serverInfo: { name: string; url: string },
	opts: { sessionName?: string; provider?: string; model?: string },
	cfg: AhpxConfig,
	cwd: string,
	gitRoot: string | undefined,
	globalOpts: GlobalOpts,
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
		opts.provider ?? cfg.defaultProvider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);
	if (!provider) {
		throw new UsageError("No agent provider available. Specify one with --provider.");
	}
	const sessionId = randomUUID();
	const sessionUri = `${provider}:/${sessionId}`;

	const spinner = startSpinner(`Creating session on ${serverInfo.name}...`, spinnersEnabled(globalOpts));
	try {
		await client.createSession(sessionUri, provider, opts.model ?? cfg.defaultModel, cwd);
		await client.subscribe(sessionUri);

		spinner.update("Waiting for session ready...");
		await waitForReady(client, sessionUri);
		spinner.stop();
	} catch (err) {
		spinner.stop();
		throw err;
	}

	const newRecord: SessionRecord = {
		id: sessionId,
		sessionUri,
		serverName: serverInfo.name,
		serverUrl: serverInfo.url,
		provider,
		model: opts.model ?? cfg.defaultModel ?? client.state.getSession(sessionUri)?.summary.model,
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
			reject(new TimeoutError("Timed out waiting for session to be ready"));
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
				reject(new AhpxError(`Session creation failed: ${errMsg}`, ExitCode.Error));
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
			reject(new AhpxError(`Session creation failed: ${errMsg}`, ExitCode.Error));
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
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				let text = textParts.join(" ");
				if (opts.file) {
					text = await readPromptFile(opts.file);
				}
				if (!text) {
					throw new UsageError("No prompt text provided.");
				}
				await runPrompt({ text, ...opts }, globalOpts);
			} catch (err) {
				handleError(err, globalOpts);
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
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const text = textParts.join(" ");
				if (!text) {
					throw new UsageError("No prompt text provided.");
				}
				await runPrompt({ text, oneShot: true, ...opts }, globalOpts);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

// ── cancel ───────────────────────────────────────────────────────────────────

program
	.command("cancel")
	.description("Cancel the active turn in a session")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.action(async (opts: { sessionName?: string; server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
			const serverName = await resolveServerName(opts.server, cfg);
			const cwd = process.cwd();

			const record = await resolveSession({
				serverName,
				cwd,
				name: opts.sessionName,
				store: sessionStore,
			});

			if (!record) {
				if (globalOpts.format === "text") {
					console.log(pc.dim("No active session found. Nothing to cancel."));
				}
				return;
			}

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				await client.subscribe(record.sessionUri);
				const sessionState = client.state.getSession(record.sessionUri);

				if (!sessionState?.activeTurn) {
					if (globalOpts.format === "text") {
						console.log(pc.dim("No active turn. Nothing to cancel."));
					}
					return;
				}

				client.dispatchAction({
					type: ActionType.SessionTurnCancelled,
					session: record.sessionUri,
					turnId: sessionState.activeTurn.id,
				});
				outputResult(globalOpts, () => console.log(pc.green("✓"), "Cancellation dispatched."), {
					cancelled: true,
					sessionUri: record.sessionUri,
				});
			});
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── completions ──────────────────────────────────────────────────────────────

const completions = program.command("completions").description("Generate shell completion scripts");

completions
	.command("bash")
	.description("Print bash completion script")
	.action(() => {
		process.stdout.write(bashCompletion());
	});

completions
	.command("zsh")
	.description("Print zsh completion script")
	.action(() => {
		process.stdout.write(zshCompletion());
	});

completions
	.command("fish")
	.description("Print fish completion script")
	.action(() => {
		process.stdout.write(fishCompletion());
	});

// ── Implicit prompt (bare text as default verb) ─────────────────────────────

// Check for piped stdin (non-TTY) without explicit command
async function handleImplicitPrompt(): Promise<boolean> {
	const args = process.argv.slice(2);

	// Parse global flags from args before deciding on implicit prompt
	const globalOpts: GlobalOpts = { format: "text", jsonStrict: false, verbose: false };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--format" && i + 1 < args.length) {
			globalOpts.format = args[i + 1] as OutputFormat;
			i++;
		} else if (args[i] === "--json-strict") {
			globalOpts.jsonStrict = true;
		} else if (args[i] === "--verbose" || args[i] === "-v") {
			globalOpts.verbose = true;
		}
	}
	applyGlobalOpts(globalOpts);

	// If no args but stdin is piped, read from stdin
	if (args.length === 0 && stdinIsPipe()) {
		const text = await readStdin();
		if (text) {
			await runPrompt({ text }, globalOpts);
			return true;
		}
		return false;
	}

	// Filter out global flags to find positional args
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let i = 0;
	while (i < args.length) {
		if (args[i] === "--format") {
			i += 2;
			continue;
		}
		if (args[i] === "--json-strict" || args[i] === "--verbose" || args[i] === "-v") {
			i++;
			continue;
		}
		if (args[i] === "--server" || args[i] === "-s") {
			flags.server = args[++i];
		} else if (args[i] === "--session-name" || args[i] === "-n") {
			flags.sessionName = args[++i];
		} else if (args[i] === "--approve-all") {
			flags.approveAll = true;
		} else if (args[i] === "--approve-reads") {
			flags.approveReads = true;
		} else if (args[i] === "--deny-all") {
			flags.denyAll = true;
		} else if (args[i] === "--file" || args[i] === "-f") {
			flags.file = args[++i];
		} else if (!args[i].startsWith("-")) {
			positional.push(args[i]);
		}
		i++;
	}

	// If the first positional arg doesn't match any known command, treat as implicit prompt
	if (positional.length > 0) {
		const knownCommands = new Set([
			"connect",
			"server",
			"config",
			"session",
			"prompt",
			"exec",
			"cancel",
			"completions",
			"help",
			"--help",
			"-h",
			"--version",
			"-V",
		]);
		if (!knownCommands.has(positional[0])) {
			let text: string;

			if (flags.file && typeof flags.file === "string") {
				text = await readPromptFile(flags.file);
			} else {
				text = positional.join(" ");
			}

			if (text) {
				await runPrompt(
					{
						text,
						server: typeof flags.server === "string" ? flags.server : undefined,
						sessionName: typeof flags.sessionName === "string" ? flags.sessionName : undefined,
						approveAll: flags.approveAll === true ? true : undefined,
						approveReads: flags.approveReads === true ? true : undefined,
						denyAll: flags.denyAll === true ? true : undefined,
					},
					globalOpts,
				);
				return true;
			}
		}
	}

	// If no positional args but stdin is piped (with global flags present)
	if (positional.length === 0 && stdinIsPipe()) {
		const text = await readStdin();
		if (text) {
			await runPrompt({ text }, globalOpts);
			return true;
		}
	}

	return false;
}

// Main entry: try implicit prompt first, then fall back to commander
(async () => {
	try {
		const handled = await handleImplicitPrompt();
		if (!handled) {
			// Apply global opts for commander-handled commands via hook
			program.hook("preAction", (thisCommand) => {
				const globalOpts = parseGlobalOpts(thisCommand);
				applyGlobalOpts(globalOpts);

				// Resolve config-level defaults for format/verbose
				// (CLI flags already parsed by Commander at this point)
			});

			program.parse();
		}
	} catch (err) {
		const exitCode = err instanceof AhpxError ? err.exitCode : ExitCode.Error;
		console.error(pc.red("✗"), err instanceof Error ? err.message : String(err));
		process.exitCode = exitCode;
	}
})();
