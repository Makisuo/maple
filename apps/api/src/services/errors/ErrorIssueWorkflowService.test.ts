import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Schema } from "effect"
import { ErrorIncidentId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import { errorIncidents, errorIssues, errorIssueEvents, errorIssueStates } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"

// Compile-time guard: broadening this service to warehouse, cache, Env,
// notifications, or WorkerEnvironment makes this assignment fail.
const databaseAndActorsOnly: Layer.Layer<ErrorIssueWorkflowService, never, Database | ErrorActorsService> =
	ErrorIssueWorkflowService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asIncidentId = Schema.decodeUnknownSync(ErrorIncidentId)

const ORG = asOrgId("org_error_issue_workflow_test")
const USER = asUserId("user_error_issue_workflow_test")
const OTHER_USER = asUserId("other_error_issue_workflow_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => {
	const database = createTestDb(createdDbs).layer
	const actors = ErrorActorsService.layer.pipe(Layer.provide(database))
	const workflow = databaseAndActorsOnly.pipe(Layer.provide(Layer.mergeAll(database, actors)))
	return Layer.mergeAll(workflow, actors).pipe(Layer.provideMerge(database))
}

const seedIssue = (issueId: ErrorIssueId, overrides: Partial<typeof errorIssues.$inferInsert> = {}) =>
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
				topFrame: "handler.ts:42",
				firstSeenAt: new Date(now),
				lastSeenAt: new Date(now),
				createdAt: new Date(now),
				updatedAt: new Date(now),
				...overrides,
			}),
		)
	})

describe("ErrorIssueWorkflowService", () => {
	it.effect("enforces lease ownership, heartbeats, and release transitions on Postgres", () =>
		Effect.gen(function* () {
			const workflow = yield* ErrorIssueWorkflowService
			const actors = yield* ErrorActorsService
			const database = yield* Database
			const holder = yield* actors.ensureUserActor(ORG, USER)
			const contender = yield* actors.ensureUserActor(ORG, OTHER_USER)
			const issueId = asIssueId(randomUUID())
			const now = yield* Clock.currentTimeMillis
			yield* seedIssue(issueId, {
				workflowState: "in_progress",
				leaseHolderActorId: holder.id,
				claimedAt: new Date(now),
				leaseExpiresAt: new Date(now + 60_000),
			})

			const contention = yield* Effect.flip(workflow.heartbeatIssue(ORG, contender.id, issueId))
			if (contention._tag !== "@maple/http/errors/ErrorIssueLeaseConflictError") {
				return assert.fail(`Expected lease conflict, received ${contention._tag}`)
			}
			assert.strictEqual(contention.currentHolderActorId, holder.id)

			const heartbeat = yield* workflow.heartbeatIssue(ORG, holder.id, issueId)
			assert.strictEqual(heartbeat.leaseHolder?.id, holder.id)
			assert.isNotNull(heartbeat.leaseExpiresAt)

			const released = yield* workflow.releaseIssue(ORG, holder.id, issueId, {
				note: "handoff",
			})
			assert.strictEqual(released.workflowState, "todo")
			assert.isNull(released.leaseHolder)
			assert.isNull(released.leaseExpiresAt)

			const events = yield* database.execute((db) =>
				db
					.select({ type: errorIssueEvents.type, toState: errorIssueEvents.toState })
					.from(errorIssueEvents)
					.where(and(eq(errorIssueEvents.orgId, ORG), eq(errorIssueEvents.issueId, issueId))),
			)
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "release" }),
					expect.objectContaining({ type: "state_change", toState: "todo" }),
				]),
			)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("keeps issue, incident, evaluator state, and audit mutation coherent", () =>
		Effect.gen(function* () {
			const workflow = yield* ErrorIssueWorkflowService
			const actors = yield* ErrorActorsService
			const database = yield* Database
			const actor = yield* actors.ensureUserActor(ORG, USER)
			const issueId = asIssueId(randomUUID())
			const incidentId = asIncidentId(randomUUID())
			const now = yield* Clock.currentTimeMillis
			yield* seedIssue(issueId, { workflowState: "in_review" })
			yield* database.execute((db) =>
				db.insert(errorIncidents).values({
					id: incidentId,
					orgId: ORG,
					issueId,
					status: "open",
					reason: "first_seen",
					firstTriggeredAt: new Date(now),
					lastTriggeredAt: new Date(now),
					createdAt: new Date(now),
					updatedAt: new Date(now),
				}),
			)
			yield* database.execute((db) =>
				db.insert(errorIssueStates).values({
					orgId: ORG,
					issueId,
					openIncidentId: incidentId,
					updatedAt: new Date(now),
				}),
			)

			const current = yield* workflow.requireIssue(ORG, issueId)
			const transitioned = yield* workflow.applyTransition(ORG, actor.id, current, "done", {
				note: "verified",
			})
			assert.strictEqual(transitioned.workflowState, "done")

			const [incident] = yield* database.execute((db) =>
				db.select().from(errorIncidents).where(eq(errorIncidents.id, incidentId)),
			)
			const [state] = yield* database.execute((db) =>
				db
					.select()
					.from(errorIssueStates)
					.where(and(eq(errorIssueStates.orgId, ORG), eq(errorIssueStates.issueId, issueId))),
			)
			assert.strictEqual(incident?.status, "resolved")
			assert.isNotNull(incident?.resolvedAt)
			assert.isNull(state?.openIncidentId)

			const response = yield* workflow.listIssueEvents(ORG, issueId)
			const stateChange = response.events.find((event) => event.type === "state_change")
			assert.strictEqual(stateChange?.actor?.id, actor.id)
			assert.strictEqual(stateChange?.fromState, "in_review")
			assert.strictEqual(stateChange?.toState, "done")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("preserves transition validation without partially mutating the issue", () =>
		Effect.gen(function* () {
			const workflow = yield* ErrorIssueWorkflowService
			const database = yield* Database
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(issueId, { workflowState: "cancelled" })
			const current = yield* workflow.requireIssue(ORG, issueId)

			const failure = yield* Effect.flip(workflow.applyTransition(ORG, null, current, "triage"))
			assert.strictEqual(failure._tag, "@maple/http/errors/ErrorIssueTransitionError")

			const [after] = yield* database.execute((db) =>
				db.select().from(errorIssues).where(eq(errorIssues.id, issueId)),
			)
			const events = yield* database.execute((db) =>
				db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
			)
			assert.strictEqual(after?.workflowState, "cancelled")
			assert.lengthOf(events, 0)
		}).pipe(Effect.provide(makeLayer())),
	)
})
