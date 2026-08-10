import { createMaplePgClient } from "@maple/db/client"
import type { Effect } from "effect"
import { type DatabaseClient, type DatabaseError, executeWithSpan } from "./DatabaseLive"

/**
 * Seconds a request-path dial may spend before postgres.js destroys the socket.
 *
 * Sized off production: `Database.execute` p50 is ~51ms and the alerting worker
 * — same code, same Hyperdrive config, 47x the volume — has a p95 of 1.5s, so
 * 2s cannot fire on a healthy dial. It exists because the driver default is
 * 30s, and a Worker holding a connection slot for 30s hurts the whole isolate
 * far more than a fast failure hurts the one request.
 */
const REQUEST_CONNECT_TIMEOUT_SECONDS = 2

/**
 * Workflow entrypoints run for minutes and dial once per run, so a
 * request-shaped bound would be wrong for them — but the driver's 30s default
 * is still longer than a dial should ever legitimately take.
 */
const WORKFLOW_CONNECT_TIMEOUT_SECONDS = 10

/**
 * Dials in progress in this isolate, sampled onto each span as
 * `db.connect.in_flight`.
 *
 * The open question this answers: whether a slow dial is slow on its own, or
 * slow because it is queued behind siblings competing for the isolate's
 * connection slots. Those two have different fixes, and the span cannot tell
 * them apart without this number.
 */
let dialsInFlight = 0

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
 * request that opened them. It also gives each call its own `onQuery` statement
 * collector, which is what keeps `db.query.text` correct under concurrency.
 * Transactions run inside one callback, so atomicity is unaffected.
 */
export const executeOnFreshPgClient = <T>(
	connectionString: string,
	fn: (db: DatabaseClient) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
) =>
	executeWithSpan(async (hooks) => {
		const { db, awaitConnected, end } = createMaplePgClient(connectionString, {
			maxConnections: 1,
			connectTimeoutSeconds: REQUEST_CONNECT_TIMEOUT_SECONDS,
			onQuery: hooks.collect,
		})
		dialsInFlight += 1
		hooks.record({ "db.connect.in_flight": dialsInFlight })
		try {
			// Establish the connection before running the query, so the span can
			// attribute handshake time separately — without this the dial and the
			// query are one opaque number and a stalled handshake is
			// indistinguishable from slow SQL, which is the ambiguity that made the
			// p95 investigation guesswork. Costs one extra round-trip per execute
			// (see `awaitConnected`); revisit once the tail is understood.
			await awaitConnected()
			hooks.markConnected()
			return await fn(db)
		} finally {
			dialsInFlight -= 1
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
	let connected = false
	const { db, awaitConnected, end } = createMaplePgClient(connectionString, {
		maxConnections: 1,
		connectTimeoutSeconds: WORKFLOW_CONNECT_TIMEOUT_SECONDS,
		onQuery: (query) => collector?.(query),
	})
	return {
		db,
		step: (fn) =>
			executeWithSpan(async (hooks) => {
				collector = hooks.collect
				try {
					// One dial serves the whole run, so only the first step pays for
					// it; the rest report `db.connect_ms` ~0 and `reused: true`.
					const reused = connected
					if (!connected) {
						await awaitConnected()
						connected = true
					}
					hooks.record({ "db.connect.reused": reused })
					hooks.markConnected()
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
 *
 * `markConnected` fires immediately: there is no dial to attribute here, so
 * without it the whole step would be miscounted as connect time.
 */
export const tracedPgConnectionFrom = (
	db: DatabaseClient,
	extraAttributes?: Record<string, unknown>,
): TracedPgConnection => ({
	db,
	step: (fn) =>
		executeWithSpan((hooks) => {
			hooks.markConnected()
			return fn(db)
		}, extraAttributes),
	end: () => Promise.resolve(),
})
