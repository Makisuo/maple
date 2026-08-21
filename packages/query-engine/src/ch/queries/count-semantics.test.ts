// Count-scale invariants for traces queries.
//
// A single dashboard must never show two answers to "how many spans?". Two
// things have to hold for that:
//
//   1. DEFINITION — every route that emits a `count` column emits the same
//      sample-weighted estimate (`sum(SampleRate)` on row-level tables,
//      `sum(WeightedCount)` on the hourly rollup), never a raw row count.
//   2. POPULATION — the rows being counted are the same set regardless of which
//      table a route picks or which dimension the caller grouped by. In
//      practice that means `service_overview_spans` (entry-point spans only) is
//      reachable only from a `rootOnly` query.
//
// Breaking either produced the bug this file exists to prevent: a "Spans" stat
// reading 5.5B directly above a status donut totalling 26.6M.

import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { tracesBreakdownQuery, tracesTimeseriesQuery } from "./traces"
import type { TracesBaseWhereOpts } from "./query-helpers"

const baseParams = {
	orgId: "org_123",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

/** The SELECT expression aliased as `count`, e.g. `sum(SampleRate)`. */
function countExpr(sql: string): string {
	// Scan by line rather than by regex over the whole string: the expression can
	// itself contain commas (`if(sum(a) > 0, sum(a), sum(b))`).
	const line = sql.split("\n").find((l) => / AS count\b/.test(l))
	if (!line) throw new Error(`no count column in:\n${sql}`)
	return line.slice(0, line.indexOf(" AS count")).trim()
}

/** The SELECT expression aliased as `spanCount`, e.g. `count()`. */
function spanCountExpr(sql: string): string {
	const line = sql.split("\n").find((l) => / AS spanCount\b/.test(l))
	if (!line) throw new Error(`no spanCount column in:\n${sql}`)
	return line.slice(0, line.indexOf(" AS spanCount")).trim()
}

function sourceTable(sql: string): string {
	const tables = [...sql.matchAll(/FROM (\w+)/g)].map((m) => m[1])
	// Union/CTE shapes read several tables; the invariant cares about the set.
	return [...new Set(tables)].sort().join("+")
}

/** Every count expression must weight by SampleRate, on either table shape. */
function expectWeighted(sql: string) {
	const expr = countExpr(sql)
	expect(
		expr.includes("SampleRate") || expr.includes("WeightedCount") || expr.includes("Estimated"),
		`count expression "${expr}" is not sample-weighted`,
	).toBe(true)
	expect(expr).not.toBe("count()")
}

// Each entry pins one routing branch of `tracesTimeseriesQuery`, so a new
// branch that forgets to weight its count fails here rather than in prod.
const TIMESERIES_ROUTES: ReadonlyArray<{
	name: string
	table: string
	opts: Parameters<typeof tracesTimeseriesQuery>[0]
}> = [
	{
		name: "raw traces",
		table: "traces",
		opts: { metric: "count", needsSampling: false, groupBy: ["http_method"], bucketSeconds: 3600 },
	},
	{
		// `status_code` is what keeps this on the flat per-span scan: the overview
		// rollup tiers pre-aggregate it away into `ErrorCount`, so they cannot group
		// by it. Without a groupBy outside `OVERVIEW_ROLLUP_GROUP_KEYS` these opts
		// now route to the tiers below.
		name: "service_overview_spans MV",
		table: "service_overview_spans",
		opts: {
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			groupBy: ["status_code"],
			bucketSeconds: 300,
		},
	},
	{
		// The alert-evaluation shape: one metric, sub-hour bucket, root spans only.
		// `computeAlertBuckets` never sets `allMetrics`, which used to force this
		// onto the per-span scan above; it now reads the minutely rollup instead.
		name: "annual service overview union (single metric, no allMetrics)",
		table: "service_overview_minutely+service_overview_spans",
		opts: { metric: "count", needsSampling: false, rootOnly: true, bucketSeconds: 300 },
	},
	{
		// Raw partial-hour edges unioned with the whole-hour rollup interior.
		name: "traces_aggregates_hourly rollup",
		table: "traces+traces_aggregates_hourly",
		opts: { metric: "count", needsSampling: false, groupBy: ["service"], bucketSeconds: 3600 },
	},
	{
		// All three tiers: raw partial-minute edges, the minutely rollup for the
		// sub-hour remainder, and the hourly rollup for the whole-hour interior.
		name: "annual service overview union",
		table: "service_overview_hourly+service_overview_minutely+service_overview_spans",
		opts: {
			metric: "count",
			needsSampling: true,
			allMetrics: true,
			rootOnly: true,
			bucketSeconds: 3600,
		},
	},
	{
		// Sub-hour bucket: the hourly tier is dropped, because an hour-floored row
		// has no position inside the hour. Weighting must survive that too.
		name: "annual service overview union (sub-hour bucket)",
		table: "service_overview_minutely+service_overview_spans",
		opts: {
			metric: "count",
			needsSampling: true,
			allMetrics: true,
			rootOnly: true,
			bucketSeconds: 300,
		},
	},
]

describe("traces count is sample-weighted on every route", () => {
	for (const route of TIMESERIES_ROUTES) {
		it(`weights count on the ${route.name} timeseries path`, () => {
			const { sql } = compileCH(tracesTimeseriesQuery(route.opts), baseParams)
			expect(sourceTable(sql)).toBe(route.table)
			expectWeighted(sql)
		})
	}

	// Alerting's `minimumSampleCount` is a confidence guard, so it reads
	// `spanCount` (rows observed), never the extrapolated `count`. Row-level
	// tables must therefore keep both columns distinct.
	it("keeps an unweighted spanCount alongside the weighted count", () => {
		// Asserted as an invariant rather than a literal, because the routes differ
		// in how they spell it: row-level tables emit `count()`, while the overview
		// tiers sum a stored raw `SpanCount` through `bCount`. Both are unweighted,
		// which is the property `minimumSampleCount` depends on.
		for (const opts of [
			{ metric: "count", needsSampling: false, groupBy: ["http_method"], bucketSeconds: 300 },
			{ metric: "count", needsSampling: false, rootOnly: true, bucketSeconds: 300 },
			{
				metric: "count",
				needsSampling: false,
				rootOnly: true,
				groupBy: ["status_code"],
				bucketSeconds: 300,
			},
		] as const) {
			const { sql } = compileCH(tracesTimeseriesQuery(opts), { ...baseParams, bucketSeconds: 300 })
			const spanCount = spanCountExpr(sql)
			expect(
				/SampleRate|Estimated|Weighted/.test(spanCount),
				`spanCount expression "${spanCount}" is sample-weighted; it is the confidence guard and must count observed rows`,
			).toBe(false)
			expectWeighted(sql)
		}
	})

	it("weights count on the raw breakdown path", () => {
		const { sql } = compileCH(tracesBreakdownQuery({ metric: "count", groupBy: "span_name" }), {
			orgId: "org_123",
			startTime: baseParams.startTime,
			endTime: baseParams.endTime,
		})
		expect(sourceTable(sql)).toBe("traces")
		expectWeighted(sql)
	})

	it("weights count on the MV breakdown path", () => {
		const { sql } = compileCH(
			tracesBreakdownQuery({ metric: "count", groupBy: "service", rootOnly: true }),
			{ orgId: "org_123", startTime: baseParams.startTime, endTime: baseParams.endTime },
		)
		expect(sourceTable(sql)).toBe("service_overview_spans")
		expectWeighted(sql)
	})
})

// The dimensions the query builder offers for traces. Grouping is a projection
// of the same rows — it must never change how many spans exist.
const BREAKDOWN_DIMENSIONS = [
	{ groupBy: "service" },
	{ groupBy: "span_name" },
	{ groupBy: "status_code" },
	{ groupBy: "http_method" },
	{ groupBy: "attribute", groupByAttributeKey: "rpc.service" },
] as const

describe("a breakdown totals the same regardless of the dimension", () => {
	for (const filters of [{}, { rootOnly: true }, { serviceName: "api" }] as TracesBaseWhereOpts[]) {
		const label = Object.keys(filters).length ? Object.keys(filters).join("+") : "no filters"

		it(`uses one count definition and one population across dimensions (${label})`, () => {
			const compiled = BREAKDOWN_DIMENSIONS.map(
				(dim) =>
					compileCH(tracesBreakdownQuery({ metric: "count", ...dim, ...filters }), {
						orgId: "org_123",
						startTime: baseParams.startTime,
						endTime: baseParams.endTime,
					}).sql,
			)

			const exprs = new Set(compiled.map(countExpr))
			expect([...exprs]).toEqual(["sum(SampleRate)"])

			// Table may differ (the MV can serve some dimensions and not others),
			// but the entry-point-only MV is reachable only when the query asked
			// for entry points — so the counted population is identical either way.
			for (const sql of compiled) {
				if (sql.includes("FROM service_overview_spans")) {
					expect(filters.rootOnly).toBe(true)
				}
			}
		})
	}
})

describe("timeseries and breakdown agree for the same query", () => {
	// Same window, same filters, same dimension: summing the timeseries buckets
	// must reproduce the breakdown total. Both sides therefore have to count the
	// same rows with the same expression.
	const cases: ReadonlyArray<{ groupBy: string; opts: TracesBaseWhereOpts }> = [
		{ groupBy: "service", opts: {} },
		{ groupBy: "status_code", opts: {} },
		{ groupBy: "span_name", opts: { serviceName: "api" } },
		{ groupBy: "http_method", opts: { rootOnly: true } },
	]

	const breakdownSql = (groupBy: string, opts: TracesBaseWhereOpts) =>
		compileCH(tracesBreakdownQuery({ metric: "count", groupBy, ...opts }), {
			orgId: "org_123",
			startTime: baseParams.startTime,
			endTime: baseParams.endTime,
		}).sql

	const timeseriesSql = (groupBy: string, opts: TracesBaseWhereOpts, bucketSeconds: number) =>
		compileCH(
			tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				groupBy: [groupBy],
				bucketSeconds,
				...opts,
			}),
			{ ...baseParams, bucketSeconds },
		).sql

	// Sub-hour buckets keep the timeseries on a row-level table, so both sides
	// compile to literally the same count over literally the same table.
	for (const { groupBy, opts } of cases) {
		it(`matches definition and population for groupBy=${groupBy} (5m buckets)`, () => {
			const ts = timeseriesSql(groupBy, opts, 300)
			const bd = breakdownSql(groupBy, opts)

			expect(countExpr(ts)).toBe(countExpr(bd))
			expect(sourceTable(ts)).toBe(sourceTable(bd))
		})
	}

	// At >= 1h an eligible timeseries reads the hourly rollup. It stays comparable
	// because the rollup covers only whole hours and raw `traces` covers the two
	// partial edge hours — the halves tile the requested window exactly. Reading
	// the rollup alone (`Hour BETWEEN startTime AND endTime`) dropped the partial
	// head hour and took the trailing hour whole, which put an hourly chart up to
	// an hour of traffic below the breakdown of the same window.
	for (const { groupBy, opts } of cases) {
		it(`matches definition and window for groupBy=${groupBy} (1h buckets)`, () => {
			const ts = timeseriesSql(groupBy, opts, 3600)
			const bd = breakdownSql(groupBy, opts)

			// Dimensions the rollup cannot serve stay entirely row-level.
			if (!ts.includes("FROM traces_aggregates_hourly")) {
				expect(countExpr(ts)).toBe(countExpr(bd))
				expect(sourceTable(ts)).toBe(sourceTable(bd))
				return
			}

			// Both union branches weight, and the outer query just sums the partials.
			expect(ts).toContain("sum(SampleRate) AS bWeightedCount")
			expect(ts).toContain("sum(WeightedCount) AS bWeightedCount")
			expect(countExpr(ts)).toBe("sum(bWeightedCount)")

			// The edges cover [start, firstFullHour) ∪ [endHour, end] and the interior
			// covers [firstFullHour, endHour) — no gap, no double count.
			const firstFullHour =
				"if(toDateTime('2024-01-01 00:00:00') = toStartOfHour(toDateTime('2024-01-01 00:00:00')), " +
				"toStartOfHour(toDateTime('2024-01-01 00:00:00')), " +
				"toStartOfHour(toDateTime('2024-01-01 00:00:00')) + INTERVAL 1 HOUR)"
			const endHour = "toStartOfHour(toDateTime('2024-01-02 00:00:00'))"
			expect(ts).toContain(`(Timestamp < ${firstFullHour} OR Timestamp >= ${endHour})`)
			expect(ts).toContain(`Hour >= ${firstFullHour}`)
			expect(ts).toContain(`Hour < ${endHour}`)
			// The inclusive-end rollup bound is the bug; it must not come back.
			expect(ts).not.toContain("Hour <=")
		})
	}

	// A UNION branch mismatch here is a hard ClickHouse error on a path shared by
	// dashboards and alert evaluation, so pin the two columns whose natural types
	// disagree: `count()` is UInt64, `sum(WeightedCount)` is Float64, and
	// ClickHouse refuses to find a supertype for that pair.
	it("keeps union branch column types compatible", () => {
		const sql = timeseriesSql("service", {}, 3600)
		expect(sql).toContain("toFloat64(count()) AS bSpanCount")
		expect(sql).toContain("sum(WeightedCount) AS bSpanCount")
		expect(sql).not.toContain("count() AS bSpanCount\n")
	})

	// Quantile state must be the same aggregate type on both branches: the raw
	// side builds it, the rollup side re-emits its stored state via -MergeState.
	it("emits matching quantile aggregate states across the union", () => {
		const sql = compileCH(
			tracesTimeseriesQuery({
				metric: "p95_duration",
				needsSampling: false,
				groupBy: ["service"],
				bucketSeconds: 3600,
			}),
			baseParams,
		).sql
		expect(sql).toContain(
			"quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(greatest(SampleRate, 1.0)))",
		)
		expect(sql).toContain("quantilesTDigestWeightedMergeState(0.5, 0.95, 0.99)(DurationQuantiles)")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
	})

	// No t-digest work when the metric doesn't need it — but the placeholder has
	// to be the same type on both branches, or the union stops compiling.
	it("skips quantile state on both branches when the metric needs none", () => {
		const sql = timeseriesSql("service", {}, 3600)
		expect(sql).not.toContain("quantilesTDigest")
		expect([...sql.matchAll(/'' AS bDurationQuantiles/g)]).toHaveLength(2)
	})
})
