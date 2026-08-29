import { afterEach, describe, expect, it } from "@effect/vitest"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { AuditLogService, recordHttpAudit } from "./AuditLogService"
import { CurrentTenant } from "@maple/domain/http"
import { ApiKeyId } from "@maple/domain/primitives"
import { type AuditActorInfo, CurrentAuditActor } from "@/services/auth/audit-actor"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_audit_log_test")
const USER = asUserId("user_audit_log_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const DASHBOARD_ID = "3f1b7c02-9a44-4d1e-8b2f-0c5d6e7a8b91"
const API_KEY = Schema.decodeUnknownSync(ApiKeyId)("7b2e4c10-55aa-4d3e-9f21-1a2b3c4d5e6f")

const makeLayer = () => AuditLogService.layer.pipe(Layer.provide(createTestDb(createdDbs).layer))

/** Three entries with distinct timestamps: user, then api_key, then agent. */
const seedThree = Effect.gen(function* () {
	const audit = yield* AuditLogService
	yield* audit.record({
		orgId: ORG,
		actor: { type: "user", userId: USER },
		source: "dashboard",
		action: "dashboard.created",
		// Internal ID in, public `dash_…` ID out — the service owns the encoding.
		resourceId: DASHBOARD_ID,
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
			expect(oldest.resourceId).toBe(encodePublicId(PublicIdPrefixes.dashboard, DASHBOARD_ID))
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
				action: "alert_rule.deleted",
				outcome: "denied",
				denialReason: "missing role: admin",
			})

			const denied = yield* audit.list(ORG, { outcome: "denied", limit: 10, offset: 0 })
			expect(denied.map((row) => row.action)).toEqual(["alert_rule.deleted"])
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

	// The credential and the surface are the two facts a mutation handler cannot
	// re-derive, and getting them wrong is what made API-key and MCP actions read
	// back as dashboard sessions.
	describe("recordHttpAudit attribution", () => {
		const tenant = new CurrentTenant.TenantSchema({
			orgId: ORG,
			userId: USER,
			roles: [],
			authMode: "self_hosted",
		})

		const recordAs = (info: AuditActorInfo | undefined) =>
			Effect.gen(function* () {
				const audit = yield* AuditLogService
				yield* recordHttpAudit("dashboard.created", { resourceId: DASHBOARD_ID })
				const rows = yield* audit.list(ORG, { limit: 1, offset: 0 })
				return rows[0]!
			}).pipe(
				Effect.provideService(CurrentTenant.Context, tenant),
				Effect.provideService(CurrentAuditActor, info),
				Effect.provide(makeLayer().pipe(Layer.provide(Layer.succeed(WorkerEnvironment, {})))),
			)

		it.effect("attributes an API-key request to the key, not the dashboard", () =>
			Effect.gen(function* () {
				const row = yield* recordAs({ type: "api_key", apiKeyId: API_KEY, source: "api" })
				expect(row.actorType).toBe("api_key")
				expect(row.source).toBe("api")
				expect(row.apiKeyId).toBe(API_KEY)
			}),
		)

		it.effect("records the MCP surface rather than assuming a dashboard session", () =>
			Effect.gen(function* () {
				const row = yield* recordAs({ type: "api_key", source: "mcp" })
				expect(row.source).toBe("mcp")
				expect(row.actorType).toBe("api_key")
			}),
		)

		it.effect("records Maple's own internal-token actions as system", () =>
			Effect.gen(function* () {
				const row = yield* recordAs({ type: "system", source: "system" })
				expect(row.actorType).toBe("system")
				expect(row.source).toBe("system")
			}),
		)

		// Requests that skipped every auth middleware still have a tenant; the
		// fallback must not invent a credential it did not see.
		it.effect("falls back to the tenant user when no middleware set the reference", () =>
			Effect.gen(function* () {
				const row = yield* recordAs(undefined)
				expect(row.actorType).toBe("user")
				expect(row.source).toBe("dashboard")
				expect(row.userId).toBe(USER)
				expect(row.apiKeyId).toBeNull()
			}),
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
