import type { AlertContext } from "./alert-context"

/**
 * Alert context delivery for the Flue chat backend. A Flue send carries only a
 * message string, so the attached-alert context is folded into a
 * preamble on the conversation's FIRST message. Mobile stores the user's plain
 * text locally and only prepends this block to what's sent to the agent, so the
 * preamble never shows in the user's bubble. Ported from the legacy agent's
 * `formatAlertContextBlock` so the model sees an identical context shape.
 */
export const buildAlertPreamble = (alert: AlertContext): string => formatAlertContextBlock(alert).trim()

const formatAlertComparator = (c: string): string => {
	switch (c) {
		case "gt":
			return ">"
		case "gte":
			return ">="
		case "lt":
			return "<"
		case "lte":
			return "<="
		default:
			return c
	}
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

const formatAlertContextBlock = (alert: AlertContext): string => {
	const observedRaw = alert.value === null ? "n/a" : String(alert.value)
	const thresholdExpr = `${formatAlertComparator(alert.comparator)} ${alert.threshold}`
	const toolHints =
		SIGNAL_TOOL_HINTS[alert.signalType] ??
		"- Use `diagnose_service` and `explore_attributes` on the affected service."

	const lines = [
		"## Attached Alert",
		"The on-call engineer is investigating an alert that has been attached to this conversation as structured context. It is visible to them as a pinned card above the message thread, and it remains attached to every message in this thread.",
		"",
		"```yaml",
		`rule_id: ${alert.ruleId}`,
		`rule_name: ${JSON.stringify(alert.ruleName)}`,
		`incident_id: ${alert.incidentId ?? "null"}`,
		`event_type: ${alert.eventType}`,
		`severity: ${alert.severity}`,
		`signal: ${alert.signalType}`,
		`threshold: ${thresholdExpr}`,
		`observed: ${observedRaw}`,
		`sample_count: ${alert.sampleCount ?? "null"}`,
		`window_minutes: ${alert.windowMinutes}`,
		`group_key: ${alert.groupKey === null ? "null" : JSON.stringify(alert.groupKey)}`,
		"```",
		"",
		"### Investigation guidance",
		`- Scope every query to service/group \`${alert.groupKey ?? "all"}\` unless the engineer explicitly broadens it.`,
		`- Default time range: the alert window (${alert.windowMinutes}m ending at the event time) with ~15m of surrounding context. Widen if needed.`,
		`- Treat the attachment as authoritative — do not ask the engineer to repeat values it already contains. Reference the rule by name, not by ID.`,
		toolHints,
		"- If the event is `resolve`, focus on root-cause and prevention rather than immediate mitigation.",
	]
	return lines.join("\n")
}
