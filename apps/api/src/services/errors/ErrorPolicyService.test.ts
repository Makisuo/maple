import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import {
	ErrorNotificationPolicyUpsertRequest,
	EscalationPolicyEvaluationRequest,
	IssueEscalationPolicyRule,
	IssueEscalationPolicyUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { AlertDestinationId, ErrorIssueId, IssueEscalationId } from "@maple/domain/primitives"
import { alertDestinations, issueEscalations } from "@maple/db"
import { Clock, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ErrorPolicyService } from "./ErrorPolicyService"

// Compile-time guard: broadening policy persistence to Env, notifications,
// warehouse, cache, WorkerEnvironment, actors, or workflow makes this fail.
const databaseOnlyLayer: Layer.Layer<ErrorPolicyService, never, Database> = ErrorPolicyService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asEscalationId = Schema.decodeUnknownSync(IssueEscalationId)
const asRoleName = Schema.decodeUnknownSync(RoleName)
const ADMIN_ROLES = [asRoleName("org:admin")]
const MEMBER_ROLES = [asRoleName("org:member")]

const ORG = asOrgId("org_error_policy_service_test")
const OTHER_ORG = asOrgId("org_error_policy_service_other")
const USER = asUserId("user_error_policy_service_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => {
	const database = createTestDb(createdDbs).layer
	return databaseOnlyLayer.pipe(Layer.provide(database), Layer.provideMerge(database))
}

const insertDestination = (
	id: ReturnType<typeof asDestinationId>,
	orgId: ReturnType<typeof asOrgId>,
	enabled = true,
) =>
	Effect.gen(function* () {
		const database = yield* Database
		const timestamp = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.insert(alertDestinations).values({
				id,
				orgId,
				name: `Destination ${id}`,
				type: "webhook",
				enabled,
				configJson: {},
				secretCiphertext: "ciphertext",
				secretIv: "iv",
				secretTag: "tag",
				createdAt: msToDate(timestamp),
				updatedAt: msToDate(timestamp),
				createdBy: USER,
				updatedBy: USER,
			}),
		)
	})

describe("ErrorPolicyService", () => {
	it.effect("provides row-less notification defaults and persists partial updates", () =>
		Effect.gen(function* () {
			const policies = yield* ErrorPolicyService

			const initial = yield* policies.getNotificationPolicy(ORG)
			assert.isTrue(initial.enabled)
			assert.deepStrictEqual(initial.destinationIds, [])
			assert.isTrue(initial.notifyOnFirstSeen)
			assert.strictEqual(initial.updatedBy, "system")

			const destinationId = asDestinationId(randomUUID())
			const updated = yield* policies.upsertNotificationPolicy(
				ORG,
				USER,
				ADMIN_ROLES,
				new ErrorNotificationPolicyUpsertRequest({
					destinationIds: [destinationId],
					notifyOnResolve: true,
					minOccurrenceCount: 7,
				}),
			)

			assert.deepStrictEqual(updated.destinationIds, [destinationId])
			assert.isTrue(updated.notifyOnFirstSeen)
			assert.isTrue(updated.notifyOnResolve)
			assert.strictEqual(updated.minOccurrenceCount, 7)
			assert.strictEqual(updated.updatedBy, USER)

			const row = yield* policies.loadNotificationPolicyRow(ORG)
			assert.isNotNull(row)
			assert.deepStrictEqual(policies.parseNotificationDestinationIds(row?.destinationIdsJson), [
				destinationId,
			])
		}).pipe(Effect.provide(makeLayer())),
	)

	// The gate lives here rather than on the v1 route because the MCP tool and
	// the chat apply path reach the same mutation.
	it.effect("refuses a notification policy write from a non-admin", () =>
		Effect.gen(function* () {
			const policies = yield* ErrorPolicyService

			const failure = yield* Effect.flip(
				policies.upsertNotificationPolicy(
					ORG,
					USER,
					MEMBER_ROLES,
					new ErrorNotificationPolicyUpsertRequest({ enabled: false }),
				),
			)

			assert.strictEqual(failure._tag, "@maple/http/errors/ErrorForbiddenError")
			// And nothing was written.
			assert.isNull(yield* policies.loadNotificationPolicyRow(ORG))
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("validates duplicate severities and destination ownership before policy writes", () =>
		Effect.gen(function* () {
			const policies = yield* ErrorPolicyService
			const ownedId = asDestinationId(randomUUID())
			const foreignId = asDestinationId(randomUUID())
			yield* insertDestination(ownedId, ORG)
			yield* insertDestination(foreignId, OTHER_ORG)

			const duplicate = yield* Effect.flip(
				policies.upsertEscalationPolicy(
					ORG,
					USER,
					new IssueEscalationPolicyUpsertRequest({
						rules: [
							new IssueEscalationPolicyRule({
								severity: "critical",
								destinationIds: [ownedId],
							}),
							new IssueEscalationPolicyRule({
								severity: "critical",
								destinationIds: [ownedId],
							}),
						],
					}),
				),
			)
			assert.strictEqual(duplicate._tag, "@maple/http/errors/ErrorValidationError")
			assert.include(duplicate.message, "duplicate severity")

			const foreign = yield* Effect.flip(
				policies.upsertEscalationPolicy(
					ORG,
					USER,
					new IssueEscalationPolicyUpsertRequest({
						rules: [
							new IssueEscalationPolicyRule({
								severity: "critical",
								destinationIds: [ownedId, foreignId],
							}),
						],
					}),
				),
			)
			if (foreign._tag !== "@maple/http/errors/ErrorValidationError") {
				return assert.fail(`Expected validation error, received ${foreign._tag}`)
			}
			assert.include(foreign.details, foreignId)
			assert.notInclude(foreign.details, ownedId)

			const accepted = yield* policies.upsertEscalationPolicy(
				ORG,
				USER,
				new IssueEscalationPolicyUpsertRequest({
					enabled: true,
					rules: [
						new IssueEscalationPolicyRule({
							severity: "critical",
							destinationIds: [ownedId],
						}),
					],
				}),
			)
			assert.deepStrictEqual(accepted.rules[0]?.destinationIds, [ownedId])

			const evaluation = yield* policies.evaluateEscalationPolicy(
				ORG,
				new EscalationPolicyEvaluationRequest({ severity: "critical", source: "manual" }),
			)
			assert.strictEqual(evaluation.outcome, "route")
			assert.deepStrictEqual(evaluation.destinationIds, [ownedId])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("lists issue and recent escalation attempts with org scoping and limits", () =>
		Effect.gen(function* () {
			const policies = yield* ErrorPolicyService
			const database = yield* Database
			const issueId = asIssueId(randomUUID())
			const otherIssueId = asIssueId(randomUUID())
			const timestamp = yield* Clock.currentTimeMillis
			const rows = [
				{ id: asEscalationId(randomUUID()), orgId: ORG, issueId, createdAt: timestamp },
				{ id: asEscalationId(randomUUID()), orgId: ORG, issueId, createdAt: timestamp + 1 },
				{
					id: asEscalationId(randomUUID()),
					orgId: ORG,
					issueId: otherIssueId,
					createdAt: timestamp + 2,
				},
				{
					id: asEscalationId(randomUUID()),
					orgId: OTHER_ORG,
					issueId,
					createdAt: timestamp + 3,
				},
			]
			yield* database.execute((db) =>
				db.insert(issueEscalations).values(
					rows.map((row) => ({
						id: row.id,
						orgId: row.orgId,
						issueId: row.issueId,
						severity: "high" as const,
						source: "manual" as const,
						reason: "severity_set" as const,
						payloadJson: {},
						deliveryResultsJson: [],
						status: "queued" as const,
						attempts: 0,
						dedupeKey: `test:${row.id}`,
						createdAt: msToDate(row.createdAt),
					})),
				),
			)

			const issueAttempts = yield* policies.listIssueEscalations(ORG, issueId)
			expect(issueAttempts.attempts.map((attempt) => attempt.id)).toEqual([rows[1]?.id, rows[0]?.id])

			const recent = yield* policies.listRecentEscalations(ORG, 2)
			expect(recent.attempts.map((attempt) => attempt.id)).toEqual([rows[2]?.id, rows[1]?.id])
		}).pipe(Effect.provide(makeLayer())),
	)
})
