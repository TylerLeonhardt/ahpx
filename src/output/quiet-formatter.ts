/**
 * Quiet Formatter — Minimal output for scripting and piping.
 *
 * Accumulates all delta text silently. On turn complete, prints only the
 * final response text (nothing else). On error, prints the error message
 * to stderr.
 */

import type { IErrorInfo, IToolCallResult, IUsageInfo } from "../protocol/state.js";
import type { OutputFormatter, WritableOutput } from "./format.js";
import type { ToolCallInfo } from "./renderer.js";

/**
 * Silent formatter — only the final response text goes to stdout.
 */
export class QuietFormatter implements OutputFormatter {
	constructor(
		private readonly out: WritableOutput = process.stdout,
		private readonly err: WritableOutput = process.stderr,
	) {}

	onDelta(_text: string): void {
		// Silent — accumulated by TurnController
	}

	onReasoning(_text: string): void {
		// Silent
	}

	onToolCallStart(_id: string, _name: string): void {
		// Silent
	}

	onToolCallDelta(_id: string, _paramsDelta: string): void {
		// Silent
	}

	onToolCallReady(_id: string, _call: ToolCallInfo): void {
		// Silent
	}

	onToolCallComplete(_id: string, _result: IToolCallResult): void {
		// Silent
	}

	onToolCallCancelled(_id: string, _reason: string): void {
		// Silent
	}

	onUsage(_usage: IUsageInfo): void {
		// Silent
	}

	onTurnComplete(responseText: string): void {
		if (responseText) {
			this.out.write(`${responseText}\n`);
		}
	}

	onTurnError(error: IErrorInfo): void {
		this.err.write(`${error.message}\n`);
	}

	onTurnCancelled(): void {
		// Silent
	}

	onTitleChanged(_title: string): void {
		// Silent
	}
}
