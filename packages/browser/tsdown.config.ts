import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
	},
	format: "esm",
	// `eager` is required, not a tuning knob: the entry re-exports types that
	// originate in `@maple/browser-session` (a private, source-consumed workspace
	// package). The plugin's lazy path resolves that package to a declaration
	// file it synthesized without those exports and fails with
	// "Export 'IdentifyInput' is not defined". Eager emission resolves them from
	// source. Same reason as lib/effect-sdk/tsdown.config.ts.
	dts: { eager: true },
	outDir: "dist",
})
