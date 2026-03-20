import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpinner } from "../spinner.js";

describe("Spinner", () => {
	// biome-ignore lint/suspicious/noExplicitAny: mock type
	let stderrWrite: any;
	let origIsTTY: boolean | undefined;

	beforeEach(() => {
		stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		origIsTTY = process.stderr.isTTY;
	});

	afterEach(() => {
		stderrWrite.mockRestore();
		Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
		vi.restoreAllMocks();
	});

	describe("TTY mode", () => {
		beforeEach(() => {
			Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
		});

		it("stop() clears the spinner line", () => {
			vi.useFakeTimers();
			const spinner = startSpinner("Loading...");
			stderrWrite.mockClear();

			spinner.stop();
			expect(stderrWrite).toHaveBeenCalledWith("\r\x1B[K");
			vi.useRealTimers();
		});

		it("succeed() clears line and writes \u2713 prefixed message", () => {
			vi.useFakeTimers();
			const spinner = startSpinner("Loading...");
			stderrWrite.mockClear();

			spinner.succeed("Connected");
			const output = stderrWrite.mock.calls.map((c: unknown[]) => c[0]).join("");
			expect(output).toContain("\u2713");
			expect(output).toContain("Connected");
			vi.useRealTimers();
		});

		it("fail() clears line and writes \u2717 prefixed message", () => {
			vi.useFakeTimers();
			const spinner = startSpinner("Connecting...");
			stderrWrite.mockClear();

			spinner.fail("Connection failed: ECONNREFUSED");
			const output = stderrWrite.mock.calls.map((c: unknown[]) => c[0]).join("");
			expect(output).toContain("\u2717");
			expect(output).toContain("Connection failed: ECONNREFUSED");
			vi.useRealTimers();
		});

		it("succeed() is a no-op after stop()", () => {
			vi.useFakeTimers();
			const spinner = startSpinner("Loading...");
			spinner.stop();
			stderrWrite.mockClear();

			spinner.succeed("Done");
			expect(stderrWrite).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it("fail() is a no-op after stop()", () => {
			vi.useFakeTimers();
			const spinner = startSpinner("Loading...");
			spinner.stop();
			stderrWrite.mockClear();

			spinner.fail("Failed");
			expect(stderrWrite).not.toHaveBeenCalled();
			vi.useRealTimers();
		});
	});

	describe("non-TTY mode", () => {
		beforeEach(() => {
			Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
		});

		it("stop() is a no-op", () => {
			const spinner = startSpinner("Loading...");
			stderrWrite.mockClear();
			spinner.stop();
			expect(stderrWrite).not.toHaveBeenCalled();
		});

		it("succeed() still writes the message", () => {
			const spinner = startSpinner("Loading...");
			stderrWrite.mockClear();
			spinner.succeed("Connected");
			const output = stderrWrite.mock.calls.map((c: unknown[]) => c[0]).join("");
			expect(output).toContain("\u2713");
			expect(output).toContain("Connected");
		});

		it("fail() still writes the message", () => {
			const spinner = startSpinner("Loading...");
			stderrWrite.mockClear();
			spinner.fail("Connection failed");
			const output = stderrWrite.mock.calls.map((c: unknown[]) => c[0]).join("");
			expect(output).toContain("\u2717");
			expect(output).toContain("Connection failed");
		});

		it("succeed() is a no-op after stop()", () => {
			const spinner = startSpinner("Loading...");
			spinner.stop();
			stderrWrite.mockClear();
			spinner.succeed("Done");
			expect(stderrWrite).not.toHaveBeenCalled();
		});

		it("fail() is a no-op after stop()", () => {
			const spinner = startSpinner("Loading...");
			spinner.stop();
			stderrWrite.mockClear();
			spinner.fail("Failed");
			expect(stderrWrite).not.toHaveBeenCalled();
		});
	});
});
