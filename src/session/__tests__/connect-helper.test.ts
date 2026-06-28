import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AhpxConfig } from "../../config/index.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockClient = {
	connect: vi.fn().mockResolvedValue({}),
	disconnect: vi.fn().mockResolvedValue(undefined),
	authenticate: vi.fn().mockResolvedValue(undefined),
	on: vi.fn(),
	removeListener: vi.fn(),
	state: {
		root: {
			agents: [
				{
					provider: "copilot",
					displayName: "Copilot",
					description: "Copilot agent",
					models: [],
					protectedResources: [{ resource: "https://api.github.com" }],
				},
			],
		},
	},
};

vi.mock("../../client/index.js", () => ({
	AhpClient: vi.fn().mockImplementation(() => mockClient),
}));

const mockStoreGet = vi.fn();
const mockStoreGetDefault = vi.fn();

vi.mock("../../config/index.js", async () => {
	const actual = await vi.importActual<typeof import("../../config/index.js")>("../../config/index.js");
	return {
		...actual,
		ConnectionStore: vi.fn().mockImplementation(() => ({
			get: mockStoreGet,
			getDefault: mockStoreGetDefault,
		})),
	};
});

vi.mock("../../auth/index.js", () => ({
	AuthHandler: vi.fn().mockImplementation(() => ({
		handleAuthRequired: vi.fn().mockResolvedValue(true),
	})),
	authenticateUpfront: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { authenticateUpfront } from "../../auth/index.js";
import { withConnection } from "../connect-helper.js";

const mockAuthenticateUpfront = vi.mocked(authenticateUpfront);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AhpxConfig> = {}): AhpxConfig {
	return { ...overrides };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("withConnection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockClient.connect.mockResolvedValue({});
		mockClient.disconnect.mockResolvedValue(undefined);
		mockClient.authenticate.mockResolvedValue(undefined);
	});

	// ── Server resolution ────────────────────────────────────────────────

	describe("server resolution", () => {
		it("uses a direct ws:// URL", async () => {
			const callback = vi.fn();
			await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, callback);

			expect(mockClient.connect).toHaveBeenCalledWith("ws://localhost:3000", { headers: undefined });
			expect(callback).toHaveBeenCalledWith(mockClient, {
				name: "ws://localhost:3000",
				url: "ws://localhost:3000",
				token: undefined,
			});
			expect(mockStoreGet).not.toHaveBeenCalled();
		});

		it("uses a direct wss:// URL", async () => {
			const callback = vi.fn();
			await withConnection({ server: "wss://prod.example.com/ahp", config: makeConfig() }, callback);

			expect(mockClient.connect).toHaveBeenCalledWith("wss://prod.example.com/ahp", { headers: undefined });
			expect(callback).toHaveBeenCalledWith(mockClient, {
				name: "wss://prod.example.com/ahp",
				url: "wss://prod.example.com/ahp",
				token: undefined,
			});
		});

		it("resolves a named connection from ConnectionStore", async () => {
			mockStoreGet.mockResolvedValue({ name: "dev", url: "ws://dev.local:4000", token: "dev-token" });
			const callback = vi.fn();

			await withConnection({ server: "dev", config: makeConfig() }, callback);

			expect(mockStoreGet).toHaveBeenCalledWith("dev");
			expect(mockClient.connect).toHaveBeenCalledWith("ws://dev.local:4000", { headers: undefined });
			expect(callback).toHaveBeenCalledWith(mockClient, {
				name: "dev",
				url: "ws://dev.local:4000",
				token: "dev-token",
			});
		});

		it("throws when a named connection is not found", async () => {
			mockStoreGet.mockResolvedValue(undefined);

			await expect(withConnection({ server: "ghost", config: makeConfig() }, vi.fn())).rejects.toThrow(
				/Unknown connection "ghost"/,
			);
		});

		it("uses config.defaultServer to look up a connection", async () => {
			mockStoreGet.mockResolvedValue({ name: "prod", url: "wss://prod.example.com", token: "prod-tok" });
			const callback = vi.fn();

			await withConnection({ config: makeConfig({ defaultServer: "prod" }) }, callback);

			expect(mockStoreGet).toHaveBeenCalledWith("prod");
			expect(mockClient.connect).toHaveBeenCalledWith("wss://prod.example.com", { headers: undefined });
			expect(callback).toHaveBeenCalledWith(mockClient, {
				name: "prod",
				url: "wss://prod.example.com",
				token: "prod-tok",
			});
		});

		it("throws when config.defaultServer is not found in the store", async () => {
			mockStoreGet.mockResolvedValue(undefined);

			await expect(withConnection({ config: makeConfig({ defaultServer: "missing" }) }, vi.fn())).rejects.toThrow(
				/Default server "missing" not found/,
			);
		});

		it("falls through to connection store default when no server specified", async () => {
			mockStoreGetDefault.mockResolvedValue({ name: "fallback", url: "ws://fallback:5000" });
			const callback = vi.fn();

			await withConnection({ config: makeConfig() }, callback);

			expect(mockStoreGetDefault).toHaveBeenCalled();
			expect(mockClient.connect).toHaveBeenCalledWith("ws://fallback:5000", { headers: undefined });
			expect(callback).toHaveBeenCalledWith(mockClient, {
				name: "fallback",
				url: "ws://fallback:5000",
				token: undefined,
			});
		});

		it("throws with helpful message when no server is available at all", async () => {
			mockStoreGetDefault.mockResolvedValue(undefined);

			await expect(withConnection({ config: makeConfig() }, vi.fn())).rejects.toThrow(
				/No server specified and no default is set/,
			);
		});

		it("error for no server suggests 'ahpx server add'", async () => {
			mockStoreGetDefault.mockResolvedValue(undefined);

			await expect(withConnection({ config: makeConfig() }, vi.fn())).rejects.toThrow(/ahpx server add/);
		});
	});

	// ── Lifecycle ────────────────────────────────────────────────────────

	describe("lifecycle", () => {
		it("callback receives client and server info", async () => {
			const callback = vi.fn();
			await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, callback);

			expect(callback).toHaveBeenCalledOnce();
			const [client, serverInfo] = callback.mock.calls[0];
			expect(client).toBe(mockClient);
			expect(serverInfo).toEqual({
				name: "ws://localhost:3000",
				url: "ws://localhost:3000",
				token: undefined,
			});
		});

		it("disconnects the client even if callback throws", async () => {
			const callback = vi.fn().mockRejectedValue(new Error("callback boom"));

			await expect(withConnection({ server: "ws://localhost:3000", config: makeConfig() }, callback)).rejects.toThrow(
				"callback boom",
			);

			expect(mockClient.disconnect).toHaveBeenCalledOnce();
		});

		it("disconnects the client on success", async () => {
			await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, vi.fn());

			expect(mockClient.disconnect).toHaveBeenCalledOnce();
		});

		it("delegates upfront auth with the connection profile token", async () => {
			mockStoreGet.mockResolvedValue({ name: "auth", url: "ws://auth.local", token: "my-secret" });

			await withConnection({ server: "auth", config: makeConfig() }, vi.fn());

			expect(mockAuthenticateUpfront).toHaveBeenCalledWith(mockClient, { token: "my-secret" });
		});

		it("delegates upfront auth with no token when none is configured", async () => {
			const origAhpx = process.env.AHPX_TOKEN;
			const origGh = process.env.GITHUB_TOKEN;
			const origGhToken = process.env.GH_TOKEN;
			Reflect.deleteProperty(process.env, "AHPX_TOKEN");
			Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
			Reflect.deleteProperty(process.env, "GH_TOKEN");

			try {
				await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, vi.fn());
				expect(mockAuthenticateUpfront).toHaveBeenCalledWith(mockClient, { token: undefined });
			} finally {
				if (origAhpx !== undefined) process.env.AHPX_TOKEN = origAhpx;
				if (origGh !== undefined) process.env.GITHUB_TOKEN = origGh;
				if (origGhToken !== undefined) process.env.GH_TOKEN = origGhToken;
			}
		});

		it("registers and removes notification listener around callback", async () => {
			await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, vi.fn());

			expect(mockClient.on).toHaveBeenCalledWith("notification", expect.any(Function));
			expect(mockClient.removeListener).toHaveBeenCalledWith("notification", expect.any(Function));

			// Same handler function for both
			const onHandler = mockClient.on.mock.calls[0][1];
			const removeHandler = mockClient.removeListener.mock.calls[0][1];
			expect(onHandler).toBe(removeHandler);
		});

		it("uses config.timeout (in seconds) converted to milliseconds", async () => {
			const { AhpClient } = await import("../../client/index.js");

			await withConnection({ server: "ws://localhost:3000", config: makeConfig({ timeout: 30 }) }, vi.fn());

			expect(AhpClient).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 30_000 }));
		});

		it("uses explicit timeout option over config.timeout", async () => {
			const { AhpClient } = await import("../../client/index.js");

			await withConnection(
				{ server: "ws://localhost:3000", config: makeConfig({ timeout: 30 }), timeout: 5000 },
				vi.fn(),
			);

			expect(AhpClient).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 5000 }));
		});

		it("defaults to 10s connect timeout", async () => {
			const { AhpClient } = await import("../../client/index.js");

			await withConnection({ server: "ws://localhost:3000", config: makeConfig() }, vi.fn());

			expect(AhpClient).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 10_000 }));
		});
	});
});
