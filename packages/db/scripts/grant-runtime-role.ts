#!/usr/bin/env bun
/**
 * Re-grant table/sequence privileges on a PlanetScale Postgres branch to the
 * RUNTIME app role (the role the deployed worker authenticates as through its
 * Hyperdrive binding) — distinct from the ephemeral `migrate-<branch>-<pid>`
 * role that runs DDL.
 *
 * Why this exists: schema migrations create (and table-rebuild data-migrations
 * DROP+CREATE) tables owned by the migration role / `postgres`. In Postgres,
 * `DROP TABLE` discards all grants and a fresh `CREATE TABLE` only carries owner
 * privileges — so after a rebuild the runtime role hits `permission denied for
 * table …` on every read/write until it is re-granted. Nothing in plain
 * `drizzle-kit migrate` does that, so we run this idempotent grant pass right
 * after every migrate.
 *
 * Two connection modes:
 *   1. DATABASE_URL set  → connect directly (stg / PR-preview CI, where the
 *      migrate step already has MAPLE_PG_URL). Runtime role defaults to the
 *      session's `current_user` (the managed Hyperdrive is built from the same
 *      URL, so this is a harmless self-grant) unless MAPLE_PG_RUNTIME_ROLE
 *      overrides. It must come from the session and NOT from the URL's
 *      username: PlanetScale connection strings carry a routing suffix
 *      (`<role>.<branch-id>`) that is stripped before the server sees it, so
 *      granting to the URL username fails with `role … does not exist`.
 *   2. branch arg only   → broker an ephemeral postgres-inheriting credential
 *      via `withBranchConnection` (prod `main`, applied out of band). The
 *      brokered URL's user is the migration role, NOT the runtime role, so
 *      MAPLE_PG_RUNTIME_ROLE is REQUIRED here.
 *
 * Usage:
 *   # prod (out of band, alongside ps:apply-schema main)
 *   MAPLE_PG_RUNTIME_ROLE=<role> PLANETSCALE_ORG=<org> \
 *     bun packages/db/scripts/grant-runtime-role.ts main
 *
 *   # against a direct connection string (stg / PR preview)
 *   DATABASE_URL="$MAPLE_PG_URL" bun packages/db/scripts/grant-runtime-role.ts
 */
import postgres from "postgres"
import { fail, resolveDatabase, withBranchConnection } from "./planetscale-connection"

/**
 * Postgres role names we accept. The role is interpolated into DDL as a quoted
 * identifier (it cannot be a bind parameter), so we whitelist a conservative
 * identifier charset and reject everything else rather than trust the input.
 * PlanetScale runtime roles are dotted (e.g. `pscale_api_<id>.<id>`); the `.` is
 * safe because we always double-quote, where Postgres treats it as a literal
 * character, not a schema separator.
 */
const RUNTIME_ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$.-]*$/

const quoteIdent = (role: string): string => {
	if (!RUNTIME_ROLE_PATTERN.test(role)) {
		fail(`Refusing to grant to unsafe role name ${JSON.stringify(role)} (allowed: ${RUNTIME_ROLE_PATTERN})`)
	}
	return `"${role}"`
}

/**
 * The grant pass: re-grant the runtime role on every existing table/sequence in
 * `public`. This is the reliable fix — it covers every object regardless of
 * owner and is re-applied after every migrate, so a table-rebuild migration that
 * strips grants is healed on the next deploy.
 *
 * We deliberately do NOT use `ALTER DEFAULT PRIVILEGES`: keyed to the ephemeral
 * migration role it vanishes when that role is dropped each run, and keyed to a
 * hardcoded owner (`postgres`) it breaks wherever the owner role is named
 * differently (local docker, self-grant stg). The explicit re-grant after every
 * migrate makes default privileges unnecessary.
 */
const grantStatements = (role: string): readonly string[] => {
	const ident = quoteIdent(role)
	return [
		`GRANT USAGE ON SCHEMA public TO ${ident}`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`,
		`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ident}`,
	]
}

/**
 * Open a short-lived connection on `connectionUrl` and apply the grant pass for
 * `role`. Idempotent — safe to re-run on every deploy.
 */
const sessionRole = async (sql: postgres.Sql): Promise<string> => {
	const [row] = await sql`SELECT current_user`
	const role: unknown = row?.current_user
	if (typeof role !== "string" || role.length === 0) {
		return fail("`SELECT current_user` returned no role — cannot determine who to grant to")
	}
	return role
}

export const applyRuntimeGrants = async (connectionUrl: string, explicitRole?: string): Promise<void> => {
	const sql = postgres(connectionUrl, { max: 1, fetch_types: false })
	try {
		// No explicit role → self-grant to whoever this connection authenticated
		// as. Asking the server (rather than parsing the URL) is what makes this
		// work on PlanetScale, whose usernames carry a routing suffix.
		const role = explicitRole ?? (await sessionRole(sql))
		console.log(`→ Granting runtime privileges to "${role}"\n`)
		for (const statement of grantStatements(role)) {
			console.log(`  → ${statement}`)
			await sql.unsafe(statement)
		}
		console.log(`✓ Runtime grants applied to "${role}"`)
	} finally {
		await sql.end()
	}
}

const requireRole = (): string => {
	const explicit = process.env.MAPLE_PG_RUNTIME_ROLE?.trim()
	if (explicit) return explicit
	return fail(
		"MAPLE_PG_RUNTIME_ROLE is not set — cannot determine the runtime app role to grant. " +
			"Set it to the role embedded in the prod Hyperdrive (maple-db) connection.",
	)
}

// CLI entry (skipped when imported by ps:apply-schema).
if (import.meta.main) {
	const directUrl = process.env.DATABASE_URL?.trim()
	if (directUrl) {
		// Mode 1: direct connection. Without an override the grant targets the
		// session's own role — the managed Hyperdrive (stg / PR preview) is built
		// from this same URL, so that self-grant is a no-op which future-proofs
		// against the runtime/migrate roles ever diverging.
		console.log("→ Granting runtime privileges via DATABASE_URL")
		await applyRuntimeGrants(directUrl, process.env.MAPLE_PG_RUNTIME_ROLE?.trim() || undefined)
	} else {
		// Mode 2: broker an ephemeral credential for the branch (prod path).
		const branch = process.argv[2]?.trim()
		if (!branch) {
			fail("Usage: DATABASE_URL=… grant-runtime-role.ts   OR   grant-runtime-role.ts <branch>")
		}
		const role = requireRole()
		await withBranchConnection(branch as string, async (connectionUrl) => {
			console.log(`→ Granting runtime privileges to "${role}" on ${resolveDatabase()}/${branch}\n`)
			await applyRuntimeGrants(connectionUrl, role)
		})
	}
}
