/**
 * Lightweight progress spinner for the terminal.
 *
 * Only renders when stdout is a TTY and the output format is "text".
 * Writes to stderr so it doesn't interfere with stdout piping.
 */

import pc from "picocolors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

export interface Spinner {
	/** Update the spinner message. */
	update(message: string): void;
	/** Stop and clear the spinner line, optionally replacing with a final message. */
	stop(finalMessage?: string): void;
	/** Stop with a success message (✓ prefix). */
	succeed(message: string): void;
	/** Stop with a failure message (✗ prefix). */
	fail(message: string): void;
}

/**
 * Start a progress spinner on stderr.
 *
 * Returns a no-op spinner if stdout is not a TTY (piped output, CI, etc.)
 * or if `enabled` is false (json/quiet mode).
 */
export function startSpinner(message: string, enabled = true): Spinner {
	// No-op spinner for non-TTY / non-text modes.
	// succeed/fail still write their message — the status matters even without animation.
	if (!enabled || !process.stderr.isTTY) {
		let stopped = false;
		return {
			update() {},
			stop() {
				stopped = true;
			},
			succeed(msg: string) {
				if (stopped) return;
				stopped = true;
				process.stderr.write(`${pc.green("✓")} ${msg}\n`);
			},
			fail(msg: string) {
				if (stopped) return;
				stopped = true;
				process.stderr.write(`${pc.red("✗")} ${msg}\n`);
			},
		};
	}

	let frameIdx = 0;
	let text = message;
	let stopped = false;

	const render = () => {
		if (stopped) return;
		const frame = FRAMES[frameIdx % FRAMES.length];
		process.stderr.write(`\r\x1B[K${frame} ${text}`);
		frameIdx++;
	};

	const timer = setInterval(render, INTERVAL);
	render();

	return {
		update(msg: string) {
			text = msg;
		},
		stop(finalMessage?: string) {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			process.stderr.write("\r\x1B[K"); // clear the spinner line
			if (finalMessage) {
				process.stderr.write(`${finalMessage}\n`);
			}
		},
		succeed(msg: string) {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			process.stderr.write(`\r\x1B[K${pc.green("✓")} ${msg}\n`);
		},
		fail(msg: string) {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			process.stderr.write(`\r\x1B[K${pc.red("✗")} ${msg}\n`);
		},
	};
}
