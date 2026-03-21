import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../config/connections.js";
import type { ServerHealth } from "../health.js";

let mockCheckAllResult: ServerHealth[] = [];

vi.mock("../health.js", () => {
	class MockHealthChecker {
		async check(url: string, name: string): Promise<ServerHealth> {
			return (
				mockCheckAllResult.find((h) => h.url === url) ?? {
					name,
					url,
					status: "unreachable" as const,
					latencyMs: 0,
					agents: [],
					activeSessions: 0,
					checkedAt: new Date().toISOString(),
					error: "Not found in mock",
				}
			);
		}
		async checkAll(_connections: Array<{ name: string; url: string }>): Promise<ServerHealth[]> {
			return mockCheckAllResult;
		}
	}
	return { HealthChecker: MockHealthChecker };
});

const { FleetManager } = await import("../manager.js");

function makeHealth(overrides: Partial<ServerHealth> = {}): ServerHealth {
	return {
		name: "server",
		url: "ws://localhost:8082",
		status: "healthy",
		latencyMs: 10,
		agents: [{ provider: "copilot", models: ["gpt-4"] }],
		activeSessions: 0,
		checkedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeConnection(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
	return {
		name: "server",
		url: "ws://localhost:8082",
		...overrides,
	};
}

describe("FleetManager", () => {
	beforeEach(() => {
		mockCheckAllResult = [];
	});

	describe("selectServer", () => {
		describe("least-sessions strategy", () => {
			it("selects server with fewest active sessions", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						activeSessions: 5,
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						activeSessions: 2,
					}),
					makeHealth({
						name: "s3",
						url: "ws://s3",
						activeSessions: 8,
					}),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "least-sessions",
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s2", url: "ws://s2" });
			});

			it("breaks ties by selecting first server", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						activeSessions: 0,
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						activeSessions: 0,
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
					strategy: "least-sessions",
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});
		});

		describe("round-robin strategy", () => {
			it("cycles through healthy servers", async () => {
				mockCheckAllResult = [
					makeHealth({ name: "s1", url: "ws://s1" }),
					makeHealth({ name: "s2", url: "ws://s2" }),
					makeHealth({ name: "s3", url: "ws://s3" }),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "round-robin",
				});

				const results = [];
				for (let i = 0; i < 4; i++) {
					results.push(await fm.selectServer());
				}

				expect(results[0]).toEqual({ name: "s1", url: "ws://s1" });
				expect(results[1]).toEqual({ name: "s2", url: "ws://s2" });
				expect(results[2]).toEqual({ name: "s3", url: "ws://s3" });
				// Wraps around
				expect(results[3]).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("skips unhealthy servers", async () => {
				mockCheckAllResult = [
					makeHealth({ name: "s1", url: "ws://s1" }),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						status: "unreachable",
					}),
					makeHealth({ name: "s3", url: "ws://s3" }),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "round-robin",
				});

				const results = [];
				for (let i = 0; i < 3; i++) {
					results.push(await fm.selectServer());
				}

				// Only s1 and s3 are healthy, s2 is filtered out
				expect(results[0]).toEqual({ name: "s1", url: "ws://s1" });
				expect(results[1]).toEqual({ name: "s3", url: "ws://s3" });
				expect(results[2]).toEqual({ name: "s1", url: "ws://s1" });
			});
		});

		describe("random strategy", () => {
			it("selects a healthy server", async () => {
				mockCheckAllResult = [
					makeHealth({ name: "s1", url: "ws://s1" }),
					makeHealth({ name: "s2", url: "ws://s2" }),
					makeHealth({ name: "s3", url: "ws://s3" }),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "random",
				});

				const result = await fm.selectServer();
				const validNames = ["s1", "s2", "s3"];
				expect(validNames).toContain(result.name);
			});
		});

		describe("preferred strategy", () => {
			it("returns preferred server when healthy", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						activeSessions: 10,
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						activeSessions: 0,
					}),
					makeHealth({
						name: "s3",
						url: "ws://s3",
						activeSessions: 0,
					}),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "preferred",
					preferredServer: "s1",
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("falls back to least-sessions when preferred is unhealthy", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						status: "unreachable",
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						activeSessions: 5,
					}),
					makeHealth({
						name: "s3",
						url: "ws://s3",
						activeSessions: 1,
					}),
				];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1" }),
						makeConnection({ name: "s2", url: "ws://s2" }),
						makeConnection({ name: "s3", url: "ws://s3" }),
					],
					strategy: "preferred",
					preferredServer: "s1",
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s3", url: "ws://s3" });
			});

			it("falls back when preferred server not found in health", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						activeSessions: 3,
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						activeSessions: 1,
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
					strategy: "preferred",
					preferredServer: "nonexistent",
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s2", url: "ws://s2" });
			});
		});

		describe("filtering", () => {
			it("filters by provider", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						agents: [{ provider: "copilot", models: ["gpt-4"] }],
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						agents: [{ provider: "mock", models: ["mock-1"] }],
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
				});

				const result = await fm.selectServer({ provider: "copilot" });
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("filters by model", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						agents: [{ provider: "copilot", models: ["gpt-4"] }],
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						agents: [{ provider: "copilot", models: ["gpt-3.5"] }],
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
				});

				const result = await fm.selectServer({ model: "gpt-4" });
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("filters by tag from connection profile", async () => {
				mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1" }), makeHealth({ name: "s2", url: "ws://s2" })];

				const fm = new FleetManager({
					connections: [
						makeConnection({ name: "s1", url: "ws://s1", tags: ["gpu"] }),
						makeConnection({ name: "s2", url: "ws://s2" }),
					],
				});

				const result = await fm.selectServer({ tag: "gpu" });
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("filters by tag from options tags mapping", async () => {
				mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1" }), makeHealth({ name: "s2", url: "ws://s2" })];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
					tags: { fast: ["s1"] },
				});

				const result = await fm.selectServer({ tag: "fast" });
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("throws when no server matches requirements", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						agents: [{ provider: "mock", models: ["mock-1"] }],
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						agents: [{ provider: "mock", models: ["mock-1"] }],
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
				});

				await expect(fm.selectServer({ provider: "copilot" })).rejects.toThrow(
					"No healthy server matches the requirements",
				);
			});
		});

		describe("unhealthy server exclusion", () => {
			it("excludes unreachable servers", async () => {
				mockCheckAllResult = [
					makeHealth({ name: "s1", url: "ws://s1", status: "healthy" }),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						status: "unreachable",
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
				});

				const result = await fm.selectServer();
				expect(result).toEqual({ name: "s1", url: "ws://s1" });
			});

			it("throws when all servers are unhealthy", async () => {
				mockCheckAllResult = [
					makeHealth({
						name: "s1",
						url: "ws://s1",
						status: "unreachable",
					}),
					makeHealth({
						name: "s2",
						url: "ws://s2",
						status: "unreachable",
					}),
				];

				const fm = new FleetManager({
					connections: [makeConnection({ name: "s1", url: "ws://s1" }), makeConnection({ name: "s2", url: "ws://s2" })],
				});

				await expect(fm.selectServer()).rejects.toThrow("No healthy server matches the requirements");
			});
		});
	});

	describe("getHealth", () => {
		it("returns cached health data", async () => {
			mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1" })];

			const fm = new FleetManager({
				connections: [makeConnection({ name: "s1", url: "ws://s1" })],
			});

			await fm.refresh();
			const health = await fm.getHealth();
			expect(health).toHaveLength(1);
			expect(health[0].name).toBe("s1");
		});

		it("auto-refreshes on first call", async () => {
			mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1" })];

			const fm = new FleetManager({
				connections: [makeConnection({ name: "s1", url: "ws://s1" })],
			});

			// Don't call refresh first
			const health = await fm.getHealth();
			expect(health).toHaveLength(1);
			expect(health[0].name).toBe("s1");
		});

		it("returns a copy of the cache", async () => {
			mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1" })];

			const fm = new FleetManager({
				connections: [makeConnection({ name: "s1", url: "ws://s1" })],
			});

			const health1 = await fm.getHealth();
			health1.push(makeHealth({ name: "extra", url: "ws://extra" }));

			const health2 = await fm.getHealth();
			expect(health2).toHaveLength(1);
		});
	});

	describe("refresh", () => {
		it("updates health cache from all connections", async () => {
			mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1", activeSessions: 5 })];

			const fm = new FleetManager({
				connections: [makeConnection({ name: "s1", url: "ws://s1" })],
			});

			await fm.refresh();
			let health = await fm.getHealth();
			expect(health[0].activeSessions).toBe(5);

			// Update mock and refresh
			mockCheckAllResult = [makeHealth({ name: "s1", url: "ws://s1", activeSessions: 10 })];

			await fm.refresh();
			health = await fm.getHealth();
			expect(health[0].activeSessions).toBe(10);
		});
	});
});
