/**
 * Tunnel module — Dev tunnel discovery and connection support.
 */

export {
	AHP_TUNNEL_PORT,
	AHP_TUNNEL_LABEL,
	listAgentHostTunnels,
	getTunnelById,
	resolveTunnelUrl,
	resolveGitHubToken,
	buildTunnelHeaders,
} from "./discovery.js";

export type { TunnelInfo } from "./discovery.js";
