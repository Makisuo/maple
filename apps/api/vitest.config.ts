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
		// Worker threads rather than the default forked processes. Measured on the
		// full suite at CI's 4 workers: 42.4s vs 45.2s wall, and 248s vs 292s of
		// user CPU — the saving is process startup and the per-worker module
		// registry, which threads share. `isolate` stays on: turning it off cut
		// import time by 60% but pushed test time up further and came out slower
		// overall (34.7s vs 29.9s at full local parallelism).
		pool: "threads",
		// Builds the post-migration PGlite data directory that createTestDb boots
		// from. See test/pglite-snapshot.ts — without it every test pays a full
		// initdb inside WASM.
		globalSetup: ["./test/global-setup.ts"],
		// Generous timeouts: the DB-backed suites boot a fresh PGlite (WASM) per
		// test and some retry tests run real exponential backoff. Under CI's
		// parallel `turbo test`, CPU starvation stretches these past the 5s
		// default — without headroom a starved-but-correct test gets killed, and
		// the abandoned fiber then queries the torn-down PGlite ("PGlite is closed").
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
