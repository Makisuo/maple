import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService } from "@maple/cache"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/platform/test-pglite"
import type { WarehouseQueryServiceShape } from "@/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { AlertRuntime, AlertsService } from "@/services/alerts/AlertsService"
import { AlertDestinationsService } from "@/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@/services/alerts/AlertRulesService"
import { HazelOAuthService } from "@/services/auth/HazelOAuthService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { OrgMembersService } from "@/services/org/OrgMembersService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { V2SchemaErrorsLive } from "./error-envelope"
import {
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"
import { InvestigationService } from "@/services/errors/InvestigationService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3480",
			MCP_PORT: "3481",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/** The v2 alert CRUD endpoints never reach the warehouse; stub it inert. */
const warehouseStub: WarehouseQueryServiceShape = {
	query: () => Effect.die(new Error("unexpected warehouse pipe query")),
	sqlQuery: () => Effect.succeed([]),
	rawSqlQuery: () => Effect.succeed([]),
	compiledQuery: (_tenant, compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: () => Effect.die(new Error("unexpected compiled query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
}

const makeHarness = (warehouseService: WarehouseQueryServiceShape = warehouseStub) => {
	const testDb = createTestDb(createdDbs)
	const configLive = testConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseService)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = QueryEngineService.layer.pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, {
		now: Effect.sync(() => Date.now()),
		makeUuid: () => crypto.randomUUID(),
		fetch: globalThis.fetch,
		deliveryTimeoutMs: () => 15_000,
	})
	const hazelOAuthLive = HazelOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, testDb.layer)))
	const emailLive = Layer.succeed(EmailService, {
		isConfigured: false,
		send: () => Effect.void,
	})
	const orgMembersLive = Layer.succeed(OrgMembersService, {
		resolveMembers: () => Effect.succeed([]),
	})
	// Held by AlertsService only to hand an autonomous investigation turn its `submit_diagnosis`
	// tool; nothing in these tests starts one. The real layer is cheap — Env plus the database.
	const investigationsLive = InvestigationService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)
	const orgChSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, testDb.layer, edgeCacheLive)),
	)
	const alertDestinationsLive = AlertDestinationsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(envLive, testDb.layer, runtimeLive, hazelOAuthLive, emailLive, orgMembersLive),
		),
	)
	const alertReadModelsLive = AlertReadModelsService.layer.pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, warehouseLive)),
	)
	const alertRulesLive = AlertRulesService.layer.pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, runtimeLive)),
	)
	const alertsLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				testDb.layer,
				queryEngineLive,
				warehouseLive,
				runtimeLive,
				hazelOAuthLive,
				emailLive,
				orgMembersLive,
				orgChSettingsLive,
				investigationsLive,
				alertDestinationsLive,
				alertReadModelsLive,
				alertRulesLive,
			),
		),
	)
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		alertDestinationsLive,
		alertReadModelsLive,
		alertRulesLive,
		alertsLive,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_alerts_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_alerts_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "alerts-test", scopes })
			}),
		)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		bootstrapKey,
		request,
		testDb,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 alerts over HTTP", () => {
	const createWebhookAndRule = async (harness: ReturnType<typeof makeHarness>, token: string) => {
		const destination = await harness.request("POST", "/v2/alerts/destinations", token, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		const rule = await harness.request("POST", "/v2/alerts/rules", token, {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		return { destination, rule }
	}

	it("supports destination + rule CRUD with v2 wire conventions", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])

		const destCreated = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Ops hook",
			url: "https://example.com/hooks/maple",
		})
		expect(destCreated.status).toBe(200)
		expect(destCreated.body.object).toBe("alert_destination")
		expect(destCreated.body.id).toMatch(/^dest_/)
		expect(destCreated.body.type).toBe("webhook")
		expect(destCreated.body.txid).toMatch(/^\d+$/)
		// Secrets never round-trip: only the redacted summary comes back.
		expect(JSON.stringify(destCreated.body)).not.toContain("signing")
		expect("url" in destCreated.body).toBe(false)

		const destId: string = destCreated.body.id

		const destUpdated = await harness.request("PATCH", `/v2/alerts/destinations/${destId}`, key.secret, {
			type: "webhook",
			name: "Primary ops hook",
		})
		expect(destUpdated.status).toBe(200)
		expect(destUpdated.body.name).toBe("Primary ops hook")
		expect(destUpdated.body.txid).toMatch(/^\d+$/)

		const ruleCreated = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destId],
			tags: ["payments"],
		})
		expect(ruleCreated.status).toBe(200)
		expect(ruleCreated.body.object).toBe("alert_rule")
		expect(ruleCreated.body.id).toMatch(/^alrt_/)
		expect(ruleCreated.body.destination_ids).toEqual([destId])
		expect(ruleCreated.body.no_data_behavior).toBe("skip")
		expect(ruleCreated.body.txid).toMatch(/^\d+$/)
		expect("signalType" in ruleCreated.body).toBe(false)

		const ruleId: string = ruleCreated.body.id

		const listed = await harness.request("GET", "/v2/alerts/rules?limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data[0].id).toBe(ruleId)
		expect("txid" in listed.body.data[0]).toBe(false)

		const retrieved = await harness.request("GET", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.name).toBe("Checkout error rate")

		// PATCH is a true partial update: pausing the rule keeps the condition.
		const patched = await harness.request("PATCH", `/v2/alerts/rules/${ruleId}`, key.secret, {
			enabled: false,
		})
		expect(patched.status).toBe(200)
		expect(patched.body.enabled).toBe(false)
		expect(patched.body.threshold).toBe(0.05)
		expect(patched.body.tags).toEqual(["payments"])
		expect(patched.body.txid).toMatch(/^\d+$/)

		const checks = await harness.request("GET", `/v2/alerts/rules/${ruleId}/checks`, key.secret)
		expect(checks.status).toBe(200)
		expect(checks.body).toMatchObject({ object: "list", data: [], has_more: false })
		const summary = await harness.request(
			"GET",
			`/v2/alerts/rules/${ruleId}/checks/summary?since=2025-01-01T00%3A00%3A00.000Z&until=2025-12-31T00%3A00%3A00.000Z`,
			key.secret,
		)
		expect(summary.status).toBe(200)
		expect(summary.body).toMatchObject({
			object: "alert_check.summary",
			top_group_keys: [],
			totals: { total: 0 },
			points: [],
		})
		expect(summary.body.bucket_seconds).toBeGreaterThan(0)
		expect((364 * 24 * 60 * 60) / summary.body.bucket_seconds).toBeLessThanOrEqual(720)

		const incidents = await harness.request("GET", "/v2/alerts/incidents", key.secret)
		expect(incidents.status).toBe(200)
		expect(incidents.body).toMatchObject({ object: "list", data: [] })

		// A destination referenced by a rule cannot be deleted.
		const conflicted = await harness.request("DELETE", `/v2/alerts/destinations/${destId}`, key.secret)
		expect(conflicted.status).toBe(409)
		expect(conflicted.body.error).toMatchObject({
			type: "conflict_error",
			code: "alert_destination_in_use",
		})

		const ruleDeleted = await harness.request("DELETE", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(ruleDeleted.status).toBe(200)
		expect(ruleDeleted.body).toMatchObject({ id: ruleId, object: "alert_rule", deleted: true })

		const destDeleted = await harness.request("DELETE", `/v2/alerts/destinations/${destId}`, key.secret)
		expect(destDeleted.status).toBe(200)
		expect(destDeleted.body).toMatchObject({ id: destId, object: "alert_destination", deleted: true })
		expect(destDeleted.body.txid).toMatch(/^\d+$/)

		const missing = await harness.request("GET", `/v2/alerts/rules/${ruleId}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({ type: "not_found_error", code: "alert_rule_not_found" })

		await harness.dispose()
	})

	it("paginates delivery history beyond the first 100 rows", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		await createWebhookAndRule(harness, key.secret)

		await executeSql(
			harness.testDb,
			`insert into alert_delivery_events (
				id, org_id, rule_id, destination_id, delivery_key, event_type,
				attempt_number, status, scheduled_at, payload_json, created_at, updated_at
			)
			select
				'00000000-0000-4000-8000-' || lpad(series::text, 12, '0'),
				rules.org_id, rules.id, destinations.id, 'delivery-' || series,
				'trigger', 1, 'success',
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second',
				'{}'::jsonb,
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second',
				timestamp '2026-07-31 12:00:00+00' - series * interval '1 second'
			from generate_series(1, 105) as series
			cross join lateral (
				select id, org_id from alert_rules where org_id = 'org_alerts_e2e' limit 1
			) as rules
			cross join lateral (
				select id from alert_destinations where org_id = 'org_alerts_e2e' limit 1
			) as destinations`,
		)
		await executeSql(
			harness.testDb,
			`insert into alert_delivery_events (
				id, org_id, rule_id, destination_id, delivery_key, event_type,
				attempt_number, status, scheduled_at, payload_json, created_at, updated_at
			) values (
				'00000000-0000-4000-9000-000000000001', 'org_other',
				'00000000-0000-4000-9000-000000000002', '00000000-0000-4000-9000-000000000003',
				'foreign-delivery', 'trigger', 1, 'success', timestamp '2026-08-01 12:00:00+00',
				'{}'::jsonb, timestamp '2026-08-01 12:00:00+00', timestamp '2026-08-01 12:00:00+00'
			)`,
		)

		const first = await harness.request("GET", "/v2/alerts/deliveries?limit=60", key.secret)
		expect(first.status).toBe(200)
		expect(first.body.data).toHaveLength(60)
		expect(first.body.has_more).toBe(true)
		expect(first.body.next_cursor).toEqual(expect.any(String))
		expect(first.body.data[0].id).toMatch(/^evt_/)
		expect(first.body.data[0].scheduled_at > first.body.data[1].scheduled_at).toBe(true)

		const second = await harness.request(
			"GET",
			`/v2/alerts/deliveries?limit=60&cursor=${encodeURIComponent(first.body.next_cursor)}`,
			key.secret,
		)
		expect(second.status).toBe(200)
		expect(second.body.data).toHaveLength(45)
		expect(second.body.has_more).toBe(false)
		expect(second.body.next_cursor).toBeNull()
		expect(new Set([...first.body.data, ...second.body.data].map((item) => item.id)).size).toBe(105)
		expect(
			[...first.body.data, ...second.body.data].some(
				(item) => item.delivery_key === "foreign-delivery",
			),
		).toBe(false)

		await harness.dispose()
	})

	it("clears stored raw SQL when a rule switches to a structured signal", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Raw transition hook",
			url: "https://example.com/hooks/raw-transition",
		})
		expect(destination.status).toBe(200)

		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Raw transition rule",
			severity: "warning",
			signal_type: "raw_query",
			raw_query_sql:
				"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
			raw_query_reducer: "max",
			comparator: "gt",
			threshold: 10,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		expect(created.body.raw_query_sql).toContain("$__orgFilter")

		const patched = await harness.request("PATCH", `/v2/alerts/rules/${created.body.id}`, key.secret, {
			signal_type: "error_rate",
		})
		expect(patched.status, JSON.stringify(patched.body)).toBe(200)
		expect(patched.body.signal_type).toBe("error_rate")
		expect(patched.body.raw_query_sql).toBeNull()
		expect(patched.body.raw_query_reducer).toBeNull()
		await harness.dispose()
	})

	it("rejects hidden raw SQL on structured rules", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])
		const response = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Disguised raw rule",
			severity: "warning",
			signal_type: "error_rate",
			raw_query_sql: "SELECT count() AS value FROM traces WHERE $__orgFilter",
			comparator: "gt",
			threshold: 0.1,
			window_minutes: 5,
			destination_ids: [],
		})
		expect(response.status).toBe(400)
		expect(response.body.error).toMatchObject({ type: "invalid_request_error" })
		await harness.dispose()
	})

	it("blocks raw SQL preview for non-admin keys without querying the warehouse", async () => {
		let warehouseCalls = 0
		const harness = makeHarness({
			...warehouseStub,
			sqlQuery: () => {
				warehouseCalls += 1
				return Effect.succeed([{ value: 42 }])
			},
		})
		// Preview needs only `alerts:read`, but replaying a raw_query rule executes
		// user-authored ClickHouse — the same capability creating one requires. A
		// read-only key must not get there via preview.
		const key = await harness.bootstrapKey(["alerts:read"])
		const response = await harness.request("POST", "/v2/alerts/rules/preview", key.secret, {
			rule: {
				name: "Raw preview",
				severity: "warning",
				signal_type: "raw_query",
				raw_query_sql:
					"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				raw_query_reducer: "max",
				comparator: "gt",
				threshold: 10,
				window_minutes: 5,
				destination_ids: [],
			},
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-01-01T00:30:00.000Z",
		})
		expect(response.status).toBe(403)
		expect(warehouseCalls).toBe(0)
		await harness.dispose()
	})

	it("previews a raw SQL alert for alerts:write keys", async () => {
		const harness = makeHarness({
			...warehouseStub,
			rawSqlQuery: () => Effect.succeed([{ value: 42, samples: 20 }]),
		})
		const key = await harness.bootstrapKey(["alerts:write"])
		const response = await harness.request("POST", "/v2/alerts/rules/preview", key.secret, {
			rule: {
				name: "Raw preview",
				severity: "warning",
				signal_type: "raw_query",
				raw_query_sql:
					"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
				raw_query_reducer: "max",
				comparator: "gt",
				threshold: 10,
				window_minutes: 5,
				destination_ids: [],
			},
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-01-01T00:30:00.000Z",
		})
		expect(response.status).toBe(200)
		expect(response.body.object).toBe("alert_rule.preview")
		expect(response.body.series.length).toBeGreaterThan(0)
		await harness.dispose()
	})

	it("paginates alert checks beyond the former 2,000-row window", async () => {
		const checkRows = Array.from({ length: 2_005 }, (_, index) => {
			const timestamp = new Date(Date.UTC(2026, 0, 1) + (2_005 - index) * 1_000).toISOString()
			return {
				timestamp,
				groupKey: `service=api-${String(index).padStart(4, "0")}`,
				status: "healthy",
				signalType: "error_rate",
				comparator: "gt",
				threshold: 0.05,
				observedValue: 0.01,
				sampleCount: 100,
				windowMinutes: 5,
				windowStart: timestamp,
				windowEnd: timestamp,
				consecutiveBreaches: 0,
				consecutiveHealthy: 1,
				incidentId: null,
				incidentTransition: "none",
				evaluationDurationMs: 8,
				errorMessage: null,
				errorCategory: "",
			}
		})
		const pagedWarehouse: WarehouseQueryServiceShape = {
			...warehouseStub,
			compiledQuery: (_tenant, compiled, options) => {
				if (options?.context !== "listAlertChecks") return compiled.decodeRows([]).pipe(Effect.orDie)
				const limit = Number(/LIMIT\s+(\d+)/i.exec(compiled.sql)?.[1] ?? 100)
				const before = /Timestamp < '([^']+)'/i.exec(compiled.sql)?.[1]
				const status = /Status = '([^']+)'/i.exec(compiled.sql)?.[1]
				const beforeMs = before === undefined ? undefined : Date.parse(`${before.replace(" ", "T")}Z`)
				const rows = checkRows.filter(
					(row) =>
						(beforeMs === undefined || Date.parse(row.timestamp) < beforeMs) &&
						(status === undefined || row.status === status),
				)
				return compiled.decodeRows(rows.slice(0, limit)).pipe(Effect.orDie)
			},
		}
		const harness = makeHarness(pagedWarehouse)
		const key = await harness.bootstrapKey(["alerts:write"])
		const destination = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "webhook",
			name: "Pagination hook",
			url: "https://example.com/hooks/pagination",
		})
		expect(destination.status).toBe(200)
		const created = await harness.request("POST", "/v2/alerts/rules", key.secret, {
			name: "Pagination rule",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: [destination.body.id],
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)

		let cursor: string | null = null
		const seen = new Set<string>()
		do {
			const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
			const page = await harness.request(
				"GET",
				`/v2/alerts/rules/${created.body.id}/checks?limit=100${suffix}`,
				key.secret,
			)
			expect(page.status).toBe(200)
			for (const check of page.body.data) seen.add(`${check.timestamp}:${check.group_key}`)
			cursor = page.body.next_cursor
		} while (cursor !== null)

		expect(seen.size).toBe(2_005)

		const filtered = await harness.request(
			"GET",
			`/v2/alerts/rules/${created.body.id}/checks?limit=10&status=healthy`,
			key.secret,
		)
		expect(filtered.status).toBe(200)
		expect(filtered.body.data).toHaveLength(10)
		expect(filtered.body.data.every((check: { status: string }) => check.status === "healthy")).toBe(true)
		await harness.dispose()
	})

	/**
	 * `toCreateRequest` / `toUpdateRequest` in alert-destinations.http.ts translate
	 * the snake_case v2 wire params into the internal camelCase destination configs.
	 * The schemas on either side are covered elsewhere (openapi decode tests,
	 * AlertsService merge semantics); these exercise the mapping itself end to end,
	 * so a dropped or misspelled field surfaces as a wrong stored channel rather
	 * than a silent no-op.
	 */
	it("maps slack-bot create params through to the stored channel", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])

		const created = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "slack-bot",
			name: "On-call Slack",
			channel_id: "C0789CHAN",
			channel_name: "incidents",
		})
		expect(created.status).toBe(200)
		expect(created.body.type).toBe("slack-bot")
		// `channel_name` → `channelName`, which AlertsService renders as the label.
		expect(created.body.channel_label).toBe("#incidents")
		expect(created.body.summary).toBe("#incidents")
		// The channel id is config, not a secret, but it is never echoed back.
		expect(JSON.stringify(created.body)).not.toContain("C0789CHAN")

		// `channel_name` is optional on create; without it there is no label.
		const minimal = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "slack-bot",
			name: "Bare Slack",
			channel_id: "C0790BARE",
		})
		expect(minimal.status).toBe(200)
		expect(minimal.body.channel_label).toBeNull()
		expect(minimal.body.summary).toBe("Slack channel")

		await harness.dispose()
	})

	it("maps slack-bot update params and never clobbers the stored channel with a blank", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["alerts:write"])

		const created = await harness.request("POST", "/v2/alerts/destinations", key.secret, {
			type: "slack-bot",
			name: "On-call Slack",
			channel_id: "C0789CHAN",
			channel_name: "incidents",
		})
		expect(created.status).toBe(200)
		const id: string = created.body.id

		// A supplied channel_name maps through and re-derives the label.
		const renamed = await harness.request("PATCH", `/v2/alerts/destinations/${id}`, key.secret, {
			type: "slack-bot",
			channel_name: "alerts",
		})
		expect(renamed.status).toBe(200)
		expect(renamed.body.channel_label).toBe("#alerts")

		// An omitted channel_name is DROPPED by the mapper (rather than sent as
		// `channelName: undefined`), so AlertsService keeps the stored channel — a
		// name-only edit must not wipe it.
		const nameOnly = await harness.request("PATCH", `/v2/alerts/destinations/${id}`, key.secret, {
			type: "slack-bot",
			name: "Primary on-call Slack",
		})
		expect(nameOnly.status).toBe(200)
		expect(nameOnly.body.name).toBe("Primary on-call Slack")
		expect(nameOnly.body.channel_label).toBe("#alerts")

		// An explicit blank never reaches the mapper: both fields are non-empty
		// optional strings, so a blank is rejected at decode instead of silently
		// wiping the stored channel.
		for (const blank of [{ channel_name: "" }, { channel_id: "" }]) {
			const rejected = await harness.request("PATCH", `/v2/alerts/destinations/${id}`, key.secret, {
				type: "slack-bot",
				...blank,
			})
			expect(rejected.status).toBe(400)
			expect(rejected.body.error).toMatchObject({ type: "invalid_request_error" })
		}

		// …and the stored channel survived every rejected write.
		const after = await harness.request("GET", `/v2/alerts/destinations/${id}`, key.secret)
		expect(after.status).toBe(200)
		expect(after.body.channel_label).toBe("#alerts")

		await harness.dispose()
	})

	it("enforces the alerts scope family and rejects malformed ids", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["alerts:read"])

		const list = await harness.request("GET", "/v2/alerts/rules", readOnly.secret)
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/alerts/rules", readOnly.secret, {
			name: "Denied",
			severity: "warning",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.5,
			window_minutes: 5,
			destination_ids: [],
		})
		expect(create.status).toBe(403)
		expect(create.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		// The /v2/alerts/* namespace is one scope family: alerts:read spans all three groups...
		const destinations = await harness.request("GET", "/v2/alerts/destinations", readOnly.secret)
		expect(destinations.status).toBe(200)

		// ...but another family's scope grants nothing here.
		const foreign = await harness.bootstrapKey(["dashboards:read"])
		const denied = await harness.request("GET", "/v2/alerts/destinations", foreign.secret)
		expect(denied.status).toBe(403)
		expect(denied.body.error).toMatchObject({ type: "permission_error", code: "insufficient_scope" })

		const malformed = await harness.request("GET", "/v2/alerts/rules/dash_notARuleId", readOnly.secret)
		expect(malformed.status).toBe(400)
		expect(malformed.body.error).toMatchObject({ type: "invalid_request_error" })

		await harness.dispose()
	})
})
