/**
 * Structured logger — debug/info/warn/error output to stderr.
 *
 * Debug output is only emitted when `setVerbose(true)` has been called.
 * All log output goes to stderr so it never contaminates stdout (important
 * for JSON piping and quiet mode).
 */

import pc from "picocolors";

let verbose = false;

/** Enable or disable debug-level output globally. */
export function setVerbose(enabled: boolean): void {
	verbose = enabled;
}

/** Returns the current verbose setting. */
export function isVerbose(): boolean {
	return verbose;
}

/** Format a time-only timestamp for log prefixes. */
function timestamp(): string {
	const now = new Date();
	return [
		String(now.getHours()).padStart(2, "0"),
		String(now.getMinutes()).padStart(2, "0"),
		String(now.getSeconds()).padStart(2, "0"),
	].join(":");
}

/** Format extra data as key=value pairs. */
function formatData(data?: Record<string, unknown>): string {
	if (!data) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value !== undefined) {
			parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export interface Logger {
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Create a named logger instance. The component name is shown in every log line.
 *
 * ```
 * const log = createLogger("transport");
 * log.debug("connecting", { url: "ws://localhost:3000" });
 * // → [07:12:33 transport] connecting url=ws://localhost:3000
 * ```
 */
export function createLogger(component: string): Logger {
	const prefix = () => `[${timestamp()} ${component}]`;

	return {
		debug(message: string, data?: Record<string, unknown>): void {
			if (!verbose) return;
			process.stderr.write(pc.dim(`${prefix()} ${message}${formatData(data)}\n`));
		},

		info(message: string, data?: Record<string, unknown>): void {
			process.stderr.write(`${prefix()} ${message}${formatData(data)}\n`);
		},

		warn(message: string, data?: Record<string, unknown>): void {
			process.stderr.write(pc.yellow(`${prefix()} ${message}${formatData(data)}\n`));
		},

		error(message: string, data?: Record<string, unknown>): void {
			process.stderr.write(pc.red(`${prefix()} ${message}${formatData(data)}\n`));
		},
	};
}
