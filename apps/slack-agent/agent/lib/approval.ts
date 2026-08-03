import type { ApprovalContext, ApprovalStatus } from "eve/tools"

/**
 * Base names of the mutating Maple MCP tools that must pause for human
 * approval before executing.
 *
 * Keep in sync with `apps/api/src/mcp/tools/mutating.ts` (the source of
 * truth) and `apps/api/src/chat/agent.ts`. Mirrored, not imported —
 * this app is outside the bun workspace.
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

/** eve qualifies the Maple connection's tools as `maple__<name>`. */
const MAPLE_TOOL_PREFIX = "maple__"

/** Strips the connection qualifier off a runtime tool name. */
export function baseToolName(toolName: string): string {
	return toolName.startsWith(MAPLE_TOOL_PREFIX) ? toolName.slice(MAPLE_TOOL_PREFIX.length) : toolName
}

/**
 * Approval policy for the Maple MCP connection.
 *
 * - App-principal turns (future schedules/digests — no human in the loop to
 *   answer an approval card) are denied outright for mutating tools: fail
 *   closed, matching chat-flue, which has no unattended mutation path either.
 * - Mutating tools pause for a Slack approve/deny prompt. On approve the
 *   REAL MCP tool executes with the workspace's Maple API key — approval is
 *   consent; the Maple API boundary still enforces authorization.
 * - Everything else (read-only tools, unknown names) runs without a prompt.
 */
export function mapleToolApproval(ctx: ApprovalContext): ApprovalStatus {
	if (!MUTATING_TOOL_NAMES.has(baseToolName(ctx.toolName))) {
		return "not-applicable"
	}

	const auth = ctx.session.auth.current
	if (auth?.authenticator === "app" && auth.principalId === "eve:app" && auth.principalType === "runtime") {
		return {
			type: "denied",
			reason: "Automated turns cannot perform mutations.",
		}
	}

	return "user-approval"
}
