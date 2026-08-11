import { afterAll, assert, describe, it } from "@effect/vitest"
import { createMaplePgSocket } from "@maple/db/client"
import { sql } from "drizzle-orm"
import { Effect, Exit, Tracer } from "effect"
import type { DatabaseClient } from "@/platform/DatabaseLive"
import { makePgConnectionScope } from "@/platform/pg-connection-scope"
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

	/** Postgres tears backends down asynchronously, so settle rather than sample once. */
	const waitForBackends = async (expected: number): Promise<number> => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const n = await backends()
			if (n === expected) return n
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		return backends()
	}

	it("serves many executes from a single backend, and releases it on close", async () => {
		await waitForBackends(0)
		const scope = makePgConnectionScope(url)

		// Sampled AFTER each execute, not inside it: the client is lazy, so before
		// the first statement runs there is legitimately no connection yet.
		const observed: Array<number> = []
		try {
			for (let i = 0; i < 5; i++) {
				await Effect.runPromise(scope.run((db: DatabaseClient) => db.execute(sql`select 1 as one`)))
				observed.push(await backends())
			}
		} finally {
			await scope.close()
		}

		// The claim this rests on: five executes, one connection. Each of these
		// used to be its own handshake and its own outbound slot.
		assert.deepStrictEqual(observed, [1, 1, 1, 1, 1])
		assert.strictEqual(await waitForBackends(0), 0)
	})

	it("keeps concurrent executes on one backend and does not cross-attribute their SQL", async () => {
		await waitForBackends(0)
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

		const backendsDuring = await backends()

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
		assert.strictEqual(backendsDuring, 1)

		await scope.close()
	})

	it("runs a transaction and lets queued executes through behind it", async () => {
		await waitForBackends(0)
		const scope = makePgConnectionScope(url)
		const table = `scope_txn_${Date.now()}`

		await Effect.runPromise(
			scope.run((db: DatabaseClient) =>
				db.execute(sql.raw(`create table ${table} (id int primary key)`)),
			),
		)

		// With max: 1 a transaction holds the only connection. Anything queued
		// behind it must complete rather than deadlock — the risk flagged when the
		// pool size was fixed at one.
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
		assert.strictEqual(await backends(), 1)

		await Effect.runPromise(scope.run((db: DatabaseClient) => db.execute(sql.raw(`drop table ${table}`))))
		await scope.close()
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
			openSocket: () => {
				creations += 1
				return createMaplePgSocket("postgres://maple:maple@127.0.0.1:1/never", {
					maxConnections: 1,
				})
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
