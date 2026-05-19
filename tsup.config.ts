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
	external: [
		"@microsoft/dev-tunnels-management",
		"@microsoft/dev-tunnels-connections",
		"@microsoft/dev-tunnels-contracts",
	],
	// Add shebang only to the CLI entry point (not the library).
	// Uses a Node.js script instead of shell commands for cross-platform support.
	onSuccess: "node scripts/postbuild.js",
});
