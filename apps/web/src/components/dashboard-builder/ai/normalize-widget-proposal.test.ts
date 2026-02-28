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
  })
})
