import { optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import {
	resolveTimeRange,
	rangeExceededResult,
	timeRangeInvalidResult,
	MCP_SEARCH_MAX_HOURS,
} from "@/mcp/lib/time"
import { clampLimit, clampOffset } from "@/mcp/lib/limits"
import { truncate, formatNumber } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { searchLogs } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

export function registerSearchLogsTool(server: McpToolRegistrar) {
	server.tool(
		"search_logs",
		"Search and filter logs by service, severity, keyword, or trace_id. Supports pagination — check hasMore in the response for additional results. Use inspect_trace to see the full trace for a log entry.",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter by service name"),
			severity: optionalStringParam(
				"Filter by log severity level. Valid values: TRACE, DEBUG, INFO, WARN, ERROR, FATAL. Case-insensitive.",
			),
			search: optionalStringParam("Search text in log body"),
			trace_id: optionalStringParam("Filter by trace ID"),
			span_id: optionalStringParam("Filter by span ID (scope to a specific span within a trace)"),
			offset: optionalNumberParam(
				"Offset for pagination (default 0). Use nextOffset from previous response.",
			),
			limit: optionalNumberParam("Max results (default 30)"),
		}),
		Effect.fn("McpTool.searchLogs")(function* ({
			start_time,
			end_time,
			service,
			severity,
			search,
			trace_id,
			span_id,
			offset,
			limit,
		}) {
			const range = resolveTimeRange(start_time, end_time, { maxHours: MCP_SEARCH_MAX_HOURS })
			const { st, et } = range
			if (range.invalid.length > 0) return timeRangeInvalidResult(range, "search_logs")
			if (range.exceeded) return rangeExceededResult(range, "search_logs")
			const lim = clampLimit(limit, { defaultValue: 30, max: 200 })
			const off = clampOffset(offset, { max: 10_000 })
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: service ?? "all",
				severity: severity ?? "all",
				limit: lim,
				offset: off,
			})

			const result = yield* searchLogs({
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				severity: severity ?? undefined,
				search: search ?? undefined,
				traceId: trace_id ?? undefined,
				spanId: span_id ?? undefined,
				limit: lim,
				offset: off,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("search_logs")),
			)

			yield* Effect.annotateCurrentSpan("result.rowCount", result.logs.length)

			if (result.logs.length === 0) {
				return { content: [{ type: "text", text: `No logs found matching filters (${st} — ${et})` }] }
			}

			const lines: string[] = [
				`## Logs (${formatNumber(result.total)} total, showing ${result.logs.length})`,
				`Time range: ${st} — ${et}`,
			]

			const filters: string[] = []
			if (service) filters.push(`service=${service}`)
			if (severity) filters.push(`severity=${severity}`)
			if (search) filters.push(`search="${search}"`)
			if (trace_id) filters.push(`trace_id=${trace_id}`)
			if (filters.length > 0) lines.push(`Filters: ${filters.join(", ")}`)
			lines.push(``)

			for (const log of result.logs) {
				const time = log.timestamp.split(" ")[1] ?? log.timestamp
				const sevUpper = log.severityText.toUpperCase()
				const marker = sevUpper === "ERROR" || sevUpper === "FATAL" ? "●" : " "
				const sev = log.severityText.padEnd(5)
				let ref = ""
				if (log.traceId) {
					// Span ref is only useful once scoped to a trace; otherwise it's noise.
					const span = trace_id && log.spanId ? ` span:${log.spanId.slice(0, 8)}` : ""
					ref = ` [trace:${log.traceId.slice(0, 8)}${span}]`
				}
				lines.push(`${marker} ${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 120)}${ref}`)
			}

			const hasMore = result.pagination.hasMore
			if (hasMore) {
				const nextOffset = off + result.logs.length
				lines.push(
					``,
					`Showing ${off + 1}–${off + result.logs.length} of ${formatNumber(result.total)}. Call again with offset=${nextOffset} for more.`,
				)
			}

			const traceIds = [...new Set(result.logs.filter((l) => l.traceId).map((l) => l.traceId))].slice(
				0,
				3,
			)
			const nextSteps = traceIds.map((tid) => `\`inspect_trace trace_id="${tid}"\` — see full trace`)
			const spanPivot = result.logs.find((l) => l.spanId && l.traceId)
			if (spanPivot) {
				nextSteps.push(
					`\`inspect_span trace_id="${spanPivot.traceId}" span_id="${spanPivot.spanId}"\` — full attributes for a span`,
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "search_logs",
					data: {
						timeRange: { start: st, end: et },
						totalCount: result.total,
						pagination: result.pagination,
						logs: result.logs.map((l) => ({ ...l })),
					},
				}),
			}
		}),
	)
}
