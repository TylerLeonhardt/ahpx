/**
 * Upfront AHP authentication.
 *
 * AHP 0.5.0 agents advertise the OAuth protected resources they require via
 * `AgentInfo.protectedResources` (RFC 9728). The protocol contract is explicit:
 * clients SHOULD obtain tokens from the declared `authorization_servers` and
 * push them via the `authenticate` command BEFORE creating sessions with the
 * agent. The `copilotcli` agent (the Copilot SDK running in a dedicated host
 * process) declares `https://api.github.com` with `required: true`; without a
 * pushed token the host rejects every turn with `agent_unauthorized` /
 * "Session was not created with authentication info or custom provider".
 *
 * This helper resolves a token for each declared resource using the full
 * {@link AuthHandler} chain — explicit/profile token, `AHPX_TOKEN`, GitHub env
 * vars, and crucially the `gh auth token` CLI fallback (so users authenticated
 * via the `gh` CLI, like the claude/codex agents already rely on, work without
 * setting an env var) — and pushes it via `authenticate`. Failures are
 * non-fatal: a server that requires no auth, or a missing token, simply leaves
 * the connection unauthenticated.
 */

import type { AhpClient } from "../client/index.js";
import { AuthHandler } from "./handler.js";

export interface AuthenticateUpfrontOptions {
	/** Explicit token (connection profile token or `--token`), highest precedence. */
	token?: string;
}

/**
 * Authenticate, before any session is created, for every protected resource the
 * connected agents declare. No-op when the server advertises no protected
 * resources.
 */
export async function authenticateUpfront(client: AhpClient, options: AuthenticateUpfrontOptions = {}): Promise<void> {
	const agents = client.state.root?.agents ?? [];
	const resources = agents.flatMap((a) => a.protectedResources ?? []);
	if (resources.length === 0) {
		return;
	}

	const handler = new AuthHandler(client, { token: options.token, interactive: false });
	await handler.authenticateResources(resources);
}
