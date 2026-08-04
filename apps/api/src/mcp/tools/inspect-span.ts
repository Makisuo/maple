import { requiredStringParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor } from "@/mcp/lib/query-warehouse"
import { truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { spanDetail } from "@maple/query-engine/observability"

export function registerInspectSpanTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_span",
		"Get the full attribute set for a single span (use after `inspect_trace`, which shows only a trimmed set of attributes per span). Pass the `span_id` shown in the trace tree. Pass `timestamp` (any timestamp from the trace) to prune ClickHouse partitions.",
		Schema.Struct({
			trace_id: requiredStringParam("The trace ID the span belongs to"),
			span_id: requiredStringParam("The span ID to inspect (from `inspect_trace` output)"),
			timestamp: optionalStringParam(
				"ISO-8601 timestamp of the span (e.g. from `search_traces` results). Narrows the ClickHouse scan to a ±1h window.",
			),
		}),
		Effect.fn("McpTool.inspectSpan")(function* ({ trace_id, span_id, timestamp }) {
			yield* Effect.annotateCurrentSpan({ traceId: trace_id, spanId: span_id })

			const timestampHint = timestamp ? new Date(timestamp) : undefined
			if (timestampHint && Number.isNaN(timestampHint.getTime())) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid timestamp: ${timestamp}. Expected ISO-8601 (e.g. 2026-04-15T14:30:00Z).`,
						},
					],
				}
			}

			const result = yield* withTenantExecutor(
				spanDetail({ traceId: trace_id, spanId: span_id, timestampHint }),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("span_detail")))

			if (!result.found) {
				const hint = timestampHint
					? ""
					: " Pass `timestamp` from the trace if the span is older than the default scan window."
				return {
					content: [
						{
							type: "text" as const,
							text: `Span ${span_id} not found in trace ${trace_id}.${hint}`,
						},
					],
				}
			}

			const renderAttrs = (label: string, attrs: Record<string, string>): string[] => {
				const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))
				if (entries.length === 0) return []
				return [
					``,
					`### ${label} (${entries.length})`,
					...entries.map(([k, v]) => `- \`${k}\`: ${truncate(String(v), 500)}`),
				]
			}

			const lines: string[] = [
				`## Span ${span_id} (trace ${trace_id})`,
				...renderAttrs("Span attributes", result.spanAttributes),
				...renderAttrs("Resource attributes", result.resourceAttributes),
			]

			if (
				Object.keys(result.spanAttributes).length === 0 &&
				Object.keys(result.resourceAttributes).length === 0
			) {
				lines.push(``, `This span has no attributes recorded.`)
			}

			lines.push(
				formatNextSteps([
					`\`inspect_trace trace_id="${trace_id}"\` — see the full span tree`,
					`\`search_logs trace_id="${trace_id}" span_id="${span_id}"\` — logs for this span`,
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "inspect_span",
					data: {
						traceId: trace_id,
						spanId: span_id,
						found: result.found,
						attributes: result.spanAttributes,
						resourceAttributes: result.resourceAttributes,
					},
				}),
			}
		}),
	)
}
