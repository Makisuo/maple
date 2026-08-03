import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { decodePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import type { WarehouseQueryServiceShape } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { IngestAttributeMappingService } from "@/services/org/IngestAttributeMappingService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { PlanetScaleDiscoveryService } from "@/services/integrations/PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { V2SchemaErrorsLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	Phase1ResourceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * End-to-end HTTP tests for `GET /v2/instrumentation/audit` over an embedded PGlite. The pure check
 * predicates are covered in packages/domain/src/setup-audit.test.ts — these assert the wire contract,
 * the public-ID encoding of affected entities, and the two degradation paths (no telemetry ever
 * received, warehouse unreachable).
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_audit_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_audit_e2e")

const die = () => Effect.die(new Error("not available in this test harness"))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3486",
			MCP_PORT: "3487",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/**
 * The audit fires eight differently-shaped reads, so the stub dispatches on the compiled SQL's table
 * and lets `decodeRows` apply that query's own row schema — which also proves the row schemas accept
 * ClickHouse's string-encoded integers, since the fixtures below are written that way.
 */
const warehouseStub = (
	rowsByTable: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {},
): WarehouseQueryServiceShape => ({
	query: () => Effect.die(new Error("unexpected warehouse pipe query")),
	sqlQuery: () => Effect.succeed([]),
	rawSqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => {
		const table = Object.keys(rowsByTable).find((name) => compiled.sql.includes(`FROM ${name}`))
		return compiled.decodeRows(table === undefined ? [] : rowsByTable[table]!).pipe(Effect.orDie)
	},
	compiledQueryFirst: () => Effect.die(new Error("unexpected compiled query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
})

const unavailableWarehouse: WarehouseQueryServiceShape = {
	...warehouseStub(),
	compiledQuery: () => Effect.die(new Error("warehouse unreachable")),
}

/** PlanetScale integrations are only reached by `planetscale` scrape targets, never by the audit. */
const planetScaleStubs = Layer.mergeAll(
	Layer.succeed(PlanetScaleDiscoveryService, {
		discover: die,
		lastError: () => Effect.succeed(null),
		invalidate: () => Effect.void,
	}),
	Layer.succeed(PlanetScaleOAuthService, {
		startConnect: die,
		completeConnect: die,
		getValidAccessToken: die,
		listOrganizations: die,
		hasConnection: die,
		connectedByUserId: die,
		disconnect: die,
	}),
)

const makeHarness = (warehouse: WarehouseQueryServiceShape = warehouseStub()) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouse)
	// The real config-resource services back the other groups in `AllV2GroupLayersLive`; stubbing
	// them via `ConfigResourceServiceStubsLayer` would shadow the real SetupAuditService under test.
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		IngestAttributeMappingService.layer,
		OrgIngestKeysService.layer,
		RecommendationIssueService.layer.pipe(Layer.provide(warehouseLive)),
		ScrapeTargetsService.layer.pipe(Layer.provide(planetScaleStubs)),
		SetupAuditService.layer.pipe(Layer.provide(warehouseLive)),
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(warehouseLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	// `testDb.layer` applies the migrations when it is first built, so raw seed SQL must wait for it.
	let migrated: Promise<void> | undefined
	const ensureSchema = () =>
		(migrated ??= runtime.runPromise(
			Effect.gen(function* () {
				yield* Database
			}),
		))

	const request = async (method: string, path: string, options: { token?: string } = {}) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {},
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "audit-test", scopes })
			}),
		)

	/** Marks the org as having received telemetry, so the audit runs its checks. */
	const seedConnectedOrg = async () => {
		await ensureSchema()
		await executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, first_data_received_at, created_at, updated_at)
			 VALUES ($1, now(), now(), now())`,
			[ORG],
		)
	}

	const seedDestination = async (id: string, enabled: boolean, lastTestError: string | null) => {
		await ensureSchema()
		await executeSql(
			testDb,
			`INSERT INTO alert_destinations
			   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
			    last_test_error, created_at, updated_at, created_by, updated_by)
			 VALUES ($1, $2, $3, 'webhook', $4, '{}'::jsonb, '', '', '', $5, now(), now(), $6, $6)`,
			[id, ORG, `dest-${id}`, enabled, lastTestError, USER],
		)
	}

	const seedRule = async (id: string, destinationIds: ReadonlyArray<string>) => {
		await ensureSchema()
		await executeSql(
			testDb,
			`INSERT INTO alert_rules
			   (id, org_id, name, enabled, severity, signal_type, comparator, threshold, window_minutes,
			    destination_ids_json, reducer, no_data_behavior, last_scheduled_at,
			    created_at, updated_at, created_by, updated_by)
			 VALUES ($1, $2, $3, true, 'warning', 'error_rate', 'gt', 0.05, 5,
			         $4::jsonb, 'avg', 'skip', now(), now(), now(), $5, $5)`,
			[id, ORG, `rule-${id}`, JSON.stringify(destinationIds), USER],
		)
	}

	return {
		request,
		bootstrapKey,
		seedConnectedOrg,
		seedDestination,
		seedRule,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("GET /v2/instrumentation/audit", () => {
	it("returns the report envelope with a summary consistent with the checks", async () => {
		const harness = makeHarness()
		try {
			await harness.seedConnectedOrg()
			const key = await harness.bootstrapKey()

			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.object).toBe("setup_audit")
			expect(response.body.data_status).toBe("ok")
			expect(response.body.telemetry_checks_available).toBe(true)
			expect(typeof response.body.generated_at).toBe("string")
			expect(response.body.checks.length).toBeGreaterThan(0)

			const summary = response.body.summary
			const total = summary.critical + summary.warn + summary.info + summary.pass + summary.skip
			expect(total).toBe(response.body.checks.length)
			expect(
				response.body.checks.every(
					(check: { object: string }) => check.object === "setup_audit_check",
				),
			).toBe(true)

			// A brand-new org with no destinations is the canonical broken-alerting case.
			const routing = response.body.checks.find((check: { id: string }) => check.id === "CFG-ALERT-01")
			expect(routing.status).toBe("fail")
			expect(routing.severity).toBe("critical")
			expect(typeof routing.fix_hint).toBe("string")
		} finally {
			await harness.dispose()
		}
	})

	it("encodes affected alert rules as public IDs", async () => {
		const harness = makeHarness()
		try {
			await harness.seedConnectedOrg()
			await harness.seedDestination("11111111-1111-4111-8111-111111111111", true, null)
			// Points at a destination that does not exist — CFG-ALERT-03 should name the rule.
			await harness.seedRule("22222222-2222-4222-8222-222222222222", ["does-not-exist"])
			const key = await harness.bootstrapKey()

			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			expect(response.status).toBe(200)

			const routing = response.body.checks.find((check: { id: string }) => check.id === "CFG-ALERT-03")
			expect(routing.status).toBe("fail")
			expect(routing.affected_count).toBe(1)
			const affected = routing.affected[0]
			expect(affected.kind).toBe("alert_rule")
			expect(affected.id.startsWith("alrt_")).toBe(true)
			expect(decodePublicId("alrt", affected.id)).toBe("22222222-2222-4222-8222-222222222222")
			expect(affected.note).toContain("disabled or deleted")
		} finally {
			await harness.dispose()
		}
	})

	it("passes the alerting checks once a rule routes to a live destination", async () => {
		const harness = makeHarness()
		try {
			await harness.seedConnectedOrg()
			await harness.seedDestination("11111111-1111-4111-8111-111111111111", true, null)
			await harness.seedRule("22222222-2222-4222-8222-222222222222", [
				"11111111-1111-4111-8111-111111111111",
			])
			const key = await harness.bootstrapKey()

			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			const byId = new Map<string, { status: string }>(
				response.body.checks.map((check: { id: string; status: string }) => [check.id, check]),
			)
			expect(byId.get("CFG-ALERT-01")?.status).toBe("pass")
			expect(byId.get("CFG-ALERT-02")?.status).toBe("pass")
			expect(byId.get("CFG-ALERT-03")?.status).toBe("pass")
			expect(byId.get("CFG-ALERT-05")?.status).toBe("pass")
		} finally {
			await harness.dispose()
		}
	})

	it("turns real warehouse rows into telemetry findings", async () => {
		// Numbers are quoted exactly as ClickHouse's FORMAT JSON emits 64-bit integers.
		const harness = makeHarness(
			warehouseStub({
				service_usage: [
					{
						serviceName: "unknown_service:node",
						totalLogCount: "0",
						totalTraceCount: "4000",
						totalSumMetricCount: "0",
						totalGaugeMetricCount: "0",
						totalHistogramMetricCount: "0",
						totalExpHistogramMetricCount: "0",
					},
				],
				attribute_keys_hourly: [{ scope: "span", attributeKey: "user.password", usageCount: "12" }],
				traces_aggregates_hourly: [
					{
						serviceName: "unknown_service:node",
						weightedSpanCount: "4000",
						weightedErrorCount: "0",
						serverCount: "4000",
						consumerCount: "0",
						clientCount: "0",
						producerCount: "0",
						noEnvCount: "4000",
						spanNameCount: "12",
						badStatusCodes: ["ERROR"],
						badSpanKinds: [],
					},
				],
			}),
		)
		try {
			await harness.seedConnectedOrg()
			const key = await harness.bootstrapKey()

			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.telemetry_checks_available).toBe(true)

			const byId = new Map<string, { status: string; affected: ReadonlyArray<{ name: string }> }>(
				response.body.checks.map((check: { id: string }) => [check.id, check]),
			)
			expect(byId.get("RES-01")?.status).toBe("fail")
			expect(byId.get("RES-01")?.affected[0]?.name).toBe("unknown_service:node")
			expect(byId.get("RES-03")?.status).toBe("fail")
			expect(byId.get("STAT-01")?.status).toBe("fail")
			expect(byId.get("PII-01")?.status).toBe("fail")
			expect(byId.get("PII-01")?.affected[0]?.name).toBe("user.password")
			// Resource keys were never read, so the coverage checks fire too.
			expect(byId.get("RES-02")?.status).toBe("fail")
			// Nothing skipped — the warehouse answered every query.
			expect(response.body.summary.skip).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	it("skips telemetry checks and still returns 200 when the warehouse is unreachable", async () => {
		const harness = makeHarness(unavailableWarehouse)
		try {
			await harness.seedConnectedOrg()
			const key = await harness.bootstrapKey()

			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.telemetry_checks_available).toBe(false)
			expect(response.body.summary.skip).toBeGreaterThan(0)

			const skipped = response.body.checks.filter(
				(check: { status: string }) => check.status === "skip",
			)
			expect(skipped.map((check: { id: string }) => check.id)).toContain("CFG-MAP-01")
			expect(skipped.map((check: { id: string }) => check.id)).toContain("RES-01")
			// Nothing telemetry-backed is reported as a pass or a failure when there is no telemetry.
			expect(response.body.summary.critical + response.body.summary.warn).toBeGreaterThan(0)
		} finally {
			await harness.dispose()
		}
	})

	it("reports no_data with no checks before the org has ever sent telemetry", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const response = await harness.request("GET", "/v2/instrumentation/audit", {
				token: key.secret,
			})
			expect(response.status).toBe(200)
			expect(response.body.data_status).toBe("no_data")
			expect(response.body.checks).toEqual([])
			expect(response.body.summary).toEqual({ critical: 0, warn: 0, info: 0, pass: 0, skip: 0 })
		} finally {
			await harness.dispose()
		}
	})

	it("requires authentication", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("GET", "/v2/instrumentation/audit")
			expect(response.status).toBe(401)
		} finally {
			await harness.dispose()
		}
	})

	it("accepts a key scoped to instrumentation:read and rejects one without it", async () => {
		const harness = makeHarness()
		try {
			await harness.seedConnectedOrg()
			const scoped = await harness.bootstrapKey(["instrumentation:read"])
			const allowed = await harness.request("GET", "/v2/instrumentation/audit", {
				token: scoped.secret,
			})
			expect(allowed.status).toBe(200)

			const unscoped = await harness.bootstrapKey(["dashboards:read"])
			const denied = await harness.request("GET", "/v2/instrumentation/audit", {
				token: unscoped.secret,
			})
			expect(denied.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})
})
