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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { AhpClient, RpcError } from "./client/index.js";
import { bashCompletion, fishCompletion, zshCompletion } from "./completions.js";
import {
	ConnectionStore,
	ConnectionValidationError,
	globalConfigPath,
	initGlobalConfig,
	isLocalUrl,
	isValidWsUrl,
	loadConfig,
	loadConfigWithSources,
} from "./config/index.js";
import type { AhpxConfig, ConfigSource } from "./config/index.js";
import { discoverCustomizations } from "./customizations/discovery.js";
import { AhpxError, ExitCode, NoSessionError, TimeoutError, UsageError } from "./errors.js";
import type { EventForwarder } from "./events/forwarder.js";
import { ForwardingFormatter } from "./events/forwarding-formatter.js";
import { WebhookForwarder } from "./events/webhook-forwarder.js";
import { WebSocketForwarder } from "./events/ws-forwarder.js";
import { HealthChecker } from "./fleet/health.js";
import { setVerbose } from "./logger.js";
import { createFormatter, startSpinner } from "./output/index.js";
import type { OutputFormat, OutputFormatter } from "./output/index.js";
import { PermissionHandler } from "./permissions/index.js";
import type { PermissionMode } from "./permissions/index.js";
import { TurnController } from "./prompt/index.js";
import { ActionType } from "./protocol/actions.js";
import { ResponsePartKind, SessionStatus } from "./protocol/state.js";
import type { Turn } from "./protocol/state.js";
import { SessionPersistence, SessionStore, findGitRoot, resolveSession, withConnection } from "./session/index.js";
import type { SessionRecord } from "./session/index.js";
import { ensureFileUri } from "./uri.js";
import { SessionWatcher } from "./watch/index.js";

const store = new ConnectionStore();
const sessionStore = new SessionStore();
const sessionPersistence = new SessionPersistence(sessionStore);

/** Derive response text from a turn's response parts (markdown parts concatenated). */
function turnResponseText(turn: Turn): string {
	let text = "";
	for (const p of turn.responseParts) {
		if (p.kind === ResponsePartKind.Markdown) {
			text += p.content;
		}
	}
	return text;
}

/** Count tool calls in a turn's response parts. */
function turnToolCallCount(turn: Turn): number {
	let count = 0;
	for (const p of turn.responseParts) {
		if (p.kind === ResponsePartKind.ToolCall) {
			count++;
		}
	}
	return count;
}

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
function formatterFromOpts(globalOpts: GlobalOpts, tags?: Record<string, string>): OutputFormatter {
	return createFormatter(globalOpts.format, { jsonStrict: globalOpts.jsonStrict, tags });
}

/** Parse --tag key=value flags into a record. Throws UsageError on bad format. */
function parseTags(raw?: string[]): Record<string, string> | undefined {
	if (!raw || raw.length === 0) return undefined;
	const tags: Record<string, string> = {};
	for (const entry of raw) {
		const eq = entry.indexOf("=");
		if (eq <= 0) {
			throw new UsageError(`Invalid --tag format: "${entry}". Expected key=value`);
		}
		tags[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return tags;
}

/** Parse --config key=value pairs into a config record. */
function parseConfigFlags(raw?: string[]): Record<string, unknown> | undefined {
	if (!raw || raw.length === 0) return undefined;
	const config: Record<string, unknown> = {};
	for (const entry of raw) {
		const eq = entry.indexOf("=");
		if (eq <= 0) {
			throw new UsageError(`Invalid --config format: "${entry}". Expected key=value`);
		}
		const key = entry.slice(0, eq);
		const val = entry.slice(eq + 1);
		// Try to parse as JSON value (for booleans, numbers), fall back to string
		try {
			config[key] = JSON.parse(val);
		} catch {
			config[key] = val;
		}
	}
	return config;
}

/** Parse --idle-timeout <seconds> into a validated positive integer. */
function parseIdleTimeout(raw?: string): number | undefined {
	if (raw === undefined) return undefined;
	const seconds = Number.parseInt(raw, 10);
	if (Number.isNaN(seconds) || seconds <= 0) {
		throw new UsageError(`--idle-timeout must be a positive integer (got: "${raw}")`);
	}
	return seconds;
}

/** Parse --forward-headers JSON string into a record. */
function parseForwardHeaders(raw?: string): Record<string, string> | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new UsageError('--forward-headers must be a JSON object (e.g. \'{"Authorization": "Bearer ..."}\')');
		}
		return parsed as Record<string, string>;
	} catch (err) {
		if (err instanceof UsageError) throw err;
		throw new UsageError(`--forward-headers must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Build EventForwarder instances from CLI forwarding flags. */
function buildForwarders(opts: {
	forwardWebhook?: string[];
	forwardWs?: string[];
	forwardFilter?: string;
	forwardHeaders?: string;
}): EventForwarder[] {
	const forwarders: EventForwarder[] = [];
	const headers = parseForwardHeaders(opts.forwardHeaders);
	const filter = opts.forwardFilter
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	if (opts.forwardWebhook) {
		for (const url of opts.forwardWebhook) {
			forwarders.push(new WebhookForwarder({ url, headers, filter }));
		}
	}

	if (opts.forwardWs) {
		for (const url of opts.forwardWs) {
			forwarders.push(new WebSocketForwarder({ url, headers, filter }));
		}
	}

	return forwarders;
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
	result: { protocolVersion: string; serverSeq: number; defaultDirectory?: string },
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
	result: { protocolVersion: string; serverSeq: number; defaultDirectory?: string },
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
	const raw = err instanceof Error ? err.message : String(err);
	const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
	const message = raw || code || "Unknown error";
	const exitCode = err instanceof AhpxError ? err.exitCode : ExitCode.Error;

	if (globalOpts?.format === "json") {
		console.log(JSON.stringify({ error: message, exitCode }));
	} else if (globalOpts?.format !== "quiet" || exitCode !== ExitCode.Success) {
		console.error(pc.red("✗"), message);
	}

	if (globalOpts?.verbose && err instanceof Error && err.stack) {
		console.error(pc.dim(err.stack));
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

				// Authenticate for each protected resource declared by agents
				const agents = client.state.root?.agents ?? [];
				const resources = agents.flatMap((a) => a.protectedResources ?? []);

				if (token) {
					for (const r of resources) {
						await client.authenticate(r.resource, token);
					}
				} else {
					const envToken = process.env.AHPX_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
					if (envToken) {
						for (const r of resources) {
							await client.authenticate(r.resource, envToken).catch(() => {});
						}
					}
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
	.option(
		"--tag <tag>",
		"Add a tag to this server (repeatable)",
		(val: string, prev: string[]) => [...prev, val],
		[] as string[],
	)
	.action(
		async (name: string, opts: { url: string; token?: string; default?: boolean; tag: string[] }, cmd: Command) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const tags = opts.tag.length > 0 ? opts.tag : undefined;
				await store.add({
					name,
					url: opts.url,
					token: opts.token,
					default: opts.default ?? false,
					tags,
				});
				outputResult(
					globalOpts,
					() => {
						console.log(pc.green("✓"), `Saved connection ${pc.bold(name)} → ${pc.dim(opts.url)}`);
						if (opts.default) {
							console.log(pc.dim("  Set as default server"));
						}
						if (tags) {
							console.log(pc.dim(`  Tags: ${tags.join(", ")}`));
						}
					},
					{ name, url: opts.url, default: opts.default ?? false, tags: tags ?? [] },
				);
			} catch (err) {
				if (err instanceof ConnectionValidationError) {
					handleError(new UsageError(err.message), globalOpts);
				} else {
					handleError(err, globalOpts);
				}
			}
		},
	);

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

				// Authenticate for each protected resource declared by agents
				const agents = client.state.root?.agents ?? [];
				const resources = agents.flatMap((a) => a.protectedResources ?? []);

				if (token) {
					for (const r of resources) {
						await client.authenticate(r.resource, token);
					}
				} else {
					const envToken = process.env.AHPX_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
					if (envToken) {
						for (const r of resources) {
							await client.authenticate(r.resource, envToken).catch(() => {});
						}
					}
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

server
	.command("status")
	.description("Health check all saved servers")
	.option("--all", "Show all servers including unreachable")
	.option("-t, --timeout <ms>", "Health check timeout in milliseconds", "10000")
	.action(async (opts: { all?: boolean; timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const connections = await store.list();

			if (connections.length === 0) {
				outputResult(
					globalOpts,
					() => console.log(pc.dim("No saved connections. Run"), pc.bold("ahpx server add"), pc.dim("to add one.")),
					[],
				);
				return;
			}

			const spinner = startSpinner(`Checking ${connections.length} server(s)...`, spinnersEnabled(globalOpts));
			const checker = new HealthChecker({ timeout: Number.parseInt(opts.timeout, 10) });
			const results = await checker.checkAll(connections);
			spinner.stop();

			const displayed = opts.all ? results : results.filter((r) => r.status !== "unreachable");

			outputResult(
				globalOpts,
				() => {
					if (displayed.length === 0) {
						console.log(pc.dim("No servers to check."));
						return;
					}

					const nameW = Math.max(4, ...displayed.map((r) => r.name.length));
					const urlW = Math.max(3, ...displayed.map((r) => r.url.length));

					console.log(
						`  ${pc.bold("Name".padEnd(nameW))}  ${pc.bold("URL".padEnd(urlW))}  ${pc.bold("Status".padEnd(11))}  ${pc.bold("Latency".padEnd(9))}  ${pc.bold("Sessions".padEnd(8))}  ${pc.bold("Agents")}`,
					);
					console.log(
						`  ${"─".repeat(nameW)}  ${"─".repeat(urlW)}  ${"─".repeat(11)}  ${"─".repeat(9)}  ${"─".repeat(8)}  ${"─".repeat(10)}`,
					);

					for (const r of displayed) {
						const statusColor = r.status === "healthy" ? pc.green : r.status === "degraded" ? pc.yellow : pc.red;
						const latency = r.status === "unreachable" ? pc.dim("—") : `${Math.round(r.latencyMs)}ms`;
						const sessions = r.status === "unreachable" ? pc.dim("—") : String(r.activeSessions);
						const agents =
							r.status === "unreachable" ? pc.dim("—") : r.agents.map((a) => a.provider).join(", ") || pc.dim("none");

						console.log(
							`  ${pc.cyan(r.name.padEnd(nameW))}  ${r.url.padEnd(urlW)}  ${statusColor(r.status.padEnd(11))}  ${String(latency).padEnd(9)}  ${String(sessions).padEnd(8)}  ${agents}`,
						);
					}
				},
				displayed.map((r) => ({
					name: r.name,
					url: r.url,
					status: r.status,
					latencyMs: r.latencyMs,
					activeSessions: r.activeSessions,
					agents: r.agents,
					error: r.error,
				})),
			);
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

server
	.command("health")
	.description("Detailed health check for a single server")
	.argument("<name>", "Connection name")
	.option("-t, --timeout <ms>", "Health check timeout in milliseconds", "10000")
	.action(async (name: string, opts: { timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const conn = await store.get(name);
			if (!conn) {
				throw new AhpxError(
					`Connection "${name}" not found. Run ${pc.bold("ahpx server list")} to see saved connections.`,
					ExitCode.Error,
				);
			}

			const spinner = startSpinner(`Checking ${name}...`, spinnersEnabled(globalOpts));
			const checker = new HealthChecker({ timeout: Number.parseInt(opts.timeout, 10) });
			const health = await checker.check(conn.url, conn.name);
			spinner.stop();

			outputResult(
				globalOpts,
				() => {
					const statusColor =
						health.status === "healthy" ? pc.green : health.status === "degraded" ? pc.yellow : pc.red;

					console.log(pc.bold("Server:"), pc.cyan(health.name));
					console.log(pc.bold("URL:"), health.url);
					console.log(pc.bold("Status:"), statusColor(health.status));
					console.log(
						pc.bold("Latency:"),
						health.status === "unreachable" ? pc.dim("—") : `${Math.round(health.latencyMs)}ms`,
					);
					if (health.protocolVersion !== undefined) {
						console.log(pc.bold("Protocol:"), `v${health.protocolVersion}`);
					}
					console.log(
						pc.bold("Active sessions:"),
						health.status === "unreachable" ? pc.dim("—") : String(health.activeSessions),
					);

					if (health.agents.length > 0) {
						console.log(pc.bold("Agents:"));
						for (const agent of health.agents) {
							console.log(`  ${pc.cyan(agent.provider)}: ${agent.models.join(", ") || pc.dim("no models")}`);
						}
					} else if (health.status !== "unreachable") {
						console.log(pc.bold("Agents:"), pc.dim("none"));
					}

					if (conn.tags && conn.tags.length > 0) {
						console.log(pc.bold("Tags:"), conn.tags.join(", "));
					}

					if (health.error) {
						console.log(pc.bold("Error:"), pc.red(health.error));
					}

					console.log(pc.bold("Checked at:"), health.checkedAt);
				},
				health,
			);
		} catch (err) {
			handleError(err, globalOpts);
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

/**
 * Validate that --cwd is provided when targeting a remote server.
 * Throws UsageError if --server points to a non-local host and --cwd is missing.
 */
async function requireCwdForRemoteServer(server: string | undefined, cwd: string | undefined): Promise<void> {
	if (!server || cwd) return;

	let url: string;
	if (isValidWsUrl(server)) {
		url = server;
	} else {
		const store = new ConnectionStore();
		const conn = await store.get(server);
		if (!conn) return; // Unknown server — let withConnection() handle the error
		url = conn.url;
	}

	if (!isLocalUrl(url)) {
		throw new UsageError(
			`--cwd is required when targeting a remote server.\nUse 'ahpx browse --server ${server}' to browse the remote filesystem and find the correct working directory.`,
		);
	}
}

// ── session new ──────────────────────────────────────────────────────────────

session
	.command("new")
	.description("Create a new agent session")
	.option("-s, --server <name>", "Server name or WebSocket URL")
	.option("-p, --provider <provider>", "Agent provider (e.g. copilot)")
	.option("-m, --model <model>", "Model to use")
	.option("-n, --name <name>", "Name this session (for scoped lookups)")
	.option("--cwd <dir>", "Working directory")
	.option("-c, --config <key=value...>", "Session config values (repeatable, e.g. -c autoApprove=autopilot)")
	.option("--no-customizations", "Skip workspace customization discovery")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (
			opts: {
				server?: string;
				provider?: string;
				model?: string;
				name?: string;
				cwd?: string;
				config?: string[];
				customizations: boolean;
				timeout: string;
			},
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				await requireCwdForRemoteServer(opts.server, opts.cwd);
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				const provider = opts.provider ?? cfg.defaultProvider;
				const model = opts.model ?? cfg.defaultModel;
				const cwd = opts.cwd ?? process.cwd();
				const gitRoot = await findGitRoot(cwd);
				const sessionConfig = parseConfigFlags(opts.config);

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

						// Resolve session config (gracefully handle servers that don't support it)
						let resolvedConfig = sessionConfig;
						try {
							const configResult = await client.resolveSessionConfig({
								provider: resolvedProvider,
								workingDirectory: ensureFileUri(cwd),
								config: sessionConfig,
							});

							// Merge server defaults with user-provided config
							resolvedConfig = { ...configResult.values, ...sessionConfig };

							if (globalOpts.format === "text") {
								const props = Object.entries(configResult.schema.properties);
								if (props.length > 0) {
									console.log(pc.bold("Session Configuration"));
									for (const [key, prop] of props) {
										const value = resolvedConfig?.[key];
										const mutable = prop.sessionMutable ? pc.green("mutable") : pc.dim("read-only");
										const valStr = value !== undefined ? pc.cyan(JSON.stringify(value)) : pc.dim("(default)");
										console.log(
											`  ${pc.bold(key)}: ${valStr} [${mutable}]${prop.enum ? ` (${prop.enum.join(", ")})` : ""}`,
										);
									}
									console.log();
								}
							}
						} catch (err) {
							if (
								err instanceof RpcError &&
								(err.code === -32601 || err.code === -32603 || err.message?.includes("Unknown method"))
							) {
								// Server doesn't support resolveSessionConfig — continue without config resolution
							} else {
								throw err;
							}
						}

						// Generate a session URI
						const sessionId = randomUUID();
						const sessionUri = `${resolvedProvider}:/${sessionId}`;

						const spinner = startSpinner(`Creating session on ${serverInfo.name}...`, spinnersEnabled(globalOpts));

						try {
							// Create the session with config
							await client.createSession(sessionUri, resolvedProvider, model, ensureFileUri(cwd), resolvedConfig);

							// Subscribe to the session URI
							await client.subscribe(sessionUri);

							// Check if session is provisional (lifecycle stays "creating" after subscribe)
							const sessionStateAfterSub = client.state.getSession(sessionUri);
							const isProvisional = sessionStateAfterSub?.lifecycle === "creating";

							// Wait for session/ready or session/creationFailed.
							// Provisional sessions skip this — they stay in "creating" until the first prompt.
							let ready = true;
							if (!isProvisional) {
								spinner.update("Waiting for session ready...");

								ready = await new Promise<boolean>((resolve, reject) => {
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
							}

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
								model: model ?? sessionState?.summary.model?.id,
								name: opts.name,
								workingDirectory: cwd,
								gitRoot,
								title: sessionState?.summary.title,
								status: "active",
								createdAt: new Date().toISOString(),
							};
							await sessionStore.save(record);

							// Discover and dispatch workspace customizations
							let discoveredCount = 0;
							if (opts.customizations !== false) {
								const discovered = await discoverCustomizations(cwd);
								discoveredCount = discovered.length;
								if (discovered.length > 0) {
									client.dispatchAction({
										type: ActionType.SessionActiveClientChanged,
										session: sessionUri,
										activeClient: {
											clientId: client.clientId,
											tools: [],
											customizations: discovered,
										},
									});
								}
							}

							outputResult(
								globalOpts,
								() => {
									console.log(pc.green("✓ Session created"));
									if (isProvisional) {
										console.log(pc.dim("  (provisional — becomes active on first prompt)"));
									}
									console.log();
									console.log(pc.bold("ID:"), sessionId);
									console.log(pc.bold("URI:"), pc.cyan(sessionUri));
									console.log(pc.bold("Provider:"), resolvedProvider);
									if (record.model) console.log(pc.bold("Model:"), record.model);
									if (opts.name) console.log(pc.bold("Name:"), opts.name);
									console.log(pc.bold("Directory:"), cwd);
									if (gitRoot) console.log(pc.bold("Git root:"), gitRoot);
									console.log(pc.bold("Status:"), pc.green("active"));
									if (resolvedConfig && Object.keys(resolvedConfig).length > 0) {
										console.log(pc.bold("Config:"), JSON.stringify(resolvedConfig));
									}
									if (discoveredCount > 0) {
										console.log(pc.bold("Customizations:"), `Discovered ${discoveredCount} customizations`);
									}
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
									...(isProvisional ? { provisional: true } : {}),
									...(resolvedConfig ? { config: resolvedConfig } : {}),
									...(discoveredCount > 0 ? { customizations: discoveredCount } : {}),
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

/** Format a turn for text output (shared by server and local history). */
function formatTurnEntry(entry: {
	id: string;
	userMessage: string;
	responsePreview: string;
	toolCalls: number;
	usage?: { inputTokens?: number; outputTokens?: number; model?: string } | null;
	timestamp?: string;
}): void {
	const userMsg = truncate(entry.userMessage, 80);
	const responseMsg = truncate(entry.responsePreview, 80);
	const usageStr = entry.usage ? `${entry.usage.inputTokens ?? "?"}→${entry.usage.outputTokens ?? "?"}t` : "";
	const timeStr = entry.timestamp ? pc.dim(` (${formatAge(entry.timestamp)})`) : "";

	console.log(pc.bold(pc.cyan(`  Turn ${entry.id.slice(0, 8)}`)) + timeStr);
	console.log(`    ${pc.bold("User:")} ${userMsg}`);
	console.log(`    ${pc.bold("Response:")} ${responseMsg}`);
	if (entry.toolCalls > 0) {
		console.log(`    ${pc.bold("Tool calls:")} ${entry.toolCalls}`);
	}
	if (usageStr) {
		console.log(`    ${pc.bold("Tokens:")} ${usageStr}`);
	}
	if (entry.usage?.model) {
		console.log(`    ${pc.bold("Model:")} ${entry.usage.model}`);
	}
	console.log();
}

session
	.command("history")
	.description("Show turn history for a session")
	.argument("[id]", "Session ID")
	.option("-n, --name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-l, --limit <n>", "Maximum number of turns to show", "10")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.option("--local", "Show only locally-cached turn history (no server connection)")
	.action(
		async (
			id: string | undefined,
			opts: { name?: string; server?: string; limit: string; timeout: string; local?: boolean },
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const record = await resolveSessionRecord(id, opts);
				const limit = Number.parseInt(opts.limit, 10);

				// --local flag: show only locally-cached turns
				if (opts.local) {
					showLocalHistory(record, limit, globalOpts);
					return;
				}

				// Try server first, fall back to local
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				try {
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
										formatTurnEntry({
											id: turn.id,
											userMessage: turn.userMessage.text,
											responsePreview: turnResponseText(turn) || "(no response)",
											toolCalls: turnToolCallCount(turn),
											usage: turn.usage,
										});
									}
								},
								{
									source: "server",
									sessionId: record.id,
									hasMore: result.hasMore,
									turns: result.turns.map((t) => ({
										id: t.id,
										userMessage: t.userMessage.text,
										responseText: turnResponseText(t),
										toolCalls: turnToolCallCount(t),
										usage: t.usage,
									})),
								},
							);
						},
					);
				} catch {
					// Server unreachable — fall back to local history
					if (globalOpts.format === "text") {
						console.error(pc.yellow("Server unavailable. Showing locally-cached history.\n"));
					}
					showLocalHistory(record, limit, globalOpts);
				}
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

/** Display locally-cached turn history from a session record. */
function showLocalHistory(record: SessionRecord, limit: number, globalOpts: GlobalOpts): void {
	const turns = record.turns ?? [];
	const display = turns.slice(-limit);

	outputResult(
		globalOpts,
		() => {
			if (display.length === 0) {
				console.log(pc.dim("No locally-cached turns for this session."));
				return;
			}

			console.log(
				pc.bold(`Local history for session ${record.id.slice(0, 8)}`),
				pc.dim(`(${display.length} of ${turns.length} turns)`),
			);
			console.log();

			for (const turn of display) {
				formatTurnEntry({
					id: turn.turnId,
					userMessage: turn.userMessage,
					responsePreview: turn.responsePreview,
					toolCalls: turn.toolCallCount,
					usage: turn.tokenUsage
						? { inputTokens: turn.tokenUsage.input, outputTokens: turn.tokenUsage.output, model: turn.tokenUsage.model }
						: undefined,
					timestamp: turn.timestamp,
				});
			}
		},
		{
			source: "local",
			sessionId: record.id,
			turns: display.map((t) => ({
				turnId: t.turnId,
				userMessage: t.userMessage,
				responsePreview: t.responsePreview,
				toolCallCount: t.toolCallCount,
				tokenUsage: t.tokenUsage,
				state: t.state,
				timestamp: t.timestamp,
			})),
		},
	);
}

// ── session config ───────────────────────────────────────────────────────────

const sessionConfig = session.command("config").description("Show or modify session configuration");

sessionConfig
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (id: string | undefined, opts: { sessionName?: string; server?: string; timeout: string }, cmd: Command) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const record = await resolveSessionRecord(id, { name: opts.sessionName, server: opts.server });
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

				await withConnection(
					{
						server: record.serverName,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						await client.subscribe(record.sessionUri);
						const sessionState = client.state.getSession(record.sessionUri);
						const config = sessionState?.config;

						if (!config || Object.keys(config.schema.properties).length === 0) {
							outputResult(globalOpts, () => console.log(pc.dim("No configuration available for this session.")), {
								config: null,
							});
							return;
						}

						outputResult(
							globalOpts,
							() => {
								console.log(pc.bold("Session Configuration"));
								console.log();
								for (const [key, prop] of Object.entries(config.schema.properties)) {
									const value = config.values[key];
									const mutable = prop.sessionMutable ? pc.green("mutable") : pc.dim("read-only");
									console.log(`  ${pc.bold(key)} ${pc.dim(`(${prop.type})`)} [${mutable}]`);
									if (prop.title) console.log(`    ${prop.title}`);
									if (prop.description) console.log(`    ${pc.dim(prop.description)}`);
									console.log(
										`    Value: ${value !== undefined ? pc.cyan(JSON.stringify(value)) : pc.dim("(not set)")}`,
									);
									if (prop.default !== undefined) console.log(`    Default: ${pc.dim(JSON.stringify(prop.default))}`);
									if (prop.enum) console.log(`    Allowed: ${prop.enum.join(", ")}`);
									console.log();
								}
							},
							config,
						);
					},
				);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

sessionConfig
	.command("set")
	.description("Set a session-mutable configuration property")
	.argument("<key>", "Configuration property key")
	.argument("<value>", "New value")
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (
			key: string,
			value: string,
			id: string | undefined,
			opts: { sessionName?: string; server?: string; timeout: string },
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const record = await resolveSessionRecord(id, { name: opts.sessionName, server: opts.server });
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

				await withConnection(
					{
						server: record.serverName,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						await client.subscribe(record.sessionUri);
						const sessionState = client.state.getSession(record.sessionUri);
						const config = sessionState?.config;

						if (!config) {
							throw new UsageError("No configuration available for this session.");
						}

						const prop = config.schema.properties[key];
						if (!prop) {
							const available = Object.keys(config.schema.properties);
							throw new UsageError(
								`Unknown config key "${key}". Available keys: ${available.length > 0 ? available.join(", ") : "(none)"}`,
							);
						}

						if (!prop.sessionMutable) {
							throw new UsageError(`Config key "${key}" is not session-mutable (read-only after creation).`);
						}

						// Coerce value based on schema type
						let coerced: unknown = value;
						if (prop.type === "number") {
							coerced = Number(value);
							if (Number.isNaN(coerced as number)) {
								throw new UsageError(`Invalid number value "${value}" for key "${key}".`);
							}
						} else if (prop.type === "boolean") {
							if (value === "true") coerced = true;
							else if (value === "false") coerced = false;
							else throw new UsageError(`Invalid boolean value "${value}" for key "${key}". Use "true" or "false".`);
						}

						// Validate against enum if present
						if (prop.enum && !prop.enum.includes(String(coerced))) {
							throw new UsageError(
								`Invalid value "${value}" for key "${key}". Allowed values: ${prop.enum.join(", ")}`,
							);
						}

						client.dispatchAction({
							type: ActionType.SessionConfigChanged,
							session: record.sessionUri,
							config: { [key]: coerced },
						});

						outputResult(
							globalOpts,
							() => console.log(pc.green("✓"), `Set ${pc.bold(key)} = ${pc.cyan(JSON.stringify(coerced))}`),
							{ key, value: coerced, sessionUri: record.sessionUri },
						);
					},
				);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

// ── session customization ────────────────────────────────────────────────────

const sessionCustomization = session
	.command("customization")
	.alias("cust")
	.description("View and manage session customizations");

sessionCustomization
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (id: string | undefined, opts: { sessionName?: string; server?: string; timeout: string }, cmd: Command) => {
			// Default action: list customizations (same as `session customization list`)
			await listCustomizations(id, opts, cmd);
		},
	);

sessionCustomization
	.command("list")
	.description("List customizations on a session")
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (id: string | undefined, opts: { sessionName?: string; server?: string; timeout: string }, cmd: Command) => {
			await listCustomizations(id, opts, cmd);
		},
	);

async function listCustomizations(
	id: string | undefined,
	opts: { sessionName?: string; server?: string; timeout: string },
	cmd: Command,
): Promise<void> {
	const globalOpts = parseGlobalOpts(cmd);
	applyGlobalOpts(globalOpts);

	try {
		const record = await resolveSessionRecord(id, { name: opts.sessionName, server: opts.server });
		const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

		await withConnection(
			{
				server: record.serverName,
				config: cfg,
				timeout: Number.parseInt(opts.timeout, 10),
			},
			async (client) => {
				await client.subscribe(record.sessionUri);
				const sessionState = client.state.getSession(record.sessionUri);
				const customizations = sessionState?.customizations ?? [];

				if (customizations.length === 0) {
					outputResult(globalOpts, () => console.log(pc.dim("No customizations on this session.")), []);
					return;
				}

				outputResult(
					globalOpts,
					() => {
						const uriW = Math.max(3, ...customizations.map((c) => c.customization.uri.length));
						const nameW = Math.max(4, ...customizations.map((c) => c.customization.displayName.length));
						const enabledW = 7;
						const statusW = 8;

						console.log(
							`  ${pc.bold("URI".padEnd(uriW))}  ${pc.bold("Name".padEnd(nameW))}  ${pc.bold("Enabled".padEnd(enabledW))}  ${pc.bold("Status".padEnd(statusW))}`,
						);
						console.log(`  ${"─".repeat(uriW)}  ${"─".repeat(nameW)}  ${"─".repeat(enabledW)}  ${"─".repeat(statusW)}`);

						for (const c of customizations) {
							const enabled = c.enabled ? pc.green("yes") : pc.red("no");
							const status = c.status ?? pc.dim("—");
							console.log(
								`  ${c.customization.uri.padEnd(uriW)}  ${c.customization.displayName.padEnd(nameW)}  ${String(enabled).padEnd(enabledW + 10)}  ${String(status).padEnd(statusW)}`,
							);
						}
					},
					customizations,
				);
			},
		);
	} catch (err) {
		handleError(err, globalOpts);
	}
}

sessionCustomization
	.command("toggle")
	.description("Toggle a customization's enabled state")
	.argument("<uri>", "Customization URI to toggle")
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(
		async (
			uri: string,
			id: string | undefined,
			opts: { sessionName?: string; server?: string; timeout: string },
			cmd: Command,
		) => {
			const globalOpts = parseGlobalOpts(cmd);
			applyGlobalOpts(globalOpts);

			try {
				const record = await resolveSessionRecord(id, { name: opts.sessionName, server: opts.server });
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

				await withConnection(
					{
						server: record.serverName,
						config: cfg,
						timeout: Number.parseInt(opts.timeout, 10),
					},
					async (client) => {
						await client.subscribe(record.sessionUri);
						const sessionState = client.state.getSession(record.sessionUri);
						const customizations = sessionState?.customizations ?? [];

						const target = customizations.find((c) => c.customization.uri === uri);
						if (!target) {
							throw new UsageError(
								`Customization "${uri}" not found on this session.${customizations.length > 0 ? ` Available: ${customizations.map((c) => c.customization.uri).join(", ")}` : ""}`,
							);
						}

						const newEnabled = !target.enabled;
						client.dispatchAction({
							type: ActionType.SessionCustomizationToggled,
							session: record.sessionUri,
							uri,
							enabled: newEnabled,
						});

						outputResult(
							globalOpts,
							() =>
								console.log(
									pc.green("✓"),
									`${pc.bold(target.customization.displayName)} ${newEnabled ? pc.green("enabled") : pc.red("disabled")}`,
								),
							{ uri, enabled: newEnabled, displayName: target.customization.displayName },
						);
					},
				);
			} catch (err) {
				handleError(err, globalOpts);
			}
		},
	);

// ── session export / import ─────────────────────────────────────────────────

session
	.command("export")
	.description("Export a session record (with local turn history) to JSON")
	.argument("<id>", "Session ID")
	.option("-o, --output <file>", "Write to file instead of stdout")
	.action(async (id: string, opts: { output?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const record = await sessionStore.get(id);
			if (!record) {
				throw new NoSessionError(`Session "${id}" not found.`);
			}

			const exported = JSON.stringify(record, null, "\t");

			if (opts.output) {
				await fs.writeFile(path.resolve(opts.output), `${exported}\n`, "utf-8");
				if (globalOpts.format === "text") {
					console.error(pc.green(`Session exported to ${opts.output}`));
				}
			} else {
				console.log(exported);
			}
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

session
	.command("import")
	.description("Import a session record from a JSON file")
	.argument("<file>", "Path to JSON file")
	.action(async (filePath: string, _opts: Record<string, unknown>, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const resolved = path.resolve(filePath);
			const raw = await fs.readFile(resolved, "utf-8");
			let record: SessionRecord;
			try {
				record = JSON.parse(raw) as SessionRecord;
			} catch {
				throw new UsageError(`Failed to parse "${filePath}" as JSON.`);
			}

			// Validate required fields
			if (!record.id || !record.sessionUri || !record.serverName || !record.serverUrl || !record.provider) {
				throw new UsageError(
					"Invalid session record: missing required fields (id, sessionUri, serverName, serverUrl, provider).",
				);
			}
			if (!record.status || (record.status !== "active" && record.status !== "closed")) {
				throw new UsageError('Invalid session record: status must be "active" or "closed".');
			}
			if (!record.createdAt) {
				throw new UsageError("Invalid session record: missing createdAt timestamp.");
			}

			await sessionStore.save(record);

			outputResult(
				globalOpts,
				() => {
					console.log(pc.green(`Session ${record.id.slice(0, 8)} imported successfully.`));
					console.log(`  ${pc.bold("URI:")} ${record.sessionUri}`);
					console.log(`  ${pc.bold("Server:")} ${record.serverName}`);
					console.log(`  ${pc.bold("Status:")} ${record.status}`);
					if (record.turns?.length) {
						console.log(`  ${pc.bold("Local turns:")} ${record.turns.length}`);
					}
				},
				{ id: record.id, sessionUri: record.sessionUri, status: record.status },
			);
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── session active ───────────────────────────────────────────────────────────

session
	.command("active")
	.description("Show all active sessions on the server (live query)")
	.option("-s, --server <name>", "Server name or WebSocket URL")
	.option("-t, --timeout <ms>", "Connection timeout in milliseconds", "10000")
	.action(async (opts: { server?: string; timeout: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

			await withConnection(
				{
					server: opts.server,
					config: cfg,
					timeout: Number.parseInt(opts.timeout, 10),
				},
				async (client, serverInfo) => {
					const result = await client.listSessions();

					outputResult(
						globalOpts,
						() => {
							if (result.items.length === 0) {
								console.log(pc.dim(`No active sessions on ${serverInfo.name}.`));
								return;
							}

							console.log(pc.bold(`Active sessions on ${serverInfo.name}`), pc.dim(`(${result.items.length})`));
							console.log();

							for (const s of result.items) {
								const status =
									s.status === SessionStatus.Error
										? pc.red("● error")
										: s.status === SessionStatus.InputNeeded
											? pc.yellow("● input-needed")
											: s.status === SessionStatus.InProgress
												? pc.yellow("● in-progress")
												: pc.green("● idle");

								console.log(`  ${pc.bold(pc.cyan(s.resource))}`);
								console.log(`    ${pc.bold("Provider:")} ${s.provider}`);
								if (s.model) console.log(`    ${pc.bold("Model:")} ${s.model.id}`);
								if (s.title) console.log(`    ${pc.bold("Title:")} ${s.title}`);
								console.log(`    ${pc.bold("Status:")} ${status}`);
								console.log();
							}
						},
						{
							server: serverInfo.name,
							sessions: result.items.map((s) => ({
								resource: s.resource,
								provider: s.provider,
								model: s.model?.id,
								title: s.title,
								status: s.status,
								createdAt: s.createdAt,
							})),
						},
					);
				},
			);
		} catch (err) {
			handleError(err, globalOpts);
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
		session?: string;
		approveAll?: boolean;
		approveReads?: boolean;
		denyAll?: boolean;
		provider?: string;
		model?: string;
		/** If true, create a temporary session (exec mode). */
		oneShot?: boolean;
		/** Working directory for session creation. Defaults to process.cwd(). */
		cwd?: string;
		/** Session configuration values to pass at creation. */
		sessionConfig?: Record<string, unknown>;
		/** Whether to discover workspace customizations. Defaults to true. */
		customizations?: boolean;
		/** Idle timeout in seconds. */
		idleTimeout?: number;
		/** Metadata tags to include in JSON output envelopes. */
		tags?: Record<string, string>;
		/** Event forwarders for dashboard integration. */
		forwarders?: EventForwarder[];
	},
	globalOpts: GlobalOpts,
): Promise<void> {
	await requireCwdForRemoteServer(opts.server, opts.cwd);
	const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
	const cwd = opts.cwd ?? process.cwd();
	const gitRoot = await findGitRoot(cwd);
	const permMode = resolvePermissionMode(opts, cfg);
	let formatter: OutputFormatter = formatterFromOpts(globalOpts, opts.tags);

	// Wrap formatter with event forwarding if forwarders are configured
	let forwardingFormatter: ForwardingFormatter | undefined;
	if (opts.forwarders && opts.forwarders.length > 0) {
		forwardingFormatter = new ForwardingFormatter({
			inner: formatter,
			forwarders: opts.forwarders,
			tags: opts.tags,
		});
		formatter = forwardingFormatter;
	}

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
					sessionUri = await createTempSession(client, opts, cfg, cwd, opts.sessionConfig);
					spinner.stop();
				} catch (err) {
					spinner.stop();
					throw err;
				}
			} else {
				// Try to resolve existing session
				const resolved = await resolveOrCreateSession(
					client,
					serverInfo,
					opts,
					cfg,
					cwd,
					gitRoot,
					globalOpts,
					opts.sessionConfig,
				);
				sessionUri = resolved.sessionUri;
				sessionRecord = resolved.record;
			}

			// Discover and dispatch workspace customizations
			if (opts.customizations !== false) {
				const discovered = await discoverCustomizations(cwd);
				if (discovered.length > 0) {
					client.dispatchAction({
						type: ActionType.SessionActiveClientChanged,
						session: sessionUri,
						activeClient: {
							clientId: client.clientId,
							tools: [],
							customizations: discovered,
						},
					});
				}
			}

			// Run the turn
			if (forwardingFormatter) {
				forwardingFormatter.sessionUri = sessionUri;
			}
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
				const result = await controller.prompt(opts.text, undefined, {
					idleTimeout: opts.idleTimeout ? opts.idleTimeout * 1000 : undefined,
				});

				// Update session record for persistent sessions
				if (sessionRecord) {
					await sessionStore.update(sessionRecord.id, {
						lastPromptAt: new Date().toISOString(),
						title: client.state.getSession(sessionUri)?.summary.title ?? sessionRecord.title,
					});

					// Persist turn summary locally
					if (result.state === "complete" || result.state === "cancelled" || result.state === "error") {
						await sessionPersistence.saveTurn(sessionRecord.id, {
							turnId: result.turnId,
							responseText: result.responseText,
							toolCalls: result.toolCalls,
							usage: result.usage,
							state: result.state as "complete" | "cancelled" | "error",
							userMessage: opts.text,
						});
					}
				}

				if (result.state === "error") {
					process.exitCode = ExitCode.Error;
				}
				if (result.state === "idle_timeout") {
					throw new TimeoutError(`Idle timeout: no events received for ${opts.idleTimeout} seconds`);
				}
			} finally {
				process.removeListener("SIGINT", sigintHandler);

				// Flush and close event forwarders
				if (forwardingFormatter) {
					await forwardingFormatter.close();
				}

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
	sessionConfig?: Record<string, unknown>,
): Promise<string> {
	const rootState = client.state.root;
	const provider =
		opts.provider ?? cfg.defaultProvider ?? (rootState.agents.length > 0 ? rootState.agents[0].provider : undefined);
	if (!provider) {
		throw new UsageError("No agent provider available. Specify one with --provider.");
	}
	const sessionId = randomUUID();
	const sessionUri = `${provider}:/${sessionId}`;
	await client.createSession(sessionUri, provider, opts.model ?? cfg.defaultModel, ensureFileUri(cwd), sessionConfig);
	await client.subscribe(sessionUri);

	// Check if session is provisional (lifecycle stays "creating" after subscribe)
	const sessionState = client.state.getSession(sessionUri);
	const isProvisional = sessionState?.lifecycle === "creating";

	if (!isProvisional) {
		await waitForReady(client, sessionUri);
	}
	return sessionUri;
}

/** Resolve an existing session or auto-create one. */
async function resolveOrCreateSession(
	client: AhpClient,
	serverInfo: { name: string; url: string },
	opts: { sessionName?: string; session?: string; provider?: string; model?: string },
	cfg: AhpxConfig,
	cwd: string,
	gitRoot: string | undefined,
	globalOpts: GlobalOpts,
	sessionConfig?: Record<string, unknown>,
): Promise<{ sessionUri: string; record: SessionRecord }> {
	let record: SessionRecord | undefined;

	if (opts.session) {
		// Direct session ID lookup
		record = await sessionStore.get(opts.session);
		if (!record) {
			throw new NoSessionError(`Session "${opts.session}" not found.`);
		}
	} else {
		record = await resolveSession({
			serverName: serverInfo.name,
			cwd,
			name: opts.sessionName,
			store: sessionStore,
		});
	}

	if (record) {
		// Verify the session still exists on the server
		const outcome = await sessionPersistence.resume(record, client);

		if (outcome.status === "resumed") {
			return { sessionUri: record.sessionUri, record };
		}

		if (outcome.status === "not_found") {
			if (globalOpts.format === "text") {
				console.error(pc.yellow("Session expired, creating new one..."));
			}
			await sessionStore.close(record.id);
		}
		if (outcome.status === "error") {
			if (globalOpts.format === "text") {
				console.error(pc.yellow("Session expired, creating new one..."));
			}
			await sessionStore.close(record.id);
		}
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
		await client.createSession(sessionUri, provider, opts.model ?? cfg.defaultModel, ensureFileUri(cwd), sessionConfig);
		await client.subscribe(sessionUri);

		// Check if session is provisional (lifecycle stays "creating" after subscribe)
		const sessionState = client.state.getSession(sessionUri);
		const isProvisional = sessionState?.lifecycle === "creating";

		if (!isProvisional) {
			spinner.update("Waiting for session ready...");
			await waitForReady(client, sessionUri);
		}
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
		model: opts.model ?? cfg.defaultModel ?? client.state.getSession(sessionUri)?.summary.model?.id,
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
			cleanup();
			reject(new TimeoutError("Timed out waiting for session to be ready"));
		}, 30_000);

		const onAction = (envelope: { action: { type: string; session?: string } }) => {
			const action = envelope.action;
			if (action.type === ActionType.SessionReady && action.session === sessionUri) {
				cleanup();
				resolve();
			} else if (action.type === ActionType.SessionCreationFailed && action.session === sessionUri) {
				cleanup();
				const sessionState = client.state.getSession(sessionUri);
				const errMsg = sessionState?.creationError?.message ?? "Unknown error";
				reject(new AhpxError(`Session creation failed: ${errMsg}`, ExitCode.Error));
			}
		};

		const cleanup = () => {
			clearTimeout(timeout);
			client.removeListener("action", onAction);
		};

		client.on("action", onAction);

		// Check if already ready from snapshot
		const sessionState = client.state.getSession(sessionUri);
		if (sessionState?.lifecycle === "ready") {
			cleanup();
			resolve();
		} else if (sessionState?.lifecycle === "creationFailed") {
			cleanup();
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
	.option("-S, --session <id>", "Target session by ID")
	.option("-f, --file <path>", "Read prompt from file (- for stdin)")
	.option("--cwd <dir>", "Working directory for auto-created sessions")
	.option("--approve-all", "Auto-approve all permissions")
	.option("--approve-reads", "Auto-approve read permissions, prompt for others")
	.option("--deny-all", "Auto-deny all permissions")
	.option("--idle-timeout <seconds>", "Cancel if no events received within N seconds")
	.option("--tag <key=value...>", "Add metadata tags to JSON events (repeatable)")
	.option("--forward-webhook <url...>", "POST events to webhook URL (repeatable)")
	.option("--forward-ws <url...>", "Stream events over WebSocket (repeatable)")
	.option("--forward-filter <types>", "Comma-separated event types to forward (default: all)")
	.option("--forward-headers <json>", "Custom headers for forwarders (JSON object)")
	.action(
		async (
			textParts: string[],
			opts: {
				server?: string;
				sessionName?: string;
				session?: string;
				file?: string;
				cwd?: string;
				approveAll?: boolean;
				approveReads?: boolean;
				denyAll?: boolean;
				idleTimeout?: string;
				tag?: string[];
				forwardWebhook?: string[];
				forwardWs?: string[];
				forwardFilter?: string;
				forwardHeaders?: string;
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
				await runPrompt(
					{
						text,
						...opts,
						tags: parseTags(opts.tag),
						idleTimeout: parseIdleTimeout(opts.idleTimeout),
						forwarders: buildForwarders(opts),
					},
					globalOpts,
				);
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
	.option("--cwd <dir>", "Working directory for the session")
	.option("-c, --config <key=value...>", "Session config values (repeatable, e.g. -c autoApprove=autopilot)")
	.option("--no-customizations", "Skip workspace customization discovery")
	.option("--approve-all", "Auto-approve all permissions")
	.option("--approve-reads", "Auto-approve read permissions, prompt for others")
	.option("--deny-all", "Auto-deny all permissions")
	.option("--idle-timeout <seconds>", "Cancel if no events received within N seconds")
	.option("--tag <key=value...>", "Add metadata tags to JSON events (repeatable)")
	.option("--forward-webhook <url...>", "POST events to webhook URL (repeatable)")
	.option("--forward-ws <url...>", "Stream events over WebSocket (repeatable)")
	.option("--forward-filter <types>", "Comma-separated event types to forward (default: all)")
	.option("--forward-headers <json>", "Custom headers for forwarders (JSON object)")
	.action(
		async (
			textParts: string[],
			opts: {
				server?: string;
				provider?: string;
				model?: string;
				cwd?: string;
				config?: string[];
				customizations: boolean;
				approveAll?: boolean;
				approveReads?: boolean;
				denyAll?: boolean;
				idleTimeout?: string;
				tag?: string[];
				forwardWebhook?: string[];
				forwardWs?: string[];
				forwardFilter?: string;
				forwardHeaders?: string;
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
				await runPrompt(
					{
						text,
						oneShot: true,
						...opts,
						sessionConfig: parseConfigFlags(opts.config),
						tags: parseTags(opts.tag),
						idleTimeout: parseIdleTimeout(opts.idleTimeout),
						forwarders: buildForwarders(opts),
					},
					globalOpts,
				);
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
	.option("-S, --session <id>", "Target session by ID")
	.option("-s, --server <name>", "Server name")
	.action(async (opts: { sessionName?: string; session?: string; server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			let record: SessionRecord;
			if (opts.session) {
				const found = await sessionStore.get(opts.session);
				if (!found) {
					throw new NoSessionError(`Session "${opts.session}" not found.`);
				}
				record = found;
			} else {
				const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
				const serverName = await resolveServerName(opts.server, cfg);
				const cwd = process.cwd();

				const resolved = await resolveSession({
					serverName,
					cwd,
					name: opts.sessionName,
					store: sessionStore,
				});

				if (!resolved) {
					if (globalOpts.format === "text") {
						console.log(pc.dim("No active session found. Nothing to cancel."));
					}
					return;
				}
				record = resolved;
			}

			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
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

// ── watch ────────────────────────────────────────────────────────────────────

program
	.command("watch")
	.description("Attach to a session as an observer and stream all activity")
	.argument("[id]", "Session ID")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-s, --server <name>", "Server name")
	.action(async (id: string | undefined, opts: { sessionName?: string; server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const record = await resolveSessionRecord(id, { name: opts.sessionName, server: opts.server });

			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });
			const formatter = formatterFromOpts(globalOpts);

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				const watcher = new SessionWatcher(client, record.sessionUri, formatter, {
					statusOut: process.stderr,
				});

				const onSigint = () => watcher.stop();
				process.on("SIGINT", onSigint);

				if (globalOpts.format === "text") {
					process.stderr.write(
						pc.dim(
							`[watch] Observing session ${pc.bold(record.id.slice(0, 8))}${record.name ? ` (${record.name})` : ""}...\n`,
						),
					);
					process.stderr.write(pc.dim("[watch] Press Ctrl+C to detach.\n"));
				}

				try {
					await watcher.watch();
				} finally {
					process.removeListener("SIGINT", onSigint);
				}
			});
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── browse ───────────────────────────────────────────────────────────────────

program
	.command("browse")
	.description("Browse server filesystem")
	.argument("[directory]", "Directory URI to browse (uses server default if omitted)")
	.option("-s, --server <name>", "Server name")
	.action(async (directory: string | undefined, opts: { server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				const result = await client.resourceList(directory ? ensureFileUri(directory) : "");

				outputResult(
					globalOpts,
					() => {
						if (result.entries.length === 0) {
							console.log(pc.dim("Directory is empty."));
							return;
						}

						// Sort: directories first, then files
						const sorted = [...result.entries].sort((a, b) => {
							if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
							return a.name.localeCompare(b.name);
						});

						for (const entry of sorted) {
							const icon = entry.type === "directory" ? pc.blue("📁") : "📄";
							const name = entry.type === "directory" ? pc.bold(entry.name) : entry.name;
							console.log(`  ${icon} ${name}`);
						}
					},
					result,
				);
			});
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── content ──────────────────────────────────────────────────────────────────

program
	.command("content")
	.description("Fetch content by URI from the server")
	.argument("<uri>", "Content reference URI")
	.option("-s, --server <name>", "Server name")
	.option("-o, --output <file>", "Write content to a file instead of stdout")
	.action(async (uri: string, opts: { server?: string; output?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				const result = await client.resourceRead(ensureFileUri(uri));

				const data =
					result.encoding === "base64" ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf-8");

				if (opts.output) {
					await fs.writeFile(opts.output, data);
					if (globalOpts.format === "text") {
						console.log(pc.green("✓"), `Wrote ${data.length} bytes to ${pc.bold(opts.output)}`);
					}
				} else if (globalOpts.format === "json") {
					console.log(
						JSON.stringify({
							uri,
							encoding: result.encoding,
							contentType: result.contentType,
							data: result.data,
							size: data.length,
						}),
					);
				} else {
					process.stdout.write(data);
				}
			});
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── model ────────────────────────────────────────────────────────────────────

program
	.command("model")
	.description("Switch the model for a session")
	.argument("<model-id>", "Model ID to switch to")
	.option("-n, --session-name <name>", "Session name (for scoped lookup)")
	.option("-S, --session <id>", "Target session by ID")
	.option("-s, --server <name>", "Server name")
	.action(async (modelId: string, opts: { sessionName?: string; session?: string; server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const record = await resolveSessionRecord(opts.session, { name: opts.sessionName, server: opts.server });

			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				await client.subscribe(record.sessionUri);

				client.dispatchAction({
					type: ActionType.SessionModelChanged,
					session: record.sessionUri,
					model: { id: modelId },
				});

				outputResult(globalOpts, () => console.log(pc.green("✓"), `Model change to ${pc.bold(modelId)} dispatched.`), {
					sessionUri: record.sessionUri,
					model: modelId,
				});
			});
		} catch (err) {
			handleError(err, globalOpts);
		}
	});

// ── agents ───────────────────────────────────────────────────────────────────

program
	.command("agents")
	.description("List available agents and models on the server")
	.option("-s, --server <name>", "Server name")
	.action(async (opts: { server?: string }, cmd: Command) => {
		const globalOpts = parseGlobalOpts(cmd);
		applyGlobalOpts(globalOpts);

		try {
			const cfg = await loadConfig({ overrides: buildConfigOverrides(globalOpts) });

			await withConnection({ server: opts.server, config: cfg }, async (client) => {
				const rootState = client.state.root;

				outputResult(
					globalOpts,
					() => {
						if (rootState.agents.length === 0) {
							console.log(pc.dim("No agents available on this server."));
							return;
						}

						for (const agent of rootState.agents) {
							console.log(pc.bold(pc.cyan(agent.provider)), pc.dim("—"), agent.displayName);
							if (agent.description) {
								console.log(`  ${pc.dim(agent.description)}`);
							}
							if (agent.models.length > 0) {
								console.log(`  ${pc.bold("Models:")}`);
								for (const m of agent.models) {
									console.log(`    ${pc.cyan(m.id)}${m.name ? ` — ${m.name}` : ""}`);
								}
							}
							console.log();
						}
					},
					rootState.agents.map((a) => ({
						provider: a.provider,
						displayName: a.displayName,
						description: a.description,
						models: a.models.map((m) => ({ id: m.id, name: m.name })),
					})),
				);
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
		} else if (args[i] === "--cwd") {
			flags.cwd = args[++i];
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
			"watch",
			"browse",
			"content",
			"model",
			"agents",
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
						cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
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
