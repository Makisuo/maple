import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { aiTriageSettings, investigations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { maybeEnqueueTriage } from "./ai-triage-enqueue"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const testDb = createTestDb(createdDbs)
	return testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_enqueue_test")

const enableSettings = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: true,
			maxRunsPerDay: 2,
			updatedAt: new Date(nowMs),
		}),
	)
})

/**
 * Every incident is planned now, so a start needs the workflow binding as well as
 * the chat one. A caller that supplies only the chat binding is exercising the
 * missing-binding path — which is what several of these tests were doing by
 * accident once the routing default flipped.
 */
/**
 * Every start needs the workflow binding, because every incident is planned.
 * Omitting it is not "the cheap path" — it is the missing-binding failure, which
 * is deliberate: a run that was planned and quietly executed as one shallow pass
 * would be a lie in the boards.
 */
const baseInput = (incidentId: string, fanoutBinding?: unknown) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error" },
	fanoutBinding,
})

/**
 * Automation on, everything else default — which now means planned. There is no
 * fan-out flag to set: the one this replaced defaulted false and had no write
 * path, so every test that "enabled" it was exercising a state production could
 * never reach.
 */
const enableAutomation = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: true,
			maxRunsPerDay: 20,
			updatedAt: new Date(nowMs),
		}),
	)
})

/**
 * Both ceilings, explicitly. The reserve is a fraction of the pass ceiling, so a
 * test about it has to pin that number rather than inherit a default whose whole
 * point is to be large.
 */
const enableWithLimits = (maxRunsPerDay: number, maxPassesPerDay: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(aiTriageSettings).values({
				orgId: ORG,
				enabled: true,
				maxRunsPerDay,
				maxPassesPerDay,
				updatedAt: new Date(nowMs),
			}),
		)
	})

const fakeFanoutWorkflow = () => {
	const created: Array<{ id: string; params: Record<string, unknown> }> = []
	return {
		created,
		binding: {
			create: async (input: { id: string; params: Record<string, unknown> }) => {
				created.push(input)
				return { id: input.id }
			},
		},
	}
}

/** A critical incident. Severity now sizes the plan; it no longer gates it. */
/** A critical incident. Severity now sizes the plan; it no longer gates it. */
const criticalInput = (fanoutBinding: unknown, incidentId: string) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error", severity: "critical", serviceName: "checkout-api" },
	fanoutBinding,
})

describe("maybeEnqueueTriage", () => {
	it.effect("dispatches a critical automatic incident to the planned workflow", () =>
		Effect.gen(function* () {
			yield* enableAutomation
			const workflow = fakeFanoutWorkflow()

			const result = yield* maybeEnqueueTriage(criticalInput(workflow.binding, "incident-critical"))
			assert.isTrue(result.enqueued)
			assert.lengthOf(workflow.created, 1)
			assert.strictEqual(workflow.created[0]!.params.maxWidth, 5)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "queued")
			assert.strictEqual(rows[0]?.fanoutSize, 5)
			// Reserved high — planner + width + validator — and reconciled downward by
			// the workflow once the planner has produced a real width.
			assert.strictEqual(rows[0]?.autonomousTurns, 7)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The regression that started the rework. Severity used to *gate* the
	 * multi-hypothesis path, so anything below critical — and every error incident,
	 * which carries no severity at all — silently got one shallow pass.
	 */
	it.effect("plans a low-severity incident too, just more narrowly", () =>
		Effect.gen(function* () {
			yield* enableAutomation
			const workflow = fakeFanoutWorkflow()

			const result = yield* maybeEnqueueTriage({
				...criticalInput(workflow.binding, "incident-low"),
				context: { kind: "error", severity: "low" },
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(workflow.created, 1)
			assert.strictEqual(workflow.created[0]!.params.maxWidth, 3)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("records agent_unavailable when the workflow binding is missing", () =>
		Effect.gen(function* () {
			yield* enableAutomation

			const result = yield* maybeEnqueueTriage(criticalInput(undefined, "incident-nobinding"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "agent_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does nothing when the org has not opted in", () =>
		Effect.gen(function* () {
			const workflow = fakeFanoutWorkflow()
			const result = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.deepStrictEqual(result, { enqueued: false, reason: "disabled" })
			assert.lengthOf(workflow.created, 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("enqueues once and dedups subsequent calls for the same incident", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const workflow = fakeFanoutWorkflow()

			const first = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isTrue(first.enqueued)
			assert.lengthOf(workflow.created, 1)
			assert.strictEqual(workflow.created[0]?.id, first.investigationId)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.strictEqual(second.investigationId, first.investigationId)
			assert.lengthOf(workflow.created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the daily cap", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const workflow = fakeFanoutWorkflow()
			const start = (id: string) => maybeEnqueueTriage(baseInput(id, workflow.binding))

			// `maxRunsPerDay` is 2 here, and a planned run reserves 6 passes against a
			// 1000-pass default — so the runs ceiling is what bites first.
			assert.isTrue((yield* start("incident-1")).enqueued)
			assert.isTrue((yield* start("incident-2")).enqueued)
			assert.deepStrictEqual(yield* start("incident-3"), {
				enqueued: false,
				reason: "daily_cap",
			})
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * No fallback, on purpose. A run planned as several hypotheses that quietly
	 * executed as one shallow pass would be indistinguishable on the boards from a
	 * real investigation.
	 */
	it.effect("marks the run failed when no workflow binding is available", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database

			const result = yield* maybeEnqueueTriage(baseInput("incident-1"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "agent_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks a stranded investigation failed with a retryable reason", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const nowMs = yield* Clock.currentTimeMillis
			const workflow = fakeFanoutWorkflow()

			// First start claims the slot, then we simulate a run that stopped making
			// progress past its budget. A planned run gets the 25-minute fan-out
			// budget, not the single pass's 15 — it has a planner, N lanes and a
			// validator to get through.
			const first = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "investigating",
						startedAt: new Date(nowMs - 26 * 60 * 1000),
						updatedAt: new Date(nowMs - 26 * 60 * 1000),
					})
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.id, first.investigationId)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "retry")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does not reclaim a fresh non-terminal run", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const workflow = fakeFanoutWorkflow()

			const first = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ status: "investigating" })
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput("incident-1", workflow.binding))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.lengthOf(workflow.created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("force bypasses the enabled flag but still requires a binding", () =>
		Effect.gen(function* () {
			const workflow = fakeFanoutWorkflow()
			// No settings row at all. There is nothing to configure: an org that has
			// never touched these settings still gets the full investigation, because
			// how one runs is not a setting.
			const result = yield* maybeEnqueueTriage({
				...baseInput("incident-1", workflow.binding),
				force: true,
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(workflow.created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	/**
	 * The regression this reserve was built for: for two weeks the whole daily
	 * budget was spent by ordinary incidents within three hours of UTC midnight,
	 * so every incident during working hours was refused — including the ones
	 * worth investigating. Arrival order must not outrank severity.
	 *
	 * A start contributes `fanoutSize + 1` to usage and reserves `width + 2`. At
	 * width 4 (unclassified) that is 5 spent per start and 6 reserved; a critical
	 * is width 5, so 7 reserved. With a 20-pass ceiling the ordinary slice is 14.
	 */
	it.effect("keeps the reserve for high and critical once ordinary starts fill the slice", () =>
		Effect.gen(function* () {
			yield* enableWithLimits(50, 20)
			const workflow = fakeFanoutWorkflow()
			const ordinary = (id: string) => maybeEnqueueTriage(baseInput(id, workflow.binding))

			assert.isTrue((yield* ordinary("incident-1")).enqueued) // 0 + 6 <= 14
			assert.isTrue((yield* ordinary("incident-2")).enqueued) // 5 + 6 <= 14
			assert.deepStrictEqual(yield* ordinary("incident-3"), {
				enqueued: false,
				reason: "daily_cap",
			}) // 10 + 6 > 14

			// Same instant, same usage, higher severity: the reserved slice is still there.
			const critical = yield* maybeEnqueueTriage(criticalInput(workflow.binding, "incident-4"))
			assert.isTrue(critical.enqueued) // 10 + 7 <= 20
			assert.lengthOf(workflow.created, 3)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a critical start too once the full ceiling is spent", () =>
		Effect.gen(function* () {
			yield* enableWithLimits(50, 8)
			const workflow = fakeFanoutWorkflow()
			// One critical spends 6 of 8; a second needs 6 + 7 and cannot have it.
			assert.isTrue((yield* maybeEnqueueTriage(criticalInput(workflow.binding, "incident-1"))).enqueued)
			assert.deepStrictEqual(yield* maybeEnqueueTriage(criticalInput(workflow.binding, "incident-2")), {
				enqueued: false,
				reason: "daily_cap",
			})
		}).pipe(Effect.provide(makeLayer())),
	)
})
