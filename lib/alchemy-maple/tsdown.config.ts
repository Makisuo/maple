import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	deps: {
		neverBundle: ["effect", "alchemy"],
	},
})
