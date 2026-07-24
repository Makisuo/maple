import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { AiTriageRunCreateRequest, OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { AiTriageService } from "./AiTriageService"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"

const createdDbs: TestDb[] = []

afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const ORG = Schema.decodeUnknownSync(OrgId)("org_alert_triage_test")
const RULE_NAME = "Checkout error rate"

/**
 * Seed one alert rule + one open incident and return the incident id. Mirrors the
 * NOT NULL columns of `alert_rules` / `alert_incidents` (defaults fill the rest).
 */
const seedAlertIncident = async (db: TestDb): Promise<string> => {
	const ruleId = randomUUID()
	const incidentId = randomUUID()
	const now = new Date().toISOString()
	await executeSql(
		db,
		`INSERT INTO alert_rules
			(id, org_id, name, enabled, severity, service_names_json, signal_type, comparator,
			 threshold, window_minutes, minimum_sample_count, consecutive_breaches_required,
			 consecutive_healthy_required, renotify_interval_minutes, destination_ids_json,
			 reducer, no_data_behavior, created_at, updated_at, created_by, updated_by)
		 VALUES ($1,$2,$3,true,'critical',$4::jsonb,'error_rate','gt',0.05,15,5,2,2,30,
			 '[]'::jsonb,'avg','skip',$5,$5,'user_seed','user_seed')`,
		[ruleId, ORG, RULE_NAME, JSON.stringify(["checkout-api"]), now],
	)
	await executeSql(
		db,
		`INSERT INTO alert_incidents
			(id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity,
			 status, comparator, threshold, first_triggered_at, last_triggered_at,
			 last_observed_value, last_sample_count, dedupe_key, error_issue_id, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,'checkout-api','error_rate','critical','open','gt',0.05,$6,$6,
			 0.12,200,$7,NULL,$6,$6)`,
		[incidentId, ORG, ruleId, `ikey-${incidentId}`, RULE_NAME, now, `${ORG}:${ruleId}:checkout-api`],
	)
	return incidentId
}

describe("AiTriageService alert incidentKind", () => {
	it.effect("createRun builds alert context instead of failing NotFound", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			// Acquiring the service forces the Database layer (and its migrations) to
			// build before we seed via raw SQL.
			const service = yield* AiTriageService
			const incidentId = yield* Effect.promise(() => seedAlertIncident(db))

			// No WorkerEnvironment in tests → the run is enqueued then marked failed
			// (binding unavailable), but the row + contextJson are written first. The
			// regression we guard: this used to throw AiTriageNotFoundError.
			const doc = yield* service.createRun(
				ORG,
				new AiTriageRunCreateRequest({ incidentKind: "alert", incidentId }),
			)

			expect(doc.incidentKind).toBe("alert")
			expect(doc.incidentId).toBe(incidentId)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ incident_kind: string; context_json: Record<string, unknown> }>(
					db,
					`SELECT incident_kind, context_json FROM ai_triage_runs WHERE incident_id = $1`,
					[incidentId],
				),
			)
			expect(row?.incident_kind).toBe("alert")
			expect(row?.context_json?.kind).toBe("alert")
			expect(row?.context_json?.ruleName).toBe(RULE_NAME)
			expect(row?.context_json?.signalType).toBe("error_rate")
		}).pipe(Effect.provide(Layer.provide(AiTriageService.layer, db.layer)))
	})

	it.effect("createRun fails NotFound for an unknown alert incident", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const service = yield* AiTriageService
			const exit = yield* service
				.createRun(
					ORG,
					new AiTriageRunCreateRequest({ incidentKind: "alert", incidentId: randomUUID() }),
				)
				.pipe(Effect.exit)
			expect(exit._tag).toBe("Failure")
		}).pipe(Effect.provide(Layer.provide(AiTriageService.layer, db.layer)))
	})
})
