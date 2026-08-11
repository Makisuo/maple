import { assert, describe, it } from "@effect/vitest"
import { createMaplePgSocket, type MaplePgSocketHandle } from "@maple/db/client"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Effect, Exit, Fiber, Tracer } from "effect"
import type { DatabaseClient } from "./DatabaseLive"
import {
	makePgConnectionScope,
	PgConnectionScope,
	type PgConnectionScopeShape,
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
	readonly openSocket: () => MaplePgSocketHandle
	readonly creations: () => number
	readonly ends: () => number
}

const recorder = (): Recorder => {
	let creations = 0
	let ends = 0
	return {
		creations: () => creations,
		ends: () => ends,
		openSocket: () => {
			creations += 1
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
})

/** A scope that records release without opening anything. */
const countingScope = () => {
	let closes = 0
	const scope: PgConnectionScopeShape = {
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
