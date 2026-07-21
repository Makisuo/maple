import { defineConfig } from "vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import tsconfigPaths from "vite-tsconfig-paths"

// The local Maple binary (`maple start`) serves this SPA from its own origin and
// owns the query and OTLP endpoints. In dev we run Vite standalone and proxy
// both route families to the running binary (default OTLP/HTTP port 4318).
const LOCAL_BINARY_URL = process.env.MAPLE_LOCAL_URL ?? "http://127.0.0.1:4318"

export default defineConfig({
	plugins: [tsconfigPaths(), tailwindcss(), viteReact()],
	// `@maple/ui` and this app each resolve their own `react`/`react-dom` copy in
	// the monorepo; dedupe so Base UI components (Popover, etc.) share a single
	// React instance — otherwise hooks throw "more than one copy of React".
	resolve: {
		dedupe: ["react", "react-dom"],
	},
	// Emit a static SPA. `dist/` is both deployed to local.maple.dev (the default
	// UI) and inlined into the `maple` binary as the `--offline` fallback (via
	// scripts/gen-ui-embed.ts → apps/cli/src/server/ui-embed.gen.ts).
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/local": {
				target: LOCAL_BINARY_URL,
				changeOrigin: true,
			},
			// Keep the connection hint same-origin in dev: exporters can post to
			// Vite's displayed origin and reach the binary just like /local/query.
			"/v1": {
				target: LOCAL_BINARY_URL,
				changeOrigin: true,
			},
		},
	},
})
