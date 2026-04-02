/**
 * OutputFormatter — Abstraction layer for CLI output formatting.
 *
 * Three modes:
 *   - text:  Colored terminal output via PromptRenderer
 *   - json:  NDJSON (one JSON object per line)
 *   - quiet: Accumulates silently, prints only the final response
 */

import type { IErrorInfo, IToolCallResult, IUsageInfo } from "../protocol/state.js";
import type { ToolCallInfo } from "./renderer.js";

export type OutputFormat = "text" | "json" | "quiet";

/**
 * Interface implemented by all output formatters.
 *
 * The TurnController calls these methods as actions arrive from the server.
 * Each formatter decides how (or whether) to render them.
 */
export interface OutputFormatter {
	onDelta(text: string): void;
	onReasoning(text: string): void;
	onToolCallStart(id: string, name: string): void;
	onToolCallDelta(id: string, paramsDelta: string): void;
	onToolCallReady(id: string, call: ToolCallInfo): void;
	onToolCallComplete(id: string, result: IToolCallResult): void;
	onToolCallCancelled(id: string, reason: string): void;
	onUsage(usage: IUsageInfo): void;
	onTurnComplete(responseText: string): void;
	onTurnError(error: IErrorInfo): void;
	onTurnCancelled(): void;
	onTitleChanged(title: string): void;
}

export type { ToolCallInfo, WritableOutput } from "./renderer.js";
