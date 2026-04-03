/**
 * Cross-platform post-build script.
 * Prepends the Node.js shebang to dist/bin.js so it can be executed directly
 * on Unix systems. Replaces the Unix-only `printf` + shell substitution that
 * previously lived in tsup.config.ts onSuccess.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const binPath = "dist/bin.js";
const content = readFileSync(binPath, "utf8");

if (!content.startsWith("#!/")) {
	writeFileSync(binPath, `#!/usr/bin/env node\n${content}`);
}

// Ensure the binary is executable on Unix (no-op on Windows)
chmodSync(binPath, 0o755);
