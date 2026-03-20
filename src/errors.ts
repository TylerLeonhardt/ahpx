/**
 * Structured error classes with well-defined exit codes.
 *
 * | Code | Meaning            |
 * |------|--------------------|
 * |  0   | Success            |
 * |  1   | Runtime error      |
 * |  2   | Usage error        |
 * |  3   | Timeout            |
 * |  4   | No session         |
 * |  5   | Permission denied  |
 * | 130  | Interrupted        |
 */

export const ExitCode = {
	Success: 0,
	Error: 1,
	Usage: 2,
	Timeout: 3,
	NoSession: 4,
	PermissionDenied: 5,
	Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Base error with an associated CLI exit code.
 */
export class AhpxError extends Error {
	constructor(
		message: string,
		public readonly exitCode: ExitCodeValue,
	) {
		super(message);
		this.name = "AhpxError";
	}
}

/** Bad CLI arguments or missing required flags. */
export class UsageError extends AhpxError {
	constructor(message: string) {
		super(message, ExitCode.Usage);
		this.name = "UsageError";
	}
}

/** Connection or request timeout. */
export class TimeoutError extends AhpxError {
	constructor(message: string) {
		super(message, ExitCode.Timeout);
		this.name = "TimeoutError";
	}
}

/** Session not found — need `session new`. */
export class NoSessionError extends AhpxError {
	constructor(message: string) {
		super(message, ExitCode.NoSession);
		this.name = "NoSessionError";
	}
}

/** All permission requests were denied. */
export class PermissionDeniedError extends AhpxError {
	constructor(message: string) {
		super(message, ExitCode.PermissionDenied);
		this.name = "PermissionDeniedError";
	}
}

/**
 * Extract a human-readable message from an error.
 *
 * Handles AggregateError (thrown by the ws library for ECONNREFUSED, etc.)
 * where the top-level message is empty but sub-errors have details.
 */
export function extractErrorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);

	// AggregateError: ws throws these with empty message for connection failures
	if (err instanceof AggregateError && !err.message && err.errors.length > 0) {
		const first = err.errors[0];
		return first instanceof Error ? first.message : String(first);
	}

	if (err.message) return err.message;

	// Fallback to error code if message is empty (e.g. ECONNREFUSED, ETIMEDOUT)
	const code = (err as NodeJS.ErrnoException).code;
	if (code) return code;

	return String(err);
}
