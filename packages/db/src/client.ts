import type { PGlite } from "@electric-sql/pglite"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

export interface MaplePgConnection {
	readonly db: MaplePgClient
	/**
	 * Resolves once the connection is usable, so callers can time the dial
	 * separately from the query.
	 *
	 * This costs one `select 1` round-trip, which is not free and is not the
	 * first design we tried. postgres.js' `reserve()` looks like the zero-cost
	 * answer but silently never resolves under `fetch_types: false`: it passes
	 * the reservation as the connection's `initial` query, and the ReadyForQuery
	 * handler only re-enters (and so only calls `onopen`, which is what resolves
	 * the reservation) via the `needsTypes` branch. With type fetching off that
	 * branch is skipped, `initial` is dropped, and the promise hangs forever.
	 * Verified against postgres 3.4.9, src/connection.js:554-570.
	 *
	 * The probe goes through the raw postgres.js client rather than drizzle, so
	 * it never reaches the `onQuery` collector and cannot pollute
	 * `db.query.text`.
	 */
	readonly awaitConnected: () => Promise<void>
	/** Closes the underlying postgres.js connection pool. */
	readonly end: () => Promise<void>
}

export interface MaplePgClientOptions {
	readonly maxConnections?: number
	/**
	 * postgres.js `connect_timeout`, in SECONDS. Left unset the driver default of
	 * 30s applies, which is far longer than any Worker request should wait — see
	 * the caller in apps/api/src/platform/pg-execute.ts for why a bounded dial
	 * matters. This is the driver option rather than an `Effect.timeout` on
	 * purpose: interrupting the fiber does not cancel the underlying promise, so
	 * the socket would keep dialing and keep holding its connection slot. Only
	 * `connect_timeout` calls `socket.destroy()` and frees the slot.
	 */
	readonly connectTimeoutSeconds?: number
	/**
	 * Called once per executed statement with the parameterized SQL ($1
	 * placeholders — params are never inlined). Fires for statements inside
	 * `db.transaction` callbacks too; `BEGIN`/`COMMIT` are issued below drizzle
	 * and are not reported.
	 */
	readonly onQuery?: (query: string) => void
}

const toDrizzleLogger = (onQuery: ((query: string) => void) | undefined) =>
	onQuery ? { logQuery: (query: string, _params: unknown[]) => onQuery(query) } : undefined

/**
 * Drizzle over postgres.js, for real Postgres (PlanetScale via Hyperdrive in
 * Workers, docker-compose Postgres in `wrangler dev`, direct URLs in scripts).
 *
 * Workers note: TCP sockets are tied to the request that opened them, so
 * deployed Workers create a connection per `execute` (`maxConnections: 1`)
 * and `end()` it when done. `fetch_types: false` skips the pg_types
 * round-trip (we only use built-in types).
 *
 * `prepare: false` because the named-statement cache is per connection: a
 * client torn down after one `execute` writes the cache and discards it, so it
 * can never produce a second hit, and named statements are the classic way to
 * pin a connection in a pooler. Hyperdrive multiplexes client connections over
 * its origin pool, so the unnamed extended protocol is the safer default.
 */
export const createMaplePgClient = (
	connectionString: string,
	options?: MaplePgClientOptions,
): MaplePgConnection => {
	const connectTimeoutSeconds = options?.connectTimeoutSeconds
	const sql = postgres(connectionString, {
		max: options?.maxConnections ?? 5,
		fetch_types: false,
		prepare: false,
		// Spread rather than pass `undefined`: postgres.js coerces the option
		// through its integer parser, and an explicit undefined would not fall
		// back to the driver default.
		...(connectTimeoutSeconds === undefined ? {} : { connect_timeout: connectTimeoutSeconds }),
	})
	return {
		db: drizzlePostgres(sql, { schema, logger: toDrizzleLogger(options?.onQuery) }),
		awaitConnected: async () => {
			await sql`select 1`
		},
		end: () => sql.end(),
	}
}

export type MaplePgClient = ReturnType<typeof drizzlePostgres<typeof schema>>

/** Drizzle over an embedded PGlite instance — local dev and vitest. */
export const createMaplePgliteClient = (pglite: PGlite, options?: Pick<MaplePgClientOptions, "onQuery">) =>
	drizzlePglite(pglite, { schema, logger: toDrizzleLogger(options?.onQuery) })

export type MaplePgliteClient = ReturnType<typeof createMaplePgliteClient>

/**
 * Canonical client type the app codes against. PostgresJsDatabase and
 * PgliteDatabase share the PgDatabase core; the PGlite layer casts into this
 * (same precedent as the deployed Postgres layer).
 */
export type MapleDatabaseClient = MaplePgClient

export type MapleDatabaseTransaction = Parameters<Parameters<MaplePgClient["transaction"]>[0]>[0]
