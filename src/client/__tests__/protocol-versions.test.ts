/**
 * Protocol version negotiation — what ahpx offers in `initialize`, how the
 * override works, and how an incompatible host is reported.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockServer, createMockServer } from "../../__tests__/helpers/mock-server.js";
import { UsageError } from "../../errors.js";
import { AhpClient } from "../index.js";
import { PROTOCOL_VERSIONS_ENV, parseProtocolVersionList, resolveProtocolVersions } from "../protocol-versions.js";

describe("resolveProtocolVersions", () => {
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env[PROTOCOL_VERSIONS_ENV];
		delete process.env[PROTOCOL_VERSIONS_ENV];
	});

	afterEach(() => {
		if (saved === undefined) delete process.env[PROTOCOL_VERSIONS_ENV];
		else process.env[PROTOCOL_VERSIONS_ENV] = saved;
	});

	it("defaults to every supported compatibility baseline", () => {
		expect(resolveProtocolVersions()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
		expect(resolveProtocolVersions()).toEqual(expect.arrayContaining(["1.0.0"]));
	});

	it("uses the env var when set", () => {
		process.env[PROTOCOL_VERSIONS_ENV] = " 0.10.0 , 1.0.0 ";
		expect(resolveProtocolVersions()).toEqual(["0.10.0", "1.0.0"]);
	});

	it("ignores a blank env var", () => {
		process.env[PROTOCOL_VERSIONS_ENV] = "  ";
		expect(resolveProtocolVersions()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
	});

	it("prefers the explicit option over the env var", () => {
		process.env[PROTOCOL_VERSIONS_ENV] = "0.10.0";
		expect(resolveProtocolVersions(["1.0.0"])).toEqual(["1.0.0"]);
	});

	it("rejects malformed and empty overrides", () => {
		expect(() => resolveProtocolVersions(["v1"])).toThrow(UsageError);
		expect(() => resolveProtocolVersions(["0.10"])).toThrow(/0\.10/);
		expect(() => resolveProtocolVersions([])).toThrow(UsageError);
		process.env[PROTOCOL_VERSIONS_ENV] = ",";
		expect(() => resolveProtocolVersions()).toThrow(UsageError);
	});

	it("parses comma-separated lists", () => {
		expect(parseProtocolVersionList("1.0.0,,0.9.0 ")).toEqual(["1.0.0", "0.9.0"]);
	});
});

describe("AhpClient protocol negotiation", () => {
	let server: MockServer;
	let client: AhpClient;
	let saved: string | undefined;

	beforeEach(() => {
		saved = process.env[PROTOCOL_VERSIONS_ENV];
		delete process.env[PROTOCOL_VERSIONS_ENV];
	});

	afterEach(async () => {
		await client?.disconnect().catch(() => {});
		await server?.close().catch(() => {});
		if (saved === undefined) delete process.env[PROTOCOL_VERSIONS_ENV];
		else process.env[PROTOCOL_VERSIONS_ENV] = saved;
	});

	it("offers all supported versions and negotiates 1.0.0 with a released host", async () => {
		let offered: unknown;
		server = await createMockServer({
			onInitialize: (params) => {
				offered = params.protocolVersions;
				return { protocolVersion: "1.0.0", serverSeq: 0, snapshots: [] };
			},
		});
		client = new AhpClient();
		const result = await client.connect(server.url);
		expect(offered).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
		expect(result.protocolVersion).toBe("1.0.0");
	});

	it("negotiates 1.0.0 with the default (released-host) mock", async () => {
		server = await createMockServer();
		client = new AhpClient();
		const result = await client.connect(server.url);
		expect(result.protocolVersion).toBe("1.0.0");
	});

	it("fails against a ^0.10.0-only host with an actionable hint", async () => {
		server = await createMockServer({ hostProtocolVersion: "0.10.0" });
		client = new AhpClient();
		const err = await client.connect(server.url).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/none of which are compatible/);
		expect((err as Error).message).toMatch(/--protocol-version/);
		expect((err as Error).message).toContain(PROTOCOL_VERSIONS_ENV);
		expect(client.connected).toBe(false);
	});

	it("reaches a ^0.10.0-only host via the protocolVersions option", async () => {
		server = await createMockServer({ hostProtocolVersion: "0.10.0" });
		client = new AhpClient({ protocolVersions: ["0.10.0"] });
		const result = await client.connect(server.url);
		expect(result.protocolVersion).toBe("0.10.0");
	});

	it("reaches a ^0.10.0-only host via the env var", async () => {
		process.env[PROTOCOL_VERSIONS_ENV] = "1.0.0,0.10.0";
		server = await createMockServer({ hostProtocolVersion: "0.10.0" });
		client = new AhpClient();
		const result = await client.connect(server.url);
		expect(result.protocolVersion).toBe("0.10.0");
	});

	it("rejects a malformed override before opening a socket", async () => {
		server = await createMockServer();
		client = new AhpClient({ protocolVersions: ["latest"] });
		await expect(client.connect(server.url)).rejects.toBeInstanceOf(UsageError);
		expect(client.connected).toBe(false);
	});
});
