import { assert, describe, it } from "@effect/vitest"
import { createMaplePgSocket, type MaplePgSocketHandle } from "@maple/db/client"
import { Effect, Exit, Tracer } from "effect"
import type { DatabaseClient } from "./DatabaseLive"
import { makePgConnectionScope } from "./pg-connection-scope"
import { CONNECT_ATTEMPT_TIMEOUT_SECONDS } from "./pg-execute"

/**
 * A socket that never touches the network.
 *
 * `sql` is a real postgres.js client because `wrapMaplePgClient` builds drizzle
 * over it — constructing one dials nothing (postgres.js connects lazily), and
 * these tests never issue a statement, so the port below is never reached.
 */
const fakeSocket = (options: {
	readonly onConnect: () => Promise<void>
	readonly onEnd: () => void
}): MaplePgSocketHandle => {
	const real = createMaplePgSocket("postgres://maple:maple@127.0.0.1:1/never", {
		maxConnections: 1,
	})
	return {
		sql: real.sql,
		awaitConnected: options.onConnect,
		end: async () => {
			options.onEnd()
			await real.end().catch(() => undefined)
		},
	}
}

interface Recorder {
	readonly openSocket: (connectTimeoutSeconds: number) => MaplePgSocketHandle
	/** Dial budget passed to each attempt, in call order. */
	readonly budgets: Array<number>
	readonly ends: () => number
}

/** `failures` dial attempts reject before any subsequent attempt succeeds. */
const recorder = (failures = 0): Recorder => {
	const budgets: Array<number> = []
	let attempts = 0
	let ends = 0
	return {
		budgets,
		ends: () => ends,
		openSocket: (connectTimeoutSeconds) => {
			budgets.push(connectTimeoutSeconds)
			const shouldFail = attempts < failures
			attempts += 1
			return fakeSocket({
				onConnect: shouldFail
					? () => Promise.reject(new Error("write CONNECT_TIMEOUT"))
					: () => Promise.resolve(),
				onEnd: () => {
					ends += 1
				},
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
	it.effect("dials once and reuses the socket across every execute", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			yield* scope.run(noop)
			yield* scope.run(noop)
			yield* scope.run(noop)

			// The whole point: five calls used to mean five handshakes.
			assert.strictEqual(rec.budgets.length, 1)
			yield* Effect.promise(() => scope.close())
			assert.strictEqual(rec.ends(), 1)
		}),
	)

	it.effect("single-flights the dial when concurrent calls both find it cold", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			// Without the shared promise these race into two dials — two of the
			// Worker's six outbound slots for one logical connection.
			yield* Effect.all([scope.run(noop), scope.run(noop), scope.run(noop)], {
				concurrency: 3,
			})

			assert.strictEqual(rec.budgets.length, 1)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("retries a failed dial on the next budget and drops the dead socket", () =>
		Effect.gen(function* () {
			const rec = recorder(1)
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			const result = yield* scope.run(noop)

			assert.strictEqual(result, "ok")
			assert.deepStrictEqual(rec.budgets, [...CONNECT_ATTEMPT_TIMEOUT_SECONDS])
			// The failed attempt's socket is closed rather than left holding a slot.
			assert.strictEqual(rec.ends(), 1)
			yield* Effect.promise(() => scope.close())
			assert.strictEqual(rec.ends(), 2)
		}),
	)

	it.effect("fails the execute once every dial budget is spent", () =>
		Effect.gen(function* () {
			const rec = recorder(CONNECT_ATTEMPT_TIMEOUT_SECONDS.length)
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			const exit = yield* Effect.exit(scope.run(noop))

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(rec.budgets.length, CONNECT_ATTEMPT_TIMEOUT_SECONDS.length)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("gives each execute its own drizzle client so statements cannot cross-attribute", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)
			const clients: Array<DatabaseClient> = []
			const capture = (db: DatabaseClient) => {
				clients.push(db)
				return Promise.resolve("ok")
			}

			yield* Effect.all([scope.run(capture), scope.run(capture)], { concurrency: 2 })

			// One socket, two wrappers. A shared wrapper would share drizzle's logger
			// and put both calls' SQL on whichever span looked last.
			assert.strictEqual(rec.budgets.length, 1)
			assert.strictEqual(clients.length, 2)
			assert.notStrictEqual(clients[0], clients[1])
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("reports reuse and dial count on the span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))
			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [first, second] = dbSpans(spans)
			assert.isDefined(first)
			assert.isDefined(second)
			assert.strictEqual(first.attributes.get("db.connect.reused"), false)
			assert.strictEqual(second.attributes.get("db.connect.reused"), true)
			assert.strictEqual(second.attributes.get("db.connect.dials"), 1)
			yield* Effect.promise(() => scope.close())
		}),
	)

	it.effect("close is a no-op when nothing ever dialed", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const scope = makePgConnectionScope("postgres://unused", undefined, rec.openSocket)

			yield* Effect.promise(() => scope.close())

			assert.strictEqual(rec.budgets.length, 0)
			assert.strictEqual(rec.ends(), 0)
		}),
	)

	it.effect("carries the connection-source attributes onto every span", () =>
		Effect.gen(function* () {
			const rec = recorder()
			const { spans, tracer } = makeRecordingTracer()
			const scope = makePgConnectionScope(
				"postgres://unused",
				{ "db.namespace": "maple", "server.address": "cfg.hyperdrive.local" },
				rec.openSocket,
			)

			yield* scope.run(noop).pipe(Effect.withTracer(tracer))

			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.namespace"), "maple")
			assert.strictEqual(span.attributes.get("server.address"), "cfg.hyperdrive.local")
			yield* Effect.promise(() => scope.close())
		}),
	)
})
