import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { defaultTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { Effect } from "effect"

export function registerListMetricsTool(server: McpToolRegistrar) {
  server.tool(
    "list_metrics",
    "Discover available metrics with type, service, description, and data point counts.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      search: optionalStringParam("Search in metric name"),
      metric_type: optionalStringParam("Filter by type (sum, gauge, histogram, exponential_histogram)"),
      limit: optionalNumberParam("Max results (default 50)"),
    },
    ({ start_time, end_time, service, search, metric_type, limit }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime

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
          `=== Available Metrics ===`,
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

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
