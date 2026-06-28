/**
 * Connection Helper — Shared logic for commands that need to connect to an AHP server.
 *
 * Resolves the server from a flag, config default, or connection store,
 * then manages AhpClient lifecycle around a callback.
 */

import pc from "picocolors";
import { AuthHandler, authenticateUpfront } from "../auth/index.js";
import { AhpClient } from "../client/index.js";
import type { AhpxConfig } from "../config/index.js";
import { ConnectionStore, isValidWsUrl } from "../config/index.js";
import type { ConnectionProfile } from "../config/index.js";
import { NotificationType } from "../notifications.js";
import type { AuthRequiredNotification } from "../notifications.js";

export interface WithConnectionOptions {
	/** Server name or WebSocket URL (from --server flag) */
	server?: string;
	/** Resolved ahpx config */
	config: AhpxConfig;
	/** Connection timeout in milliseconds */
	timeout?: number;
}

/** Resolve a connection profile to a URL + token + headers, handling tunnel profiles. */
async function resolveProfileUrl(
	conn: ConnectionProfile,
): Promise<{ url: string; token?: string; headers?: Record<string, string> }> {
	if (conn.tunnelId) {
		const { resolveGitHubToken, resolveTunnelUrl, buildTunnelHeaders } = await import("../tunnel/index.js");
		const githubToken = resolveGitHubToken();
		const { wssUrl, accessToken } = await resolveTunnelUrl(githubToken, conn.tunnelId, conn.tunnelClusterId);
		return { url: wssUrl, token: undefined, headers: buildTunnelHeaders(accessToken) };
	}
	return { url: conn.url, token: conn.token };
}

/**
 * Connect to an AHP server, run a callback, then disconnect cleanly.
 *
 * Resolution order for the server:
 *   1. If `server` is a ws:// or wss:// URL, use it directly
 *   2. If `server` is a tunnel:// URL, resolve via dev tunnel SDK
 *   3. If `server` is a name, look it up in the connection store
 *   4. If no `server`, use `config.defaultServer`
 *   5. If nothing resolves, throw with a helpful error message
 */
export async function withConnection(
	options: WithConnectionOptions,
	fn: (client: AhpClient, serverInfo: { name: string; url: string; token?: string }) => Promise<void>,
): Promise<void> {
	const store = new ConnectionStore();
	const { server, config, timeout } = options;

	let url: string;
	let token: string | undefined;
	let headers: Record<string, string> | undefined;
	let name: string;

	if (server && isValidWsUrl(server)) {
		// Direct URL
		url = server;
		name = server;
	} else if (server?.startsWith("tunnel://")) {
		// tunnel:// URL — resolve dynamically
		const tunnelId = server.replace("tunnel://", "");
		const { resolveGitHubToken, resolveTunnelUrl, buildTunnelHeaders } = await import("../tunnel/index.js");
		const githubToken = resolveGitHubToken();
		const resolved = await resolveTunnelUrl(githubToken, tunnelId);
		url = resolved.wssUrl;
		headers = buildTunnelHeaders(resolved.accessToken);
		name = `tunnel:${tunnelId}`;
	} else if (server) {
		// Named connection
		const conn = await store.get(server);
		if (!conn) {
			throw new Error(`Unknown connection "${server}". Run ${pc.bold("ahpx server list")} to see saved connections.`);
		}
		const resolved = await resolveProfileUrl(conn);
		url = resolved.url;
		token = resolved.token;
		headers = resolved.headers;
		name = conn.name;
	} else if (config.defaultServer) {
		// Config default
		const conn = await store.get(config.defaultServer);
		if (!conn) {
			throw new Error(
				`Default server "${config.defaultServer}" not found in connections. Run ${pc.bold("ahpx server list")} to check.`,
			);
		}
		const resolved = await resolveProfileUrl(conn);
		url = resolved.url;
		token = resolved.token;
		headers = resolved.headers;
		name = conn.name;
	} else {
		// Try the connection store's default
		const def = await store.getDefault();
		if (!def) {
			throw new Error(
				`No server specified and no default is set.\nRun ${pc.bold("ahpx server add <name> --url <ws://...> --default")} to save one.`,
			);
		}
		const resolved = await resolveProfileUrl(def);
		url = resolved.url;
		token = resolved.token;
		headers = resolved.headers;
		name = def.name;
	}

	const client = new AhpClient({
		connectTimeout: timeout ?? (config.timeout ? config.timeout * 1000 : 10_000),
		initialSubscriptions: ["ahp-root://"],
	});

	try {
		await client.connect(url, { headers });

		// Upfront auth: authenticate for each protected resource declared by
		// agents BEFORE any session is created. AHP 0.5.0 agents such as
		// copilotcli (the Copilot SDK) require a pushed Bearer token or the host
		// rejects every turn with "Session was not created with authentication
		// info or custom provider". Token resolution uses the full chain
		// (explicit/profile token, env vars, and the `gh auth token` CLI
		// fallback) so `gh`-authenticated users work without setting an env var.
		await authenticateUpfront(client, { token });

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
