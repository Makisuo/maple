import {
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange, rangeExceededResult, MCP_SEARCH_MAX_HOURS } from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatTable } from "@/mcp/lib/format"
import { formatMetricValue } from "@/mcp/lib/format-query-result"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { Effect, Option, Schema } from "effect"
import { topOperations } from "@maple/query-engine/observability"
import { TracesMetric } from "@maple/query-engine"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

const decodeTracesMetric = Schema.decodeUnknownOption(TracesMetric)

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
		Effect.fn("McpTool.getServiceTopOperations")(function* ({
			service_name,
			metric,
			start_time,
			end_time,
			limit,
		}) {
			const range = resolveTimeRange(start_time, end_time, { maxHours: MCP_SEARCH_MAX_HOURS })
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "get_service_top_operations")
			const metricOption =
				metric === undefined ? Option.some("count" as const) : decodeTracesMetric(metric)
			if (Option.isNone(metricOption)) {
				return validationError(
					`Invalid metric: ${metric}. Must be one of: count, error_rate, avg_duration, p95_duration.`,
				)
			}
			const resolvedMetric = metricOption.value
			const resolvedLimit = clampLimit(limit, { defaultValue: 20, max: 500 })
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: service_name,
				metric: resolvedMetric,
				limit: resolvedLimit,
			})

			const operations = yield* topOperations({
				serviceName: service_name,
				metric: resolvedMetric,
				timeRange: { startTime: st, endTime: et },
				limit: resolvedLimit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("top_operations")),
			)

			const lines: string[] = [
				`## Top Operations: ${service_name}`,
				`Time range: ${st} — ${et}`,
				`Metric: ${resolvedMetric}`,
				``,
			]

			if (operations.length === 0) {
				lines.push("No operations found for this service in the given time range.")
				lines.push(
					formatNextSteps([
						`\`search_traces service_name="${service_name}"\` — search for traces from this service`,
						`\`list_services\` — verify the service name`,
					]),
				)
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

			lines.push(
				formatTable(
					["Operation", resolvedMetric],
					operations.map((op) => [op.name, formatMetricValue(resolvedMetric, op.value)]),
				),
			)

			const nextSteps = operations
				.slice(0, 3)
				.map(
					(op) =>
						`\`search_traces service_name="${service_name}" span_name="${op.name}"\` — find traces for ${op.name}`,
				)
			nextSteps.push(
				`\`query_data source="traces" kind="timeseries" metric="${resolvedMetric}" service_name="${service_name}"\` — chart trend over time`,
			)
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
