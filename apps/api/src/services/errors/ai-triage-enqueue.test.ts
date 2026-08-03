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

const fakeBinding = (status = 202) => {
	const created: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = []
	return {
		created,
		binding: {
			fetch: async (request: Request) => {
				created.push({
					url: request.url,
					method: request.method,
					authorization: request.headers.get("authorization"),
					body: await request.json(),
				})
				return new Response(null, { status })
			},
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
	internalServiceToken: Option.some(Redacted.make("test-internal-token")),
})

describe("maybeEnqueueTriage", () => {
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
			assert.include(created[0]?.url ?? "", `inv-${first.investigationId}`)
			assert.strictEqual(created[0]?.method, "POST")
			assert.strictEqual(created[0]?.authorization, "Bearer maple_svc_test-internal-token")
			const body = created[0]?.body as { readonly message?: string }
			assert.include(body.message ?? "", '"incidentId":"incident-1"')
			assert.include(body.message ?? "", '"snapshot"')

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

	it.effect("marks the run failed and reports `error` when workflow creation fails", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const failingBinding = {
				fetch: async () => {
					throw new Error("agent boom")
				},
			}

			const result = yield* maybeEnqueueTriage(baseInput(failingBinding, "incident-1"))
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

	it.effect("marks terminal agent rejections as non-retryable", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const { binding } = fakeBinding(401)

			const result = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "rejected")

			const rows = yield* database.execute((db) =>
				db.select().from(investigations).where(eq(investigations.orgId, ORG)),
			)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.include(rows[0]?.error ?? "", "start_rejected")
			assert.notInclude(rows[0]?.error ?? "", "retry")
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
