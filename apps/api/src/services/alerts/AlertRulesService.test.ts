import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AlertDestinationId,
	AlertRuleId,
	AlertRuleUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import { AlertRuntime, type AlertRuntimeApi } from "./AlertRuntime"
import { AlertRulesService } from "./AlertRulesService"

// Compile-time guard: warehouse/query-engine, Env, delivery, scheduler, and
// incident capabilities cannot enter this layer without failing the assignment.
const ruleRequirements: Layer.Layer<AlertRulesService, never, Database | AlertRuntime> =
	AlertRulesService.layer

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)

const ORG = asOrgId("org_alert_rules_service")
const OTHER_ORG = asOrgId("org_alert_rules_service_other")
const USER = asUserId("user_alert_rules_service")
const DESTINATION = asDestinationId("00000000-0000-4000-8000-000000000021")
const RULE = asRuleId("00000000-0000-4000-8000-000000000022")
const ADMIN_ROLES = [asRoleName("org:admin")]
const MEMBER_ROLES = [asRoleName("org:member")]
const NOW = Date.parse("2026-08-11T12:00:00.000Z")

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const runtime: AlertRuntimeApi = {
	now: Effect.succeed(NOW),
	makeUuid: () => RULE,
	fetch: globalThis.fetch,
	deliveryTimeoutMs: () => 15_000,
}

const makeLayer = (testDb: TestDb) =>
	ruleRequirements.pipe(Layer.provide(Layer.mergeAll(testDb.layer, Layer.succeed(AlertRuntime, runtime))))

const seedDestination = (testDb: TestDb) =>
	executeSql(
		testDb,
		`INSERT INTO alert_destinations
		   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
		    created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $2, 'Primary webhook', 'webhook', true, '{}'::jsonb, '', '', '',
		         $3, $3, $4, $4)`,
		[DESTINATION, ORG, msToDate(NOW), USER],
	)

const request = new AlertRuleUpsertRequest({
	name: "Checkout error rate",
	severity: "critical",
	enabled: true,
	serviceNames: ["checkout"],
	signalType: "error_rate",
	comparator: "gt",
	threshold: 5,
	windowMinutes: 5,
	minimumSampleCount: 10,
	consecutiveBreachesRequired: 2,
	consecutiveHealthyRequired: 2,
	renotifyIntervalMinutes: 30,
	destinationIds: [DESTINATION],
})

describe("AlertRulesService", () => {
	it.effect("creates, lists, and deletes rules without the evaluator graph", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedDestination(testDb))
			const rules = yield* AlertRulesService

			const forbidden = yield* Effect.flip(rules.createRule(ORG, USER, MEMBER_ROLES, request))
			assert.strictEqual(forbidden._tag, "@maple/http/errors/AlertForbiddenError")

			const created = yield* rules.createRule(ORG, USER, ADMIN_ROLES, request)
			assert.strictEqual(created.id, RULE)
			assert.strictEqual(created.createdAt, "2026-08-11T12:00:00.000Z")
			assert.deepStrictEqual(created.serviceNames, ["checkout"])

			const listed = yield* rules.listRules(ORG)
			assert.deepStrictEqual(
				listed.rules.map((rule) => rule.id),
				[RULE],
			)
			assert.deepStrictEqual((yield* rules.listRules(OTHER_ORG)).rules, [])

			const wrongOrg = yield* Effect.flip(rules.deleteRule(OTHER_ORG, ADMIN_ROLES, RULE))
			assert.strictEqual(wrongOrg._tag, "@maple/http/errors/AlertRuleNotFoundError")

			const deleted = yield* rules.deleteRule(ORG, ADMIN_ROLES, RULE)
			assert.strictEqual(deleted.id, RULE)
			assert.deepStrictEqual((yield* rules.listRules(ORG)).rules, [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects destination ids that do not belong to the organization", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedDestination(testDb))
			const rules = yield* AlertRulesService
			const unknown = asDestinationId("00000000-0000-4000-8000-000000000099")
			const error = yield* Effect.flip(
				rules.createRule(
					ORG,
					USER,
					ADMIN_ROLES,
					new AlertRuleUpsertRequest({ ...request, destinationIds: [unknown] }),
				),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AlertRuleDestinationNotFoundError")
			assert.strictEqual(error.destinationId, unknown)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
