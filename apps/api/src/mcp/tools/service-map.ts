import { optionalStringParam, optionalTimeParam, McpQueryError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "@/mcp/lib/time"
import { formatNumber, formatDurationFromMs, formatPercent, formatTable } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Array as Arr, Effect, HashSet, Order, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { serviceMap } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

export function registerServiceMapTool(server: McpToolRegistrar) {
	server.tool(
		"service_map",
		"Show service-to-service dependencies with call counts, error rates, and latency per edge. Use to understand system architecture and identify problematic inter-service calls.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service_name: optionalStringParam("Filter to edges involving this service (as source or target)"),
			environment: optionalStringParam("Filter by deployment environment"),
		}),
		Effect.fn("McpTool.serviceMap")(function* ({ start_time, end_time, service_name, environment }) {
			const { st, et } = resolveTimeRange(start_time, end_time)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: service_name ?? "all",
				environment: environment ?? "all",
			})

			const allEdges = yield* serviceMap({
				timeRange: { startTime: st, endTime: et },
				service: service_name ?? undefined,
				environment: environment ?? undefined,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(
					(e) =>
						new McpQueryError({ message: e.message, pipeName: "service_dependencies", cause: e }),
				),
			)

			// The warehouse query does not scope by service, so filter to edges
			// involving the specified service here.
			const edges = service_name
				? Arr.filter(
						allEdges,
						(e) => e.sourceService === service_name || e.targetService === service_name,
					)
				: allEdges

			if (edges.length === 0) {
				const filterInfo = service_name ? ` involving "${service_name}"` : ""
				return {
					content: [
						{ type: "text", text: `No service dependencies found${filterInfo} in ${st} — ${et}` },
					],
				}
			}

			const services = HashSet.fromIterable(
				Arr.flatMap(edges, (e) => [e.sourceService, e.targetService]),
			)
			const serviceCount = HashSet.size(services)

			const lines: string[] = [
				`## Service Map`,
				`Time range: ${st} — ${et}`,
				`Services: ${serviceCount} | Edges: ${edges.length}`,
				``,
			]

			const headers = [
				"Source → Target",
				"Calls",
				"Errors",
				"Error Rate",
				"Avg Duration",
				"Max Duration",
			]
			const rows = Arr.map(edges, (e) => {
				const errorRate = e.callCount > 0 ? e.errorCount / e.callCount : 0
				return [
					`${e.sourceService} → ${e.targetService}`,
					formatNumber(e.callCount),
					formatNumber(e.errorCount),
					formatPercent(errorRate),
					formatDurationFromMs(e.avgDurationMs),
					formatDurationFromMs(e.maxDurationMs),
				]
			})

			lines.push(formatTable(headers, rows))

			const errorEdges = Arr.sort(
				Arr.filter(
					Arr.map(edges, (e) => ({
						service: e.targetService,
						errorRate: e.callCount > 0 ? e.errorCount / e.callCount : 0,
					})),
					(e) => e.errorRate > 0.01,
				),
				Order.mapInput(Order.flip(Order.Number), (e: { errorRate: number }) => e.errorRate),
			)

			const errorEdgeSteps = Arr.map(
				Arr.take(errorEdges, 2),
				(e) =>
					`\`diagnose_service service_name="${e.service}"\` — investigate high error rate dependency`,
			)
			const nextSteps =
				errorEdgeSteps.length > 0
					? errorEdgeSteps
					: ["`list_services` — see all services with health metrics"]
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "service_map",
					data: {
						timeRange: { start: st, end: et },
						edges: Arr.map(edges, (e) => ({
							sourceService: e.sourceService,
							targetService: e.targetService,
							callCount: e.callCount,
							errorCount: e.errorCount,
							avgDurationMs: e.avgDurationMs,
							maxDurationMs: e.maxDurationMs,
						})),
						serviceCount,
					},
				}),
			}
		}),
	)
}
