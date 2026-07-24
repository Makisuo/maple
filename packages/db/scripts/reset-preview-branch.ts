#!/usr/bin/env bun
/**
 * In-place SQL reset of a PlanetScale PR-preview branch — the fast path of
 * `scripts/planetscale-pr-branch.ts up`.
 *
 * A PS-DEV Postgres branch takes ~9 minutes to provision, so the preview deploy
 * no longer deletes + recreates `pr-<n>` on every push. Instead the branch
 * lives for the PR's lifetime and each deploy resets it to empty here, which
 * takes seconds. The reset must leave the database indistinguishable from a
 * fresh branch as far as `drizzle-kit migrate` is concerned:
 *
 *   1. `DROP SCHEMA drizzle` — the migrations journal, so migrate replays from
 *      0000 onto the empty DB.
 *   2. Drop every object INSIDE `public` (tables, views, sequences, routines,
 *      enums/domains) — but never `public` itself: it is owned by
 *      `pg_database_owner`, which cannot be granted, so `DROP SCHEMA public`
 *      is not reliably ours to run. Per-object drops only need the object
 *      owners, which we assume below.
 *   3. `DROP PUBLICATION` (all) — publications are database-level, so they
 *      survive the schema drops with an emptied table list. Left in place,
 *      0009_electric_publication's replayed `CREATE PUBLICATION` would hit
 *      duplicate_object and its DO/EXCEPTION guard would roll back the whole
 *      block, leaving an empty publication and no REPLICA IDENTITY FULL.
 *   4. Drop *inactive* replication slots — Electric's old slot holds WAL once
 *      its source is gone; on a long-lived branch that would pin WAL forever.
 *      (The slot of the still-attached previous Electric source is `active`
 *      at this point — its environment is torn down by electric-pr-branch.ts
 *      later in the same deploy — so it gets swept on the NEXT deploy.)
 *
 * Ownership: the previous deploy hands everything it created to `postgres`
 * before finishing (packages/db/scripts/normalize-preview-ownership.ts after
 * migrate; scripts/electric-pr-branch.ts for the Electric cloud publication),
 * and every pscale role inherits `postgres` — so this run's role owns the
 * prior run's objects through that membership and the drops below just work.
 * The `GRANT <owner> TO CURRENT_USER` loop that follows is a legacy
 * best-effort fallback for branches provisioned before normalization existed;
 * expect it to fail on PlanetScale (pscale_api_* roles are not grantable —
 * "permission denied to grant role", run 30051727304) — the drops that follow
 * are the real test, and their failure pushes the caller onto the
 * delete → recreate fallback.
 *
 * Exits non-zero if the reset cannot be completed; the caller falls back to
 * the slow delete + recreate path, so failure here costs time, not correctness.
 *
 * Usage:  DATABASE_URL="$MAPLE_PG_URL" bun run --cwd packages/db db:reset-preview
 */
import postgres from "postgres"

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

/**
 * Role/publication names are interpolated as quoted identifiers (they cannot be
 * bind parameters), so whitelist a conservative charset — same rationale as
 * grant-runtime-role.ts. PlanetScale roles are dotted; `.` is literal inside
 * double quotes.
 */
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_$.-]*$/

const quoteIdent = (name: string): string => {
	if (!IDENT_PATTERN.test(name)) {
		fail(`Refusing to interpolate unsafe identifier ${JSON.stringify(name)} (allowed: ${IDENT_PATTERN})`)
	}
	return `"${name}"`
}

const main = async () => {
	const url = process.env.DATABASE_URL?.trim()
	if (!url) {
		fail("DATABASE_URL is not set — pass the PR branch connection string (MAPLE_PG_URL)")
	}
	// Tripwire: this script empties whatever DATABASE_URL points at, and the
	// connected role inherits `postgres`, so nothing downstream would stop it
	// from gutting prod/stg. It is only ever meant for ephemeral PR-preview
	// branches, driven by CI.
	if (!process.env.CI && process.env.RESET_PREVIEW_CONFIRM !== "1") {
		fail(
			"Refusing to reset: this drops ALL objects in the target database. Set RESET_PREVIEW_CONFIRM=1 to confirm DATABASE_URL points at a disposable preview branch (CI runs set CI).",
		)
	}
	const sql = postgres(url as string, { max: 1, fetch_types: false })
	try {
		// Take on the previous run's ownership: every role owning the drizzle
		// schema, a publication, or anything inside public that we don't already
		// have (directly or by inheritance). Built-in pg_* roles can't have
		// explicit members, so they're excluded — objects owned by them aren't
		// the app's anyway.
		const owners = await sql<{ owner: string }[]>`
			SELECT DISTINCT r.rolname AS owner
			FROM (
				SELECT n.nspowner AS oid FROM pg_namespace n WHERE n.nspname = 'drizzle'
				UNION
				SELECT p.pubowner FROM pg_publication p
				UNION
				SELECT c.relowner FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public'
				UNION
				SELECT pr.proowner FROM pg_proc pr
				JOIN pg_namespace n ON n.oid = pr.pronamespace
				WHERE n.nspname = 'public'
				UNION
				SELECT t.typowner FROM pg_type t
				JOIN pg_namespace n ON n.oid = t.typnamespace
				WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
			) owned
			JOIN pg_roles r ON r.oid = owned.oid
			WHERE NOT pg_has_role(current_user, r.oid, 'USAGE')
				AND r.rolname NOT LIKE ${"pg\\_%"}
		`
		for (const { owner } of owners) {
			try {
				await sql.unsafe(`GRANT ${quoteIdent(owner)} TO CURRENT_USER`)
				console.log(`→ Assumed prior owner role "${owner}"`)
			} catch (error) {
				// Best-effort: if PS already reaped the role its objects belong to
				// a role we inherit, and the drops below succeed anyway.
				console.log(`… could not assume role "${owner}" (${(error as Error).message}); continuing`)
			}
		}

		const publications = await sql<{ pubname: string }[]>`SELECT pubname FROM pg_publication`
		for (const { pubname } of publications) {
			await sql.unsafe(`DROP PUBLICATION ${quoteIdent(pubname)}`)
			console.log(`→ Dropped publication "${pubname}"`)
		}

		await sql.unsafe(`DROP SCHEMA IF EXISTS "drizzle" CASCADE`)
		console.log(`→ Dropped drizzle migrations schema`)

		// Empty `public` object-by-object. Tables first with CASCADE (takes FKs
		// and dependent views along), then whatever remains of each class.
		// Composite row-types of tables vanish with their table, so the type
		// drop pass only targets standalone enums/domains (drizzle-kit's pgEnum).
		const dropObjects = async (
			label: string,
			listQuery: Promise<{ name: string }[]>,
			dropSql: (quoted: string) => string,
		): Promise<void> => {
			for (const { name } of await listQuery) {
				await sql.unsafe(dropSql(`"public".${quoteIdent(name)}`))
				console.log(`→ Dropped ${label} "${name}"`)
			}
		}
		await dropObjects(
			"table",
			sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`,
			(quoted) => `DROP TABLE IF EXISTS ${quoted} CASCADE`,
		)
		await dropObjects(
			"materialized view",
			sql`SELECT matviewname AS name FROM pg_matviews WHERE schemaname = 'public'`,
			(quoted) => `DROP MATERIALIZED VIEW IF EXISTS ${quoted} CASCADE`,
		)
		await dropObjects(
			"view",
			sql`SELECT viewname AS name FROM pg_views WHERE schemaname = 'public'`,
			(quoted) => `DROP VIEW IF EXISTS ${quoted} CASCADE`,
		)
		await dropObjects(
			"sequence",
			sql`SELECT c.relname AS name FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind = 'S'`,
			(quoted) => `DROP SEQUENCE IF EXISTS ${quoted} CASCADE`,
		)
		// Routines need their identity arguments to disambiguate overloads.
		const routines = await sql<{ signature: string; kind: string }[]>`
			SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS signature,
				CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
			FROM pg_proc p
			JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'public'
		`
		for (const { signature, kind } of routines) {
			await sql.unsafe(`DROP ${kind} IF EXISTS ${signature} CASCADE`)
			console.log(`→ Dropped ${kind.toLowerCase()} ${signature}`)
		}
		await dropObjects(
			"type",
			sql`SELECT t.typname AS name FROM pg_type t
				JOIN pg_namespace n ON n.oid = t.typnamespace
				WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')`,
			(quoted) => `DROP TYPE IF EXISTS ${quoted} CASCADE`,
		)

		// Extra schemas a migration may have created (`CREATE SCHEMA foo`). After
		// normalize-preview-ownership.ts they belong to `postgres` (or to a role
		// we inherit), so they are ours to drop; vendor/system schemas that came
		// with the branch are owned by neither and are left untouched. Without
		// this, the replayed CREATE SCHEMA migration would hit duplicate_object
		// on every reused-branch deploy — with no recreate fallback, because the
		// emptiness verification below only inspects `public`.
		const extraSchemas = await sql<{ nspname: string }[]>`
			SELECT n.nspname FROM pg_namespace n
			JOIN pg_roles r ON r.oid = n.nspowner
			WHERE n.nspname NOT IN ('public', 'information_schema')
				AND n.nspname NOT LIKE ${"pg\\_%"}
				AND (r.rolname = 'postgres' OR pg_has_role(current_user, r.oid, 'USAGE'))
		`
		for (const { nspname } of extraSchemas) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(nspname)} CASCADE`)
			console.log(`→ Dropped schema "${nspname}"`)
		}

		// The reset only succeeded if public is actually empty now — anything
		// left (an owner we couldn't assume, an object class this script doesn't
		// know) must push the caller onto the delete → recreate fallback.
		const [remaining] = await sql<{ count: string }[]>`
			SELECT count(*)::int AS count FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')
		`
		if (Number(remaining?.count ?? 0) > 0) {
			fail(`public schema still holds ${remaining?.count} objects after the drop pass`)
		}
		console.log(`→ public schema emptied`)

		// Drop replication slots orphaned by torn-down Electric sources.
		// pg_drop_replication_slot needs the REPLICATION attribute, which the
		// main role deliberately lacks (and which is never inherited through
		// `postgres` membership) — the caller passes the replication-role
		// connection string as REPLICATION_DATABASE_URL for this step.
		// Non-fatal either way, but a stale slot pins WAL for the branch's
		// whole lifetime, so a failure here is warned loudly.
		const slotUrl = process.env.REPLICATION_DATABASE_URL?.trim()
		const slotSql = slotUrl ? postgres(slotUrl, { max: 1, fetch_types: false }) : sql
		try {
			const slots = await slotSql<{ slot_name: string }[]>`
				SELECT slot_name FROM pg_replication_slots WHERE active = false
			`
			for (const { slot_name } of slots) {
				await slotSql`SELECT pg_drop_replication_slot(${slot_name})`
				console.log(`→ Dropped inactive replication slot "${slot_name}"`)
			}
		} catch (error) {
			console.log(
				`⚠ could not drop inactive replication slots (${(error as Error).message}) — a stale slot pins WAL for the branch's lifetime; continuing`,
			)
		} finally {
			if (slotSql !== sql) await slotSql.end()
		}

		console.log("✓ Preview branch reset to empty")
	} finally {
		await sql.end()
	}
}

await main()
