import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		"index.server": "./src/index.server.ts",
		"index.client": "./src/index.client.ts",
		"server/index": "./src/server/index.ts",
		"client/index": "./src/client/index.ts",
		"cloudflare/index": "./src/cloudflare/index.ts",
	},
	format: "esm",
	// `eager` is required, not a tuning knob: the client entry re-exports types
	// that originate in `@maple/browser-session` (a private, source-consumed
	// workspace package). The plugin's lazy path resolves that package to a
	// declaration file it synthesized without those exports and fails with
	// "X is not exported by .../src/index.d.ts". Eager emission resolves them
	// from source. Costs ~2s.
	dts: { eager: true },
	outDir: "dist",
	deps: {
		neverBundle: ["effect"],
	},
})
