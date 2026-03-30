import {
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatDurationFromMs, formatPercent, formatNumber, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
  server.tool(
    "diagnose_service",
    "Deep investigation of one service: health metrics, Apdex, top errors, recent traces and logs. Use after system_health identifies a problem service.",
    Schema.Struct({
      service_name: requiredStringParam("The service name to diagnose"),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    ({ service_name, start_time, end_time, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const [overviewResult, errorsResult, logsResult, tracesResult, apdexResult] =
          yield* Effect.all(
            [
              queryTinybird("service_overview", { start_time: st, end_time: et, ...(environment && { environments: environment }) }),
              queryTinybird("errors_by_type", {
                start_time: st,
                end_time: et,
                services: service_name,
                limit: 10,
                ...(environment && { deployment_envs: environment }),
                exclude_spam_patterns: getSpamPatternsParam(),
              }),
              queryTinybird("list_logs", {
                start_time: st,
                end_time: et,
                service: service_name,
                limit: 15,
              }),
              queryTinybird("list_traces", {
                start_time: st,
                end_time: et,
                service: service_name,
                limit: 5,
              }),
              queryTinybird("service_apdex_time_series", {
                service_name,
                start_time: st,
                end_time: et,
                bucket_seconds: 300,
              }),
            ],
            { concurrency: "unbounded" },
          )

        // Aggregate service overview rows for this service
        const svcRows = overviewResult.data.filter(
          (r) => r.serviceName === service_name,
        )
        let throughput = 0
        let errorCount = 0
        let weightedP50 = 0
        let weightedP95 = 0
        let weightedP99 = 0
        for (const r of svcRows) {
          const tp = Number(r.throughput)
          throughput += tp
          errorCount += Number(r.errorCount)
          weightedP50 += r.p50LatencyMs * tp
          weightedP95 += r.p95LatencyMs * tp
          weightedP99 += r.p99LatencyMs * tp
        }
        const errorRate = throughput > 0 ? (errorCount / throughput) * 100 : 0
        const p50 = throughput > 0 ? weightedP50 / throughput : 0
        const p95 = throughput > 0 ? weightedP95 / throughput : 0
        const p99 = throughput > 0 ? weightedP99 / throughput : 0

        // Compute average Apdex
        const apdexValues = apdexResult.data.filter(
          (a) => Number(a.totalCount) > 0,
        )
        const avgApdex =
          apdexValues.length > 0
            ? apdexValues.reduce((sum, a) => sum + a.apdexScore, 0) /
              apdexValues.length
            : 0

        const lines: string[] = [
          `## Diagnosis: ${service_name}`,
          `Time range: ${st} — ${et}`,
          ``,
          `Health Metrics:`,
          `  Throughput: ${formatNumber(throughput)} spans`,
          `  Error Rate: ${formatPercent(errorRate)} (${formatNumber(errorCount)} errors)`,
          `  P50 Latency: ${formatDurationFromMs(p50)}`,
          `  P95 Latency: ${formatDurationFromMs(p95)}`,
          `  P99 Latency: ${formatDurationFromMs(p99)}`,
          `  Apdex Score: ${avgApdex.toFixed(3)}`,
        ]

        // Errors
        if (errorsResult.data.length > 0) {
          lines.push(``, `Top Errors:`)
          for (const e of errorsResult.data) {
            lines.push(
              `  - ${truncate(e.errorType, 80)} (${formatNumber(e.count)}x)`,
            )
          }
        } else {
          lines.push(``, `No errors found for this service.`)
        }

        // Recent traces
        if (tracesResult.data.length > 0) {
          lines.push(``, `Recent Traces:`)
          for (const t of tracesResult.data) {
            const dur = Number(t.durationMicros) / 1000
            const err = Number(t.hasError) ? " [Error]" : ""
            lines.push(
              `  ${t.traceId.slice(0, 12)}... ${t.rootSpanName} (${formatDurationFromMs(dur)})${err}`,
            )
          }
        }

        // Recent logs
        if (logsResult.data.length > 0) {
          lines.push(``, `Recent Logs:`)
          for (const log of logsResult.data) {
            const ts = String(log.timestamp)
            const time = ts.split(" ")[1] ?? ts
            const sev = (log.severityText || "INFO").padEnd(5)
            lines.push(`  ${time} [${sev}] ${truncate(log.body, 100)}`)
          }
        }

        const nextSteps: string[] = []
        if (errorsResult.data.length > 0) {
          nextSteps.push(`\`find_errors service="${service_name}"\` — see all error types`)
        }
        if (p95 > 500) {
          nextSteps.push(`\`find_slow_traces service="${service_name}"\` — find slow traces`)
        }
        for (const t of tracesResult.data.filter((t) => Number(t.hasError)).slice(0, 2)) {
          nextSteps.push(`\`inspect_trace trace_id="${t.traceId}"\` — inspect error trace`)
        }
        nextSteps.push(`\`service_map service_name="${service_name}"\` — see upstream/downstream dependencies`)
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "diagnose_service",
            data: {
              serviceName: service_name,
              timeRange: { start: st, end: et },
              health: {
                throughput,
                errorRate,
                errorCount,
                p50Ms: p50,
                p95Ms: p95,
                p99Ms: p99,
                apdex: avgApdex,
              },
              topErrors: errorsResult.data.map((e) => ({
                errorType: e.errorType,
                count: Number(e.count),
              })),
              recentTraces: tracesResult.data.map((t) => ({
                traceId: t.traceId,
                rootSpanName: t.rootSpanName,
                durationMs: Number(t.durationMicros) / 1000,
                spanCount: Number(t.spanCount),
                services: t.services,
                hasError: Boolean(Number(t.hasError)),
              })),
              recentLogs: logsResult.data.map((l) => ({
                timestamp: String(l.timestamp),
                severityText: l.severityText || "INFO",
                serviceName: l.serviceName,
                body: l.body,
                traceId: l.traceId || undefined,
                spanId: l.spanId || undefined,
              })),
            },
          }),
        }
      }),
  )
}
