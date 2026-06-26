import { describe, expect, it } from "vitest";

/**
 * Integration guard for the official `@microsoft/agent-host-protocol` package.
 *
 * ahpx is migrating from its vendored `src/protocol/` copy of the AHP types to
 * the published package. This suite pins the package's public entrypoints and
 * verifies they resolve under ESM/Node, so the migration (and future version
 * bumps) has a stable, executable foundation. See the migration tracking PR for
 * the phased plan.
 */
describe("@microsoft/agent-host-protocol package", () => {
	it("exposes protocol version constants from the root entrypoint", async () => {
		const ahp = await import("@microsoft/agent-host-protocol");
		expect(typeof ahp.PROTOCOL_VERSION).toBe("string");
		expect(Array.isArray(ahp.SUPPORTED_PROTOCOL_VERSIONS)).toBe(true);
		// The published package targets the 0.3+ protocol line.
		expect(ahp.SUPPORTED_PROTOCOL_VERSIONS).toContain(ahp.PROTOCOL_VERSION);
		expect(ahp.PROTOCOL_VERSION.startsWith("0.")).toBe(true);
	});

	it("exposes the central action enum and reducers from the root entrypoint", async () => {
		const ahp = await import("@microsoft/agent-host-protocol");
		expect(ahp.ActionType.RootAgentsChanged).toBe("root/agentsChanged");
		expect(typeof ahp.rootReducer).toBe("function");
		expect(typeof ahp.sessionReducer).toBe("function");
		expect(typeof ahp.chatReducer).toBe("function");
		expect(typeof ahp.terminalReducer).toBe("function");
	});

	it("exposes the client surface from the /client entrypoint", async () => {
		const client = await import("@microsoft/agent-host-protocol/client");
		expect(typeof client.AhpClient).toBe("function");
		expect(typeof client.Subscription).toBe("function");
		expect(typeof client.AhpStateMirror).toBe("function");
		expect(typeof client.InMemoryTransport.pair).toBe("function");
		// Error taxonomy used by callers for `instanceof` checks.
		expect(typeof client.AhpClientError).toBe("function");
		expect(typeof client.RpcError).toBe("function");
		expect(typeof client.RpcTimeoutError).toBe("function");
		expect(typeof client.TransportError).toBe("function");
		expect(typeof client.ClientClosedError).toBe("function");
	});

	it("exposes the WebSocket transport from the /ws entrypoint", async () => {
		const ws = await import("@microsoft/agent-host-protocol/ws");
		expect(typeof ws.WebSocketTransport).toBe("function");
		expect(typeof ws.WebSocketTransport.connect).toBe("function");
		expect(typeof ws.WebSocketTransport.fromSocket).toBe("function");
	});

	it("exposes the multi-host surface from the /hosts entrypoint", async () => {
		const hosts = await import("@microsoft/agent-host-protocol/hosts");
		expect(typeof hosts.MultiHostClient).toBe("function");
		expect(typeof hosts.HostClientHandle).toBe("function");
		expect(typeof hosts.InMemoryClientIdStore).toBe("function");
		expect(typeof hosts.defaultReconnectPolicy).toBe("function");
	});

	it("drives an in-memory client through initialize against a hand-rolled server", async () => {
		const { AhpClient, InMemoryTransport } = await import("@microsoft/agent-host-protocol/client");
		const [clientTransport, serverTransport] = InMemoryTransport.pair();
		const client = new AhpClient(clientTransport);
		client.connect();

		// Minimal server: answer the first request (initialize) with an empty snapshot set.
		const serverLoop = (async () => {
			const frame = await serverTransport.recv();
			if (!frame || frame.kind !== "text") return;
			const req = JSON.parse(frame.text) as { id: number; method: string };
			expect(req.method).toBe("initialize");
			await serverTransport.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: req.id,
					result: { protocolVersion: "0.4.0", snapshots: [] },
				}),
			);
		})();

		const result = await client.initialize({
			clientId: "ahpx-smoke",
			protocolVersions: ["0.4.0"],
		});
		expect(result.protocolVersion).toBe("0.4.0");
		await serverLoop;
		await client.shutdown();
	});
});
