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
import { applyRuntimeGrants } from "./grant-runtime-role"
import { fail, resolveDatabase, withBranchConnection } from "./planetscale-connection"

const branch = process.argv[2]?.trim()
if (!branch) {
	fail("Usage: bun packages/db/scripts/planetscale-apply-schema.ts <branch>")
}

const packageDir = resolve(import.meta.dir, "..")

// The runtime app role (the role the deployed worker authenticates as through
// its Hyperdrive binding) differs from the ephemeral migration role used here.
// A fresh `CREATE TABLE` carries OWNER privileges only, and a table-rebuild
// migration DROPs the grants outright — so without the re-grant pass the app
// role hits "permission denied for table …" on the new table.
//
// This is a hard failure on prod, not a warning. On 2026-07-29 a `main` apply
// without MAPLE_PG_RUNTIME_ROLE created `org_spend_limits` with postgres-only
// grants; the ingest gateway's startup probe joins that table, could not read
// it, exited, burned Railway's 5 restart retries and stayed down — a 21.7h
// total ingest outage for every org. The skip printed a warning nobody saw.
const runtimeRole = process.env.MAPLE_PG_RUNTIME_ROLE?.trim()

// Branches serving deployed traffic, where a missing grant pass takes production
// down rather than merely inconveniencing a preview.
const PROTECTED_BRANCHES = new Set(["main", "stg"])

if (PROTECTED_BRANCHES.has(branch as string) && !runtimeRole) {
	fail(
		`Refusing to apply schema to "${branch}" without MAPLE_PG_RUNTIME_ROLE.\n\n` +
			"  New tables are created with owner-only privileges, so the deployed app role\n" +
			"  would get \"permission denied\" on anything this migration creates.\n\n" +
			"  Set it to the role embedded in the prod Hyperdrive connection, e.g.\n" +
			`    MAPLE_PG_RUNTIME_ROLE=<role> PLANETSCALE_ORG=<org> bun scripts/planetscale-apply-schema.ts ${branch}\n\n` +
			"  Discover the role with:\n" +
			"    SELECT DISTINCT grantee FROM information_schema.table_privileges\n" +
			"     WHERE table_name = 'org_ingest_keys';",
	)
}

await withBranchConnection(branch as string, async (connectionUrl) => {
	console.log(`→ Applying schema to ${resolveDatabase()}/${branch} via drizzle-kit migrate\n`)
	const proc = spawnSync("bun", ["run", "db:migrate"], {
		cwd: packageDir,
		env: { ...process.env, DATABASE_URL: connectionUrl },
		stdio: "inherit",
	})
	if (proc.status !== 0) {
		fail("drizzle-kit migrate failed")
	}
	console.log(`\n✓ Schema applied to ${resolveDatabase()}/${branch}`)

	if (runtimeRole) {
		console.log(`\n→ Re-granting runtime privileges to "${runtimeRole}"\n`)
		await applyRuntimeGrants(connectionUrl, runtimeRole)
	} else {
		// Only reachable for preview branches — PROTECTED_BRANCHES bail out above.
		console.warn(
			`\n⚠ MAPLE_PG_RUNTIME_ROLE not set — SKIPPING runtime grants on "${branch}". Anything this ` +
				'migration created is readable by its owner only, so a deployed app role would hit ' +
				'"permission denied for table …". Tolerated here because "' +
				`${branch}" is a preview branch; it is a hard error on ${[...PROTECTED_BRANCHES].join(" / ")}.`,
		)
	}
})
