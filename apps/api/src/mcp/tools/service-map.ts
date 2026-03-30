import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatDurationFromMs, formatPercent, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerServiceMapTool(server: McpToolRegistrar) {
  server.tool(
    "service_map",
    "Show service-to-service dependencies with call counts, error rates, and latency per edge. Use to understand system architecture and identify problematic inter-service calls.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service_name: optionalStringParam("Filter to edges involving this service (as source or target)"),
      environment: optionalStringParam("Filter by deployment environment"),
    }),
    ({ start_time, end_time, service_name, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const result = yield* queryTinybird("service_dependencies", {
          start_time: st,
          end_time: et,
          ...(environment && { deployment_env: environment }),
        })

        let edges = result.data

        // Filter to edges involving the specified service
        if (service_name) {
          edges = edges.filter(
            (e) => e.sourceService === service_name || e.targetService === service_name,
          )
        }

        if (edges.length === 0) {
          const filterInfo = service_name ? ` involving "${service_name}"` : ""
          return { content: [{ type: "text", text: `No service dependencies found${filterInfo} in ${st} — ${et}` }] }
        }

        // Collect unique services
        const services = new Set<string>()
        for (const e of edges) {
          services.add(e.sourceService)
          services.add(e.targetService)
        }

        const lines: string[] = [
          `## Service Map`,
          `Time range: ${st} — ${et}`,
          `Services: ${services.size} | Edges: ${edges.length}`,
          ``,
        ]

        const headers = ["Source → Target", "Calls", "Errors", "Error Rate", "Avg Duration", "P95 Duration"]
        const rows = edges.map((e) => {
          const callCount = Number(e.callCount)
          const errorCount = Number(e.errorCount)
          const errorRate = callCount > 0 ? (errorCount / callCount) * 100 : 0
          return [
            `${e.sourceService} → ${e.targetService}`,
            formatNumber(callCount),
            formatNumber(errorCount),
            formatPercent(errorRate),
            formatDurationFromMs(e.avgDurationMs),
            formatDurationFromMs(e.p95DurationMs),
          ]
        })

        lines.push(formatTable(headers, rows))

        // Next steps
        const nextSteps: string[] = []
        // Suggest diagnosing services with highest error rates on edges
        const errorEdges = edges
          .map((e) => ({
            service: e.targetService,
            errorRate: Number(e.callCount) > 0 ? Number(e.errorCount) / Number(e.callCount) * 100 : 0,
          }))
          .filter((e) => e.errorRate > 1)
          .sort((a, b) => b.errorRate - a.errorRate)

        for (const e of errorEdges.slice(0, 2)) {
          nextSteps.push(`\`diagnose_service service_name="${e.service}"\` — investigate high error rate dependency`)
        }

        if (service_name) {
          const upstreamCallers = edges.filter((e) => e.targetService === service_name).map((e) => e.sourceService)
          const downstreamDeps = edges.filter((e) => e.sourceService === service_name).map((e) => e.targetService)
          if (upstreamCallers.length > 0) {
            lines.push(``, `Upstream callers: ${upstreamCallers.join(", ")}`)
          }
          if (downstreamDeps.length > 0) {
            lines.push(`Downstream dependencies: ${downstreamDeps.join(", ")}`)
          }
        }

        if (nextSteps.length === 0) {
          nextSteps.push('`system_health` — see overall system health')
        }
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "service_map",
            data: {
              timeRange: { start: st, end: et },
              edges: edges.map((e) => ({
                sourceService: e.sourceService,
                targetService: e.targetService,
                callCount: Number(e.callCount),
                errorCount: Number(e.errorCount),
                avgDurationMs: e.avgDurationMs,
                p95DurationMs: e.p95DurationMs,
              })),
              serviceCount: services.size,
            },
          }),
        }
      }),
  )
}
