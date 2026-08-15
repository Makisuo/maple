/**
 * A shared board issues the queries the signed-in board issues.
 *
 * `DashboardWidgetDataService` (the share API) and `useWidgetDataSource` (the
 * browser) each build a widget's request from the same two shared functions —
 * `toWidgetRequest` then `planWidgetRequest` — and execute it through the same
 * runners. This file pins that: for each data-source kind it computes what the
 * browser would send (planner output fed to the same runner) and asserts the
 * share resolver hit the warehouse with byte-identical requests.
 *
 * Keyed on the *captured warehouse request*, not on the resolver's return
 * value, so an edit that touches only one side — a new param on the browser, a
 * different bucket policy on the server — fails here rather than in a viewer's
 * screenshot.
 */
import { describe, expect, it } from "@effect/vitest"
import { DashboardDocument, DashboardId, IsoDateTimeString, OrgId } from "@maple/domain/http"
import type { RawSqlValidationError } from "@maple/domain/http"
import {
	MAX_LIST_RANGE_SECONDS,
	coerceServiceOverviewRows,
	computeBucketSecondsForRange,
	planWidgetRequest,
	rawSqlRowsForDisplay,
	snapRangeForCache,
	type VariableValues,
} from "@maple/query-engine"
import type { WarehouseExecutionError } from "@maple/query-engine/execution"
import { fallbackStrategyFromWire, runQuerySet } from "@maple/query-engine/query-set"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import { QuerySetSchema } from "@maple/query-model"
import { dataSourceQuerySet, toWidgetRequest } from "@maple/widgets/dashboard"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { DashboardWidgetDataService, shareViewerTenant } from "./DashboardWidgetDataService"
import { makeServerQuerySetExecutor } from "./server-query-set-executor"

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)

const ORG = asOrgId("org_share_parity")
const NOW = asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString())
const die = () => Effect.die("unexpected call")

/** The batch window the share page sends: the board's "last 12 hours". */
const WINDOW = { startTime: "2026-01-01 00:00:00", endTime: "2026-01-01 12:00:00" }

const single = (value: string): VariableValues[string] => ({ value, isAll: false, options: [] })

/** One `service_overview` row as the registry query returns it — raw span totals. */
const SERVICE_OVERVIEW_ROW = {
	serviceName: "checkout",
	environment: "prod",
	serviceNamespace: "api",
	throughput: 43_200_000,
	errorCount: 432,
	estimatedErrorCount: 4320,
	spanCount: 43_200_000,
	estimatedSpanCount: 432_000_000,
	p50LatencyMs: 8,
	p95LatencyMs: 1900,
	p99LatencyMs: 4400,
	firstSeen: "2026-01-01 00:00:00",
	commits: [["", 43_200_000, 432, "2026-01-01 00:00:00"]],
}
const VARIABLES: VariableValues = { service: single("checkout"), env: single("prod") }

interface Captured {
	readonly execute: Array<{ startTime: string; endTime: string; query: unknown }>
	readonly rawSql: Array<{ sql: string; options: unknown }>
	readonly compiled: Array<unknown>
}

/**
 * A warehouse that records every request. `execute` answers timeseries and
 * list shapes with an empty-but-valid result so the runners complete; the raw
 * SQL path echoes a two-row time series so the reshaping is observable.
 */
const makeHarness = () => {
	const captured: Captured = { execute: [], rawSql: [], compiled: [] }
	const queryEngine = Layer.succeed(QueryEngineService, {
		execute: (_tenant: unknown, request: { startTime: string; endTime: string; query: unknown }) => {
			captured.execute.push(request)
			const kind = (request.query as { kind?: string }).kind
			return Effect.succeed({
				result:
					kind === "list"
						? { kind: "list", data: [], meta: { columns: [] } }
						: { kind: "timeseries", data: [{ bucket: "2026-01-01 00:00:00", series: { A: 1 } }] },
			})
		},
		evaluate: die,
		evaluateSeries: die,
		cachedDirect: (_tenant: unknown, _id: unknown, _identity: unknown, effect: Effect.Effect<unknown>) =>
			effect,
		// oxlint-disable-next-line typescript/no-explicit-any
	} as any)
	const warehouse = Layer.succeed(WarehouseQueryService, {
		rawSqlQuery: (_tenant: unknown, sql: string, options: unknown) => {
			captured.rawSql.push({ sql, options })
			return Effect.succeed([
				{ t: "2026-01-01 00:00:00", requests: 3, errors: 1 },
				{ t: "2026-01-01 00:05:00", requests: 5, errors: 0 },
			])
		},
		compiledQuery: (_tenant: unknown, compiled: unknown) => {
			captured.compiled.push(compiled)
			return Effect.succeed([SERVICE_OVERVIEW_ROW])
		},
		// oxlint-disable-next-line typescript/no-explicit-any
	} as any)
	const runtime = ManagedRuntime.make(
		DashboardWidgetDataService.layer.pipe(Layer.provide(Layer.mergeAll(queryEngine, warehouse))),
	)
	return { runtime, captured, queryEngineLayer: queryEngine, warehouseLayer: warehouse }
}

const document = (widgets: ReadonlyArray<Record<string, unknown>>): DashboardDocument =>
	new DashboardDocument({
		id: asDashboardId("dash-parity"),
		name: "Parity",
		timeRange: { type: "relative", value: "12h" },
		// oxlint-disable-next-line typescript/no-explicit-any
		widgets: widgets as any,
		createdAt: NOW,
		updatedAt: NOW,
	})

const widget = (id: string, dataSource: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	id,
	visualization: "chart",
	dataSource,
	display: {},
	layout: { x: 0, y: 0, w: 6, h: 4 },
	...extra,
})

const TIMESERIES_SOURCE = {
	kind: "query",
	resultShape: "timeseries",
	queries: [
		{
			id: "q1",
			name: "A",
			aggregation: "count",
			dataSource: "traces",
			whereClause: "service.name = '$service' AND deployment.environment = '$env'",
		},
	],
}

const RAW_SQL_SOURCE = {
	kind: "raw_sql",
	sql: "SELECT toStartOfFiveMinutes(Timestamp) AS t, count() AS requests FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND ServiceName = $service GROUP BY t",
	displayType: "line",
}

const decodeQuerySet = Schema.decodeUnknownSync(
	Schema.Struct({
		...QuerySetSchema.fields,
		strategy: Schema.optionalKey(
			Schema.Struct({ enableEmptyRangeFallback: Schema.optionalKey(Schema.Boolean) }),
		),
	}),
)

/**
 * The browser's half: `toWidgetRequest` → `planWidgetRequest` → the same
 * runner the browser's server function calls, against the same capturing
 * warehouse. What lands in `captured` is what the signed-in board would issue.
 */
const browserWould = (
	dataSource: Record<string, unknown>,
	options: { widgetTimeRange?: { type: "relative"; value: string }; variableValues?: VariableValues },
) => {
	const request = toWidgetRequest(dataSource)
	if (request === null) throw new Error("fixture must lower")
	const plan = planWidgetRequest({
		request,
		dashboardWindow: WINDOW,
		...(options.widgetTimeRange === undefined ? undefined : { widgetTimeRange: options.widgetTimeRange }),
		...(options.variableValues === undefined ? undefined : { variableValues: options.variableValues }),
	})
	if (plan.kind !== "request") throw new Error("fixture must plan")
	return plan
}

const resolveShared = (
	runtime: ManagedRuntime.ManagedRuntime<DashboardWidgetDataService, never>,
	doc: DashboardDocument,
	widgetId: string,
	variableValues: VariableValues = {},
) =>
	runtime.runPromise(
		DashboardWidgetDataService.use((service) =>
			service.resolve(ORG, doc, { widgetId, source: "primary" }, WINDOW, variableValues),
		),
	)

describe("shared widget data parity with the signed-in board", () => {
	it("query set: variables reach the where clause and the runner sees the browser's request", async () => {
		const shared = makeHarness()
		const expected = makeHarness()

		// Browser half, executed through the identical runner.
		const plan = browserWould(TIMESERIES_SOURCE, { variableValues: VARIABLES })
		const params = decodeQuerySet(plan.params)
		await expected.runtime.runPromise(
			Effect.gen(function* () {
				const queryEngine = yield* QueryEngineService
				yield* runQuerySet(makeServerQuerySetExecutor(shareViewerTenant(ORG), queryEngine), {
					querySet: { queries: params.queries },
					resultShape: "timeseries",
					startTime: plan.window.startTime,
					endTime: plan.window.endTime,
					fallback: fallbackStrategyFromWire(params.strategy),
				})
			}).pipe(Effect.provide(expected.queryEngineLayer)),
		)

		// Share half.
		const outcome = await resolveShared(
			shared.runtime,
			document([widget("w-ts", TIMESERIES_SOURCE)]),
			"w-ts",
			VARIABLES,
		)

		expect(shared.captured.execute).toEqual(expected.captured.execute)
		expect(shared.captured.execute.length).toBeGreaterThan(0)
		// And the substituted value is really in the SQL-side request, not just
		// in the params bag: a literal `$service` here is the bug this guards.
		const requestJson = JSON.stringify(shared.captured.execute)
		expect(requestJson).toContain("checkout")
		expect(requestJson).toContain("prod")
		expect(requestJson).not.toContain("$service")
		expect(outcome.data).toEqual({ data: [{ bucket: "2026-01-01 00:00:00", A: 1 }] })

		await shared.runtime.dispose()
		await expected.runtime.dispose()
	})

	it("pinned tile: the widget's own range wins over the batch window, snapped like the browser", async () => {
		const shared = makeHarness()
		const doc = document([
			widget("w-pinned", TIMESERIES_SOURCE, { timeRange: { type: "relative", value: "1h" } }),
		])

		await resolveShared(shared.runtime, doc, "w-pinned")

		const plan = browserWould(TIMESERIES_SOURCE, { widgetTimeRange: { type: "relative", value: "1h" } })
		expect(shared.captured.execute).toHaveLength(1)
		const executed = shared.captured.execute[0]!
		// Both resolve "1h" against their own `Date.now()`, a few ms apart; the
		// cache-grid snap (15s rung for 1h) makes them land on the same endpoint.
		expect(executed.endTime).toBe(plan.window.endTime)
		expect(executed.startTime).toBe(plan.window.startTime)
		expect(executed.endTime).not.toBe(WINDOW.endTime)
		const window = { startTime: executed.startTime, endTime: executed.endTime }
		expect(snapRangeForCache(window)).toEqual(window)

		await shared.runtime.dispose()
	})

	it("raw SQL: same `$__interval_s` policy, same escaped variable, same time-series reshaping", async () => {
		const shared = makeHarness()
		const expected = makeHarness()

		const plan = browserWould(RAW_SQL_SOURCE, { variableValues: VARIABLES })
		// The browser posts the planned params to `executeRawSql`, whose handler
		// fills the bucket from the rawSql policy and runs `makeExecuteRawSql`.
		const browserResult = await expected.runtime.runPromise(
			Effect.gen(function* () {
				const warehouse = yield* WarehouseQueryService
				const executeRawSql = makeExecuteRawSql<
					ReturnType<typeof shareViewerTenant>,
					WarehouseExecutionError | RawSqlValidationError
				>(warehouse)
				return yield* executeRawSql(shareViewerTenant(ORG), {
					sql: plan.params.sql as string,
					orgId: ORG,
					startTime: plan.window.startTime,
					endTime: plan.window.endTime,
					granularitySeconds: computeBucketSecondsForRange(
						plan.window.startTime,
						plan.window.endTime,
						"rawSql",
					),
					workload: "interactive",
					context: "rawSql",
				})
			}).pipe(Effect.provide(expected.warehouseLayer)),
		)
		const browserRows = rawSqlRowsForDisplay(browserResult.rows, plan.params.displayType)

		const outcome = await resolveShared(
			shared.runtime,
			document([widget("w-sql", RAW_SQL_SOURCE)]),
			"w-sql",
			VARIABLES,
		)

		expect(shared.captured.rawSql).toEqual(expected.captured.rawSql)
		expect(shared.captured.rawSql).toHaveLength(1)
		const issued = shared.captured.rawSql[0]!.sql
		expect(issued).toContain("'checkout'")
		expect(issued).not.toContain("$service")
		// 12h under the rawSql policy is a 30-minute `$__interval_s`, not the old
		// MCP ladder's 5 minutes.
		expect(computeBucketSecondsForRange(WINDOW.startTime, WINDOW.endTime, "rawSql")).toBe(1800)
		// The line shape reaches the wire as `{ bucket, series… }`, as on the board.
		expect(outcome.data).toEqual({ data: browserRows })
		expect(browserRows[0]).toEqual({ bucket: "2026-01-01 00:00:00", requests: 3, errors: 1 })

		await shared.runtime.dispose()
		await expected.runtime.dispose()
	})

	it("route endpoint: interpolated params reach the compiled query and rows are shaped as the browser shapes them", async () => {
		const shared = makeHarness()
		const doc = document([
			widget("w-route", {
				kind: "route",
				endpoint: "service_overview",
				params: { environments: ["$env"] },
			}),
		])

		const outcome = await resolveShared(shared.runtime, doc, "w-route", VARIABLES)

		expect(shared.captured.compiled).toHaveLength(1)
		const compiled = JSON.stringify(shared.captured.compiled[0])
		expect(compiled).toContain("prod")
		expect(compiled).not.toContain("$env")

		// The browser's `getServiceOverview` turns raw span totals into a
		// per-second, sampling-corrected rate over the window (12h = 43 200 s). A
		// share serving the raw rows made a "Traffic" stat read 24.4M where the
		// board read 5.6K.
		expect(outcome.data).toEqual({ data: coerceServiceOverviewRows([SERVICE_OVERVIEW_ROW], 43_200) })
		const [row] = (outcome.data as { data: ReadonlyArray<{ throughput: number; hasSampling: boolean }> })
			.data
		expect(row.throughput).toBe(10_000) // 432M estimated spans / 43 200 s
		expect(row.hasSampling).toBe(true)

		await shared.runtime.dispose()
	})

	it("list widget: the clamp re-plans over the capped window (what the browser's narrow button does)", async () => {
		const shared = makeHarness()
		const wide = { startTime: "2025-12-01 00:00:00", endTime: "2026-01-01 00:00:00" }
		const listSource = { ...TIMESERIES_SOURCE, resultShape: "list" }

		const outcome = await shared.runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([widget("w-list", listSource)]),
					{ widgetId: "w-list", source: "primary" },
					wide,
					{},
				),
			),
		)

		expect(outcome.narrowedToSeconds).toBe(MAX_LIST_RANGE_SECONDS)
		const executed = shared.captured.execute[0]!
		expect(executed.endTime).toBe(wide.endTime)
		expect((Date.parse(`${executed.endTime}Z`) - Date.parse(`${executed.startTime}Z`)) / 1000).toBe(
			MAX_LIST_RANGE_SECONDS,
		)
		// The narrowed window is what the params carry too — not just the runner
		// bounds — since `$__startTime` macros read from the params.
		expect(dataSourceQuerySet(listSource)?.resultShape).toBe("list")

		await shared.runtime.dispose()
	})
})
