import { describe, expect, it } from "bun:test"
import { compileCH } from "../compile"
import { compileUnion } from "../compile"
import {
  metricsTimeseriesQuery,
  metricsTimeseriesRateQuery,
  metricsBreakdownQuery,
  listMetricsQuery,
  metricsSummaryQuery,
} from "./metrics"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
  bucketSeconds: 3600,
  metricName: "cpu.utilization",
}

// ---------------------------------------------------------------------------
// metricsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("metricsTimeseriesQuery", () => {
  it("compiles value timeseries (sum)", () => {
    const q = metricsTimeseriesQuery({ metricType: "sum" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_sum")
    expect(sql).toContain("avg(Value) AS avgValue")
    expect(sql).toContain("min(Value) AS minValue")
    expect(sql).toContain("max(Value) AS maxValue")
    expect(sql).toContain("sum(Value) AS sumValue")
    expect(sql).toContain("count() AS dataPointCount")
    expect(sql).toContain("INTERVAL 3600 SECOND")
    expect(sql).toContain("GROUP BY bucket, serviceName")
    expect(sql).toContain("ORDER BY bucket ASC")
    expect(sql).toContain("FORMAT JSON")
  })

  it("compiles value timeseries (gauge)", () => {
    const q = metricsTimeseriesQuery({ metricType: "gauge" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_gauge")
  })

  it("compiles histogram timeseries", () => {
    const q = metricsTimeseriesQuery({ metricType: "histogram" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_histogram")
    expect(sql).toContain("sum(Sum) / sum(Count)")
    expect(sql).toContain("min(Min) AS minValue")
    expect(sql).toContain("max(Max) AS maxValue")
    expect(sql).toContain("sum(Sum) AS sumValue")
    expect(sql).toContain("sum(Count) AS dataPointCount")
  })

  it("compiles exponential_histogram timeseries", () => {
    const q = metricsTimeseriesQuery({ metricType: "exponential_histogram" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_exponential_histogram")
  })

  it("applies groupByAttributeKey", () => {
    const q = metricsTimeseriesQuery({ metricType: "sum", groupByAttributeKey: "region" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Attributes['region']")
    expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
  })

  it("applies serviceName filter", () => {
    const q = metricsTimeseriesQuery({ metricType: "sum", serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("applies attribute key/value filter", () => {
    const q = metricsTimeseriesQuery({
      metricType: "sum",
      attributeKey: "region",
      attributeValue: "us-east-1",
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Attributes['region'] = 'us-east-1'")
  })

  it("shows empty string as attributeValue when no groupByAttributeKey", () => {
    const q = metricsTimeseriesQuery({ metricType: "sum" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("'' AS attributeValue")
  })
})

// ---------------------------------------------------------------------------
// metricsTimeseriesRateQuery
// ---------------------------------------------------------------------------

describe("metricsTimeseriesRateQuery", () => {
  it("compiles CTE-based rate query", () => {
    const q = metricsTimeseriesRateQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("WITH with_deltas AS")
    expect(sql).toContain("lagInFrame")
    expect(sql).toContain("PARTITION BY")
    expect(sql).toContain("rateValue")
    expect(sql).toContain("increaseValue")
    expect(sql).toContain("sumIf(")
    expect(sql).toContain("FROM with_deltas")
    expect(sql).toContain("FORMAT JSON")
  })

  it("applies serviceName filter in CTE", () => {
    const q = metricsTimeseriesRateQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("applies attributeKey filter", () => {
    const q = metricsTimeseriesRateQuery({
      attributeKey: "region",
      attributeValue: "us-east-1",
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Attributes['region'] = 'us-east-1'")
  })

  it("applies groupByAttributeKey", () => {
    const q = metricsTimeseriesRateQuery({ groupByAttributeKey: "host" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Attributes['host']")
    expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
  })
})

// ---------------------------------------------------------------------------
// metricsBreakdownQuery
// ---------------------------------------------------------------------------

describe("metricsBreakdownQuery", () => {
  it("compiles value breakdown", () => {
    const q = metricsBreakdownQuery({ metricType: "sum" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_sum")
    expect(sql).toContain("ServiceName AS name")
    expect(sql).toContain("avg(Value) AS avgValue")
    expect(sql).toContain("GROUP BY name")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("FORMAT JSON")
  })

  it("compiles histogram breakdown", () => {
    const q = metricsBreakdownQuery({ metricType: "histogram" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM metrics_histogram")
    expect(sql).toContain("sum(Sum)")
    expect(sql).toContain("sum(Count)")
  })

  it("applies custom limit", () => {
    const q = metricsBreakdownQuery({ metricType: "sum", limit: 25 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 25")
  })
})

// ---------------------------------------------------------------------------
// listMetricsQuery
// ---------------------------------------------------------------------------

describe("listMetricsQuery", () => {
  it("compiles UNION ALL of 4 metric tables", () => {
    const q = listMetricsQuery({})
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(3) // 4 queries = 3 UNION ALL
    expect(sql).toContain("FROM metrics_sum")
    expect(sql).toContain("FROM metrics_gauge")
    expect(sql).toContain("FROM metrics_histogram")
    expect(sql).toContain("FROM metrics_exponential_histogram")
    expect(sql).toContain("'sum' AS metricType")
    expect(sql).toContain("'gauge' AS metricType")
    expect(sql).toContain("ORDER BY lastSeen DESC")
    expect(sql).toContain("LIMIT 100")
  })

  it("filters by metricType", () => {
    const q = listMetricsQuery({ metricType: "sum" })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("FROM metrics_sum")
    expect(sql).not.toContain("UNION ALL")
    expect(sql).not.toContain("FROM metrics_gauge")
  })

  it("applies search filter", () => {
    const q = listMetricsQuery({ search: "http" })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("ILIKE '%http%'")
  })

  it("applies serviceName filter", () => {
    const q = listMetricsQuery({ serviceName: "api" })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("applies custom limit and offset", () => {
    const q = listMetricsQuery({ limit: 50, offset: 10 })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("LIMIT 50")
    expect(sql).toContain("OFFSET 10")
  })
})

// ---------------------------------------------------------------------------
// metricsSummaryQuery
// ---------------------------------------------------------------------------

describe("metricsSummaryQuery", () => {
  it("compiles summary with 4 metric type subqueries", () => {
    const q = metricsSummaryQuery()
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(3)
    expect(sql).toContain("'sum' AS metricType")
    expect(sql).toContain("'gauge' AS metricType")
    expect(sql).toContain("'histogram' AS metricType")
    expect(sql).toContain("'exponential_histogram' AS metricType")
    expect(sql).toContain("uniq(MetricName)")
    expect(sql).toContain("count()")
  })

  it("applies serviceName filter", () => {
    const q = metricsSummaryQuery({ serviceName: "api" })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })
})
