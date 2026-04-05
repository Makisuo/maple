import { describe, expect, it } from "bun:test"
import { buildTracesTimeseriesSQL, buildTracesBreakdownSQL, escapeClickHouseString } from "./traces-sql-builder"

describe("escapeClickHouseString", () => {
  it("escapes single quotes", () => {
    expect(escapeClickHouseString("it's")).toBe("it\\'s")
  })

  it("escapes backslashes", () => {
    expect(escapeClickHouseString("a\\b")).toBe("a\\\\b")
  })

  it("prevents SQL injection", () => {
    const result = escapeClickHouseString("'; DROP TABLE traces; --")
    expect(result).toBe("\\'; DROP TABLE traces; --")
  })
})

describe("buildTracesTimeseriesSQL", () => {
  const baseParams = {
    orgId: "org_123",
    startTime: "2024-01-01 00:00:00",
    endTime: "2024-01-02 00:00:00",
    bucketSeconds: 3600,
    metric: "count" as const,
    needsSampling: false,
  }

  it("builds basic count timeseries", () => {
    const sql = buildTracesTimeseriesSQL(baseParams)
    expect(sql).toContain("SELECT")
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("OrgId = 'org_123'")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("INTERVAL 3600 SECOND")
    expect(sql).toContain("GROUP BY bucket, groupName")
    expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
    expect(sql).toContain("FORMAT JSON")
    // Default group name
    expect(sql).toContain("'all' AS groupName")
    // count metric should not include quantiles
    expect(sql).toContain("0 AS p50Duration")
  })

  it("builds apdex timeseries with threshold", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      metric: "apdex",
      apdexThresholdMs: 250,
    })
    expect(sql).toContain("countIf(Duration / 1000000 < 250) AS satisfiedCount")
    expect(sql).toContain("toleratingCount")
    expect(sql).toContain("apdexScore")
  })

  it("builds p95 duration timeseries", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      metric: "p95_duration",
    })
    expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50Duration")
    expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95Duration")
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
  })

  it("builds error_rate timeseries", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      metric: "error_rate",
    })
    expect(sql).toContain("countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate")
  })

  it("includes sampling columns when needsSampling is true", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      needsSampling: true,
    })
    expect(sql).toContain("sampledSpanCount")
    expect(sql).toContain("unsampledSpanCount")
    expect(sql).toContain("dominantThreshold")
    expect(sql).toContain("TraceState LIKE '%th:%'")
  })

  it("excludes sampling columns when needsSampling is false", () => {
    const sql = buildTracesTimeseriesSQL(baseParams)
    expect(sql).toContain("0 AS sampledSpanCount")
    expect(sql).toContain("0 AS unsampledSpanCount")
    expect(sql).toContain("'' AS dominantThreshold")
  })

  it("groups by service", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      groupBy: ["service"],
    })
    expect(sql).toContain("toString(ServiceName)")
    expect(sql).toContain("AS groupName")
  })

  it("groups by span_name", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      groupBy: ["span_name"],
    })
    expect(sql).toContain("toString(SpanName)")
  })

  it("groups by multiple dimensions", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      groupBy: ["service", "status_code"],
    })
    expect(sql).toContain("arrayStringConcat")
    expect(sql).toContain("arrayFilter")
  })

  it("groups by attribute with keys", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      groupBy: ["attribute"],
      groupByAttributeKeys: ["http.route"],
    })
    expect(sql).toContain("SpanAttributes['http.route']")
  })

  it("uses traces table when rootOnly (MV disabled)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      rootOnly: true,
    })
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
  })

  it("uses traces table when not rootOnly", () => {
    const sql = buildTracesTimeseriesSQL(baseParams)
    expect(sql).toContain("FROM traces")
  })

  it("falls back to traces table when commitShas present", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      rootOnly: true,
      commitShas: ["abc123"],
    })
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("ParentSpanId = ''")
    expect(sql).toContain("deployment.commit_sha")
  })

  it("filters by serviceName", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      serviceName: "api-service",
    })
    expect(sql).toContain("ServiceName = 'api-service'")
  })

  it("filters by spanName", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      spanName: "GET /users",
    })
    expect(sql).toContain("SpanName = 'GET /users'")
  })

  it("filters errorsOnly", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      errorsOnly: true,
    })
    expect(sql).toContain("StatusCode = 'Error'")
  })

  it("filters errorsOnly with rootOnly (MV disabled)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      rootOnly: true,
      errorsOnly: true,
    })
    expect(sql).toContain("StatusCode = 'Error'")
  })

  it("filters by environments", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      environments: ["production", "staging"],
    })
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production', 'staging')")
  })

  it("filters by environments with rootOnly (MV disabled)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      rootOnly: true,
      environments: ["production"],
    })
    expect(sql).toContain("deployment.environment")
  })

  it("filters by attribute filters (equals)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      attributeFilters: [{ key: "http.status_code", value: "200", mode: "equals" }],
    })
    expect(sql).toContain("SpanAttributes['http.status_code'] = '200'")
  })

  it("filters by attribute filters (exists)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      attributeFilters: [{ key: "http.route", mode: "exists" }],
    })
    expect(sql).toContain("mapContains(SpanAttributes, 'http.route')")
  })

  it("filters by attribute filters (contains)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      attributeFilters: [{ key: "http.route", value: "/api", mode: "contains" }],
    })
    expect(sql).toContain("positionCaseInsensitive(SpanAttributes['http.route'], '/api') > 0")
  })

  it("filters by attribute filters (gt)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      attributeFilters: [{ key: "http.status_code", value: "400", mode: "gt" }],
    })
    expect(sql).toContain("toFloat64OrZero(SpanAttributes['http.status_code']) > 400")
  })

  it("filters by resource attribute filters", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
    })
    expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
  })

  it("filters attribute with rootOnly on raw table (MV disabled)", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      rootOnly: true,
      attributeFilters: [{ key: "http.method", value: "GET", mode: "equals" }],
    })
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanAttributes['http.method'] = 'GET'")
  })

  it("escapes special characters in filter values", () => {
    const sql = buildTracesTimeseriesSQL({
      ...baseParams,
      serviceName: "it's-a-service",
    })
    expect(sql).toContain("ServiceName = 'it\\'s-a-service'")
  })
})

describe("buildTracesBreakdownSQL", () => {
  const baseParams = {
    orgId: "org_123",
    startTime: "2024-01-01 00:00:00",
    endTime: "2024-01-02 00:00:00",
    metric: "count" as const,
    groupBy: "service" as const,
  }

  it("builds basic breakdown by service", () => {
    const sql = buildTracesBreakdownSQL(baseParams)
    expect(sql).toContain("SELECT")
    expect(sql).toContain("ServiceName AS name")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY name")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("FORMAT JSON")
  })

  it("groups by span_name", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      groupBy: "span_name",
    })
    expect(sql).toContain("SpanName AS name")
  })

  it("groups by status_code", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      groupBy: "status_code",
    })
    expect(sql).toContain("StatusCode AS name")
  })

  it("groups by http_method", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      groupBy: "http_method",
    })
    expect(sql).toContain("SpanAttributes['http.method'] AS name")
  })

  it("groups by custom attribute", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      groupBy: "attribute",
      groupByAttributeKey: "rpc.service",
    })
    expect(sql).toContain("SpanAttributes['rpc.service'] AS name")
  })

  it("applies custom limit", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      limit: 25,
    })
    expect(sql).toContain("LIMIT 25")
  })

  it("uses default limit of 10", () => {
    const sql = buildTracesBreakdownSQL(baseParams)
    expect(sql).toContain("LIMIT 10")
  })

  it("includes apdex columns for apdex metric", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      metric: "apdex",
      apdexThresholdMs: 300,
    })
    expect(sql).toContain("countIf(Duration / 1000000 < 300) AS satisfiedCount")
    expect(sql).toContain("apdexScore")
  })

  it("includes quantile columns for p99 metric", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      metric: "p99_duration",
    })
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
  })

  it("applies WHERE filters", () => {
    const sql = buildTracesBreakdownSQL({
      ...baseParams,
      serviceName: "api",
      errorsOnly: true,
    })
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("StatusCode = 'Error'")
  })
})
