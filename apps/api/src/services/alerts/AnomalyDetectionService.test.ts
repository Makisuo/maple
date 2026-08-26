import { describe, expect, it } from "@effect/vitest"
import { afterEach } from "vitest"
import { AnomalyIncidentId, OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { EdgeCacheService } from "@maple/cache"
import { Timestamp } from "@maple/domain/http/v2"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@/services/warehouse/WarehouseQueryService"
import { AnomalyDetectionService } from "./AnomalyDetectionService"
import { compiledQueryOf } from "@maple/query-engine/execution"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIncidentId = Schema.decodeUnknownSync(AnomalyIncidentId)
const decodeTimestamp = Schema.decodeUnknownSync(Timestamp)

const ORG = asOrgId("org_anomaly_counts")
const OTHER_ORG = asOrgId("org_anomaly_counts_other")

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)

const warehouseStub: WarehouseQueryServiceApi = {
	query: () => Effect.die(new Error("unexpected pipe query")),
	sqlQuery: () => Effect.die(new Error("unexpected raw SQL query")),
	rawSqlQuery: () => Effect.die(new Error("unexpected raw SQL query")),
	compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]),
	compiledQueryFirst: () => Effect.die(new Error("unexpected first-row query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
}

const makeLayer = (testDb: TestDb) => {
	const configLive = makeConfig()
	return AnomalyDetectionService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				testDb.layer,
				Layer.succeed(WarehouseQueryService, warehouseStub),
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
				Env.layer.pipe(Layer.provide(configLive)),
			),
		),
		Layer.provide(configLive),
	)
}

/** `lastTriggeredAt` ascends with `n` so the group's max is predictable. */
const seedIncident = (
	testDb: TestDb,
	incident: {
		readonly n: number
		readonly orgId: string
		readonly serviceName: string
		readonly deploymentEnv: string
		readonly signalType: string
		readonly severity: string
		readonly status: string
	},
) =>
	executeSql(
		testDb,
		`INSERT INTO anomaly_incidents
		   (id, org_id, detector_key, signal_type, service_name, deployment_env, fingerprint_hash,
		    error_issue_id, status, severity, opened_value, baseline_median, baseline_sigma,
		    threshold_value, last_observed_value, last_sample_count, first_triggered_at,
		    last_triggered_at, resolved_at, resolve_reason, triage_status, dedupe_key,
		    fingerprints_json, reopen_count, last_reopened_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, null, null, $7, $8, 0.12, 0.01, 0.004, 0.05, 0.14, 4200,
		         '2026-07-15T09:12:00Z', $9, null, null, 'none', $1, '[]'::jsonb, 0, null,
		         '2026-07-15T09:12:00Z', '2026-07-15T09:12:00Z')`,
		[
			asIncidentId(`00000000-0000-4000-8000-0000000000${String(incident.n).padStart(2, "0")}`),
			incident.orgId,
			`${incident.signalType}:${incident.serviceName}:${incident.deploymentEnv}`,
			incident.signalType,
			incident.serviceName,
			incident.deploymentEnv,
			incident.status,
			incident.severity,
			`2026-07-15T09:${String(10 + incident.n).padStart(2, "0")}:00Z`,
		],
	)

describe("AnomalyDetectionService.countIncidentsByService", () => {
	// Regression: the aggregate runs raw `sql` fragments, which Drizzle does not
	// put a column codec on. A stubbed-service HTTP test cannot see that; this
	// exercises the real query, and asserts the timestamp is exactly what the v2
	// `Timestamp` schema accepts rather than whatever the driver felt like.
	it.effect("groups open incidents and returns a v2-decodable timestamp", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				// Two open critical+warning rows in one group; the max wins.
				await seedIncident(testDb, {
					n: 1,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "warning",
					status: "open",
				})
				await seedIncident(testDb, {
					n: 2,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "critical",
					status: "open",
				})
				// Same service, different environment — its own group.
				await seedIncident(testDb, {
					n: 3,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "staging",
					signalType: "error_rate",
					severity: "warning",
					status: "open",
				})
				// Resolved, and another org's row: neither may appear.
				await seedIncident(testDb, {
					n: 4,
					orgId: ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "latency_p95",
					severity: "critical",
					status: "resolved",
				})
				await seedIncident(testDb, {
					n: 5,
					orgId: OTHER_ORG,
					serviceName: "payments",
					deploymentEnv: "production",
					signalType: "error_rate",
					severity: "critical",
					status: "open",
				})
			})

			const anomalies = yield* AnomalyDetectionService
			const rows = yield* anomalies.countIncidentsByService(ORG, {})

			const production = rows.find(
				(row) => row.deploymentEnv === "production" && row.signalType === "error_rate",
			)
			expect(rows).toHaveLength(2)
			expect(production).toBeDefined()
			expect(production?.incidentCount).toBe(2)
			// Severity rolls up to the worst in the group, not the first row's.
			expect(production?.severity).toBe("critical")
			expect(production?.lastTriggeredAt).toBe("2026-07-15T09:12:00.000Z")
			// The whole point: the handler hands this straight to `timestamp()`.
			expect(() => decodeTimestamp(production?.lastTriggeredAt)).not.toThrow()

			const staging = rows.find((row) => row.deploymentEnv === "staging")
			expect(staging?.incidentCount).toBe(1)
			expect(staging?.severity).toBe("warning")

			// The resolved row is reachable only by asking for it.
			const resolved = yield* anomalies.countIncidentsByService(ORG, { status: "resolved" })
			expect(resolved).toHaveLength(1)
			expect(resolved[0]?.signalType).toBe("latency_p95")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
