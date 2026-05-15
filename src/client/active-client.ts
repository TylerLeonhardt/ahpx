/**
 * ActiveClientManager — Manages active client status for AHP sessions.
 *
 * AHP sessions have an "active client" concept — only one client at a time
 * provides tools to the session. This manager handles claiming/releasing
 * active status and registering tools.
 */

import { ActionType } from "../protocol/actions.js";
import type { SessionActiveClient, ToolDefinition, ToolResultContent, URI } from "../protocol/state.js";
import { ToolResultContentType } from "../protocol/state.js";
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
	 * Dispatches `session/activeClientChanged` with this client's info.
	 */
	async claimActiveClient(sessionUri: URI, displayName?: string, tools: ToolDefinition[] = []): Promise<void> {
		const activeClient: SessionActiveClient = {
			clientId: this.clientId,
			displayName,
			tools,
		};

		this.client.dispatchAction({
			type: ActionType.SessionActiveClientChanged,
			session: sessionUri,
			activeClient,
		});

		this.activeSessions.add(sessionUri);
	}

	/**
	 * Release active client status for a session.
	 * Dispatches `session/activeClientChanged` with `null`.
	 */
	async releaseActiveClient(sessionUri: URI): Promise<void> {
		this.client.dispatchAction({
			type: ActionType.SessionActiveClientChanged,
			session: sessionUri,
			activeClient: null,
		});

		this.activeSessions.delete(sessionUri);
	}

	/**
	 * Check if this client is the active client for a session.
	 * Uses the local state mirror for the check.
	 */
	isActiveClient(sessionUri: URI): boolean {
		const session = this.client.state.getSession(sessionUri);
		return session?.activeClient?.clientId === this.clientId;
	}

	/**
	 * Register (or update) the tools this client provides to a session.
	 * Dispatches `session/activeClientToolsChanged`.
	 * Only valid when this client is the active client.
	 */
	async registerTools(sessionUri: URI, tools: ToolDefinition[]): Promise<void> {
		this.client.dispatchAction({
			type: ActionType.SessionActiveClientToolsChanged,
			session: sessionUri,
			tools,
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
		this.client.dispatchAction({
			type: ActionType.SessionToolCallComplete,
			session: sessionUri,
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
