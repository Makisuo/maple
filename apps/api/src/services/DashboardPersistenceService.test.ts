import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
	DashboardId,
	DashboardDocument,
	DashboardNotFoundError,
	DashboardPersistenceError,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	UserId,
} from "@maple/domain/http"
import { Database, DatabaseError } from "@/lib/DatabaseLive"
import { DashboardPersistenceService } from "./DashboardPersistenceService"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"

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
})
