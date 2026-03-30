import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatPercent, formatDurationFromMs, formatNumber, formatTable } from "../lib/format"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { formatNextSteps } from "../lib/next-steps"

export function registerSystemHealthTool(server: McpToolRegistrar) {
  server.tool(
    "system_health",
    "Get system health snapshot: error rate, latency percentiles (P50/P95), top errors, per-service breakdown, and data volume. Best starting point for any investigation. Use diagnose_service or find_errors to drill deeper.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service_name: optionalStringParam("Scope to a specific service"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    ({ start_time, end_time, service_name, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const [summaryResult, servicesResult, errorsResult, usageResult] = yield* Effect.all(
          [
            queryTinybird("errors_summary", {
              start_time: st,
              end_time: et,
              exclude_spam_patterns: getSpamPatternsParam(),
            }),
            queryTinybird("service_overview", {
              start_time: st,
              end_time: et,
              ...(environment && { environments: environment }),
            }),
            queryTinybird("errors_by_type", {
              start_time: st,
              end_time: et,
              limit: 5,
              ...(service_name && { services: service_name }),
              ...(environment && { deployment_envs: environment }),
              exclude_spam_patterns: getSpamPatternsParam(),
            }),
            queryTinybird("get_service_usage", {
              start_time: st,
              end_time: et,
            }),
          ],
          { concurrency: "unbounded" },
        )

        const summary = summaryResult.data[0]
        const allServices = servicesResult.data
        const errors = errorsResult.data

        // Aggregate by service name (collapse environment/commit dimensions)
        const serviceMap = new Map<string, {
          throughput: number
          errorCount: number
          p50: number
          p95: number
          p99: number
          totalWeight: number
        }>()

        for (const row of allServices) {
          if (service_name && row.serviceName !== service_name) continue
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

        const serviceCount = serviceMap.size

        // Calculate weighted latency averages
        let totalThroughput = 0
        let weightedP50 = 0
        let weightedP95 = 0
        for (const svc of serviceMap.values()) {
          totalThroughput += svc.throughput
          weightedP50 += svc.p50
          weightedP95 += svc.p95
        }
        const avgP50 = totalThroughput > 0 ? weightedP50 / totalThroughput : 0
        const avgP95 = totalThroughput > 0 ? weightedP95 / totalThroughput : 0

        // Build usage map
        const usageMap = new Map<string, { logs: number; traces: number; metrics: number }>()
        for (const u of usageResult.data) {
          if (service_name && u.serviceName !== service_name) continue
          usageMap.set(u.serviceName, {
            logs: Number(u.totalLogCount),
            traces: Number(u.totalTraceCount),
            metrics: Number(u.totalSumMetricCount) + Number(u.totalGaugeMetricCount) +
              Number(u.totalHistogramMetricCount) + Number(u.totalExpHistogramMetricCount),
          })
        }

        const lines: string[] = [
          `## System Health`,
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

        // Per-service breakdown table
        if (serviceMap.size > 0) {
          lines.push(``, `### Services`)
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
        }

        // Data volume
        if (usageMap.size > 0) {
          lines.push(``, `### Data Volume`)
          for (const [name, usage] of usageMap) {
            lines.push(`  ${name}: ${formatNumber(usage.traces)} traces, ${formatNumber(usage.logs)} logs, ${formatNumber(usage.metrics)} metrics`)
          }
        }

        // Next steps
        const nextSteps: string[] = []
        if (summary && summary.errorRate > 0) {
          nextSteps.push('`find_errors` — categorize errors by type')
        }
        // Suggest diagnose for highest error rate service
        let worstService: string | null = null
        let worstErrorRate = 0
        for (const [name, svc] of serviceMap) {
          const er = svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0
          if (er > worstErrorRate) {
            worstErrorRate = er
            worstService = name
          }
        }
        if (worstService && worstErrorRate > 1) {
          nextSteps.push(`\`diagnose_service service_name="${worstService}"\` — investigate highest error rate service`)
        }
        if (avgP95 > 500) {
          nextSteps.push('`query_data source="traces" kind="timeseries" metric="p95_duration"` — chart latency trend')
        }
        nextSteps.push('`compare_periods` — check for regressions vs previous period')
        lines.push(formatNextSteps(nextSteps))

        // Build structured data — includes services array and dataVolume
        const servicesArray = Array.from(serviceMap.entries()).map(([name, svc]) => ({
          name,
          throughput: svc.throughput,
          errorRate: svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0,
          p50Ms: svc.totalWeight > 0 ? svc.p50 / svc.totalWeight : 0,
          p95Ms: svc.totalWeight > 0 ? svc.p95 / svc.totalWeight : 0,
          p99Ms: svc.totalWeight > 0 ? svc.p99 / svc.totalWeight : 0,
        }))

        const dataVolumeArray = usageMap.size > 0
          ? Array.from(usageMap.entries()).map(([name, usage]) => ({
              name,
              traces: usage.traces,
              logs: usage.logs,
              metrics: usage.metrics,
            }))
          : undefined

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "system_health",
            data: {
              timeRange: { start: st, end: et },
              serviceCount,
              totalSpans: summary ? Number(summary.totalSpans) : 0,
              totalErrors: summary ? Number(summary.totalErrors) : 0,
              errorRate: summary ? summary.errorRate : 0,
              affectedServicesCount: summary ? Number(summary.affectedServicesCount) : 0,
              affectedTracesCount: summary ? Number(summary.affectedTracesCount) : 0,
              latency: { p50Ms: avgP50, p95Ms: avgP95 },
              topErrors: errors.map((e) => ({
                errorType: e.errorType,
                count: Number(e.count),
                affectedServicesCount: Number(e.affectedServicesCount),
              })),
              services: servicesArray,
              dataVolume: dataVolumeArray,
            },
          }),
        }
      }),
  )
}
