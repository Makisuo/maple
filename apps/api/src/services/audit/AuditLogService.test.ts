import { afterEach, describe, expect, it } from "@effect/vitest"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { AuditLogService } from "./AuditLogService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_audit_log_test")
const USER = asUserId("user_audit_log_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => AuditLogService.layer.pipe(Layer.provide(createTestDb(createdDbs).layer))

/** Three entries with distinct timestamps: user, then api_key, then agent. */
const seedThree = Effect.gen(function* () {
	const audit = yield* AuditLogService
	yield* audit.record({
		orgId: ORG,
		actor: { type: "user", userId: USER },
		source: "dashboard",
		action: "dashboard.created",
		resourceType: "dashboard",
		resourceId: "dash_first",
		metadata: { name: "First" },
	})
	yield* TestClock.adjust("1 second")
	yield* audit.record({
		orgId: ORG,
		actor: { type: "api_key" },
		source: "api",
		action: "alert_rule.updated",
	})
	yield* TestClock.adjust("1 second")
	yield* audit.record({
		orgId: ORG,
		actor: { type: "agent", label: "triage-bot" },
		source: "mcp",
		action: "error_issue.state_change",
	})
})

describe("AuditLogService", () => {
	it.effect("round-trips a recorded entry and lists newest first", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* seedThree

			const rows = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(rows.map((row) => row.action)).toEqual([
				"error_issue.state_change",
				"alert_rule.updated",
				"dashboard.created",
			])

			const oldest = rows[2]!
			expect(oldest.actorType).toBe("user")
			expect(oldest.userId).toBe(USER)
			expect(oldest.source).toBe("dashboard")
			expect(oldest.resourceType).toBe("dashboard")
			expect(oldest.resourceId).toBe("dash_first")
			expect(oldest.metadataJson).toEqual({ name: "First" })

			const newest = rows[0]!
			expect(newest.actorType).toBe("agent")
			expect(newest.actorLabel).toBe("triage-bot")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("filters by actor type", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* seedThree

			const apiKeyRows = yield* audit.list(ORG, { actorType: "api_key", limit: 10, offset: 0 })
			expect(apiKeyRows.map((row) => row.action)).toEqual(["alert_rule.updated"])

			const systemRows = yield* audit.list(ORG, { actorType: "system", limit: 10, offset: 0 })
			expect(systemRows).toEqual([])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("pages with offset and limit in newest-first order", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* seedThree

			const firstPage = yield* audit.list(ORG, { limit: 2, offset: 0 })
			expect(firstPage.map((row) => row.action)).toEqual([
				"error_issue.state_change",
				"alert_rule.updated",
			])

			const secondPage = yield* audit.list(ORG, { limit: 2, offset: 2 })
			expect(secondPage.map((row) => row.action)).toEqual(["dashboard.created"])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("records denied outcomes and filters by outcome", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* seedThree
			yield* audit.record({
				orgId: ORG,
				actor: { type: "user", userId: USER },
				source: "dashboard",
				action: "alert_rule.delete",
				outcome: "denied",
				denialReason: "missing role: admin",
			})

			const denied = yield* audit.list(ORG, { outcome: "denied", limit: 10, offset: 0 })
			expect(denied.map((row) => row.action)).toEqual(["alert_rule.delete"])
			expect(denied[0]!.outcome).toBe("denied")
			expect(denied[0]!.denialReason).toBe("missing role: admin")

			const allowed = yield* audit.list(ORG, { outcome: "allowed", limit: 10, offset: 0 })
			expect(allowed).toHaveLength(3)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stores update diffs and filters by changed field", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* seedThree
			yield* audit.record({
				orgId: ORG,
				actor: { type: "user", userId: USER },
				source: "dashboard",
				action: "dashboard.updated",
				changes: { fields: ["name"], before: { name: "a" }, after: { name: "b" } },
			})

			const rows = yield* audit.list(ORG, { changedField: "name", limit: 10, offset: 0 })
			expect(rows.map((row) => row.action)).toEqual(["dashboard.updated"])
			expect(rows[0]!.changedFields).toEqual(["name"])
			expect(rows[0]!.changesJson).toEqual({
				fields: ["name"],
				before: { name: "a" },
				after: { name: "b" },
			})

			const none = yield* audit.list(ORG, { changedField: "description", limit: 10, offset: 0 })
			expect(none).toEqual([])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("publishes to the audit queue instead of writing when the binding is present", () => {
		const sent: unknown[] = []
		return Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* audit.record({
				orgId: ORG,
				actor: { type: "user", userId: USER },
				source: "dashboard",
				action: "dashboard.created",
			})

			expect(sent).toHaveLength(1)
			expect(sent[0]).toMatchObject({ orgId: ORG, action: "dashboard.created" })
			// The consumer performs the insert; nothing lands in the DB directly.
			const rows = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(rows).toEqual([])
		}).pipe(
			Effect.provide(
				makeLayer().pipe(
					Layer.provide(
						Layer.succeed(WorkerEnvironment, {
							AUDIT_EVENTS_QUEUE: {
								send: async (message: unknown) => {
									sent.push(message)
								},
							},
						}),
					),
				),
			),
		)
	})

	it.effect("writes directly when the queue binding is absent from the worker environment", () =>
		Effect.gen(function* () {
			const audit = yield* AuditLogService
			yield* audit.record({
				orgId: ORG,
				actor: { type: "user", userId: USER },
				source: "dashboard",
				action: "dashboard.created",
			})

			const rows = yield* audit.list(ORG, { limit: 10, offset: 0 })
			expect(rows.map((row) => row.action)).toEqual(["dashboard.created"])
		}).pipe(
			Effect.provide(makeLayer().pipe(Layer.provide(Layer.succeed(WorkerEnvironment, {})))),
		),
	)
})
