/**
 * Output module — formatters and rendering for CLI output.
 */

export { PromptRenderer } from "./renderer.js";
export type { ToolCallInfo, WritableOutput } from "./renderer.js";
export type { OutputFormat, OutputFormatter } from "./format.js";
export { JsonFormatter } from "./json-formatter.js";
export type { JsonEnvelope, JsonEventType } from "./json-formatter.js";
export { QuietFormatter } from "./quiet-formatter.js";
export { startSpinner } from "./spinner.js";
export type { Spinner } from "./spinner.js";

import type { OutputFormat, OutputFormatter } from "./format.js";
import { JsonFormatter } from "./json-formatter.js";
import { QuietFormatter } from "./quiet-formatter.js";
import type { WritableOutput } from "./renderer.js";
import { PromptRenderer } from "./renderer.js";

/**
 * Create a formatter for the given output format.
 */
export function createFormatter(
	format: OutputFormat,
	options?: { out?: WritableOutput; err?: WritableOutput; jsonStrict?: boolean },
): OutputFormatter {
	switch (format) {
		case "json":
			return new JsonFormatter(options?.out, options?.jsonStrict);
		case "quiet":
			return new QuietFormatter(options?.out, options?.err);
		default:
			return new PromptRenderer(options?.out);
	}
}
