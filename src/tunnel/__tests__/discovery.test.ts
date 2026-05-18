import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AHP_TUNNEL_LABEL, AHP_TUNNEL_PORT, resolveGitHubToken } from "../discovery.js";

describe("constants", () => {
	it("AHP_TUNNEL_PORT is 31546", () => {
		expect(AHP_TUNNEL_PORT).toBe(31546);
	});

	it("AHP_TUNNEL_LABEL is protocolv5", () => {
		expect(AHP_TUNNEL_LABEL).toBe("protocolv5");
	});
});

describe("resolveGitHubToken", () => {
	const savedGithubToken = process.env.GITHUB_TOKEN;
	const savedGhToken = process.env.GH_TOKEN;

	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: env vars need delete, not undefined assignment
		delete process.env.GITHUB_TOKEN;
		// biome-ignore lint/performance/noDelete: env vars need delete, not undefined assignment
		delete process.env.GH_TOKEN;
	});

	afterEach(() => {
		process.env.GITHUB_TOKEN = savedGithubToken;
		process.env.GH_TOKEN = savedGhToken;
	});

	it("returns GITHUB_TOKEN when set", () => {
		process.env.GITHUB_TOKEN = "gh-token-123";
		expect(resolveGitHubToken()).toBe("gh-token-123");
	});

	it("returns GH_TOKEN when GITHUB_TOKEN not set", () => {
		process.env.GH_TOKEN = "gh-token-456";
		expect(resolveGitHubToken()).toBe("gh-token-456");
	});

	it("prefers GITHUB_TOKEN over GH_TOKEN", () => {
		process.env.GITHUB_TOKEN = "primary";
		process.env.GH_TOKEN = "secondary";
		expect(resolveGitHubToken()).toBe("primary");
	});
});
