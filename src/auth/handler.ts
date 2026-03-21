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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AhpClient } from "../client/index.js";
import { createLogger } from "../logger.js";
import type { IProtectedResourceMetadata } from "../protocol/state.js";

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
	 * Handle an authRequired notification — find a token and authenticate.
	 * Returns true if authentication succeeded, false otherwise.
	 */
	async handleAuthRequired(resource: IProtectedResourceMetadata): Promise<boolean> {
		const resourceUri = resource.resource;

		// 1. Check explicit token (--token flag)
		if (this.explicitToken) {
			return this.tryAuthenticate(resourceUri, this.explicitToken);
		}

		// 2. Check environment variable
		const envToken = process.env.AHPX_TOKEN;
		if (envToken) {
			return this.tryAuthenticate(resourceUri, envToken);
		}

		// 3. Check stored token
		const stored = await this.loadToken(resourceUri);
		if (stored) {
			const success = await this.tryAuthenticate(resourceUri, stored);
			if (success) return true;
			// Token expired or invalid — fall through to prompting
		}

		// 4. Interactive prompt (if available)
		if (this.interactive) {
			const token = await this.promptForToken(resource);
			if (token) {
				const success = await this.tryAuthenticate(resourceUri, token);
				if (success) {
					await this.storeToken(resourceUri, token);
				}
				return success;
			}
		}

		return false;
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
	private promptForToken(resource: IProtectedResourceMetadata): Promise<string | undefined> {
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
