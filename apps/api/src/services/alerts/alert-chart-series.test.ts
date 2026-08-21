import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { OrgId } from "@maple/domain/http"
import type { TenantContext } from "@/services/auth/AuthService"
import { breachSideFor, chartWindow, loadChartSeries, type ChartSeriesWarehouse } from "./alert-chart-series"

const ORG_ID = "org_1" as OrgId
const tenant = { orgId: ORG_ID } as TenantContext

const baseOptions = {
	orgId: ORG_ID,
	ruleId: "rule_1",
	groupKey: null,
	comparator: "gt" as const,
	threshold: 2,
	fromMs: Date.UTC(2026, 7, 18, 13, 0),
	toMs: Date.UTC(2026, 7, 18, 14, 0),
}

/**
 * `ChartSeriesWarehouse` is the narrow port the module declares, so these stubs
 * are checked against the real `compiledQuery` signature rather than cast past
 * it — a stub that stops matching the service fails here instead of passing.
 */
const warehouseReturning = (rows: ReadonlyArray<unknown>): ChartSeriesWarehouse => ({
	compiledQuery: () => Effect.succeed(rows as ReadonlyArray<never>),
})

const warehouseFailing = (): ChartSeriesWarehouse => ({
	compiledQuery: () => Effect.die(new Error("warehouse down")),
})

const checkRow = (minutesAgo: number, observedValue: number | null) => ({
	timestamp: new Date(Date.UTC(2026, 7, 18, 14, 0) - minutesAgo * 60_000).toISOString(),
	observedValue,
})

describe("breachSideFor", () => {
	it("maps the half-plane comparators to a side", () => {
		assert.strictEqual(breachSideFor("gt"), "above")
		assert.strictEqual(breachSideFor("gte"), "above")
		assert.strictEqual(breachSideFor("lt"), "below")
		assert.strictEqual(breachSideFor("lte"), "below")
	})

	it("shades nothing for the comparators with no single bad side", () => {
		// Pointing the reader's eye at half a chart is worse than not shading it.
		assert.strictEqual(breachSideFor("between"), "none")
		assert.strictEqual(breachSideFor("not_between"), "none")
		assert.strictEqual(breachSideFor("eq"), "none")
		assert.strictEqual(breachSideFor("neq"), "none")
	})
})

describe("chartWindow", () => {
	const nowMs = Date.UTC(2026, 7, 18, 14, 0)

	it("includes lead-in before the incident, so the chart shows a baseline", () => {
		const incidentStartedAtMs = nowMs - 60 * 60_000
		const window = chartWindow({ incidentStartedAtMs, nowMs, windowMinutes: 5 })
		assert.isBelow(window.fromMs, incidentStartedAtMs)
		assert.strictEqual(window.toMs, nowMs)
	})

	it("grows with the incident, so each renotify says more than the last", () => {
		const early = chartWindow({ incidentStartedAtMs: nowMs - 10 * 60_000, nowMs, windowMinutes: 5 })
		const later = chartWindow({ incidentStartedAtMs: nowMs - 180 * 60_000, nowMs, windowMinutes: 5 })
		assert.isBelow(later.fromMs, early.fromMs)
	})

	it("holds a floor, so a fresh incident on a 1-minute rule is not a 2-minute chart", () => {
		const window = chartWindow({ incidentStartedAtMs: nowMs, nowMs, windowMinutes: 1 })
		assert.isAtLeast(nowMs - window.fromMs, 6 * 60_000)
	})
})

describe("loadChartSeries", () => {
	it.effect("orders points left to right regardless of query order", () =>
		Effect.gen(function* () {
			// alert_checks pages newest-first for the checks table; a chart reads
			// the other way, and a series drawn in query order zigzags.
			const series = yield* loadChartSeries(
				warehouseReturning([checkRow(0, 3), checkRow(20, 1), checkRow(10, 2)]),
				tenant,
				baseOptions,
			)
			assert.deepStrictEqual(
				series?.points.map((p) => p[1]),
				[1, 2, 3],
			)
		}),
	)

	it.effect("carries the threshold and breach side through for the renderer", () =>
		Effect.gen(function* () {
			const series = yield* loadChartSeries(
				warehouseReturning([checkRow(0, 3), checkRow(10, 2), checkRow(20, 1)]),
				tenant,
				{ ...baseOptions, comparator: "lt", threshold: 0.8 },
			)
			assert.strictEqual(series?.threshold, 0.8)
			assert.strictEqual(series?.breachSide, "below")
		}),
	)

	it.effect("produces a sparkline alongside the points", () =>
		Effect.gen(function* () {
			const series = yield* loadChartSeries(
				warehouseReturning([checkRow(0, 9), checkRow(10, 5), checkRow(20, 1)]),
				tenant,
				baseOptions,
			)
			assert.strictEqual(series?.sparkline.length, 3)
		}),
	)

	it.effect("skips rows with no observed value rather than charting them as zero", () =>
		Effect.gen(function* () {
			// A failed evaluation writes an audit row with a null value. Reading it
			// as 0 would draw a recovery that never happened.
			const series = yield* loadChartSeries(
				warehouseReturning([checkRow(0, 3), checkRow(5, null), checkRow(10, 2), checkRow(20, 1)]),
				tenant,
				baseOptions,
			)
			assert.deepStrictEqual(
				series?.points.map((p) => p[1]),
				[1, 2, 3],
			)
		}),
	)

	it.effect("returns null for a series too short to be a trend", () =>
		Effect.gen(function* () {
			const series = yield* loadChartSeries(
				warehouseReturning([checkRow(0, 3), checkRow(10, 1)]),
				tenant,
				baseOptions,
			)
			assert.isNull(series)
		}),
	)

	it.effect("returns null instead of failing when the warehouse is down", () =>
		Effect.gen(function* () {
			// The whole contract of this module: an enrichment must never be able
			// to delay or drop a page.
			const series = yield* loadChartSeries(warehouseFailing(), tenant, baseOptions)
			assert.isNull(series)
		}),
	)
})
