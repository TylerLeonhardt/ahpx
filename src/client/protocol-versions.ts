/**
 * Protocol versions offered in the `initialize` handshake.
 *
 * By default ahpx offers every compatibility baseline the official client
 * supports (`SUPPORTED_PROTOCOL_VERSIONS`, most preferred first) so a host can
 * select the highest one it speaks. Hosts built from unreleased AHP snapshots
 * (e.g. `0.10.0`, which accepts only `^0.10.0`) match none of the released
 * baselines; for those the offer can be overridden explicitly via the
 * `--protocol-version` flag or the {@link PROTOCOL_VERSIONS_ENV} env var.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { UsageError } from "../errors.js";

/** Env var holding a comma-separated override of the offered protocol versions. */
export const PROTOCOL_VERSIONS_ENV = "AHPX_PROTOCOL_VERSIONS";

/** Strict `MAJOR.MINOR.PATCH` — the same shape the AHP version registry accepts. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Split a comma-separated version list, dropping empty entries. */
export function parseProtocolVersionList(value: string): string[] {
	return value
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

/**
 * Resolve the protocol versions to offer, in priority order:
 * explicit option → {@link PROTOCOL_VERSIONS_ENV} → `SUPPORTED_PROTOCOL_VERSIONS`.
 *
 * @throws {UsageError} if an override is empty or contains a malformed version.
 */
export function resolveProtocolVersions(explicit?: readonly string[]): string[] {
	const envValue = process.env[PROTOCOL_VERSIONS_ENV];
	let versions: string[];
	let source: string;
	if (explicit !== undefined) {
		versions = [...explicit];
		source = "protocolVersions option";
	} else if (envValue !== undefined && envValue.trim() !== "") {
		versions = parseProtocolVersionList(envValue);
		source = PROTOCOL_VERSIONS_ENV;
	} else {
		return [...SUPPORTED_PROTOCOL_VERSIONS];
	}

	if (versions.length === 0) {
		throw new UsageError(`No protocol versions given in ${source}`);
	}
	const invalid = versions.filter((v) => !SEMVER.test(v));
	if (invalid.length > 0) {
		throw new UsageError(
			`Invalid protocol version(s) in ${source}: ${invalid.join(", ")} (expected MAJOR.MINOR.PATCH, e.g. 0.10.0)`,
		);
	}
	return versions;
}
