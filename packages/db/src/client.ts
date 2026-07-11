import type { PGlite } from "@electric-sql/pglite"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

export interface MaplePgConnection {
	readonly db: MaplePgClient
	/** Closes the underlying postgres.js connection pool. */
	readonly end: () => Promise<void>
}

export interface MaplePgClientOptions {
	readonly maxConnections?: number
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
 * and `end()` it when done — Hyperdrive owns the warm origin pool, making the
 * per-request handshake cheap. `fetch_types: false` skips the pg_types
 * round-trip (we only use built-in types).
 */
export const createMaplePgClient = (
	connectionString: string,
	options?: MaplePgClientOptions,
): MaplePgConnection => {
	const sql = postgres(connectionString, {
		max: options?.maxConnections ?? 5,
		fetch_types: false,
	})
	return {
		db: drizzlePostgres(sql, { schema, logger: toDrizzleLogger(options?.onQuery) }),
		end: () => sql.end(),
	}
}

export type MaplePgClient = ReturnType<typeof drizzlePostgres<typeof schema>>

/** Drizzle over an embedded PGlite instance — local dev and vitest. */
export const createMaplePgliteClient = (
	pglite: PGlite,
	options?: Pick<MaplePgClientOptions, "onQuery">,
) => drizzlePglite(pglite, { schema, logger: toDrizzleLogger(options?.onQuery) })

export type MaplePgliteClient = ReturnType<typeof createMaplePgliteClient>

/**
 * Canonical client type the app codes against. PostgresJsDatabase and
 * PgliteDatabase share the PgDatabase core; the PGlite layer casts into this
 * (same precedent as the old D1 layer).
 */
export type MapleDatabaseClient = MaplePgClient

export type MapleDatabaseTransaction = Parameters<Parameters<MaplePgClient["transaction"]>[0]>[0]
