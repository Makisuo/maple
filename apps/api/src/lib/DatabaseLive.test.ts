import { afterEach, assert, describe, it } from "@effect/vitest"
import { orgOnboardingState } from "@maple/db"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit, Tracer } from "effect"
import { Database } from "./DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

/**
 * Records every span the runtime creates so tests can assert the DB span's
 * kind and attributes. NativeSpan keeps `kind` and `attributes` public.
 */
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
	spans.filter((span) => span.name === "Database.execute")

describe("Database execute span instrumentation", () => {
	it.effect("emits a Client-kind span with DB semconv attributes on success", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* Database

			const rows = yield* database
				.execute((db) =>
					db.select().from(orgOnboardingState).where(eq(orgOnboardingState.orgId, "org_span_test")),
				)
				.pipe(Effect.withTracer(tracer))

			assert.deepStrictEqual(rows, [])
			const [span, ...rest] = dbSpans(spans)
			assert.isDefined(span)
			assert.deepStrictEqual(rest, [])
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("db.system.name"), "postgresql")
			assert.strictEqual(span.attributes.get("peer.service"), "postgresql")
			const queryText = span.attributes.get("db.query.text")
			assert.isString(queryText)
			// Parameterized text: placeholder present, the literal param value absent.
			assert.include(queryText as string, "$1")
			assert.include(queryText as string, "org_onboarding_state")
			assert.notInclude(queryText as string, "org_span_test")
			assert.match(span.attributes.get("db.query.fingerprint") as string, /^[0-9a-f]{8}$/)
			assert.strictEqual(span.attributes.get("db.statement_count"), 1)
			assert.strictEqual(span.attributes.get("db.query.truncated"), false)
			assert.isNumber(span.attributes.get("db.duration_ms"))
			assert.strictEqual(span.attributes.get("result.rowCount"), 0)
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("keeps identity attributes and captured SQL on the error path", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* Database

			const exit = yield* database
				.execute((db) => db.execute(sql`select broken from nowhere`))
				.pipe(Effect.withTracer(tracer), Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			// Set at span declaration, so the edge exists for failed calls too.
			assert.strictEqual(span.attributes.get("db.system.name"), "postgresql")
			assert.strictEqual(span.attributes.get("peer.service"), "postgresql")
			// The statement fired before failing, so the tapError path captured it.
			assert.include(span.attributes.get("db.query.text") as string, "select broken from nowhere")
			assert.isNumber(span.attributes.get("db.duration_ms"))
			assert.strictEqual(span.status._tag, "Ended")
			assert.isTrue(span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("captures every statement of a transaction in one span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* Database
			const now = new Date()

			yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						await tx
							.insert(orgOnboardingState)
							.values({ orgId: "org_tx_test", createdAt: now, updatedAt: now })
						await tx.select().from(orgOnboardingState).where(eq(orgOnboardingState.orgId, "org_tx_test"))
					}),
				)
				.pipe(Effect.withTracer(tracer))

			const [span, ...rest] = dbSpans(spans)
			assert.isDefined(span)
			assert.deepStrictEqual(rest, [])
			assert.strictEqual(span.attributes.get("db.statement_count"), 2)
			const queryText = span.attributes.get("db.query.text") as string
			assert.include(queryText, "insert into")
			assert.include(queryText, "select")
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("isolates statement capture between concurrent executes", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* Database

			yield* Effect.all(
				[
					database.execute((db) =>
						db.select().from(orgOnboardingState).where(eq(orgOnboardingState.orgId, "org_a")),
					),
					database.execute((db) => db.execute(sql`select 1 as concurrent_probe`)),
				],
				{ concurrency: 2 },
			).pipe(Effect.withTracer(tracer))

			const texts = dbSpans(spans).map((span) => span.attributes.get("db.query.text") as string)
			assert.strictEqual(texts.length, 2)
			const selectSpan = texts.find((text) => text.includes("org_onboarding_state"))
			const probeSpan = texts.find((text) => text.includes("concurrent_probe"))
			assert.isDefined(selectSpan)
			assert.isDefined(probeSpan)
			assert.notInclude(selectSpan as string, "concurrent_probe")
			assert.notInclude(probeSpan as string, "org_onboarding_state")
			for (const span of dbSpans(spans)) {
				assert.strictEqual(span.attributes.get("db.statement_count"), 1)
			}
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)
})
