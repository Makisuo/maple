import { describe, expect, it } from "vitest"
import * as CH from "./index"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import { tracesTimeseriesQuery, tracesBreakdownQuery, tracesListQuery } from "./queries/traces"
import { logsFacetsQuery } from "./queries/logs"
import { servicesFacetsQuery } from "./queries/services"
import { sessionReplaysFacetsQuery } from "./queries/session-replays"
import { metricsSummaryQuery } from "./queries/metrics"
import {
	tracesDurationStatsQuery,
	spanHierarchyQuery,
	spanDetailQuery,
	traceTimeProbeQuery,
} from "./queries/errors"
import { unionAll } from "@maple-dev/clickhouse-builder"

// Core DSL tests

describe("CH.from / select / where / compile", () => {
	const TestTable = CH.table("test_table", {
		Id: CH.string,
		Name: CH.string,
		Value: CH.uint64,
		Attrs: CH.map(CH.string, CH.string),
	})

	it("compiles a basic select", () => {
		const q = CH.from(TestTable)
			.select(($) => ({
				id: $.Id,
				name: $.Name,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("SELECT")
		expect(sql).toContain("Id AS id")
		expect(sql).toContain("Name AS name")
		expect(sql).toContain("FROM test_table")
		expect(sql).toContain("FORMAT JSON")
	})

	it("compiles with WHERE conditions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({
				id: $.Id,
				count: CH.count(),
			}))
			.where(($) => [$.Id.eq(CH.param.string("orgId")), $.Name.eq("test")])
			.groupBy("id")

		const { sql } = compileCH(q, { orgId: "org_123" })
		expect(sql).toContain("Id AS id")
		expect(sql).toContain("count() AS count")
		expect(sql).toContain("Id = 'org_123'")
		expect(sql).toContain("Name = 'test'")
		expect(sql).toContain("GROUP BY id")
	})

	it("compiles with orderBy and limit", () => {
		const q = CH.from(TestTable)
			.select(($) => ({
				name: $.Name,
				count: CH.count(),
			}))
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(10)
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
	})

	it("compiles map access", () => {
		const q = CH.from(TestTable).select(($) => ({
			method: $.Attrs.get("http.method"),
		}))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("Attrs['http.method'] AS method")
	})

	it("compiles arithmetic expressions", () => {
		const q = CH.from(TestTable).select(($) => ({
			avgMs: CH.avg($.Value).div(1000000),
		}))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("avg(Value) / 1000000 AS avgMs")
	})

	it("compiles aggregate functions", () => {
		const q = CH.from(TestTable).select(($) => ({
			cnt: CH.count(),
			total: CH.sum($.Value),
			p95: CH.quantile(0.95)($.Value),
		}))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("count() AS cnt")
		expect(sql).toContain("sum(Value) AS total")
		expect(sql).toContain("quantile(0.95)(Value) AS p95")
	})

	it("skips undefined WHERE conditions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [
				$.Id.eq("test"),
				CH.when(undefined, () => $.Name.eq("nope")),
				CH.when("hello", (v) => $.Name.eq(v)),
			])

		const { sql } = compileCH(q, {})
		expect(sql).toContain("Id = 'test'")
		expect(sql).toContain("Name = 'hello'")
		expect(sql).not.toContain("nope")
	})

	it("resolves params with special characters", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("name"))])

		const { sql } = compileCH(q, { name: "it's-a-test" })
		expect(sql).toContain("Id = 'it\\'s-a-test'")
	})

	it("compiles toStartOfInterval", () => {
		const q = CH.from(TestTable).select((_$) => ({
			bucket: CH.toStartOfInterval(CH.rawExpr<string>("Timestamp"), 3600),
		}))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket")
	})

	it("compiles window frame helpers", () => {
		const q = CH.from(TestTable).select(($) => {
			const frame = CH.windowSpec({
				partitionBy: [$.Name, CH.cityHash64(CH.mapKeys($.Attrs), CH.mapValues($.Attrs))],
				orderBy: [[$.Value, "asc"]],
				frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
			})

			return {
				delta: $.Value.sub(CH.over(CH.lagInFrame($.Value, 1, $.Value), frame)),
			}
		})

		const { sql } = compileCH(q, {})
		expect(sql).toContain(
			"Value - lagInFrame(Value, 1, Value) OVER (PARTITION BY Name, " +
				"cityHash64(mapKeys(Attrs), mapValues(Attrs)) ORDER BY Value ASC " +
				"ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS delta",
		)
	})

	it("compiles if_ expressions", () => {
		const q = CH.from(TestTable).select(($) => ({
			errorRate: CH.if_(CH.count().gt(0), CH.countIf($.Name.eq("Error")), CH.lit(0)),
		}))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("if(count() > 0, countIf(Name = 'Error'), 0) AS errorRate")
	})

	it("compiles inList conditions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [CH.inList($.Name, ["a", "b", "c"])])

		const { sql } = compileCH(q, {})
		expect(sql).toContain("Name IN ('a', 'b', 'c')")
	})

	it("compiles column shorthand select", () => {
		const q = CH.from(TestTable).select("Id", "Name", "Value")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("Id AS Id")
		expect(sql).toContain("Name AS Name")
		expect(sql).toContain("Value AS Value")
		expect(sql).toContain("FROM test_table")
	})

	it("compiles in_() on expressions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.in_("alice", "bob", "charlie")])

		const { sql } = compileCH(q, {})
		expect(sql).toContain("Name IN ('alice', 'bob', 'charlie')")
	})

	it("compiles arrayOf()", () => {
		const q = CH.from(TestTable).select(($) => ({ names: CH.arrayOf($.Name) }))

		const { sql } = compileCH(q, {})
		expect(sql).toContain("[Name] AS names")
	})
})

// Traces timeseries query — parity with buildTracesTimeseriesSQL

describe("tracesTimeseriesQuery", () => {
	const baseParams = {
		orgId: "org_123",
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
		bucketSeconds: 3600,
	}

	it("builds basic count timeseries", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SELECT")
		// Without rootOnly the query means "all spans", which the entry-point-only
		// MV cannot answer — it reads raw traces.
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("OrgId = 'org_123'")
		expect(sql).toContain("sum(SampleRate) AS count")
		expect(sql).toContain("INTERVAL 3600 SECOND")
		expect(sql).toContain("GROUP BY bucket, groupName")
		expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
		expect(sql).toContain("FORMAT JSON")
		expect(sql).toContain("'all'")
		// count metric should not include quantiles
		expect(sql).toContain("0 AS p50Duration")
	})

	it("builds apdex timeseries with threshold", () => {
		const q = tracesTimeseriesQuery({ metric: "apdex", needsSampling: false, apdexThresholdMs: 250 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain(
			"countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) AS satisfiedCount",
		)
		expect(sql).toContain("toleratingCount")
		expect(sql).toContain("apdexScore")
	})

	it("counts errored spans as frustrated in apdex (excludes them from satisfied/tolerating)", () => {
		const q = tracesTimeseriesQuery({ metric: "apdex", needsSampling: false, apdexThresholdMs: 250 })
		const { sql } = compileCH(q, baseParams)
		// A fast error must NOT inflate apdex: the non-error predicate gates both
		// the satisfied and tolerating buckets, while count() still includes errors.
		expect(sql).toContain(
			"countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) AS satisfiedCount",
		)
		expect(sql).toContain(
			"countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 250 AND Duration / 1000000 < 1000))) AS toleratingCount",
		)
		// satisfied and tolerating are divided by the unfiltered count(), so errors drag the score down.
		expect(sql).toContain("/ count()")
	})

	it("builds p95 duration timeseries", () => {
		const q = tracesTimeseriesQuery({ metric: "p95_duration", needsSampling: false })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50Duration")
		expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95Duration")
		expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
	})

	it("builds error_rate timeseries weighted on both sides of the ratio", () => {
		const q = tracesTimeseriesQuery({ metric: "error_rate", needsSampling: false })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate")
	})

	it("emits sum(SampleRate) when needsSampling is true", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("sum(SampleRate) AS estimatedSpanCount")
		// The old non-deterministic `anyIf(threshold)` is gone — it was the bug.
		expect(sql).not.toContain("dominantThreshold")
		expect(sql).not.toContain("anyIf")
	})

	it("emits a constant 0 estimatedSpanCount when needsSampling is false", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("0 AS estimatedSpanCount")
	})

	it("groups by service", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, groupBy: ["service"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("toString(ServiceName)")
		expect(sql).toContain("AS groupName")
	})

	it("groups by span_name", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, groupBy: ["span_name"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("toString(SpanName)")
	})

	it("groups by multiple dimensions", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["service", "status_code"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("arrayStringConcat")
		expect(sql).toContain("arrayFilter")
	})

	it("groups by attribute with keys", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["attribute"],
			groupByAttributeKeys: ["http.route"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SpanAttributes['http.route']")
	})

	it("routes rootOnly to service_overview_spans_mv (MV pre-filters entry-point spans)", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, rootOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		// Filter is redundant on the MV and is dropped.
		expect(sql).not.toContain("SpanKind")
		expect(sql).not.toContain("ParentSpanId")
	})

	it("routes annual all-metric service charts through raw partial hours and hourly interiors", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: true,
			allMetrics: true,
			rootOnly: true,
			bucketSeconds: 3600,
			serviceName: "api",
			environments: ["production"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("Timestamp < if(toDateTime('2024-01-01 00:00:00')")
		expect(sql).toContain("Hour < toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		// Weighted estimate, with a raw-count fallback for buckets written before
		// `EstimatedSpanCount` existed. `count` reports the same expression. Both
		// `if()` arms must unify to Float64 — ClickHouse rejects a Float64/UInt64
		// pair outright, so dropping the `toFloat64` breaks the query at runtime.
		expect(sql).toContain(
			"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count",
		)
		expect(sql).toContain(
			"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount",
		)
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
	})

	// `service_overview_spans` stores only entry-point spans (Server/Consumer OR
	// root). Routing an all-spans query there silently swaps the population, which
	// is how one dashboard showed two answers to the same question.
	it("keeps non-rootOnly queries off service_overview_spans_mv", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, bucketSeconds: 300 })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM traces")
	})

	it("routes eligible hourly trace timeseries to traces_aggregates_hourly", () => {
		const q = tracesTimeseriesQuery({
			metric: "p95_duration",
			needsSampling: false,
			rootOnly: true,
			groupBy: ["service"],
			bucketSeconds: 3600,
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		// Whole-hour interior state is re-emitted for the union, then merged once
		// in the outer query alongside the raw partial-hour edges.
		expect(sql).toContain("quantilesTDigestWeightedMergeState(0.5, 0.95, 0.99)(DurationQuantiles)")
		expect(sql).toContain(
			"quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(greatest(SampleRate, 1.0)))",
		)
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).not.toContain("FROM service_overview_spans")
	})

	// This is the shape `computeAlertBuckets` produces: one metric, sub-hour
	// bucket, root spans only, and no `allMetrics`. It used to fall all the way
	// through to a flat scan of the per-span `service_overview_spans` because
	// `canUseAnnualServiceOverview` demanded `allMetrics === true` — 165k scans
	// per 3 days against a 325M-row table while the 2.2M-row minutely rollup
	// built for it sat unreachable.
	//
	// Asserting the minutely tier specifically, NOT just the presence of a table
	// name: the tiered union reads `service_overview_spans` too (as its partial-
	// bucket edge), so `toContain("FROM service_overview_spans")` passes on both
	// routes and cannot tell them apart. That weak assertion is what let the
	// regression sit here unnoticed.
	it("routes fine-grained single-metric trace timeseries to the minutely rollup", () => {
		const q = tracesTimeseriesQuery({
			metric: "p95_duration",
			needsSampling: false,
			rootOnly: true,
			bucketSeconds: 300,
		})
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM service_overview_minutely")
		// The raw edge covers only the partial minutes at the window's ends.
		expect(sql).toContain("FROM service_overview_spans")
		// Sub-hour buckets have no position inside an hour-floored row.
		expect(sql).not.toContain("FROM service_overview_hourly")
		expect(sql).not.toContain("FROM traces_aggregates_hourly")
	})

	// The other side of that route: a groupBy the rollup tiers cannot serve
	// (`status_code` is pre-aggregated into `ErrorCount`) must still fall through
	// to the flat per-span scan.
	it("keeps status_code breakdowns on the flat service_overview_spans scan", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			groupBy: ["status_code"],
			bucketSeconds: 300,
		})
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).not.toContain("FROM service_overview_minutely")
	})

	it("keeps all-metrics and Apdex timeseries off traces_aggregates_hourly", () => {
		const allMetrics = compileCH(
			tracesTimeseriesQuery({
				metric: "count",
				needsSampling: true,
				allMetrics: true,
				rootOnly: true,
				bucketSeconds: 3600,
			}),
			baseParams,
		).sql
		const apdex = compileCH(
			tracesTimeseriesQuery({
				metric: "apdex",
				needsSampling: false,
				rootOnly: true,
				bucketSeconds: 3600,
			}),
			baseParams,
		).sql

		expect(allMetrics).toContain("FROM service_overview_spans")
		expect(allMetrics).not.toContain("FROM traces_aggregates_hourly")
		expect(apdex).toContain("FROM service_overview_spans")
		expect(apdex).not.toContain("FROM traces_aggregates_hourly")
	})

	it("uses pre-extracted CommitSha column when routing to MV", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			commitShas: ["abc123"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("CommitSha IN ('abc123')")
	})

	it("filters by serviceName", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, serviceName: "api-service" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api-service'")
	})

	it("filters by spanName", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, spanName: "GET /users" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SpanName = 'GET /users'")
	})

	it("filters errorsOnly", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, errorsOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("filters errorsOnly with rootOnly", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			errorsOnly: true,
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("filters by environments (raw path reads the ResourceAttributes map)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			environments: ["production", "staging"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production', 'staging')")
	})

	it("filters by environments with rootOnly (MV path uses pre-extracted DeploymentEnv)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			environments: ["production"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("filters by attribute filters (equals)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", value: "200", mode: "equals" }],
		})
		const { sql } = compileCH(q, baseParams)
		// Coalesces the old + new OTel semconv spellings (mirrors trace_list_mv).
		expect(sql).toContain(
			"if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) = '200'",
		)
	})

	it("filters by attribute filters (exists)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", mode: "exists" }],
		})
		const { sql } = compileCH(q, baseParams)
		// A missing Map key reads back as '', so `exists` must also exclude empty
		// values — otherwise breakdowns keep a "(no value)" bucket.
		expect(sql).toContain(
			"mapContains(SpanAttributes, 'http.route') AND SpanAttributes['http.route'] != ''",
		)
	})

	it("filters by attribute filters (exists) across HTTP semconv aliases", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", mode: "exists" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'http.status_code') OR mapContains(SpanAttributes, 'http.response.status_code')) AND if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) != ''",
		)
	})

	it("filters by attribute filters (!exists) as the complement of exists", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", mode: "exists", negated: true }],
		})
		const { sql } = compileCH(q, baseParams)
		// Absent *or* empty — the exact negation of the positive predicate.
		expect(sql).toContain(
			"NOT ((mapContains(SpanAttributes, 'http.route') AND SpanAttributes['http.route'] != ''))",
		)
	})

	it("filters by attribute filters (contains)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", value: "/api", mode: "contains" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(SpanAttributes['http.route'], '/api') > 0")
	})

	it("filters by attribute filters (gt)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", value: "400", mode: "gt" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain(
			"toFloat64OrZero(if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code'])) > 400",
		)
	})

	it("filters by resource attribute filters", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})

	// Either spelling of the renamed deployment-environment resource attribute
	// has to match either stored key: our SDKs dual-emit, a current OTel SDK
	// sends only `deployment.environment.name`, an older one only the legacy key.
	for (const key of ["deployment.environment", "deployment.environment.name"]) {
		it(`matches both deployment-environment spellings when filtering on ${key}`, () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				resourceAttributeFilters: [{ key, value: "production", mode: "equals" }],
			})
			const { sql } = compileCH(q, baseParams)
			expect(sql).toContain(
				"if(ResourceAttributes['deployment.environment.name'] != '', ResourceAttributes['deployment.environment.name'], ResourceAttributes['deployment.environment']) = 'production'",
			)
		})
	}

	it("filters attribute with rootOnly on raw table", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			attributeFilters: [{ key: "http.method", value: "GET", mode: "equals" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain(
			"if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'",
		)
	})

	it("falls back to raw traces when groupBy includes span_name", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["span_name"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("falls back to raw traces when spanName filter is set", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			spanName: "GET /users",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("falls back to raw traces when resourceAttributeFilters are set", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})

	it("escapes special characters in filter values", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			serviceName: "it's-a-service",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'it\\'s-a-service'")
	})
})

// Traces breakdown query — parity with buildTracesBreakdownSQL

describe("tracesBreakdownQuery", () => {
	const baseParams = {
		orgId: "org_123",
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
	}

	it("builds basic breakdown by service", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SELECT")
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("sum(SampleRate) AS count")
		expect(sql).toContain("GROUP BY name")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
		expect(sql).toContain("FORMAT JSON")
	})

	it("groups by span_name", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "span_name" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("SpanName AS name")
	})

	it("groups by status_code", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "status_code" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("StatusCode AS name")
	})

	it("routes rootOnly breakdowns to service_overview_spans_mv", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service", rootOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("sum(SampleRate) AS count")
	})

	it("groups by http_method", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "http_method" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("SpanAttributes['http.method'] AS name")
	})

	it("groups by custom attribute", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "attribute",
			groupByAttributeKey: "rpc.service",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("SpanAttributes['rpc.service'] AS name")
	})

	it("applies custom limit", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service", limit: 25 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})

	it("uses default limit of 10", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 10")
	})

	it("includes apdex columns for apdex metric", () => {
		const q = tracesBreakdownQuery({ metric: "apdex", groupBy: "service", apdexThresholdMs: 300 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain(
			"countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 300)) AS satisfiedCount",
		)
		expect(sql).toContain("apdexScore")
	})

	it("includes quantile columns for p99 metric", () => {
		const q = tracesBreakdownQuery({ metric: "p99_duration", groupBy: "service" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
	})

	it("applies WHERE filters", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			serviceName: "api",
			errorsOnly: true,
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("uses pre-extracted deployment env on the service overview branch", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			rootOnly: true,
			environments: ["prod"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("DeploymentEnv IN ('prod')")
		expect(sql).not.toContain("ResourceAttributes")
	})

	it("falls back to raw traces for resource attribute filters", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})
})

// Traces list query

describe("tracesListQuery", () => {
	const baseParams = {
		orgId: "org_123",
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
	}

	it("builds basic list query", () => {
		const q = tracesListQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SELECT")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("TraceId AS traceId")
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("SpanAttributes AS spanAttributes")
		expect(sql).toContain("ResourceAttributes AS resourceAttributes")
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 25")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies custom limit", () => {
		const q = tracesListQuery({ limit: 50 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 50")
	})

	it("filters by service", () => {
		const q = tracesListQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("emits IN for multiple services", () => {
		const q = tracesListQuery({ serviceNames: ["api", "checkout", "billing"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'checkout', 'billing')")
		// Regression: the sidebar is multi-select, but the query layer used to take
		// only `services[0]`, so ticking three services filtered by one.
		expect(sql).not.toContain("ServiceName = 'api'")
	})

	it("keeps plain equality for a single service in the array spelling", () => {
		const q = tracesListQuery({ serviceNames: ["api"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("lets serviceNames win over the scalar serviceName", () => {
		const q = tracesListQuery({ serviceName: "api", serviceNames: ["checkout", "billing"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName IN ('checkout', 'billing')")
		expect(sql).not.toContain("ServiceName = 'api'")
	})

	it("emits IN against both raw and display span names for multiple spanNames", () => {
		const q = tracesListQuery({ spanNames: ["GET /a", "GET /b"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SpanName IN ('GET /a', 'GET /b')")
		// Display-name aware, same as the single-value path.
		expect(sql).toContain("replaceOne(SpanName, 'http.server ', '')")
	})

	it("emits IN for a multi-value http attribute filter", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "http.method", values: ["GET", "POST"], mode: "in" }],
		})
		const { sql } = compileCH(q, baseParams)
		// Coalesced across the http.method / http.request.method semconv aliases.
		expect(sql).toMatch(/IN \('GET', 'POST'\)/)
	})

	it("uses traces table when rootOnly (MV disabled)", () => {
		const q = tracesListQuery({ rootOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("emits NOT IN for excludedServiceNames", () => {
		const q = tracesListQuery({ excludedServiceNames: ["checkout", "billing"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName NOT IN ('checkout', 'billing')")
	})

	it("emits NOT IN for excludedSpanNames", () => {
		const q = tracesListQuery({ excludedSpanNames: ["GET /health"] })
		const { sql } = compileCH(q, baseParams)
		// Display-name aware: excludes rows whose raw OR rewritten span name
		// matches, so excluding a "Root Span" facet value ("GET /route") works.
		expect(sql).toMatch(/NOT \(\(SpanName IN \('GET \/health'\) OR /)
		expect(sql).toContain("replaceOne(SpanName, 'http.server ', '')")
	})

	it("wraps a negated attribute filter in NOT (...)", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "env", value: "prod", mode: "equals", negated: true }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("NOT (SpanAttributes['env'] = 'prod')")
	})

	it("wraps a negated contains attribute filter in NOT (positionCaseInsensitive ...)", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "http.route", value: "/health", mode: "contains", negated: true }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("NOT (positionCaseInsensitive(SpanAttributes['http.route'], '/health') > 0)")
	})
})

// UNION ALL queries

describe("unionAll", () => {
	const TestTable = CH.table("test_table", {
		Id: CH.string,
		Name: CH.string,
		Value: CH.uint64,
	})

	it("compiles two queries with UNION ALL", () => {
		const q1 = CH.from(TestTable)
			.select(($) => ({
				name: $.Name,
				count: CH.count(),
				facet: CH.lit("a"),
			}))
			.where(($) => [$.Id.eq("1")])
			.groupBy("name")

		const q2 = CH.from(TestTable)
			.select(($) => ({
				name: $.Id,
				count: CH.count(),
				facet: CH.lit("b"),
			}))
			.where(($) => [$.Id.eq("2")])
			.groupBy("name")

		const union = unionAll(q1, q2).format("JSON")
		const { sql } = compileUnion(union, {})
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("'a' AS facet")
		expect(sql).toContain("'b' AS facet")
		expect(sql).toContain("FORMAT JSON")
		// Sub-queries should NOT have FORMAT
		const parts = sql.split("UNION ALL")
		expect(parts[0]).not.toContain("FORMAT")
	})

	it("wraps with outer ORDER BY and LIMIT", () => {
		const q1 = CH.from(TestTable)
			.select(($) => ({ name: $.Name, count: CH.count() }))
			.groupBy("name")

		const q2 = CH.from(TestTable)
			.select(($) => ({ name: $.Id, count: CH.count() }))
			.groupBy("name")

		const union = unionAll(q1, q2).orderBy(["count", "desc"]).limit(10).format("JSON")

		const { sql } = compileUnion(union, {})
		expect(sql).toContain("SELECT * FROM (")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
	})
})

// Subquery support

describe("subquery support", () => {
	const TestTable = CH.table("test_table", {
		Id: CH.string,
		Name: CH.string,
		Value: CH.uint64,
	})

	it("compiles inSubquery", () => {
		const innerSql = compileCH(
			CH.from(TestTable)
				.select(($) => ({ id: $.Id }))
				.where(($) => [$.Value.gt(100)]),
			{},
			{ skipFormat: true },
		).sql

		const outer = CH.from(TestTable)
			.select(($) => ({ name: $.Name }))
			.where(($) => [CH.inSubquery($.Id, innerSql)])
			.format("JSON")

		const { sql } = compileCH(outer, {})
		expect(sql).toContain("Id IN (SELECT")
		expect(sql).toContain("Value > 100")
	})

	it("compiles exists()", () => {
		const subSql = "SELECT 1 FROM other WHERE other.Id = test_table.Id"
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(() => [CH.exists(subSql)])
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("EXISTS (SELECT 1 FROM other WHERE other.Id = test_table.Id)")
	})

	it("compiles fromQuery as typed FROM source", () => {
		const inner = CH.from(TestTable)
			.select(($) => ({ id: $.Id, name: $.Name }))
			.limit(10)

		const outer = CH.fromQuery(inner, "sub")
			.select(($) => ({
				id: $.id,
				name: $.name,
			}))
			.format("JSON")

		const { sql } = compileCH(outer, {})
		expect(sql).toContain("FROM (SELECT")
		expect(sql).toContain(") AS sub")
		expect(sql).toContain("LIMIT 10")
		expect(sql).toContain("id AS id")
		expect(sql).toContain("name AS name")
	})
})

// Type-safe joins

describe("type-safe joins", () => {
	const Users = CH.table("users", {
		Id: CH.string,
		Name: CH.string,
		OrgId: CH.string,
	})

	const Orders = CH.table("orders", {
		Id: CH.string,
		UserId: CH.string,
		Amount: CH.uint64,
		Status: CH.string,
	})

	it("compiles innerJoin with Table", () => {
		const q = CH.from(Users)
			.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
			.select(($) => ({
				userName: $.Name,
				orderAmount: $.o.Amount,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("INNER JOIN orders AS o ON users.Id = o.UserId")
		expect(sql).toContain("users.Name AS userName")
		expect(sql).toContain("o.Amount AS orderAmount")
	})

	it("compiles leftJoin with Table", () => {
		const q = CH.from(Users)
			.leftJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
			.select(($) => ({
				userName: $.Name,
				orderAmount: $.o.Amount,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("LEFT JOIN orders AS o ON users.Id = o.UserId")
	})

	it("compiles crossJoin with Table", () => {
		const q = CH.from(Users)
			.crossJoin(Orders, "o")
			.select(($) => ({
				userName: $.Name,
				orderStatus: $.o.Status,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("CROSS JOIN orders AS o")
		expect(sql).not.toContain(" ON ")
	})

	it("compiles innerJoinQuery with subquery", () => {
		const ordersSub = CH.from(Orders)
			.select(($) => ({ userId: $.UserId, total: CH.sum($.Amount) }))
			.groupBy("userId")

		const q = CH.from(Users)
			.innerJoinQuery(ordersSub, "o", (u, o) => u.Id.eq(o.userId))
			.select(($) => ({
				userName: $.Name,
				orderTotal: $.o.total,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("INNER JOIN (SELECT")
		expect(sql).toContain(") AS o ON users.Id = o.userId")
		expect(sql).toContain("o.total AS orderTotal")
	})

	it("compiles crossJoinQuery with subquery", () => {
		const statsSub = CH.from(Orders).select(() => ({ totalOrders: CH.count() }))

		const q = CH.from(Users)
			.crossJoinQuery(statsSub, "s")
			.select(($) => ({
				userName: $.Name,
				totalOrders: $.s.totalOrders,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("CROSS JOIN (SELECT")
		expect(sql).toContain(") AS s")
		expect(sql).toContain("s.totalOrders AS totalOrders")
	})

	it("compiles fromQuery + crossJoinQuery (two subqueries)", () => {
		const sub1 = CH.from(Users).select(() => ({ userCount: CH.count() }))

		const sub2 = CH.from(Orders).select(() => ({ orderCount: CH.count() }))

		const q = CH.fromQuery(sub1, "u")
			.crossJoinQuery(sub2, "o")
			.select(($) => ({
				users: $.userCount,
				orders: $.o.orderCount,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("FROM (SELECT")
		expect(sql).toContain(") AS u")
		expect(sql).toContain("CROSS JOIN (SELECT")
		expect(sql).toContain(") AS o")
		expect(sql).toContain("u.userCount AS users")
		expect(sql).toContain("o.orderCount AS orders")
	})

	it("compiles multiple chained joins", () => {
		const Tags = CH.table("tags", { Id: CH.string, UserId: CH.string, Label: CH.string })

		const q = CH.from(Users)
			.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
			.innerJoin(Tags, "t", (u, t) => u.Id.eq(t.UserId))
			.select(($) => ({
				userName: $.Name,
				orderAmount: $.o.Amount,
				tag: $.t.Label,
			}))
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("INNER JOIN orders AS o ON users.Id = o.UserId")
		expect(sql).toContain("INNER JOIN tags AS t ON users.Id = t.UserId")
		expect(sql).toContain("users.Name AS userName")
		expect(sql).toContain("o.Amount AS orderAmount")
		expect(sql).toContain("t.Label AS tag")
	})

	it("qualifies main table columns in where() with joins", () => {
		const q = CH.from(Users)
			.innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
			.select(($) => ({ userName: $.Name }))
			.where(($) => [$.OrgId.eq("org_1")])
			.format("JSON")

		const { sql } = compileCH(q, {})
		expect(sql).toContain("users.OrgId = 'org_1'")
	})
})

// New expression functions

describe("new expression functions", () => {
	const TestTable = CH.table("test_table", {
		Id: CH.string,
		Name: CH.string,
		Value: CH.uint64,
		Attrs: CH.map(CH.string, CH.string),
	})

	it("compiles uniq()", () => {
		const q = CH.from(TestTable).select(($) => ({ unique: CH.uniq($.Name) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("uniq(Name) AS unique")
	})

	it("compiles sumIf()", () => {
		const q = CH.from(TestTable).select(($) => ({ total: CH.sumIf($.Value, $.Name.eq("test")) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("sumIf(Value, Name = 'test') AS total")
	})

	it("compiles toJSONString()", () => {
		const q = CH.from(TestTable).select(($) => ({ attrs: CH.toJSONString($.Attrs) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("toJSONString(Attrs) AS attrs")
	})

	it("compiles concat()", () => {
		const q = CH.from(TestTable).select(($) => ({ full: CH.concat($.Id, CH.lit(" "), $.Name) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("concat(Id, ' ', Name) AS full")
	})

	it("compiles round_()", () => {
		const q = CH.from(TestTable).select(($) => ({ rounded: CH.round_($.Value.div(100), 2) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("round(Value / 100, 2) AS rounded")
	})

	it("compiles intDiv()", () => {
		const q = CH.from(TestTable).select(($) => ({ result: CH.intDiv($.Value, 1000) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("intDiv(Value, 1000) AS result")
	})

	it("compiles ilike", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.ilike("%test%")])
		const { sql } = compileCH(q, {})
		expect(sql).toContain("Name ILIKE '%test%'")
	})

	it("compiles groupUniqArray()", () => {
		const q = CH.from(TestTable).select(($) => ({ names: CH.groupUniqArray($.Name) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("groupUniqArray(Name) AS names")
	})

	it("generalized min_/max_ accepts string columns", () => {
		const q = CH.from(TestTable).select(($) => ({ first: CH.min($.Name), last: CH.max($.Name) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("min(Name) AS first")
		expect(sql).toContain("max(Name) AS last")
	})

	it("generalized any_() accepts any column", () => {
		const q = CH.from(TestTable).select(($) => ({ sample: CH.any($.Name) }))
		const { sql } = compileCH(q, {})
		expect(sql).toContain("any(Name) AS sample")
	})
})

// Converted queries — smoke tests

describe("converted queries", () => {
	const baseParams = { orgId: "org_1", startTime: "2024-01-01", endTime: "2024-01-02" }

	it("logsFacetsQuery compiles UNION ALL", () => {
		const q = logsFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("'severity' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("ORDER BY count DESC")
	})

	it("servicesFacetsQuery compiles UNION ALL", () => {
		const q = servicesFacetsQuery()
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("'environment' AS facetType")
		expect(sql).toContain("'commit_sha' AS facetType")
	})

	it("sessionReplaysFacetsQuery compiles UNION ALL with uniq(SessionId)", () => {
		const q = sessionReplaysFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("uniq(SessionId) AS count")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("'browser' AS facetType")
		expect(sql).toContain("'country' AS facetType")
		expect(sql).toContain("'device' AS facetType")
		expect(sql).toContain("'error' AS facetType")
		expect(sql).toContain("ORDER BY count DESC")
	})

	it("sessionReplaysFacetsQuery excludes each facet's own filter", () => {
		const q = sessionReplaysFacetsQuery({ browser: "Chrome", deviceType: "mobile" })
		const { sql } = compileUnion(q, baseParams)
		// The browser branch must still see every browser (no BrowserName = 'Chrome'
		// constraint), but other branches keep it so their counts respect the filter.
		const branches = sql.split("UNION ALL")
		const browserBranch = branches.find((b) => b.includes("'browser' AS facetType"))!
		const serviceBranch = branches.find((b) => b.includes("'service' AS facetType"))!
		expect(browserBranch).not.toContain("BrowserName = 'Chrome'")
		expect(serviceBranch).toContain("BrowserName = 'Chrome'")
		expect(serviceBranch).toContain("DeviceType = 'mobile'")
	})

	it("metricsSummaryQuery aggregates the metric_catalog rollup", () => {
		const q = metricsSummaryQuery()
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("GROUP BY metricType")
		expect(sql).toContain("uniq(MetricName)")
	})

	it("tracesDurationStatsQuery compiles with positionCaseInsensitive", () => {
		const q = tracesDurationStatsQuery({
			serviceName: "api",
			matchModes: { serviceName: "contains" },
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(ServiceName, 'api') > 0")
		expect(sql).toContain("quantile(0.5)(Duration)")
		expect(sql).toContain("FROM trace_list_mv") // tracesDurationStats always uses MV directly
	})

	it("spanHierarchyQuery projects only the trimmed tree attribute keys", () => {
		const q = spanHierarchyQuery({ traceId: "abc123" })
		const { sql } = compileCH(q, { orgId: "org_1" })
		// Maps are trimmed to the keys the tree views render — never the full map.
		expect(sql).not.toContain("toJSONString(SpanAttributes)")
		expect(sql).not.toContain("toJSONString(ResourceAttributes)")
		expect(sql).toContain("'http.route', SpanAttributes['http.route']")
		expect(sql).toContain("'cache.result', SpanAttributes['cache.result']")
		expect(sql).toContain("'deployment.environment', ResourceAttributes['deployment.environment']")
		expect(sql).toContain("AS spanAttributes")
		expect(sql).toContain("AS resourceAttributes")
		expect(sql).toContain("TraceId = 'abc123'")
		expect(sql).toContain("'related' AS relationship")
		// Capped so pathological traces can't stall the API.
		expect(sql).toContain("ORDER BY startTime ASC")
		expect(sql).toContain("LIMIT 5000")
	})

	it("spanHierarchyQuery with spanId marks target", () => {
		const q = spanHierarchyQuery({ traceId: "abc", spanId: "span1" })
		const { sql } = compileCH(q, { orgId: "org_1" })
		expect(sql).toContain("'target'")
		expect(sql).toContain("'related'")
	})

	it("spanHierarchyQuery without narrowByTime omits Timestamp filter", () => {
		const q = spanHierarchyQuery({ traceId: "abc" })
		const { sql } = compileCH(q, { orgId: "org_1" })
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("spanHierarchyQuery with narrowByTime adds Timestamp BETWEEN filter", () => {
		const q = spanHierarchyQuery({ traceId: "abc", narrowByTime: true })
		const { sql } = compileCH(q, {
			orgId: "org_1",
			startTime: "2026-04-15 13:00:00",
			endTime: "2026-04-15 15:00:00",
		})
		expect(sql).toContain("Timestamp >= '2026-04-15 13:00:00'")
		expect(sql).toContain("Timestamp <= '2026-04-15 15:00:00'")
	})

	it("spanDetailQuery is a point lookup returning the full attribute maps", () => {
		const q = spanDetailQuery({ traceId: "abc123", spanId: "span1" })
		const { sql } = compileCH(q, { orgId: "org_1" })
		expect(sql).toContain("toJSONString(SpanAttributes) AS spanAttributes")
		expect(sql).toContain("toJSONString(ResourceAttributes) AS resourceAttributes")
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId = 'abc123'")
		expect(sql).toContain("SpanId = 'span1'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ParentSpanId AS parentSpanId")
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("LIMIT 1")
	})

	it("spanDetailQuery with narrowByTime adds Timestamp filters", () => {
		const q = spanDetailQuery({ traceId: "abc", spanId: "s1", narrowByTime: true })
		const { sql } = compileCH(q, {
			orgId: "org_1",
			startTime: "2026-04-15 13:00:00",
			endTime: "2026-04-15 15:00:00",
		})
		expect(sql).toContain("Timestamp >= '2026-04-15 13:00:00'")
		expect(sql).toContain("Timestamp <= '2026-04-15 15:00:00'")
	})

	it("traceTimeProbeQuery is a cheap LIMIT-1 timestamp seek with no ORDER BY", () => {
		const q = traceTimeProbeQuery({ traceId: "abc123" })
		const { sql } = compileCH(q, { orgId: "org_1" })
		expect(sql).toContain("Timestamp AS timestamp")
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId = 'abc123'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("LIMIT 1")
		// Must early-terminate per partition — no sort, no full projection.
		expect(sql).not.toContain("ORDER BY")
		expect(sql).not.toContain("toJSONString")
		// Unbounded fallback shape — no time predicate.
		expect(sql).not.toContain("Timestamp >=")
	})

	it("traceTimeProbeQuery with narrowByTime adds a Timestamp lower bound for partition pruning", () => {
		const q = traceTimeProbeQuery({ traceId: "abc123", narrowByTime: true })
		const { sql } = compileCH(q, { orgId: "org_1", startTime: "2026-04-15 13:00:00" })
		expect(sql).toContain("Timestamp >= '2026-04-15 13:00:00'")
		// Lower bound only — "recent" needs no upper bound.
		expect(sql).not.toContain("Timestamp <=")
		expect(sql).toContain("LIMIT 1")
	})
})
