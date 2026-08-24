// The display rules the session page's views have to read the same way: what the
// toolbar's filter hides, what counts as a delegation, and how a model id is
// shortened. The waterfall, the flow view and the toolbar's visible count all
// call these, so a filter typed in one view means the same thing in the other.

import type { AiSessionSpan } from "@maple/domain/http"

import { classifyAiSpan, spanModel } from "./session-turns"

/**
 * The toolbar's filter, applied identically by every view.
 *
 * The query is normalized here rather than at each call site: the count in the
 * toolbar, the waterfall's rows and the flow view's nodes have to agree on what
 * is hidden.
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
 * A handoff: the span names a different agent than its immediate parent does.
 * An agent span under a span of the same agent is a framework step —
 * `invoke_agent` wrapping `agent_step` is one agent, not two.
 *
 * Only the immediate parent is read, so an unnamed span between two agents (an
 * HTTP client span, a wrapper with no `gen_ai.agent.name`) hides the handoff.
 */
export function isDelegation(span: AiSessionSpan, spansById: ReadonlyMap<string, AiSessionSpan>): boolean {
	if (classifyAiSpan(span) !== "agent") return false
	const agentName = span.genAi.agentName
	const parentAgentName = spansById.get(span.parentSpanId)?.genAi.agentName
	return agentName !== undefined && parentAgentName !== undefined && agentName !== parentAgentName
}

/**
 * Last path segment of a model id or tool target.
 *
 * Gateways prefix the provider path ("openrouter/openai/gpt-4o-mini"), which in
 * a 150px column truncates two different models to the same string. The shortened
 * form is lossy — two gateway-prefixed models can collapse onto it — so callers
 * that have room for the full value should show it in a `title`.
 */
export function shortTarget(value: string): string {
	const segment = value.split("/").at(-1)
	return segment === undefined || segment === "" ? value : segment
}
