import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, isVerbose, setVerbose } from "../logger.js";

describe("Logger", () => {
	afterEach(() => {
		setVerbose(false);
		vi.restoreAllMocks();
	});

	describe("setVerbose / isVerbose", () => {
		it("defaults to false", () => {
			expect(isVerbose()).toBe(false);
		});

		it("can be enabled", () => {
			setVerbose(true);
			expect(isVerbose()).toBe(true);
		});

		it("can be disabled", () => {
			setVerbose(true);
			setVerbose(false);
			expect(isVerbose()).toBe(false);
		});
	});

	describe("debug level", () => {
		it("suppresses debug output when verbose is false", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(false);

			const log = createLogger("test");
			log.debug("hidden message");

			expect(spy).not.toHaveBeenCalled();
		});

		it("shows debug output when verbose is true", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(true);

			const log = createLogger("test");
			log.debug("visible message");

			expect(spy).toHaveBeenCalledTimes(1);
			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("test");
			expect(output).toContain("visible message");
		});

		it("includes component name in debug output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(true);

			const log = createLogger("transport");
			log.debug("connecting");

			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("transport");
			expect(output).toContain("connecting");
		});

		it("includes extra data in debug output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(true);

			const log = createLogger("test");
			log.debug("connecting", { url: "ws://localhost:3000" });

			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("url=ws://localhost:3000");
		});
	});

	describe("info level", () => {
		it("always shows info output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(false);

			const log = createLogger("session");
			log.info("session created", { id: "abc" });

			expect(spy).toHaveBeenCalledTimes(1);
			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("session");
			expect(output).toContain("session created");
			expect(output).toContain("id=abc");
		});
	});

	describe("warn level", () => {
		it("always shows warn output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(false);

			const log = createLogger("transport");
			log.warn("reconnect failed", { attempt: 3 });

			expect(spy).toHaveBeenCalledTimes(1);
			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("transport");
			expect(output).toContain("reconnect failed");
			expect(output).toContain("attempt=3");
		});
	});

	describe("error level", () => {
		it("always shows error output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			setVerbose(false);

			const log = createLogger("client");
			log.error("connection lost", { code: 1006 });

			expect(spy).toHaveBeenCalledTimes(1);
			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("client");
			expect(output).toContain("connection lost");
			expect(output).toContain("code=1006");
		});
	});

	describe("output goes to stderr", () => {
		it("all log levels write to stderr (not stdout)", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			setVerbose(true);

			const log = createLogger("test");
			log.debug("debug msg");
			log.info("info msg");
			log.warn("warn msg");
			log.error("error msg");

			// All 4 messages should go to stderr
			expect(stderrSpy).toHaveBeenCalledTimes(4);
			// Nothing should go to stdout
			expect(stdoutSpy).not.toHaveBeenCalled();
		});
	});

	describe("timestamp format", () => {
		it("includes HH:MM:SS timestamp in output", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const log = createLogger("test");
			log.info("test message");

			const output = spy.mock.calls[0][0] as string;
			// Match [HH:MM:SS test] pattern
			expect(output).toMatch(/\[\d{2}:\d{2}:\d{2} test\]/);
		});
	});

	describe("data formatting", () => {
		it("omits undefined values", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const log = createLogger("test");
			log.info("test", { a: "yes", b: undefined });

			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain("a=yes");
			expect(output).not.toContain("b=");
		});

		it("serializes objects as JSON", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const log = createLogger("test");
			log.info("test", { config: { timeout: 30 } });

			const output = spy.mock.calls[0][0] as string;
			expect(output).toContain('config={"timeout":30}');
		});
	});
});
