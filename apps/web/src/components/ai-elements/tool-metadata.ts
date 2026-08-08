import {
	AlertWarningIcon,
	BellIcon,
	BoltIcon,
	ChartBarIcon,
	ChartBarTrendUpIcon,
	ChartLineIcon,
	ChatBubbleSparkleIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	ClockIcon,
	CodeIcon,
	DatabaseIcon,
	FireIcon,
	GridIcon,
	GridSquareCirclePlusIcon,
	HistoryIcon,
	IdBadgeIcon,
	MagnifierIcon,
	NetworkNodesIcon,
	PencilIcon,
	PulseIcon,
	ServerIcon,
	SlidersIcon,
	TagIcon,
	TrashIcon,
} from "@/components/icons"
import type { OrbState } from "@maple/thinking-orbs"
import type { IconComponent } from "@/components/icons"

/**
 * Tools arrive from the Maple MCP server namespaced (`mcp__maple__list_services`).
 * Strip the `mcp__<server>__` prefix so the label/icon lookups (and any builtin
 * sandbox tools like `read`/`bash`) resolve to bare names.
 */
export function normalizeToolName(toolName: string): string {
	return toolName.replace(/^mcp__.+?__/, "")
}

/** snake_case → "Title Case" fallback for any tool we don't have an explicit label for. */
function humanize(toolName: string): string {
	return toolName
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")
}

/** Friendly label for a (possibly namespaced) tool name, with a humanized fallback. */
export function toolLabel(toolName: string): string {
	const name = normalizeToolName(toolName)
	return toolLabels[name] ?? humanize(name)
}

/** Icon for a (possibly namespaced) tool name, defaulting to a generic code glyph. */
export function toolIcon(toolName: string): IconComponent {
	return toolIcons[normalizeToolName(toolName)] ?? CodeIcon
}

/**
 * Orb animation for a (possibly namespaced) tool name.
 *
 * The mapping is deliberately coarse — four buckets over ~50 tools. The point is that a glance
 * at the orb tells you what *kind* of work is in flight (sweeping data vs. crunching a query vs.
 * walking the topology), not that every tool gets its own animation. Anything unmapped falls
 * back to `working`, which is also the right read for the write/mutate tools.
 */
export function toolOrbState(toolName: string): OrbState {
	return toolOrbStates[normalizeToolName(toolName)] ?? "working"
}

const toolLabels: Record<string, string> = {
	// observability / diagnostics
	system_health: "System Health",
	diagnose_service: "Diagnose Service",
	list_services: "List Services",
	service_map: "Service Map",
	get_service_top_operations: "Top Operations",
	explore_attributes: "Explore Attributes",
	describe_warehouse_tables: "Describe Tables",
	get_instrumentation_recommendations: "Instrumentation Tips",
	// traces
	search_traces: "Search Traces",
	find_slow_traces: "Find Slow Traces",
	inspect_trace: "Inspect Trace",
	inspect_span: "Inspect Span",
	// logs
	search_logs: "Search Logs",
	mine_log_patterns: "Mine Log Patterns",
	// errors
	find_errors: "Find Errors",
	error_detail: "Error Detail",
	list_error_issues: "List Error Issues",
	list_error_incidents: "List Error Incidents",
	list_error_issue_events: "Error Issue Events",
	claim_error_issue: "Claim Issue",
	release_error_issue: "Release Issue",
	transition_error_issue: "Transition Issue",
	comment_on_error_issue: "Comment on Issue",
	set_issue_severity: "Set Issue Severity",
	propose_fix: "Propose Fix",
	// metrics & charts
	list_metrics: "List Metrics",
	query_data: "Query Data",
	inspect_chart_data: "Inspect Chart Data",
	compare_periods: "Compare Periods",
	// dashboards
	list_dashboards: "List Dashboards",
	get_dashboard: "Get Dashboard",
	create_dashboard: "Create Dashboard",
	update_dashboard: "Update Dashboard",
	add_dashboard_widget: "Add Widget",
	update_dashboard_widget: "Update Widget",
	remove_dashboard_widget: "Remove Widget",
	reorder_dashboard_widgets: "Reorder Widgets",
	replace_dashboard_widgets: "Replace Widgets",
	// alerts & incidents
	list_alert_rules: "List Alert Rules",
	get_alert_rule: "Get Alert Rule",
	create_alert_rule: "Create Alert Rule",
	update_alert_rule: "Update Alert Rule",
	delete_alert_rule: "Delete Alert Rule",
	list_alert_incidents: "List Alert Incidents",
	list_alert_checks: "List Alert Checks",
	get_incident_timeline: "Incident Timeline",
	update_error_notification_policy: "Notification Policy",
	// sessions
	search_sessions: "Search Sessions",
	get_session_traces: "Session Traces",
	get_session_transcript: "Session Transcript",
	// misc
	register_agent: "Register Agent",
	get_event: "Get Event",
}

const toolIcons: Record<string, IconComponent> = {
	system_health: PulseIcon,
	diagnose_service: PulseIcon,
	list_services: ServerIcon,
	service_map: NetworkNodesIcon,
	get_service_top_operations: ChartBarTrendUpIcon,
	explore_attributes: TagIcon,
	describe_warehouse_tables: DatabaseIcon,
	get_instrumentation_recommendations: BoltIcon,
	search_traces: NetworkNodesIcon,
	find_slow_traces: ClockIcon,
	inspect_trace: MagnifierIcon,
	inspect_span: MagnifierIcon,
	search_logs: DatabaseIcon,
	mine_log_patterns: DatabaseIcon,
	find_errors: CircleXmarkIcon,
	error_detail: CircleWarningIcon,
	list_error_issues: FireIcon,
	list_error_incidents: FireIcon,
	list_error_issue_events: FireIcon,
	claim_error_issue: FireIcon,
	release_error_issue: FireIcon,
	transition_error_issue: FireIcon,
	comment_on_error_issue: ChatBubbleSparkleIcon,
	set_issue_severity: AlertWarningIcon,
	propose_fix: BoltIcon,
	list_metrics: ChartBarIcon,
	query_data: ChartLineIcon,
	inspect_chart_data: ChartLineIcon,
	compare_periods: ClockIcon,
	list_dashboards: GridIcon,
	get_dashboard: GridIcon,
	create_dashboard: GridSquareCirclePlusIcon,
	update_dashboard: PencilIcon,
	add_dashboard_widget: GridSquareCirclePlusIcon,
	update_dashboard_widget: PencilIcon,
	remove_dashboard_widget: TrashIcon,
	reorder_dashboard_widgets: SlidersIcon,
	replace_dashboard_widgets: GridIcon,
	list_alert_rules: BellIcon,
	get_alert_rule: BellIcon,
	create_alert_rule: BellIcon,
	update_alert_rule: BellIcon,
	delete_alert_rule: TrashIcon,
	list_alert_incidents: AlertWarningIcon,
	list_alert_checks: CircleCheckIcon,
	get_incident_timeline: HistoryIcon,
	update_error_notification_policy: BellIcon,
	search_sessions: HistoryIcon,
	get_session_traces: HistoryIcon,
	get_session_transcript: ChatBubbleSparkleIcon,
	register_agent: IdBadgeIcon,
	get_event: CircleInfoIcon,
}

/**
 * Only the three non-default buckets are listed; everything else resolves to `working` via
 * `toolOrbState`. Keeping the fallback implicit means a new Maple tool doesn't have to be
 * registered here to look right — it just doesn't get a specialised animation.
 */
const toolOrbStates: Record<string, OrbState> = {
	// `searching` — a scan meridian sweeps a dotted globe. Anything that trawls a corpus.
	search_traces: "searching",
	find_slow_traces: "searching",
	search_logs: "searching",
	mine_log_patterns: "searching",
	find_errors: "searching",
	search_sessions: "searching",
	search_source_code: "searching",
	explore_attributes: "searching",
	// `solving` — bands scramble in quarter turns, then click back. Query crunching.
	run_sql: "solving",
	query_data: "solving",
	compare_periods: "solving",
	inspect_chart_data: "solving",
	// `connecting` — a constellation wires itself, packets running the edges. Topology walks.
	service_map: "connecting",
	list_services: "connecting",
	get_service_top_operations: "connecting",
	diagnose_service: "connecting",
	audit_setup: "connecting",
}
