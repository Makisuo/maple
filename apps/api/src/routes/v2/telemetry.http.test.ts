import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId, WarehouseQueryError } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { QueryEngineExecuteResponse, type QueryEngineExecuteRequest } from "@maple/query-engine"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@/services/warehouse/WarehouseQueryService"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@/services/push/MobileDevicesService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { QueryEngineService, type QueryEngineServiceApi } from "@/services/warehouse/QueryEngineService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	makeWarehouseServiceStub,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
} from "./v2-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const SPAN_ID = "0123456789abcdef"
const START = "2026-07-15T12:00:00.000Z"
const END = "2026-07-15T13:00:00.000Z"
const allowedWindow = () => ({ start_time: START, end_time: END })
const windowQuery = `start_time=${encodeURIComponent(START)}&end_time=${encodeURIComponent(END)}`

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3490",
			MCP_PORT: "3491",
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

const logRow = {
	timestamp: "2026-07-15 12:00:01.123",
	severityText: "ERROR",
	severityNumber: 17,
	serviceName: "api",
	body: "checkout failed",
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	recordIdentity: "00112233445566778899AABBCCDDEEFF",
	logAttributes: JSON.stringify({ "error.type": "Timeout" }),
	resourceAttributes: JSON.stringify({ "service.namespace": "checkout" }),
}

const hierarchyRow = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	parentSpanId: "",
	spanName: "GET /checkout",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 42.5,
	startTime: "2026-07-15 12:00:00.000",
	statusCode: "Error",
	statusMessage: "timeout",
	spanAttributes: JSON.stringify({ "http.route": "/checkout" }),
	resourceAttributes: JSON.stringify({ "deployment.environment.name": "production" }),
	relationship: "related",
}

const rowsForSql = (sql: string): ReadonlyArray<Record<string, unknown>> => {
	if (sql.includes("FROM trace_list_mv")) {
		const rows = [
			{
				traceId: TRACE_ID,
				startTime: "2026-07-15 12:00:00",
				durationMs: 42.5,
				rootSpanName: "GET /checkout",
				rootSpanKind: "Server",
				rootServiceName: "api",
				statusCode: "Error",
				hasError: 1,
				deploymentEnvironment: "production",
				serviceNamespace: "checkout",
				httpMethod: "GET",
				httpRoute: "/checkout",
				httpStatusCode: "500",
			},
			{
				traceId: "6f3a4b5c6d7e8f901234567890abcdef",
				startTime: "2026-07-15 11:59:00",
				durationMs: 10,
				rootSpanName: "GET /health",
				rootSpanKind: "Server",
				rootServiceName: "api",
				statusCode: "Ok",
				hasError: 0,
				deploymentEnvironment: "production",
				serviceNamespace: "checkout",
				httpMethod: "GET",
				httpRoute: "/health",
				httpStatusCode: "200",
			},
		]
		return sql.includes("TraceId <") ? rows.slice(1) : rows
	}
	if (sql.includes("FROM trace_detail_spans") && sql.includes("AS relationship")) return [hierarchyRow]
	if (sql.includes("FROM trace_detail_spans") && sql.includes("toJSONString(SpanAttributes)")) {
		return [
			{
				...hierarchyRow,
				spanAttributes: JSON.stringify({ "http.route": "/checkout", "error.type": "Timeout" }),
				resourceAttributes: JSON.stringify({ "service.name": "api" }),
			},
		]
	}
	if (sql.includes("FROM logs")) return [logRow]
	if (sql.includes("FROM metric_catalog")) {
		return [
			{
				metricName: "http.server.duration",
				metricType: "histogram",
				serviceName: "api",
				metricDescription: "HTTP server duration",
				metricUnit: "ms",
				dataPointCount: "42",
				firstSeen: "2026-07-15 12:00:00",
				lastSeen: "2026-07-15 12:59:00",
				isMonotonic: "0",
			},
		]
	}
	if (sql.includes("AS baselineP95LatencyMs")) {
		return [
			// Two rows for one service: the catalog aggregates namespaces under a
			// single name, so the busiest baseline row has to win rather than the
			// last one read.
			{
				serviceName: "api",
				serviceNamespace: "checkout",
				environment: "production",
				baselineP95LatencyMs: "35",
				baselineSpanCount: "5000",
			},
			{
				serviceName: "api",
				serviceNamespace: "internal",
				environment: "production",
				baselineP95LatencyMs: "900",
				baselineSpanCount: "120",
			},
		]
	}
	// Before the catalog branch below: both read `service_overview_spans`, and
	// the environments listing projects a single column the catalog rows would
	// not decode against.
	if (sql.includes("AS environment")) {
		return [{ environment: "production" }, { environment: "staging" }]
	}
	if (sql.includes("FROM service_overview_spans")) {
		return [
			{
				serviceName: "api",
				serviceNamespaces: ["checkout"],
				deploymentEnvironments: ["production"],
				spanCount: "10",
				errorCount: "2",
				estimatedErrorCount: "4",
				estimatedSpanCount: "20",
				p50LatencyMs: "10",
				p95LatencyMs: "40",
				p99LatencyMs: "50",
			},
		]
	}
	if (sql.includes("service_map_edges_hourly")) {
		return [
			{
				sourceService: "api",
				targetService: "payments",
				callCount: "10",
				errorCount: "2",
				avgDurationMs: "12.5",
				maxDurationMs: "30",
				estimatedSpanCount: "20",
			},
		]
	}
	return []
}

const warehouseStub = makeWarehouseServiceStub({
	query: () => Effect.die(new Error("unexpected named query")),
	compiledQuery: (_tenant, compiled) =>
		compiledQueryOf(compiled).decodeRows(rowsForSql(compiledQueryOf(compiled).sql)),
	compiledQueryFirst: (_tenant, compiled) =>
		compiledQueryOf(compiled)
			.decodeRows(rowsForSql(compiledQueryOf(compiled).sql))
			.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
	ingest: () => Effect.void,
})

const queryEngineStub = {
	execute: (_tenant, request) => {
		if (request.query.kind === "breakdown") {
			return Effect.succeed(
				new QueryEngineExecuteResponse({
					result: {
						kind: "breakdown",
						source: request.query.source,
						data: [{ name: "api", value: 42 }],
					},
				}),
			)
		}
		return Effect.succeed(
			new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries",
					source: request.query.source,
					data: [{ bucket: "2026-07-15 12:00:00", series: { all: 42 } }],
				},
			}),
		)
	},
	evaluate: () => Effect.die(new Error("not used")),
	evaluateSeries: () => Effect.die(new Error("not used")),
	cachedDirect: (_tenant, _route, _payload, effect) => effect,
} satisfies QueryEngineServiceApi

const makeHarness = (
	warehouseService: WarehouseQueryServiceApi = warehouseStub,
	queryEngineService: QueryEngineServiceApi = queryEngineStub,
) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		// Not read by any telemetry route, but the v2 group layer is built as one
		// unit, so a group this suite never calls still has to resolve.
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))
	const telemetryLive = Layer.mergeAll(
		Layer.succeed(WarehouseQueryService, warehouseService),
		Layer.succeed(QueryEngineService, queryEngineService),
	)
	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(telemetryLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)
	const org = Schema.decodeUnknownSync(OrgId)("org_telemetry_e2e")
	const user = Schema.decodeUnknownSync(UserId)("user_telemetry_e2e")
	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(org, user, { name: "telemetry-test", scopes })
			}),
		)
	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body ? { "content-type": "application/json" } : undefined),
				},
				body: body ? JSON.stringify(body) : undefined,
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text ? JSON.parse(text) : null }
	}
	return {
		bootstrapKey,
		request,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 telemetry reads over HTTP", () => {
	it("serves trace, log, metric, service, and service-map reads", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()
		const bounds = { start_time: START, end_time: END }

		const traces = await harness.request("POST", "/v2/traces/search", key.secret, bounds)
		expect(traces.status).toBe(200)
		expect(traces.body.data[0]).toMatchObject({
			object: "trace",
			id: TRACE_ID,
			root_has_error: true,
		})
		const traceSeries = await harness.request("POST", "/v2/traces/timeseries", key.secret, {
			...bounds,
			aggregation: "count",
		})
		expect(traceSeries.body).toMatchObject({ object: "trace_timeseries", aggregation: "count" })
		const traceBreakdown = await harness.request("POST", "/v2/traces/breakdown", key.secret, {
			...bounds,
			aggregation: "count",
			group_by: "service",
		})
		expect(traceBreakdown.body.data[0]).toEqual({ name: "api", value: 42 })

		const trace = await harness.request("GET", `/v2/traces/${TRACE_ID}`, key.secret)
		expect(trace.status).toBe(200)
		expect(trace.body.spans).toHaveLength(1)
		expect(trace.body.truncated).toBe(false)

		const span = await harness.request("GET", `/v2/traces/${TRACE_ID}/spans/${SPAN_ID}`, key.secret)
		expect(span.status).toBe(200)
		expect(span.body.attributes["error.type"]).toBe("Timeout")

		const logs = await harness.request("POST", "/v2/logs/search", key.secret, bounds)
		expect(logs.status).toBe(200)
		expect(logs.body.data[0].id.startsWith("log_")).toBe(true)
		const log = await harness.request("GET", `/v2/logs/${logs.body.data[0].id}`, key.secret)
		expect(log.status).toBe(200)
		expect(log.body.trace_id).toBe(TRACE_ID)
		const logSeries = await harness.request("POST", "/v2/logs/timeseries", key.secret, {
			...bounds,
			aggregation: "count",
		})
		expect(logSeries.body.object).toBe("log_timeseries")
		const logBreakdown = await harness.request("POST", "/v2/logs/breakdown", key.secret, {
			...bounds,
			aggregation: "count",
			group_by: "service",
		})
		expect(logBreakdown.body.object).toBe("log_breakdown")

		const metrics = await harness.request("GET", `/v2/metrics?${windowQuery}`, key.secret)
		expect(metrics.status).toBe(200)
		expect(metrics.body.data[0].data_point_count).toBe(42)

		const metricSeries = await harness.request("POST", "/v2/metrics/timeseries", key.secret, {
			...bounds,
			aggregation: "avg",
			filters: { metric_name: "http.server.duration", metric_type: "histogram" },
		})
		expect(metricSeries.status).toBe(200)
		expect(metricSeries.body.series[0]).toEqual({
			group: null,
			points: [{ timestamp: START, value: 42 }],
		})
		const metricBreakdown = await harness.request("POST", "/v2/metrics/breakdown", key.secret, {
			...bounds,
			aggregation: "avg",
			group_by: "service",
			filters: { metric_name: "http.server.duration", metric_type: "histogram" },
		})
		expect(metricBreakdown.body.object).toBe("metric_breakdown")

		const services = await harness.request("GET", `/v2/services?${windowQuery}`, key.secret)
		expect(services.status).toBe(200)
		expect(services.body.data[0]).toMatchObject({
			name: "api",
			has_sampling: true,
			span_count: 10,
			baseline_p95_latency_ms: 35,
			baseline_span_count: 5000,
		})
		const service = await harness.request("GET", `/v2/services/api?${windowQuery}`, key.secret)
		expect(service.status).toBe(200)

		const serviceMap = await harness.request("GET", `/v2/service_map?${windowQuery}`, key.secret)
		expect(serviceMap.status).toBe(200)
		// `max_duration_ms` included on purpose: this stub is not typechecked
		// (see the partial-stub gap), so a renamed row field only ever surfaces as
		// a decode failure here. Asserting the value keeps the fixture honest.
		expect(serviceMap.body.edges[0]).toMatchObject({
			source_service: "api",
			target_service: "payments",
			max_duration_ms: 30,
		})

		const annualWindow = "start_time=2025-07-16T12%3A00%3A00.000Z&end_time=2026-07-15T12%3A00%3A00.000Z"
		const annualServices = await harness.request("GET", `/v2/services?${annualWindow}`, key.secret)
		expect(annualServices.status, JSON.stringify(annualServices.body)).toBe(200)
		expect((await harness.request("GET", `/v2/service_map?${annualWindow}`, key.secret)).status).toBe(200)

		const tooWide = "start_time=2025-07-14T12%3A00%3A00.000Z&end_time=2026-07-15T12%3A00%3A00.000Z"
		expect((await harness.request("GET", `/v2/services?${tooWide}`, key.secret)).status).toBe(400)
		expect((await harness.request("GET", `/v2/service_map?${tooWide}`, key.secret)).status).toBe(400)

		await harness.dispose()
	})

	it("requires windows, validates log IDs, and treats telemetry POSTs as scoped reads", async () => {
		const harness = makeHarness()
		const tracesKey = await harness.bootstrapKey(["traces:read"])
		const allowed = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {
			start_time: START,
			end_time: END,
		})
		expect(allowed.status).toBe(200)
		for (const [path, body] of [
			["/v2/traces/timeseries", { ...allowedWindow(), aggregation: "count" }],
			["/v2/traces/breakdown", { ...allowedWindow(), aggregation: "count", group_by: "service" }],
		] as const) {
			expect((await harness.request("POST", path, tracesKey.secret, body)).status).toBe(200)
		}
		const denied = await harness.request("POST", "/v2/logs/search", tracesKey.secret, {
			start_time: START,
			end_time: END,
		})
		expect(denied.status).toBe(403)
		const logsKey = await harness.bootstrapKey(["logs:read"])
		for (const [path, body] of [
			["/v2/logs/search", allowedWindow()],
			["/v2/logs/timeseries", { ...allowedWindow(), aggregation: "count" }],
			["/v2/logs/breakdown", { ...allowedWindow(), aggregation: "count", group_by: "service" }],
		] as const) {
			expect((await harness.request("POST", path, logsKey.secret, body)).status).toBe(200)
		}
		const metricsKey = await harness.bootstrapKey(["metrics:read"])
		for (const [path, body] of [
			[
				"/v2/metrics/timeseries",
				{
					...allowedWindow(),
					aggregation: "avg",
					filters: { metric_name: "http.server.duration", metric_type: "histogram" },
				},
			],
			[
				"/v2/metrics/breakdown",
				{
					...allowedWindow(),
					aggregation: "avg",
					group_by: "service",
					filters: { metric_name: "http.server.duration", metric_type: "histogram" },
				},
			],
		] as const) {
			expect((await harness.request("POST", path, metricsKey.secret, body)).status).toBe(200)
		}
		const missingWindow = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {})
		expect(missingWindow.status).toBe(400)
		const firstPage = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {
			start_time: START,
			end_time: END,
			limit: 1,
		})
		expect(firstPage.body.has_more).toBe(true)
		const secondPage = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {
			start_time: START,
			end_time: END,
			limit: 1,
			cursor: firstPage.body.next_cursor,
		})
		expect(secondPage.body.data[0].id).toBe("6f3a4b5c6d7e8f901234567890abcdef")
		const badCursor = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {
			start_time: START,
			end_time: END,
			cursor: "garbage",
		})
		expect(badCursor.status).toBe(400)
		const oversizedWindow = await harness.request("POST", "/v2/traces/search", tracesKey.secret, {
			start_time: "2026-01-01T00:00:00.000Z",
			end_time: "2026-02-02T00:00:00.000Z",
		})
		expect(oversizedWindow.status).toBe(400)
		expect(oversizedWindow.body.error.code).toBe("time_range_too_large")
		const rootKey = await harness.bootstrapKey()
		const malformedLog = await harness.request("GET", "/v2/logs/log_bad", rootKey.secret)
		expect(malformedLog.status).toBe(400)
		const removedQuery = await harness.request("POST", "/v2/query", rootKey.secret, {
			start_time: START,
			end_time: END,
			query: { kind: "raw_sql", sql: "SELECT * FROM traces WHERE $__orgFilter" },
		})
		expect(removedQuery.status).toBe(404)
		await harness.dispose()
	})

	it("preserves fractional bounds and reads complete traces by their sorting-key identity", async () => {
		const observedSql: string[] = []
		const observingWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQuery(tenant, compiled, options)
			},
			compiledQueryFirst: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQueryFirst(tenant, compiled, options)
			},
		}
		const harness = makeHarness(observingWarehouse)
		const key = await harness.bootstrapKey()

		const logs = await harness.request("POST", "/v2/logs/search", key.secret, {
			start_time: "2026-07-15T12:00:00.900Z",
			end_time: "2026-07-15T12:00:01.100Z",
		})
		expect(logs.status).toBe(200)
		const logSql = observedSql.find((sql) => sql.includes("FROM logs"))
		expect(logSql).toContain("'2026-07-15 12:00:00.900'")
		expect(logSql).toContain("'2026-07-15 12:00:01.100'")

		observedSql.length = 0
		const trace = await harness.request("GET", `/v2/traces/${TRACE_ID}`, key.secret)
		expect(trace.status).toBe(200)
		const hierarchySql = observedSql.find((sql) => sql.includes("FROM trace_detail_spans"))
		expect(hierarchySql).toContain(`TraceId = '${TRACE_ID}'`)
		expect(hierarchySql).not.toContain("Timestamp >=")
		expect(hierarchySql).not.toContain("Timestamp <=")
		expect(hierarchySql).toContain("LIMIT 5001")
		await harness.dispose()
	})

	// Regression: the summary endpoints read the hourly rollups, whose Timestamp
	// is a plain `DateTime`. They were formatting window bounds with millisecond
	// precision, which ClickHouse rejects outright — `GET /v2/services` returned
	// a 500 for three weeks. It survived because this file stubs the warehouse
	// and the SQL-catalog sweep only ever compiles second-precision fixtures, so
	// nothing checked the parameter VALUES the route actually sends.
	it("sends second-precision window bounds to the rollup-backed summary endpoints", async () => {
		const observedSql: string[] = []
		const observingWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQuery(tenant, compiled, options)
			},
			compiledQueryFirst: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQueryFirst(tenant, compiled, options)
			},
		}
		const harness = makeHarness(observingWarehouse)
		const key = await harness.bootstrapKey()

		// Deliberately fractional inbound bounds — the route must round them.
		const services = await harness.request(
			"GET",
			"/v2/services?start_time=2026-07-15T12:00:00.900Z&end_time=2026-07-16T12:00:00.100Z",
			key.secret,
		)
		expect(services.status).toBe(200)

		// The listing compiles two queries against the same rollups — the catalog
		// and the latency baseline — so pick the catalog out by its own alias.
		const catalogSql = observedSql.find((sql) => sql.includes("AS p95LatencyMs"))
		expect(catalogSql).toBeDefined()
		expect(catalogSql).toContain("'2026-07-15 12:00:00'")
		expect(catalogSql).toContain("'2026-07-16 12:00:00'")
		// A fractional literal is a TYPE_MISMATCH against a DateTime column.
		expect(catalogSql).not.toMatch(/'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+'/)

		// The baseline covers the seven days before the window, hour-floored so
		// the cache key survives a drifting client window — and second-precision
		// for the same DateTime reason.
		const baselineSql = observedSql.find((sql) => sql.includes("AS baselineP95LatencyMs"))
		expect(baselineSql).toBeDefined()
		expect(baselineSql).toContain("'2026-07-08 12:00:00'")
		expect(baselineSql).toContain("'2026-07-15 12:00:00'")
		expect(baselineSql).not.toMatch(/'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+'/)
		await harness.dispose()
	})

	it("sends second-precision window bounds to trace_list_mv search", async () => {
		const observedSql: string[] = []
		const observingWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQuery(tenant, compiled, options)
			},
			compiledQueryFirst: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQueryFirst(tenant, compiled, options)
			},
		}
		const harness = makeHarness(observingWarehouse)
		const key = await harness.bootstrapKey()

		const traces = await harness.request("POST", "/v2/traces/search", key.secret, {
			start_time: "2026-07-15T12:00:00.900Z",
			end_time: "2026-07-15T13:00:00.100Z",
		})
		expect(traces.status).toBe(200)
		const sql = observedSql.find((statement) => statement.includes("FROM trace_list_mv"))
		expect(sql).toBeDefined()
		expect(sql).toContain("'2026-07-15 12:00:00'")
		expect(sql).toContain("'2026-07-15 13:00:00'")
		expect(sql).not.toMatch(/'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+'/)
		await harness.dispose()
	})

	it("enforces signal query windows, bucket budgets, and breakdown narrowing", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["traces:read"])
		const searchTooWide = await harness.request("POST", "/v2/traces/search", key.secret, {
			start_time: "2026-07-01T00:00:00.000Z",
			end_time: "2026-07-09T00:00:00.000Z",
		})
		expect(searchTooWide.body.error.code).toBe("time_range_too_large")

		const timeseriesTooWide = await harness.request("POST", "/v2/traces/timeseries", key.secret, {
			start_time: "2026-06-01T00:00:00.000Z",
			end_time: "2026-07-03T00:00:00.000Z",
			aggregation: "count",
		})
		expect(timeseriesTooWide.body.error.code).toBe("time_range_too_large")
		const tooManyBuckets = await harness.request("POST", "/v2/traces/timeseries", key.secret, {
			...allowedWindow(),
			aggregation: "count",
			bucket_seconds: 1,
		})
		expect(tooManyBuckets.body.error).toMatchObject({
			code: "bucket_count_too_large",
			param: "bucket_seconds",
		})

		const wideBreakdown = {
			start_time: "2026-07-01T00:00:00.000Z",
			end_time: "2026-07-02T01:00:00.000Z",
			aggregation: "count",
			group_by: "service",
		}
		const unfiltered = await harness.request("POST", "/v2/traces/breakdown", key.secret, wideBreakdown)
		expect(unfiltered.body.error).toMatchObject({
			code: "breakdown_filter_required",
			param: "filters",
		})
		const filtered = await harness.request("POST", "/v2/traces/breakdown", key.secret, {
			...wideBreakdown,
			filters: { service_name: "api" },
		})
		expect(filtered.status).toBe(200)
		const breakdownTooWide = await harness.request("POST", "/v2/traces/breakdown", key.secret, {
			...wideBreakdown,
			start_time: "2026-06-01T00:00:00.000Z",
			end_time: "2026-07-02T00:00:00.000Z",
			filters: { service_name: "api" },
		})
		expect(breakdownTooWide.body.error.code).toBe("time_range_too_large")
		await harness.dispose()
	})

	it("maps public trace attribute grouping onto the validated internal query", async () => {
		let observedRequest: QueryEngineExecuteRequest | undefined
		const queryEngine: QueryEngineServiceApi = {
			...queryEngineStub,
			execute: (tenant, request) => {
				observedRequest = request
				return queryEngineStub.execute(tenant, request)
			},
		}
		const harness = makeHarness(warehouseStub, queryEngine)
		const key = await harness.bootstrapKey()
		const response = await harness.request("POST", "/v2/traces/timeseries", key.secret, {
			start_time: START,
			end_time: END,
			aggregation: "count",
			group_by: "attribute",
			group_by_attribute_key: "http.route",
		})
		expect(response.status).toBe(200)
		expect(observedRequest?.query).toMatchObject({
			seriesLimit: 50,
			filters: { groupByAttributeKeys: ["http.route"] },
		})
		const excessiveLimit = await harness.request("POST", "/v2/traces/timeseries", key.secret, {
			start_time: START,
			end_time: END,
			aggregation: "count",
			group_by: "service",
			series_limit: 101,
		})
		expect(excessiveLimit.status).toBe(400)
		await harness.dispose()
	})

	it("coerces BYO-ClickHouse numeric strings before encoding aggregation responses", async () => {
		const queryEngine: QueryEngineServiceApi = {
			...queryEngineStub,
			execute: (_tenant, request) =>
				Effect.succeed(
					(request.query.kind === "breakdown"
						? {
								result: {
									kind: "breakdown",
									source: "metrics",
									data: [{ name: "api", value: "42" }],
								},
							}
						: {
								result: {
									kind: "timeseries",
									source: "metrics",
									data: [{ bucket: "2026-07-15 12:00:00", series: { all: "42" } }],
								},
							}) as QueryEngineExecuteResponse,
				),
		}
		const harness = makeHarness(warehouseStub, queryEngine)
		const key = await harness.bootstrapKey(["metrics:read"])
		const filters = { metric_name: "http.server.duration", metric_type: "histogram" }
		const timeseries = await harness.request("POST", "/v2/metrics/timeseries", key.secret, {
			...allowedWindow(),
			aggregation: "avg",
			filters,
		})
		expect(timeseries.body.series[0].points[0].value).toBe(42)
		const breakdown = await harness.request("POST", "/v2/metrics/breakdown", key.secret, {
			...allowedWindow(),
			aggregation: "avg",
			group_by: "service",
			filters,
		})
		expect(breakdown.body.data[0].value).toBe(42)
		await harness.dispose()
	})

	it("applies bounded ClickHouse settings to log body searches", async () => {
		let observedOptions: Parameters<WarehouseQueryServiceApi["compiledQuery"]>[2]
		const observingWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (tenant, compiled, options) => {
				observedOptions = options
				return warehouseStub.compiledQuery(tenant, compiled, options)
			},
		}
		const harness = makeHarness(observingWarehouse)
		const key = await harness.bootstrapKey(["logs:read"])
		const response = await harness.request("POST", "/v2/logs/search", key.secret, {
			start_time: START,
			end_time: END,
			filters: { body_search: "checkout failed" },
		})
		expect(response.status).toBe(200)
		expect(observedOptions?.settings).toMatchObject({ maxBlockSize: 512 })
		await harness.dispose()
	})

	it("lists the organization's deployment environments", async () => {
		const observedSql: string[] = []
		const observingWarehouse: WarehouseQueryServiceApi = {
			...warehouseStub,
			compiledQuery: (tenant, compiled, options) => {
				observedSql.push(compiledQueryOf(compiled).sql)
				return warehouseStub.compiledQuery(tenant, compiled, options)
			},
		}
		const harness = makeHarness(observingWarehouse)
		const key = await harness.bootstrapKey(["environments:read"])

		const environments = await harness.request(
			"GET",
			`/v2/environments?start_time=${START}&end_time=${END}`,
			key.secret,
		)
		expect(environments.status).toBe(200)
		expect(environments.body).toEqual({
			object: "list",
			data: [
				{ object: "environment", name: "production" },
				{ object: "environment", name: "staging" },
			],
			// Always the whole list — a cursor here would never be non-null.
			has_more: false,
			next_cursor: null,
		})
		// The blank environment is excluded in SQL, not filtered afterwards: the
		// DSL reads `''` as "no filter", so offering it would hand the caller back
		// every environment under a label claiming otherwise.
		expect(observedSql[0]).toContain("!= ''")
		await harness.dispose()
	})

	it("fences the environments listing behind its own scope family", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["services:read"])
		const environments = await harness.request(
			"GET",
			`/v2/environments?start_time=${START}&end_time=${END}`,
			key.secret,
		)
		expect(environments.status).toBe(403)
		expect(environments.body.error.message).toContain("environments:read")
		await harness.dispose()
	})

	it("sanitizes warehouse failures without collapsing them to a 503", async () => {
		const failure = new WarehouseQueryError({
			message: "SECRET_CLICKHOUSE_DIAGNOSTIC",
			pipeName: "traceSummaries",
		})
		const harness = makeHarness({
			...warehouseStub,
			compiledQuery: () => Effect.fail(failure),
		})
		const key = await harness.bootstrapKey(["traces:read"])
		const response = await harness.request("POST", "/v2/traces/search", key.secret, {
			start_time: START,
			end_time: END,
		})
		// A generic query fault is a 502 with a stable per-tag code (503 is
		// reserved for genuinely retryable outages) — and the raw ClickHouse
		// diagnostic must never cross the public API boundary.
		expect(response.status).toBe(502)
		expect(response.body.error.code).toBe("warehouse_query_failed")
		expect(JSON.stringify(response.body)).not.toContain("SECRET_CLICKHOUSE_DIAGNOSTIC")
		await harness.dispose()
	})
})
