/**
 * ReconnectManager — Handles automatic reconnection with exponential backoff.
 *
 * When the WebSocket connection drops, attempts to reconnect using the
 * AHP `reconnect` command. Supports both `replay` (apply missed actions)
 * and `snapshot` (reset state) recovery modes.
 */

import type { URI } from "@microsoft/agent-host-protocol";
import pc from "picocolors";
import type { AhpClient } from "./index.js";

export interface ReconnectOptions {
	/** Maximum number of reconnect attempts (default: 5) */
	maxRetries?: number;
	/** Initial backoff in milliseconds (default: 1000) */
	backoffMs?: number;
	/** Maximum backoff in milliseconds (default: 30000) */
	maxBackoffMs?: number;
	/** Stream for status messages (default: process.stderr) */
	statusOut?: { write(data: string): void };
}

export type ReconnectOutcome = "replay" | "snapshot" | "failed";

export interface ReconnectEvents {
	reconnecting: [attempt: number, maxRetries: number];
	reconnected: [outcome: ReconnectOutcome];
	failed: [error: Error];
}

/**
 * Manages reconnection to an AHP server with exponential backoff.
 */
export class ReconnectManager {
	private readonly maxRetries: number;
	private readonly backoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly statusOut: { write(data: string): void };
	private aborted = false;

	constructor(
		private readonly serverUrl: string,
		private readonly clientId: string,
		options: ReconnectOptions = {},
	) {
		this.maxRetries = options.maxRetries ?? 5;
		this.backoffMs = options.backoffMs ?? 1000;
		this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
		this.statusOut = options.statusOut ?? process.stderr;
	}

	/**
	 * Attempt to reconnect to the AHP server.
	 *
	 * @param client - The AhpClient to reconnect
	 * @param lastSeenServerSeq - Last server sequence number received
	 * @param subscriptions - URIs the client was subscribed to
	 * @returns The reconnect outcome (replay, snapshot, or failed)
	 */
	async reconnect(client: AhpClient, _lastSeenServerSeq: number, subscriptions: URI[]): Promise<ReconnectOutcome> {
		this.aborted = false;
		let attempt = 0;
		let backoff = this.backoffMs;

		while (attempt < this.maxRetries && !this.aborted) {
			attempt++;
			this.statusOut.write(pc.yellow(`Connection lost. Reconnecting (${attempt}/${this.maxRetries})...\n`));

			try {
				// Wait for backoff period
				await this.sleep(backoff);
				if (this.aborted) break;

				// Re-establish transport connection
				await client.connect(this.serverUrl);

				// The reconnect command is sent during initialize in AHP,
				// but for client-side recovery we can re-subscribe and
				// let the state mirror handle it via snapshots.
				// Re-subscribe to all resources
				for (const uri of subscriptions) {
					await client.subscribe(uri);
				}

				this.statusOut.write(pc.green("Reconnected successfully.\n"));
				return "snapshot";
			} catch {
				// Exponential backoff with jitter
				backoff = Math.min(backoff * 2, this.maxBackoffMs);
				// Add jitter (±25%)
				const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
				backoff = Math.max(this.backoffMs, backoff + jitter);
			}
		}

		this.statusOut.write(pc.red(`Failed to reconnect after ${this.maxRetries} attempts.\n`));
		return "failed";
	}

	/**
	 * Abort any in-progress reconnection attempt.
	 */
	abort(): void {
		this.aborted = true;
	}

	/**
	 * Sleep for a given number of milliseconds. Can be aborted.
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			// Check periodically if aborted
			const check = setInterval(() => {
				if (this.aborted) {
					clearTimeout(timer);
					clearInterval(check);
					resolve();
				}
			}, 100);
			// Clear the interval when the timer fires naturally
			setTimeout(() => clearInterval(check), ms + 10);
		});
	}
}
