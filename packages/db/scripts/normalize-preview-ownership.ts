#!/usr/bin/env bun
/**
 * Hand every object this deploy created on the PR-preview branch to `postgres`
 * — the step that makes the NEXT deploy's in-place reset possible.
 *
 * Each preview deploy authenticates as an ephemeral `pscale role create` role
 * (24h TTL, unique per run). PlanetScale does not allow granting `pscale_api_*`
 * roles to one another — `GRANT <old role> TO CURRENT_USER` fails with
 * "permission denied to grant role" for BOTH the replication and the plain
 * role (run 30051727304) — so a later run can never assume a prior run's role
 * to drop its objects, and reset-preview-branch.ts would always fail on the
 * prior run's publications/schemas and fall back to the ~9-minute
 * delete → recreate path.
 *
 * Every pscale role DOES inherit `postgres`, though. So after `drizzle-kit
 * migrate` + the runtime grant pass, this script (running as the run's main
 * role, a member of `postgres`) reassigns everything it owns to `postgres`:
 *
 *   REASSIGN OWNED BY CURRENT_USER TO postgres
 *
 * covering the drizzle migrations schema, every object in `public`, and
 * `electric_publication_default` in one statement. The next run's role then
 * owns all of it through its own `postgres` membership and the in-place reset
 * drops it without any role assumption. (Electric Cloud's per-service
 * publication is owned by the separate replication role — scripts/
 * electric-pr-branch.ts reassigns that one the same way after the source
 * activates.)
 *
 * Failure here is deliberately NON-FATAL: an un-normalized branch only means
 * the next deploy falls back to delete → recreate — it costs time, never
 * correctness — and failing the deploy over an optimization would be worse.
 *
 * Usage:  DATABASE_URL="$MAPLE_PG_URL" bun run --cwd packages/db db:normalize-preview
 */
import postgres from "postgres"

const main = async (): Promise<void> => {
	const url = process.env.DATABASE_URL?.trim()
	if (!url) {
		console.error("✗ DATABASE_URL is not set — pass the PR branch connection string (MAPLE_PG_URL)")
		process.exit(1)
	}
	const sql = postgres(url, { max: 1, fetch_types: false })
	try {
		const [who] = await sql`
			SELECT current_user AS role, pg_has_role(current_user, 'postgres', 'MEMBER') AS is_member`
		if (who?.role === "postgres") {
			console.log("✓ Already connected as postgres — nothing to reassign")
			return
		}
		if (who?.is_member !== true) {
			console.log(
				`⚠ ${String(who?.role)} is not a member of postgres — skipping ownership normalization (next deploy will use the delete → recreate fallback)`,
			)
			return
		}
		await sql.unsafe(`REASSIGN OWNED BY CURRENT_USER TO postgres`)
		console.log(`✓ Reassigned all objects owned by "${String(who?.role)}" to postgres`)
	} catch (error) {
		console.log(
			`⚠ Ownership normalization failed (${error instanceof Error ? error.message : String(error)}) — next deploy will use the delete → recreate fallback`,
		)
	} finally {
		await sql.end()
	}
}

await main()
