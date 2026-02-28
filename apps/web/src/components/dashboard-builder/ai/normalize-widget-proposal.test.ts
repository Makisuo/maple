import { describe, expect, it } from "vitest"
import { createQueryDraft, resetQueryForDataSource } from "@/lib/query-builder/model"
import { normalizeAiWidgetProposal } from "@/components/dashboard-builder/ai/normalize-widget-proposal"

describe("normalizeAiWidgetProposal", () => {
  it("converts legacy flat timeseries params to queries[]", () => {
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          source: "metrics",
          metric: "sum",
          filters: {
            metricName: "http.server.duration",
            metricType: "histogram",
            serviceName: "api",
          },
          groupBy: "service",
          bucketSeconds: 300,
        },
      },
      display: {
        title: "Metric Chart",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("valid")
    if (result.kind !== "valid") return

    const params = result.proposal.dataSource.params as Record<string, unknown>
    const queries = params.queries as Array<Record<string, unknown>>
    expect(Array.isArray(queries)).toBe(true)
    expect(queries).toHaveLength(1)
    expect(queries[0]?.dataSource).toBe("metrics")
    expect(queries[0]?.aggregation).toBe("sum")
    expect(queries[0]?.metricName).toBe("http.server.duration")
    expect(queries[0]?.metricType).toBe("histogram")
    expect(queries[0]?.stepInterval).toBe("300")
  })

  it("blocks metrics query without metric name/type", () => {
    const metricsQuery = resetQueryForDataSource(createQueryDraft(0), "metrics")
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [
            {
              ...metricsQuery,
              metricName: "",
            },
          ],
        },
      },
      display: {
        title: "Broken Metric Chart",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") return
    expect(result.reason).toContain("metric name and metric type")
  })

  it("blocks metrics query with invalid metric type", () => {
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [
            {
              dataSource: "metrics",
              metricName: "http.server.duration",
              metricType: "invalid_type",
              metric: "avg",
            },
          ],
        },
      },
      display: {
        title: "Invalid Metric Type",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") return
    expect(result.reason).toContain("metric name and metric type")
  })

  it("accepts valid metrics query and preserves metric values", () => {
    const metricsQuery = {
      ...resetQueryForDataSource(createQueryDraft(0), "metrics"),
      metricName: "process.runtime.jvm.cpu.utilization",
      metricType: "gauge",
      aggregation: "avg",
    }

    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [metricsQuery],
          formulas: [],
          comparison: { mode: "none", includePercentChange: true },
          debug: false,
        },
      },
      display: {
        title: "CPU",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("valid")
    if (result.kind !== "valid") return

    const params = result.proposal.dataSource.params as Record<string, unknown>
    const queries = params.queries as Array<Record<string, unknown>>
    expect(queries[0]?.metricName).toBe("process.runtime.jvm.cpu.utilization")
    expect(queries[0]?.metricType).toBe("gauge")
    expect(queries[0]?.aggregation).toBe("avg")
    expect(typeof queries[0]?.id).toBe("string")
    expect(typeof queries[0]?.whereClause).toBe("string")
    expect(typeof queries[0]?.addOns).toBe("object")
  })

  it("hydrates minimal metrics query entries into full query drafts", () => {
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [
            {
              dataSource: "metrics",
              metricName: "http.server.duration",
              metricType: "histogram",
              metric: "sum",
            },
          ],
        },
      },
      display: {
        title: "Hydrated Metrics Query",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("valid")
    if (result.kind !== "valid") return
    const params = result.proposal.dataSource.params as Record<string, unknown>
    const queries = params.queries as Array<Record<string, unknown>>
    expect(queries).toHaveLength(1)
    expect(typeof queries[0]?.id).toBe("string")
    expect(queries[0]?.name).toBe("A")
    expect(queries[0]?.enabled).toBe(true)
    expect(queries[0]?.dataSource).toBe("metrics")
    expect(typeof queries[0]?.whereClause).toBe("string")
    expect(typeof queries[0]?.stepInterval).toBe("string")
    expect(typeof queries[0]?.addOns).toBe("object")
  })

  it("converts spec-like query entries inside queries[]", () => {
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [
            {
              source: "metrics",
              metric: "count",
              filters: {
                metricName: "queue.depth",
                metricType: "gauge",
                serviceName: "worker",
              },
              groupBy: "service",
              bucketSeconds: 120,
            },
          ],
        },
      },
      display: {
        title: "Spec-like query",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("valid")
    if (result.kind !== "valid") return
    const params = result.proposal.dataSource.params as Record<string, unknown>
    const queries = params.queries as Array<Record<string, unknown>>
    expect(queries[0]?.dataSource).toBe("metrics")
    expect(queries[0]?.aggregation).toBe("count")
    expect(queries[0]?.metricName).toBe("queue.depth")
    expect(queries[0]?.metricType).toBe("gauge")
    expect(queries[0]?.stepInterval).toBe("120")
  })

  it("drops malformed query entries and blocks when none remain", () => {
    const result = normalizeAiWidgetProposal({
      visualization: "chart",
      dataSource: {
        endpoint: "custom_query_builder_timeseries",
        params: {
          queries: [
            null,
            123,
            "bad",
            {},
          ],
        },
      },
      display: {
        title: "Malformed Queries",
        chartId: "query-builder-line",
      },
    })

    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") return
    expect(result.reason).toContain("missing queries[]")
  })
})
