/**
 * Tunnel Discovery — Discovers AHP agent hosts running via Microsoft Dev Tunnels.
 *
 * Tunnels tagged with `protocolv5` are running AHP agent hosts.
 * Port 31546 is the standard AHP WebSocket endpoint.
 *
 * The dev-tunnels packages are lazily imported so they remain optional —
 * users who only connect locally don't need them installed.
 */

import { execSync } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("tunnel");

/** Default AHP port on dev tunnels. */
export const AHP_TUNNEL_PORT = 31546;

/** Label used to identify AHP agent host tunnels. */
export const AHP_TUNNEL_LABEL = "protocolv5";

/**
 * Lazily import the dev-tunnels management SDK.
 * Throws a user-friendly error if the packages aren't installed.
 */
async function loadTunnelSdk() {
	try {
		const management = await import("@microsoft/dev-tunnels-management");
		const contracts = await import("@microsoft/dev-tunnels-contracts");
		// TunnelAuthenticationSchemes is re-exported from the management package;
		// the contracts subpath import doesn't work under ESM.
		const { TunnelAuthenticationSchemes } = management;
		return { management, contracts, TunnelAuthenticationSchemes };
	} catch {
		throw new Error(
			"Dev tunnel packages are not installed. Run:\n" +
				"  npm install @microsoft/dev-tunnels-management @microsoft/dev-tunnels-connections @microsoft/dev-tunnels-contracts",
		);
	}
}

/**
 * Resolve a GitHub token for tunnel authentication.
 *
 * Checks (in order):
 *   1. GITHUB_TOKEN env var
 *   2. GH_TOKEN env var
 *   3. `gh auth token` CLI output
 */
export function resolveGitHubToken(): string {
	const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (fromEnv) return fromEnv;

	try {
		const result = execSync("gh auth token", {
			encoding: "utf-8",
			timeout: 5_000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (result) return result;
	} catch {
		// gh CLI not installed or not authenticated
	}

	throw new Error("No GitHub token found. Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.");
}

/** Tunnel info returned from discovery (subset of the full Tunnel contract). */
export interface TunnelInfo {
	tunnelId: string;
	clusterId: string;
	name?: string;
	description?: string;
	labels: string[];
	ports: Array<{ portNumber: number; name?: string }>;
	hostConnected: boolean;
	/** Web-forwarding URL for the AHP port (HTTPS), if available. */
	portUrl?: string;
	/** WSS URL derived from the web-forwarding URL. */
	wssUrl?: string;
	/** Tunnel access token for connecting. */
	accessToken?: string;
}

/**
 * List dev tunnels tagged with `protocolv5` (AHP agent hosts).
 */
export async function listAgentHostTunnels(githubToken: string): Promise<TunnelInfo[]> {
	const { management, contracts, TunnelAuthenticationSchemes } = await loadTunnelSdk();

	const client = new management.TunnelManagementHttpClient(
		{ name: "ahpx", version: "1.0" },
		management.ManagementApiVersions.Version20230927preview,
		async () => `${TunnelAuthenticationSchemes.github} ${githubToken}`,
	);

	const tunnels = await client.listTunnels(undefined, undefined, {
		labels: [AHP_TUNNEL_LABEL],
		includePorts: true,
		tokenScopes: ["connect"],
	});

	return tunnels.map((t) => tunnelToInfo(t, contracts));
}

/**
 * Look up a single tunnel by ID and return its connection info.
 */
export async function getTunnelById(githubToken: string, tunnelId: string, clusterId?: string): Promise<TunnelInfo> {
	const { management, contracts, TunnelAuthenticationSchemes } = await loadTunnelSdk();

	const client = new management.TunnelManagementHttpClient(
		{ name: "ahpx", version: "1.0" },
		management.ManagementApiVersions.Version20230927preview,
		async () => `${TunnelAuthenticationSchemes.github} ${githubToken}`,
	);

	const tunnel = await client.getTunnel(
		{ tunnelId, clusterId },
		{
			includePorts: true,
			tokenScopes: ["connect"],
		},
	);

	if (!tunnel) {
		throw new Error(`Tunnel "${tunnelId}" not found.`);
	}

	return tunnelToInfo(tunnel, contracts);
}

/**
 * Resolve a tunnel to a WSS URL suitable for the standard WebSocket transport.
 *
 * Uses the tunnel endpoint's web-forwarding URL for port 31546,
 * converting HTTPS → WSS.
 */
export async function resolveTunnelUrl(
	githubToken: string,
	tunnelId: string,
	clusterId?: string,
	port: number = AHP_TUNNEL_PORT,
): Promise<{ wssUrl: string; accessToken?: string }> {
	const info = await getTunnelById(githubToken, tunnelId, clusterId);

	if (info.wssUrl) {
		return { wssUrl: info.wssUrl, accessToken: info.accessToken };
	}

	// Fallback: construct URL from cluster + tunnel ID pattern
	const cluster = info.clusterId || clusterId;
	if (cluster) {
		const wssUrl = `wss://${info.tunnelId}-${port}.${cluster}.devtunnels.ms`;
		log.info("constructed fallback tunnel URL", { wssUrl });
		return { wssUrl, accessToken: info.accessToken };
	}

	throw new Error(
		`Could not resolve WebSocket URL for tunnel "${tunnelId}". No web-forwarding endpoint found and no cluster ID available.`,
	);
}

// biome-ignore lint/suspicious/noExplicitAny: contracts module type is dynamic
function tunnelToInfo(tunnel: any, contracts: any): TunnelInfo {
	const tunnelId = tunnel.tunnelId ?? "";
	const clusterId = tunnel.clusterId ?? "";

	// Try to find the web-forwarding URL for the AHP port
	let portUrl: string | undefined;
	if (tunnel.endpoints) {
		for (const ep of tunnel.endpoints) {
			const uri = contracts.TunnelEndpoint.getPortUri(ep, AHP_TUNNEL_PORT);
			if (uri) {
				portUrl = uri;
				break;
			}
		}
	}

	// Convert HTTPS URL → WSS URL
	let wssUrl: string | undefined;
	if (portUrl) {
		wssUrl = portUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
	}

	// Check host connectivity
	const hostConnected =
		typeof tunnel.status?.hostConnectionCount === "number"
			? tunnel.status.hostConnectionCount > 0
			: typeof tunnel.status?.hostConnectionCount === "object"
				? (tunnel.status.hostConnectionCount?.current ?? 0) > 0
				: false;

	return {
		tunnelId,
		clusterId,
		name: tunnel.name,
		description: tunnel.description,
		labels: tunnel.labels ?? [],
		ports: (tunnel.ports ?? []).map((p: { portNumber: number; name?: string }) => ({
			portNumber: p.portNumber,
			name: p.name,
		})),
		hostConnected,
		portUrl,
		wssUrl,
		accessToken: tunnel.accessTokens?.connect,
	};
}
