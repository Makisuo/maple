import { createMaplePgClient } from "@maple/db/client"
import type { Effect } from "effect"
import { type DatabaseClient, type DatabaseError, executeWithSpan } from "./DatabaseLive"

/**
 * Run one callback against a freshly dialed Postgres client, inside the
 * standard `Database.execute` client span.
 *
 * This is the single instrumented Postgres entry point. `layerPg` uses it for
 * every request, and the Workflow entrypoints — which can't take the Effect
 * `Database` service, since they run outside the worker's layer graph — use it
 * too, so their queries produce the same spans instead of none at all.
 *
 * Dial-per-call is deliberate, not a limitation: Workers tie TCP sockets to the
 * request that opened them, and Hyperdrive keeps the warm origin pool so the
 * per-call handshake is cheap. It also gives each call its own `onQuery`
 * statement collector, which is what keeps `db.query.text` correct under
 * concurrency. Transactions run inside one callback, so atomicity is unaffected.
 */
export const executeOnFreshPgClient = <T>(
	connectionString: string,
	fn: (db: DatabaseClient) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
) =>
	executeWithSpan(async (collect) => {
		const { db, end } = createMaplePgClient(connectionString, {
			maxConnections: 1,
			onQuery: collect,
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
 * re-dial per statement). `step()` wraps one logical unit of DB work in the
 * standard `Database.execute` client span instead.
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
			executeWithSpan(async (collect) => {
				collector = collect
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
