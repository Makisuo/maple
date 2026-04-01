import {
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatTable } from "../lib/format"
import { formatMetricValue } from "../lib/format-query-result"
import { formatNextSteps } from "../lib/next-steps"
import { createDualContent } from "../lib/structured-output"
import { Effect, Schema } from "effect"
import { topOperations } from "@maple/query-engine/observability"
import type { TracesMetric } from "@maple/query-engine"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerGetServiceTopOperationsTool(server: McpToolRegistrar) {
  server.tool(
    "get_service_top_operations",
    "Get the top operations (endpoints/spans) for a service, sorted by request count, error rate, or latency. Use after diagnosing a slow/erroring service to find which endpoints need attention.",
    Schema.Struct({
      service_name: requiredStringParam("Service name to get top operations for"),
      metric: optionalStringParam(
        "Metric to sort by: count (request volume), error_rate, avg_duration, p95_duration (default: count)",
      ),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      limit: optionalNumberParam("Max operations to return (default 20)"),
    }),
    Effect.fn("McpTool.getServiceTopOperations")(function* ({ service_name, metric, start_time, end_time, limit }) {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const resolvedMetric = (metric ?? "count") as TracesMetric
        const resolvedLimit = limit ?? 20
        const tenant = yield* resolveTenant

        const operations = yield* topOperations({
          serviceName: service_name,
          metric: resolvedMetric,
          timeRange: { startTime: st, endTime: et },
          limit: resolvedLimit,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "top_operations" })),
        )

        const lines: string[] = [
          `## Top Operations: ${service_name}`,
          `Time range: ${st} — ${et}`,
          `Metric: ${resolvedMetric}`,
          ``,
        ]

        if (operations.length === 0) {
          lines.push("No operations found for this service in the given time range.")
          lines.push(formatNextSteps([
            `\`search_traces service_name="${service_name}"\` — search for traces from this service`,
            `\`list_services\` — verify the service name`,
          ]))
          return {
            content: createDualContent(lines.join("\n"), {
              tool: "get_service_top_operations",
              data: { timeRange: { start: st, end: et }, serviceName: service_name, metric: resolvedMetric, total: 0, operations: [] },
            }),
          }
        }

        lines.push(formatTable(
          ["Operation", resolvedMetric],
          operations.map((op) => [op.name, formatMetricValue(resolvedMetric, op.value)]),
        ))

        const nextSteps = operations.slice(0, 3).map((op) =>
          `\`search_traces service_name="${service_name}" span_name="${op.name}"\` — find traces for ${op.name}`
        )
        nextSteps.push(`\`query_data source="traces" kind="timeseries" metric="${resolvedMetric}" service_name="${service_name}"\` — chart trend over time`)
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "get_service_top_operations",
            data: {
              timeRange: { start: st, end: et },
              serviceName: service_name,
              metric: resolvedMetric,
              total: operations.length,
              operations: [...operations],
            },
          }),
        }
      }),
  )
}
