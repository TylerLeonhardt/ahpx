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
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { createLogger } from "../logger.js";

const log = createLogger("file-serving");

/** JSON-RPC method-not-found code. */
const METHOD_NOT_FOUND = -32601;
/** AHP resource-access-denied code (used for read/list failures). */
const ACCESS_DENIED = -32008;

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
	 * Handle a reverse-RPC request from the server.
	 *
	 * Wire this into the official client via `setServerRequestHandler`. As of
	 * protocol 0.5.0 the server may request `file://` customization contents back
	 * from the client (`resourceRead`) and directory listings (`resourceList`).
	 *
	 * Returns the result on success, or throws an official {@link RpcError} so the
	 * client sends back a JSON-RPC error response (`-32601` for unknown methods,
	 * `-32008` for access-denied / read failures).
	 */
	async handleServerRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "resourceRead": {
				const uri = (params as { uri: string }).uri;
				return this.handleResourceRead(uri);
			}
			case "resourceList": {
				const uri = (params as { uri: string }).uri;
				return this.handleResourceList(uri);
			}
			default:
				throw new RpcError(METHOD_NOT_FOUND, `Unknown method: ${method}`);
		}
	}

	/**
	 * Check whether a resolved path is in the allowed set.
	 */
	isAllowed(resolvedPath: string): boolean {
		return this.allowedPaths.has(resolvedPath);
	}

	private async handleResourceRead(uri: string): Promise<{ data: string; encoding: string }> {
		try {
			const filePath = resolveAndValidatePath(uri, this.allowedPaths);
			const content = await fs.readFile(filePath);
			return {
				data: content.toString("base64"),
				encoding: "base64",
			};
		} catch (err) {
			if (err instanceof RpcError) throw err;
			throw new RpcError(ACCESS_DENIED, err instanceof Error ? err.message : String(err));
		}
	}

	private async handleResourceList(
		uri: string,
	): Promise<{ entries: Array<{ name: string; type: "file" | "directory" }> }> {
		try {
			const dirPath = resolveAndValidatePath(uri, this.allowedPaths);
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			return {
				entries: entries.map((e) => ({
					name: e.name,
					type: e.isDirectory() ? ("directory" as const) : ("file" as const),
				})),
			};
		} catch (err) {
			if (err instanceof RpcError) throw err;
			throw new RpcError(ACCESS_DENIED, err instanceof Error ? err.message : String(err));
		}
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
