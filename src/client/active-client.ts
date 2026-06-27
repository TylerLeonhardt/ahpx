/**
 * ActiveClientManager — Manages active client status for AHP sessions.
 *
 * AHP sessions have an "active client" concept — only one client at a time
 * provides tools to the session. This manager handles claiming/releasing
 * active status and registering tools.
 */

import { ActionType } from "@microsoft/agent-host-protocol";
import type { SessionActiveClient, ToolDefinition, ToolResultContent, URI } from "@microsoft/agent-host-protocol";
import { ToolResultContentType } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "./index.js";

/**
 * Manages active client status and tool registration for AHP sessions.
 */
export class ActiveClientManager {
	/** Sessions where this client is the active client. */
	private readonly activeSessions = new Set<URI>();

	constructor(
		private readonly client: AhpClient,
		private readonly clientId: string,
	) {}

	/**
	 * Claim active client status for a session.
	 * Dispatches `session/activeClientSet` with this client's info.
	 */
	async claimActiveClient(sessionUri: URI, displayName?: string, tools: ToolDefinition[] = []): Promise<void> {
		const activeClient: SessionActiveClient = {
			clientId: this.clientId,
			displayName,
			tools,
		};

		this.client.dispatchAction(sessionUri, {
			type: ActionType.SessionActiveClientSet,
			activeClient,
		});

		this.activeSessions.add(sessionUri);
	}

	/**
	 * Release active client status for a session.
	 * Dispatches `session/activeClientRemoved` with this client's id.
	 */
	async releaseActiveClient(sessionUri: URI): Promise<void> {
		this.client.dispatchAction(sessionUri, {
			type: ActionType.SessionActiveClientRemoved,
			clientId: this.clientId,
		});

		this.activeSessions.delete(sessionUri);
	}

	/**
	 * Check if this client is the active client for a session.
	 * Uses the local state mirror for the check.
	 */
	isActiveClient(sessionUri: URI): boolean {
		const session = this.client.state.getSession(sessionUri);
		return session?.activeClients?.some((c) => c.clientId === this.clientId) ?? false;
	}

	/**
	 * Register (or update) the tools this client provides to a session.
	 * Dispatches `session/activeClientSet` with the refreshed tool list.
	 * Only valid when this client is the active client.
	 */
	async registerTools(sessionUri: URI, tools: ToolDefinition[]): Promise<void> {
		const existing = this.client.state.getSession(sessionUri)?.activeClients?.find((c) => c.clientId === this.clientId);

		const activeClient: SessionActiveClient = {
			clientId: this.clientId,
			displayName: existing?.displayName,
			tools,
			customizations: existing?.customizations,
		};

		this.client.dispatchAction(sessionUri, {
			type: ActionType.SessionActiveClientSet,
			activeClient,
		});
	}

	/**
	 * Handle a tool call directed at this client.
	 * Dispatches `session/toolCallComplete` with the result.
	 */
	completeToolCall(
		sessionUri: URI,
		turnId: string,
		toolCallId: string,
		result: { success: boolean; pastTenseMessage: string; content?: Array<{ type: "text"; text: string }> },
	): void {
		this.client.dispatchAction(sessionUri, {
			type: ActionType.ChatToolCallComplete,
			turnId,
			toolCallId,
			result: {
				success: result.success,
				pastTenseMessage: result.pastTenseMessage,
				content: result.content?.map(
					(c): ToolResultContent => ({
						type: ToolResultContentType.Text,
						text: c.text,
					}),
				),
			},
		});
	}

	/**
	 * Get the set of sessions where this client is active.
	 */
	get sessions(): ReadonlySet<URI> {
		return this.activeSessions;
	}
}
