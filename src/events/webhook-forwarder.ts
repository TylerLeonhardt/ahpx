/**
 * Webhook Forwarder — POST events to an HTTP endpoint.
 *
 * Batches events to reduce HTTP requests, retries with exponential backoff
 * on failure, supports event type filtering, and buffers events if the
 * endpoint is temporarily down. Flushes remaining events on `close()`.
 */

import { createLogger } from "../logger.js";
import type { AhpxEvent, EventForwarder } from "./forwarder.js";

const log = createLogger("webhook-forwarder");

export interface WebhookForwarderOptions {
	/** URL to POST events to. */
	url: string;
	/** Custom HTTP headers to include in requests. */
	headers?: Record<string, string>;
	/** Number of events to batch before sending (default: 10). */
	batchSize?: number;
	/** Max milliseconds to wait before flushing a partial batch (default: 1000). */
	batchIntervalMs?: number;
	/** Number of retry attempts on failure (default: 3). */
	retries?: number;
	/** Event types to forward. If empty/undefined, forwards all. */
	filter?: string[];
}

export class WebhookForwarder implements EventForwarder {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private readonly batchSize: number;
	private readonly batchIntervalMs: number;
	private readonly retries: number;
	private readonly filter: Set<string> | undefined;

	private batch: AhpxEvent[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private flushPromise: Promise<void> = Promise.resolve();

	constructor(options: WebhookForwarderOptions) {
		this.url = options.url;
		this.headers = options.headers ?? {};
		this.batchSize = options.batchSize ?? 10;
		this.batchIntervalMs = options.batchIntervalMs ?? 1000;
		this.retries = options.retries ?? 3;
		this.filter = options.filter && options.filter.length > 0 ? new Set(options.filter) : undefined;
	}

	async forward(event: AhpxEvent): Promise<void> {
		if (this.closed) return;
		if (this.filter && !this.filter.has(event.type)) return;

		this.batch.push(event);

		if (this.batch.length >= this.batchSize) {
			this.clearFlushTimer();
			// Chain flushes to avoid concurrent sends
			this.flushPromise = this.flushPromise.then(() => this.flush());
		} else if (this.flushTimer === undefined) {
			this.startFlushTimer();
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.clearFlushTimer();

		// Wait for any in-flight flush, then flush remaining
		await this.flushPromise;
		await this.flush();
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private startFlushTimer(): void {
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushPromise = this.flushPromise.then(() => this.flush());
		}, this.batchIntervalMs);
	}

	private clearFlushTimer(): void {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
	}

	private async flush(): Promise<void> {
		if (this.batch.length === 0) return;

		const events = this.batch;
		this.batch = [];

		await this.sendWithRetry(events);
	}

	private async sendWithRetry(events: AhpxEvent[]): Promise<void> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				await this.send(events);
				return;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < this.retries) {
					const delay = Math.min(1000 * 2 ** attempt, 10_000);
					log.info("retry", { attempt: attempt + 1, delay, error: lastError.message });
					await sleep(delay);
				}
			}
		}

		// All retries exhausted — log and drop (don't crash the session)
		log.info("send-failed", {
			url: this.url,
			events: events.length,
			error: lastError?.message ?? "Unknown error",
		});
	}

	private async send(events: AhpxEvent[]): Promise<void> {
		const body = events.map((e) => JSON.stringify(e)).join("\n");

		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-ndjson",
				...this.headers,
			},
			body,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
