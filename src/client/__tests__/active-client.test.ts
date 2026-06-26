import { EventEmitter } from "node:events";
import type { StateAction } from "@microsoft/agent-host-protocol";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { SessionActiveClient, SessionState, ToolDefinition } from "@microsoft/agent-host-protocol";
import { SessionLifecycle, SessionStatus } from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { ActiveClientManager } from "../active-client.js";

const SESSION_URI = "copilot:/test-session";
const CLIENT_ID = "test-client-123";

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		summary: {
			resource: SESSION_URI,
			provider: "copilot",
			title: "Test",
			status: SessionStatus.Idle,
			createdAt: 1000,
			modifiedAt: 1000,
		},
		lifecycle: SessionLifecycle.Ready,
		chats: [],
		...overrides,
	};
}

function createMockClient() {
	const emitter = new EventEmitter();
	const dispatched: StateAction[] = [];
	const dispatchedChannels: string[] = [];
	const sessionStates = new Map<string, SessionState>();

	const client = Object.assign(emitter, {
		dispatchAction(channel: string, action: StateAction) {
			dispatchedChannels.push(channel);
			dispatched.push(action);
		},
		state: {
			getSession(uri: string) {
				return sessionStates.get(uri);
			},
		},
	}) as unknown as AhpClient;

	return {
		client,
		dispatched,
		setSessionState(uri: string, state: SessionState) {
			sessionStates.set(uri, state);
		},
	};
}

describe("ActiveClientManager", () => {
	it("claims active client status", async () => {
		const { client, dispatched } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		await manager.claimActiveClient(SESSION_URI, "ahpx CLI");

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].type).toBe(ActionType.SessionActiveClientChanged);

		const action = dispatched[0] as { activeClient: SessionActiveClient };
		expect(action.activeClient.clientId).toBe(CLIENT_ID);
		expect(action.activeClient.displayName).toBe("ahpx CLI");
		expect(action.activeClient.tools).toEqual([]);
	});

	it("releases active client status", async () => {
		const { client, dispatched } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		await manager.claimActiveClient(SESSION_URI);
		await manager.releaseActiveClient(SESSION_URI);

		expect(dispatched).toHaveLength(2);

		const releaseAction = dispatched[1] as { activeClient: SessionActiveClient | null };
		expect(releaseAction.activeClient).toBeNull();
	});

	it("checks if this client is active using state mirror", () => {
		const { client, setSessionState } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		// Not active yet
		setSessionState(SESSION_URI, makeSessionState());
		expect(manager.isActiveClient(SESSION_URI)).toBe(false);

		// Set as active
		setSessionState(
			SESSION_URI,
			makeSessionState({
				activeClient: { clientId: CLIENT_ID, tools: [] },
			}),
		);
		expect(manager.isActiveClient(SESSION_URI)).toBe(true);

		// Different client is active
		setSessionState(
			SESSION_URI,
			makeSessionState({
				activeClient: { clientId: "other-client", tools: [] },
			}),
		);
		expect(manager.isActiveClient(SESSION_URI)).toBe(false);
	});

	it("registers tools for a session", async () => {
		const { client, dispatched } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		const tools: ToolDefinition[] = [
			{ name: "readFile", title: "Read File", description: "Read a file from disk" },
			{ name: "writeFile", title: "Write File", description: "Write a file to disk" },
		];

		await manager.registerTools(SESSION_URI, tools);

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].type).toBe(ActionType.SessionActiveClientToolsChanged);
		expect((dispatched[0] as { tools: ToolDefinition[] }).tools).toEqual(tools);
	});

	it("completes a tool call with result", () => {
		const { client, dispatched } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		manager.completeToolCall(SESSION_URI, "turn-1", "tc-1", {
			success: true,
			pastTenseMessage: "Read package.json",
			content: [{ type: "text", text: '{ "name": "ahpx" }' }],
		});

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].type).toBe(ActionType.ChatToolCallComplete);

		const action = dispatched[0] as { result: { success: boolean; pastTenseMessage: string } };
		expect(action.result.success).toBe(true);
		expect(action.result.pastTenseMessage).toBe("Read package.json");
	});

	it("tracks active sessions", async () => {
		const { client } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		expect(manager.sessions.size).toBe(0);

		await manager.claimActiveClient(SESSION_URI);
		expect(manager.sessions.has(SESSION_URI)).toBe(true);

		await manager.releaseActiveClient(SESSION_URI);
		expect(manager.sessions.has(SESSION_URI)).toBe(false);
	});

	it("claims with initial tools", async () => {
		const { client, dispatched } = createMockClient();
		const manager = new ActiveClientManager(client, CLIENT_ID);

		const tools: ToolDefinition[] = [{ name: "shell", title: "Shell", description: "Run shell commands" }];

		await manager.claimActiveClient(SESSION_URI, "ahpx CLI", tools);

		const action = dispatched[0] as { activeClient: SessionActiveClient };
		expect(action.activeClient.tools).toEqual(tools);
	});
});
