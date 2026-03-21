/**
 * Connection Store — Manages named AHP server connection profiles.
 *
 * Profiles are stored in `~/.ahpx/connections.json` with atomic writes
 * (write to temp + rename) to prevent corruption.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("connections");

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConnectionProfile {
	/** Unique display name for this connection */
	name: string;
	/** WebSocket URL (ws:// or wss://) */
	url: string;
	/** Optional authentication token */
	token?: string;
	/** Whether this is the default connection */
	default?: boolean;
	/** Optional tags for server grouping (e.g., ['gpu', 'cloud']) */
	tags?: string[];
}

interface ConnectionsFile {
	connections: ConnectionProfile[];
}

// ── Validation ───────────────────────────────────────────────────────────────

export function isValidWsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "ws:" || parsed.protocol === "wss:";
	} catch {
		return false;
	}
}

export class ConnectionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionValidationError";
	}
}

// ── Store ────────────────────────────────────────────────────────────────────

export class ConnectionStore {
	private readonly filePath: string;

	constructor(configDir?: string) {
		const dir = configDir ?? path.join(os.homedir(), ".ahpx");
		this.filePath = path.join(dir, "connections.json");
	}

	/** Ensure the config directory exists. */
	private async ensureDir(): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
	}

	/** Read the connections file, returning an empty list if it doesn't exist. */
	private async read(): Promise<ConnectionsFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf-8");
			return JSON.parse(raw) as ConnectionsFile;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { connections: [] };
			}
			log.warn("corrupt connections file, using empty list", { error: String(err) });
			return { connections: [] };
		}
	}

	/** Atomic write: write to temp file then rename. */
	private async write(data: ConnectionsFile): Promise<void> {
		await this.ensureDir();
		const tmp = `${this.filePath}.${randomUUID()}.tmp`;
		await fs.writeFile(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600, encoding: "utf-8" });
		await fs.rename(tmp, this.filePath);
	}

	/** List all connection profiles. */
	async list(): Promise<ConnectionProfile[]> {
		const data = await this.read();
		return data.connections;
	}

	/** Get a connection by name, or undefined if not found. */
	async get(name: string): Promise<ConnectionProfile | undefined> {
		const data = await this.read();
		return data.connections.find((c) => c.name === name);
	}

	/** Get the default connection, or undefined if none is set. */
	async getDefault(): Promise<ConnectionProfile | undefined> {
		const data = await this.read();
		return data.connections.find((c) => c.default === true);
	}

	/** Add a new connection profile. Throws if name already exists or URL is invalid. */
	async add(profile: ConnectionProfile): Promise<void> {
		if (!isValidWsUrl(profile.url)) {
			throw new ConnectionValidationError(`Invalid WebSocket URL: ${profile.url} (must be ws:// or wss://)`);
		}

		const data = await this.read();

		if (data.connections.some((c) => c.name === profile.name)) {
			throw new ConnectionValidationError(`Connection "${profile.name}" already exists`);
		}

		// If this profile is the new default, clear existing default
		if (profile.default) {
			for (const c of data.connections) {
				c.default = false;
			}
		}

		data.connections.push({ ...profile });
		await this.write(data);
	}

	/** Remove a connection by name. Returns true if found and removed, false otherwise. */
	async remove(name: string): Promise<boolean> {
		const data = await this.read();
		const idx = data.connections.findIndex((c) => c.name === name);
		if (idx === -1) return false;

		data.connections.splice(idx, 1);
		await this.write(data);
		return true;
	}

	/** Set a connection as the default. Throws if name not found. */
	async setDefault(name: string): Promise<void> {
		const data = await this.read();
		const target = data.connections.find((c) => c.name === name);
		if (!target) {
			throw new ConnectionValidationError(`Connection "${name}" not found`);
		}

		for (const c of data.connections) {
			c.default = c.name === name;
		}
		await this.write(data);
	}
}
