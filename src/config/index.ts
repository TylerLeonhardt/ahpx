/**
 * Config System — Layered configuration with global + project + CLI overrides.
 *
 * Resolution order (later wins):
 *   1. ~/.ahpx/config.json     (global)
 *   2. <cwd>/.ahpxrc.json      (project)
 *   3. CLI flags                (runtime)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AhpxConfig {
	/** Name of the default connection profile */
	defaultServer?: string;
	/** Default agent provider (e.g., "copilot") */
	defaultProvider?: string;
	/** Default model */
	defaultModel?: string;
	/** Permission approval mode */
	permissions?: "approve-all" | "approve-reads" | "deny-all";
	/** Default request timeout in seconds */
	timeout?: number;
	/** Output format */
	format?: "text" | "json" | "quiet";
}

/** Keys that are valid in AhpxConfig, for filtering unknown properties. */
const CONFIG_KEYS: ReadonlySet<string> = new Set<string>([
	"defaultServer",
	"defaultProvider",
	"defaultModel",
	"permissions",
	"timeout",
	"format",
]);

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Readonly<AhpxConfig> = Object.freeze({
	permissions: "approve-reads",
	timeout: 30,
	format: "text",
});

// ── Paths ────────────────────────────────────────────────────────────────────

export function globalConfigDir(): string {
	return process.env.HOME ? path.join(process.env.HOME, ".ahpx") : path.join("~", ".ahpx");
}

export function globalConfigPath(): string {
	return path.join(globalConfigDir(), "config.json");
}

export function projectConfigPath(cwd?: string): string {
	return path.join(cwd ?? process.cwd(), ".ahpxrc.json");
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Read and parse a JSON config file. Returns undefined if the file doesn't exist. */
async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw err;
	}
}

/** Pick only known config keys from a raw object. */
function pickConfigKeys(raw: Record<string, unknown>): Partial<AhpxConfig> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(raw)) {
		if (CONFIG_KEYS.has(key)) {
			result[key] = raw[key];
		}
	}
	return result as Partial<AhpxConfig>;
}

/**
 * Load merged configuration.
 *
 * Resolution: defaults ← global ← project ← overrides
 */
export async function loadConfig(options?: {
	globalPath?: string;
	projectPath?: string;
	overrides?: Partial<AhpxConfig>;
}): Promise<AhpxConfig> {
	const gPath = options?.globalPath ?? globalConfigPath();
	const pPath = options?.projectPath ?? projectConfigPath();

	const globalRaw = await readJsonFile(gPath);
	const projectRaw = await readJsonFile(pPath);

	// Strip undefined values from overrides so they don't clobber
	const overrides: Partial<AhpxConfig> = {};
	if (options?.overrides) {
		for (const [k, v] of Object.entries(options.overrides)) {
			if (v !== undefined) {
				(overrides as Record<string, unknown>)[k] = v;
			}
		}
	}

	return {
		...DEFAULT_CONFIG,
		...(globalRaw ? pickConfigKeys(globalRaw) : {}),
		...(projectRaw ? pickConfigKeys(projectRaw) : {}),
		...overrides,
	};
}

/**
 * Initialize the global config file with defaults.
 * Returns true if created, false if already exists.
 */
export async function initGlobalConfig(configPath?: string): Promise<boolean> {
	const p = configPath ?? globalConfigPath();
	try {
		await fs.access(p);
		return false; // already exists
	} catch {
		// doesn't exist — create it
		await fs.mkdir(path.dirname(p), { recursive: true });
		await fs.writeFile(p, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`, "utf-8");
		return true;
	}
}

export { ConnectionStore, ConnectionValidationError, isValidWsUrl } from "./connections.js";
export type { ConnectionProfile } from "./connections.js";
