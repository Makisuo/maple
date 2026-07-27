import type { InvestigationContext, InvestigationKind } from "./investigation-context"
import type { WidgetFixContext } from "./widget-fix-context"
import type { AutoContext, PageContextPayload } from "./auto-contexts"

/**
 * Per-conversation context (alert / widget-fix / page) delivery for the Flue
 * chat backend.
 *
 * The legacy chat agent received this context out-of-band in the request `body`
 * and merged it into the system prompt. Flue's `agents.send` carries only a
 * message string, so we fold the same structured blocks into a preamble on the
 * conversation's FIRST message instead. The blocks are wrapped in sentinel
 * markers so the renderer can strip them from the user's visible bubble while
 * the model still receives them (see {@link wrapContextPreamble} /
 * {@link stripContextPreamble}).
 *
 * The formatters below are ported verbatim from the legacy agent so the model
 * sees an identical context shape.
 */

export interface ChatContext {
	mode?: "widget-fix" | "investigation"
	investigationContext?: InvestigationContext
	widgetFixContext?: WidgetFixContext
	pageContext?: PageContextPayload
}

const CONTEXT_OPEN = "<!--maple:context-->"
const CONTEXT_CLOSE = "<!--/maple:context-->"

/** Prepend a context block to a user message, fenced by strip-able sentinels. */
export const wrapContextPreamble = (block: string, userText: string): string =>
	`${CONTEXT_OPEN}\n${block}\n${CONTEXT_CLOSE}\n\n${userText}`

/** Remove a leading context block (if present) so the user's bubble stays clean. */
export const stripContextPreamble = (text: string): string => {
	const start = text.indexOf(CONTEXT_OPEN)
	if (start !== 0) return text
	const end = text.indexOf(CONTEXT_CLOSE)
	if (end === -1) return text
	return text.slice(end + CONTEXT_CLOSE.length).replace(/^\s+/, "")
}

/** Build the context block for a conversation, or "" when there's nothing to attach. */
export const buildContextPreamble = (ctx: ChatContext): string => {
	if (ctx.mode === "investigation" && ctx.investigationContext) {
		return formatInvestigationContextBlock(ctx.investigationContext).trim()
	}
	if (ctx.mode === "widget-fix" && ctx.widgetFixContext) {
		return formatWidgetFixContextBlock(ctx.widgetFixContext).trim()
	}
	if (ctx.mode !== "widget-fix" && ctx.pageContext && ctx.pageContext.contexts.length > 0) {
		return formatPageContextBlock(ctx.pageContext).trim()
	}
	return ""
}

// ---------------------------------------------------------------------------
// Formatters (ported from apps/chat-agent/src/index.ts)
// ---------------------------------------------------------------------------

const formatAutoContextLine = (ctx: AutoContext): string => {
	switch (ctx.kind) {
		case "service":
			return `- service: ${ctx.serviceName}`
		case "trace":
			return `- trace: ${ctx.traceId}`
		case "dashboard":
			return ctx.widgetId
				? `- dashboard: ${ctx.dashboardId} (widget: ${ctx.widgetId})`
				: `- dashboard: ${ctx.dashboardId}`
		case "error_type":
			return `- error_type: ${ctx.errorType}`
		case "error_issue":
			return `- error_issue: ${ctx.issueId}`
		case "alert_rule":
			return `- alert_rule: ${ctx.ruleId}`
		case "host":
			return `- host: ${ctx.hostName}`
		case "logs_explorer":
			return "- view: logs explorer"
		case "metrics_explorer":
			return "- view: metrics explorer"
		case "traces_explorer":
			return "- view: traces explorer"
		case "service_map":
			return "- view: service map"
	}
}

const formatPageContextBlock = (payload: PageContextPayload): string => {
	if (payload.contexts.length === 0) return ""
	const lines = [
		"",
		"## Current Page Context",
		'The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says "this", "here", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what\'s listed below.',
		"",
		`page: ${payload.pathname}`,
		...payload.contexts.map(formatAutoContextLine),
	]
	return lines.join("\n")
}

const SIGNAL_TOOL_HINTS: Record<string, string> = {
	error_rate:
		"- Prefer `find_errors` and `list_error_issues` for the affected service.\n- Use `search_logs` to surface exception messages in the alert window.",
	p95_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	p99_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	apdex: "- Investigate both latency and errors: `find_slow_traces`, `find_errors`, and `get_service_top_operations`.",
	throughput:
		"- Use `compare_periods` to contrast the alert window against the prior equivalent window.\n- `service_map` can reveal upstream dependencies that dropped or surged.",
	metric: "- Use `query_data` or `inspect_chart_data` to pull the raw metric values across the window.",
}

const formatWidgetFixContextBlock = (ctx: WidgetFixContext): string => {
	const lines = [
		"",
		"## Broken Widget — Propose a Fix",
		"The user is on a dashboard with a widget that is failing schema validation. The full widget JSON and the validation error are attached. Diagnose what is wrong with the widget config, then call `update_dashboard_widget` with a corrected `widget_json`.",
		"",
		`dashboard_id: ${ctx.dashboardId}`,
		`widget_id: ${ctx.widgetId}`,
		`widget_title: ${JSON.stringify(ctx.widgetTitle)}`,
		"",
		"### Validation error",
		ctx.errorTitle ? `- ${ctx.errorTitle}` : "- (no title)",
		ctx.errorMessage ? `- ${ctx.errorMessage}` : "- (no message)",
		"",
		"### Current widget config",
		"```json",
		ctx.widgetJson,
		"```",
		"",
		"### Fix-mode rules",
		"- Treat the widget JSON as the single source of truth. Modify only what the validation error requires.",
		"- Do NOT change `id`, `layout`, or `visualization` unless the schema error explicitly requires it.",
		"- Preserve `display.title` and other display config that is not implicated by the error.",
		"- Call `update_dashboard_widget` with `dashboard_id`, `widget_id`, and a complete corrected `widget_json` (full widget object as a JSON string).",
		"- Maple renders an approval card for `update_dashboard_widget` automatically — do not narrate the approval step or emit Approve/Deny prose. Just call the tool.",
		"- After the user approves, briefly confirm what changed and why.",
	]
	return lines.join("\n")
}

const KIND_HEADING: Record<InvestigationKind, string> = {
	alert: "Attached Alert",
	anomaly: "Attached Anomaly",
	error: "Attached Error",
	freeform: "Investigation subject",
}

const ERROR_TOOL_HINTS =
	"- Prefer `error_detail`, `find_errors`, and `list_error_issue_events` for this issue.\n- Use `search_logs` and `inspect_trace` on representative occurrences to read stack traces."

const investigationToolHints = (ctx: InvestigationContext): string => {
	if (ctx.kind === "error") return ERROR_TOOL_HINTS
	if (ctx.signalType && SIGNAL_TOOL_HINTS[ctx.signalType]) return SIGNAL_TOOL_HINTS[ctx.signalType]!
	return "- Use `diagnose_service` and `explore_attributes` on the affected service."
}

/** Generic investigation preamble — alert, anomaly, or error, from normalized facts. */
const formatInvestigationContextBlock = (ctx: InvestigationContext): string => {
	const scope = ctx.scope ?? ctx.refs?.serviceName ?? "all"
	const lines = [
		"",
		`## ${KIND_HEADING[ctx.kind]}`,
		`The on-call engineer is investigating ${ctx.kind === "error" ? "an error issue" : ctx.kind === "freeform" ? "a free-form subject" : `a${ctx.kind === "anomaly" ? "n" : ""} ${ctx.kind}`} that is attached to this conversation as structured context. It is pinned above the message thread and stays attached to every message.`,
		"",
		"```yaml",
		`kind: ${ctx.kind}`,
		`id: ${ctx.id}`,
		`title: ${JSON.stringify(ctx.title)}`,
		`severity: ${ctx.severity}`,
		`status: ${ctx.status}`,
		...(ctx.signalType ? [`signal: ${ctx.signalType}`] : []),
		...ctx.facts.map((fact) => `${fact.key}: ${JSON.stringify(fact.value)}`),
		...(ctx.refs?.serviceName ? [`service: ${ctx.refs.serviceName}`] : []),
		...(ctx.refs?.ruleId ? [`rule_id: ${ctx.refs.ruleId}`] : []),
		...(ctx.refs?.detectorKey ? [`detector_key: ${ctx.refs.detectorKey}`] : []),
		...(ctx.refs?.issueId ? [`error_issue_id: ${ctx.refs.issueId}`] : []),
		"```",
		"",
		"### Investigation guidance",
		`- Scope every query to \`${scope}\` unless the engineer explicitly broadens it.`,
		...(ctx.windowMinutes
			? [
					`- Default time range: the ${ctx.windowMinutes}m window ending at the event time, with ~15m of surrounding context. Widen if needed.`,
				]
			: ["- Default time range: the incident's active window with ~15m of surrounding context."]),
		"- Treat the attachment as authoritative — do not ask the engineer to repeat values it already contains.",
		investigationToolHints(ctx),
		"- Prefer existing Maple routes (services, traces, errors, alerts, anomalies) when you recommend links.",
	]

	if (ctx.aiSummary || ctx.aiSuspectedCause) {
		lines.push(
			"",
			"### Prior AI triage",
			"An automated triage pass already ran. Build on it — verify, deepen, or correct it rather than starting from scratch.",
		)
		if (ctx.aiSummary) lines.push(`- summary: ${ctx.aiSummary}`)
		if (ctx.aiSuspectedCause) lines.push(`- suspected_cause: ${ctx.aiSuspectedCause}`)
	}

	return lines.join("\n")
}
