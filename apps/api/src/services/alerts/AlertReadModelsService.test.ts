import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { AlertDestinationId, AlertIncidentId, AlertRuleId, OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@/services/warehouse/WarehouseQueryService"
import { AlertReadModelsService } from "./AlertReadModelsService"

// Compile-time guard: scheduler, delivery, Env, cache, and query-engine
// capabilities cannot enter this layer without making the assignment fail.
const readModelRequirements: Layer.Layer<AlertReadModelsService, never, Database | WarehouseQueryService> =
	AlertReadModelsService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asIncidentId = Schema.decodeUnknownSync(AlertIncidentId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)

const ORG = asOrgId("org_alert_read_models")
const OTHER_ORG = asOrgId("org_alert_read_models_other")
const RULE = asRuleId("00000000-0000-4000-8000-000000000010")
const INCIDENT_OLD = asIncidentId("00000000-0000-4000-8000-000000000011")
const INCIDENT_NEW = asIncidentId("00000000-0000-4000-8000-000000000012")
const DESTINATION = asDestinationId("00000000-0000-4000-8000-000000000013")
const DELIVERY = "00000000-0000-4000-8000-000000000014"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeWarehouseStub = (contexts: Array<string>): WarehouseQueryServiceApi => ({
	query: () => Effect.die(new Error("unexpected pipe query")),
	sqlQuery: () => Effect.die(new Error("unexpected raw SQL query")),
	rawSqlQuery: () => Effect.die(new Error("unexpected raw SQL query")),
	compiledQuery: (_tenant, compiled, options) =>
		Effect.sync(() => contexts.push(options?.context ?? "")).pipe(
			Effect.andThen(compiled.decodeRows([])),
		),
	compiledQueryFirst: () => Effect.die(new Error("unexpected first-row query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
})

const makeLayer = (testDb: TestDb, contexts: Array<string>) =>
	readModelRequirements.pipe(
		Layer.provide(
			Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, makeWarehouseStub(contexts))),
		),
	)

const seedReadModels = async (testDb: TestDb) => {
	const created = new Date("2026-08-01T10:00:00.000Z")
	await executeSql(
		testDb,
		`INSERT INTO alert_destinations
		   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
		    created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $2, 'Primary webhook', 'webhook', true, '{}'::jsonb, '', '', '',
		         $3, $3, 'user_read_models', 'user_read_models')`,
		[DESTINATION, ORG, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_rules
		   (id, org_id, name, enabled, severity, signal_type, comparator, threshold, window_minutes,
		    destination_ids_json, reducer, no_data_behavior, created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $2, 'Read model rule', true, 'warning', 'error_rate', 'gt', 5, 5,
		         '[]'::jsonb, 'avg', 'skip', $3, $3, 'user_read_models', 'user_read_models')`,
		[RULE, ORG, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_incidents
		   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
		    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at,
		    last_observed_value, last_sample_count, dedupe_key, created_at, updated_at)
		 VALUES
		   ($1, $3, $4, 'read-old', 'Read model rule', 'api', 'error_rate', 'warning', 'resolved',
		    'gt', 5, '2026-08-01T10:00:00Z', '2026-08-01T10:05:00Z', '2026-08-01T10:06:00Z',
		    7, 20, 'dedupe-old', $5, $5),
		   ($2, $3, $4, 'read-new', 'Read model rule', 'worker', 'error_rate', 'critical', 'open',
		    'gt', 5, '2026-08-01T10:10:00Z', '2026-08-01T10:15:00Z', null,
		    9, 30, 'dedupe-new', $5, $5)`,
		[INCIDENT_OLD, INCIDENT_NEW, ORG, RULE, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_delivery_events
		   (id, org_id, incident_id, rule_id, destination_id, delivery_key, event_type,
		    attempt_number, status, scheduled_at, attempted_at, response_code, payload_json,
		    created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'delivery-read-model', 'trigger', 1, 'success',
		         '2026-08-01T10:16:00Z', '2026-08-01T10:16:01Z', 204, '{}'::jsonb,
		         '2026-08-01T10:16:00Z', '2026-08-01T10:16:01Z')`,
		[DELIVERY, ORG, INCIDENT_NEW, RULE, DESTINATION],
	)
}

describe("AlertReadModelsService", () => {
	it.effect("reads incident and delivery projections without the scheduler graph", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			const incidents = yield* readModels.listIncidents(ORG)
			assert.deepStrictEqual(
				incidents.incidents.map((incident) => incident.id),
				[INCIDENT_NEW, INCIDENT_OLD],
			)
			const open = yield* readModels.listIncidents(ORG, { status: "open", limit: 1 })
			assert.deepStrictEqual(
				open.incidents.map((incident) => incident.id),
				[INCIDENT_NEW],
			)
			assert.strictEqual((yield* readModels.getIncident(ORG, INCIDENT_NEW)).groupKey, "worker")

			const deliveries = yield* readModels.listDeliveryEvents(ORG)
			assert.strictEqual(deliveries.events[0]?.id, DELIVERY)
			assert.strictEqual(deliveries.events[0]?.destinationName, "Primary webhook")
			assert.strictEqual(deliveries.events[0]?.responseCode, 204)

			// The incident filter is what the mobile incident timeline reads.
			const forNew = yield* readModels.listDeliveryEvents(ORG, { incidentId: INCIDENT_NEW })
			assert.deepStrictEqual(
				forNew.events.map((event) => event.id),
				[DELIVERY],
			)
			const forOld = yield* readModels.listDeliveryEvents(ORG, { incidentId: INCIDENT_OLD })
			assert.deepStrictEqual(forOld.events, [])
			const forRule = yield* readModels.listDeliveryEvents(ORG, { ruleId: RULE })
			assert.strictEqual(forRule.events.length, 1)
			assert.deepStrictEqual(contexts, [])
		}).pipe(Effect.provide(makeLayer(testDb, contexts)))
	})

	it.effect("enforces org ownership before warehouse-backed check reads", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			const missingIncident = yield* Effect.flip(readModels.getIncident(OTHER_ORG, INCIDENT_NEW))
			assert.strictEqual(missingIncident._tag, "@maple/http/errors/AlertIncidentNotFoundError")

			const missingChecks = yield* Effect.flip(readModels.listRuleChecks(OTHER_ORG, RULE, {}))
			assert.strictEqual(missingChecks._tag, "@maple/http/errors/AlertRuleNotFoundError")
			assert.deepStrictEqual(contexts, [])

			const checks = yield* readModels.listRuleChecks(ORG, RULE, { limit: 20 })
			assert.deepStrictEqual(checks.checks, [])
			const summary = yield* readModels.summarizeRuleChecks(ORG, RULE, {
				since: "2026-08-01T00:00:00.000Z",
				until: "2026-08-02T00:00:00.000Z",
			})
			expect(summary).toMatchObject({
				topGroupKeys: [],
				points: [],
				totals: { total: 0, breached: 0, healthy: 0, skipped: 0, error: 0, transitions: 0 },
			})
			assert.deepStrictEqual(contexts, [
				"listAlertChecks",
				"alertCheckSummaryGroups",
				"alertCheckSummary",
			])
		}).pipe(Effect.provide(makeLayer(testDb, contexts)))
	})
})
