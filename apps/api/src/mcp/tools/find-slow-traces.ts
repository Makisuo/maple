import { optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { resolveTimeRange, rangeExceededResult, MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { clampLimit } from "../lib/limits"
import { formatDurationFromMs, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "../lib/structured-output"
import { findSlowTraces } from "@maple/query-engine/observability"

export function registerFindSlowTracesTool(server: McpToolRegistrar) {
	server.tool(
		"find_slow_traces",
		"Find the slowest traces with percentile context (p50, p95, min, max). Use inspect_trace on slow trace_ids to find bottleneck spans.",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter by service name"),
			environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
			limit: optionalNumberParam("Max results (default 10)"),
		}),
		Effect.fn("McpTool.findSlowTraces")(function* ({
			start_time,
			end_time,
			service,
			environment,
			limit,
		}) {
			const range = resolveTimeRange(start_time, end_time, { maxHours: MCP_SEARCH_MAX_HOURS })
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "find_slow_traces")
			const lim = clampLimit(limit, { defaultValue: 10, max: 100 })

			const result = yield* withTenantExecutor(
				findSlowTraces({
					timeRange: { startTime: st, endTime: et },
					service: service ?? undefined,
					environment: environment ?? undefined,
					limit: lim,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("find_slow_traces")))

			if (result.traces.length === 0) {
				return { content: [{ type: "text" as const, text: `No traces found in ${st} — ${et}` }] }
			}

			const lines: string[] = [`## Slowest Traces`, `Time range: ${st} — ${et}`]

			if (result.stats) {
				lines.push(
					``,
					`Duration Percentiles:`,
					`  P50: ${formatDurationFromMs(result.stats.p50Ms)}`,
					`  P95: ${formatDurationFromMs(result.stats.p95Ms)}`,
					`  Min: ${formatDurationFromMs(result.stats.minMs)}`,
					`  Max: ${formatDurationFromMs(result.stats.maxMs)}`,
				)
			}

			lines.push(``)

			const headers = ["Trace ID", "Root Span", "Duration", "Service", "Error"]
			const rows = Arr.map(result.traces, (t) => [
				t.traceId.slice(0, 12) + "...",
				t.spanName.length > 30 ? t.spanName.slice(0, 27) + "..." : t.spanName,
				formatDurationFromMs(t.durationMs),
				t.serviceName,
				t.statusCode === "Error" ? "Yes" : "",
			])

			lines.push(formatTable(headers, rows))

			const nextSteps = pipe(
				result.traces,
				Arr.take(3),
				Arr.map((t) => `\`inspect_trace trace_id="${t.traceId}"\` — find bottleneck spans`),
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "find_slow_traces",
					data: {
						timeRange: { start: st, end: et },
						stats: result.stats ?? undefined,
						traces: Arr.map(result.traces, (t) => ({
							traceId: t.traceId,
							rootSpanName: t.spanName,
							durationMs: t.durationMs,
							spanCount: 1,
							services: [t.serviceName],
							hasError: t.statusCode === "Error",
							resourceAttributes: t.resourceAttributes,
						})),
					},
				}),
			}
		}),
	)
}
