import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerListMetricsTool(server: McpToolRegistrar) {
  server.tool(
    "list_metrics",
    "Discover available custom metrics with their types and data volume. Use chart_metrics with a discovered metric_name and metric_type.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      search: optionalStringParam("Search in metric name"),
      metric_type: optionalStringParam("Filter by type (sum, gauge, histogram, exponential_histogram)"),
      limit: optionalNumberParam("Max results (default 50)"),
    }),
    ({ start_time, end_time, service, search, metric_type, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const [metricsResult, summaryResult] = yield* Effect.all(
          [
            queryTinybird("list_metrics", {
              start_time: st,
              end_time: et,
              service,
              search,
              metric_type,
              limit: limit ?? 50,
            }),
            queryTinybird("metrics_summary", {
              start_time: st,
              end_time: et,
              service,
            }),
          ],
          { concurrency: "unbounded" },
        )

        const metrics = metricsResult.data
        const summary = summaryResult.data

        const lines: string[] = [
          `## Available Metrics`,
          `Time range: ${st} — ${et}`,
        ]

        // Summary counts by type
        if (summary.length > 0) {
          lines.push(``)
          for (const s of summary) {
            lines.push(
              `  ${s.metricType}: ${formatNumber(s.metricCount)} metrics, ${formatNumber(s.dataPointCount)} data points`,
            )
          }
        }

        if (metrics.length === 0) {
          lines.push(``, `No metrics found matching filters.`)
          return { content: [{ type: "text", text: lines.join("\n") }] }
        }

        lines.push(``, `Metrics (${metrics.length}):`, ``)

        const headers = ["Name", "Type", "Service", "Unit", "Data Points"]
        const rows = metrics.map((m) => [
          m.metricName.length > 40 ? m.metricName.slice(0, 37) + "..." : m.metricName,
          m.metricType,
          m.serviceName,
          m.metricUnit || "-",
          formatNumber(m.dataPointCount),
        ])

        lines.push(formatTable(headers, rows))

        const nextSteps = metrics.slice(0, 3).map((m) =>
          `\`chart_metrics kind="timeseries" metric_name="${m.metricName}" metric_type="${m.metricType}"\` — chart this metric`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_metrics",
            data: {
              timeRange: { start: st, end: et },
              summary: summary.map((s) => ({
                metricType: s.metricType,
                metricCount: Number(s.metricCount),
                dataPointCount: Number(s.dataPointCount),
              })),
              metrics: metrics.map((m) => ({
                metricName: m.metricName,
                metricType: m.metricType,
                serviceName: m.serviceName,
                metricUnit: m.metricUnit || "",
                dataPointCount: Number(m.dataPointCount),
              })),
            },
          }),
        }
      }),
  )
}
