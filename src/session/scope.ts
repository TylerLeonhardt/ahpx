/**
 * Session Scoping — Directory-walk session resolution.
 *
 * Walks from `cwd` up to the nearest git root (inclusive), looking for
 * active sessions that match the given server name and optional session name.
 * If no git root is found, falls back to exact cwd match only.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionRecord } from "./store.js";
import type { SessionStore } from "./store.js";

/**
 * Walk up from `from` looking for a `.git` directory.
 * Returns the directory containing `.git`, or undefined if none found.
 */
export async function findGitRoot(from: string): Promise<string | undefined> {
	let current = path.resolve(from);

	while (true) {
		try {
			await fs.access(path.join(current, ".git"));
			return current;
		} catch {
			// Not found at this level — go up
		}

		const parent = path.dirname(current);
		if (parent === current) {
			// Reached filesystem root
			return undefined;
		}
		current = parent;
	}
}

/**
 * Resolve a session by walking from `cwd` up to the git root.
 *
 * At each directory in the walk, checks for an active session matching
 * (serverName, directory, optionalName). Stops at the git root.
 * If no git root exists, matches only the exact cwd.
 */
export async function resolveSession(options: {
	serverName: string;
	cwd: string;
	name?: string;
	store: SessionStore;
}): Promise<SessionRecord | undefined> {
	const { serverName, cwd, name, store } = options;
	const resolvedCwd = path.resolve(cwd);

	const gitRoot = await findGitRoot(resolvedCwd);

	if (!gitRoot) {
		// No git root — match exact cwd only
		return store.getByScope({ serverName, workingDirectory: resolvedCwd, name });
	}

	// Walk from cwd up to gitRoot (inclusive)
	let current = resolvedCwd;
	while (true) {
		const match = await store.getByScope({ serverName, workingDirectory: current, name });
		if (match) return match;

		if (current === gitRoot) break;

		const parent = path.dirname(current);
		if (parent === current) break; // safety: filesystem root
		current = parent;
	}

	return undefined;
}
