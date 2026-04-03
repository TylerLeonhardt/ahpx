/**
 * URI utility functions for converting between file URIs and filesystem paths.
 *
 * These functions handle both Unix and Windows paths correctly regardless of
 * the platform they run on — critical for ahpx which may run on macOS/Linux
 * while targeting remote Windows servers via `--cwd`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8089 — The "file" URI Scheme
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * True when the string starts with a URI scheme (e.g. `file:`, `http:`, `copilot:`).
 * Requires 2+ characters before the colon to avoid matching Windows drive letters
 * like `C:\` which have exactly one letter before the colon.
 */
function hasScheme(input: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(input);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure a filesystem path or URI string is a proper `file://` URI.
 *
 * | Input                       | Output                              |
 * |-----------------------------|-------------------------------------|
 * | `C:\Users\tyler\Code`       | `file:///C:/Users/tyler/Code`       |
 * | `C:/Users/tyler/Code`       | `file:///C:/Users/tyler/Code`       |
 * | `/Users/tyler/Code`         | `file:///Users/tyler/Code`          |
 * | `file:///C:/Users/tyler`    | `file:///C:/Users/tyler` (unchanged)|
 * | `copilot:/session-1`        | `copilot:/session-1` (unchanged)    |
 * | `""` (empty)                | `""` (unchanged)                    |
 *
 * Backslashes are normalized to forward slashes. Spaces and other reserved
 * characters in path components are percent-encoded.
 */
export function ensureFileUri(pathOrUri: string): string {
	if (!pathOrUri) return pathOrUri;

	// Already has a scheme — return unchanged
	if (hasScheme(pathOrUri)) return pathOrUri;

	// Normalize backslashes for consistent handling
	const normalized = pathOrUri.replace(/\\/g, "/");

	// Windows absolute path: C:/path → file:///C:/path
	if (/^[a-zA-Z]:\//.test(normalized) || /^[a-zA-Z]:$/.test(normalized)) {
		return `file:///${encodeFilePathComponents(normalized)}`;
	}

	// Unix absolute path: /path → file:///path (file:// + /path = file:///path)
	if (normalized.startsWith("/")) {
		return `file://${encodeFilePathComponents(normalized)}`;
	}

	// Not a recognized absolute path — return unchanged
	return pathOrUri;
}

/**
 * Convert a `file://` URI to a display-friendly filesystem path.
 *
 * | Input                           | Output                    |
 * |---------------------------------|---------------------------|
 * | `file:///C:/Users/tyler/Code`   | `C:/Users/tyler/Code`     |
 * | `file:///Users/tyler/Code`      | `/Users/tyler/Code`       |
 * | `file:///C%3A/Users/tyler`      | `C:/Users/tyler`          |
 * | `copilot:/session-1`            | `copilot:/session-1`      |
 * | `/plain/path`                   | `/plain/path`             |
 *
 * Percent-encoded characters are decoded. Windows drive letters are detected
 * and the leading slash is stripped so the path starts with `C:`.
 */
export function fileUriToDisplayPath(uri: string): string {
	if (!uri.startsWith("file:///")) return uri;

	try {
		const parsed = new URL(uri);
		const pathname = decodeURIComponent(parsed.pathname);

		// Windows: /C:/path → C:/path  (strip leading / before drive letter)
		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}

		// Unix: /path → /path
		return pathname;
	} catch {
		// Fallback for malformed URIs — best-effort decode
		const pathname = decodeURIComponent(uri.slice("file://".length));
		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}
		return pathname;
	}
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Percent-encode individual path components while preserving `/` separators
 * and the drive letter colon (e.g. `C:`).
 */
function encodeFilePathComponents(filePath: string): string {
	return filePath
		.split("/")
		.map((component) => {
			if (!component) return component;
			// Preserve Windows drive letter (e.g. "C:") — already safe in file URIs
			if (/^[a-zA-Z]:$/.test(component)) return component;
			return encodeURIComponent(component);
		})
		.join("/");
}
