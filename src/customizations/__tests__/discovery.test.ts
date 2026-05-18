import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCustomizations } from "../discovery.js";

describe("discoverCustomizations", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ahpx-discovery-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array for empty workspace", async () => {
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toEqual([]);
	});

	it("discovers .instructions.md", async () => {
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), "# Instructions\nDo stuff");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Instructions");
		expect(refs[0].uri).toBe(`file://${path.join(tmpDir, ".instructions.md")}`);
		expect(refs[0].nonce).toMatch(/^[a-f0-9]{64}$/);
	});

	it("discovers .github/copilot-instructions.md", async () => {
		await fs.mkdir(path.join(tmpDir, ".github"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".github/copilot-instructions.md"), "copilot instructions");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Copilot Instructions");
	});

	it("discovers .agent.md and AGENTS.md", async () => {
		await fs.writeFile(path.join(tmpDir, ".agent.md"), "agent definition");
		await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents list");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(2);
		const names = refs.map((r) => r.displayName);
		expect(names).toContain("Agent");
		expect(names).toContain("Agents");
	});

	it("discovers .github/agents/*.md", async () => {
		await fs.mkdir(path.join(tmpDir, ".github/agents"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".github/agents/reviewer.md"), "review agent");
		await fs.writeFile(path.join(tmpDir, ".github/agents/planner.md"), "planning agent");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(2);
		const names = refs.map((r) => r.displayName);
		expect(names).toContain("Agent: reviewer");
		expect(names).toContain("Agent: planner");
	});

	it("ignores non-md files in .github/agents/", async () => {
		await fs.mkdir(path.join(tmpDir, ".github/agents"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, ".github/agents/config.json"), "{}");
		await fs.writeFile(path.join(tmpDir, ".github/agents/agent.md"), "an agent");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Agent: agent");
	});

	it("discovers .prompt.md", async () => {
		await fs.writeFile(path.join(tmpDir, ".prompt.md"), "prompt template");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Prompt");
	});

	it("discovers SKILL.md in subdirectories", async () => {
		const skillDir = path.join(tmpDir, "myskill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "skill content");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Skill: myskill");
		expect(refs[0].uri).toBe(`file://${path.join(skillDir, "SKILL.md")}`);
	});

	it("discovers nested SKILL.md up to 3 levels", async () => {
		const level1 = path.join(tmpDir, "a");
		const level2 = path.join(level1, "b");
		const level3 = path.join(level2, "c");
		await fs.mkdir(level3, { recursive: true });
		await fs.writeFile(path.join(level3, "SKILL.md"), "deep skill");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].displayName).toBe("Skill: c");
	});

	it("ignores SKILL.md beyond 3 levels", async () => {
		const level4 = path.join(tmpDir, "a", "b", "c", "d");
		await fs.mkdir(level4, { recursive: true });
		await fs.writeFile(path.join(level4, "SKILL.md"), "too deep");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(0);
	});

	it("ignores SKILL.md at workspace root", async () => {
		await fs.writeFile(path.join(tmpDir, "SKILL.md"), "root skill");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(0);
	});

	it("skips hidden directories when scanning for skills", async () => {
		const hiddenDir = path.join(tmpDir, ".hidden");
		await fs.mkdir(hiddenDir, { recursive: true });
		await fs.writeFile(path.join(hiddenDir, "SKILL.md"), "hidden skill");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(0);
	});

	it("skips node_modules when scanning for skills", async () => {
		const nmDir = path.join(tmpDir, "node_modules", "pkg");
		await fs.mkdir(nmDir, { recursive: true });
		await fs.writeFile(path.join(nmDir, "SKILL.md"), "module skill");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(0);
	});

	it("extracts description from frontmatter", async () => {
		const content = `---
description: My custom instructions
title: Something
---
# Instructions`;
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), content);
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].description).toBe("My custom instructions");
	});

	it("sets no description when frontmatter is absent", async () => {
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), "# No frontmatter");
		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(1);
		expect(refs[0].description).toBeUndefined();
	});

	it("generates different nonces for different content", async () => {
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), "content A");
		const refs1 = await discoverCustomizations(tmpDir);
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), "content B");
		const refs2 = await discoverCustomizations(tmpDir);
		expect(refs1[0].nonce).not.toBe(refs2[0].nonce);
	});

	it("discovers multiple file types simultaneously", async () => {
		await fs.writeFile(path.join(tmpDir, ".instructions.md"), "instructions");
		await fs.writeFile(path.join(tmpDir, ".agent.md"), "agent");
		await fs.writeFile(path.join(tmpDir, ".prompt.md"), "prompt");
		await fs.mkdir(path.join(tmpDir, "myskill"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "myskill", "SKILL.md"), "skill");

		const refs = await discoverCustomizations(tmpDir);
		expect(refs).toHaveLength(4);
		const names = refs.map((r) => r.displayName);
		expect(names).toContain("Instructions");
		expect(names).toContain("Agent");
		expect(names).toContain("Prompt");
		expect(names).toContain("Skill: myskill");
	});
});
