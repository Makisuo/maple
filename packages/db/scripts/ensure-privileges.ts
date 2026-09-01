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
 * Default privileges are keyed to the CREATING role, and the standalone path
 * cannot know which identity a later `drizzle-kit migrate` process will create
 * objects as — its own `SET ROLE postgres` is session-scoped, and only the
 * brokered prod connection persists the pin (`pinSessionRoleToPostgres` in
 * planetscale-connection.ts). So defaults are keyed to BOTH candidates: the
 * login role (while the session still is it), then `postgres` where membership
 * allows the switch. Whichever one migrate's connections end up creating as,
 * its defaults fire.
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
 * Defaults are keyed to EVERY role migrations might create objects as, not
 * just one: this script's `SET ROLE postgres` lasts only for its own session,
 * and `drizzle-kit migrate` runs later as a separate process whose connections
 * authenticate as the login role. Unless that login carries a persisted
 * `role=postgres` (the brokered prod path's `ALTER ROLE … SET role`, see
 * planetscale-connection.ts — the standalone stg path has no such guarantee),
 * its objects are created by the login role and postgres-keyed defaults never
 * fire — recreating exactly the owner-only-table outage this script prevents.
 *
 * PUBLIC is a keyword, not an identifier — it must never be quoted.
 */
export const defaultPrivilegeStatements = (owner: string): readonly string[] => {
	const ident = quoteIdent(owner)
	return [
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO PUBLIC`,
	]
}

export const sweepStatements: readonly string[] = [
	"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO PUBLIC",
	"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO PUBLIC",
]

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
		const runStatements = async (batch: readonly string[]): Promise<void> => {
			for (const statement of batch) {
				console.log(`  → ${statement}`)
				await sql.unsafe(statement)
			}
		}

		await runStatements(["GRANT USAGE ON SCHEMA public TO PUBLIC"])
		// Key defaults to the LOGIN role first, while the session still is it:
		// `ALTER DEFAULT PRIVILEGES FOR ROLE x` needs membership in x, and
		// `postgres` is not a member of its own members.
		const loginRole = await currentUser(sql)
		console.log(`→ Ensuring PUBLIC privileges for objects created by "${loginRole}"`)
		await runStatements(defaultPrivilegeStatements(loginRole))
		// Then as `postgres` where membership allows it, so the defaults are also
		// keyed to the role that creates prod's tables (the brokered path pins
		// migrations to run as postgres — see planetscale-connection.ts).
		try {
			await sql.unsafe("SET ROLE postgres")
		} catch {
			console.log("→ SET ROLE postgres not permitted — defaults keyed to the session role only")
		}
		const owner = await currentUser(sql)
		if (owner !== loginRole) {
			console.log(`→ Ensuring PUBLIC privileges for objects created by "${owner}"`)
			await runStatements(defaultPrivilegeStatements(owner))
		}
		await runStatements(sweepStatements)
		console.log(`\n✓ Privileges ensured — future tables are granted to PUBLIC at creation`)
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
