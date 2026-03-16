import { describe, expect, it } from "bun:test"
import * as JSONSchema from "effect/JSONSchema"
import { buildQuerySpec, queryDataArgsSchema } from "./query-data"

describe("query_data", () => {
  it("rejects traces attribute grouping without attribute_key", () => {
    const result = buildQuerySpec({
      source: "traces",
      kind: "breakdown",
      group_by: "attribute",
    } as unknown as Parameters<typeof buildQuerySpec>[0])

    expect(result).toEqual({
      error: "`group_by=attribute` requires `attribute_key`.",
    })
  })

  it("requires metric_name and metric_type for metrics queries", () => {
    const result = buildQuerySpec({
      source: "metrics",
      kind: "timeseries",
      metric: "avg",
    } as Parameters<typeof buildQuerySpec>[0])

    expect(result).toEqual({
      error: "`metric_name` and `metric_type` are required for metrics queries.",
    })
  })

  it("builds the expected QuerySpec for supported branches", () => {
    const cases = [
      {
        input: {
          source: "traces",
          kind: "timeseries",
          metric: "count",
          group_by: "http_method",
          bucket_seconds: 300,
        } as const,
        expected: {
          kind: "timeseries",
          source: "traces",
          metric: "count",
          groupBy: "http_method",
          bucketSeconds: 300,
        },
      },
      {
        input: {
          source: "traces",
          kind: "breakdown",
          metric: "p95_duration",
          group_by: "service",
          limit: 5,
        } as const,
        expected: {
          kind: "breakdown",
          source: "traces",
          metric: "p95_duration",
          groupBy: "service",
          limit: 5,
        },
      },
      {
        input: {
          source: "logs",
          kind: "timeseries",
          group_by: "severity",
        } as const,
        expected: {
          kind: "timeseries",
          source: "logs",
          metric: "count",
          groupBy: "severity",
        },
      },
      {
        input: {
          source: "logs",
          kind: "breakdown",
          group_by: "service",
          severity: "ERROR",
        } as const,
        expected: {
          kind: "breakdown",
          source: "logs",
          metric: "count",
          groupBy: "service",
          filters: {
            severity: "ERROR",
          },
        },
      },
      {
        input: {
          source: "metrics",
          kind: "timeseries",
          metric: "max",
          group_by: "none",
          metric_name: "request.duration",
          metric_type: "histogram",
        } as const,
        expected: {
          kind: "timeseries",
          source: "metrics",
          metric: "max",
          groupBy: "none",
          filters: {
            metricName: "request.duration",
            metricType: "histogram",
          },
        },
      },
      {
        input: {
          source: "metrics",
          kind: "breakdown",
          metric: "sum",
          metric_name: "request.count",
          metric_type: "sum",
          limit: 10,
        } as const,
        expected: {
          kind: "breakdown",
          source: "metrics",
          metric: "sum",
          groupBy: "service",
          filters: {
            metricName: "request.count",
            metricType: "sum",
          },
          limit: 10,
        },
      },
    ]

    for (const testCase of cases) {
      const result = buildQuerySpec(testCase.input as Parameters<typeof buildQuerySpec>[0])
      expect(result as unknown).toEqual({ spec: testCase.expected })
    }
  })

  it("generates a flat object schema with no anyOf for Claude Code compatibility", () => {
    const schema = JSONSchema.make(queryDataArgsSchema) as unknown as Record<string, unknown>

    expect(schema.type).toBe("object")
    expect("anyOf" in schema).toBe(false)
    expect("oneOf" in schema).toBe(false)
    expect("allOf" in schema).toBe(false)
  })
})
