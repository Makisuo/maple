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

/**
 * Stub `CHAT_SESSION` Durable Object namespace. Starting an autonomous turn is a single DO call
 * rather than an HTTP POST to the chat-flue Worker, so what a test observes is the `beginTurn`
 * call, not a `Request`. The real object also *runs* the turn inside itself; nothing here does,
 * which is the point — the caller's only job is to claim the slot.
 */
const fakeBinding = (options?: { readonly busy?: boolean }) => {
	const created: Array<{ sessionId: string; messageId: string; text: string }> = []
	return {
		created,
		binding: {
			idFromName: (name: string) => name,
			get: () => ({
				history: async () => [],
				beginTurn: async (input: { sessionId: string; messageId: string; text: string }) => {
					created.push(input)
					return options?.busy === true ? undefined : { cursor: 0, messageId: input.messageId }
				},
				append: async () => 1,
				endTurn: async () => undefined,
			}),
		},
	}
}

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

const baseInput = (binding: unknown, incidentId: string) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error" },
	agentBinding: binding,
})

const enableFanout = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: true,
			fanoutEnabled: true,
			maxRunsPerDay: 20,
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

/** A critical incident — severity is what earns an automatic start its fan-out. */
const criticalInput = (binding: unknown, fanoutBinding: unknown, incidentId: string) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error", severity: "critical", serviceName: "checkout-api" },
	agentBinding: binding,
	fanoutBinding,
})

describe("maybeEnqueueTriage", () => {
	/**
	 * The gap the reviews found: the automatic half of the routing rule was never
	 * wired. `maybeEnqueueTriage` owns every incident-open start, and it used to
	 * call `beginTurn` unconditionally — so an org that enabled fan-out got it on
	 * manual starts only, and the severity branch of the policy was dead code that
	 * still passed its own unit tests.
	 */
	it.effect("dispatches a critical automatic incident to the fan-out workflow", () =>
		Effect.gen(function* () {
			yield* enableFanout
			const chat = fakeBinding()
			const workflow = fakeFanoutWorkflow()

			const result = yield* maybeEnqueueTriage(
				criticalInput(chat.binding, workflow.binding, "incident-critical"),
			)
			assert.isTrue(result.enqueued)
			// The workflow ran; the single-pass chat turn did not.
			assert.lengthOf(workflow.created, 1)
			assert.lengthOf(chat.created, 0)
			assert.lengthOf(workflow.created[0]!.params.lensIds as ReadonlyArray<string>, 5)

			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.fanoutState, "queued")
			assert.strictEqual(rows[0]?.fanoutSize, 5)
			// Six model passes, six units of budget.
			assert.strictEqual(rows[0]?.autonomousTurns, 6)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("keeps a low-severity automatic incident on the single pass", () =>
		Effect.gen(function* () {
			yield* enableFanout
			const chat = fakeBinding()
			const workflow = fakeFanoutWorkflow()

			const result = yield* maybeEnqueueTriage({
				...criticalInput(chat.binding, workflow.binding, "incident-low"),
				context: { kind: "error", severity: "low" },
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(workflow.created, 0)
			assert.lengthOf(chat.created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("records agent_unavailable when the fan-out binding is missing", () =>
		Effect.gen(function* () {
			yield* enableFanout
			const chat = fakeBinding()

			const result = yield* maybeEnqueueTriage(
				criticalInput(chat.binding, undefined, "incident-nobinding"),
			)
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")
			// It must NOT silently fall back to one agent — a run planned as a
			// fan-out that quietly ran as a single pass is a lie in the boards.
			assert.lengthOf(chat.created, 0)

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
			const { binding, created } = fakeBinding()
			const result = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.deepStrictEqual(result, { enqueued: false, reason: "disabled" })
			assert.lengthOf(created, 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("enqueues once and dedups subsequent calls for the same incident", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding, created } = fakeBinding()

			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			assert.lengthOf(created, 1)
			assert.include(created[0]?.sessionId ?? "", `inv-${first.investigationId}`)
			assert.include(created[0]?.text ?? "", '"incidentId":"incident-1"')
			assert.include(created[0]?.text ?? "", '"snapshot"')

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.strictEqual(second.investigationId, first.investigationId)
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the daily cap", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding } = fakeBinding()

			assert.isTrue((yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))).enqueued)
			assert.isTrue((yield* maybeEnqueueTriage(baseInput(binding, "incident-2"))).enqueued)
			const third = yield* maybeEnqueueTriage(baseInput(binding, "incident-3"))
			assert.deepStrictEqual(third, { enqueued: false, reason: "daily_cap" })
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks the run failed when no workflow binding is available", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database

			const result = yield* maybeEnqueueTriage({
				...baseInput(undefined, "incident-1"),
				agentBinding: undefined,
			})
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

	/**
	 * The old "agent returned HTTP 4xx / the fetch threw" outcomes are gone with the Worker hop.
	 * The one pre-turn failure that survives is a session that already has a turn in flight.
	 */
	it.effect("marks the run failed and reports `error` when the session is already busy", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const { binding } = fakeBinding({ busy: true })

			const result = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "error")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "start_failed")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks a stranded investigation failed with a retryable reason", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const nowMs = yield* Clock.currentTimeMillis
			const { binding } = fakeBinding()

			// First start claims the slot, then we simulate an autonomous turn
			// that stopped making progress for more than 15 minutes.
			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "investigating",
						startedAt: new Date(nowMs - 16 * 60 * 1000),
						updatedAt: new Date(nowMs - 16 * 60 * 1000),
					})
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
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
			const { binding, created } = fakeBinding()

			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({ status: "investigating" })
					.where(eq(investigations.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isFalse(second.enqueued)
			assert.strictEqual(second.reason, "duplicate")
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("force bypasses the enabled flag but still requires a binding", () =>
		Effect.gen(function* () {
			const { binding, created } = fakeBinding()
			const result = yield* maybeEnqueueTriage({
				...baseInput(binding, "incident-1"),
				force: true,
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)
})
