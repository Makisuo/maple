import { createMaplePgSocket, type MaplePgSocketHandle, wrapMaplePgClient } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect } from "effect"
import type { HttpMiddleware } from "effect/unstable/http"
import type { DatabaseClient, DatabaseError } from "./DatabaseLive"
import { executeWithSpan } from "./DatabaseLive"
import { resolveDbConnectionSource } from "./pg-connection-source"

/**
 * One connection per scope, never more.
 *
 * Deliberately not the `max: 5` Cloudflare's Hyperdrive example uses. A Worker
 * gets six simultaneous outbound connections in total, and `cache.match()` holds
 * one until response headers arrive and cannot be cancelled, while warehouse
 * `fetch()` calls hold theirs for 110ms to several seconds — measured, with
 * numbers, in lib/cache/src/edge-cache.ts. Postgres competes with those for the
 * same six, so the pool size is capped independently of anything to do with
 * dialing. Concurrent statements pipeline over the single connection instead.
 */
const SCOPE_MAX_CONNECTIONS = 1

/**
 * A per-request (or per-tick) Postgres connection, created at most once and
 * shared by every `Database.execute` inside the scope.
 */
export interface PgConnectionScopeShape {
	/** Run one logical DB call on the scope's connection, inside the standard client span. */
	readonly run: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
	/** Release the connection. Safe when nothing was ever created. */
	readonly close: () => Promise<void>
}

/**
 * The scope in force for the current fiber, or `undefined` outside one.
 *
 * A reference rather than a service so `DatabasePgLive` can read it at call
 * time and fall back to a per-call client where no scope was installed
 * (Workflow entrypoints, tests, any future entry point that forgets to wrap).
 */
export class PgConnectionScope extends Context.Reference<PgConnectionScopeShape | undefined>(
	"@maple/api/platform/PgConnectionScope",
	{ defaultValue: () => undefined },
) {}

/**
 * Test seam: how to create the scope's client. Real callers pass nothing.
 * Same precedent as `tracedPgConnectionFrom`, which exists so the Workflow
 * tests can drive a connection they own.
 */
export interface PgConnectionScopeSeams {
	readonly openSocket?: () => MaplePgSocketHandle
}

/**
 * Build a scope over one connection string.
 *
 * This is Cloudflare's documented Hyperdrive shape — one client per request,
 * created lazily, closed at the boundary — reached through a `Context.Reference`
 * because `Database.execute` is called from ~200 places that cannot each be
 * handed the client.
 *
 * There is no dial step, no retry and no failure latch. postgres.js connects on
 * the first query, so creating the client is synchronous and cannot fail; a
 * connection problem surfaces as that query's error, classified by
 * `postgres-errors.ts`. The machinery that used to live here — a 2s/8s dial
 * budget, a retry for the budget, and a cooldown for the retry — was a chain of
 * compensations for a cap we imposed ourselves.
 */
export const makePgConnectionScope = (
	connectionString: string,
	extraAttributes?: Record<string, unknown>,
	seams?: PgConnectionScopeSeams,
): PgConnectionScopeShape => {
	const openSocket =
		seams?.openSocket ??
		(() => createMaplePgSocket(connectionString, { maxConnections: SCOPE_MAX_CONNECTIONS }))

	let socket: MaplePgSocketHandle | undefined

	return {
		run: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan(async (hooks) => {
				// Lazy: a request that never touches the database never creates one.
				const reused = socket !== undefined
				socket ??= openSocket()
				hooks.record({ "db.connect.reused": reused })
				// Wrapped per call so each call's statements land in its own span.
				// One shared wrapper would cross-attribute `db.query.text` between
				// concurrent executes; the wrapper is cheap (relational config only).
				return await fn(wrapMaplePgClient(socket.sql, { onQuery: hooks.collect }))
			}, extraAttributes),

		close: async () => {
			const open = socket
			socket = undefined
			if (open !== undefined) await open.end().catch(() => undefined)
		},
	}
}

/**
 * Run `program` against `scope`, releasing the connection however the program
 * settles — success, failure, or interruption. Split from
 * `withPgConnectionScope` so the release contract can be tested without a
 * connection string or a live server.
 */
export const withPgConnectionScopeOf = <A, E, R>(
	scope: PgConnectionScopeShape,
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	program.pipe(
		Effect.provideService(PgConnectionScope, scope),
		Effect.ensuring(Effect.promise(() => scope.close())),
	)

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

		return yield* withPgConnectionScopeOf(
			makePgConnectionScope(source.connectionString, source.attributes),
			program,
		)
	})

/**
 * HTTP boundary for the scope: one connection per request.
 *
 * Also satisfies the api worker's standing requirement that SOME middleware be
 * present — `POST /mcp` hangs on Workers when `toWebHandler` is given none.
 */
export const pgConnectionMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) =>
	withPgConnectionScope(httpApp)
