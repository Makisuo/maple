import type { PGlite } from "@electric-sql/pglite"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

/** The raw postgres.js client — one TCP socket's worth of connection state. */
export type MaplePgSocket = ReturnType<typeof postgres>

/**
 * One client, without any drizzle wrapper bound to it.
 *
 * Split out from `MaplePgConnection` so a caller can hold ONE client across many
 * logical calls while still giving each call its own `onQuery` collector —
 * drizzle fixes its logger at construction, so collector isolation has to come
 * from a per-call `wrapMaplePgClient`, not from a per-call client.
 *
 * There is deliberately no "wait until connected" member. postgres.js connects
 * lazily on the first query, so a separate connect step can only be synthesized
 * with a `select 1`, and that round trip bought nothing but a telemetry split.
 * Its absence is what lets the request path create a client synchronously.
 */
export interface MaplePgSocketHandle {
	/** The raw postgres.js client. Wrap it per call with `wrapMaplePgClient`. */
	readonly sql: MaplePgSocket
	/** Closes the underlying postgres.js connection pool. */
	readonly end: () => Promise<void>
}

/** A socket plus a drizzle client bound to it, for callers that want both at once. */
export interface MaplePgConnection extends MaplePgSocketHandle {
	readonly db: MaplePgClient
}

export interface MaplePgSocketOptions {
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
}

export interface MaplePgClientOptions extends MaplePgSocketOptions {
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
 * Create one postgres.js client, for real Postgres (PlanetScale via Hyperdrive
 * in Workers, docker-compose Postgres in `wrangler dev`, direct URLs in
 * scripts).
 *
 * Creating one costs nothing: postgres.js connects lazily on the first query,
 * so this is synchronous and does not touch the network.
 *
 * Workers note: TCP sockets are tied to the request that opened them, so a
 * client may be reused freely WITHIN a request but must never outlive it. The
 * request path holds one of these per request (`maxConnections: 1`) and `end()`s
 * it at the boundary — see apps/api/src/platform/pg-connection-scope.ts.
 * `fetch_types: false` skips the pg_types round-trip (we only use built-in
 * types).
 *
 * `prepare: false` because the named-statement cache is per connection: a
 * request-lived client would have to re-issue every statement's Parse on the
 * next request anyway, and named statements are the classic way to pin a
 * connection in a pooler. Hyperdrive multiplexes client connections over its
 * origin pool, so the unnamed extended protocol is the safer default.
 */
export const createMaplePgSocket = (
	connectionString: string,
	options?: MaplePgSocketOptions,
): MaplePgSocketHandle => {
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
	return { sql, end: () => sql.end() }
}

/**
 * Bind a drizzle client to an already-dialed socket.
 *
 * Cheap enough to call per logical DB call — it only re-derives drizzle's
 * relational config, it does not touch the network. Calling it per call is what
 * keeps each call's `onQuery` collector isolated while they share one socket;
 * `DatabasePgliteLive` does the same thing over a shared PGlite instance for
 * exactly this reason.
 */
export const wrapMaplePgClient = (
	sql: MaplePgSocket,
	options?: Pick<MaplePgClientOptions, "onQuery">,
): MaplePgClient => drizzlePostgres(sql, { schema, logger: toDrizzleLogger(options?.onQuery) })

/** A freshly dialed socket with one drizzle client already bound to it. */
export const createMaplePgClient = (
	connectionString: string,
	options?: MaplePgClientOptions,
): MaplePgConnection => {
	const socket = createMaplePgSocket(connectionString, options)
	return { ...socket, db: wrapMaplePgClient(socket.sql, options) }
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
