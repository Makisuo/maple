import { optionalStringParam, McpQueryError, type McpToolRegistrar } from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatDurationFromMs, formatPercent, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { serviceMap } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

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
		Effect.fn("McpTool.serviceMap")(function* ({ start_time, end_time, service_name, environment }) {
			const { st, et } = resolveTimeRange(start_time, end_time)
			const tenant = yield* resolveTenant

			let edges = yield* serviceMap({
				timeRange: { startTime: st, endTime: et },
				service: service_name ?? undefined,
				environment: environment ?? undefined,
			}).pipe(
				Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
				Effect.mapError(
					(e) => new McpQueryError({ message: e.message, pipe: "service_dependencies" }),
				),
			)

			// Filter to edges involving the specified service
			if (service_name) {
				edges = Arr.filter(
					edges,
					(e) => e.sourceService === service_name || e.targetService === service_name,
				)
			}

			if (edges.length === 0) {
				const filterInfo = service_name ? ` involving "${service_name}"` : ""
				return {
					content: [
						{ type: "text", text: `No service dependencies found${filterInfo} in ${st} — ${et}` },
					],
				}
			}

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

			const headers = [
				"Source → Target",
				"Calls",
				"Errors",
				"Error Rate",
				"Avg Duration",
				"P95 Duration",
			]
			const rows = Arr.map(edges, (e) => {
				const errorRate = e.callCount > 0 ? e.errorCount / e.callCount : 0
				return [
					`${e.sourceService} → ${e.targetService}`,
					formatNumber(e.callCount),
					formatNumber(e.errorCount),
					formatPercent(errorRate),
					formatDurationFromMs(e.avgDurationMs),
					formatDurationFromMs(e.p95DurationMs),
				]
			})

			lines.push(formatTable(headers, rows))

			const nextSteps: string[] = []
			const errorEdges = Arr.filter(
				Arr.map(edges, (e) => ({
					service: e.targetService,
					errorRate: e.callCount > 0 ? e.errorCount / e.callCount : 0,
				})),
				(e) => e.errorRate > 0.01,
			).sort((a, b) => b.errorRate - a.errorRate)

			for (const e of Arr.take(errorEdges, 2)) {
				nextSteps.push(
					`\`diagnose_service service_name="${e.service}"\` — investigate high error rate dependency`,
				)
			}
			if (nextSteps.length === 0) {
				nextSteps.push("`list_services` — see all services with health metrics")
			}
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
							p95DurationMs: e.p95DurationMs,
						})),
						serviceCount: services.size,
					},
				}),
			}
		}),
	)
}
