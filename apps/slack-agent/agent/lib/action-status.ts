/**
 * Typing-indicator phrases for requested actions.
 *
 * Eve's default `actions.requested` handler flashes the raw tool-call label
 * (`maple__list_services`, `grep pattern`) into Slack's typing status. This
 * module replaces that with one plain, descriptive phrase per tool
 * ("Searching traces…"), so the indicator reads like a status bar — not a
 * stack trace, and not a joke.
 *
 * Slack's typing indicator (`assistant.threads.setStatus`) caps at ~100
 * chars and eve trims to 50; every phrase here stays ≤40 so the ` +N more`
 * batch suffix always fits.
 */

/**
 * Structural view of eve's `RuntimeActionRequest` union — just the fields
 * this module reads, so it needs no import from eve internals.
 */
export interface ActionRequestLike {
	readonly kind: string
	readonly toolName?: string
	readonly subagentName?: string
	readonly remoteAgentName?: string
}

/**
 * Exact tool name (connection prefix stripped) → phrase. Maple's MCP tool
 * list is resolved at runtime, so unlisted/new tools fall through to the
 * keyword heuristics below rather than breaking.
 */
const PHRASE_BY_TOOL: Record<string, string> = {
	// Local tools (agent/tools/*).
	bash: "Running a command…",
	glob: "Searching files…",
	grep: "Searching files…",
	read_file: "Reading a file…",
	write_file: "Writing a file…",
	web_search: "Searching the web…",
	web_fetch: "Fetching a page…",
	render_chart: "Rendering a chart…",
	load_skill: "Loading a skill…",
	// Maple MCP tools.
	list_services: "Listing services…",
	service_map: "Mapping service dependencies…",
	diagnose_service: "Diagnosing a service…",
	get_service_top_operations: "Checking top operations…",
	search_traces: "Searching traces…",
	inspect_trace: "Inspecting a trace…",
	inspect_span: "Inspecting a span…",
	find_slow_traces: "Finding slow traces…",
	get_session_traces: "Fetching session traces…",
	search_logs: "Searching logs…",
	mine_log_patterns: "Mining log patterns…",
	find_errors: "Searching errors…",
	error_detail: "Inspecting an error…",
	list_error_issues: "Listing error issues…",
	list_error_issue_events: "Fetching issue events…",
	list_error_incidents: "Listing error incidents…",
	claim_error_issue: "Updating an issue…",
	release_error_issue: "Updating an issue…",
	heartbeat_error_issue: "Updating an issue…",
	comment_on_error_issue: "Commenting on an issue…",
	transition_error_issue: "Updating an issue…",
	set_issue_severity: "Updating issue severity…",
	get_incident_timeline: "Fetching the incident timeline…",
	list_dashboards: "Listing dashboards…",
	get_dashboard: "Fetching a dashboard…",
	create_dashboard: "Creating a dashboard…",
	update_dashboard: "Updating a dashboard…",
	add_dashboard_widget: "Adding a widget…",
	update_dashboard_widget: "Updating a widget…",
	remove_dashboard_widget: "Removing a widget…",
	reorder_dashboard_widgets: "Reordering widgets…",
	replace_dashboard_widgets: "Updating widgets…",
	inspect_chart_data: "Inspecting chart data…",
	list_alert_rules: "Listing alert rules…",
	get_alert_rule: "Fetching an alert rule…",
	create_alert_rule: "Creating an alert rule…",
	update_alert_rule: "Updating an alert rule…",
	delete_alert_rule: "Deleting an alert rule…",
	list_alert_checks: "Listing alert checks…",
	list_alert_incidents: "Listing alert incidents…",
	update_error_notification_policy: "Updating notification policy…",
	list_metrics: "Listing metrics…",
	query_data: "Querying the warehouse…",
	run_sql: "Running a SQL query…",
	describe_warehouse_tables: "Inspecting warehouse tables…",
	compare_periods: "Comparing time periods…",
	explore_attributes: "Exploring attributes…",
	search_source_code: "Searching source code…",
	read_source_file: "Reading source code…",
	list_source_repositories: "Listing repositories…",
	propose_fix: "Drafting a fix…",
	search_sessions: "Searching sessions…",
	get_session_transcript: "Reading a session transcript…",
}

/** Keyword fallbacks for tools not in {@link PHRASE_BY_TOOL}, checked in order. */
const PHRASE_BY_KEYWORD: readonly (readonly [string, string])[] = [
	["trace", "Looking at traces…"],
	["span", "Looking at traces…"],
	["log", "Searching logs…"],
	["error", "Looking at errors…"],
	["issue", "Looking at errors…"],
	["incident", "Looking at incidents…"],
	["dashboard", "Working on dashboards…"],
	["widget", "Working on dashboards…"],
	["chart", "Rendering a chart…"],
	["alert", "Checking alerts…"],
	["metric", "Checking metrics…"],
	["sql", "Querying the warehouse…"],
	["query", "Querying the warehouse…"],
	["warehouse", "Querying the warehouse…"],
	["source", "Reading source code…"],
	["service", "Checking services…"],
	["session", "Looking at sessions…"],
	["search", "Searching…"],
	["file", "Reading files…"],
]

const DELEGATE = "Delegating a task…"
const SKILL = "Loading a skill…"
const MAPLE_GENERIC = "Querying Maple…"
const GENERIC = "Working…"

/** `maple__list_services` → `list_services`; unprefixed names pass through. */
function stripConnectionPrefix(toolName: string): string {
	const separator = toolName.lastIndexOf("__")
	return separator === -1 ? toolName : toolName.slice(separator + 2)
}

function phraseForAction(action: ActionRequestLike): string {
	if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return DELEGATE
	if (action.kind === "load-skill") return SKILL
	if (action.kind !== "tool-call" || !action.toolName) return GENERIC

	const name = stripConnectionPrefix(action.toolName).toLowerCase()
	const exact = PHRASE_BY_TOOL[name]
	if (exact) return exact

	for (const [keyword, phrase] of PHRASE_BY_KEYWORD) if (name.includes(keyword)) return phrase

	// Unknown maple tool: still telemetry-flavored rather than fully generic.
	if (action.toolName.startsWith("maple__")) return MAPLE_GENERIC
	return GENERIC
}

/** Matches eve's `SLACK_TYPING_STATUS_MAX_LENGTH`. */
const TYPING_STATUS_MAX_LENGTH = 50

/**
 * Caps arbitrary text (e.g. the model's own pre-tool-call narration) to
 * Slack's typing-status budget, mirroring eve's `truncateTypingStatus`
 * (which the package doesn't export).
 */
export function truncateTypingStatus(text: string): string {
	return text.length <= TYPING_STATUS_MAX_LENGTH ? text : `${text.slice(0, TYPING_STATUS_MAX_LENGTH - 1)}…`
}

/**
 * Typing-status text for one requested action batch: the first action's
 * phrase, plus `+N more` when the model requested several actions at once.
 */
export function describeActions(actions: readonly ActionRequestLike[]): string {
	const [first] = actions
	if (first === undefined) return "Working…"
	const phrase = phraseForAction(first)
	const status = actions.length === 1 ? phrase : `${phrase} +${actions.length - 1} more`
	return status.length <= TYPING_STATUS_MAX_LENGTH
		? status
		: `${status.slice(0, TYPING_STATUS_MAX_LENGTH - 1)}…`
}
