import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, initGlobalConfig, loadConfig } from "../index.js";

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
