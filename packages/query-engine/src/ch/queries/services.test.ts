import { describe, expect, it } from "bun:test"
import { compileCH, compileUnion } from "../compile"
import {
  serviceOverviewQuery,
  serviceReleasesTimelineQuery,
  serviceApdexTimeseriesQuery,
  serviceUsageQuery,
  servicesFacetsQuery,
} from "./services"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
  bucketSeconds: 3600,
}

// ---------------------------------------------------------------------------
// serviceOverviewQuery
// ---------------------------------------------------------------------------

describe("serviceOverviewQuery", () => {
  it("compiles basic overview with all columns", () => {
    const q = serviceOverviewQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM service_overview_spans")
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("DeploymentEnv AS environment")
    expect(sql).toContain("CommitSha AS commitSha")
    expect(sql).toContain("count() AS throughput")
    expect(sql).toContain("countIf(StatusCode = 'Error') AS errorCount")
    expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50LatencyMs")
    expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95LatencyMs")
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99LatencyMs")
    expect(sql).toContain("GROUP BY serviceName, environment, commitSha")
    expect(sql).toContain("ORDER BY throughput DESC")
    expect(sql).toContain("LIMIT 100")
    expect(sql).toContain("FORMAT JSON")
  })

  it("includes sampling columns", () => {
    const q = serviceOverviewQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("sampledSpanCount")
    expect(sql).toContain("unsampledSpanCount")
    expect(sql).toContain("dominantThreshold")
    expect(sql).toContain("TraceState LIKE '%th:%'")
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
})

// ---------------------------------------------------------------------------
// serviceReleasesTimelineQuery
// ---------------------------------------------------------------------------

describe("serviceReleasesTimelineQuery", () => {
  it("compiles releases timeline", () => {
    const q = serviceReleasesTimelineQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM service_overview_spans")
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("CommitSha != ''")
    expect(sql).toContain("CommitSha AS commitSha")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY bucket, commitSha")
    expect(sql).toContain("ORDER BY bucket ASC")
    expect(sql).toContain("LIMIT 1000")
  })
})

// ---------------------------------------------------------------------------
// serviceApdexTimeseriesQuery
// ---------------------------------------------------------------------------

describe("serviceApdexTimeseriesQuery", () => {
  it("compiles apdex timeseries with default threshold", () => {
    const q = serviceApdexTimeseriesQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("count() AS totalCount")
    expect(sql).toContain("Duration / 1000000 < 500")
    expect(sql).toContain("AS satisfiedCount")
    expect(sql).toContain("AS toleratingCount")
    expect(sql).toContain("AS apdexScore")
    expect(sql).toContain("GROUP BY bucket")
    expect(sql).toContain("ORDER BY bucket ASC")
    // Root-only filter
    expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
  })

  it("compiles with custom threshold", () => {
    const q = serviceApdexTimeseriesQuery({ serviceName: "api", apdexThresholdMs: 250 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Duration / 1000000 < 250")
    // Tolerating = 4x threshold
    expect(sql).toContain("Duration / 1000000 < 1000")
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
})

// ---------------------------------------------------------------------------
// servicesFacetsQuery
// ---------------------------------------------------------------------------

describe("servicesFacetsQuery", () => {
  it("compiles UNION ALL with environment and commit_sha facets", () => {
    const q = servicesFacetsQuery()
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(1)
    expect(sql).toContain("'environment' AS facetType")
    expect(sql).toContain("'commit_sha' AS facetType")
    expect(sql).toContain("DeploymentEnv != ''")
    expect(sql).toContain("CommitSha != ''")
    expect(sql).toContain("FROM service_overview_spans")
  })
})
