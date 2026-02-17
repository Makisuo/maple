import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { defaultTimeRange } from "../lib/time"
import { formatDurationFromMs, formatPercent, formatNumber, formatTable } from "../lib/format"
import { Effect } from "effect"

export function registerServiceOverviewTool(server: McpToolRegistrar) {
  server.tool(
    "service_overview",
    "List all services with health metrics: latency (P50/P95/P99), error rate, and throughput.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
    },
    ({ start_time, end_time }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime

        const [servicesResult, usageResult] = yield* Effect.all(
          [
            queryTinybird("service_overview", {
              start_time: st,
              end_time: et,
            }),
            queryTinybird("get_service_usage", {
              start_time: st,
              end_time: et,
            }),
          ],
          { concurrency: "unbounded" },
        )

        // Aggregate by service name (collapse environment/commit dimensions)
        const serviceMap = new Map<string, {
          throughput: number
          errorCount: number
          p50: number
          p95: number
          p99: number
          totalWeight: number
        }>()

        for (const row of servicesResult.data) {
          const tp = Number(row.throughput)
          const existing = serviceMap.get(row.serviceName)
          if (existing) {
            existing.throughput += tp
            existing.errorCount += Number(row.errorCount)
            existing.p50 += row.p50LatencyMs * tp
            existing.p95 += row.p95LatencyMs * tp
            existing.p99 += row.p99LatencyMs * tp
            existing.totalWeight += tp
          } else {
            serviceMap.set(row.serviceName, {
              throughput: tp,
              errorCount: Number(row.errorCount),
              p50: row.p50LatencyMs * tp,
              p95: row.p95LatencyMs * tp,
              p99: row.p99LatencyMs * tp,
              totalWeight: tp,
            })
          }
        }

        if (serviceMap.size === 0) {
          return { content: [{ type: "text", text: `No services found in ${st} — ${et}` }] }
        }

        // Build usage map
        const usageMap = new Map<string, { logs: number; traces: number; metrics: number }>()
        for (const u of usageResult.data) {
          usageMap.set(u.serviceName, {
            logs: Number(u.totalLogCount),
            traces: Number(u.totalTraceCount),
            metrics: Number(u.totalSumMetricCount) + Number(u.totalGaugeMetricCount) +
              Number(u.totalHistogramMetricCount) + Number(u.totalExpHistogramMetricCount),
          })
        }

        const lines: string[] = [
          `=== Service Overview (${serviceMap.size} services) ===`,
          `Time range: ${st} — ${et}`,
          ``,
        ]

        const headers = ["Service", "Throughput", "Error Rate", "P50", "P95", "P99"]
        const rows: string[][] = []

        for (const [name, svc] of serviceMap) {
          const errorRate = svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0
          const p50 = svc.totalWeight > 0 ? svc.p50 / svc.totalWeight : 0
          const p95 = svc.totalWeight > 0 ? svc.p95 / svc.totalWeight : 0
          const p99 = svc.totalWeight > 0 ? svc.p99 / svc.totalWeight : 0

          rows.push([
            name,
            formatNumber(svc.throughput),
            formatPercent(errorRate),
            formatDurationFromMs(p50),
            formatDurationFromMs(p95),
            formatDurationFromMs(p99),
          ])
        }

        lines.push(formatTable(headers, rows))

        // Data volume summary
        if (usageResult.data.length > 0) {
          lines.push(``, `Data Volume:`)
          for (const [name] of serviceMap) {
            const usage = usageMap.get(name)
            if (usage) {
              lines.push(`  ${name}: ${formatNumber(usage.traces)} traces, ${formatNumber(usage.logs)} logs, ${formatNumber(usage.metrics)} metrics`)
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
