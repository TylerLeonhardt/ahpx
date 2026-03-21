/**
 * Session Store — Persists local session metadata as individual JSON files.
 *
 * Each session is stored as `~/.ahpx/sessions/<id>.json`, using atomic
 * writes (temp file + rename) to prevent corruption.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

/** Maximum number of turns kept per local session record. */
const MAX_LOCAL_TURNS = 100;

/** Maximum character length for user message and response previews. */
const PREVIEW_MAX_LEN = 200;

/** Lightweight summary of a single turn, stored locally for offline history. */
export interface TurnSummary {
	/** Turn identifier (UUID from the AHP action). */
	turnId: string;
	/** First 200 characters of the user's message. */
	userMessage: string;
	/** First 200 characters of the agent's response. */
	responsePreview: string;
	/** Number of tool calls made during this turn. */
	toolCallCount: number;
	/** Token usage, if reported by the server. */
	tokenUsage?: { input: number; output: number; model?: string };
	/** Final state of the turn. */
	state: "complete" | "cancelled" | "error";
	/** ISO 8601 timestamp when the turn completed. */
	timestamp: string;
}

export interface SessionRecord {
	/** Unique identifier (UUID) */
	id: string;
	/** AHP session URI (e.g. "copilot:/<uuid>") */
	sessionUri: string;
	/** Name of the saved connection this session belongs to */
	serverName: string;
	/** WebSocket URL (preserved in case the connection profile is removed) */
	serverUrl: string;
	/** Agent provider (e.g. "copilot") */
	provider: string;
	/** Model used for this session */
	model?: string;
	/** User-given name for named sessions */
	name?: string;
	/** Working directory when the session was created */
	workingDirectory?: string;
	/** Nearest git root directory (for directory-walk scoping) */
	gitRoot?: string;
	/** Server-generated session title */
	title?: string;
	/** Session lifecycle status */
	status: "active" | "closed";
	/** ISO 8601 timestamp of creation */
	createdAt: string;
	/** ISO 8601 timestamp when session was closed */
	closedAt?: string;
	/** ISO 8601 timestamp of the last prompt sent */
	lastPromptAt?: string;
	/** Local turn history (lightweight summaries, capped at MAX_LOCAL_TURNS). */
	turns?: TurnSummary[];
}

export interface SessionFilter {
	/** Filter by status */
	status?: "active" | "closed";
	/** Filter by server name */
	serverName?: string;
	/** Filter by working directory (exact match) */
	workingDirectory?: string;
	/** Filter by user-given session name */
	name?: string;
}

// ── Store ────────────────────────────────────────────────────────────────────

/** Truncate a string to the preview limit, appending ellipsis if needed. */
export function truncatePreview(str: string, maxLen = PREVIEW_MAX_LEN): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/** Build a TurnSummary from a completed turn result. */
export function buildTurnSummary(result: {
	turnId: string;
	responseText: string;
	toolCalls: number;
	usage?: { inputTokens: number; outputTokens: number; model?: string };
	state: "complete" | "cancelled" | "error";
	userMessage: string;
}): TurnSummary {
	return {
		turnId: result.turnId,
		userMessage: truncatePreview(result.userMessage),
		responsePreview: truncatePreview(result.responseText || "(no response)"),
		toolCallCount: result.toolCalls,
		tokenUsage: result.usage
			? { input: result.usage.inputTokens, output: result.usage.outputTokens, model: result.usage.model }
			: undefined,
		state: result.state,
		timestamp: new Date().toISOString(),
	};
}

export class SessionStore {
	private readonly sessionsDir: string;

	constructor(configDir?: string) {
		const dir = configDir ?? path.join(process.env.HOME ?? "~", ".ahpx");
		this.sessionsDir = path.join(dir, "sessions");
	}

	/** Ensure the sessions directory exists. */
	private async ensureDir(): Promise<void> {
		await fs.mkdir(this.sessionsDir, { recursive: true });
	}

	/** Path to a session record file. */
	private filePath(id: string): string {
		return path.join(this.sessionsDir, `${id}.json`);
	}

	/**
	 * Save a session record to disk. Creates a new file or overwrites an existing one.
	 * Uses atomic writes (temp file + rename).
	 */
	async save(record: SessionRecord): Promise<void> {
		await this.ensureDir();
		const tmp = path.join(this.sessionsDir, `.${record.id}.${randomUUID()}.tmp`);
		await fs.writeFile(tmp, `${JSON.stringify(record, null, "\t")}\n`, "utf-8");
		await fs.rename(tmp, this.filePath(record.id));
	}

	/** Get a session record by ID, or undefined if not found. */
	async get(id: string): Promise<SessionRecord | undefined> {
		try {
			const raw = await fs.readFile(this.filePath(id), "utf-8");
			return JSON.parse(raw) as SessionRecord;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw err;
		}
	}

	/**
	 * List session records, optionally filtered.
	 * Returns records sorted by createdAt descending (newest first).
	 */
	async list(filter?: SessionFilter): Promise<SessionRecord[]> {
		await this.ensureDir();

		let entries: string[];
		try {
			entries = await fs.readdir(this.sessionsDir);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw err;
		}

		const records: SessionRecord[] = [];

		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;

			try {
				const raw = await fs.readFile(path.join(this.sessionsDir, entry), "utf-8");
				const record = JSON.parse(raw) as SessionRecord;

				// Apply filters
				if (filter?.status && record.status !== filter.status) continue;
				if (filter?.serverName && record.serverName !== filter.serverName) continue;
				if (filter?.workingDirectory && record.workingDirectory !== filter.workingDirectory) continue;
				if (filter?.name && record.name !== filter.name) continue;

				records.push(record);
			} catch {
				// Skip corrupt files
			}
		}

		// Sort by createdAt descending (newest first)
		records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return records;
	}

	/**
	 * Update specific fields on an existing session record.
	 * Returns the updated record, or undefined if not found.
	 */
	async update(id: string, updates: Partial<Omit<SessionRecord, "id">>): Promise<SessionRecord | undefined> {
		const existing = await this.get(id);
		if (!existing) return undefined;

		const updated: SessionRecord = { ...existing, ...updates };
		await this.save(updated);
		return updated;
	}

	/**
	 * Soft-close a session: set status='closed' and record the timestamp.
	 * The record is preserved for history.
	 * Returns the updated record, or undefined if not found.
	 */
	async close(id: string): Promise<SessionRecord | undefined> {
		return this.update(id, {
			status: "closed",
			closedAt: new Date().toISOString(),
		});
	}

	/**
	 * Append a turn summary to a session record's local history.
	 * Caps the history at MAX_LOCAL_TURNS entries (oldest removed first).
	 * Returns the updated record, or undefined if not found.
	 */
	async appendTurn(id: string, turn: TurnSummary): Promise<SessionRecord | undefined> {
		const record = await this.get(id);
		if (!record) return undefined;

		const turns = record.turns ? [...record.turns] : [];
		turns.push(turn);
		// Trim oldest entries when over the cap
		while (turns.length > MAX_LOCAL_TURNS) {
			turns.shift();
		}
		return this.update(id, { turns });
	}

	/**
	 * Find a session by scope: matching serverName, workingDirectory, and optional name.
	 * Only returns active sessions.
	 */
	async getByScope(options: {
		serverName: string;
		workingDirectory: string;
		name?: string;
	}): Promise<SessionRecord | undefined> {
		const records = await this.list({
			status: "active",
			serverName: options.serverName,
			workingDirectory: options.workingDirectory,
			...(options.name ? { name: options.name } : {}),
		});

		// If a name is specified, find exact match; otherwise return the most recent
		if (options.name) {
			return records.find((r) => r.name === options.name);
		}

		return records[0]; // Already sorted by createdAt descending
	}
}
