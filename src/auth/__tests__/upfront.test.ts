import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AhpClient } from "../../client/index.js";
import { authenticateUpfront } from "../upfront.js";

/**
 * Regression coverage for the copilotcli "Session was not created with
 * authentication info or custom provider" failure: the updated VS Code agent
 * host advertises `copilotcli` with a `required: true` GitHub protected
 * resource and rejects every turn unless the client pushes a Bearer token via
 * `authenticate` BEFORE creating the session. ahpx must resolve a token from
 * the full chain (here a `gh`-style `GITHUB_TOKEN`, no explicit/profile token)
 * and push it. See the AHP 0.5.0 `AgentInfo.protectedResources` +
 * `authenticate` command contract.
 */

// Mirrors the protectedResources the live host advertises for every agent.
const COPILOT_RESOURCES = [
	{
		resource: "https://api.github.com",
		resource_name: "GitHub Copilot",
		authorization_servers: ["https://github.com/login/oauth"],
		scopes_supported: ["read:user", "user:email"],
		required: true,
	},
	{
		resource: "https://api.github.com/repos",
		resource_name: "GitHub Repository",
		authorization_servers: ["https://github.com/login/oauth"],
		scopes_supported: ["repo"],
		required: false,
	},
];

function createMockClient(agents: Array<Record<string, unknown>>) {
	const emitter = new EventEmitter();
	const authenticateCalls: Array<{ resource: string; token: string }> = [];

	const client = Object.assign(emitter, {
		state: { root: { agents } },
		authenticate: async (resource: string, token: string) => {
			authenticateCalls.push({ resource, token });
		},
		connected: true,
	}) as unknown as AhpClient;

	return { client, authenticateCalls };
}

describe("authenticateUpfront", () => {
	let origAhpx: string | undefined;
	let origGithub: string | undefined;
	let origGh: string | undefined;

	beforeEach(() => {
		origAhpx = process.env.AHPX_TOKEN;
		origGithub = process.env.GITHUB_TOKEN;
		origGh = process.env.GH_TOKEN;
		Reflect.deleteProperty(process.env, "AHPX_TOKEN");
		Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
		Reflect.deleteProperty(process.env, "GH_TOKEN");
	});

	afterEach(() => {
		if (origAhpx !== undefined) process.env.AHPX_TOKEN = origAhpx;
		else Reflect.deleteProperty(process.env, "AHPX_TOKEN");
		if (origGithub !== undefined) process.env.GITHUB_TOKEN = origGithub;
		else Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
		if (origGh !== undefined) process.env.GH_TOKEN = origGh;
		else Reflect.deleteProperty(process.env, "GH_TOKEN");
	});

	it("pushes a token for the copilotcli protected resources using gh-auth env (no profile token)", async () => {
		process.env.GITHUB_TOKEN = "gho_fake_gh_cli_token";
		const { client, authenticateCalls } = createMockClient([
			{ provider: "copilotcli", protectedResources: COPILOT_RESOURCES },
			{ provider: "claude", protectedResources: COPILOT_RESOURCES },
			{ provider: "codex", protectedResources: COPILOT_RESOURCES },
		]);

		await authenticateUpfront(client);

		// The shared resource is authenticated exactly once (deduplicated across
		// the three agents), plus the per-repo resource.
		expect(authenticateCalls).toEqual([
			{ resource: "https://api.github.com", token: "gho_fake_gh_cli_token" },
			{ resource: "https://api.github.com/repos", token: "gho_fake_gh_cli_token" },
		]);
	});

	it("prefers an explicit connection-profile token", async () => {
		process.env.GITHUB_TOKEN = "env-token";
		const { client, authenticateCalls } = createMockClient([
			{ provider: "copilotcli", protectedResources: COPILOT_RESOURCES },
		]);

		await authenticateUpfront(client, { token: "profile-token" });

		expect(authenticateCalls.every((c) => c.token === "profile-token")).toBe(true);
		expect(authenticateCalls).toHaveLength(2);
	});

	it("is a no-op when the server advertises no protected resources", async () => {
		process.env.GITHUB_TOKEN = "env-token";
		const { client, authenticateCalls } = createMockClient([{ provider: "claude" }]);

		await authenticateUpfront(client);

		expect(authenticateCalls).toHaveLength(0);
	});
});
