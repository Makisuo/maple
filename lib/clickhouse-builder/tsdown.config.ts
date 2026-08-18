import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		expr: "./src/expr.ts",
		types: "./src/ch/types.ts",
		sql: "./src/sql/index.ts",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	deps: {
		neverBundle: ["effect"],
	},
})
