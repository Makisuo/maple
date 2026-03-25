import { describe, expect, it } from "vitest"
import { defaultRuleForm, flattenAlertChartData, signalToQueryParams } from "./form-utils"

const makePoint = (bucket: string, series: Record<string, number>) => ({ bucket, series })

describe("flattenAlertChartData", () => {
  it("filters to only selected services when multiple are specified", () => {
    const points = [
      makePoint("2026-03-25 10:00:00", { "svc-a": 1.5, "svc-b": 2.0, "svc-c": 3.0 }),
      makePoint("2026-03-25 10:05:00", { "svc-a": 1.8, "svc-b": 2.5, "svc-c": 0.5 }),
    ]

    const result = flattenAlertChartData(points, ["svc-a", "svc-b"])

    expect(result).toEqual([
      { bucket: "2026-03-25 10:00:00", "svc-a": 1.5, "svc-b": 2.0 },
      { bucket: "2026-03-25 10:05:00", "svc-a": 1.8, "svc-b": 2.5 },
    ])
  })

  it("remaps series key to the service name for single service", () => {
    const points = [
      makePoint("2026-03-25 10:00:00", { "svc-a": 4.2 }),
      makePoint("2026-03-25 10:05:00", { "svc-a": 3.1 }),
    ]

    const result = flattenAlertChartData(points, ["svc-a"])

    expect(result).toEqual([
      { bucket: "2026-03-25 10:00:00", "svc-a": 4.2 },
      { bucket: "2026-03-25 10:05:00", "svc-a": 3.1 },
    ])
  })

  it("defaults to 0 when single service is missing from series", () => {
    const points = [
      makePoint("2026-03-25 10:00:00", { all: 5.0 }),
    ]

    const result = flattenAlertChartData(points, ["svc-a"])

    expect(result).toEqual([
      { bucket: "2026-03-25 10:00:00", "svc-a": 0 },
    ])
  })

  it("passes through all series keys when no services specified", () => {
    const points = [
      makePoint("2026-03-25 10:00:00", { "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 }),
    ]

    const result = flattenAlertChartData(points, [])

    expect(result).toEqual([
      { bucket: "2026-03-25 10:00:00", "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 },
    ])
  })

  it("skips selected services not present in series data", () => {
    const points = [
      makePoint("2026-03-25 10:00:00", { "svc-a": 1.0 }),
    ]

    const result = flattenAlertChartData(points, ["svc-a", "svc-missing"])

    expect(result).toEqual([
      { bucket: "2026-03-25 10:00:00", "svc-a": 1.0 },
    ])
  })

  it("handles empty points array", () => {
    expect(flattenAlertChartData([], ["svc-a"])).toEqual([])
    expect(flattenAlertChartData([], [])).toEqual([])
  })
})

describe("signalToQueryParams", () => {
  it("parses traces query filters from the where clause for alert previews", () => {
    const form = {
      ...defaultRuleForm(),
      signalType: "query" as const,
      queryDataSource: "traces" as const,
      queryAggregation: "count",
      queryWhereClause:
        'service.name = "checkout" AND span.name = "GET /checkout" AND has_error = true',
    }

    expect(signalToQueryParams(form)).toEqual({
      source: "traces",
      metric: "count",
      filters: {
        serviceName: "checkout",
        spanName: "GET /checkout",
        errorsOnly: true,
      },
    })
  })

  it("parses logs query filters from the where clause for alert previews", () => {
    const form = {
      ...defaultRuleForm(),
      signalType: "query" as const,
      queryDataSource: "logs" as const,
      queryAggregation: "count",
      queryWhereClause: 'service.name = "checkout" AND severity = "error"',
    }

    expect(signalToQueryParams(form)).toEqual({
      source: "logs",
      metric: "count",
      filters: {
        serviceName: "checkout",
        severity: "error",
      },
    })
  })

  it("parses metrics query service filters from the where clause for alert previews", () => {
    const form = {
      ...defaultRuleForm(),
      signalType: "query" as const,
      queryDataSource: "metrics" as const,
      queryAggregation: "avg",
      metricName: "cpu.usage",
      metricType: "gauge" as const,
      queryWhereClause: 'service.name = "worker"',
    }

    expect(signalToQueryParams(form)).toEqual({
      source: "metrics",
      metric: "avg",
      filters: {
        metricName: "cpu.usage",
        metricType: "gauge",
        serviceName: "worker",
      },
    })
  })
})
