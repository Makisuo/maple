#!/usr/bin/env bun
/**
 * Apply the Drizzle Postgres schema (packages/db/drizzle) to a PlanetScale
 * branch, brokering the connection through the PlanetScale CLI.
 *
 *   PLANETSCALE_ORG=<org> bun packages/db/scripts/planetscale-apply-schema.ts <branch>
 *
 *   # examples
 *   bun packages/db/scripts/planetscale-apply-schema.ts main     # prd
 *   bun packages/db/scripts/planetscale-apply-schema.ts stg
 *   bun packages/db/scripts/planetscale-apply-schema.ts pr-123
 *
 * Mints an ephemeral credential for the branch (direct port 5432 — DDL must NOT
 * go through the PSBouncer/Hyperdrive poolers), runs `drizzle-kit migrate`, then
 * revokes the credential. Idempotent: drizzle skips migrations already recorded
 * in `drizzle.__drizzle_migrations`, so re-running is a no-op on an up-to-date
 * branch.
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { ensureRuntimePrivileges } from "./ensure-privileges"
import { fail, resolveDatabase, withBranchConnection } from "./planetscale-connection"

const branch = process.argv[2]?.trim()
if (!branch) {
	fail("Usage: bun packages/db/scripts/planetscale-apply-schema.ts <branch>")
}

const packageDir = resolve(import.meta.dir, "..")

await withBranchConnection(branch as string, async (connectionUrl) => {
	// BEFORE migrate, not after: this installs default privileges, which only
	// apply to objects created after they are set. A fresh `CREATE TABLE` carries
	// OWNER privileges only and a table-rebuild migration DROPs grants outright,
	// so without this the ingest gateway — the one consumer that reads through
	// PUBLIC rather than by inheriting `postgres` — hits "permission denied for
	// table …" on anything the migration creates. A missing runtime grant makes
	// the gateway's startup probe fail and the process exit before serving traffic.
	await ensureRuntimePrivileges(connectionUrl)

	console.log(`\n→ Applying schema to ${resolveDatabase()}/${branch} via drizzle-kit migrate\n`)
	const proc = spawnSync("bun", ["run", "db:migrate"], {
		cwd: packageDir,
		env: { ...process.env, DATABASE_URL: connectionUrl },
		stdio: "inherit",
	})
	if (proc.status !== 0) {
		fail("drizzle-kit migrate failed")
	}
	console.log(`\n✓ Schema applied to ${resolveDatabase()}/${branch}`)
})
