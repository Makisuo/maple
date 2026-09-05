import { describe, expect, it } from "@effect/vitest"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { CurrentTenant } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import type { AuditLogRow } from "@maple/domain/tinybird"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeWarehouseServiceStub } from "@/routes/v2/v2-test-support"
import { type AuditActorInfo, CurrentAuditActor } from "@/services/auth/audit-actor"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { AUDIT_LOG_DATASOURCE, AuditLogService, recordHttpAudit } from "./AuditLogService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_audit_log_test")
const USER = asUserId("user_audit_log_test")
const DASHBOARD_ID = "3f1b7c02-9a44-4d1e-8b2f-0c5d6e7a8b91"
const API_KEY = Schema.decodeUnknownSync(ApiKeyId)("7b2e4c10-55aa-4d3e-9f21-1a2b3c4d5e6f")

/**
 * A warehouse that records what `ingest` receives and answers `compiledQuery`
 * with canned rows, exposing the SQL it was handed so a test can assert which
 * filters the listing bound.
 */
const recordingWarehouse = (rows: ReadonlyArray<Record<string, unknown>> = []) => {
	const ingested: Array<{ datasource: string; rows: ReadonlyArray<AuditLogRow> }> = []
	const sql: Array<string> = []
	const layer = Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			ingest: (_tenant, datasource, batch) =>
				Effect.sync(() => {
					// SAFETY: this stub only ever receives the audit datasource's rows.
					ingested.push({ datasource, rows: batch as ReadonlyArray<AuditLogRow> })
				}),
			compiledQuery: ((_tenant: unknown, compiled: unknown) =>
				Effect.gen(function* () {
					const query = Effect.isEffect(compiled) ? yield* compiled : compiled
					// SAFETY: every compiled query carries its SQL text.
					sql.push((query as { readonly sql: string }).sql)
					return rows
				})) as never,
		}),
	)
	return { ingested, sql, layer }
}

const storedRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: "9d2c1e3a-6a1b-4f0e-9c1d-2b3a4c5d6e7f",
	occurredAt: "2026-08-29 09:12:00.412",
	recordedAt: "2026-08-29 09:12:00.900",
	actorType: "user",
	userId: USER,
	apiKeyId: "",
	actorId: "",
	actorLabel: "David",
	affectedUserId: "",
	source: "dashboard",
	action: "dashboard.updated",
	outcome: "allowed",
	denialReason: "",
	resourceType: "dashboard",
	resourceId: "dash_1",
	changedFields: ["name"],
	changes: JSON.stringify({ fields: ["name"], before: { name: "a" }, after: { name: "b" } }),
	metadata: JSON.stringify({ reason: "rename" }),
	requestId: "ray",
	originIp: "203.0.113.7",
	originCountry: "DE",
	...overrides,
})

describe("AuditLogService (warehouse-backed)", () => {
	it.effect("writes one audit_log row through ingest, with '' for absent values", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse()
			yield* Effect.gen(function* () {
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
			}).pipe(Effect.provide(AuditLogService.layer.pipe(Layer.provide(warehouse.layer))))

			expect(warehouse.ingested).toHaveLength(1)
			expect(warehouse.ingested[0]!.datasource).toBe(AUDIT_LOG_DATASOURCE)
			const row = warehouse.ingested[0]!.rows[0]!
			expect(row.OrgId).toBe(ORG)
			expect(row.ActorType).toBe("user")
			expect(row.UserId).toBe(USER)
			expect(row.ApiKeyId).toBe("")
			expect(row.ResourceType).toBe("dashboard")
			expect(row.ResourceId).toBe(encodePublicId(PublicIdPrefixes.dashboard, DASHBOARD_ID))
			expect(row.ChangedFields).toEqual([])
			expect(row.Changes).toBe("")
			expect(JSON.parse(row.Metadata)).toEqual({ name: "First" })
			expect(row.OccurredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
		}),
	)

	it.effect("publishes to the audit queue instead of writing when the binding is present", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse()
			const sent: unknown[] = []
			yield* Effect.gen(function* () {
				const audit = yield* AuditLogService
				yield* audit.record({
					orgId: ORG,
					actor: { type: "user", userId: USER },
					source: "dashboard",
					action: "dashboard.created",
				})
			}).pipe(
				Effect.provide(
					AuditLogService.layer.pipe(
						Layer.provide(warehouse.layer),
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
			expect(sent).toHaveLength(1)
			expect(sent[0]).toMatchObject({ orgId: ORG, action: "dashboard.created" })
			// The consumer performs the write; nothing reaches the warehouse directly.
			expect(warehouse.ingested).toEqual([])
		}),
	)

	it.effect("drops the entry rather than writing to the warehouse on the response path", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse()
			yield* Effect.gen(function* () {
				const audit = yield* AuditLogService
				yield* audit.record({
					orgId: ORG,
					actor: { type: "api_key" },
					source: "api",
					action: "alert_rule.updated",
				})
			}).pipe(
				Effect.provide(
					AuditLogService.layer.pipe(
						Layer.provide(warehouse.layer),
						Layer.provide(
							Layer.succeed(WorkerEnvironment, {
								AUDIT_EVENTS_QUEUE: {
									send: async () => {
										throw new Error("broker down")
									},
								},
							}),
						),
					),
				),
			)
			// The queue owns durability (retries, DLQ). A failed send must not buy a
			// second network round trip with the caller's response time, which is
			// exactly when the platform is already degraded — the caller still
			// succeeds, and the loss is in the logs.
			expect(warehouse.ingested).toHaveLength(0)
		}),
	)

	it.effect("decodes stored rows: '' becomes null, documents parse, timestamps are UTC", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse([storedRow()])
			const rows = yield* Effect.gen(function* () {
				const audit = yield* AuditLogService
				return yield* audit.list(ORG, { limit: 10, offset: 0 })
			}).pipe(Effect.provide(AuditLogService.layer.pipe(Layer.provide(warehouse.layer))))

			expect(rows).toHaveLength(1)
			const entry = rows[0]!
			expect(entry.orgId).toBe(ORG)
			expect(entry.userId).toBe(USER)
			expect(entry.apiKeyId).toBeNull()
			expect(entry.affectedUserId).toBeNull()
			expect(entry.denialReason).toBeNull()
			expect(entry.changedFields).toEqual(["name"])
			expect(entry.changes).toEqual({ fields: ["name"], before: { name: "a" }, after: { name: "b" } })
			expect(entry.metadata).toEqual({ reason: "rename" })
			expect(entry.occurredAt.toISOString()).toBe("2026-08-29T09:12:00.412Z")
			expect(entry.recordedAt.toISOString()).toBe("2026-08-29T09:12:00.900Z")
		}),
	)

	it.effect("an entry without a diff lists with null changed fields", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse([storedRow({ changes: "", changedFields: [], metadata: "" })])
			const rows = yield* Effect.gen(function* () {
				const audit = yield* AuditLogService
				return yield* audit.list(ORG, { limit: 10, offset: 0 })
			}).pipe(Effect.provide(AuditLogService.layer.pipe(Layer.provide(warehouse.layer))))
			expect(rows[0]!.changes).toBeNull()
			expect(rows[0]!.changedFields).toBeNull()
			expect(rows[0]!.metadata).toBeNull()
		}),
	)

	it.effect("binds only the filters the caller set", () =>
		Effect.gen(function* () {
			const warehouse = recordingWarehouse()
			yield* Effect.gen(function* () {
				const audit = yield* AuditLogService
				yield* audit.list(ORG, { limit: 10, offset: 0 })
				yield* audit.list(ORG, {
					actorType: "api_key",
					changedField: "scopes",
					sinceMs: Date.UTC(2026, 7, 29, 9, 12, 0, 412),
					limit: 5,
					offset: 5,
				})
			}).pipe(Effect.provide(AuditLogService.layer.pipe(Layer.provide(warehouse.layer))))

			const [plain, filtered] = warehouse.sql
			expect(plain).toContain(`OrgId = '${ORG}'`)
			expect(plain).not.toContain("ActorType =")
			expect(plain).not.toContain("has(ChangedFields")
			expect(plain).toMatch(/ORDER BY occurredAt DESC, id DESC/)
			expect(filtered).toContain("ActorType = 'api_key'")
			expect(filtered).toContain("has(ChangedFields, 'scopes')")
			expect(filtered).toContain("OccurredAt >= '2026-08-29 09:12:00.412'")
			expect(filtered).toMatch(/LIMIT 5\s+OFFSET 5/)
			// Never routed to an org's BYO warehouse.
			expect(plain).toContain("audit_log")
		}),
	)
})

/** Three entries with distinct timestamps: user, then api_key, then agent. */
const seedThree = Effect.gen(function* () {
	const audit = yield* AuditLogService
	yield* audit.record({
		orgId: ORG,
		actor: { type: "user", userId: USER },
		source: "dashboard",
		action: "dashboard.created",
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

// The in-memory layer backs every route and workflow test, so its filter and
// ordering semantics must match the warehouse query's.
describe("AuditLogService.layerMemory", () => {
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
			expect(oldest.metadata).toEqual({ name: "First" })

			const newest = rows[0]!
			expect(newest.actorType).toBe("agent")
			expect(newest.actorLabel).toBe("triage-bot")
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

	it.effect("filters by actor type and outcome, and pages newest-first", () =>
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

			const apiKeyRows = yield* audit.list(ORG, { actorType: "api_key", limit: 10, offset: 0 })
			expect(apiKeyRows.map((row) => row.action)).toEqual(["alert_rule.updated"])
			expect(yield* audit.list(ORG, { actorType: "system", limit: 10, offset: 0 })).toEqual([])

			const denied = yield* audit.list(ORG, { outcome: "denied", limit: 10, offset: 0 })
			expect(denied.map((row) => row.action)).toEqual(["alert_rule.deleted"])
			expect(denied[0]!.denialReason).toBe("missing role: admin")

			const secondPage = yield* audit.list(ORG, { limit: 2, offset: 2 })
			expect(secondPage.map((row) => row.action)).toEqual(["alert_rule.updated", "dashboard.created"])
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
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
			expect(rows[0]!.changes).toEqual({ fields: ["name"], before: { name: "a" }, after: { name: "b" } })
			expect(yield* audit.list(ORG, { changedField: "description", limit: 10, offset: 0 })).toEqual([])
		}).pipe(Effect.provide(AuditLogService.layerMemory)),
	)

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
				Effect.provide(AuditLogService.layerMemory),
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
})
