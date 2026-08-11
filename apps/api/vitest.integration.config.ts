import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Integration suite — needs a live Postgres, so it is deliberately NOT part of
 * `vitest.config.ts` (`include: ["src/**\/*.test.ts"]`) and never runs under
 * `bun run test`.
 *
 * These cover what the unit suite structurally cannot: the unit tests inject an
 * `openSocket` seam, so "one socket per request" is only ever asserted against a
 * counter the test controls. Here it is asserted against `pg_stat_activity`.
 *
 * Run with:
 *   bun db:up
 *   MAPLE_TEST_PG_URL=postgres://maple:maple@localhost:5499/maple \
 *     bun run --cwd apps/api test:integration
 *
 * Without `MAPLE_TEST_PG_URL` the suite skips rather than fails, so a checkout
 * with no docker stays green.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["test/integration/**/*.test.ts"],
		pool: "threads",
		// No PGlite snapshot globalSetup here — these talk to a real server.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
