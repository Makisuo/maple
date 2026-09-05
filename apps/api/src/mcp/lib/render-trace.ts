import { Array as Arr, pipe } from "effect"
import type { SpanNode } from "@maple/query-engine/observability"
import { formatDurationFromMs, truncate } from "./format"
import { selectOverviewSpans, type OverviewOptions, type OverviewSelection } from "./span-tree"

export interface TraceOverviewLog {
	readonly timestamp: string
	readonly severityText: string
	readonly serviceName: string
	readonly body: string
	readonly spanId: string
}

export interface TraceOverviewInput {
	readonly traceId: string
	readonly serviceCount: number
	readonly spanCount: number
	readonly rootDurationMs: number
	readonly spans: ReadonlyArray<SpanNode>
	readonly logs: ReadonlyArray<TraceOverviewLog>
	/** Max spans to render before collapsing the rest (see `selectOverviewSpans`). */
	readonly budget: number
	readonly options?: OverviewOptions
}

export interface RenderedTraceOverview {
	readonly lines: string[]
	readonly overview: OverviewSelection
}

/**
 * Render a trace as a bounded markdown span tree (+ related logs). Pure so the
 * exact output — span-id suffixes, the "Showing N of M" note, and `… +K more`
 * collapse markers — is unit-testable without a live warehouse.
 */
export function renderTraceOverview(input: TraceOverviewInput): RenderedTraceOverview {
	const overview = selectOverviewSpans(input.spans, input.budget, input.options)

	const lines: string[] = [
		`## Trace ${input.traceId} (${input.serviceCount} services, ${input.spanCount} spans, ${formatDurationFromMs(input.rootDurationMs)})`,
		``,
	]

	if (overview.truncated) {
		const policy = input.options?.errorsOnly
			? "error spans and their ancestors only"
			: "errors and longest first"
		lines.push(
			`_Showing ${overview.renderedCount} of ${input.spanCount} spans (${policy}). Use \`inspect_span trace_id="${input.traceId}" span_id="…"\` for one span's full attributes, or \`search_traces\` to find more._`,
			``,
		)
	}

	const renderNode = (node: SpanNode, prefix: string, isLast: boolean): void => {
		const connector = prefix === "" ? "" : isLast ? "└── " : "├── "
		const status = node.statusCode === "Error" ? " [Error]" : node.statusCode === "Ok" ? " [Ok]" : ""
		// Full span id at the END of the line: readable label first, copyable id
		// last for `inspect_span` / `search_logs` follow-ups.
		lines.push(
			`${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}  span=${node.spanId}`,
		)
		const detailPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ")
		if (node.statusCode === "Error" && node.statusMessage) {
			lines.push(`${detailPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
		}
		const attrEntries = Object.entries(node.attributes)
		if (attrEntries.length > 0) {
			const attrStr = pipe(
				attrEntries,
				Arr.take(5),
				Arr.map(([k, v]) => `${k}=${truncate(String(v), 60)}`),
			).join(", ")
			lines.push(`${detailPrefix}    {${attrStr}}`)
		}
		const resAttrEntries = Object.entries(node.resourceAttributes)
		if (resAttrEntries.length > 0) {
			const resAttrStr = pipe(
				resAttrEntries,
				Arr.take(5),
				Arr.map(([k, v]) => `${k}=${truncate(String(v), 60)}`),
			).join(", ")
			lines.push(`${detailPrefix}    resource: {${resAttrStr}}`)
		}
		const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ")
		const omitted = overview.omittedByParent.get(node.spanId as string)
		Arr.forEach(node.children, (child, i) => {
			const lastChild = i === node.children.length - 1 && !omitted
			renderNode(child, childPrefix, lastChild)
		})
		if (omitted) {
			const omittedConnector = childPrefix === "" ? "" : "└── "
			const label = omitted.count === 1 ? "span" : "spans"
			lines.push(
				`${childPrefix}${omittedConnector}… +${omitted.count} more ${label} (${formatDurationFromMs(omitted.totalDurationMs)} total)`,
			)
		}
	}

	Arr.forEach(overview.roots, (root) => renderNode(root, "", true))

	if (input.logs.length > 0) {
		lines.push(``, `Related Logs (${input.logs.length}):`)
		Arr.forEach(input.logs, (log) => {
			const time = log.timestamp.split(" ")[1] ?? log.timestamp
			const sevUpper = log.severityText.toUpperCase()
			const marker = sevUpper === "ERROR" || sevUpper === "FATAL" ? "●" : " "
			const sev = log.severityText.padEnd(5)
			const spanRef = log.spanId ? ` span:${log.spanId.slice(0, 8)}` : ""
			lines.push(`${marker} ${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 100)}${spanRef}`)
		})
	}

	return { lines, overview }
}
