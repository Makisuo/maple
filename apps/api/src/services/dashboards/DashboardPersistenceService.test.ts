// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
	DashboardId,
	DashboardDocument,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	UserId,
} from "@maple/domain/http"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { DashboardPersistenceService } from "./DashboardPersistenceService"
import { Env } from "@/platform/Env"
import { CURRENT_DASHBOARD_SCHEMA_VERSION, upgradeStoredDocument } from "@maple/widgets/dashboard"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"

const trackedDbs: TestDb[] = []

// A Database layer that builds successfully but fails every query, exercising
// the service's `mapError(toPersistenceError)` path. The unreachable-URL
// approach instead fails during migration in layer construction, surfacing a
// raw DatabaseError that never reaches the service's mapping.
const failingDatabaseLayer = Layer.succeed(
	Database,
	Database.of({
		execute: () =>
			Effect.fail(new DatabaseError({ message: "simulated query failure", cause: new Error("boom") })),
	}),
)

afterEach(() => cleanupTestDbs(trackedDbs))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

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
		}),
	)

const makeLayer = (testDb: TestDb) =>
	DashboardPersistenceService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(testConfig()),
	)

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeDashboard = (overrides: Partial<DashboardDocument> = {}): DashboardDocument =>
	new DashboardDocument({
		id: asDashboardId("dash-1"),
		name: "Dashboard",
		timeRange: {
			type: "relative",
			value: "12h",
		},
		widgets: [],
		createdAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
		updatedAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
		...overrides,
	})

const makePortableDashboard = (
	overrides: Partial<PortableDashboardDocument> = {},
): PortableDashboardDocument =>
	new PortableDashboardDocument({
		name: "Portable Dashboard",
		timeRange: {
			type: "relative",
			value: "12h",
		},
		widgets: [],
		...overrides,
	})

describe("DashboardPersistenceService", () => {
	it.effect("lists dashboards only for the requested org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(
				asOrgId("org_a"),
				asUserId("user_a"),
				makeDashboard({ id: asDashboardId("a-1"), name: "Org A" }),
			)
			yield* DashboardPersistenceService.upsert(
				asOrgId("org_b"),
				asUserId("user_b"),
				makeDashboard({ id: asDashboardId("b-1"), name: "Org B" }),
			)
			const dashboards = yield* DashboardPersistenceService.list(asOrgId("org_a"))

			assert.strictEqual(dashboards.dashboards.length, 1)
			assert.strictEqual(dashboards.dashboards[0]!.id, asDashboardId("a-1"))
			assert.strictEqual(dashboards.dashboards[0]!.name, "Org A")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("upserts by replacing existing dashboard rows for the same org/id", () => {
		const testDb = createTestDb(trackedDbs)

		const original = makeDashboard({
			id: asDashboardId("dash-1"),
			name: "First Name",
			updatedAt: asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString()),
		})

		const updated = makeDashboard({
			id: asDashboardId("dash-1"),
			name: "Second Name",
			updatedAt: asIsoDateTimeString(new Date("2026-01-01T01:00:00.000Z").toISOString()),
		})

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(asOrgId("org_a"), asUserId("user_a"), original)
			yield* DashboardPersistenceService.upsert(asOrgId("org_a"), asUserId("user_a"), updated)
			const dashboards = yield* DashboardPersistenceService.list(asOrgId("org_a"))

			assert.strictEqual(dashboards.dashboards.length, 1)
			assert.strictEqual(dashboards.dashboards[0]!.name, "Second Name")
			assert.strictEqual(dashboards.dashboards[0]!.updatedAt, updated.updatedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates dashboards from the portable import payload with fresh metadata", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const created = yield* DashboardPersistenceService.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({
					name: "Imported Dashboard",
					description: "Imported from JSON",
					tags: ["imported"],
				}),
			)

			const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))

			assert.strictEqual(typeof created.id, "string")
			assert.strictEqual(created.name, "Imported Dashboard")
			assert.strictEqual(created.description, "Imported from JSON")
			assert.deepStrictEqual(created.tags, ["imported"])
			assert.deepStrictEqual(created.widgets, [])
			assert.strictEqual(typeof created.createdAt, "string")
			assert.strictEqual(typeof created.updatedAt, "string")
			assert.strictEqual(listed.dashboards.length, 1)
			assert.strictEqual(listed.dashboards[0]!.id, created.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates a dashboard from a portable payload with no tags or description", () => {
		const testDb = createTestDb(trackedDbs)

		// `tags`/`description` are `Schema.optionalKey`; `makePortableDashboard`
		// omits both here. The create path must not forward their `undefined` values
		// into `new DashboardDocument(...)`, which the Schema.Class constructor rejects.
		return Effect.gen(function* () {
			const created = yield* DashboardPersistenceService.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({ name: "No Tags" }),
			)

			const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))

			assert.strictEqual(created.name, "No Tags")
			assert.strictEqual(created.description, undefined)
			assert.strictEqual(created.tags, undefined)
			assert.strictEqual(listed.dashboards.length, 1)
			assert.strictEqual(listed.dashboards[0]!.id, created.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("returns DashboardNotFoundError when deleting a missing dashboard", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				DashboardPersistenceService.delete(asOrgId("org_a"), asDashboardId("missing")),
			)
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, DashboardNotFoundError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("maps database/driver errors to DashboardPersistenceError", () => {
		const failingLayer = DashboardPersistenceService.layer.pipe(Layer.provide(failingDatabaseLayer))

		return Effect.gen(function* () {
			const exit = yield* Effect.exit(DashboardPersistenceService.list(asOrgId("org_a")))
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, DashboardPersistenceError)
		}).pipe(Effect.provide(failingLayer))
	})

	// `validatePayload` is the single jsonb write choke point, so repairing the
	// section invariants there covers v1 upsert, v2 PATCH, MCP, template
	// instantiate, Perses import and version restore at once.
	it.effect("repairs dangling section membership before persisting", () => {
		const testDb = createTestDb(trackedDbs)

		const widget = (id: string, membership: Record<string, string>) => ({
			id,
			visualization: "chart",
			dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
			display: {},
			layout: { x: 0, y: 0, w: 4, h: 4 },
			...membership,
		})

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(
				asOrgId("org_a"),
				asUserId("user_a"),
				makeDashboard({
					id: asDashboardId("dash-sections"),
					widgets: [
						widget("orphan", { sectionId: "deleted", tabId: "t1" }),
						widget("dangling-tab", { sectionId: "s1", tabId: "gone" }),
					],
					sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "Latency" }] }],
				}),
			)

			const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))
			const stored = listed.dashboards[0]!
			const [orphan, dangling] = stored.widgets

			// A widget pointing at a section that is gone becomes ungrouped, and
			// the keys are absent rather than `undefined` — they are optionalKey.
			assert.isFalse("sectionId" in orphan!)
			assert.isFalse("tabId" in orphan!)
			// A dangling tab snaps to the section's first tab rather than vanishing.
			assert.strictEqual(dangling!.sectionId, "s1")
			assert.strictEqual(dangling!.tabId, "t1")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("leaves a dashboard without sections byte-identical", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* DashboardPersistenceService.upsert(
				asOrgId("org_a"),
				asUserId("user_a"),
				makeDashboard({ id: asDashboardId("dash-flat"), name: "Flat" }),
			)
			const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))
			assert.isFalse("sections" in listed.dashboards[0]!)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	// Regression: `createDashboardDocument` enumerates portable fields explicitly,
	// so a newly-added one is silently dropped unless it is listed there. This
	// path backs v2 POST, JSON import and template instantiate alike — all three
	// lost their groups.
	it.effect("carries sections through the portable create path", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const created = yield* DashboardPersistenceService.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({
					name: "Grouped import",
					sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "Latency" }] }],
					widgets: [
						{
							id: "w1",
							visualization: "chart",
							dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
							display: {},
							layout: { x: 0, y: 0, w: 6, h: 4 },
							sectionId: "s1",
							tabId: "t1",
						},
					],
				}),
			)

			assert.strictEqual(created.sections?.length, 1)
			assert.strictEqual(created.sections?.[0]?.title, "Overview")
			assert.strictEqual(created.widgets[0]?.sectionId, "s1")

			// And it survives the round-trip through storage, not just the response.
			const listed = yield* DashboardPersistenceService.list(asOrgId("org_a"))
			assert.strictEqual(listed.dashboards[0]?.sections?.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	describe("schema versioning", () => {
		const readStoredPayload = (testDb: TestDb, id: string) =>
			Effect.promise(() =>
				queryFirstRow<{ payload_json: Record<string, unknown> }>(
					testDb,
					"SELECT payload_json FROM dashboards WHERE id = $1",
					[id],
				),
			)

		/** Inserts a row straight into storage, bypassing the write path's stamping. */
		const insertRawDashboard = (testDb: TestDb, id: string, payload: unknown) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO dashboards (org_id, id, name, payload_json, created_at, updated_at, created_by, updated_by, version)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						"org_a",
						id,
						"Legacy",
						JSON.stringify(payload),
						new Date("2026-01-01T00:00:00.000Z"),
						new Date("2026-01-01T00:00:00.000Z"),
						"user_a",
						"user_a",
						1,
					],
				),
			)

		const legacyPayload = (id: string) => ({
			// No `schemaVersion` key: exactly how every pre-versioning row is stored.
			id,
			name: "Legacy",
			timeRange: { type: "relative", value: "12h" },
			widgets: [
				{
					id: "w1",
					visualization: "chart",
					dataSource: {
						endpoint: "custom_query_builder_timeseries",
						params: {
							queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }],
						},
					},
					display: {},
					layout: { x: 0, y: 0, w: 6, h: 4 },
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})

		it.effect("stamps the current schema version into the stored payload", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				yield* DashboardPersistenceService.upsert(
					asOrgId("org_a"),
					asUserId("user_a"),
					makeDashboard({ id: asDashboardId("dash-stamp") }),
				)

				const row = yield* readStoredPayload(testDb, "dash-stamp")
				assert.strictEqual(row?.payload_json.schemaVersion, CURRENT_DASHBOARD_SCHEMA_VERSION)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		// These two tests used to assert lazy upgrade: a legacy row read fine and was
		// rewritten at its next natural write. Schema v3 deliberately ends that. The
		// v2 -> v3 step is a one-shot backfill rather than a migration-chain entry, so
		// this build cannot read a row the backfill has not touched — and that gap IS
		// the migration window. The pair below pins both halves of it so the window is
		// a documented, tested property rather than a surprise in production.
		it.effect("refuses a legacy row the backfill has not converted yet", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				yield* insertRawDashboard(testDb, "dash-legacy", legacyPayload("dash-legacy"))

				const outcome = yield* Effect.exit(
					DashboardPersistenceService.get(asOrgId("org_a"), asDashboardId("dash-legacy")),
				)

				// Loudly, not silently. A half-decoded document would be persisted by
				// the next read-modify-write and the original lost.
				assert.strictEqual(outcome._tag, "Failure")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("reads that same row once the backfill transform has been applied", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				// Exactly what `backfill-dashboard-datasource-v3.ts` writes back.
				yield* insertRawDashboard(
					testDb,
					"dash-backfilled",
					upgradeStoredDocument(legacyPayload("dash-backfilled")) as Record<string, unknown>,
				)

				const dashboard = yield* DashboardPersistenceService.get(
					asOrgId("org_a"),
					asDashboardId("dash-backfilled"),
				)

				assert.strictEqual(dashboard.name, "Legacy")
				const dataSource = dashboard.widgets[0]?.dataSource
				assert.strictEqual(dataSource?.kind, "query")
				// The queries survive the reshaping; only the envelope changed.
				assert.deepStrictEqual(dataSource.kind === "query" ? dataSource.queries : undefined, [
					{ id: "a", name: "A", dataSource: "traces", aggregation: "count" },
				])
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("refuses a stored payload it cannot fully decode", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const corrupt = { ...legacyPayload("dash-corrupt"), widgets: [{ id: "no-layout" }] }
				yield* insertRawDashboard(testDb, "dash-corrupt", corrupt)

				const exit = yield* Effect.exit(
					DashboardPersistenceService.get(asOrgId("org_a"), asDashboardId("dash-corrupt")),
				)

				assert.isTrue(Exit.isFailure(exit))
				const error = getError(exit)
				assert.instanceOf(error, DashboardStoredConfigInvalidError)
				assert.strictEqual(error.component, "document")
				assert.strictEqual(error.error.retryable, false)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})
})
