import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// The `cloudflare:workers` virtual module only exists inside a Worker
			// isolate; stub it so worker-dependent services can be imported in node.
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// PGlite boots a WASM Postgres instance per test. Running DB-heavy files in
		// parallel makes the instances contend until otherwise-correct tests hit the
		// timeout (the failing file varies by run). Keep this package file-serial;
		// Effect-level concurrency inside each suite remains available.
		maxWorkers: 1,
		// Generous timeouts: the DB-backed suites boot a fresh PGlite (WASM) per
		// test and some retry tests run real exponential backoff. Under CI's
		// parallel `turbo test`, CPU starvation stretches these past the 5s
		// default — without headroom a starved-but-correct test gets killed, and
		// the abandoned fiber then queries the torn-down PGlite ("PGlite is closed").
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
