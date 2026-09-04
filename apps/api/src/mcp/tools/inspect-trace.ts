import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
} from "./types"
import { clampLimit } from "@/mcp/lib/limits"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor } from "@/mcp/lib/query-warehouse"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { renderTraceOverview } from "@/mcp/lib/render-trace"
import { inspectTrace, type SpanNode } from "@maple/query-engine/observability"

/**
 * Render budget for a single trace overview. Traces can hold thousands of spans
 * (the SQL caps at 5_000); dumping all of them blows up the agent context.
 * `selectOverviewSpans` keeps errors, roots and the longest/structural spans up
 * to this budget — deeper inspection goes through `inspect_span` / `search_traces`.
 */
const MAX_OVERVIEW_SPANS = 100
/** Hard ceiling for `max_spans`; past this a single response stops being readable. */
const MAX_OVERVIEW_SPANS_CEILING = 300

export function registerInspectTraceTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_trace",
		"Get the span tree and logs for a single trace. Use this to understand request flow, find bottlenecks, and see error context. Large traces are bounded to an overview (errors and longest spans first); use `inspect_span` for one span's full attributes. Pass `timestamp` (any timestamp from the trace) so the query can prune ClickHouse partitions to a ±1h window. Without `timestamp` only the last 24h is scanned — pass `timestamp` for older traces.",
		Schema.Struct({
			trace_id: requiredStringParam("The trace ID to inspect"),
			timestamp: optionalStringParam(
				"ISO-8601 timestamp of any span in the trace (e.g. from `search_traces` results). Used to narrow the ClickHouse scan to a ±1h window — required for traces older than 24h, strongly recommended otherwise.",
			),
			errors_only: optionalBooleanParam(
				"Render only error spans, their ancestors and the roots — the fastest way to read a large trace's failure without its healthy spans.",
			),
			max_spans: optionalNumberParam(
				`Spans to render before collapsing the rest (default ${MAX_OVERVIEW_SPANS}, max ${MAX_OVERVIEW_SPANS_CEILING}). Errors and roots are always kept.`,
			),
		}),
		Effect.fn("McpTool.inspectTrace")(function* ({ trace_id, timestamp, errors_only, max_spans }) {
			yield* Effect.annotateCurrentSpan("traceId", trace_id)
			const budget = clampLimit(max_spans, {
				defaultValue: MAX_OVERVIEW_SPANS,
				max: MAX_OVERVIEW_SPANS_CEILING,
			})
			const options = { errorsOnly: errors_only === true }

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

			const result = yield* withTenantExecutor(inspectTrace(trace_id, { timestampHint })).pipe(
				Effect.catchTags(warehouseToMcpHandlers("span_hierarchy")),
			)

			if (result.spanCount === 0) {
				const hint = timestampHint
					? ""
					: ` (scanned last 24h). If this trace is older, pass timestamp=<ISO-8601> from \`search_traces\` results.`
				return {
					content: [{ type: "text" as const, text: `No spans found for trace ${trace_id}${hint}` }],
				}
			}

			const { lines, overview } = renderTraceOverview({
				traceId: trace_id,
				serviceCount: result.serviceCount,
				spanCount: result.spanCount,
				rootDurationMs: result.rootDurationMs,
				spans: result.spans,
				logs: result.logs,
				budget,
				options,
			})

			yield* Effect.annotateCurrentSpan({
				"result.rowCount": result.spanCount,
				"result.renderedSpanCount": overview.renderedCount,
				"result.errorsOnly": options.errorsOnly,
			})

			const collectServices = (n: SpanNode): string[] => [
				n.serviceName,
				...Arr.flatMap(n.children, collectServices),
			]
			const services = pipe(result.spans, Arr.flatMap(collectServices), Arr.dedupe)

			const nextSteps: string[] = []
			const hasErrors = Arr.some(result.spans, function checkError(n: SpanNode): boolean {
				return n.statusCode === "Error" || Arr.some(n.children, checkError)
			})
			if (hasErrors) {
				nextSteps.push(`\`search_logs trace_id="${trace_id}"\` — see all logs for this trace`)
			}
			Arr.forEach(Arr.take(services, 2), (svc) => {
				nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate this service`)
			})
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "inspect_trace",
					data: {
						traceId: trace_id,
						serviceCount: result.serviceCount,
						spanCount: result.spanCount,
						rootDurationMs: result.rootDurationMs,
						// Structured payload mirrors the rendered overview, not the full
						// (up to 5_000-span) tree — keeps the response bounded.
						spans: [...overview.roots] as any,
						renderedSpanCount: overview.renderedCount,
						totalSpanCount: overview.totalCount,
						truncated: overview.truncated,
						logs: pipe(
							result.logs,
							Arr.map((l) => ({ ...l })),
						),
					},
				}),
			}
		}),
	)
}
