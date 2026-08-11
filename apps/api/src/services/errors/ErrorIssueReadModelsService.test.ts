import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { ErrorIncidentId, ErrorIssueId, OrgId } from "@maple/domain/primitives"
import { errorIncidents, errorIssues } from "@maple/db"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import { Clock, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceShape,
} from "@/services/warehouse/WarehouseQueryService"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueReadModelsService } from "./ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"

// Compile-time guard: cache, Env, notifications, WorkerEnvironment, and the
// broad ErrorsService cannot enter this layer without making this fail.
const readRequirements: Layer.Layer<
	ErrorIssueReadModelsService,
	never,
	Database | WarehouseQueryService | ErrorIssueWorkflowService
> = ErrorIssueReadModelsService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asIncidentId = Schema.decodeUnknownSync(ErrorIncidentId)

const ORG = asOrgId("org_error_read_models")
const OTHER_ORG = asOrgId("org_error_read_models_other")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeWarehouseStub = (contexts: Array<string>): WarehouseQueryServiceShape => ({
	query: () => Effect.die(new Error("unexpected pipe query")),
	rawSqlQuery: () => Effect.die(new Error("unexpected raw SQL query")),
	crossOrgQuery: () => Effect.die(new Error("unexpected cross-org query")),
	compiledQuery: (_tenant, compile, options) => {
		const compiled = typeof compile === "function" ? compile(baselineWarehouseCapabilities()) : compile
		return Effect.sync(() => contexts.push(options?.context ?? "")).pipe(
			Effect.andThen(
				compiled
					.decodeRows(
						options?.context === "errorIssueEnvFingerprints"
							? [{ fingerprintHash: "fp-checkout" }]
							: [],
					)
					.pipe(Effect.orDie),
			),
		)
	},
	compiledQueryBounded: () => Effect.die(new Error("unexpected bounded query")),
	compiledQueryWithCapabilities: () => Effect.die(new Error("unexpected capability-aware query")),
	compiledQueryFirst: () => Effect.die(new Error("unexpected first-row query")),
	warmRoute: () => Effect.void,
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
})

const makeLayer = (contexts: Array<string>) => {
	const database = createTestDb(createdDbs).layer
	const actors = ErrorActorsService.layer.pipe(Layer.provide(database))
	const workflow = ErrorIssueWorkflowService.layer.pipe(Layer.provide(Layer.mergeAll(database, actors)))
	const warehouse = Layer.succeed(WarehouseQueryService, makeWarehouseStub(contexts))
	const readModels = readRequirements.pipe(Layer.provide(Layer.mergeAll(database, warehouse, workflow)))
	return Layer.mergeAll(readModels, workflow, actors).pipe(Layer.provideMerge(database))
}

const seedIssue = (
	orgId: OrgId,
	issueId: ErrorIssueId,
	now: number,
	overrides: Partial<typeof errorIssues.$inferInsert> = {},
) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(errorIssues).values({
				id: issueId,
				orgId,
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout-api",
				exceptionType: "TimeoutError",
				exceptionMessage: "upstream timed out",
				topFrame: "handler.ts:42",
				firstSeenAt: msToDate(now - 60_000),
				lastSeenAt: msToDate(now),
				createdAt: msToDate(now),
				updatedAt: msToDate(now),
				...overrides,
			}),
		)
	})

describe("ErrorIssueReadModelsService", () => {
	it.effect("serves org-scoped issue and incident projections from the narrow graph", () => {
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			const database = yield* Database
			const readModels = yield* ErrorIssueReadModelsService
			const now = yield* Clock.currentTimeMillis
			const issueId = asIssueId(randomUUID())
			const hiddenIssueId = asIssueId(randomUUID())
			const incidentId = asIncidentId(randomUUID())

			yield* seedIssue(ORG, issueId, now, { fingerprintHash: "fp-checkout" })
			yield* seedIssue(OTHER_ORG, hiddenIssueId, now + 1_000, {
				fingerprintHash: "fp-hidden",
			})
			yield* database.execute((db) =>
				db.insert(errorIncidents).values({
					id: incidentId,
					orgId: ORG,
					issueId,
					status: "open",
					reason: "first_seen",
					firstTriggeredAt: msToDate(now - 30_000),
					lastTriggeredAt: msToDate(now),
					createdAt: msToDate(now),
					updatedAt: msToDate(now),
				}),
			)

			const listed = yield* readModels.listIssues(ORG, {
				deploymentEnv: "production",
			})
			assert.deepStrictEqual(
				listed.issues.map((issue) => issue.id),
				[issueId],
			)
			const counts = yield* readModels.countOpenIssuesByService(ORG)
			expect(counts).toEqual([{ serviceName: "checkout-api", openCount: 1 }])
			const detail = yield* readModels.getIssue(ORG, issueId, {})
			assert.strictEqual(detail.issue.id, issueId)
			assert.strictEqual(detail.issue.hasOpenIncident, true)
			assert.lengthOf(detail.incidents, 1)

			const issueIncidents = yield* readModels.listIssueIncidents(ORG, issueId)
			const openIncidents = yield* readModels.listOpenIncidents(ORG)
			assert.deepStrictEqual(
				issueIncidents.incidents.map((incident) => incident.id),
				[incidentId],
			)
			assert.deepStrictEqual(
				openIncidents.incidents.map((incident) => incident.id),
				[incidentId],
			)
			expect(contexts).toEqual([
				"errorIssueEnvFingerprints",
				"errorIssueTimeseries",
				"errorIssueSampleTraces",
			])
		}).pipe(Effect.provide(makeLayer(contexts)))
	})

	it.effect("preserves issue ownership and not-found semantics", () => {
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			const readModels = yield* ErrorIssueReadModelsService
			const now = yield* Clock.currentTimeMillis
			const issueId = asIssueId(randomUUID())
			yield* seedIssue(OTHER_ORG, issueId, now)

			const detailError = yield* Effect.flip(readModels.getIssue(ORG, issueId, {}))
			const incidentsError = yield* Effect.flip(readModels.listIssueIncidents(ORG, issueId))
			assert.strictEqual(detailError._tag, "@maple/http/errors/ErrorIssueNotFoundError")
			assert.strictEqual(incidentsError._tag, "@maple/http/errors/ErrorIssueNotFoundError")
			assert.deepStrictEqual(contexts, [])
		}).pipe(Effect.provide(makeLayer(contexts)))
	})
})
