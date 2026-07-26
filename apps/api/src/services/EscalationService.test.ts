import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect"
import { AlertDestinationId, ErrorIssueId, IssueEscalationId, OrgId } from "@maple/domain/http"
import { alertDestinations, errorIssues, issueEscalationPolicies, issueEscalations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/lib/DatabaseLive"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { EscalationService } from "./EscalationService"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
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

interface DispatchCall {
	readonly orgId: string
	readonly destinationIds: ReadonlyArray<string>
	readonly request: NotificationRequest
}

const makeHarness = (
	dispatchResult: { delivered: number; failed: number } = { delivered: 1, failed: 0 },
	options: { readonly dieOnDispatch?: boolean } = {},
) => {
	const calls: DispatchCall[] = []
	const dispatcherStub = Layer.succeed(NotificationDispatcher, {
		dispatch: (orgId, destinationIds, request) =>
			Effect.sync(() => {
				calls.push({ orgId, destinationIds: [...destinationIds], request })
				if (options.dieOnDispatch) {
					throw new Error("dispatcher exploded")
				}
				return {
					...dispatchResult,
					destinations: destinationIds.map((destinationId) => ({
						destinationId,
						destinationName: "On-call",
						status:
							dispatchResult.delivered > 0
								? ("delivered" as const)
								: dispatchResult.failed > 0
									? ("failed" as const)
									: ("missing" as const),
						error: dispatchResult.failed > 0 ? "delivery_failed" : null,
					})),
				}
			}),
	})
	const testDb = createTestDb(createdDbs)
	const base = testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
	const layer = EscalationService.layer.pipe(Layer.provide(dispatcherStub), Layer.provideMerge(base))
	return { calls, layer }
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const asEscalationId = Schema.decodeUnknownSync(IssueEscalationId)
const asRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const ORG = asOrgId("org_escalation_test")
const DESTINATION_ID = asDestinationId("00000000-0000-4000-8000-000000000001")

// Seed timestamps come from the Effect Clock (the TestClock under it.effect)
// so rows and the service — which reads Clock.currentTimeMillis — share one
// time base instead of mixing Date.now() with the test epoch.
const seedIssue = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id: issueId,
				orgId: ORG,
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout-api",
				exceptionType: "TimeoutError",
				exceptionMessage: "upstream timed out",
				topFrame: "",
				severity: "high",
				severitySource: "ai",
				firstSeenAt: new Date(now),
				lastSeenAt: new Date(now),
				createdAt: new Date(now),
				updatedAt: new Date(now),
			}),
		)
	})

const seedEscalation = (
	issueId: ErrorIssueId,
	overrides: Partial<typeof issueEscalations.$inferInsert> = {},
) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(issueEscalations).values({
				id: asEscalationId(randomUUID()),
				orgId: ORG,
				issueId,
				severity: "high",
				source: "ai",
				reason: "severity_set",
				payloadJson: { confidence: "medium" },
				status: "queued",
				attempts: 0,
				dedupeKey: `esc:${ORG}:${issueId}:high`,
				createdAt: new Date(now),
				...overrides,
			}),
		)
	})

const seedPolicy = (rulesJson: ReadonlyArray<unknown>, enabled = true) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db
				.insert(alertDestinations)
				.values({
					id: DESTINATION_ID,
					orgId: ORG,
					name: "On-call",
					type: "webhook",
					enabled: true,
					configJson: { url: "https://example.test/escalations" },
					secretCiphertext: "test",
					secretIv: "test",
					secretTag: "test",
					createdAt: new Date(now),
					updatedAt: new Date(now),
					createdBy: "user_test",
					updatedBy: "user_test",
				})
				.onConflictDoNothing(),
		)
		yield* database.execute((db) =>
			db.insert(issueEscalationPolicies).values({
				orgId: ORG,
				enabled,
				rulesJson,
				updatedAt: new Date(now),
				updatedBy: "user_test",
			}),
		)
	})

const loadEscalations = Effect.gen(function* () {
	const database = yield* Database
	return yield* database.execute((db) =>
		db.select().from(issueEscalations).where(eq(issueEscalations.orgId, ORG)),
	)
})

const highRule = (overrides: Record<string, unknown> = {}) => [
	{ severity: "high", destinationIds: [DESTINATION_ID], ...overrides },
]

describe("EscalationService.runEscalationTick", () => {
	it.effect("dispatches a queued escalation through the policy and marks it sent", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 1, skipped: 0, failed: 0, retried: 0 })
			assert.lengthOf(calls, 1)
			assert.strictEqual(calls[0]?.orgId, ORG)
			const escalation = asRecord(calls[0]?.request.escalation)
			assert.strictEqual(asRecord(escalation.issue).id, issueId)
			assert.strictEqual(escalation.source, "ai")

			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "sent")
			assert.strictEqual(rows[0]?.attempts, 1)
			assert.deepStrictEqual(rows[0]?.deliveryResultsJson, [
				{
					destinationId: DESTINATION_ID,
					destinationName: "On-call",
					status: "delivered",
					error: null,
				},
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when no policy exists or the policy is disabled", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule(), false)

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0, retried: 0 })
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "skipped")
			assert.strictEqual(rows[0]?.error, "policy_disabled")
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when no rule matches the escalation severity", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy([{ severity: "critical", destinationIds: [randomUUID()] }])

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.skipped, 1)
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.error, "no_destinations_for_severity")
		}).pipe(Effect.provide(layer))
	})

	it.effect("treats malformed policy rules as an empty rule set", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(["not a rule shape"])

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0, retried: 0 })
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "skipped")
			assert.strictEqual(rows[0]?.error, "no_destinations_for_severity")
		}).pipe(Effect.provide(layer))
	})

	it.effect("gates AI escalations below the rule's minimum confidence", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId, { payloadJson: { confidence: "low" } })
			yield* seedPolicy(highRule({ minConfidence: "high" }))

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.skipped, 1)
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.error, "below_min_confidence")
		}).pipe(Effect.provide(layer))
	})

	it.effect("lets manual escalations through the confidence gate", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId, { source: "manual", payloadJson: {} })
			yield* seedPolicy(highRule({ minConfidence: "high" }))

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.strictEqual(result.sent, 1)
			assert.lengthOf(calls, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("falls back to an empty payload when payloadJson is not a record", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId, { payloadJson: "not a record" })
			yield* seedPolicy(highRule())

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 1, skipped: 0, failed: 0, retried: 0 })
			assert.lengthOf(calls, 1)
			const escalation = asRecord(calls[0]?.request.escalation)
			assert.notProperty(escalation, "triage")
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when the referenced issue is missing", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			// No seedIssue — the outbox row points at a deleted/unknown issue.
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0, retried: 0 })
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "skipped")
			assert.strictEqual(rows[0]?.error, "issue_missing")
		}).pipe(Effect.provide(layer))
	})

	it.effect("skips when the route only contains disabled destinations", () => {
		const { calls, layer } = makeHarness()
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())
			const database = yield* Database
			yield* database.execute((db) =>
				db
					.update(alertDestinations)
					.set({ enabled: false })
					.where(eq(alertDestinations.id, DESTINATION_ID)),
			)

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0, retried: 0 })
			assert.lengthOf(calls, 0)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "skipped")
			assert.strictEqual(rows[0]?.error, "no_enabled_destinations")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a dispatch defect counts as failed but never re-delivers (at-most-once)", () => {
		// The row is flipped to "sent" BEFORE dispatch, so a defect mid-dispatch
		// (or a lost finalize) drops the escalation instead of re-paging on the
		// next tick: catchCause counts the defect as "failed", the row stays
		// "sent", and a second tick finds nothing to claim.
		const { calls, layer } = makeHarness({ delivered: 1, failed: 0 }, { dieOnDispatch: true })
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService
			const result = yield* service.runEscalationTick()

			assert.deepStrictEqual(result, { processed: 1, sent: 0, skipped: 0, failed: 1, retried: 0 })
			assert.lengthOf(calls, 1)
			const rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "sent")
			assert.strictEqual(rows[0]?.attempts, 1)

			const second = yield* service.runEscalationTick()
			assert.deepStrictEqual(second, { processed: 0, sent: 0, skipped: 0, failed: 0, retried: 0 })
			assert.lengthOf(calls, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("retries failed deliveries and fails after the attempt budget", () => {
		const { layer } = makeHarness({ delivered: 0, failed: 1 })
		return Effect.gen(function* () {
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId)
			yield* seedEscalation(issueId)
			yield* seedPolicy(highRule())

			const service = yield* EscalationService

			const first = yield* service.runEscalationTick()
			assert.strictEqual(first.retried, 1)
			let rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "queued")
			assert.strictEqual(rows[0]?.attempts, 1)
			assert.deepStrictEqual(rows[0]?.deliveryResultsJson, [
				{
					destinationId: DESTINATION_ID,
					destinationName: "On-call",
					status: "failed",
					error: "delivery_failed",
				},
			])

			const second = yield* service.runEscalationTick()
			assert.strictEqual(second.retried, 1)

			const third = yield* service.runEscalationTick()
			assert.strictEqual(third.failed, 1)
			rows = yield* loadEscalations
			assert.strictEqual(rows[0]?.status, "failed")
			assert.strictEqual(rows[0]?.attempts, 3)
			assert.deepStrictEqual(rows[0]?.deliveryResultsJson, [
				{
					destinationId: DESTINATION_ID,
					destinationName: "On-call",
					status: "failed",
					error: "delivery_failed",
				},
			])
		}).pipe(Effect.provide(layer))
	})
})
