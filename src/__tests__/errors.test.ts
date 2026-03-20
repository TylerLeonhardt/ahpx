import { describe, expect, it } from "vitest";
import {
	AhpxError,
	ExitCode,
	NoSessionError,
	PermissionDeniedError,
	TimeoutError,
	UsageError,
	extractErrorMessage,
} from "../errors.js";

describe("Error classes", () => {
	describe("ExitCode constants", () => {
		it("has correct values", () => {
			expect(ExitCode.Success).toBe(0);
			expect(ExitCode.Error).toBe(1);
			expect(ExitCode.Usage).toBe(2);
			expect(ExitCode.Timeout).toBe(3);
			expect(ExitCode.NoSession).toBe(4);
			expect(ExitCode.PermissionDenied).toBe(5);
			expect(ExitCode.Interrupted).toBe(130);
		});
	});

	describe("AhpxError", () => {
		it("stores message and exit code", () => {
			const err = new AhpxError("something failed", ExitCode.Error);
			expect(err.message).toBe("something failed");
			expect(err.exitCode).toBe(1);
			expect(err.name).toBe("AhpxError");
		});

		it("is an instance of Error", () => {
			const err = new AhpxError("test", ExitCode.Error);
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe("UsageError", () => {
		it("has exit code 2", () => {
			const err = new UsageError("missing required flag --url");
			expect(err.exitCode).toBe(2);
			expect(err.name).toBe("UsageError");
			expect(err.message).toBe("missing required flag --url");
		});

		it("is an instance of AhpxError", () => {
			const err = new UsageError("bad args");
			expect(err).toBeInstanceOf(AhpxError);
		});
	});

	describe("TimeoutError", () => {
		it("has exit code 3", () => {
			const err = new TimeoutError("connection timed out after 10s");
			expect(err.exitCode).toBe(3);
			expect(err.name).toBe("TimeoutError");
			expect(err.message).toBe("connection timed out after 10s");
		});

		it("is an instance of AhpxError", () => {
			const err = new TimeoutError("timeout");
			expect(err).toBeInstanceOf(AhpxError);
		});
	});

	describe("NoSessionError", () => {
		it("has exit code 4", () => {
			const err = new NoSessionError("no session found for server");
			expect(err.exitCode).toBe(4);
			expect(err.name).toBe("NoSessionError");
			expect(err.message).toBe("no session found for server");
		});

		it("is an instance of AhpxError", () => {
			const err = new NoSessionError("no session");
			expect(err).toBeInstanceOf(AhpxError);
		});
	});

	describe("PermissionDeniedError", () => {
		it("has exit code 5", () => {
			const err = new PermissionDeniedError("all permissions denied by user");
			expect(err.exitCode).toBe(5);
			expect(err.name).toBe("PermissionDeniedError");
			expect(err.message).toBe("all permissions denied by user");
		});

		it("is an instance of AhpxError", () => {
			const err = new PermissionDeniedError("denied");
			expect(err).toBeInstanceOf(AhpxError);
		});
	});

	describe("error hierarchy", () => {
		it("all custom errors extend AhpxError", () => {
			const errors = [
				new UsageError("test"),
				new TimeoutError("test"),
				new NoSessionError("test"),
				new PermissionDeniedError("test"),
			];

			for (const err of errors) {
				expect(err).toBeInstanceOf(AhpxError);
				expect(err).toBeInstanceOf(Error);
			}
		});

		it("each error type has a unique exit code", () => {
			const codes = new Set([
				new UsageError("").exitCode,
				new TimeoutError("").exitCode,
				new NoSessionError("").exitCode,
				new PermissionDeniedError("").exitCode,
			]);

			expect(codes.size).toBe(4);
		});
	});

	describe("extractErrorMessage", () => {
		it("extracts message from standard Error", () => {
			expect(extractErrorMessage(new Error("something broke"))).toBe("something broke");
		});

		it("extracts message from AhpxError", () => {
			expect(extractErrorMessage(new AhpxError("session failed", ExitCode.Error))).toBe("session failed");
		});

		it("extracts sub-error message from AggregateError with empty message", () => {
			const subError = new Error("connect ECONNREFUSED 127.0.0.1:9999");
			const aggregate = new AggregateError([subError], "");
			expect(extractErrorMessage(aggregate)).toBe("connect ECONNREFUSED 127.0.0.1:9999");
		});

		it("uses top-level message when AggregateError has one", () => {
			const aggregate = new AggregateError([new Error("sub")], "top-level message");
			expect(extractErrorMessage(aggregate)).toBe("top-level message");
		});

		it("falls back to error code when message is empty", () => {
			const err = new Error("");
			(err as NodeJS.ErrnoException).code = "ECONNREFUSED";
			expect(extractErrorMessage(err)).toBe("ECONNREFUSED");
		});

		it("converts non-Error values to string", () => {
			expect(extractErrorMessage("plain string")).toBe("plain string");
			expect(extractErrorMessage(42)).toBe("42");
			expect(extractErrorMessage(null)).toBe("null");
		});

		it("handles AggregateError with multiple sub-errors (uses first)", () => {
			const errors = [new Error("connect ECONNREFUSED 127.0.0.1:9999"), new Error("connect ECONNREFUSED ::1:9999")];
			const aggregate = new AggregateError(errors, "");
			expect(extractErrorMessage(aggregate)).toBe("connect ECONNREFUSED 127.0.0.1:9999");
		});

		it("handles AggregateError with empty errors array", () => {
			const aggregate = new AggregateError([], "");
			expect(extractErrorMessage(aggregate)).toBe("AggregateError");
		});
	});
});
