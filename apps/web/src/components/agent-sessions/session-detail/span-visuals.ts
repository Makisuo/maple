// The session page's shared vocabulary: one color per kind of work, and the few
// display rules the views have to read the same way. Colors are used by the
// header's breakdown bar, the waterfall's dots and bars, and the flow view's
// nodes; the rules below are shared because the waterfall, the flow view and the
// toolbar count must agree on what a filter hides and what a delegation is.
//
// The colors map onto the app's existing chart tokens rather than new ones —
// agent work is the product's own amber, inference the blue that already means
// "outbound call", tools the teal, and time-to-first-token the purple the charts
// use for a leading segment.

import type { AiSessionSpan } from "@maple/domain/http"
import { classifySpan, spanModel, type SpanCategory } from "@/lib/agent-sessions/session-turns"
import type { OccupancyKind } from "@/lib/agent-sessions/session-summary"

/** Background for a bar or a dot. */
export const CATEGORY_FILL = {
	agent: "bg-chart-1",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	other: "bg-muted-foreground/40",
} satisfies Record<SpanCategory, string>

export const CATEGORY_LABEL = {
	agent: "agent",
	inference: "inference",
	tool: "tool",
	other: "other",
} satisfies Record<SpanCategory, string>

export const OCCUPANCY_FILL = {
	// Idle is the absence of work, so it gets a neutral surface rather than a
	// hue: a colored idle segment reads as a category of work at a glance.
	idle: "bg-muted-foreground/35",
	ttft: "bg-chart-5",
	inference: "bg-chart-2",
	tool: "bg-chart-4",
	// Framework overhead is usually a percent or two of the bar, so it needs more
	// density than idle to survive at that width — the opposite of what its
	// importance suggests, and the reason the two neutrals aren't one token.
	unaccounted: "bg-muted-foreground/50",
} satisfies Record<OccupancyKind, string>

/** The same vocabulary at 6px, where the two neutrals wash out entirely. */
export const OCCUPANCY_DOT_FILL = {
	...OCCUPANCY_FILL,
	idle: "bg-muted-foreground/50",
	unaccounted: "bg-muted-foreground/70",
} satisfies Record<OccupancyKind, string>

export const OCCUPANCY_LABEL = {
	idle: "Idle · awaiting user",
	ttft: "Time to first token",
	inference: "Inference · streaming",
	tool: "Tool execution",
	unaccounted: "Unaccounted",
} satisfies Record<OccupancyKind, string>

/**
 * The toolbar's filter, applied identically by every view.
 *
 * The query is normalized here rather than at each call site: the count in the
 * toolbar, the waterfall's rows and the flow view's nodes have to agree on what
 * is hidden, and a filter typed in one view still applies in the other.
 */
export function filterSpans(
	spans: readonly AiSessionSpan[],
	query: string,
	agentSpansOnly: boolean,
): readonly AiSessionSpan[] {
	const needle = query.trim().toLowerCase()
	return spans.filter((span) => {
		if (agentSpansOnly && !span.isAiSpan) return false
		if (needle === "") return true
		return [span.spanName, spanModel(span), span.genAi.toolName, span.genAi.agentName]
			.filter((value): value is string => value !== undefined)
			.some((value) => value.toLowerCase().includes(needle))
	})
}

/**
 * A real handoff: the span names a different agent than the one that invoked it.
 * An agent span under another agent span is otherwise just a framework step —
 * `invoke_agent` wrapping `agent_step` is one agent, not two.
 */
export function isDelegation(span: AiSessionSpan, spansById: ReadonlyMap<string, AiSessionSpan>): boolean {
	if (classifySpan(span) !== "agent") return false
	const agentName = span.genAi.agentName
	const parentAgentName = spansById.get(span.parentSpanId)?.genAi.agentName
	return agentName !== undefined && parentAgentName !== undefined && agentName !== parentAgentName
}

/**
 * Last path segment of a model id or tool target.
 *
 * Gateways prefix the provider path ("openrouter/openai/gpt-4o-mini"), which in
 * a 150px column truncates two different models to the same string. Callers keep
 * the full value in a `title`.
 */
export function shortTarget(value: string): string {
	const segment = value.split("/").at(-1)
	return segment === undefined || segment === "" ? value : segment
}
