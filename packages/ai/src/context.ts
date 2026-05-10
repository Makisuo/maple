export interface DashboardContext {
	dashboardName: string
	existingWidgets: Array<{ title: string; visualization: string }>
}

export type AutoContext =
	| { kind: "service"; id: string; serviceName: string }
	| { kind: "trace"; id: string; traceId: string }
	| { kind: "dashboard"; id: string; dashboardId: string; widgetId?: string }
	| { kind: "error_type"; id: string; errorType: string }
	| { kind: "error_issue"; id: string; issueId: string }
	| { kind: "alert_rule"; id: string; ruleId: string }
	| { kind: "host"; id: string; hostName: string }
	| { kind: "logs_explorer"; id: string }
	| { kind: "metrics_explorer"; id: string }
	| { kind: "traces_explorer"; id: string }
	| { kind: "service_map"; id: string }

export interface PageContextPayload {
	pathname: string
	contexts: AutoContext[]
}

export interface AlertContext {
	ruleId: string
	ruleName: string
	incidentId: string | null
	eventType: string
	signalType: string
	severity: string
	comparator: string
	threshold: number
	value: number | null
	windowMinutes: number
	groupKey: string | null
	sampleCount: number | null
}

export interface WidgetFixContext {
	dashboardId: string
	widgetId: string
	widgetTitle: string
	widgetJson: string
	errorTitle: string | null
	errorMessage: string | null
}

export interface MapleChatContextInput {
	mode?: string
	dashboardContext?: DashboardContext
	alertContext?: AlertContext
	widgetFixContext?: WidgetFixContext
	pageContext?: PageContextPayload
}

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

export const formatPageContextBlock = (payload: PageContextPayload): string => {
	if (payload.contexts.length === 0) return ""
	return [
		"",
		"## Current Page Context",
		'The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says "this", "here", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what is listed below.',
		"",
		`page: ${payload.pathname}`,
		...payload.contexts.map(formatAutoContextLine),
	].join("\n")
}

const formatAlertComparator = (c: string) => {
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

export const formatAlertContextBlock = (alert: AlertContext): string => {
	const observedRaw = alert.value === null ? "n/a" : String(alert.value)
	const thresholdExpr = `${formatAlertComparator(alert.comparator)} ${alert.threshold}`
	const toolHints =
		SIGNAL_TOOL_HINTS[alert.signalType] ??
		"- Use `diagnose_service` and `explore_attributes` on the affected service."

	return [
		"",
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
		"- Treat the attachment as authoritative — do not ask the engineer to repeat values it already contains. Reference the rule by name, not by ID.",
		toolHints,
		"- When you recommend dashboards or links, prefer existing Maple routes (services, traces, errors, alerts). Use `get_alert_rule`/`list_alert_incidents` if you need deeper rule history.",
		"- If the event is `resolve`, focus on root-cause and prevention rather than immediate mitigation.",
	].join("\n")
}

export const formatWidgetFixContextBlock = (ctx: WidgetFixContext): string =>
	[
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
	].join("\n")

export const withMapleContext = (systemPrompt: string, input: MapleChatContextInput): string => {
	let prompt = systemPrompt
	if (input.mode === "dashboard_builder" && input.dashboardContext) {
		const widgetList =
			input.dashboardContext.existingWidgets.length > 0
				? input.dashboardContext.existingWidgets
						.map((w) => `- "${w.title}" (${w.visualization})`)
						.join("\n")
				: "(none)"
		prompt += `\n\n## Current Dashboard Context\nDashboard: "${input.dashboardContext.dashboardName}"\nExisting widgets:\n${widgetList}`
	}
	if (input.mode === "alert" && input.alertContext) {
		prompt += `\n${formatAlertContextBlock(input.alertContext)}`
	}
	if (input.mode === "widget-fix" && input.widgetFixContext) {
		prompt += `\n${formatWidgetFixContextBlock(input.widgetFixContext)}`
	}
	if (input.pageContext && input.pageContext.contexts.length > 0) {
		prompt += `\n${formatPageContextBlock(input.pageContext)}`
	}
	return prompt
}
