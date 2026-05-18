/**
 * Reverse-RPC file serving — handles server requests for local files.
 *
 * When the client sends customization `file://` URIs to the server, the
 * server may request their contents back via reverse JSON-RPC requests.
 * This module handles `resourceRead` and `resourceList` requests from
 * the server, with security restrictions to only serve allowed files.
 */

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import type { IncomingRequest, ProtocolLayer } from "./protocol.js";

const log = createLogger("file-serving");

/**
 * Manages the set of file URIs the client has offered as customizations,
 * and handles reverse-RPC requests from the server to read those files.
 */
export class FileServingHandler {
	private readonly allowedPaths = new Set<string>();

	/**
	 * Register file URIs that the server is allowed to read.
	 * Call this after discovering customizations, passing the `file://` URIs
	 * from `discoverCustomizations()`.
	 */
	addAllowedUris(uris: string[]): void {
		for (const uri of uris) {
			try {
				const filePath = normalizedPathFromUri(uri);
				this.allowedPaths.add(filePath);
			} catch {
				// Skip malformed URIs
			}
		}
	}

	/**
	 * Clear all allowed paths (e.g. on disconnect).
	 */
	clearAllowedPaths(): void {
		this.allowedPaths.clear();
	}

	/**
	 * Register this handler on a ProtocolLayer to respond to incoming
	 * reverse-RPC requests from the server.
	 */
	register(protocol: ProtocolLayer): void {
		protocol.on("request", (req) => {
			this.handleRequest(protocol, req).catch((err) => {
				log.info("unhandled file-serving error", {
					method: req.method,
					error: String(err),
				});
			});
		});
	}

	/**
	 * Check whether a resolved path is in the allowed set.
	 */
	isAllowed(resolvedPath: string): boolean {
		return this.allowedPaths.has(resolvedPath);
	}

	private async handleRequest(protocol: ProtocolLayer, req: IncomingRequest): Promise<void> {
		try {
			switch (req.method) {
				case "resourceRead": {
					const params = req.params as { uri: string };
					const result = await this.handleResourceRead(params.uri);
					protocol.respond(req.id, result);
					break;
				}
				case "resourceList": {
					const params = req.params as { uri: string };
					const result = await this.handleResourceList(params.uri);
					protocol.respond(req.id, result);
					break;
				}
				default:
					protocol.respondError(req.id, -32601, `Unknown method: ${req.method}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			protocol.respondError(req.id, -32008, message);
		}
	}

	private async handleResourceRead(uri: string): Promise<{ data: string; encoding: string }> {
		const filePath = resolveAndValidatePath(uri, this.allowedPaths);
		const content = await fs.readFile(filePath);
		return {
			data: content.toString("base64"),
			encoding: "base64",
		};
	}

	private async handleResourceList(
		uri: string,
	): Promise<{ entries: Array<{ name: string; type: "file" | "directory" }> }> {
		const dirPath = resolveAndValidatePath(uri, this.allowedPaths);
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		return {
			entries: entries.map((e) => ({
				name: e.name,
				type: e.isDirectory() ? ("directory" as const) : ("file" as const),
			})),
		};
	}
}

/**
 * Convert a `file://` URI to a normalized absolute path.
 */
function normalizedPathFromUri(uri: string): string {
	if (!uri.startsWith("file://")) {
		throw new Error(`Not a file URI: ${uri}`);
	}
	return nodePath.resolve(fileURLToPath(uri));
}

/**
 * Resolve a URI to a local path and validate it against the allowed set.
 *
 * For `resourceRead`, the exact file must be in the allowed set.
 * For `resourceList`, the directory must contain at least one allowed file
 * (i.e., be a parent directory of an allowed path).
 */
function resolveAndValidatePath(uri: string, allowedPaths: Set<string>): string {
	const resolved = normalizedPathFromUri(uri);

	// Exact match — the file itself was offered as a customization
	if (allowedPaths.has(resolved)) {
		return resolved;
	}

	// Directory listing — allow if any allowed path is under this directory
	const dirPrefix = resolved.endsWith(nodePath.sep) ? resolved : resolved + nodePath.sep;
	for (const allowed of allowedPaths) {
		if (allowed.startsWith(dirPrefix)) {
			return resolved;
		}
	}

	log.info("file access denied — not in allowed set", { uri, resolved });
	throw new Error(`Access denied: ${uri} is not in the set of offered customization files`);
}
