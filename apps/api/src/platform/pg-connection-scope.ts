import {
	createMaplePgSocket,
	type MaplePgSocketHandle,
	type MaplePgSocketOptions,
	wrapMaplePgClient,
} from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect } from "effect"
import type { HttpMiddleware } from "effect/unstable/http"
import type { DatabaseClient, DatabaseError } from "./DatabaseLive"
import { executeWithSpan } from "./DatabaseLive"
import { resolveDbConnectionSource } from "./pg-connection-source"

/**
 * Cloudflare's documented value for postgres.js behind Hyperdrive.
 *
 * `max` is a CEILING, not an allocation: postgres.js opens a second socket only
 * when a second statement is genuinely in flight, so a request that makes one
 * DB call still costs one connection. That is why a single value serves both
 * the request path (mostly one call per invocation) and the cron path (a tick
 * issuing thousands).
 *
 * This was 1 for one day, on the theory that Postgres should reserve at most
 * one of the Worker's six outbound slots. Reserving is not what `max` does, and
 * capping it serialized every statement in a cron tick behind one connection —
 * measured on identical queries, `SELECT actors` p50 928ms -> 5687ms and
 * `INSERT alert_rule_claims` p50 536ms -> 2989ms at flat volume. Head-of-line
 * blocking cost far more than the contention it was avoiding.
 */
export const MAX_CONNECTIONS = 5

/**
 * One dial attempt, bounded. No retry, no ladder.
 *
 * The bound exists for diagnosis as much as for latency: postgres.js only
 * raises `CONNECT_TIMEOUT` from `connectTimedOut()`, and its `timer()` is a
 * no-op when `connect_timeout` is unset — so with no bound a stalled dial hangs
 * for the whole invocation and lands with no `error.type` at all.
 *
 * 10s rather than the 2s that shipped briefly: 2s alone took production 5xx
 * from 0.06% to 5.01%, and the retry that followed existed only to compensate
 * for it. Dial latency is bimodal (p50 ~11ms, or dead), so a generous single
 * bound kills essentially only the dead ones.
 */
const CONNECT_TIMEOUT_SECONDS = 10

/**
 * A Postgres connection scoped to one invocation — a request, a cron tick, or a
 * Workflow run — created at most once and shared by every call inside it.
 *
 * This is the one primitive. `Database.execute` reaches it through
 * `PgConnectionScope`; `executeOnFreshPgClient` is it with a scope of one call;
 * the Workflow entrypoints hold one directly. There is no second implementation
 * of "open a socket, wrap it per call, put a span around it".
 */
export interface PgConnectionScopeApi {
	/** Run one logical DB call on the scope's connection, inside the standard client span. */
	readonly run: <T>(fn: (db: DatabaseClient) => Promise<T>) => Effect.Effect<T, DatabaseError>
	/** Release the connection. Safe when nothing was ever created, and safe to call twice. */
	readonly close: () => Promise<void>
}

/**
 * The scope in force for the current fiber, or `undefined` outside one.
 *
 * A reference rather than a service so `DatabasePgLive` can read it at call
 * time and fall back to a per-call scope where none was installed (Workflow
 * entrypoints, tests, any future entry point that forgets to wrap).
 */
export class PgConnectionScope extends Context.Reference<PgConnectionScopeApi | undefined>(
	"@maple/api/platform/PgConnectionScope",
	{ defaultValue: () => undefined },
) {}

/**
 * Test seam: how to create the scope's socket. Real callers pass nothing.
 *
 * It receives the options the real factory would have been given, so a test can
 * assert the pool ceiling and the dial bound without dialing anything. Both
 * have regressed in production before.
 */
export interface PgConnectionScopeSeams {
	readonly openSocket?: (options: MaplePgSocketOptions) => MaplePgSocketHandle
}

/**
 * Build a scope over one connection string.
 *
 * Cloudflare's documented Hyperdrive shape — one client per invocation, created
 * lazily, closed at the boundary — reached through a `Context.Reference`
 * because `Database.execute` is called from ~200 places that cannot each be
 * handed the client.
 *
 * There is no dial step and no retry. postgres.js connects on the first query,
 * so creating the client is synchronous and cannot fail; a connection problem
 * surfaces as that query's error, classified by `postgres-errors.ts`.
 */
export const makePgConnectionScope = (
	connectionString: string,
	extraAttributes?: Record<string, unknown>,
	seams?: PgConnectionScopeSeams,
): PgConnectionScopeApi => {
	const options: MaplePgSocketOptions = {
		maxConnections: MAX_CONNECTIONS,
		connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
	}
	const create =
		seams?.openSocket ?? ((opts: MaplePgSocketOptions) => createMaplePgSocket(connectionString, opts))
	const openSocket = () => create(options)

	let socket: MaplePgSocketHandle | undefined

	return {
		run: <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			executeWithSpan(async (hooks) => {
				// Lazy: an invocation that never touches the database never creates one.
				const reused = socket !== undefined
				const open = (socket ??= openSocket())
				hooks.record({ "db.connect.reused": reused })
				// Wrapped per call so each call's statements land in its own span.
				// One shared wrapper would cross-attribute `db.query.text` between
				// concurrent calls; the wrapper is cheap (relational config only).
				return await fn(wrapMaplePgClient(open.sql, { onQuery: hooks.collect }))
			}, extraAttributes),

		close: async () => {
			const open = socket
			socket = undefined
			if (open !== undefined) await open.end().catch(() => undefined)
		},
	}
}

/**
 * A scope over a client someone else owns — the Workflow test seams pass a
 * PGlite-backed drizzle. No statement collector is available, so spans carry
 * kind, identity and timing but no `db.query.text`; `close` is a no-op because
 * the caller owns the connection.
 */
export const pgConnectionScopeFrom = (
	db: DatabaseClient,
	extraAttributes?: Record<string, unknown>,
): PgConnectionScopeApi => ({
	run: (fn) => executeWithSpan(() => fn(db), extraAttributes),
	close: () => Promise.resolve(),
})

/**
 * Run one callback against its own connection, for callers with no scope
 * installed. A scope of exactly one call — same span, same socket handling,
 * released immediately.
 *
 * A connection per call is correct but wasteful, so entry points should install
 * a scope instead where they can. Workers tie TCP sockets to the invocation
 * that opened them, so a connection may be reused freely WITHIN one but must
 * never outlive it.
 */
export const executeOnFreshPgClient = <T>(
	connectionString: string,
	fn: (db: DatabaseClient) => Promise<T>,
	extraAttributes?: Record<string, unknown>,
): Effect.Effect<T, DatabaseError> =>
	Effect.suspend(() => {
		const scope = makePgConnectionScope(connectionString, extraAttributes)
		// Never let a socket-teardown error shadow the real DB error from fn(db).
		return scope.run(fn).pipe(Effect.ensuring(Effect.promise(() => scope.close())))
	})

/**
 * Run `program` against `scope`, releasing the connection however the program
 * settles — success, failure, or interruption. Split from
 * `withPgConnectionScope` so the release contract can be tested without a
 * connection string or a live server.
 */
export const withPgConnectionScopeOf = <A, E, R>(
	scope: PgConnectionScopeApi,
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
