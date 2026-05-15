/**
 * Connection Helper — Shared logic for commands that need to connect to an AHP server.
 *
 * Resolves the server from a flag, config default, or connection store,
 * then manages AhpClient lifecycle around a callback.
 */

import pc from "picocolors";
import { AuthHandler } from "../auth/index.js";
import { AhpClient } from "../client/index.js";
import type { AhpxConfig } from "../config/index.js";
import { ConnectionStore, isValidWsUrl } from "../config/index.js";
import { NotificationType } from "../protocol/notifications.js";
import type { AuthRequiredNotification } from "../protocol/notifications.js";

export interface WithConnectionOptions {
	/** Server name or WebSocket URL (from --server flag) */
	server?: string;
	/** Resolved ahpx config */
	config: AhpxConfig;
	/** Connection timeout in milliseconds */
	timeout?: number;
}

/**
 * Connect to an AHP server, run a callback, then disconnect cleanly.
 *
 * Resolution order for the server:
 *   1. If `server` is a ws:// or wss:// URL, use it directly
 *   2. If `server` is a name, look it up in the connection store
 *   3. If no `server`, use `config.defaultServer`
 *   4. If nothing resolves, throw with a helpful error message
 */
export async function withConnection(
	options: WithConnectionOptions,
	fn: (client: AhpClient, serverInfo: { name: string; url: string; token?: string }) => Promise<void>,
): Promise<void> {
	const store = new ConnectionStore();
	const { server, config, timeout } = options;

	let url: string;
	let token: string | undefined;
	let name: string;

	if (server && isValidWsUrl(server)) {
		// Direct URL
		url = server;
		name = server;
	} else if (server) {
		// Named connection
		const conn = await store.get(server);
		if (!conn) {
			throw new Error(`Unknown connection "${server}". Run ${pc.bold("ahpx server list")} to see saved connections.`);
		}
		url = conn.url;
		token = conn.token;
		name = conn.name;
	} else if (config.defaultServer) {
		// Config default
		const conn = await store.get(config.defaultServer);
		if (!conn) {
			throw new Error(
				`Default server "${config.defaultServer}" not found in connections. Run ${pc.bold("ahpx server list")} to check.`,
			);
		}
		url = conn.url;
		token = conn.token;
		name = conn.name;
	} else {
		// Try the connection store's default
		const def = await store.getDefault();
		if (!def) {
			throw new Error(
				`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
			);
		}
		url = def.url;
		token = def.token;
		name = def.name;
	}

	const client = new AhpClient({
		connectTimeout: timeout ?? (config.timeout ? config.timeout * 1000 : 10_000),
		initialSubscriptions: ["agenthost:/root"],
	});

	try {
		await client.connect(url);

		if (token) {
			await client.authenticate(url, token);
		}

		// Wire up auth handler for server-initiated auth challenges
		const authHandler = new AuthHandler(client, { token });
		const onNotification = (notification: { type: string; resource?: string }) => {
			if (notification.type === NotificationType.AuthRequired) {
				const authNotification = notification as AuthRequiredNotification;
				authHandler.handleAuthRequired({ resource: authNotification.resource }).catch(() => {
					// Auth failure during session is non-fatal — server will retry or error
				});
			}
		};
		client.on("notification", onNotification);

		try {
			await fn(client, { name, url, token });
		} finally {
			client.removeListener("notification", onNotification);
		}
	} finally {
		await client.disconnect();
	}
}
