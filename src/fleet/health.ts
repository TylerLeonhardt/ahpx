/**
 * Server Health Checker — probes AHP servers for health status.
 *
 * Each health check connects, initializes, reads root state, and disconnects.
 * Stateless per-check — no long-lived connections.
 */

import type { InitializeResult } from "@microsoft/agent-host-protocol";
import { AhpClient } from "../client/index.js";

export interface ServerHealth {
	name: string;
	url: string;
	status: "healthy" | "degraded" | "unreachable";
	latencyMs: number;
	protocolVersion?: string;
	agents: { provider: string; models: string[] }[];
	activeSessions: number;
	checkedAt: string; // ISO 8601
	error?: string;
}

export class HealthChecker {
	private readonly _defaultTimeout: number;

	constructor(options?: { timeout?: number }) {
		this._defaultTimeout = options?.timeout ?? 10_000;
	}

	/** Check a single server's health. */
	async check(
		url: string,
		name: string,
		options?: { timeout?: number; token?: string; headers?: Record<string, string> },
	): Promise<ServerHealth> {
		const start = performance.now();
		const client = new AhpClient({
			connectTimeout: options?.timeout ?? this._defaultTimeout,
			...(options?.headers ? { headers: options.headers } : {}),
		});

		try {
			const result: InitializeResult = await client.connect(url);

			if (options?.token) {
				const agents = client.state.root?.agents ?? [];
				const resources = agents.flatMap((a) => a.protectedResources ?? []);
				for (const r of resources) {
					await client.authenticate(r.resource, options.token);
				}
			}

			const latencyMs = performance.now() - start;
			const root = client.state.root;

			return {
				name,
				url,
				status: "healthy",
				latencyMs,
				protocolVersion: result.protocolVersion,
				agents: root.agents.map((a) => ({
					provider: a.provider,
					models: a.models.map((m) => m.id),
				})),
				activeSessions: root.activeSessions ?? 0,
				checkedAt: new Date().toISOString(),
			};
		} catch (err) {
			const latencyMs = performance.now() - start;
			return {
				name,
				url,
				status: "unreachable",
				latencyMs,
				agents: [],
				activeSessions: 0,
				checkedAt: new Date().toISOString(),
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			try {
				await client.disconnect();
			} catch {
				// best-effort disconnect
			}
		}
	}

	/** Check all servers concurrently. */
	async checkAll(connections: Array<{ name: string; url: string; token?: string }>): Promise<ServerHealth[]> {
		return Promise.all(connections.map((c) => this.check(c.url, c.name, c.token ? { token: c.token } : undefined)));
	}
}
