import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockEventEmitter } = vi.hoisted(() => {
	const { EventEmitter: EE } = require("node:events");
	return { MockEventEmitter: EE };
});

// biome-ignore lint/suspicious/noExplicitAny: test mock state tracking
let mockInstances: any[] = [];
// biome-ignore lint/suspicious/noExplicitAny: test mock connect behavior
let mockConnectBehavior: (url: string) => Promise<any>;

vi.mock("../../client/index.js", () => {
	class MockAhpClient extends MockEventEmitter {
		private _connected = false;
		private _state = {
			root: {
				agents: [
					{
						provider: "copilot",
						displayName: "Copilot",
						description: "Copilot agent",
						models: [{ id: "gpt-4" }, { id: "gpt-3.5" }],
						protectedResources: [{ resource: "https://api.github.com" }],
					},
					{
						provider: "mock",
						displayName: "Mock",
						description: "Mock agent",
						models: [{ id: "mock-1" }],
					},
				],
				activeSessions: 2,
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock constructor options
		options: Record<string, any> = {};

		// biome-ignore lint/suspicious/noExplicitAny: mock constructor
		constructor(options?: Record<string, any>) {
			super();
			this.options = options ?? {};
			mockInstances.push(this);
		}

		get connected() {
			return this._connected;
		}

		get state() {
			return this._state;
		}

		async connect(url: string) {
			if (mockConnectBehavior) {
				return mockConnectBehavior(url);
			}
			this._connected = true;
			return {
				protocolVersion: 1,
				serverSeq: 0,
				snapshots: [],
			};
		}

		async disconnect() {
			this._connected = false;
		}

		// biome-ignore lint/suspicious/noExplicitAny: mock authenticate tracking
		authenticateCalls: any[] = [];

		async authenticate(resource: string, token: string) {
			this.authenticateCalls.push({ resource, token });
		}
	}

	return { AhpClient: MockAhpClient };
});

describe("HealthChecker", () => {
	beforeEach(() => {
		mockInstances = [];
		// biome-ignore lint/suspicious/noExplicitAny: reset mock state
		mockConnectBehavior = undefined as any;
	});

	describe("check", () => {
		it("returns healthy status for a reachable server", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:8080", "test-server");

			expect(result.status).toBe("healthy");
			expect(result.latencyMs).toBeGreaterThanOrEqual(0);
			expect(result.protocolVersion).toBe(1);
			expect(result.agents).toHaveLength(2);
			expect(result.activeSessions).toBe(2);
			expect(result.error).toBeUndefined();
			expect(result.name).toBe("test-server");
			expect(result.url).toBe("ws://localhost:8080");
		});

		it("captures agent and model information from root state", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:8080", "test-server");

			expect(result.agents).toEqual([
				{ provider: "copilot", models: ["gpt-4", "gpt-3.5"] },
				{ provider: "mock", models: ["mock-1"] },
			]);
		});

		it("measures latency in milliseconds", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:8080", "test-server");

			expect(typeof result.latencyMs).toBe("number");
			expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		});

		it("returns unreachable status on connection error", async () => {
			mockConnectBehavior = async () => {
				throw new Error("Connection refused");
			};

			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:9999", "dead-server");

			expect(result.status).toBe("unreachable");
			expect(result.error).toContain("Connection refused");
		});

		it("returns unreachable status on timeout", async () => {
			mockConnectBehavior = async () => {
				throw new Error("Connection timed out");
			};

			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:9999", "slow-server");

			expect(result.status).toBe("unreachable");
		});

		it("includes ISO 8601 checkedAt timestamp", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const result = await checker.check("ws://localhost:8080", "test-server");

			expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		it("disconnects even on error", async () => {
			mockConnectBehavior = async () => {
				throw new Error("fail");
			};

			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			await checker.check("ws://localhost:9999", "fail-server");

			expect(mockInstances).toHaveLength(1);
			expect(mockInstances[0].connected).toBe(false);
		});

		it("uses custom timeout when provided", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker({ timeout: 5000 });
			await checker.check("ws://localhost:8080", "test-server", { timeout: 3000 });

			expect(mockInstances).toHaveLength(1);
			expect(mockInstances[0].options.connectTimeout).toBe(3000);
		});

		it("passes headers through to the client (tunnel auth, #88)", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			await checker.check("wss://tunnel.example/", "tunnel-server", {
				headers: { "X-Tunnel-Authorization": "tunnel abc123" },
			});

			expect(mockInstances).toHaveLength(1);
			expect(mockInstances[0].options.headers).toEqual({ "X-Tunnel-Authorization": "tunnel abc123" });
		});

		it("authenticates when token is provided", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			await checker.check("ws://localhost:8080", "test-server", { token: "secret" });

			expect(mockInstances).toHaveLength(1);
			expect(mockInstances[0].authenticateCalls).toEqual([{ resource: "https://api.github.com", token: "secret" }]);
		});
	});

	describe("checkAll", () => {
		it("checks multiple servers concurrently", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const results = await checker.checkAll([
				{ name: "server-1", url: "ws://localhost:8081" },
				{ name: "server-2", url: "ws://localhost:8082" },
				{ name: "server-3", url: "ws://localhost:8083" },
			]);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.status === "healthy")).toBe(true);
		});

		it("returns results for all servers even if some fail", async () => {
			mockConnectBehavior = async (url: string) => {
				if (url === "ws://localhost:8082") {
					throw new Error("Connection refused");
				}
				return {
					protocolVersion: 1,
					serverSeq: 0,
					snapshots: [],
				};
			};

			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const results = await checker.checkAll([
				{ name: "server-1", url: "ws://localhost:8081" },
				{ name: "server-2", url: "ws://localhost:8082" },
				{ name: "server-3", url: "ws://localhost:8083" },
			]);

			expect(results).toHaveLength(3);
			const healthy = results.filter((r) => r.status === "healthy");
			const unreachable = results.filter((r) => r.status === "unreachable");
			expect(healthy).toHaveLength(2);
			expect(unreachable).toHaveLength(1);
			expect(unreachable[0].name).toBe("server-2");
		});

		it("returns empty array for empty input", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			const results = await checker.checkAll([]);

			expect(results).toEqual([]);
		});

		it("passes tokens through to individual checks", async () => {
			const { HealthChecker } = await import("../health.js");
			const checker = new HealthChecker();
			await checker.checkAll([
				{ name: "server-1", url: "ws://localhost:8081", token: "tok1" },
				{ name: "server-2", url: "ws://localhost:8082" },
			]);

			expect(mockInstances).toHaveLength(2);
			expect(mockInstances[0].authenticateCalls).toHaveLength(1);
			expect(mockInstances[1].authenticateCalls).toHaveLength(0);
		});
	});
});
