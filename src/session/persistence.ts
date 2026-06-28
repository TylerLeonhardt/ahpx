/**
 * Session Persistence — Bridge between local SessionStore and live AHP server.
 *
 * Handles resuming sessions from local records, saving turn summaries after
 * each prompt, and syncing local state with server-side session lists.
 */

import type { AhpClient } from "../client/index.js";
import { RpcError } from "../client/index.js";
import { createLogger } from "../logger.js";
import type { SessionRecord } from "./store.js";
import { type SessionStore, buildTurnSummary } from "./store.js";

const log = createLogger("persistence");

// ── Types ────────────────────────────────────────────────────────────────────

/** Outcome of attempting to resume a session on a server. */
export type ResumeOutcome = { status: "resumed" } | { status: "not_found" } | { status: "error"; message: string };

/** Result of syncing local records with a server. */
export interface SyncResult {
	/** Session URIs found on server but not in local store. */
	added: string[];
	/** Session IDs in local store whose sessions no longer exist on server. */
	removed: string[];
	/** Session IDs where title or status diverged. */
	updated: string[];
}

// AHP error code for session-not-found
const SESSION_NOT_FOUND = -32001;

// ── Persistence Manager ─────────────────────────────────────────────────────

export class SessionPersistence {
	constructor(private readonly store: SessionStore) {}

	/**
	 * Resume a locally-stored session on a connected server.
	 *
	 * Subscribes to the session URI and verifies it is still alive. Returns
	 * a ResumeOutcome indicating whether the session was found.
	 */
	async resume(record: SessionRecord, client: AhpClient): Promise<ResumeOutcome> {
		try {
			await client.subscribe(record.sessionUri);
			log.info("session resumed", { sessionUri: record.sessionUri });
			return { status: "resumed" };
		} catch (err: unknown) {
			if (err instanceof RpcError && err.code === SESSION_NOT_FOUND) {
				log.info("session not found on server", { sessionUri: record.sessionUri });
				return { status: "not_found" };
			}
			const message = err instanceof Error ? err.message : String(err);
			log.info("resume failed", { sessionUri: record.sessionUri, error: message });
			return { status: "error", message };
		}
	}

	/**
	 * Save a turn summary to the local session record after a prompt completes.
	 */
	async saveTurn(
		recordId: string,
		result: {
			turnId: string;
			responseText: string;
			toolCalls: number;
			usage?: { inputTokens: number; outputTokens: number; model?: string };
			state: "complete" | "cancelled" | "error";
			userMessage: string;
		},
	): Promise<SessionRecord | undefined> {
		const summary = buildTurnSummary(result);
		return this.store.appendTurn(recordId, summary);
	}

	/**
	 * Sync local session records for a server with the server's actual state.
	 *
	 * Compares locally-active records against the server's session list to
	 * find sessions that were added remotely, disposed remotely, or updated.
	 */
	async sync(client: AhpClient, serverName: string): Promise<SyncResult> {
		const result: SyncResult = { added: [], removed: [], updated: [] };

		// Fetch server sessions
		const serverSessions = await client.listSessions();
		const serverUris = new Set(serverSessions.items.map((s) => s.resource));
		const serverMap = new Map(serverSessions.items.map((s) => [s.resource, s]));

		// Fetch local active records for this server
		const localRecords = await this.store.list({ status: "active", serverName });
		const localUris = new Set(localRecords.map((r) => r.sessionUri));

		// Sessions on server but not locally tracked
		for (const uri of serverUris) {
			if (!localUris.has(uri)) {
				result.added.push(uri);
			}
		}

		// Sessions locally active but no longer on server
		for (const record of localRecords) {
			if (!serverUris.has(record.sessionUri)) {
				result.removed.push(record.id);
				await this.store.close(record.id);
				log.info("closed stale local record", { id: record.id, sessionUri: record.sessionUri });
			}
		}

		// Sessions that exist on both sides — check for divergence
		for (const record of localRecords) {
			const serverSession = serverMap.get(record.sessionUri);
			if (!serverSession) continue;

			let changed = false;
			const updates: Partial<SessionRecord> = {};

			if (serverSession.title && serverSession.title !== record.title) {
				updates.title = serverSession.title;
				changed = true;
			}

			if (changed) {
				await this.store.update(record.id, updates);
				result.updated.push(record.id);
			}
		}

		return result;
	}
}
