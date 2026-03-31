import {
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatTable } from "../lib/format"
import { formatMetricValue } from "../lib/format-query-result"
import { formatNextSteps } from "../lib/next-steps"
import { createDualContent } from "../lib/structured-output"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { QueryEngineService } from "@/services/QueryEngineService"
import { QuerySpec, type QuerySpec as QuerySpecType } from "@maple/query-engine"

const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

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
    ({ service_name, metric, start_time, end_time, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)

        const resolvedMetric = metric ?? "count"
        const resolvedLimit = limit ?? 20

        let decodedQuery: QuerySpecType
        try {
          decodedQuery = decodeQuerySpecSync({
            kind: "breakdown",
            source: "traces",
            metric: resolvedMetric,
            groupBy: "span_name",
            filters: { serviceName: service_name },
            limit: resolvedLimit,
          })
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Invalid query specification:\n${String(error)}` }],
          }
        }

        const tenant = yield* resolveTenant
        const queryEngine = yield* QueryEngineService
        const exit = yield* queryEngine.execute(tenant, {
          startTime: st,
          endTime: et,
          query: decodedQuery,
        }).pipe(Effect.exit)

        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
          if (failure && typeof failure === "object" && "_tag" in failure) {
            const tagged = failure as { _tag: string; message: string; details?: string[] }
            const details = tagged.details ? `\n${tagged.details.join("\n")}` : ""
            return {
              isError: true,
              content: [{ type: "text" as const, text: `${tagged._tag}: ${tagged.message}${details}` }],
            }
          }

          return {
            isError: true,
            content: [{ type: "text" as const, text: Cause.pretty(exit.cause) }],
          }
        }

        const result = exit.value.result

        const lines: string[] = [
          `## Top Operations: ${service_name}`,
          `Time range: ${st} — ${et}`,
          `Metric: ${resolvedMetric}`,
          ``,
        ]

        if (result.kind !== "breakdown" || result.data.length === 0) {
          lines.push("No operations found for this service in the given time range.")
          lines.push(formatNextSteps([
            `\`search_traces service_name="${service_name}"\` — search for traces from this service`,
            `\`list_services\` — verify the service name`,
          ]))

          return {
            content: createDualContent(lines.join("\n"), {
              tool: "get_service_top_operations",
              data: {
                timeRange: { start: st, end: et },
                serviceName: service_name,
                metric: resolvedMetric,
                total: 0,
                operations: [],
              },
            }),
          }
        }

        const headers = ["Operation", resolvedMetric]
        const rows = result.data.map((item) => [
          item.name,
          formatMetricValue(resolvedMetric, item.value),
        ])

        lines.push(formatTable(headers, rows))

        // Next steps: suggest search_traces for top operations
        const nextSteps: string[] = []
        const top3 = result.data.slice(0, 3)
        for (const op of top3) {
          nextSteps.push(
            `\`search_traces service_name="${service_name}" span_name="${op.name}"\` — find traces for ${op.name}`,
          )
        }
        nextSteps.push(
          `\`query_data source="traces" kind="timeseries" metric="${resolvedMetric}" service_name="${service_name}"\` — chart trend over time`,
        )
        lines.push(formatNextSteps(nextSteps))

        const operationsArray = result.data.map((item) => ({
          name: item.name,
          value: item.value,
        }))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "get_service_top_operations",
            data: {
              timeRange: { start: st, end: et },
              serviceName: service_name,
              metric: resolvedMetric,
              total: result.data.length,
              operations: operationsArray,
            },
          }),
        }
      }),
  )
}
