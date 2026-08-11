import { afterEach, assert, describe, it } from "@effect/vitest"
import { orgOnboardingState } from "@maple/db"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit, Tracer } from "effect"
import { Database, executeWithSpan } from "./DatabaseLive"
import { PGLITE_DB_NAMESPACE } from "./DatabasePgliteLive"
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

/**
 * DB spans are renamed to their query summary once the SQL is known, so they can
 * no longer be found by name — `db.system.name` is the stable marker.
 */
const dbSpans = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.filter((span) => span.attributes.get("db.system.name") === "postgresql")

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
			assert.strictEqual(span.attributes.get("peer.service"), "planetscale-postgres")
			assert.strictEqual(span.attributes.get("db.namespace"), PGLITE_DB_NAMESPACE)
			// OTel wants the span named after its query, not after the call site.
			assert.strictEqual(span.name, "SELECT org_onboarding_state")
			assert.strictEqual(span.attributes.get("db.query.summary"), "SELECT org_onboarding_state")
			assert.strictEqual(span.attributes.get("db.operation.name"), "SELECT")
			assert.strictEqual(span.attributes.get("db.collection.name"), "org_onboarding_state")
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
			assert.strictEqual(span.attributes.get("db.response.returned_rows"), 0)
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
			assert.strictEqual(span.attributes.get("peer.service"), "planetscale-postgres")
			// The statement fired before failing, so the tapError path captured it —
			// including the rename and the derived operation/collection.
			assert.include(span.attributes.get("db.query.text") as string, "select broken from nowhere")
			assert.strictEqual(span.name, "SELECT nowhere")
			assert.strictEqual(span.attributes.get("db.operation.name"), "SELECT")
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
						await tx
							.select()
							.from(orgOnboardingState)
							.where(eq(orgOnboardingState.orgId, "org_tx_test"))
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
			// A multi-statement call is summarized by the joined text — the same
			// input the warehouse derives its fallback label from — so the leading
			// statement names the span.
			assert.strictEqual(span.name, "INSERT org_onboarding_state")
			assert.strictEqual(span.attributes.get("db.operation.name"), "INSERT")
		}).pipe(Effect.provide(createTestDb(trackedDbs).layer)),
	)

	it.effect("keeps the placeholder name when the call fails before any statement", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const database = yield* Database

			const exit = yield* database
				.execute(() => Promise.reject(new Error("connection refused")))
				.pipe(Effect.withTracer(tracer), Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.name, "Database.execute")
			assert.isUndefined(span.attributes.get("db.query.summary"))
			assert.isUndefined(span.attributes.get("db.operation.name"))
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

/**
 * `db.duration_ms` alone cannot distinguish a stalled connection handshake from
 * a slow query — the ambiguity that made the production p95 investigation
 * guesswork. These cover the split that resolves it.
 */
describe("Database execute failure classification", () => {
	// There is no connect/query split any more. postgres.js connects on the first
	// statement, so the split could only ever be synthesized by a `select 1` probe
	// that cost a round trip on every request. What it was used to infer — is this
	// a connection problem or a query problem — `error.type` states outright.
	it.effect("classifies a connection failure by class rather than by duration", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			const exit = yield* executeWithSpan(() =>
				Promise.reject(
					Object.assign(new Error("write CONNECT_TIMEOUT"), { code: "CONNECT_TIMEOUT" }),
				),
			).pipe(Effect.withTracer(tracer), Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("error.type"), "CONNECT_TIMEOUT")
			assert.strictEqual(span.attributes.get("db.connect.failed"), true)
			assert.isNumber(span.attributes.get("db.duration_ms"))
		}),
	)

	it.effect("classifies a statement failure separately, with its SQLSTATE", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			const exit = yield* executeWithSpan(() =>
				Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" })),
			).pipe(Effect.withTracer(tracer), Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("error.type"), "23505")
			assert.strictEqual(span.attributes.get("db.response.status_code"), "23505")
			assert.strictEqual(span.attributes.get("db.connect.failed"), false)
		}),
	)

	it.effect("merges attributes recorded by the body", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			yield* executeWithSpan((hooks) => {
				hooks.record({ "db.connect.reused": true })
				return Promise.resolve("ok")
			}).pipe(Effect.withTracer(tracer))

			const [span] = dbSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("db.connect.reused"), true)
		}),
	)
})
