export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"create_dashboard",
	"update_dashboard",
	"add_dashboard_widget",
	"update_dashboard_widget",
	"remove_dashboard_widget",
	"reorder_dashboard_widgets",
	"create_alert_rule",
	"transition_error_issue",
	"claim_error_issue",
	"release_error_issue",
	"comment_on_error_issue",
	"propose_fix",
	"update_error_notification_policy",
])

export const requiresApproval = (toolName: string): boolean => GATED_TOOL_NAMES.has(toolName)
