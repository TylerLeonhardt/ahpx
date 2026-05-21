/**
 * Mock AHP Server — Lightweight WebSocket server for integration testing.
 *
 * Speaks the AHP protocol over JSON-RPC 2.0, configurable per-test via
 * scenario callbacks. Each test starts its own server on a random port.
 *
 * @example
 * ```ts
 * const server = await createMockServer();
 * const client = new AhpClient();
 * await client.connect(server.url);
 * // ... test interactions
 * await client.disconnect();
 * await server.close();
 * ```
 */

import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// ── Protocol constants (mirroring src/protocol) ─────────────────────────

const PROTOCOL_VERSION = "0.1.0";

// ── Types ────────────────────────────────────────────────────────────────

/** JSON-RPC 2.0 request from client */
interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

/** JSON-RPC 2.0 notification from client (no id) */
interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

/** Action envelope sent from server to client */
interface ActionEnvelope {
	channel: string;
	action: Record<string, unknown>;
	serverSeq: number;
	origin?: { clientId: string; clientSeq: number };
	rejectionReason?: string;
}

/** Session state tracked by the mock */
interface MockSession {
	uri: string;
	provider: string;
	model?: { id: string };
	workingDirectory?: string;
	title: string;
	createdAt: number;
}

/** Per-test scenario configuration */
export interface MockServerScenario {
	/** Override initialize response */
	onInitialize?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Override createSession handling. Return actions to send after creation. */
	onCreateSession?: (params: Record<string, unknown>) => ActionEnvelope[] | undefined;
	/** Override subscribe handling */
	onSubscribe?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Handle dispatchAction notifications (e.g., react to turnStarted) */
	onDispatchAction?: (params: Record<string, unknown>, ctx: MockServerContext) => void;
	/** Override listSessions response */
	onListSessions?: () => Record<string, unknown>;
	/** Override resourceRead response */
	onResourceRead?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Override resourceList response */
	onResourceList?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Override fetchTurns response */
	onFetchTurns?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Override reconnect response */
	onReconnect?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Override disposeSession handling */
	onDisposeSession?: (params: Record<string, unknown>) => void;
	/** Agents available on this server */
	agents?: AgentConfig[];
	/** Delay before sending session/ready after createSession (ms) */
	sessionReadyDelay?: number;
}

export interface AgentConfig {
	provider: string;
	displayName: string;
	description?: string;
	models: Array<{
		id: string;
		provider: string;
		name: string;
		maxContextWindow?: number;
	}>;
}

/** Context object passed to scenario callbacks for sending actions */
export interface MockServerContext {
	/** Send an action envelope to the connected client */
	sendAction(action: Record<string, unknown>, origin?: { clientId: string; clientSeq: number }): void;
	/** Send a protocol notification to the connected client */
	sendNotification(notification: Record<string, unknown>): void;
	/** Get the current server sequence number */
	getSeq(): number;
	/** Get the connected client's ID */
	getClientId(): string | undefined;
	/** Get sessions tracked by the mock */
	getSessions(): Map<string, MockSession>;
}

/** The mock server instance returned by createMockServer */
export interface MockServer {
	/** WebSocket URL (ws://localhost:<port>) */
	url: string;
	/** Port the server is listening on */
	port: number;
	/** Gracefully close the server and all connections */
	close(): Promise<void>;
	/** The scenario (can be mutated between tests if needed) */
	scenario: MockServerScenario;
	/** Access the mock context for sending actions outside of callbacks */
	context: MockServerContext;
	/** Get the underlying WebSocket server */
	wss: WebSocketServer;
}

// ── Default agent configuration ──────────────────────────────────────────

const DEFAULT_AGENTS: AgentConfig[] = [
	{
		provider: "mock-agent",
		displayName: "Mock Agent",
		description: "A mock agent for integration testing",
		models: [
			{
				id: "mock-model",
				provider: "mock-agent",
				name: "Mock Model",
				maxContextWindow: 128000,
			},
		],
	},
];

// ── Server implementation ────────────────────────────────────────────────

export async function createMockServer(scenario: MockServerScenario = {}): Promise<MockServer> {
	const agents = scenario.agents ?? DEFAULT_AGENTS;
	const sessions = new Map<string, MockSession>();
	const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
	let serverSeq = 0;
	let activeWs: WebSocket | undefined;
	let clientId: string | undefined;

	const nextSeq = () => ++serverSeq;

	// Context for scenario callbacks
	const context: MockServerContext = {
		sendAction(action, origin) {
			if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
			// Derive channel from action's session/terminal field, or default to root
			const channel = (action.session ?? action.terminal ?? "ahp-root://") as string;
			// Remove session/terminal from action payload (channel-based model)
			const cleanAction = { ...action };
			delete cleanAction.session;
			delete cleanAction.terminal;
			const envelope: ActionEnvelope = {
				channel,
				action: cleanAction,
				serverSeq: nextSeq(),
				origin,
			};
			activeWs.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "action",
					params: envelope,
				}),
			);
		},
		sendNotification(notification) {
			if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
			activeWs.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "notification",
					params: { notification },
				}),
			);
		},
		getSeq: () => serverSeq,
		getClientId: () => clientId,
		getSessions: () => sessions,
	};

	// Create WebSocket server on random port
	const wss = new WebSocketServer({ port: 0 });

	await new Promise<void>((resolve) => {
		wss.on("listening", resolve);
	});

	const address = wss.address() as { port: number };

	wss.on("connection", (ws) => {
		activeWs = ws;

		ws.on("message", (raw) => {
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(raw.toString()) as JsonRpcMessage;
			} catch {
				return; // Ignore malformed messages
			}

			if ("id" in msg && msg.id !== undefined) {
				// JSON-RPC Request — needs a response
				handleRequest(ws, msg as JsonRpcRequest);
			} else {
				// JSON-RPC Notification — fire-and-forget
				handleNotification(msg as JsonRpcNotification);
			}
		});

		ws.on("close", () => {
			if (activeWs === ws) {
				activeWs = undefined;
			}
		});
	});

	function sendResponse(ws: WebSocket, id: number, result: unknown) {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	function sendError(ws: WebSocket, id: number, code: number, message: string, data?: unknown) {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code, message, ...(data !== undefined ? { data } : {}) },
			}),
		);
	}

	function makeRootSnapshot() {
		return {
			resource: "ahp-root://",
			fromSeq: serverSeq,
			state: {
				agents: agents.map((a) => ({
					provider: a.provider,
					displayName: a.displayName,
					description: a.description ?? "",
					models: a.models,
				})),
				activeSessions: sessions.size,
			},
		};
	}

	function makeSessionSnapshot(session: MockSession) {
		return {
			resource: session.uri,
			fromSeq: serverSeq,
			state: {
				summary: {
					resource: session.uri,
					provider: session.provider,
					title: session.title,
					status: "idle",
					createdAt: session.createdAt,
					modifiedAt: session.createdAt,
					model: session.model,
				},
				lifecycle: "ready",
				turns: [],
				activeTurn: undefined,
			},
		};
	}

	function handleRequest(ws: WebSocket, req: JsonRpcRequest) {
		const params = (req.params ?? {}) as Record<string, unknown>;

		try {
			handleRequestInner(ws, req, params);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendError(ws, req.id, -32603, message);
		}
	}

	function handleRequestInner(ws: WebSocket, req: JsonRpcRequest, params: Record<string, unknown>) {
		switch (req.method) {
			case "initialize": {
				clientId = params.clientId as string;

				if (scenario.onInitialize) {
					sendResponse(ws, req.id, scenario.onInitialize(params));
					return;
				}

				const initialSubs = (params.initialSubscriptions ?? []) as string[];
				const snapshots = initialSubs.map((uri) => {
					if (uri === "ahp-root://") return makeRootSnapshot();
					const session = sessions.get(uri);
					if (session) return makeSessionSnapshot(session);
					return { resource: uri, fromSeq: serverSeq, state: {} };
				});

				sendResponse(ws, req.id, {
					protocolVersion: PROTOCOL_VERSION,
					serverSeq,
					snapshots,
				});
				break;
			}

			case "createSession": {
				const sessionUri = params.session as string;
				const provider = (params.provider ?? agents[0]?.provider ?? "mock-agent") as string;
				const model = params.model as { id: string } | undefined;
				const workingDirectory = params.workingDirectory as string | undefined;

				if (sessions.has(sessionUri)) {
					sendError(ws, req.id, -32003, "Session already exists");
					return;
				}

				const session: MockSession = {
					uri: sessionUri,
					provider,
					model,
					workingDirectory,
					title: `Session ${sessions.size + 1}`,
					createdAt: Date.now(),
				};
				sessions.set(sessionUri, session);

				sendResponse(ws, req.id, null);

				// Optionally let scenario send custom actions after creation
				if (scenario.onCreateSession) {
					const actions = scenario.onCreateSession(params);
					if (actions) {
						for (const env of actions) {
							context.sendAction(env.action, env.origin);
						}
					}
				}

				// Send session/ready after a delay (default: immediate)
				const delay = scenario.sessionReadyDelay ?? 0;
				const timer = setTimeout(() => {
					pendingTimers.delete(timer);
					context.sendAction({
						type: "session/ready",
						session: sessionUri,
					});
				}, delay);
				pendingTimers.add(timer);
				break;
			}

			case "subscribe": {
				const channel = params.channel as string;

				if (scenario.onSubscribe) {
					sendResponse(ws, req.id, scenario.onSubscribe(params));
					return;
				}

				if (channel === "ahp-root://") {
					sendResponse(ws, req.id, { snapshot: makeRootSnapshot() });
					return;
				}

				const session = sessions.get(channel);
				if (session) {
					sendResponse(ws, req.id, {
						snapshot: makeSessionSnapshot(session),
					});
					return;
				}

				// Unknown channel — return empty snapshot
				sendResponse(ws, req.id, {
					snapshot: {
						resource: channel,
						fromSeq: serverSeq,
						state: {
							summary: {
								resource: channel,
								provider: "mock-agent",
								title: "Unknown Session",
								status: "idle",
								createdAt: Date.now(),
								modifiedAt: Date.now(),
							},
							lifecycle: "creating",
							turns: [],
						},
					},
				});
				break;
			}

			case "disposeSession": {
				const sessionUri = params.session as string;
				if (!sessions.has(sessionUri)) {
					sendError(ws, req.id, -32001, "Session not found");
					return;
				}
				sessions.delete(sessionUri);
				sendResponse(ws, req.id, null);
				if (scenario.onDisposeSession) {
					scenario.onDisposeSession(params);
				}
				break;
			}

			case "listSessions": {
				if (scenario.onListSessions) {
					sendResponse(ws, req.id, scenario.onListSessions());
					return;
				}

				const items = [...sessions.values()].map((s) => ({
					resource: s.uri,
					provider: s.provider,
					title: s.title,
					status: "idle",
					createdAt: s.createdAt,
					modifiedAt: s.createdAt,
					model: s.model,
				}));
				sendResponse(ws, req.id, { items });
				break;
			}

			case "fetchTurns": {
				if (scenario.onFetchTurns) {
					sendResponse(ws, req.id, scenario.onFetchTurns(params));
					return;
				}
				sendResponse(ws, req.id, { turns: [], hasMore: false });
				break;
			}

			case "resourceRead": {
				if (scenario.onResourceRead) {
					sendResponse(ws, req.id, scenario.onResourceRead(params));
					return;
				}
				sendResponse(ws, req.id, {
					data: "mock file content",
					encoding: "utf-8",
					contentType: "text/plain",
				});
				break;
			}

			case "resourceList": {
				if (scenario.onResourceList) {
					sendResponse(ws, req.id, scenario.onResourceList(params));
					return;
				}
				sendResponse(ws, req.id, {
					entries: [
						{ name: "src", type: "directory" },
						{ name: "package.json", type: "file" },
						{ name: "README.md", type: "file" },
					],
				});
				break;
			}

			case "reconnect": {
				if (scenario.onReconnect) {
					sendResponse(ws, req.id, scenario.onReconnect(params));
					return;
				}

				clientId = params.clientId as string;
				const subscriptions = (params.subscriptions ?? []) as string[];
				const snapshots = subscriptions.map((uri) => {
					if (uri === "ahp-root://") return makeRootSnapshot();
					const session = sessions.get(uri);
					if (session) return makeSessionSnapshot(session);
					return { resource: uri, fromSeq: serverSeq, state: {} };
				});

				sendResponse(ws, req.id, {
					type: "snapshot",
					snapshots,
				});
				break;
			}

			case "authenticate": {
				sendResponse(ws, req.id, {});
				break;
			}

			default: {
				sendError(ws, req.id, -32601, `Method not found: ${req.method}`);
			}
		}
	}

	function handleNotification(notification: JsonRpcNotification) {
		if (notification.method === "dispatchAction") {
			const params = (notification.params ?? {}) as Record<string, unknown>;
			const action = params.action as Record<string, unknown>;
			const clientSeqVal = params.clientSeq as number;
			const channel = params.channel as string;

			// Inject channel back into action as session/terminal for scenario handlers
			// (scenario handlers expect the old-style action with session/terminal)
			const actionForScenario = { ...action };
			if (channel && !actionForScenario.session && !actionForScenario.terminal) {
				if (typeof action.type === "string" && action.type.startsWith("terminal/")) {
					actionForScenario.terminal = channel;
				} else if (typeof action.type === "string" && action.type.startsWith("session/")) {
					actionForScenario.session = channel;
				}
			}

			// Echo the action back as an ActionEnvelope (server acknowledges)
			if (clientId) {
				context.sendAction(actionForScenario, {
					clientId,
					clientSeq: clientSeqVal,
				});
			}

			// Delegate to scenario
			if (scenario.onDispatchAction) {
				scenario.onDispatchAction({ ...params, action: actionForScenario }, context);
			}
		}
		// unsubscribe — no-op for mock
	}

	const server: MockServer = {
		url: `ws://127.0.0.1:${address.port}`,
		port: address.port,
		scenario,
		context,
		wss,
		async close() {
			// Clear pending timers
			for (const timer of pendingTimers) {
				clearTimeout(timer);
			}
			pendingTimers.clear();

			// Close all connections
			for (const client of wss.clients) {
				client.close();
			}

			await new Promise<void>((resolve, reject) => {
				wss.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		},
	};

	return server;
}

// ── Scenario helpers ─────────────────────────────────────────────────────

/** Create a simple echo scenario that streams back the user's message */
export function echoScenario(): MockServerScenario {
	return {
		onDispatchAction(params, ctx) {
			const action = params.action as Record<string, unknown>;
			if (action.type === "session/turnStarted") {
				const sessionUri = action.session as string;
				const turnId = action.turnId as string;
				const userMessage = action.userMessage as { text: string };

				// Send response part first
				ctx.sendAction({
					type: "session/responsePart",
					session: sessionUri,
					turnId,
					part: {
						kind: "markdown",
						id: "part-1",
						content: "",
					},
				});

				// Send delta chunks
				const chunks = userMessage.text.split(" ");
				for (const chunk of chunks) {
					ctx.sendAction({
						type: "session/delta",
						session: sessionUri,
						turnId,
						partId: "part-1",
						content: `${chunk} `,
					});
				}

				// Send usage
				ctx.sendAction({
					type: "session/usage",
					session: sessionUri,
					turnId,
					usage: {
						inputTokens: 10,
						outputTokens: chunks.length,
						model: "mock-model",
					},
				});

				// Complete the turn
				ctx.sendAction({
					type: "session/turnComplete",
					session: sessionUri,
					turnId,
				});
			}
		},
	};
}

/** Create a scenario with a tool call that needs confirmation */
export function toolCallScenario(options?: {
	confirmed?: string;
	toolClientId?: string;
	toolName?: string;
	sendResultAfterConfirm?: boolean;
}): MockServerScenario {
	const toolName = options?.toolName ?? "edit_file";
	const sendResult = options?.sendResultAfterConfirm ?? true;

	return {
		onDispatchAction(params, ctx) {
			const action = params.action as Record<string, unknown>;

			if (action.type === "session/turnStarted") {
				const sessionUri = action.session as string;
				const turnId = action.turnId as string;
				const toolCallId = randomUUID();

				// Tool call start
				ctx.sendAction({
					type: "session/toolCallStart",
					session: sessionUri,
					turnId,
					toolCallId,
					toolName,
					displayName: `Run ${toolName}`,
					...(options?.toolClientId ? { toolClientId: options.toolClientId } : {}),
				});

				// Response part for tool call
				ctx.sendAction({
					type: "session/responsePart",
					session: sessionUri,
					turnId,
					part: {
						kind: "toolCall",
						toolCall: {
							toolCallId,
							toolName,
							displayName: `Run ${toolName}`,
							status: "streaming",
							...(options?.toolClientId ? { toolClientId: options.toolClientId } : {}),
						},
					},
				});

				// Tool call ready
				ctx.sendAction({
					type: "session/toolCallReady",
					session: sessionUri,
					turnId,
					toolCallId,
					invocationMessage: `Execute ${toolName} on file.txt`,
					toolInput: '{"file": "file.txt"}',
					...(options?.confirmed ? { confirmed: options.confirmed } : {}),
				});
			}

			if (action.type === "session/toolCallConfirmed") {
				const sessionUri = action.session as string;
				const turnId = action.turnId as string;
				const toolCallId = action.toolCallId as string;
				const approved = action.approved as boolean;

				if (approved && sendResult) {
					// Send tool completion
					ctx.sendAction({
						type: "session/toolCallComplete",
						session: sessionUri,
						turnId,
						toolCallId,
						result: {
							success: true,
							output: "Tool executed successfully",
						},
					});

					// Send response text
					ctx.sendAction({
						type: "session/responsePart",
						session: sessionUri,
						turnId,
						part: {
							kind: "markdown",
							id: "part-1",
							content: "",
						},
					});

					ctx.sendAction({
						type: "session/delta",
						session: sessionUri,
						turnId,
						partId: "part-1",
						content: "Done! Tool executed.",
					});

					// Complete turn
					ctx.sendAction({
						type: "session/turnComplete",
						session: sessionUri,
						turnId,
					});
				} else if (!approved) {
					// Tool was denied — send response and complete
					ctx.sendAction({
						type: "session/responsePart",
						session: sessionUri,
						turnId,
						part: {
							kind: "markdown",
							id: "part-1",
							content: "",
						},
					});

					ctx.sendAction({
						type: "session/delta",
						session: sessionUri,
						turnId,
						partId: "part-1",
						content: "Tool call was denied.",
					});

					ctx.sendAction({
						type: "session/turnComplete",
						session: sessionUri,
						turnId,
					});
				}
			}
		},
	};
}
