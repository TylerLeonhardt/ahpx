import { describe, expect, it } from "vitest";
import { ensureFileUri, fileUriToDisplayPath } from "../uri.js";

// ── ensureFileUri ────────────────────────────────────────────────────────────

describe("ensureFileUri", () => {
	describe("Windows paths", () => {
		it("converts backslash-separated Windows path", () => {
			expect(ensureFileUri("C:\\Users\\tyler\\Code")).toBe("file:///C:/Users/tyler/Code");
		});

		it("converts forward-slash Windows path", () => {
			expect(ensureFileUri("C:/Users/tyler/Code")).toBe("file:///C:/Users/tyler/Code");
		});

		it("handles lowercase drive letter", () => {
			expect(ensureFileUri("d:\\Projects\\my-app")).toBe("file:///d:/Projects/my-app");
		});

		it("handles drive root (C:\\)", () => {
			expect(ensureFileUri("C:\\")).toBe("file:///C:/");
		});

		it("handles bare drive letter (C:)", () => {
			expect(ensureFileUri("C:")).toBe("file:///C:");
		});

		it("handles deeply nested Windows path", () => {
			expect(ensureFileUri("D:\\Projects\\org\\repo\\src\\lib")).toBe("file:///D:/Projects/org/repo/src/lib");
		});

		it("handles mixed separators", () => {
			expect(ensureFileUri("C:\\Users/tyler\\Code/project")).toBe("file:///C:/Users/tyler/Code/project");
		});
	});

	describe("Unix paths", () => {
		it("converts Unix absolute path", () => {
			expect(ensureFileUri("/Users/tyler/Code")).toBe("file:///Users/tyler/Code");
		});

		it("handles root path", () => {
			expect(ensureFileUri("/")).toBe("file:///");
		});

		it("handles deeply nested Unix path", () => {
			expect(ensureFileUri("/home/user/projects/org/repo/src")).toBe("file:///home/user/projects/org/repo/src");
		});
	});

	describe("already-formed URIs (passthrough)", () => {
		it("returns file URIs unchanged", () => {
			expect(ensureFileUri("file:///C:/Users/tyler")).toBe("file:///C:/Users/tyler");
		});

		it("returns Unix file URIs unchanged", () => {
			expect(ensureFileUri("file:///Users/tyler/Code")).toBe("file:///Users/tyler/Code");
		});

		it("returns copilot URIs unchanged", () => {
			expect(ensureFileUri("copilot:/session-abc")).toBe("copilot:/session-abc");
		});

		it("returns http URIs unchanged", () => {
			expect(ensureFileUri("http://example.com/path")).toBe("http://example.com/path");
		});

		it("returns agenthost URIs unchanged", () => {
			expect(ensureFileUri("ahp-root://")).toBe("ahp-root://");
		});
	});

	describe("special characters", () => {
		it("percent-encodes spaces in path components", () => {
			expect(ensureFileUri("C:\\Users\\My Documents\\Code")).toBe("file:///C:/Users/My%20Documents/Code");
		});

		it("percent-encodes spaces in Unix paths", () => {
			expect(ensureFileUri("/Users/My User/Code")).toBe("file:///Users/My%20User/Code");
		});

		it("percent-encodes special characters", () => {
			expect(ensureFileUri("/path/with [brackets]")).toBe("file:///path/with%20%5Bbrackets%5D");
		});

		it("percent-encodes colons in Unix filenames", () => {
			expect(ensureFileUri("/path/file:name.txt")).toBe("file:///path/file%3Aname.txt");
		});

		it("percent-encodes colons in Windows paths (except drive letter)", () => {
			expect(ensureFileUri("C:/Users/file:name.txt")).toBe("file:///C:/Users/file%3Aname.txt");
		});
	});

	describe("edge cases", () => {
		it("returns empty string unchanged", () => {
			expect(ensureFileUri("")).toBe("");
		});

		it("returns relative paths unchanged", () => {
			expect(ensureFileUri("relative/path")).toBe("relative/path");
		});

		it("returns dot paths unchanged", () => {
			expect(ensureFileUri("./local")).toBe("./local");
		});
	});
});

// ── fileUriToDisplayPath ─────────────────────────────────────────────────────

describe("fileUriToDisplayPath", () => {
	describe("Windows file URIs", () => {
		it("preserves drive letter from Windows file URI", () => {
			expect(fileUriToDisplayPath("file:///C:/Users/tyler/Code")).toBe("C:/Users/tyler/Code");
		});

		it("handles lowercase drive letter", () => {
			expect(fileUriToDisplayPath("file:///d:/Projects/my-app")).toBe("d:/Projects/my-app");
		});

		it("handles drive root", () => {
			expect(fileUriToDisplayPath("file:///C:/")).toBe("C:/");
		});

		it("handles bare drive letter", () => {
			expect(fileUriToDisplayPath("file:///C:")).toBe("C:");
		});

		it("handles deeply nested path", () => {
			expect(fileUriToDisplayPath("file:///D:/Projects/org/repo/src/lib")).toBe("D:/Projects/org/repo/src/lib");
		});
	});

	describe("Unix file URIs", () => {
		it("converts Unix file URI to path", () => {
			expect(fileUriToDisplayPath("file:///Users/tyler/Code")).toBe("/Users/tyler/Code");
		});

		it("handles root path", () => {
			expect(fileUriToDisplayPath("file:///")).toBe("/");
		});

		it("handles deeply nested path", () => {
			expect(fileUriToDisplayPath("file:///home/user/projects/src")).toBe("/home/user/projects/src");
		});
	});

	describe("percent-encoded URIs", () => {
		it("decodes percent-encoded spaces", () => {
			expect(fileUriToDisplayPath("file:///C:/Users/My%20Documents/Code")).toBe("C:/Users/My Documents/Code");
		});

		it("decodes percent-encoded special characters", () => {
			expect(fileUriToDisplayPath("file:///path/with%20%5Bbrackets%5D")).toBe("/path/with [brackets]");
		});
	});

	describe("non-file URIs (passthrough)", () => {
		it("returns copilot URIs unchanged", () => {
			expect(fileUriToDisplayPath("copilot:/session-abc")).toBe("copilot:/session-abc");
		});

		it("returns http URIs unchanged", () => {
			expect(fileUriToDisplayPath("http://example.com")).toBe("http://example.com");
		});

		it("returns plain paths unchanged", () => {
			expect(fileUriToDisplayPath("/plain/path")).toBe("/plain/path");
		});

		it("returns empty string unchanged", () => {
			expect(fileUriToDisplayPath("")).toBe("");
		});

		it("returns Windows paths unchanged", () => {
			expect(fileUriToDisplayPath("C:\\Users\\tyler")).toBe("C:\\Users\\tyler");
		});
	});

	describe("round-trip consistency", () => {
		it("round-trips Windows path through URI and back", () => {
			const original = "C:/Users/tyler/Code/project";
			const uri = ensureFileUri(original);
			expect(uri).toBe("file:///C:/Users/tyler/Code/project");
			expect(fileUriToDisplayPath(uri)).toBe(original);
		});

		it("round-trips Unix path through URI and back", () => {
			const original = "/Users/tyler/Code/project";
			const uri = ensureFileUri(original);
			expect(uri).toBe("file:///Users/tyler/Code/project");
			expect(fileUriToDisplayPath(uri)).toBe(original);
		});

		it("round-trips Windows backslash path (normalizes to forward slash)", () => {
			const uri = ensureFileUri("C:\\Users\\tyler\\Code");
			expect(uri).toBe("file:///C:/Users/tyler/Code");
			expect(fileUriToDisplayPath(uri)).toBe("C:/Users/tyler/Code");
		});

		it("round-trips path with spaces", () => {
			const uri = ensureFileUri("C:\\Users\\My Documents\\Code");
			expect(uri).toBe("file:///C:/Users/My%20Documents/Code");
			expect(fileUriToDisplayPath(uri)).toBe("C:/Users/My Documents/Code");
		});
	});
});
