import { createMaplePgClient } from "@maple/db/client"
import type { Effect } from "effect"
import { type DatabaseClient, type DatabaseError, executeWithSpan } from "./DatabaseLive"

/**
 * Run one callback against its own Postgres client, inside the standard
 * `Database.execute` client span.
 *
 * This is the fallback path, used where no `PgConnectionScope` is installed:
 * the Workflow entrypoints (which can't take the Effect `Database` service,
 * since they run outside the worker's layer graph), tests, and any entry point
 * that has not been wrapped. Requests and cron ticks go through the scope
 * instead and share one client for the whole invocation.
 *
 * A client per call is correct but wasteful. Workers tie TCP sockets to the
 * request that opened them, so a connection may be reused freely WITHIN an
 * invocation — it just must not outlive it — and each connection here spends one
 * of the Worker's six outbound slots. Transactions run inside one callback, so
 * atomicity is unaffected either way.
 *
 * There is no dial budget and no retry. postgres.js connects on the first
 * statement, so there is no separate connect phase to bound or to re-attempt,
 * and retrying a statement that may already have committed would make writes
 * at-least-once. A connection failure surfaces as that statement's error and is
 * classified by `postgres-errors.ts` (`error.type` = `CONNECT_TIMEOUT`,
 * `ECONNREFUSED`, …).
 */
export const executeOnFreshPgClient = <T>(
	connectionString: string,
	fn: (db: DatabaseClient) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
) =>
	executeWithSpan(async (hooks) => {
		const { db, end } = createMaplePgClient(connectionString, {
			maxConnections: 1,
			onQuery: hooks.collect,
		})
		try {
			return await fn(db)
		} finally {
			// Never let a socket-teardown error shadow the real DB error from fn(db).
			await end().catch(() => undefined)
		}
	}, extraAttributes)

/**
 * A long-lived Postgres connection whose individual steps are still traced.
 *
 * The Workflow entrypoints hold one client for the whole run and thread it
 * through helpers, so they can't use `executeOnFreshPgClient` (that would
 * create a client per statement). `step()` wraps one logical unit of DB work in
 * the standard `Database.execute` client span instead.
 */
export interface TracedPgConnection {
	readonly db: DatabaseClient
	readonly step: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
	readonly end: () => Promise<void>
}

/**
 * Build a traced connection over a client this code owns.
 *
 * The statement collector is a slot rather than a per-call `onQuery` closure,
 * because one client serves every step. That is only correct while steps run
 * sequentially — which is what the Workflow entrypoints do (`await` per step,
 * each inside its own `step.do`). Concurrent steps would cross-attribute
 * `db.query.text`; if that ever changes, switch the caller to
 * `executeOnFreshPgClient`, which isolates the collector per call.
 */
export const makeTracedPgConnection = (
	connectionString: string,
	extraAttributes?: Record<string, unknown>,
): TracedPgConnection => {
	let collector: ((query: string) => void) | undefined
	const { db, end } = createMaplePgClient(connectionString, {
		maxConnections: 1,
		onQuery: (query) => collector?.(query),
	})
	return {
		db,
		step: (fn) =>
			executeWithSpan(async (hooks) => {
				collector = hooks.collect
				try {
					return await fn(db)
				} finally {
					collector = undefined
				}
			}, extraAttributes),
		end: () => end().catch(() => undefined),
	}
}

/**
 * Trace steps against a client someone else owns (the Workflow test seams pass
 * a PGlite-backed drizzle). No statement collector is available, so spans carry
 * kind, identity and timing but no `db.query.text`; `end` is a no-op because the
 * caller owns the connection.
 */
export const tracedPgConnectionFrom = (
	db: DatabaseClient,
	extraAttributes?: Record<string, unknown>,
): TracedPgConnection => ({
	db,
	step: (fn) => executeWithSpan(() => fn(db), extraAttributes),
	end: () => Promise.resolve(),
})
