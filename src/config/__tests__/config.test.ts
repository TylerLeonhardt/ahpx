import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	UnknownConfigKeyError,
	getConfigValue,
	initGlobalConfig,
	loadConfig,
	loadConfigWithSources,
	mergeSessionConfigMaps,
	setGlobalConfigValue,
} from "../index.js";

describe("loadConfig", () => {
	let tmpDir: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-config-test-"));
		globalPath = path.join(tmpDir, "global", "config.json");
		projectPath = path.join(tmpDir, "project", ".ahpxrc.json");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns defaults when no config files exist", async () => {
		const config = await loadConfig({ globalPath, projectPath });
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	it("loads global config", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultServer: "prod", timeout: 60 }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultServer).toBe("prod");
		expect(config.timeout).toBe(60);
		// Defaults still apply for unset values
		expect(config.format).toBe("text");
	});

	it("loads project config", async () => {
		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, JSON.stringify({ defaultProvider: "copilot", format: "json" }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultProvider).toBe("copilot");
		expect(config.format).toBe("json");
	});

	it("project config overrides global config", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultServer: "global-server", timeout: 60 }));

		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, JSON.stringify({ defaultServer: "project-server" }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultServer).toBe("project-server");
		// Global values not overridden by project are preserved
		expect(config.timeout).toBe(60);
	});

	it("CLI overrides take precedence over everything", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ timeout: 60 }));

		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, JSON.stringify({ timeout: 120 }));

		const config = await loadConfig({
			globalPath,
			projectPath,
			overrides: { timeout: 5 },
		});
		expect(config.timeout).toBe(5);
	});

	it("ignores unknown keys in config files", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ unknownKey: "value", defaultServer: "ok" }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultServer).toBe("ok");
		expect((config as Record<string, unknown>).unknownKey).toBeUndefined();
	});

	it("skips undefined override values", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultServer: "keep-me" }));

		const config = await loadConfig({
			globalPath,
			projectPath,
			overrides: { defaultServer: undefined },
		});
		expect(config.defaultServer).toBe("keep-me");
	});
});

describe("defaultSessionConfig (layered map merge)", () => {
	let tmpDir: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-dsc-test-"));
		globalPath = path.join(tmpDir, "global", "config.json");
		projectPath = path.join(tmpDir, "project", ".ahpxrc.json");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("is a no-op (undefined) when no map is configured anywhere", async () => {
		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultSessionConfig).toBeUndefined();
	});

	it("loads a global-only map", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultSessionConfig: { isolation: "folder" } }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultSessionConfig).toEqual({ isolation: "folder" });
	});

	it("shallow-merges project over global per-key (not whole-object replacement)", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultSessionConfig: { isolation: "folder", verbosity: "low" } }));
		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, JSON.stringify({ defaultSessionConfig: { isolation: "worktree" } }));

		const config = await loadConfig({ globalPath, projectPath });
		// project overrides isolation; global verbosity survives (shallow merge)
		expect(config.defaultSessionConfig).toEqual({ isolation: "worktree", verbosity: "low" });
	});

	it("CLI overrides win at the per-key level over global+project", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultSessionConfig: { isolation: "folder" } }));

		const config = await loadConfig({
			globalPath,
			projectPath,
			overrides: { defaultSessionConfig: { isolation: "worktree" } },
		});
		expect(config.defaultSessionConfig).toEqual({ isolation: "worktree" });
	});

	it("ignores a non-object defaultSessionConfig value", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultSessionConfig: "nope" }));

		const config = await loadConfig({ globalPath, projectPath });
		expect(config.defaultSessionConfig).toBeUndefined();
	});

	it("annotates the source of the map as the highest contributing layer", async () => {
		await fs.mkdir(path.dirname(globalPath), { recursive: true });
		await fs.writeFile(globalPath, JSON.stringify({ defaultSessionConfig: { isolation: "folder" } }));
		await fs.mkdir(path.dirname(projectPath), { recursive: true });
		await fs.writeFile(projectPath, JSON.stringify({ defaultSessionConfig: { verbosity: "low" } }));

		const result = await loadConfigWithSources({ globalPath, projectPath });
		expect(result.config.defaultSessionConfig).toEqual({ isolation: "folder", verbosity: "low" });
		expect(result.sources.defaultSessionConfig).toBe("project");
	});
});

describe("mergeSessionConfigMaps", () => {
	it("returns undefined when no object layer contributes keys", () => {
		expect(mergeSessionConfigMaps(undefined, undefined)).toBeUndefined();
		expect(mergeSessionConfigMaps({}, undefined)).toBeUndefined();
	});

	it("merges later layers over earlier ones (CLI -c beats persisted default)", () => {
		// defaults (lowest) under explicit -c flags (highest)
		const merged = mergeSessionConfigMaps({ isolation: "folder" }, { isolation: "worktree" });
		expect(merged).toEqual({ isolation: "worktree" });
	});

	it("keeps keys that only the lower layer provides", () => {
		const merged = mergeSessionConfigMaps({ isolation: "folder", verbosity: "low" }, { isolation: "worktree" });
		expect(merged).toEqual({ isolation: "worktree", verbosity: "low" });
	});

	it("ignores non-object layers", () => {
		expect(mergeSessionConfigMaps(undefined, { isolation: "folder" })).toEqual({ isolation: "folder" });
	});
});

describe("setGlobalConfigValue / getConfigValue", () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-set-test-"));
		configPath = path.join(tmpDir, "config.json");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("sets a nested map value via a dotted path, creating the map", async () => {
		await setGlobalConfigValue("defaultSessionConfig.isolation", "folder", configPath);
		const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(parsed.defaultSessionConfig).toEqual({ isolation: "folder" });
	});

	it("preserves existing keys when setting a nested value", async () => {
		await fs.writeFile(
			configPath,
			JSON.stringify({ defaultServer: "prod", defaultSessionConfig: { verbosity: "low" } }),
		);
		await setGlobalConfigValue("defaultSessionConfig.isolation", "folder", configPath);
		const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(parsed.defaultServer).toBe("prod");
		expect(parsed.defaultSessionConfig).toEqual({ verbosity: "low", isolation: "folder" });
	});

	it("sets a top-level scalar value", async () => {
		await setGlobalConfigValue("timeout", 60, configPath);
		const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(parsed.timeout).toBe(60);
	});

	it("rejects an unknown top-level key", async () => {
		await expect(setGlobalConfigValue("bogusKey", "x", configPath)).rejects.toThrow(UnknownConfigKeyError);
	});

	it("reads a dotted value out of a resolved config", () => {
		const cfg = { defaultSessionConfig: { isolation: "folder" } };
		expect(getConfigValue(cfg, "defaultSessionConfig.isolation")).toBe("folder");
		expect(getConfigValue(cfg, "defaultSessionConfig.missing")).toBeUndefined();
		expect(getConfigValue(cfg, "missing.deep")).toBeUndefined();
	});
});

describe("initGlobalConfig", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-init-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("creates config file with defaults", async () => {
		const configPath = path.join(tmpDir, "new-dir", "config.json");
		const created = await initGlobalConfig(configPath);

		expect(created).toBe(true);

		const raw = await fs.readFile(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed).toEqual(DEFAULT_CONFIG);
	});

	it("does not overwrite existing config", async () => {
		const configPath = path.join(tmpDir, "config.json");
		await fs.writeFile(configPath, JSON.stringify({ defaultServer: "keep" }));

		const created = await initGlobalConfig(configPath);
		expect(created).toBe(false);

		const raw = await fs.readFile(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.defaultServer).toBe("keep");
	});
});
