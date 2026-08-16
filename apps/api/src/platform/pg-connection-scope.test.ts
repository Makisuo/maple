import { assert, describe, it } from "@effect/vitest"
import { createMaplePgSocket, type MaplePgSocketHandle, type MaplePgSocketOptions } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Effect, Exit, Fiber, Tracer } from "effect"
import type { DatabaseClient } from "./DatabaseLive"
import {
	executeOnFreshPgClient,
	makePgConnectionScope,
	PgConnectionScope,
	type PgConnectionScopeApi,
	PgConnectionScopeClosedError,
	pgConnectionScopeFrom,
	withPgConnectionScope,
	withPgConnectionScopeOf,
} from "./pg-connection-scope"

/**
 * A client that never touches the network.
 *
 * `sql` is a real postgres.js client because `wrapMaplePgClient` builds drizzle
 * over it — constructing one connects to nothing (postgres.js connects lazily on
 * the first statement), and these tests never issue one, so the port below is
 * never reached.
 */
const fakeSocket = (onEnd: () => void): MaplePgSocketHandle => {
	const real = createMaplePgSocket("postgres://maple:maple@127.0.0.1:1/never", {
		maxConnections: 1,
	})
	return {
		sql: real.sql,
		end: async () => {
			onEnd()
			await real.end().catch(() => undefined)
		},
	}
}

interface Recorder {
	readonly openSocket: (options: MaplePgSocketOptions) => MaplePgSocketHandle
	readonly creations: () => number
	readonly ends: () => number
	readonly lastOptions: () => MaplePgSocketOptions | undefined
}

const recorder = (): Recorder => {
	let creations = 0
	let ends = 0
	let lastOptions: MaplePgSocketOptions | undefined
	return {
		creations: () => creations,
		ends: () => ends,
		lastOptions: () => lastOptions,
		openSocket: (options) => {
			creations += 1
			lastOptions = options
			return fakeSocket(() => {
				ends += 1
			})
		},
	}
}

const noop = () => Promise.resolve("ok")

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

const dbSpans = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.filter((span) => span.attributes.get("db.system.name") === "postgresql")

describe("PgConnectionScope", () => {
	it.effect("creates one client and reuses it across every execute", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop)
			yield* scope.run(noop)
			yield* scope.run(noop)

			// The whole point: these used to be three connections.
			assert.strictEqual(rec.creations(), 1)
			yield* Effect.promise(() => scope.close())
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.effect("creates nothing for a scope that never touches the database", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* Effect.promise(() => scope.close())

			assert.strictEqual(rec.creations(), 0)
			assert.strictEqual(rec.ends(), 0)
		}),
	)

	it.effect("gives each execute its own drizzle client so statements cannot cross-attribute", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})
			const clients: Array<DatabaseClient> = []
			const capture = (db: DatabaseClient) => {
				clients.push(db)
				return Promise.resolve("ok")
			}

			yield* Effect.all([scope.run(capture), scope.run(capture)], { concurrency: 2 })

			// One client, two wrappers. A shared wrapper would share drizzle's logger
			// and put both calls' SQL on whichever span looked last.
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(clients.length, 2)
			assert.notStrictEqual(clients[0], clients[1])
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("reports reuse on the span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))
			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [first, second] = dbSpans(spans)
			assert.isDefined(first)
			assert.isDefined(second)
			assert.strictEqual(first.attributes.get("db.connect.reused"), false)
			assert.strictEqual(second.attributes.get("db.connect.reused"), true)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("carries the connection-source attributes onto every span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope(
				"postgres://unused",
				{ "db.namespace": "maple", "server.address": "cfg.hyperdrive.local" },
				{ openSocket: rec.openSocket },
			)

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.namespace"), "maple")
			assert.strictEqual(span.attributes.get("server.address"), "cfg.hyperdrive.local")
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("surfaces a failing statement without swallowing it", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			// With no probe there is no separate connect phase: a connection problem
			// arrives as the statement's own error, which is what `postgres-errors`
			// classifies.
			const exit = yield* Effect.exit(
				scope.run(() =>
					Promise.reject(
						Object.assign(new Error("write CONNECT_TIMEOUT"), {
							code: "CONNECT_TIMEOUT",
						}),
					),
				),
			)

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("opens the pool at Cloudflare's ceiling rather than serializing on one connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop)

			// This was 1 for one day and serialized every statement in a cron tick
			// behind a single connection — `SELECT actors` p50 928ms -> 5687ms at flat
			// volume. `max` is a ceiling, not a reservation.
			assert.strictEqual(rec.lastOptions()?.maxConnections, 5)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("bounds the dial so a stall is classifiable instead of unbounded", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop)

			// postgres.js only raises CONNECT_TIMEOUT from connectTimedOut(), and its
			// timer() is a no-op when the option is absent — unset, a stalled dial
			// hangs for the whole invocation and lands with no error.type at all.
			const connectTimeoutSeconds = rec.lastOptions()?.connectTimeoutSeconds
			assert.isDefined(connectTimeoutSeconds)
			assert.isAbove(connectTimeoutSeconds, 0)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("closes twice without opening a second connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop)
			yield* Effect.promise(() => scope.close())
			yield* Effect.promise(() => scope.close())

			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.effect("refuses a call that arrives after the scope closed instead of dialing again", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* scope.run(noop)
			yield* Effect.promise(() => scope.close())

			// The bug this replaces: `close` set the handle back to `undefined`, which
			// is also what "never dialed" looked like, so this call opened a second
			// socket after the invocation that owned it had ended — on Workers, past
			// the point where one may exist at all. Late work is a defect to report,
			// not a connection to open.
			const exit = yield* Effect.exit(scope.run(noop).pipe(Effect.withTracer(tracer)))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.connect.scope_state"), "closed")
			// Not a driver fault, so it must not land as an unlabelled database
			// error beside real ones.
			assert.strictEqual(span.attributes.get("error.type"), "SCOPE_CLOSED")
		}),
	)

	it.effect("keeps the closed-scope failure discriminable behind the DatabaseError channel", () =>
		Effect.gen(function* () {
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: recorder().openSocket,
			})

			yield* Effect.promise(() => scope.close())
			const error = yield* Effect.flip(scope.run(noop))

			// `run` stays typed as DatabaseError — ~200 call sites depend on that —
			// but the reason travels as a tagged cause instead of flattened prose.
			assert.strictEqual(error._tag, "@maple/api/lib/DatabaseError")
			assert.instanceOf(error.cause, PgConnectionScopeClosedError)
		}),
	)

	it.effect("refuses a first call after close without ever creating a connection", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			yield* Effect.promise(() => scope.close())
			const exit = yield* Effect.exit(scope.run(noop))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 0)
		}),
	)

	it.effect("closes an in-flight connection and refuses the calls that follow it", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, {
				openSocket: rec.openSocket,
			})

			// Close transitions to Closed before releasing, so a caller racing the
			// teardown is refused rather than handed a socket being ended underneath it.
			const running = yield* Effect.forkChild(scope.run(() => new Promise<string>(() => {})))
			yield* Effect.yieldNow
			yield* Effect.promise(() => scope.close())
			yield* Fiber.interrupt(running)

			const exit = yield* Effect.exit(scope.run(noop))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.creations(), 1)
			assert.strictEqual(rec.ends(), 1)
		}),
	)
})

describe("executeOnFreshPgClient", () => {
	it.effect("runs the callback and releases its connection", () =>
		Effect.gen(function* () {
			// No seam: this builds a real postgres.js client, which connects lazily.
			// Nothing here issues a statement, so the unroutable port is never dialed.
			const result = yield* executeOnFreshPgClient("postgres://maple:maple@127.0.0.1:1/never", noop)

			assert.strictEqual(result, "ok")
		}),
	)

	it.effect("releases its connection when the callback fails, and preserves the error", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				executeOnFreshPgClient("postgres://maple:maple@127.0.0.1:1/never", () =>
					Promise.reject(new Error("boom")),
				),
			)

			assert.isTrue(Exit.isFailure(exit))
		}),
	)
})

describe("pgConnectionScopeFrom", () => {
	it.effect("spans a client someone else owns and never closes it", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			let closed = false
			const owned = {
				end: () => {
					closed = true
				},
			} as DatabaseClient
			const scope = pgConnectionScopeFrom(owned)

			const seen: Array<DatabaseClient> = []
			const result = yield* scope
				.run((db) => {
					seen.push(db)
					return Promise.resolve("ok")
				})
				.pipe(Effect.withTracer(tracer))
			yield* Effect.promise(() => scope.close())

			assert.strictEqual(result, "ok")
			assert.strictEqual(seen[0], owned)
			assert.strictEqual(dbSpans(spans).length, 1)
			// The caller owns the connection; closing it here would pull it out from
			// under the Workflow that handed it over.
			assert.isFalse(closed)
		}),
	)
})

/** A scope that records release without opening anything. */
const countingScope = () => {
	let closes = 0
	const scope: PgConnectionScopeApi = {
		run: () => Effect.succeed("unused" as never),
		close: async () => {
			closes += 1
		},
	}
	return { scope, closes: () => closes }
}

describe("withPgConnectionScopeOf", () => {
	it.effect("releases the connection when the program succeeds", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()

			const result = yield* withPgConnectionScopeOf(scope, Effect.succeed("done"))

			assert.strictEqual(result, "done")
			assert.strictEqual(closes(), 1)
		}),
	)

	it.effect("releases the connection when the program fails, and preserves the error", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()

			const exit = yield* Effect.exit(withPgConnectionScopeOf(scope, Effect.fail("boom")))

			// A leak here is the worst case: the request is over, but its connection
			// is still holding one of the Worker's six outbound slots.
			assert.strictEqual(closes(), 1)
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("releases the connection when the program is interrupted", () =>
		Effect.gen(function* () {
			const { scope, closes } = countingScope()
			const fiber = yield* Effect.forkChild(withPgConnectionScopeOf(scope, Effect.never))

			yield* Effect.yieldNow
			yield* Fiber.interrupt(fiber)

			assert.strictEqual(closes(), 1)
		}),
	)

	it.effect("makes the scope visible to code inside and invisible outside", () =>
		Effect.gen(function* () {
			const { scope } = countingScope()

			const inside = yield* withPgConnectionScopeOf(scope, PgConnectionScope)
			const outside = yield* PgConnectionScope

			assert.strictEqual(inside, scope)
			assert.isUndefined(outside)
		}),
	)
})

describe("withPgConnectionScope", () => {
	const hyperdriveEnv = {
		MAPLE_DB: {
			connectionString: "postgres://maple:maple@cfg.hyperdrive.local:5432/maple",
			host: "cfg.hyperdrive.local",
			port: 5432,
			database: "maple",
		},
	}

	it.effect("installs a scope when the MAPLE_DB binding is present", () =>
		Effect.gen(function* () {
			const scope = yield* withPgConnectionScope(PgConnectionScope).pipe(
				Effect.provideService(WorkerEnvironment, hyperdriveEnv),
			)

			// Lazy: resolving the binding must not connect. Nothing here reaches the
			// network, and the host above does not resolve.
			assert.isDefined(scope)
		}),
	)

	it.effect("runs unwrapped on a stage with no application database", () =>
		Effect.gen(function* () {
			// PR previews bind no MAPLE_DB. Installing a scope here would have to
			// invent a connection string; instead the program runs without one and
			// DatabasePgLive keeps reporting the missing binding per execute, so
			// DB-free routes still serve.
			const scope = yield* withPgConnectionScope(PgConnectionScope).pipe(
				Effect.provideService(WorkerEnvironment, {}),
			)

			assert.isUndefined(scope)
		}),
	)
})
