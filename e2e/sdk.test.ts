/**
 * E2E SDK tests against a live AHP server.
 *
 * These tests connect to a real insiders AHP server and verify the SDK
 * actually works end-to-end: sending prompts, steering mid-turn, and
 * observing session state in real-time.
 *
 * Prerequisites:
 *   - AHP server running at ws://127.0.0.1:8090
 *   - Tests are automatically skipped if the server is unreachable
 *
 * Run:
 *   npx vitest run e2e/sdk.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ActionType, AhpClient, PendingMessageKind, ToolCallConfirmationReason } from "../src/index.js";
import type { IActionEnvelope, SessionHandle } from "../src/index.js";

const SERVER_URL = "ws://127.0.0.1:8090";

// ── Server reachability check ─────────────────────────────────────────────

async function isServerReachable(): Promise<boolean> {
	try {
		const client = new AhpClient();
		await client.connect(SERVER_URL);
		await client.disconnect();
		return true;
	} catch {
		return false;
	}
}

const serverAvailable = await isServerReachable();

if (!serverAvailable) {
	console.log(`⏭  Skipping SDK e2e tests — server not reachable at ${SERVER_URL}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Auto-approve tool calls and result confirmations so turns can proceed
 * without manual intervention. In a real app, a UI or permission handler
 * would do this interactively.
 */
function autoApproveToolCalls(handle: SessionHandle): void {
	handle.on("action", (envelope: IActionEnvelope) => {
		const { action } = envelope;

		// Approve tool calls that need user confirmation
		if (action.type === ActionType.ChatToolCallReady && !action.confirmed) {
			handle.dispatchAction({
				type: ActionType.ChatToolCallConfirmed,
				turnId: action.turnId,
				toolCallId: action.toolCallId,
				approved: true,
				confirmed: ToolCallConfirmationReason.UserAction,
			});
		}

		// Approve tool results that need confirmation
		if (action.type === ActionType.ChatToolCallComplete && action.requiresResultConfirmation) {
			handle.dispatchAction({
				type: ActionType.ChatToolCallResultConfirmed,
				turnId: action.turnId,
				toolCallId: action.toolCallId,
				approved: true,
			});
		}
	});
}

/**
 * Wait for the first action of a specific type on a session handle.
 * Returns the action envelope when it fires.
 */
function waitForAction(handle: SessionHandle, actionType: ActionType, timeoutMs = 30_000): Promise<IActionEnvelope> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			handle.removeListener("action", onAction);
			reject(new Error(`Timed out waiting for ${actionType} after ${timeoutMs}ms`));
		}, timeoutMs);

		const onAction = (envelope: IActionEnvelope) => {
			if (envelope.action.type === actionType) {
				clearTimeout(timer);
				handle.removeListener("action", onAction);
				resolve(envelope);
			}
		};

		handle.on("action", onAction);
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.runIf(serverAvailable)("SDK E2E: Live AHP Server", () => {
	let client: AhpClient;
	let session: SessionHandle;

	beforeAll(async () => {
		client = new AhpClient();
		await client.connect(SERVER_URL);
	}, 15_000);

	afterEach(async () => {
		if (session && !session.disposed) {
			await session.dispose();
		}
	}, 30_000);

	afterAll(async () => {
		if (client?.connected) {
			await client.disconnect();
		}
	}, 15_000);

	// ── Test 1: Send a message ────────────────────────────────────────────

	it("sends a prompt and receives a complete response", async () => {
		session = await client.openSession({ provider: "copilot" });
		autoApproveToolCalls(session);

		const result = await session.sendPrompt('Respond with exactly: "hello world". Nothing else.', { timeout: 60_000 });

		expect(result.state).toBe("complete");
		expect(result.responseText).toBeTruthy();
		expect(result.responseText.length).toBeGreaterThan(0);
		expect(result.turnId).toBeTruthy();
	}, 90_000);

	// ── Test 2: Steering mid-turn ─────────────────────────────────────────

	it("sends a steering message while a turn is in progress", async () => {
		session = await client.openSession({ provider: "copilot" });
		autoApproveToolCalls(session);

		// Prepare the steering ID and observer BEFORE starting the turn to avoid
		// a race where the server echoes the action before we attach the listener.
		const steeringId = randomUUID();
		let steeringActionObserved = false;
		const steeringObserver = (envelope: IActionEnvelope) => {
			if (envelope.action.type === ActionType.ChatPendingMessageSet && envelope.action.id === steeringId) {
				steeringActionObserved = true;
			}
		};
		session.on("action", steeringObserver);

		// Start a prompt but DON'T await — keep the promise pending
		const turnPromise = session.sendPrompt("Write a short poem about cats. Take your time and be creative.", {
			timeout: 60_000,
		});

		// Wait until the first delta arrives, proving the turn is actively streaming
		await waitForAction(session, ActionType.ChatDelta, 30_000);
		session.dispatchAction({
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Steering,
			id: steeringId,
			userMessage: { text: "Actually, make it about dogs instead." },
		});

		// Wait for the turn to complete
		const result = await turnPromise;
		session.removeListener("action", steeringObserver);

		expect(result.state).toBe("complete");
		expect(result.responseText).toBeTruthy();

		// Verify steering was processed by the protocol: the server should echo the
		// PendingMessageSet action back, or the state snapshot should reflect it.
		// The server may consume it immediately, so we check both signals.
		const stateHadSteering = session.state?.steeringMessage?.id === steeringId;
		expect(steeringActionObserved || stateHadSteering).toBe(true);
	}, 90_000);

	// ── Test 3: Observe session state mid-stream ──────────────────────────

	it("observes session state and active turn while streaming", async () => {
		session = await client.openSession({ provider: "copilot" });
		autoApproveToolCalls(session);

		let observedActiveTurn = false;
		let _observedResponseParts = false;
		let capturedTurnId: string | undefined;
		let capturedLifecycle: string | undefined;

		// Set up an observer that checks state on every delta
		const observations: Array<{ hasActiveTurn: boolean; responsePartCount: number }> = [];

		const observer = (envelope: IActionEnvelope) => {
			if (envelope.action.type === ActionType.ChatDelta) {
				const state = session.state;
				const activeTurn = session.activeTurn;

				if (activeTurn) {
					observedActiveTurn = true;
					capturedTurnId = activeTurn.id;
					capturedLifecycle = state?.lifecycle;

					observations.push({
						hasActiveTurn: true,
						responsePartCount: activeTurn.responseParts?.length ?? 0,
					});

					if (activeTurn.responseParts && activeTurn.responseParts.length > 0) {
						_observedResponseParts = true;
					}
				}
			}
		};

		session.on("action", observer);

		// Send the prompt
		const result = await session.sendPrompt("Tell me a joke about programming. Make it detailed.", { timeout: 60_000 });

		session.removeListener("action", observer);

		// Verify the turn completed
		expect(result.state).toBe("complete");

		// Verify we could observe the session mid-stream
		expect(observedActiveTurn).toBe(true);
		expect(capturedTurnId).toBe(result.turnId);
		expect(capturedLifecycle).toBe("ready");

		// We should have seen multiple deltas streaming in
		expect(observations.length).toBeGreaterThan(0);

		// After turn completes, activeTurn should be cleared
		expect(session.activeTurn).toBeUndefined();

		// The completed turn should be in the turns array
		const finalState = session.state;
		expect(finalState?.turns.length).toBeGreaterThanOrEqual(1);
	}, 90_000);
});
