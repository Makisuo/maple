#!/usr/bin/env bun
/**
 * Make a PlanetScale Postgres branch grant correct privileges to new tables BY
 * ITSELF, so a plain `drizzle-kit migrate` can never again ship a table the
 * fleet cannot read.
 *
 * Run this BEFORE migrate (order matters — `ALTER DEFAULT PRIVILEGES` only
 * applies to objects created after it):
 *
 *   DATABASE_URL="$MAPLE_PG_URL" bun packages/db/scripts/ensure-privileges.ts
 *
 * `ps:apply-schema` calls `ensureRuntimePrivileges` directly, so the prod path
 * needs no separate invocation.
 *
 * ── Why PUBLIC, and why no runtime-role name ──────────────────────────────
 * Prod has four `pscale_api_*` login roles. Three are members of `postgres`
 * with rolinherit and so can read a postgres-owned table through inheritance;
 * `pscale_api_rg068pnctlxw` — the ingest gateway, which connects via PSBouncer
 * on 6432 rather than Hyperdrive — is NOT a member and reads only through
 * PUBLIC. That asymmetry is the whole shape of the 2026-07-29 outage: a new
 * table with owner-only privileges broke the gateway alone while the API and
 * alerting workers kept serving, so it hid for 21.7h.
 *
 * PUBLIC covers every consumer without naming any of them, which is what lets
 * this run with no configuration. The old approach needed MAPLE_PG_RUNTIME_ROLE
 * naming one specific role, and granting that role was never what kept the
 * fleet up.
 *
 * ── Why default privileges rather than a post-migrate grant sweep ─────────
 * A sweep has to be remembered on every path that ever runs DDL. Default
 * privileges are a property of the branch: once set, every subsequent
 * `CREATE TABLE` is born correct, including tables created by a rebuild
 * migration that DROPped its grants. The sweep below is kept only to heal
 * objects that predate this — it is idempotent and cheap.
 *
 * Default privileges are keyed to the CREATING role, so this pins the session to
 * `postgres` first (see `pinSessionRoleToPostgres` in planetscale-connection.ts,
 * which does the same for the brokered prod connection). Where that is not
 * permitted we fall back to keying them to the session's own role, which is
 * correct for stg / PR previews — there the migrate role and the runtime role
 * are the same identity.
 */
import * as Predicate from "effect/Predicate"
import postgres from "postgres"
import { fail } from "./planetscale-connection"

/**
 * Role names we are willing to interpolate as a quoted identifier — the value
 * comes from `SELECT current_user`, not user input, but is validated anyway.
 * PlanetScale roles are dotted (`pscale_api_<id>.<id>`); `.` is safe because we
 * always double-quote, where Postgres treats it as a literal character.
 */
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$.-]*$/

const quoteIdent = (role: string): string => {
	if (!ROLE_PATTERN.test(role)) {
		fail(`Refusing to use unsafe role name ${JSON.stringify(role)} (allowed: ${ROLE_PATTERN})`)
	}
	return `"${role}"`
}

/**
 * Statements are ordered: schema usage, then the default privileges that make
 * FUTURE objects correct, then the backfill sweep for existing ones.
 *
 * PUBLIC is a keyword, not an identifier — it must never be quoted.
 */
const statements = (owner: string): readonly string[] => {
	const ident = quoteIdent(owner)
	return [
		"GRANT USAGE ON SCHEMA public TO PUBLIC",
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO PUBLIC`,
		"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO PUBLIC",
		"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO PUBLIC",
	]
}

/** Ask the server — a PlanetScale URL username carries a routing suffix that is
 * stripped before the server sees it, so it is not a usable role name. */
const currentUser = async (sql: postgres.Sql): Promise<string> => {
	const [row] = await sql`SELECT current_user`
	const role: unknown = row?.current_user
	if (!Predicate.isString(role) || role.length === 0) {
		return fail("`SELECT current_user` returned no role")
	}
	return role
}

/**
 * Apply the privilege scaffolding on `connectionUrl`. Idempotent — safe to run
 * before every migrate.
 */
export const ensureRuntimePrivileges = async (connectionUrl: string): Promise<void> => {
	const sql = postgres(connectionUrl, { max: 1, fetch_types: false })
	try {
		// Own the objects as `postgres` where membership allows it, so the default
		// privileges are keyed to the role that will actually create prod's tables.
		try {
			await sql.unsafe("SET ROLE postgres")
		} catch {
			console.log("→ SET ROLE postgres not permitted — keying defaults to the session role")
		}
		const owner = await currentUser(sql)
		console.log(`→ Ensuring PUBLIC privileges (objects created by "${owner}")\n`)
		for (const statement of statements(owner)) {
			console.log(`  → ${statement}`)
			await sql.unsafe(statement)
		}
		console.log(`\n✓ Privileges ensured — future tables owned by "${owner}" are granted to PUBLIC`)
	} finally {
		await sql.end()
	}
}

// CLI entry (skipped when imported by ps:apply-schema).
if (import.meta.main) {
	const url = process.env.DATABASE_URL?.trim()
	if (!url) {
		fail("DATABASE_URL is not set — usage: DATABASE_URL=… bun scripts/ensure-privileges.ts")
	}
	await ensureRuntimePrivileges(url as string)
}
