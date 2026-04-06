import { describe, expect, it } from "bun:test"
import { compileCH } from "../compile"
import {
  alertTracesAggregateQuery,
  alertTracesAggregateByServiceQuery,
  alertMetricsAggregateQuery,
  alertMetricsAggregateByServiceQuery,
  alertLogsAggregateQuery,
  alertLogsAggregateByServiceQuery,
} from "./alerts"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
}

const metricsParams = {
  ...baseParams,
  metricName: "http.request.duration",
}

// ---------------------------------------------------------------------------
// alertTracesAggregateQuery
// ---------------------------------------------------------------------------

describe("alertTracesAggregateQuery", () => {
  it("compiles basic aggregate with all metrics", () => {
    const q = alertTracesAggregateQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("avg(Duration) / 1000000 AS avgDuration")
    expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50Duration")
    expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95Duration")
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
    expect(sql).toContain("errorRate")
    expect(sql).toContain("apdexScore")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).not.toContain("GROUP BY")
  })

  it("applies serviceName filter", () => {
    const q = alertTracesAggregateQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("applies rootOnly filter", () => {
    const q = alertTracesAggregateQuery({ rootOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
  })

  it("applies errorsOnly filter", () => {
    const q = alertTracesAggregateQuery({ errorsOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("StatusCode = 'Error'")
  })

  it("applies environment filter", () => {
    const q = alertTracesAggregateQuery({ environments: ["production", "staging"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production', 'staging')")
  })

  it("applies attribute filters", () => {
    const q = alertTracesAggregateQuery({
      attributeFilters: [{ key: "http.status_code", value: "500", mode: "equals" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['http.status_code'] = '500'")
  })

  it("uses custom apdex threshold", () => {
    const q = alertTracesAggregateQuery({ apdexThresholdMs: 250 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Duration / 1000000 < 250")
  })
})

// ---------------------------------------------------------------------------
// alertTracesAggregateByServiceQuery
// ---------------------------------------------------------------------------

describe("alertTracesAggregateByServiceQuery", () => {
  it("compiles with GROUP BY serviceName", () => {
    const q = alertTracesAggregateByServiceQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("GROUP BY serviceName")
    expect(sql).toContain("ORDER BY count DESC")
  })

  it("applies environment filter", () => {
    const q = alertTracesAggregateByServiceQuery({ environments: ["prod"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("deployment.environment")
    expect(sql).toContain("GROUP BY serviceName")
  })
})

// ---------------------------------------------------------------------------
// alertMetricsAggregateQuery
// ---------------------------------------------------------------------------

describe("alertMetricsAggregateQuery", () => {
  it("compiles value metric (sum type)", () => {
    const q = alertMetricsAggregateQuery({ metricType: "sum" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("FROM metrics_sum")
    expect(sql).toContain("avg(Value) AS avgValue")
    expect(sql).toContain("min(Value) AS minValue")
    expect(sql).toContain("max(Value) AS maxValue")
    expect(sql).toContain("sum(Value) AS sumValue")
    expect(sql).toContain("count() AS dataPointCount")
    expect(sql).toContain("FORMAT JSON")
  })

  it("compiles value metric (gauge type)", () => {
    const q = alertMetricsAggregateQuery({ metricType: "gauge" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("FROM metrics_gauge")
  })

  it("compiles histogram metric", () => {
    const q = alertMetricsAggregateQuery({ metricType: "histogram" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("FROM metrics_histogram")
    expect(sql).toContain("sum(Count)")
    expect(sql).toContain("sum(Sum)")
    expect(sql).toContain("min(Min)")
    expect(sql).toContain("max(Max)")
  })

  it("compiles exponential_histogram metric", () => {
    const q = alertMetricsAggregateQuery({ metricType: "exponential_histogram" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("FROM metrics_exponential_histogram")
  })

  it("applies serviceName filter", () => {
    const q = alertMetricsAggregateQuery({ metricType: "sum", serviceName: "api" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("ServiceName = 'api'")
  })
})

// ---------------------------------------------------------------------------
// alertMetricsAggregateByServiceQuery
// ---------------------------------------------------------------------------

describe("alertMetricsAggregateByServiceQuery", () => {
  it("compiles value type with GROUP BY", () => {
    const q = alertMetricsAggregateByServiceQuery({ metricType: "sum" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("GROUP BY serviceName")
    expect(sql).toContain("ORDER BY dataPointCount DESC")
  })

  it("compiles histogram type with GROUP BY", () => {
    const q = alertMetricsAggregateByServiceQuery({ metricType: "histogram" })
    const { sql } = compileCH(q, metricsParams)
    expect(sql).toContain("FROM metrics_histogram")
    expect(sql).toContain("GROUP BY serviceName")
  })
})

// ---------------------------------------------------------------------------
// alertLogsAggregateQuery
// ---------------------------------------------------------------------------

describe("alertLogsAggregateQuery", () => {
  it("compiles basic log count aggregate", () => {
    const q = alertLogsAggregateQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).not.toContain("GROUP BY")
  })

  it("applies optional filters", () => {
    const q = alertLogsAggregateQuery({ serviceName: "api", severity: "ERROR" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("SeverityText = 'ERROR'")
  })
})

// ---------------------------------------------------------------------------
// alertLogsAggregateByServiceQuery
// ---------------------------------------------------------------------------

describe("alertLogsAggregateByServiceQuery", () => {
  it("compiles with GROUP BY serviceName", () => {
    const q = alertLogsAggregateByServiceQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("GROUP BY serviceName")
    expect(sql).toContain("ORDER BY count DESC")
  })

  it("applies severity filter", () => {
    const q = alertLogsAggregateByServiceQuery({ severity: "WARN" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SeverityText = 'WARN'")
  })
})
