/**
 * Base names of the mutating MCP tools that the AI chat gates behind approval.
 *
 * The Flue chat agent wraps these so a model call returns a `proposed` marker
 * instead of mutating (see `apps/chat-flue/src/lib/approval.ts`); the web client
 * applies the real change via `POST /api/chat/apply`, which only accepts tools
 * in this set. The Slack agent gates the same set behind eve's native
 * human-in-the-loop approval (`apps/slack-agent/agent/lib/approval.ts`).
 *
 * Keep in sync — three mirrored copies, no shared import:
 *   - apps/api/src/mcp/tools/mutating.ts (this file, the source of truth)
 *   - apps/chat-flue/src/lib/approval.ts
 *   - apps/slack-agent/agent/lib/approval.ts
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	// dashboards
	"create_dashboard",
	"update_dashboard",
	"add_dashboard_widget",
	"update_dashboard_widget",
	"remove_dashboard_widget",
	"reorder_dashboard_widgets",
	"replace_dashboard_widgets",
	// alerts
	"create_alert_rule",
	"update_alert_rule",
	"delete_alert_rule",
	// error issues
	"claim_error_issue",
	"release_error_issue",
	"transition_error_issue",
	"comment_on_error_issue",
	"heartbeat_error_issue",
	"set_issue_severity",
	"update_error_notification_policy",
	// fixes / agents
	"propose_fix",
	"register_agent",
])
