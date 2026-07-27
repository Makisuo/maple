import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import {
	serviceOverviewQuery,
	serviceOverviewRowSchema,
	serviceCatalogQuery,
	serviceHealthSnapshotQuery,
	serviceHealthSnapshotRowSchema,
	serviceHealthBaselineQuery,
	serviceReleasesTimelineQuery,
	serviceEnvironmentsQuery,
	serviceApdexTimeseriesQuery,
	serviceApdexTimeseriesRowSchema,
	serviceUsageQuery,
	serviceUsageWithPreviousQuery,
	servicesFacetsQuery,
} from "./services"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

describe("serviceCatalogQuery", () => {
	it("aggregates by service name with pruning filters and limit-plus-one pagination", () => {
		const { sql } = compileCH(
			serviceCatalogQuery({
				deploymentEnvironment: "production",
				serviceNamespace: "checkout",
				limit: 21,
				offset: 20,
			}),
			baseParams,
		)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Hour >= if(toDateTime('2024-01-01 00:00:00')")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("ServiceNamespace IN ('checkout')")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("LIMIT 21")
		expect(sql).toContain("OFFSET 20")
	})
})

// ---------------------------------------------------------------------------
// serviceHealthSnapshotQuery
// ---------------------------------------------------------------------------

describe("serviceHealthSnapshotQuery", () => {
	it("reads the hourly aggregate and merges weighted golden signals", () => {
		const { sql } = compileCH(serviceHealthSnapshotQuery({ environments: ["production"] }), baseParams, {
			rowSchema: serviceHealthSnapshotRowSchema,
		})

		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("sum(WeightedCount) AS requestCount")
		expect(sql).toContain("sum(WeightedErrorCount) AS errorCount")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.95)(DurationQuantiles)")
		expect(sql).toContain("GROUP BY serviceName, environment")
		expect(sql).not.toContain("service_overview_spans")
	})

	it("coerces BYO ClickHouse string-encoded aggregates", () => {
		const compiled = compileCH(serviceHealthSnapshotQuery({}), baseParams, {
			rowSchema: serviceHealthSnapshotRowSchema,
		})
		const rows = Effect.runSync(
			compiled.decodeRows([
				{
					serviceName: "checkout",
					environment: "production",
					requestCount: "1200",
					errorCount: "24",
					p95LatencyMs: "187.5",
				},
			]),
		)

		expect(rows[0]).toEqual({
			serviceName: "checkout",
			environment: "production",
			requestCount: 1200,
			errorCount: 24,
			p95LatencyMs: 187.5,
		})
	})
})

// ---------------------------------------------------------------------------
// serviceOverviewQuery
// ---------------------------------------------------------------------------

describe("serviceOverviewQuery", () => {
	it("compiles basic overview with all columns", () => {
		const q = serviceOverviewQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("bServiceName AS serviceName")
		expect(sql).toContain("bServiceNamespace AS serviceNamespace")
		expect(sql).toContain("bEnvironment AS environment")
		expect(sql).toContain("bCommitSha AS commitSha")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("sum(bSpanCount) AS throughput")
		expect(sql).toContain("sum(bErrorCount) AS errorCount")
		expect(sql).toContain("sum(bEstimatedErrorCount) AS estimatedErrorCount")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
		expect(sql).toContain("min(bFirstSeen) AS firstSeen")
		expect(sql).toContain("GROUP BY serviceName, serviceNamespace, environment, commitSha")
		expect(sql).toContain("ORDER BY throughput DESC")
		expect(sql).toContain("LIMIT 100")
		expect(sql).toContain("FORMAT JSON")
	})

	it("merges sampling-corrected counts from raw edges and hourly interiors", () => {
		const q = serviceOverviewQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("estimatedSpanCount")
		expect(sql).toContain("sum(SampleRate)")
		expect(sql).toContain("estimatedErrorCount")
		expect(sql).toContain("sumIf(SampleRate, StatusCode = 'Error')")
		expect(sql).toContain("sum(EstimatedSpanCount)")
		expect(sql).toContain("sum(bEstimatedSpanCount)")
		// The old `anyIf(threshold)` approach must be gone — it was the bug.
		expect(sql).not.toContain("dominantThreshold")
		expect(sql).not.toContain("anyIf")
	})

	it("applies environment filter", () => {
		const q = serviceOverviewQuery({ environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("applies commitSha filter", () => {
		const q = serviceOverviewQuery({ commitShas: ["abc123", "def456"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("CommitSha IN ('abc123', 'def456')")
	})

	it("coerces BYO ClickHouse string-encoded annual aggregates", () => {
		const compiled = compileCH(serviceOverviewQuery({}), baseParams, {
			rowSchema: serviceOverviewRowSchema,
		})
		const [decoded] = Effect.runSync(
			compiled.decodeRows([
				{
					serviceName: "api",
					serviceNamespace: "checkout",
					environment: "production",
					commitSha: "abc123",
					throughput: "100",
					errorCount: "2",
					estimatedErrorCount: "4",
					spanCount: "100",
					p50LatencyMs: "12.5",
					p95LatencyMs: "42",
					p99LatencyMs: "80",
					estimatedSpanCount: "200",
					firstSeen: "2024-01-01 00:00:00",
				},
			]),
		)
		expect(decoded.estimatedSpanCount).toBe(200)
		expect(decoded.p95LatencyMs).toBe(42)
	})
})

// ---------------------------------------------------------------------------
// serviceHealthBaselineQuery
// ---------------------------------------------------------------------------

describe("serviceHealthBaselineQuery", () => {
	it("compiles a per-service p95 baseline scoped to the org", () => {
		const q = serviceHealthBaselineQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain(
			"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS baselineP95LatencyMs",
		)
		expect(sql).toContain("sum(bSpanCount) AS baselineSpanCount")
		// Baseline must NOT split by commit — health compares service+env totals.
		expect(sql).toContain("GROUP BY serviceName, serviceNamespace, environment")
		expect(sql).not.toContain("commitSha")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies environment and namespace filters", () => {
		const q = serviceHealthBaselineQuery({ environments: ["production"], namespaces: ["shop"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("ServiceNamespace IN ('shop')")
	})
})

// ---------------------------------------------------------------------------
// serviceReleasesTimelineQuery
// ---------------------------------------------------------------------------

describe("serviceReleasesTimelineQuery", () => {
	it("compiles releases timeline", () => {
		const q = serviceReleasesTimelineQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("CommitSha != ''")
		expect(sql).toContain("CommitSha AS commitSha")
		expect(sql).toContain("sum(bSpanCount) AS count")
		expect(sql).toContain("sum(bErrorCount) AS errorCount")
		expect(sql).toContain("GROUP BY bucket, commitSha")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("LIMIT 1000")
	})
})

// ---------------------------------------------------------------------------
// serviceEnvironmentsQuery
// ---------------------------------------------------------------------------

describe("serviceEnvironmentsQuery", () => {
	it("compiles a service-scoped, time-windowed distinct-environments query", () => {
		const q = serviceEnvironmentsQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("bEnvironment AS environment")
		// Scoped to the org + this one service (replaces an all-services scan)…
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'api'")
		// …and to the active window so date partitions are pruned.
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp <= '2024-01-02 00:00:00'")
		// Empty env rows are excluded (matches the old switcher's truthy filter).
		expect(sql).toContain("bEnvironment != ''")
		expect(sql).toContain("GROUP BY environment")
		expect(sql).toContain("FORMAT JSON")
	})
})

// ---------------------------------------------------------------------------
// serviceApdexTimeseriesQuery
// ---------------------------------------------------------------------------

describe("serviceApdexTimeseriesQuery", () => {
	it("compiles apdex timeseries with default threshold", () => {
		const q = serviceApdexTimeseriesQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		// Exact raw partial hours surround complete hourly aggregate buckets.
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("sum(bSpanCount) AS totalCount")
		expect(sql).toContain("Duration < 500000000")
		expect(sql).toContain("AS satisfiedCount")
		expect(sql).toContain("AS toleratingCount")
		expect(sql).toContain("AS apdexScore")
		// Errored spans count as frustrated: the satisfied/tolerating buckets are
		// gated on the non-error predicate, so a fast 5xx never inflates apdex.
		expect(sql).toContain("StatusCode != 'Error'")
		// totalCount still counts every span (errors included), so they drag the score down.
		expect(sql).toContain("sum(bSpanCount) AS totalCount")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
		// The MV pre-filters at write time — the runtime root-only predicate is
		// no longer needed in the query body.
		expect(sql).not.toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
	})

	it("compiles with custom threshold", () => {
		const q = serviceApdexTimeseriesQuery({ serviceName: "api", apdexThresholdMs: 250 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Duration / 1000000 < 250")
		// Tolerating = 4x threshold
		expect(sql).toContain("Duration / 1000000 < 1000")
	})

	it("apdex SQL has correct operator precedence", () => {
		// Regression: writing the formula as
		// `satisfied.add(tolerating.mul(0.5)).div(count())` compiled to
		// `satisfied + tolerating * 0.5 / count()`, which under SQL precedence
		// evaluates as `satisfied + ((tolerating*0.5)/count())` ≈ satisfied,
		// producing 6-digit "Apdex" values instead of a 0–1 ratio.
		// The split-term form below is unambiguous left-to-right.
		const q = serviceApdexTimeseriesQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		// The Apdex SELECT must contain the split-term form: each countIf is
		// divided by count() before being summed, instead of summed first.
		expect(sql).toContain(
			"sum(bApdexSatisfiedCount) / sum(bSpanCount) + sum(bApdexToleratingCount) * 0.5 / sum(bSpanCount)",
		)
		// And it must NOT contain the buggy summed-then-divided form.
		expect(sql).not.toMatch(/sum\(bApdexSatisfiedCount\) \+ sum\(bApdexToleratingCount\)/)
	})

	it("coerces BYO ClickHouse string-encoded Apdex aggregates", () => {
		const compiled = compileCH(serviceApdexTimeseriesQuery({ serviceName: "api" }), baseParams, {
			rowSchema: serviceApdexTimeseriesRowSchema,
		})
		const [decoded] = Effect.runSync(
			compiled.decodeRows([
				{
					bucket: "2024-01-01 00:00:00",
					totalCount: "100",
					satisfiedCount: "80",
					toleratingCount: "10",
					apdexScore: "0.85",
				},
			]),
		)
		expect(decoded.totalCount).toBe(100)
		expect(decoded.apdexScore).toBe(0.85)
	})
})

// ---------------------------------------------------------------------------
// serviceUsageQuery
// ---------------------------------------------------------------------------

describe("serviceUsageQuery", () => {
	it("compiles basic usage query", () => {
		const q = serviceUsageQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM service_usage")
		expect(sql).toContain("ServiceName AS serviceName")
		expect(sql).toContain("sum(LogCount) AS totalLogCount")
		expect(sql).toContain("sum(LogSizeBytes) AS totalLogSizeBytes")
		expect(sql).toContain("sum(TraceCount) AS totalTraceCount")
		expect(sql).toContain("sum(TraceSizeBytes) AS totalTraceSizeBytes")
		expect(sql).toContain("sum(SumMetricCount) AS totalSumMetricCount")
		expect(sql).toContain("sum(GaugeMetricCount) AS totalGaugeMetricCount")
		expect(sql).toContain("sum(HistogramMetricCount) AS totalHistogramMetricCount")
		expect(sql).toContain("sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount")
		expect(sql).toContain("AS totalSizeBytes")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("ORDER BY totalSizeBytes DESC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies serviceName filter", () => {
		const q = serviceUsageQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("snaps both Hour bounds to hour boundaries so sub-hour ranges still match", () => {
		// `service_usage` is hourly-keyed; without snapping, a "last 15 min" query
		// like 22:23–22:38 returns no rows. The fix wraps both bounds with
		// `toStartOfHour(toDateTime(...))` so the enclosing hour contributes.
		const q = serviceUsageQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})
})

describe("serviceUsageWithPreviousQuery", () => {
	const params = {
		orgId: "org_1",
		startTime: "2024-01-02 00:00:00",
		endTime: "2024-01-03 00:00:00",
		previousStartTime: "2024-01-01 00:00:00",
		previousEndTime: "2024-01-02 00:00:00",
	}

	it("splits current and previous windows with sumIf in one scan", () => {
		const q = serviceUsageWithPreviousQuery({})
		const { sql } = compileCH(q, params)
		// Single scan of the union window [previousStartTime, endTime].
		expect((sql.match(/FROM service_usage/g) || []).length).toBe(1)
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2024-01-03 00:00:00'))")
		// Current totals are sumIf over [startTime, endTime].
		expect(sql).toContain(
			"sumIf(LogCount, (Hour >= toStartOfHour(toDateTime('2024-01-02 00:00:00')) AND Hour <= toStartOfHour(toDateTime('2024-01-03 00:00:00')))) AS totalLogCount",
		)
		// Previous aggregates are sumIf over [previousStartTime, previousEndTime].
		expect(sql).toContain(
			"sumIf(LogCount, (Hour >= toStartOfHour(toDateTime('2024-01-01 00:00:00')) AND Hour <= toStartOfHour(toDateTime('2024-01-02 00:00:00')))) AS previousLogCount",
		)
		expect(sql).toContain("AS previousSizeBytes")
		expect(sql).toContain("GROUP BY serviceName")
	})
})

// ---------------------------------------------------------------------------
// servicesFacetsQuery
// ---------------------------------------------------------------------------

describe("servicesFacetsQuery", () => {
	it("compiles UNION ALL with environment, namespace, commit_sha, and service facets", () => {
		const q = servicesFacetsQuery()
		const { sql } = compileUnion(q, baseParams)
		const unionCount = (sql.match(/UNION ALL/g) || []).length
		expect(unionCount).toBe(7) // 4 facet branches, each with a raw/hourly window union
		expect(sql).toContain("'environment' AS facetType")
		expect(sql).toContain("'namespace' AS facetType")
		expect(sql).toContain("'commit_sha' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("bEnvironment != ''")
		expect(sql).toContain("bServiceNamespace != ''")
		expect(sql).toContain("bCommitSha != ''")
		expect(sql).toContain("bServiceName != ''")
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
	})
})
