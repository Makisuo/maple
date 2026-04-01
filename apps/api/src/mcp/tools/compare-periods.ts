import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatPercent, formatDurationFromMs, formatNumber, formatTable } from "../lib/format"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { formatNextSteps } from "../lib/next-steps"

export function registerComparePeriodsTool(server: McpToolRegistrar) {
  server.tool(
    "compare_periods",
    "Compare system health between two time periods to detect regressions. Flags regressions automatically: error_rate_up, latency_up, throughput_drop. Useful after deploys or incident reports. Use around_time to auto-generate a 30min before/after comparison.",
    Schema.Struct({
      current_start: optionalStringParam("Start of current period (YYYY-MM-DD HH:mm:ss). Defaults to 1 hour ago"),
      current_end: optionalStringParam("End of current period (YYYY-MM-DD HH:mm:ss). Defaults to now"),
      previous_start: optionalStringParam("Start of previous period. Defaults to 1 hour before current_start"),
      previous_end: optionalStringParam("End of previous period. Defaults to current_start"),
      around_time: optionalStringParam("Auto-generate 30min before/after comparison around this time (YYYY-MM-DD HH:mm:ss). Overrides current_start/end and previous_start/end"),
      service_name: optionalStringParam("Scope comparison to a specific service"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    Effect.fn("McpTool.comparePeriods")(function* ({ current_start, current_end, previous_start, previous_end, around_time, service_name, environment }) {
        let curSt: string, curEt: string, prevSt: string, prevEt: string

        if (around_time) {
          // Auto-generate 30min before/after comparison
          const center = new Date(around_time.replace(" ", "T") + "Z")
          const halfWindow = 30 * 60 * 1000 // 30 minutes
          prevSt = new Date(center.getTime() - halfWindow).toISOString().replace("T", " ").slice(0, 19)
          prevEt = around_time
          curSt = around_time
          curEt = new Date(center.getTime() + halfWindow).toISOString().replace("T", " ").slice(0, 19)
        } else {
          // Resolve current period
          const current = resolveTimeRange(current_start, current_end, 1)
          curSt = current.st
          curEt = current.et

          // Resolve previous period: default to same duration before current
          const currentStartDate = new Date(current.st.replace(" ", "T") + "Z")
          const currentEndDate = new Date(current.et.replace(" ", "T") + "Z")
          const durationMs = currentEndDate.getTime() - currentStartDate.getTime()

          prevEt = previous_end ?? current.st
          prevSt = previous_start ?? new Date(currentStartDate.getTime() - durationMs)
            .toISOString().replace("T", " ").slice(0, 19)
        }

        // Query both periods in parallel
        const [currentSummary, previousSummary, currentServices, previousServices] =
          yield* Effect.all(
            [
              queryTinybird("errors_summary", {
                start_time: curSt,
                end_time: curEt,
                exclude_spam_patterns: getSpamPatternsParam(),
              }),
              queryTinybird("errors_summary", {
                start_time: prevSt,
                end_time: prevEt,
                exclude_spam_patterns: getSpamPatternsParam(),
              }),
              queryTinybird("service_overview", {
                start_time: curSt,
                end_time: curEt,
                ...(environment && { environments: environment }),
              }),
              queryTinybird("service_overview", {
                start_time: prevSt,
                end_time: prevEt,
                ...(environment && { environments: environment }),
              }),
            ],
            { concurrency: "unbounded" },
          )

        // Aggregate services for both periods
        function aggregateServices(data: typeof currentServices.data) {
          const map = new Map<string, {
            throughput: number
            errorCount: number
            p50: number
            p95: number
            totalWeight: number
          }>()
          for (const row of data) {
            if (service_name && row.serviceName !== service_name) continue
            const tp = Number(row.throughput)
            const existing = map.get(row.serviceName)
            if (existing) {
              existing.throughput += tp
              existing.errorCount += Number(row.errorCount)
              existing.p50 += row.p50LatencyMs * tp
              existing.p95 += row.p95LatencyMs * tp
              existing.totalWeight += tp
            } else {
              map.set(row.serviceName, {
                throughput: tp,
                errorCount: Number(row.errorCount),
                p50: row.p50LatencyMs * tp,
                p95: row.p95LatencyMs * tp,
                totalWeight: tp,
              })
            }
          }
          return map
        }

        const currentSvcMap = aggregateServices(currentServices.data)
        const previousSvcMap = aggregateServices(previousServices.data)

        const curSummary = currentSummary.data[0]
        const prevSummaryRow = previousSummary.data[0]

        // Format delta
        function formatDelta(current: number, previous: number): string {
          if (previous === 0) return current > 0 ? "+inf" : "—"
          const pctChange = ((current - previous) / previous) * 100
          const sign = pctChange >= 0 ? "+" : ""
          return `${sign}${pctChange.toFixed(1)}%`
        }

        const lines: string[] = [
          `## Period Comparison`,
          `Current: ${curSt} — ${curEt}`,
          `Previous: ${prevSt} — ${prevEt}`,
          ``,
        ]

        // Overall summary comparison
        const curErrors = curSummary ? Number(curSummary.totalErrors) : 0
        const prevErrors = prevSummaryRow ? Number(prevSummaryRow.totalErrors) : 0
        const curErrorRate = curSummary ? curSummary.errorRate : 0
        const prevErrorRate = prevSummaryRow ? prevSummaryRow.errorRate : 0
        const curSpans = curSummary ? Number(curSummary.totalSpans) : 0
        const prevSpans = prevSummaryRow ? Number(prevSummaryRow.totalSpans) : 0

        lines.push(`### Overall`)
        const overallHeaders = ["Metric", "Previous", "Current", "Change"]
        const overallRows = [
          ["Total spans", formatNumber(prevSpans), formatNumber(curSpans), formatDelta(curSpans, prevSpans)],
          ["Total errors", formatNumber(prevErrors), formatNumber(curErrors), formatDelta(curErrors, prevErrors)],
          ["Error rate", formatPercent(prevErrorRate), formatPercent(curErrorRate), formatDelta(curErrorRate, prevErrorRate)],
        ]
        lines.push(formatTable(overallHeaders, overallRows))

        // Per-service comparison
        const allServiceNames = new Set([...currentSvcMap.keys(), ...previousSvcMap.keys()])
        if (allServiceNames.size > 0) {
          lines.push(``, `### Per-Service`)
          const svcHeaders = ["Service", "Prev Throughput", "Curr Throughput", "Prev Error Rate", "Curr Error Rate", "Prev P95", "Curr P95", "Flags"]
          const svcRows: string[][] = []

          const regressions: string[] = []

          for (const name of allServiceNames) {
            const cur = currentSvcMap.get(name)
            const prev = previousSvcMap.get(name)

            const curTp = cur?.throughput ?? 0
            const prevTp = prev?.throughput ?? 0
            const curEr = cur && cur.throughput > 0 ? (cur.errorCount / cur.throughput) * 100 : 0
            const prevEr = prev && prev.throughput > 0 ? (prev.errorCount / prev.throughput) * 100 : 0
            const curP95 = cur && cur.totalWeight > 0 ? cur.p95 / cur.totalWeight : 0
            const prevP95 = prev && prev.totalWeight > 0 ? prev.p95 / prev.totalWeight : 0

            const flags: string[] = []
            if (prevEr > 0 && curEr / prevEr > 1.5) flags.push("error_rate_up")
            if (prevP95 > 0 && curP95 / prevP95 > 2) flags.push("latency_up")
            if (prevTp > 0 && curTp / prevTp < 0.5) flags.push("throughput_drop")

            if (flags.length > 0) regressions.push(name)

            svcRows.push([
              name,
              formatNumber(prevTp),
              formatNumber(curTp),
              formatPercent(prevEr),
              formatPercent(curEr),
              formatDurationFromMs(prevP95),
              formatDurationFromMs(curP95),
              flags.join(", ") || "—",
            ])
          }

          lines.push(formatTable(svcHeaders, svcRows))

          // Next steps
          const nextSteps: string[] = []
          for (const svc of Arr.take(regressions, 3)) {
            nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate regression`)
          }
          if (curErrorRate > prevErrorRate && curErrorRate > 1) {
            nextSteps.push('`find_errors` — categorize new errors')
          }
          if (nextSteps.length === 0) {
            nextSteps.push('`list_services` — see current service health')
          }
          lines.push(formatNextSteps(nextSteps))
        }

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "compare_periods" as any,
            data: {
              currentPeriod: { start: curSt, end: curEt },
              previousPeriod: { start: prevSt, end: prevEt },
              overall: {
                current: { totalSpans: curSpans, totalErrors: curErrors, errorRate: curErrorRate },
                previous: { totalSpans: prevSpans, totalErrors: prevErrors, errorRate: prevErrorRate },
              },
              services: Arr.map(Arr.fromIterable(allServiceNames), (name) => {
                const cur = currentSvcMap.get(name)
                const prev = previousSvcMap.get(name)
                return {
                  name,
                  current: {
                    throughput: cur?.throughput ?? 0,
                    errorRate: cur && cur.throughput > 0 ? (cur.errorCount / cur.throughput) * 100 : 0,
                    p95Ms: cur && cur.totalWeight > 0 ? cur.p95 / cur.totalWeight : 0,
                  },
                  previous: {
                    throughput: prev?.throughput ?? 0,
                    errorRate: prev && prev.throughput > 0 ? (prev.errorCount / prev.throughput) * 100 : 0,
                    p95Ms: prev && prev.totalWeight > 0 ? prev.p95 / prev.totalWeight : 0,
                  },
                }
              }),
            },
          }),
        }
      }),
  )
}
