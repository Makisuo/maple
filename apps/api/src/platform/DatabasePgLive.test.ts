import { assert, describe, it } from "@effect/vitest"
import { layerFromEnvRecord } from "@maple/effect-cloudflare"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Tracer } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { layerPg } from "./DatabasePgLive"
import { PgConnectionScope, type PgConnectionScopeShape } from "./pg-connection-scope"

/**
 * A binding pointed at a closed local port.
 *
 * The fallback path really dials, so the test needs a dial that fails
 * immediately: 127.0.0.1:1 is refused by the OS rather than timing out, so the
 * test costs milliseconds instead of the `CONNECT_TIMEOUT_SECONDS` a blackholed
 * host would.
 */
const closedPortBinding = {
	MAPLE_DB: {
		connectionString: "postgres://maple:maple@127.0.0.1:1/never",
		host: "127.0.0.1",
		port: 1,
		database: "never",
	},
}

const databaseFor = (env: Record<string, unknown>) =>
	Effect.provide(Database, layerPg.pipe(Layer.provide(layerFromEnvRecord(env))))

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

const dbSpan = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.find((span) => span.attributes.get("db.system.name") === "postgresql")

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string =>
	Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "<succeeded>"

describe("layerPg", () => {
	it.effect("fails per execute when the stage has no MAPLE_DB binding", () =>
		Effect.gen(function* () {
			const database = yield* databaseFor({})

			const exit = yield* Effect.exit(database.execute(() => Promise.resolve("unreachable")))

			// Deliberately a per-call failure, not a layer-build failure: dying at
			// construction would 504 every route including /health, whereas this
			// leaves DB-free routes serving on stages with no database (PR previews).
			assert.isTrue(Exit.isFailure(exit))
			assert.include(failureMessage(exit), "No application database on this stage")
		}),
	)

	it.effect("uses a per-call client when no connection scope is installed", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* databaseFor(closedPortBinding)

			// The callback must issue a statement: the client is lazy, so a callback
			// that never queries would never reach the closed port and would succeed.
			const exit = yield* Effect.exit(
				database.execute((db) => db.execute(sql`select 1`)).pipe(Effect.withTracer(tracer)),
			)

			assert.isTrue(Exit.isFailure(exit))
			const span = dbSpan(spans)
			assert.isDefined(span)
			// A real dial against a closed port is what proves the fallback ran rather
			// than an installed scope — Workflow entrypoints and tests depend on this
			// branch still working.
			assert.strictEqual(span.attributes.get("db.connect.failed"), true)
			// The fallback is a scope one call long, so it always reports a fresh
			// connection. Reuse here would mean a socket outlived its invocation.
			assert.strictEqual(span.attributes.get("db.connect.reused"), false)
		}),
	)

	it.effect("uses the installed scope instead of dialing", () =>
		Effect.gen(function* () {
			let calls = 0
			const scope: PgConnectionScopeShape = {
				run: <T>(fn: (db: DatabaseClient) => Promise<T>) => {
					calls += 1
					return Effect.promise(() => fn(undefined as unknown as DatabaseClient))
				},
				close: () => Promise.resolve(),
			}
			const database = yield* databaseFor(closedPortBinding)

			const result = yield* database
				.execute(() => Promise.resolve("from the scope"))
				.pipe(Effect.provideService(PgConnectionScope, scope))

			// The binding points at a closed port, so a success here can only mean
			// the scope was used and nothing was dialed.
			assert.strictEqual(result, "from the scope")
			assert.strictEqual(calls, 1)
		}),
	)
})
