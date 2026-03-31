import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatPercent, formatDurationFromMs, formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { createDualContent } from "../lib/structured-output"
import { Effect, Schema } from "effect"

export function registerListServicesTool(server: McpToolRegistrar) {
  server.tool(
    "list_services",
    "List all active services with key metrics (throughput, error rate, P95 latency). Use as an entry point to discover services before drilling down with diagnose_service or get_service_top_operations.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    ({ start_time, end_time, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const servicesResult = yield* queryTinybird("service_overview", {
          start_time: st,
          end_time: et,
          ...(environment && { environments: environment }),
        })

        const allServices = servicesResult.data

        // Aggregate by service name (collapse environment/commit dimensions)
        const serviceMap = new Map<string, {
          throughput: number
          errorCount: number
          p95: number
          totalWeight: number
        }>()

        for (const row of allServices) {
          const tp = Number(row.throughput)
          const existing = serviceMap.get(row.serviceName)
          if (existing) {
            existing.throughput += tp
            existing.errorCount += Number(row.errorCount)
            existing.p95 += row.p95LatencyMs * tp
            existing.totalWeight += tp
          } else {
            serviceMap.set(row.serviceName, {
              throughput: tp,
              errorCount: Number(row.errorCount),
              p95: row.p95LatencyMs * tp,
              totalWeight: tp,
            })
          }
        }

        // Sort by throughput descending
        const sorted = Array.from(serviceMap.entries()).sort(
          ([, a], [, b]) => b.throughput - a.throughput,
        )

        const lines: string[] = [
          `## Services`,
          `Time range: ${st} — ${et}`,
          `Total: ${sorted.length} service${sorted.length !== 1 ? "s" : ""}`,
          ``,
        ]

        if (sorted.length === 0) {
          lines.push("No active services found in this time range.")
        } else {
          const headers = ["Service", "Throughput (rpm)", "Error Rate", "P95 Latency"]
          const rows = sorted.map(([name, svc]) => {
            const errorRate = svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0
            const p95 = svc.totalWeight > 0 ? svc.p95 / svc.totalWeight : 0

            return [
              name,
              formatNumber(svc.throughput),
              formatPercent(errorRate),
              formatDurationFromMs(p95),
            ]
          })

          lines.push(formatTable(headers, rows))
        }

        // Next steps: suggest diagnose_service for top 3 services by throughput
        const nextSteps: string[] = []
        const top3 = sorted.slice(0, 3)
        for (const [name] of top3) {
          nextSteps.push(`\`diagnose_service service_name="${name}"\` — deep-dive into ${name}`)
        }
        if (sorted.length > 0) {
          nextSteps.push(`\`get_service_top_operations service_name="<name>"\` — see top endpoints for a service`)
        }
        lines.push(formatNextSteps(nextSteps))

        const servicesArray = sorted.map(([name, svc]) => ({
          name,
          throughput: svc.throughput,
          errorRate: svc.throughput > 0 ? (svc.errorCount / svc.throughput) * 100 : 0,
          p95Ms: svc.totalWeight > 0 ? svc.p95 / svc.totalWeight : 0,
        }))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_services",
            data: {
              timeRange: { start: st, end: et },
              total: sorted.length,
              services: servicesArray,
            },
          }),
        }
      }),
  )
}
