import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { defaultTimeRange } from "../lib/time"
import { formatPercent, formatDurationFromMs, formatNumber } from "../lib/format"
import { Effect } from "effect"

export function registerSystemHealthTool(server: McpToolRegistrar) {
  server.tool(
    "system_health",
    "Get an overall health snapshot of the system: error rate, active services, latency stats, and top errors.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
    },
    ({ start_time, end_time }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime

        const [summaryResult, servicesResult, errorsResult] = yield* Effect.all(
          [
            queryTinybird("errors_summary", {
              start_time: st,
              end_time: et,
              exclude_spam_patterns: getSpamPatternsParam(),
            }),
            queryTinybird("service_overview", {
              start_time: st,
              end_time: et,
            }),
            queryTinybird("errors_by_type", {
              start_time: st,
              end_time: et,
              limit: 5,
              exclude_spam_patterns: getSpamPatternsParam(),
            }),
          ],
          { concurrency: "unbounded" },
        )

        const summary = summaryResult.data[0]
        const services = servicesResult.data
        const errors = errorsResult.data

        const serviceCount = new Set(services.map((s) => s.serviceName)).size

        let totalThroughput = 0
        let weightedP50 = 0
        let weightedP95 = 0
        for (const s of services) {
          const tp = Number(s.throughput)
          totalThroughput += tp
          weightedP50 += s.p50LatencyMs * tp
          weightedP95 += s.p95LatencyMs * tp
        }
        const avgP50 = totalThroughput > 0 ? weightedP50 / totalThroughput : 0
        const avgP95 = totalThroughput > 0 ? weightedP95 / totalThroughput : 0

        const lines: string[] = [
          `=== System Health Snapshot ===`,
          `Time range: ${st} — ${et}`,
          ``,
          `Services active: ${serviceCount}`,
          `Total spans: ${summary ? formatNumber(summary.totalSpans) : "0"}`,
          `Total errors: ${summary ? formatNumber(summary.totalErrors) : "0"}`,
          `Error rate: ${summary ? formatPercent(summary.errorRate) : "0.00%"}`,
          `Affected services: ${summary ? Number(summary.affectedServicesCount) : 0}`,
          `Affected traces: ${summary ? Number(summary.affectedTracesCount) : 0}`,
          ``,
          `Latency (weighted avg):`,
          `  P50: ${formatDurationFromMs(avgP50)}`,
          `  P95: ${formatDurationFromMs(avgP95)}`,
        ]

        if (errors.length > 0) {
          lines.push(``, `Top Errors:`)
          for (const e of errors) {
            lines.push(
              `  - ${e.errorType} (${formatNumber(e.count)}x, ${Number(e.affectedServicesCount)} services)`,
            )
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
