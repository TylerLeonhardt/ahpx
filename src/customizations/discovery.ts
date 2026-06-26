/**
 * Workspace Customization Discovery
 *
 * Scans a workspace directory for customization files (instructions, agents,
 * prompts, skills) and builds CustomizationRef[] for dispatch to AHP sessions.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomizationRef } from "./types.js";

/** Maximum directory depth for SKILL.md scanning. */
const SKILL_MAX_DEPTH = 3;

/**
 * Discover workspace customization files and return CustomizationRef[].
 *
 * Scans for:
 * - `.instructions.md`, `.github/copilot-instructions.md` → instructions
 * - `.agent.md`, `AGENTS.md`, `.github/agents/*.md` → agents
 * - `.prompt.md` files → prompts
 * - `SKILL.md` files in subdirectories (up to 3 levels deep) → skills
 */
export async function discoverCustomizations(cwd: string): Promise<CustomizationRef[]> {
	const refs: CustomizationRef[] = [];

	// Instructions
	await collectIfExists(refs, cwd, ".instructions.md", "Instructions");
	await collectIfExists(refs, cwd, ".github/copilot-instructions.md", "Copilot Instructions");

	// Agents — root files
	await collectIfExists(refs, cwd, ".agent.md", "Agent");
	await collectIfExists(refs, cwd, "AGENTS.md", "Agents");

	// Agents — .github/agents/*.md
	await collectGlob(refs, cwd, ".github/agents", "agent");

	// Prompts
	await collectIfExists(refs, cwd, ".prompt.md", "Prompt");

	// Skills — **/SKILL.md up to 3 levels
	await collectSkills(refs, cwd);

	return refs;
}

/**
 * Check if a specific file exists and add it as a CustomizationRef.
 */
async function collectIfExists(
	refs: CustomizationRef[],
	cwd: string,
	relativePath: string,
	displayName: string,
): Promise<void> {
	const fullPath = path.join(cwd, relativePath);
	try {
		const content = await fs.readFile(fullPath, "utf-8");
		refs.push(buildRef(fullPath, displayName, content));
	} catch {
		// File doesn't exist — skip
	}
}

/**
 * Collect all .md files from a directory (non-recursive).
 */
async function collectGlob(refs: CustomizationRef[], cwd: string, relativeDir: string, kind: string): Promise<void> {
	const dirPath = path.join(cwd, relativeDir);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			const fullPath = path.join(dirPath, entry.name);
			const name = path.basename(entry.name, ".md");
			const displayName = `${capitalize(kind)}: ${name}`;
			try {
				const content = await fs.readFile(fullPath, "utf-8");
				refs.push(buildRef(fullPath, displayName, content));
			} catch {
				// Unreadable — skip
			}
		}
	}
}

/**
 * Recursively scan for SKILL.md files up to SKILL_MAX_DEPTH levels deep.
 * The skill name is derived from the parent directory.
 */
async function collectSkills(refs: CustomizationRef[], cwd: string): Promise<void> {
	await walkForSkills(refs, cwd, cwd, 0);
}

async function walkForSkills(refs: CustomizationRef[], root: string, dir: string, depth: number): Promise<void> {
	if (depth > SKILL_MAX_DEPTH) return;

	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.isFile() && entry.name === "SKILL.md" && dir !== root) {
			const fullPath = path.join(dir, entry.name);
			const skillName = path.basename(dir);
			const displayName = `Skill: ${skillName}`;
			try {
				const content = await fs.readFile(fullPath, "utf-8");
				refs.push(buildRef(fullPath, displayName, content));
			} catch {
				// Unreadable — skip
			}
		} else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
			await walkForSkills(refs, root, path.join(dir, entry.name), depth + 1);
		}
	}
}

/**
 * Build a CustomizationRef from a file path and content.
 */
function buildRef(fullPath: string, displayName: string, content: string): CustomizationRef {
	const description = extractDescription(content);
	const nonce = createHash("sha256").update(content).digest("hex");

	return {
		uri: `file://${fullPath}`,
		displayName,
		...(description ? { description } : {}),
		nonce,
	};
}

/**
 * Extract a description from YAML frontmatter if present.
 * Looks for `description:` in a `---` delimited frontmatter block.
 */
function extractDescription(content: string): string | undefined {
	if (!content.startsWith("---")) return undefined;

	const endIdx = content.indexOf("---", 3);
	if (endIdx === -1) return undefined;

	const frontmatter = content.slice(3, endIdx);
	const match = frontmatter.match(/^description:\s*(.+)$/m);
	return match?.[1]?.trim();
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
