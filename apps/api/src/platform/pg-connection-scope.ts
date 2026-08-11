import { createMaplePgSocket, type MaplePgSocketHandle, wrapMaplePgClient } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect } from "effect"
import type { HttpMiddleware } from "effect/unstable/http"
import type { DatabaseClient, DatabaseError } from "./DatabaseLive"
import { executeWithSpan } from "./DatabaseLive"
import { resolveDbConnectionSource } from "./pg-connection-source"
import { CONNECT_ATTEMPT_TIMEOUT_SECONDS } from "./pg-execute"

/**
 * One socket per scope, never more.
 *
 * The constraint that actually bites is Cloudflare's cap of six simultaneous
 * outbound connections per Worker. `cache.match()` holds a slot until response
 * headers arrive and cannot be cancelled, and warehouse `fetch()` calls hold
 * theirs for 110ms to several seconds (measured — see lib/cache/src/edge-cache.ts).
 * Postgres dials queue behind them, which is why `db.connect_ms` is bimodal:
 * a dial either finds a free slot in ~12ms or never lands at all.
 *
 * Raising this trades directly against that budget, so it stays at 1 and
 * concurrent statements pipeline over the single connection instead.
 */
const SCOPE_MAX_CONNECTIONS = 1

/**
 * A per-request (or per-tick) Postgres connection, dialed at most once and
 * shared by every `Database.execute` inside the scope.
 */
export interface PgConnectionScopeShape {
	/** Run one logical DB call on the scope's socket, inside the standard client span. */
	readonly run: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
	/**
	 * Release the socket. Safe to call when nothing was ever dialed, and safe to
	 * call while a dial is still in flight — it waits for that dial rather than
	 * leaving an orphaned socket to land after the request is gone.
	 */
	readonly close: () => Promise<void>
}

/**
 * The scope in force for the current fiber, or `undefined` outside one.
 *
 * A reference rather than a service so `DatabasePgLive` can read it at call
 * time and fall back to dial-per-execute where no scope was installed
 * (Workflow entrypoints, tests, any future entry point that forgets to wrap).
 */
export class PgConnectionScope extends Context.Reference<PgConnectionScopeShape | undefined>(
	"@maple/api/platform/PgConnectionScope",
	{ defaultValue: () => undefined },
) {}

/**
 * Build a scope over one connection string.
 *
 * Dialing is lazy — a request that never touches the database never opens a
 * socket — and single-flighted, so concurrent first calls share one dial
 * instead of racing two into the same six-slot budget.
 */
export const makePgConnectionScope = (
	connectionString: string,
	extraAttributes?: Record<string, unknown>,
	/**
	 * Test seam: how to open one socket, given that attempt's dial budget in
	 * seconds. Real callers take the default. Same precedent as
	 * `tracedPgConnectionFrom`, which exists so the Workflow tests can drive a
	 * connection they own.
	 */
	openSocket: (connectTimeoutSeconds: number) => MaplePgSocketHandle = (connectTimeoutSeconds) =>
		createMaplePgSocket(connectionString, {
			maxConnections: SCOPE_MAX_CONNECTIONS,
			connectTimeoutSeconds,
		}),
): PgConnectionScopeShape => {
	let socket: MaplePgSocketHandle | undefined
	let pending: Promise<MaplePgSocketHandle> | undefined
	let dials = 0

	const dial = async (): Promise<MaplePgSocketHandle> => {
		let lastConnectError: unknown
		for (let attempt = 0; attempt < CONNECT_ATTEMPT_TIMEOUT_SECONDS.length; attempt++) {
			const handle = openSocket(CONNECT_ATTEMPT_TIMEOUT_SECONDS[attempt])
			dials += 1
			try {
				await handle.awaitConnected()
				return handle
			} catch (error) {
				// Dial-only retry, same invariant as `executeOnFreshPgClient`: nothing
				// has been issued on this socket, so re-dialing cannot re-run a
				// statement. Drop the dead socket before trying again so a failed
				// attempt does not hold its slot.
				lastConnectError = error
				await handle.end().catch(() => undefined)
			}
		}
		throw lastConnectError
	}

	const acquire = (): Promise<MaplePgSocketHandle> => {
		if (socket !== undefined) return Promise.resolve(socket)
		// A failed dial clears the memo so a later call in the same scope gets its
		// own budget rather than inheriting a poisoned one — matching what
		// dial-per-execute did before.
		pending ??= dial().then(
			(handle) => {
				socket = handle
				pending = undefined
				return handle
			},
			(error) => {
				pending = undefined
				throw error
			},
		)
		return pending
	}

	return {
		run: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan(async (hooks) => {
				const dialsBefore = dials
				const handle = await acquire()
				// `reused` is derived from whether this call actually dialed, not from
				// whether a socket existed on entry — otherwise concurrent first calls
				// would all claim to have dialed when only one of them did.
				hooks.record({ "db.connect.reused": dials === dialsBefore, "db.connect.dials": dials })
				hooks.markConnected()
				// Wrapped per call so each call's statements land in its own span.
				// One shared wrapper would cross-attribute `db.query.text` between
				// concurrent executes; the wrapper is cheap (relational config only).
				return await fn(wrapMaplePgClient(handle.sql, { onQuery: hooks.collect }))
			}, extraAttributes),

		close: async () => {
			if (pending !== undefined) await pending.catch(() => undefined)
			const open = socket
			socket = undefined
			pending = undefined
			if (open !== undefined) await open.end().catch(() => undefined)
		},
	}
}

/**
 * Install a connection scope for the duration of `program`.
 *
 * Stages with no application database resolve to `Unavailable`; those run
 * unwrapped so `DatabasePgLive` keeps reporting the missing binding per
 * `execute` instead of failing here.
 */
export const withPgConnectionScope = <A, E, R>(
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | WorkerEnvironment> =>
	Effect.gen(function* () {
		const env = yield* WorkerEnvironment
		const source = resolveDbConnectionSource(env)
		if (source._tag === "Unavailable") return yield* program

		const scope = makePgConnectionScope(source.connectionString, source.attributes)
		return yield* program.pipe(
			Effect.provideService(PgConnectionScope, scope),
			Effect.ensuring(Effect.promise(() => scope.close())),
		)
	})

/**
 * HTTP boundary for the scope: one socket per request.
 *
 * Also satisfies the api worker's standing requirement that SOME middleware be
 * present — `POST /mcp` hangs on Workers when `toWebHandler` is given none.
 */
export const pgConnectionMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) =>
	withPgConnectionScope(httpApp)
