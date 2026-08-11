import { afterAll, assert, describe, it } from "@effect/vitest"
import { createMaplePgSocket } from "@maple/db/client"
import { sql } from "drizzle-orm"
import { Effect, Exit, Tracer } from "effect"
import type { DatabaseClient } from "@/platform/DatabaseLive"
import { makePgConnectionScope, MAX_CONNECTIONS } from "@/platform/pg-connection-scope"
import { isPostgresConnectionError, postgresErrorType } from "@/platform/postgres-errors"

/**
 * These assertions are the reason this suite exists. The unit tests replace the
 * dial with a fake, so they can only prove the scope calls `openSocket` once —
 * not that one real TCP connection serves the whole request. Here the proof
 * comes from the server: a separate admin connection counts backends in
 * `pg_stat_activity`.
 */
const PG_URL = process.env.MAPLE_TEST_PG_URL

/** Admin connection targets `postgres`, so its own backend never pollutes the count. */
const adminUrlFor = (url: string): { admin: string; database: string } => {
	const parsed = new URL(url)
	const database = parsed.pathname.replace(/^\//, "")
	parsed.pathname = "/postgres"
	return { admin: parsed.toString(), database }
}

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

/**
 * `describe.skipIf` still evaluates the body, so the setup below needs a URL it
 * can parse even when the suite is skipped. Constructing a postgres.js client
 * dials nothing, so the placeholder never reaches the network.
 */
const PLACEHOLDER_URL = "postgres://skipped:skipped@127.0.0.1:1/skipped"

describe.skipIf(PG_URL === undefined)("PgConnectionScope against a real Postgres", () => {
	const url = PG_URL ?? PLACEHOLDER_URL
	const { admin: adminUrl, database } = adminUrlFor(url)
	const adminSocket = createMaplePgSocket(adminUrl, { maxConnections: 1 })

	afterAll(async () => {
		await adminSocket.end().catch(() => undefined)
	})

	/** Backends currently open against the test database, excluding the admin's own. */
	const backends = async (): Promise<number> => {
		const rows = await adminSocket.sql<Array<{ n: number }>>`
			select count(*)::int as n from pg_stat_activity where datname = ${database}
		`
		return rows[0]?.n ?? 0
	}

	/**
	 * Every assertion here is a DELTA against a baseline sampled at the start of
	 * the test, never an absolute count. The docker Postgres these run against is
	 * shared — a dev server or a previous run can hold tens of backends on the
	 * same database — and an absolute count turns that into a spurious failure
	 * about connection scoping.
	 */
	const settle = async (): Promise<number> => {
		let previous = await backends()
		for (let attempt = 0; attempt < 30; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100))
			const n = await backends()
			if (n === previous) return n
			previous = n
		}
		return previous
	}

	/** Wait for the scope's own backends to reach `expected`, ignoring ambient ones. */
	const waitForDelta = async (baseline: number, expected: number): Promise<number> => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const delta = (await backends()) - baseline
			if (delta === expected) return delta
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		return (await backends()) - baseline
	}

	it("serves many sequential executes from a single backend, and releases it on close", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)

		// Sampled AFTER each execute, not inside it: the client is lazy, so before
		// the first statement runs there is legitimately no connection yet.
		const observed: Array<number> = []
		try {
			for (let i = 0; i < 5; i++) {
				await Effect.runPromise(scope.run((db: DatabaseClient) => db.execute(sql`select 1 as one`)))
				observed.push((await backends()) - baseline)
			}
		} finally {
			await scope.close()
		}

		// The claim this rests on: five SEQUENTIAL executes, one connection. Each of
		// these used to be its own handshake and its own outbound slot. Raising the
		// pool ceiling does not change this — postgres.js opens a second socket only
		// when a second statement is actually in flight.
		assert.deepStrictEqual(observed, [1, 1, 1, 1, 1])
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("bounds concurrent executes by the pool ceiling and does not cross-attribute their SQL", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			Effect.all(
				[
					scope.run((db: DatabaseClient) => db.execute(sql`select 'alpha_marker' as tag`)),
					scope.run((db: DatabaseClient) => db.execute(sql`select 'beta_marker' as tag`)),
				],
				{ concurrency: 2 },
			).pipe(Effect.withTracer(tracer)),
		)

		const backendsDuring = (await backends()) - baseline

		// The real test of the per-call `wrapMaplePgClient`. Drizzle fixes its
		// logger at construction, so a single shared wrapper would put both
		// statements on whichever span looked last. The unit suite can only assert
		// the wrappers differ; this asserts the consequence that actually matters.
		const texts = dbSpans(spans).map((span) => String(span.attributes.get("db.query.text") ?? ""))
		assert.strictEqual(texts.length, 2)
		const alpha = texts.filter((text) => text.includes("alpha_marker"))
		const beta = texts.filter((text) => text.includes("beta_marker"))
		assert.strictEqual(alpha.length, 1)
		assert.strictEqual(beta.length, 1)
		assert.notInclude(alpha[0], "beta_marker")
		assert.notInclude(beta[0], "alpha_marker")

		// This asserted exactly 1 while the pool was capped at 1, which is the cap
		// that serialized cron ticks behind a single connection. The contract now is
		// a CEILING, not serialization: concurrent statements may open up to
		// `MAX_CONNECTIONS` and no more. How many of the two land together is a race
		// between them, so the lower bound is 1, not 2.
		assert.isAtLeast(backendsDuring, 1)
		assert.isAtMost(backendsDuring, MAX_CONNECTIONS)

		await scope.close()
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("overlaps concurrent statements instead of serializing them", async () => {
		// The regression this whole change exists for. With the pool capped at 1,
		// four 300ms statements queue head-to-tail and take ~1.2s; a cron tick issuing
		// thousands is what took `SELECT actors` from p50 928ms to 5687ms in
		// production. `pg_sleep` makes the serialization observable in wall time,
		// which no fake socket can do.
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const sleepSeconds = 0.3
		const concurrency = 4

		const startedAt = Date.now()
		await Effect.runPromise(
			Effect.all(
				Array.from({ length: concurrency }, () =>
					scope.run((db: DatabaseClient) => db.execute(sql`select pg_sleep(${sleepSeconds})`)),
				),
				{ concurrency },
			),
		)
		const elapsedMs = Date.now() - startedAt

		// Serialized would be >= 1200ms. Overlapped is one sleep plus scheduling.
		// The midpoint is a wide margin either way, so this is not timing-flaky.
		assert.isBelow(elapsedMs, sleepSeconds * 1000 * concurrency * 0.6)
		assert.isAtMost((await backends()) - baseline, MAX_CONNECTIONS)

		await scope.close()
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("runs a transaction and lets queued executes through beside it", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const table = `scope_txn_${Date.now()}`

		await Effect.runPromise(
			scope.run((db: DatabaseClient) =>
				db.execute(sql.raw(`create table ${table} (id int primary key)`)),
			),
		)

		// A transaction pins whichever connection it runs on for its whole duration.
		// Anything issued alongside it must still complete rather than deadlock —
		// the risk originally flagged when the pool was fixed at one, and still worth
		// holding now that the ceiling lets the sibling take its own connection.
		const [, queued] = await Effect.runPromise(
			Effect.all(
				[
					scope.run((db: DatabaseClient) =>
						db.transaction(async (tx) => {
							await tx.execute(sql.raw(`insert into ${table} (id) values (1)`))
							await tx.execute(sql.raw(`insert into ${table} (id) values (2)`))
						}),
					),
					scope.run((db: DatabaseClient) => db.execute(sql`select 'queued' as tag`)),
				],
				{ concurrency: 2 },
			),
		)

		assert.isDefined(queued)
		const rows = await Effect.runPromise(
			scope.run((db: DatabaseClient) => db.execute(sql.raw(`select count(*)::int as n from ${table}`))),
		)
		assert.strictEqual(Number((rows as unknown as Array<{ n: number }>)[0]?.n), 2)
		assert.isAtMost((await backends()) - baseline, MAX_CONNECTIONS)

		await Effect.runPromise(scope.run((db: DatabaseClient) => db.execute(sql.raw(`drop table ${table}`))))
		await scope.close()
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("classifies a refused connection as a connection error on a real socket", async () => {
		// Port 1 is refused immediately. This closes the loop on postgres-errors.ts,
		// which the unit suite only exercises against hand-built error objects, and
		// is the diagnostic that replaced the connect/query duration split.
		const scope = makePgConnectionScope("postgres://maple:maple@127.0.0.1:1/never")
		const { spans, tracer } = makeRecordingTracer()

		const exit = await Effect.runPromiseExit(
			scope.run((db: DatabaseClient) => db.execute(sql`select 1`)).pipe(Effect.withTracer(tracer)),
		)

		assert.isTrue(Exit.isFailure(exit))
		if (Exit.isFailure(exit)) {
			const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
			assert.isDefined(postgresErrorType(error as never))
			assert.isTrue(isPostgresConnectionError(error as never))
		}
		const [span] = dbSpans(spans)
		assert.isDefined(span)
		assert.strictEqual(span.attributes.get("db.connect.failed"), true)
		assert.isDefined(span.attributes.get("error.type"))

		await scope.close()
	})

	it("opens one connection for a whole fan-out against an unreachable origin", async () => {
		// The production shape this exists for: a request whose branches all miss
		// the org-config memo, against an origin that cannot be reached. Each branch
		// must reuse the scope's one client rather than creating its own — an
		// unreachable origin should cost one connection attempt's worth of outbound
		// slot, not N.
		//
		// Real clients, counted: `openSocket` wraps the production constructor
		// rather than replacing it, so this measures the same code path the unit
		// test fakes.
		let creations = 0
		const scope = makePgConnectionScope("postgres://maple:maple@127.0.0.1:1/never", undefined, {
			// The seam forwards the production options rather than inventing its own,
			// so this measures the same client the request path builds.
			openSocket: (options) => {
				creations += 1
				return createMaplePgSocket("postgres://maple:maple@127.0.0.1:1/never", options)
			},
		})

		// Sequential on purpose: a concurrent version would pass trivially. The case
		// that matters is the branch arriving after the previous failure resolved,
		// which must not decide to start over with a new client.
		const results: Array<"ok" | "rejected"> = []
		for (let i = 0; i < 10; i++) {
			results.push(
				await Effect.runPromise(scope.run((db: DatabaseClient) => db.execute(sql`select 1`)))
					.then(() => "ok" as const)
					.catch(() => "rejected" as const),
			)
		}

		assert.deepStrictEqual(
			results,
			Array.from({ length: 10 }, () => "rejected" as const),
		)
		assert.strictEqual(creations, 1)

		await scope.close()
	})
})
