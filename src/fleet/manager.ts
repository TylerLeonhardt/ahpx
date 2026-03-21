/**
 * Fleet Manager — manages multiple AHP servers with health-aware routing.
 *
 * Provides server selection strategies (least-sessions, round-robin, random,
 * preferred) and filters by provider, model, or tag. Caches health data and
 * refreshes on demand.
 */

import type { ConnectionProfile } from "../config/connections.js";
import { HealthChecker, type ServerHealth } from "./health.js";

export type RoutingStrategy = "least-sessions" | "round-robin" | "random" | "preferred";

export interface FleetManagerOptions {
	connections: ConnectionProfile[];
	strategy?: RoutingStrategy;
	preferredServer?: string;
	/** Tag-to-server-name mapping, e.g. { gpu: ['cloud-1'], local: ['laptop'] } */
	tags?: Record<string, string[]>;
	healthCheckTimeout?: number;
}

export interface ServerRequirements {
	provider?: string;
	model?: string;
	tag?: string;
}

export class FleetManager {
	private readonly _connections: ConnectionProfile[];
	private readonly _strategy: RoutingStrategy;
	private readonly _preferredServer: string | undefined;
	private readonly _tags: Record<string, string[]>;
	private readonly _checker: HealthChecker;
	private _healthCache: ServerHealth[] = [];
	private _roundRobinIndex = 0;

	constructor(options: FleetManagerOptions) {
		this._connections = options.connections;
		this._strategy = options.strategy ?? "least-sessions";
		this._preferredServer = options.preferredServer;
		this._checker = new HealthChecker({ timeout: options.healthCheckTimeout });

		// Merge explicit tags with tags from ConnectionProfile
		const tags: Record<string, string[]> = {};
		if (options.tags) {
			for (const [tag, names] of Object.entries(options.tags)) {
				tags[tag] = [...names];
			}
		}
		for (const conn of options.connections) {
			if (conn.tags) {
				for (const tag of conn.tags) {
					if (!tags[tag]) {
						tags[tag] = [];
					}
					if (!tags[tag].includes(conn.name)) {
						tags[tag].push(conn.name);
					}
				}
			}
		}
		this._tags = tags;
	}

	/** Pick the best server for a dispatch based on strategy and requirements. */
	async selectServer(requirements?: ServerRequirements): Promise<{ name: string; url: string }> {
		if (this._healthCache.length === 0) {
			await this.refresh();
		}

		// Filter to healthy servers only
		let candidates = this._healthCache.filter((h) => h.status === "healthy");

		// Apply requirements filtering
		if (requirements?.provider) {
			const provider = requirements.provider;
			candidates = candidates.filter((h) => h.agents.some((a) => a.provider === provider));
		}
		if (requirements?.model) {
			const model = requirements.model;
			candidates = candidates.filter((h) => h.agents.some((a) => a.models.includes(model)));
		}
		if (requirements?.tag) {
			const tag = requirements.tag;
			const serversWithTag = this._tags[tag] ?? [];
			candidates = candidates.filter((h) => serversWithTag.includes(h.name));
		}

		if (candidates.length === 0) {
			throw new Error("No healthy server matches the requirements");
		}

		const selected = this._applyStrategy(candidates);
		return { name: selected.name, url: selected.url };
	}

	/** Get health for all servers (cached). */
	async getHealth(): Promise<ServerHealth[]> {
		if (this._healthCache.length === 0) {
			await this.refresh();
		}
		return [...this._healthCache];
	}

	/** Refresh health cache by checking all servers. */
	async refresh(): Promise<void> {
		this._healthCache = await this._checker.checkAll(this._connections);
	}

	private _applyStrategy(candidates: ServerHealth[]): ServerHealth {
		switch (this._strategy) {
			case "least-sessions":
				return this._leastSessions(candidates);

			case "round-robin": {
				const index = this._roundRobinIndex % candidates.length;
				this._roundRobinIndex = (this._roundRobinIndex + 1) % candidates.length;
				return candidates[index];
			}

			case "random":
				return candidates[Math.floor(Math.random() * candidates.length)];

			case "preferred": {
				if (this._preferredServer) {
					const preferred = candidates.find((h) => h.name === this._preferredServer);
					if (preferred) {
						return preferred;
					}
				}
				// Fallback to least-sessions
				return this._leastSessions(candidates);
			}
		}
	}

	private _leastSessions(candidates: ServerHealth[]): ServerHealth {
		let best = candidates[0];
		for (let i = 1; i < candidates.length; i++) {
			if (candidates[i].activeSessions < best.activeSessions) {
				best = candidates[i];
			}
		}
		return best;
	}
}
