/**
 * Tests for session config display formatting and config set validation logic.
 *
 * These test the formatting and validation patterns used by the
 * `session config` and `session config set` CLI commands.
 */

import type { SessionConfigPropertySchema, SessionConfigState } from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a string value to the type declared in the schema. */
function coerceConfigValue(value: string, prop: SessionConfigPropertySchema): unknown {
	if (prop.type === "number") {
		const n = Number(value);
		if (Number.isNaN(n)) throw new Error(`Invalid number value "${value}".`);
		return n;
	}
	if (prop.type === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
		throw new Error(`Invalid boolean value "${value}". Use "true" or "false".`);
	}
	return value;
}

/** Validate a config set operation and return the coerced value. */
function validateConfigSet(config: SessionConfigState, key: string, value: string): { coerced: unknown } {
	const prop = config.schema.properties[key];
	if (!prop) {
		const available = Object.keys(config.schema.properties);
		throw new Error(`Unknown config key "${key}". Available keys: ${available.join(", ")}`);
	}
	if (!prop.sessionMutable) {
		throw new Error(`Config key "${key}" is not session-mutable.`);
	}
	const coerced = coerceConfigValue(value, prop);
	if (prop.enum && !prop.enum.includes(String(coerced))) {
		throw new Error(`Invalid value "${value}" for key "${key}". Allowed values: ${prop.enum.join(", ")}`);
	}
	return { coerced };
}

/** Format session config for text display. */
function formatConfigText(config: SessionConfigState): string[] {
	const lines: string[] = [];
	for (const [key, prop] of Object.entries(config.schema.properties)) {
		const value = config.values[key];
		const mutable = prop.sessionMutable ? "mutable" : "read-only";
		lines.push(`${key} (${prop.type}) [${mutable}]`);
		if (prop.title) lines.push(`  ${prop.title}`);
		if (prop.description) lines.push(`  ${prop.description}`);
		lines.push(`  Value: ${value !== undefined ? JSON.stringify(value) : "(not set)"}`);
		if (prop.default !== undefined) lines.push(`  Default: ${JSON.stringify(prop.default)}`);
		if (prop.enum) lines.push(`  Allowed: ${prop.enum.join(", ")}`);
	}
	return lines;
}

// ── Test data ────────────────────────────────────────────────────────────────

const testConfig: SessionConfigState = {
	schema: {
		type: "object",
		properties: {
			model: {
				type: "string",
				title: "AI Model",
				description: "The model to use for completions",
				enum: ["gpt-4", "gpt-3.5", "claude-3"],
				sessionMutable: true,
			},
			temperature: {
				type: "number",
				title: "Temperature",
				description: "Sampling temperature",
				default: 0.7,
				sessionMutable: true,
			},
			provider: {
				type: "string",
				title: "Provider",
				description: "Agent provider (set at creation)",
				sessionMutable: false,
			},
			verbose: {
				type: "boolean",
				title: "Verbose output",
				sessionMutable: true,
			},
		},
	},
	values: {
		model: "gpt-4",
		temperature: 0.7,
		provider: "copilot",
	},
};

const emptyConfig: SessionConfigState = {
	schema: { type: "object", properties: {} },
	values: {},
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("session config display", () => {
	it("formats properties with values, types, and mutability", () => {
		const lines = formatConfigText(testConfig);
		expect(lines.some((l) => l.includes("model") && l.includes("string") && l.includes("mutable"))).toBe(true);
		expect(lines.some((l) => l.includes("provider") && l.includes("read-only"))).toBe(true);
	});

	it("shows current values", () => {
		const lines = formatConfigText(testConfig);
		expect(lines.some((l) => l.includes('"gpt-4"'))).toBe(true);
		expect(lines.some((l) => l.includes("0.7"))).toBe(true);
	});

	it("shows (not set) for undefined values", () => {
		const lines = formatConfigText(testConfig);
		expect(lines.some((l) => l.includes("(not set)"))).toBe(true);
	});

	it("shows enum values", () => {
		const lines = formatConfigText(testConfig);
		expect(lines.some((l) => l.includes("gpt-4, gpt-3.5, claude-3"))).toBe(true);
	});

	it("shows defaults", () => {
		const lines = formatConfigText(testConfig);
		expect(lines.some((l) => l.includes("Default: 0.7"))).toBe(true);
	});

	it("handles empty config", () => {
		const lines = formatConfigText(emptyConfig);
		expect(lines).toHaveLength(0);
	});
});

describe("session config set validation", () => {
	it("accepts valid mutable string key", () => {
		const { coerced } = validateConfigSet(testConfig, "model", "gpt-3.5");
		expect(coerced).toBe("gpt-3.5");
	});

	it("accepts valid mutable number key", () => {
		const { coerced } = validateConfigSet(testConfig, "temperature", "0.9");
		expect(coerced).toBe(0.9);
	});

	it("accepts valid mutable boolean key", () => {
		const { coerced } = validateConfigSet(testConfig, "verbose", "true");
		expect(coerced).toBe(true);
	});

	it("rejects unknown key", () => {
		expect(() => validateConfigSet(testConfig, "nonexistent", "val")).toThrow("Unknown config key");
	});

	it("rejects read-only key", () => {
		expect(() => validateConfigSet(testConfig, "provider", "azure")).toThrow("not session-mutable");
	});

	it("rejects invalid enum value", () => {
		expect(() => validateConfigSet(testConfig, "model", "invalid-model")).toThrow("Allowed values");
	});

	it("rejects invalid number", () => {
		expect(() => validateConfigSet(testConfig, "temperature", "not-a-number")).toThrow("Invalid number");
	});

	it("rejects invalid boolean", () => {
		expect(() => validateConfigSet(testConfig, "verbose", "yes")).toThrow("Invalid boolean");
	});

	it("coerces boolean false", () => {
		const { coerced } = validateConfigSet(testConfig, "verbose", "false");
		expect(coerced).toBe(false);
	});
});
