/**
 * AuthHandler — Handles AHP authentication flow.
 *
 * When a server sends an `authRequired` notification, the handler:
 *   1. Checks for a stored token (from ~/.ahpx/auth.json)
 *   2. Checks environment variable (AHPX_TOKEN)
 *   3. Uses a CLI-provided token (--token flag)
 *   4. Prompts the user interactively (if TTY available)
 *   5. Stores successful tokens for future use
 *
 * Tokens are stored with restrictive file permissions (0600).
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProtectedResourceMetadata } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "../client/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

/** Where auth tokens are stored. */
function authFilePath(configDir?: string): string {
	const dir = configDir ?? path.join(os.homedir(), ".ahpx");
	return path.join(dir, "auth.json");
}

/** Stored token data. */
interface TokenStore {
	[resourceUri: string]: {
		token: string;
		storedAt: string;
	};
}

export interface AuthHandlerOptions {
	/** Explicit token (from --token flag) */
	token?: string;
	/** Config directory override (for testing) */
	configDir?: string;
	/** Whether interactive prompting is allowed */
	interactive?: boolean;
}

/**
 * Handles AHP authentication: token storage, lookup, and delivery.
 */
export class AuthHandler {
	private readonly configDir: string;
	private readonly explicitToken: string | undefined;
	private readonly interactive: boolean;

	constructor(
		private readonly client: AhpClient,
		options: AuthHandlerOptions = {},
	) {
		this.configDir = options.configDir ?? path.join(os.homedir(), ".ahpx");
		this.explicitToken = options.token;
		this.interactive = options.interactive ?? !!process.stdin.isTTY;
	}

	/**
	 * Resolve a token for a protected resource without prompting.
	 *
	 * Resolution order (highest precedence first):
	 *   1. Explicit token (`--token` flag / connection profile)
	 *   2. `AHPX_TOKEN` environment variable
	 *   3. GitHub-specific sources (`GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`)
	 *      — only for the `https://api.github.com` resource
	 *   4. A previously stored token (`~/.ahpx/auth.json`)
	 *
	 * Returns `undefined` if no non-interactive source yields a token.
	 */
	async resolveToken(resourceUri: string): Promise<string | undefined> {
		if (this.explicitToken) {
			return this.explicitToken;
		}

		const envToken = process.env.AHPX_TOKEN;
		if (envToken) {
			return envToken;
		}

		const githubToken = this.resolveGitHubToken(resourceUri);
		if (githubToken) {
			return githubToken;
		}

		return this.loadToken(resourceUri);
	}

	/**
	 * Upfront authentication for a set of protected resources declared by the
	 * connected agents (see `AgentInfo.protectedResources`).
	 *
	 * AHP 0.5.0 agents such as `copilotcli` (the Copilot SDK agent) declare a
	 * `required: true` protected resource and the host rejects session turns
	 * that were not authenticated — the Copilot SDK fails with "Session was not
	 * created with authentication info or custom provider". Clients are expected
	 * to push a Bearer token via the `authenticate` command BEFORE creating
	 * sessions. This resolves a token for each distinct resource (including the
	 * `gh auth token` fallback) and pushes it. Failures are non-fatal: a missing
	 * or rejected token simply leaves the resource unauthenticated.
	 */
	async authenticateResources(resources: ProtectedResourceMetadata[]): Promise<void> {
		const seen = new Set<string>();
		for (const resource of resources) {
			if (seen.has(resource.resource)) {
				continue;
			}
			seen.add(resource.resource);
			const token = await this.resolveToken(resource.resource);
			if (token) {
				await this.tryAuthenticate(resource.resource, token);
			}
		}
	}

	/**
	 * Handle an authRequired notification — find a token and authenticate.
	 * Returns true if authentication succeeded, false otherwise.
	 */
	async handleAuthRequired(resource: ProtectedResourceMetadata): Promise<boolean> {
		const resourceUri = resource.resource;

		// 1-4. Non-interactive resolution (explicit → env → GitHub → stored).
		const token = await this.resolveToken(resourceUri);
		if (token) {
			const success = await this.tryAuthenticate(resourceUri, token);
			if (success) return true;
			// Token expired or invalid — fall through to prompting.
		}

		// 5. Interactive prompt (if available)
		if (this.interactive) {
			const entered = await this.promptForToken(resource);
			if (entered) {
				const success = await this.tryAuthenticate(resourceUri, entered);
				if (success) {
					await this.storeToken(resourceUri, entered);
				}
				return success;
			}
		}

		return false;
	}

	/**
	 * Resolve a GitHub token from environment variables or the `gh` CLI.
	 * Applies to the GitHub API protected resources (`https://api.github.com`
	 * and its sub-resources such as `https://api.github.com/repos`), which share
	 * the same authorization server.
	 */
	private resolveGitHubToken(resourceUri: string): string | undefined {
		if (resourceUri !== "https://api.github.com" && !resourceUri.startsWith("https://api.github.com/")) {
			return undefined;
		}

		const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
		if (fromEnv) {
			return fromEnv;
		}

		try {
			const result = execSync("gh auth token", {
				encoding: "utf-8",
				timeout: 5_000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			if (result) {
				return result;
			}
		} catch {
			// gh CLI not installed or not authenticated — fall through
		}

		return undefined;
	}

	/**
	 * Store a token for a resource in ~/.ahpx/auth.json.
	 * File is created with 0600 permissions.
	 */
	async storeToken(resourceUri: string, token: string): Promise<void> {
		const filePath = authFilePath(this.configDir);
		await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

		let store: TokenStore = {};
		try {
			const raw = await fs.readFile(filePath, "utf-8");
			store = JSON.parse(raw) as TokenStore;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("corrupt auth file, starting fresh", { error: String(err) });
			}
		}

		store[resourceUri] = {
			token,
			storedAt: new Date().toISOString(),
		};

		const tmp = `${filePath}.${randomUUID()}.tmp`;
		await fs.writeFile(tmp, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
		await fs.rename(tmp, filePath);

		// Ensure correct permissions even if file existed
		try {
			await fs.chmod(filePath, 0o600);
		} catch {
			// Best effort — chmod may fail on some platforms
		}
	}

	/**
	 * Load a stored token for a resource.
	 */
	async loadToken(resourceUri: string): Promise<string | undefined> {
		try {
			const raw = await fs.readFile(authFilePath(this.configDir), "utf-8");
			const store = JSON.parse(raw) as TokenStore;
			return store[resourceUri]?.token;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("skipping corrupt auth file", { error: String(err) });
			}
			return undefined;
		}
	}

	/**
	 * Try to authenticate with the server.
	 */
	private async tryAuthenticate(resource: string, token: string): Promise<boolean> {
		try {
			await this.client.authenticate(resource, token);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Prompt the user for a token interactively.
	 */
	private promptForToken(resource: ProtectedResourceMetadata): Promise<string | undefined> {
		const name = resource.resource_name ?? resource.resource;
		return new Promise<string | undefined>((resolve) => {
			const readline = require("node:readline") as typeof import("node:readline");
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stderr,
			});

			rl.question(`Token for ${name}: `, (answer: string) => {
				rl.close();
				const token = answer.trim();
				resolve(token || undefined);
			});

			rl.on("close", () => resolve(undefined));
		});
	}
}
