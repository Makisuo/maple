// Unit tests for the pure decision logic inside inspect-widget.ts.
//
// `applyReduceToValue`, `isSingleAllGroup` and `summarizeOutcome` are module-private
// helpers; they are exercised through the smallest exported surface that reaches
// them (`inspectWidget` / `inspectWidgetsAfterMutation`) with stub
// QueryEngineService / WarehouseQueryService layers, so no warehouse is needed.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { QueryEngineResult } from "@maple/query-engine"
import { QueryEngineService, type QueryEngineServiceShape } from "@/services/QueryEngineService"
import { WarehouseQueryService, type WarehouseQueryServiceShape } from "@/lib/WarehouseQueryService"
import type { TenantContext } from "@/lib/tenant-context"
import type { DashboardDocument } from "@maple/domain/http"
import {
	inspectWidget,
	inspectWidgetsAfterMutation,
	type DashboardWidget,
	type InspectWidgetTimeRange,
} from "./inspect-widget"

const tenant = { orgId: "org_test", userId: "user_test", roles: [], authMode: "self_hosted" } as TenantContext

const timeRange: InspectWidgetTimeRange = {
	startTime: "2026-04-01 00:00:00",
	endTime: "2026-04-01 06:00:00",
	source: "dashboard",
}

const TIMESERIES_ENDPOINT = "custom_query_builder_timeseries"
const BREAKDOWN_ENDPOINT = "custom_query_builder_breakdown"

// --- stub layers -----------------------------------------------------------

/** QueryEngineService that always resolves to `result`. */
const engineReturning = (result: QueryEngineResult) =>
	Layer.succeed(QueryEngineService, {
		execute: () => Effect.succeed({ result }),
	} as unknown as QueryEngineServiceShape)

/** QueryEngineService whose `execute` throws synchronously (a defect). */
const engineDefect = Layer.succeed(QueryEngineService, {
	execute: () => {
		throw new Error("engine exploded")
	},
} as unknown as QueryEngineServiceShape)

/** WarehouseQueryService whose `list_metrics` lookup returns `metricNames`. */
const catalogWith = (metricNames: ReadonlyArray<string>) =>
	Layer.succeed(WarehouseQueryService, {
		query: () => Effect.succeed({ data: metricNames.map((metricName) => ({ metricName })) }),
	} as unknown as WarehouseQueryServiceShape)

/** WarehouseQueryService whose catalog lookup fails (we must assume "exists"). */
const catalogFailing = Layer.succeed(WarehouseQueryService, {
	query: () => Effect.fail(new Error("catalog down")),
} as unknown as WarehouseQueryServiceShape)

const stubs = (result: QueryEngineResult, metricNames: ReadonlyArray<string> = []) =>
	Layer.mergeAll(engineReturning(result), catalogWith(metricNames))

// --- fixtures --------------------------------------------------------------

const tracesDraft = (over: Record<string, unknown> = {}) => ({
	id: "q1",
	name: "Query 1",
	dataSource: "traces",
	aggregation: "count",
	...over,
})

const makeWidget = (over: {
	endpoint?: string
	params?: unknown
	transform?: Record<string, unknown>
	id?: string
	title?: string
}): DashboardWidget =>
	({
		id: over.id ?? "w1",
		visualization: "chart",
		dataSource: {
			endpoint: over.endpoint ?? TIMESERIES_ENDPOINT,
			...(over.params !== undefined ? { params: over.params } : {}),
			...(over.transform !== undefined ? { transform: over.transform } : {}),
		},
		display: over.title !== undefined ? { title: over.title } : {},
		layout: { x: 0, y: 0, w: 6, h: 4 },
	}) as unknown as DashboardWidget

const timeseries = (points: ReadonlyArray<{ bucket: string; series: Record<string, number> }>) =>
	({ kind: "timeseries", source: "traces", data: points }) satisfies QueryEngineResult

const breakdown = (rows: ReadonlyArray<{ name: string; value: number }>) =>
	({ kind: "breakdown", source: "traces", data: rows }) satisfies QueryEngineResult

const run = (widget: DashboardWidget, layer: Layer.Layer<QueryEngineService | WarehouseQueryService>) =>
	inspectWidget({ tenant, dashboardName: "dash", widget, timeRange }).pipe(Effect.provide(layer))

/** Inspect a stat widget and return its single query's `reducedValue`. */
const reduceWith = (aggregate: string | undefined, field: string, result: QueryEngineResult) =>
	Effect.gen(function* () {
		const isBreakdown = result.kind === "breakdown"
		const outcome = yield* run(
			makeWidget({
				endpoint: isBreakdown ? BREAKDOWN_ENDPOINT : TIMESERIES_ENDPOINT,
				// A breakdown query must group by something to be buildable.
				params: { queries: [isBreakdown ? groupedDraft(["service"]) : tracesDraft()] },
				transform: { reduceToValue: { field, ...(aggregate !== undefined && { aggregate }) } },
			}),
			stubs(result),
		)
		assert.strictEqual(outcome.kind, "supported")
		if (outcome.kind !== "supported") return undefined
		return outcome.data.queries[0]?.reducedValue
	})

const THREE_POINTS = timeseries([
	{ bucket: "2026-04-01 00:00:00", series: { count: 2 } },
	{ bucket: "2026-04-01 01:00:00", series: { count: 4 } },
	{ bucket: "2026-04-01 02:00:00", series: { count: 9 } },
])

// --- applyReduceToValue ----------------------------------------------------

describe("applyReduceToValue (via inspectWidget transform.reduceToValue)", () => {
	it.effect("sums timeseries values", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith("sum", "count", THREE_POINTS), 15)
		}),
	)

	it.effect("averages timeseries values", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith("avg", "count", THREE_POINTS), 5)
		}),
	)

	it.effect("defaults to avg when no aggregate is configured", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith(undefined, "count", THREE_POINTS), 5)
		}),
	)

	it.effect("supports min / max / first / count", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith("min", "count", THREE_POINTS), 2)
			assert.strictEqual(yield* reduceWith("max", "count", THREE_POINTS), 9)
			assert.strictEqual(yield* reduceWith("first", "count", THREE_POINTS), 2)
			assert.strictEqual(yield* reduceWith("count", "count", THREE_POINTS), 3)
		}),
	)

	it.effect("returns null for an unknown aggregate", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith("median", "count", THREE_POINTS), null)
		}),
	)

	it.effect("falls back to the first numeric field when the configured field is absent", () =>
		Effect.gen(function* () {
			// The renderer auto-picks the first numeric column for stat tiles, so the
			// inspector must reduce that same column rather than report a false null.
			assert.strictEqual(yield* reduceWith("sum", "not_a_column", THREE_POINTS), 15)
		}),
	)

	it.effect("returns null when there is no numeric value at all", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* reduceWith("sum", "count", timeseries([])), null)
		}),
	)

	it.effect("reduces breakdown rows through the `value` field", () =>
		Effect.gen(function* () {
			const rows = breakdown([
				{ name: "api", value: 10 },
				{ name: "web", value: 5 },
			])
			assert.strictEqual(yield* reduceWith("sum", "value", rows), 15)
			assert.strictEqual(yield* reduceWith("max", "value", rows), 10)
		}),
	)

	it.effect("reduces a breakdown row selected by name", () =>
		Effect.gen(function* () {
			const rows = breakdown([
				{ name: "api", value: 10 },
				{ name: "web", value: 5 },
			])
			assert.strictEqual(yield* reduceWith("sum", "web", rows), 5)
		}),
	)

	it.effect("omits reducedValue entirely when the widget has no reduceToValue transform", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [tracesDraft()] } }),
				stubs(THREE_POINTS),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.isUndefined(outcome.data.queries[0]?.reducedValue)
		}),
	)
})

// --- isSingleAllGroup / EMPTY_GROUPING -------------------------------------

const groupedDraft = (groupBy: ReadonlyArray<string>) =>
	tracesDraft({
		addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		groupBy: [...groupBy],
	})

describe("isSingleAllGroup (via the EMPTY_GROUPING flag)", () => {
	it.effect("flags a requested grouping that collapsed to a single `all` series", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [groupedDraft(["service"])] } }),
				stubs(
					timeseries([
						{ bucket: "2026-04-01 00:00:00", series: { all: 3 } },
						{ bucket: "2026-04-01 01:00:00", series: { all: 7 } },
					]),
				),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "EMPTY_GROUPING")
		}),
	)

	it.effect("flags a breakdown whose only row is `all`", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({
					endpoint: BREAKDOWN_ENDPOINT,
					params: { queries: [groupedDraft(["service"])] },
				}),
				stubs(breakdown([{ name: "all", value: 42 }])),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "EMPTY_GROUPING")
		}),
	)

	it.effect("does not flag real group series", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [groupedDraft(["service"])] } }),
				stubs(
					timeseries([
						{ bucket: "2026-04-01 00:00:00", series: { api: 3, web: 1 } },
						{ bucket: "2026-04-01 01:00:00", series: { api: 4, web: 2 } },
					]),
				),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.notInclude(outcome.data.flags, "EMPTY_GROUPING")
		}),
	)

	it.effect("does not flag an intentionally ungrouped chart that yields one `all` series", () =>
		Effect.gen(function* () {
			// No groupBy add-on requested — one "all" series is the expected total.
			const outcome = yield* run(
				makeWidget({ params: { queries: [tracesDraft()] } }),
				stubs(
					timeseries([
						{ bucket: "2026-04-01 00:00:00", series: { all: 3 } },
						{ bucket: "2026-04-01 01:00:00", series: { all: 7 } },
					]),
				),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.notInclude(outcome.data.flags, "EMPTY_GROUPING")
		}),
	)

	it.effect("does not flag a groupBy list holding only the `none`/`all` sentinels", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [groupedDraft(["none"])] } }),
				stubs(
					timeseries([
						{ bucket: "2026-04-01 00:00:00", series: { all: 3 } },
						{ bucket: "2026-04-01 01:00:00", series: { all: 7 } },
					]),
				),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.notInclude(outcome.data.flags, "EMPTY_GROUPING")
		}),
	)
})

// --- METRIC_NOT_FOUND ------------------------------------------------------

const metricsWidget = makeWidget({
	params: {
		queries: [
			{
				id: "q1",
				name: "Metric query",
				dataSource: "metrics",
				aggregation: "avg",
				metricName: "my.custom.metric",
				metricType: "gauge",
			},
		],
	},
})

describe("METRIC_NOT_FOUND detection", () => {
	it.effect("replaces EMPTY with METRIC_NOT_FOUND when the metric is absent from the catalog", () =>
		Effect.gen(function* () {
			const outcome = yield* run(metricsWidget, stubs(timeseries([]), ["some.other.metric"]))
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "METRIC_NOT_FOUND")
			assert.notInclude(outcome.data.flags, "EMPTY")
		}),
	)

	it.effect("keeps EMPTY when the metric does exist in the catalog", () =>
		Effect.gen(function* () {
			const outcome = yield* run(metricsWidget, stubs(timeseries([]), ["my.custom.metric"]))
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "EMPTY")
			assert.notInclude(outcome.data.flags, "METRIC_NOT_FOUND")
		}),
	)

	it.effect("assumes the metric exists when the catalog lookup fails", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				metricsWidget,
				Layer.mergeAll(engineReturning(timeseries([])), catalogFailing),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "EMPTY")
			assert.notInclude(outcome.data.flags, "METRIC_NOT_FOUND")
		}),
	)

	it.effect("never raises METRIC_NOT_FOUND for a non-metrics query", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [tracesDraft()] } }),
				stubs(timeseries([]), []),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.include(outcome.data.flags, "EMPTY")
			assert.notInclude(outcome.data.flags, "METRIC_NOT_FOUND")
		}),
	)
})

// --- non-supported outcomes ------------------------------------------------

describe("inspectWidget outcomes", () => {
	it.effect("returns `unsupported` for a predefined endpoint", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ endpoint: "service_overview", params: {} }),
				stubs(timeseries([])),
			)
			assert.strictEqual(outcome.kind, "unsupported")
			if (outcome.kind !== "unsupported") return
			assert.strictEqual(outcome.endpoint, "service_overview")
		}),
	)

	it.effect("skips a widget with no params", () =>
		Effect.gen(function* () {
			const outcome = yield* run(makeWidget({}), stubs(timeseries([])))
			assert.strictEqual(outcome.kind, "skipped")
			if (outcome.kind !== "skipped") return
			assert.strictEqual(outcome.reason, "no_params")
		}),
	)

	it.effect("skips a widget whose params don't decode", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [{ nope: true }] } }),
				stubs(timeseries([])),
			)
			assert.strictEqual(outcome.kind, "skipped")
			if (outcome.kind !== "skipped") return
			assert.strictEqual(outcome.reason, "decode_failed")
		}),
	)

	it.effect("skips a widget with no enabled queries", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [tracesDraft({ enabled: false })] } }),
				stubs(timeseries([])),
			)
			assert.strictEqual(outcome.kind, "skipped")
			if (outcome.kind !== "skipped") return
			assert.strictEqual(outcome.reason, "no_enabled_queries")
		}),
	)

	it.effect("skips a widget with more than 5 enabled queries", () =>
		Effect.gen(function* () {
			const queries = Array.from({ length: 6 }, (_, i) => tracesDraft({ id: `q${i}`, name: `Q${i}` }))
			const outcome = yield* run(makeWidget({ params: { queries } }), stubs(timeseries([])))
			assert.strictEqual(outcome.kind, "skipped")
			if (outcome.kind !== "skipped") return
			assert.strictEqual(outcome.reason, "too_many_queries")
		}),
	)

	it.effect("returns `inspection_error` (catchCause fallback) when the engine defects", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ params: { queries: [tracesDraft()] } }),
				Layer.mergeAll(engineDefect, catalogWith([])),
			)
			assert.strictEqual(outcome.kind, "inspection_error")
			if (outcome.kind !== "inspection_error") return
			assert.include(outcome.message, "engine exploded")
		}),
	)

	it.effect("records a per-query error (not a failure) when a query spec cannot be built", () =>
		Effect.gen(function* () {
			// Logs only support `count`; the builder returns `query: null` + error.
			const outcome = yield* run(
				makeWidget({
					params: { queries: [{ id: "q1", name: "Q1", dataSource: "logs", aggregation: "avg" }] },
				}),
				stubs(timeseries([])),
			)
			assert.strictEqual(outcome.kind, "supported")
			if (outcome.kind !== "supported") return
			assert.strictEqual(outcome.data.queries[0]?.status, "error")
			assert.include(outcome.data.flags, "EMPTY")
		}),
	)

	it.effect("skips a raw_sql_chart widget that has no params.sql", () =>
		Effect.gen(function* () {
			const outcome = yield* run(
				makeWidget({ endpoint: "raw_sql_chart", params: {} }),
				stubs(timeseries([])),
			)
			assert.strictEqual(outcome.kind, "skipped")
			if (outcome.kind !== "skipped") return
			assert.strictEqual(outcome.reason, "no_params")
		}),
	)
})

// --- summarizeOutcome (via inspectWidgetsAfterMutation) --------------------

const dashboardWith = (widgets: ReadonlyArray<DashboardWidget>) =>
	({
		id: "dash-1",
		name: "Dash",
		timeRange: { type: "relative", value: "6h" },
		widgets,
	}) as unknown as DashboardDocument

describe("summarizeOutcome (via inspectWidgetsAfterMutation)", () => {
	it.effect("returns the skipped summary when validate is false", () =>
		Effect.gen(function* () {
			const widget = makeWidget({ params: { queries: [tracesDraft()] } })
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith([widget]),
				widgetIds: [widget.id],
				validate: false,
			}).pipe(Effect.provide(stubs(THREE_POINTS)))

			assert.isFalse(summary.ran)
			assert.deepStrictEqual([...summary.inspected], [])
			assert.isFalse(summary.capped)
		}),
	)

	it.effect("summarizes a healthy supported widget", () =>
		Effect.gen(function* () {
			const widget = makeWidget({ params: { queries: [tracesDraft()] }, title: "Requests" })
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith([widget]),
				widgetIds: [widget.id],
				validate: true,
			}).pipe(Effect.provide(stubs(THREE_POINTS)))

			assert.isTrue(summary.ran)
			assert.strictEqual(summary.inspected.length, 1)
			assert.strictEqual(summary.inspected[0]?.widgetId, "w1")
			assert.strictEqual(summary.inspected[0]?.title, "Requests")
			assert.strictEqual(summary.inspected[0]?.verdict, "looks_healthy")
			assert.strictEqual(summary.healthyCount, 1)
			assert.strictEqual(summary.skippedCount, 0)
			// A dashboard timeRange resolved successfully.
			assert.strictEqual(summary.timeRange?.source, "dashboard")
		}),
	)

	it.effect("maps unsupported / skipped / error outcomes to their verdicts", () =>
		Effect.gen(function* () {
			const unsupported = makeWidget({ id: "w-unsup", endpoint: "service_overview", params: {} })
			const skipped = makeWidget({ id: "w-skip" })
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith([unsupported, skipped]),
				widgetIds: ["w-unsup", "w-skip"],
				validate: true,
			}).pipe(Effect.provide(stubs(THREE_POINTS)))

			assert.strictEqual(summary.inspected[0]?.verdict, "unsupported")
			assert.include(summary.inspected[0]?.note ?? "", "service_overview")
			assert.strictEqual(summary.inspected[1]?.verdict, "skipped")
			assert.include(summary.inspected[1]?.note ?? "", "cannot inspect")
			// Both unsupported and skipped land in `skippedCount`.
			assert.strictEqual(summary.skippedCount, 2)
		}),
	)

	it.effect("maps an inspection defect to the `error` verdict", () =>
		Effect.gen(function* () {
			const widget = makeWidget({ params: { queries: [tracesDraft()] } })
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith([widget]),
				widgetIds: [widget.id],
				validate: true,
			}).pipe(Effect.provide(Layer.mergeAll(engineDefect, catalogWith([]))))

			assert.strictEqual(summary.inspected[0]?.verdict, "error")
			assert.include(summary.inspected[0]?.note ?? "", "Inspection failed")
			assert.strictEqual(summary.skippedCount, 1)
		}),
	)

	it.effect("counts a suspicious widget and ignores unknown widget ids", () =>
		Effect.gen(function* () {
			const widget = makeWidget({ params: { queries: [tracesDraft()] } })
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith([widget]),
				widgetIds: [widget.id, "does-not-exist"],
				validate: true,
			}).pipe(Effect.provide(stubs(timeseries([]))))

			assert.strictEqual(summary.inspected.length, 1)
			assert.strictEqual(summary.suspiciousCount + summary.brokenCount, 1)
		}),
	)

	it.effect("caps the inspected widget list at maxWidgets", () =>
		Effect.gen(function* () {
			const widgets = Array.from({ length: 3 }, (_, i) =>
				makeWidget({ id: `w${i}`, params: { queries: [tracesDraft()] } }),
			)
			const summary = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard: dashboardWith(widgets),
				widgetIds: widgets.map((w) => w.id),
				validate: true,
				maxWidgets: 2,
			}).pipe(Effect.provide(stubs(THREE_POINTS)))

			assert.isTrue(summary.capped)
			assert.strictEqual(summary.inspected.length, 2)
		}),
	)
})
