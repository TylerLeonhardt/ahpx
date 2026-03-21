import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		bin: "src/bin.ts",
		index: "src/index.ts",
	},
	format: ["esm"],
	target: "node20",
	clean: true,
	dts: true,
	// Add shebang only to the CLI entry point (not the library)
	onSuccess: "printf '%s\\n' '#!/usr/bin/env node' \"$(cat dist/bin.js)\" > dist/bin.js",
});
