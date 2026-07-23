import type { ToolDefinition } from "@flue/runtime"
import { baseToolName } from "./mcp.ts"

/**
 * Mutating Maple tools (base names). The legacy chat agent gated these with
 * `@cloudflare/ai-chat`'s approval interrupt — Flue's event stream has no
 * human-in-the-loop interrupt, so we use **propose-then-apply** instead: the
 * agent calls the tool, but its `execute` returns a proposal marker WITHOUT
 * performing the mutation. The web client renders an approval card from that
 * result and performs the real mutation (via Maple's existing API) on approve.
 *
 * Keep in sync — three mirrored copies, no shared import:
 *   - apps/api/src/mcp/tools/mutating.ts (the source of truth)
 *   - apps/chat-flue/src/lib/approval.ts (this file)
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

/** Marker an approval-gated tool returns instead of mutating. */
export interface ToolProposal {
	status: "proposed"
	tool: string
	input: unknown
}

export const PROPOSAL_STATUS = "proposed" as const

/** Parse a tool result string back into a {@link ToolProposal}, or `null`. */
export const parseToolProposal = (result: string): ToolProposal | null => {
	try {
		const parsed = JSON.parse(result) as Partial<ToolProposal>
		return parsed?.status === PROPOSAL_STATUS && typeof parsed.tool === "string"
			? { status: PROPOSAL_STATUS, tool: parsed.tool, input: parsed.input }
			: null
	} catch {
		return null
	}
}

/**
 * Swap the `execute` of every mutating tool for one that returns a proposal
 * marker (no side effect). Read-only tools pass through unchanged. The tool's
 * name, description, and parameter schema are preserved so the model calls it
 * exactly as it would the real tool.
 */
export const applyApprovalGates = (tools: readonly ToolDefinition[]): ToolDefinition[] =>
	tools.map((tool) => {
		if (!MUTATING_TOOL_NAMES.has(baseToolName(tool.name))) return tool
		return {
			...tool,
			description: `${tool.description}\n\nThis is an approval-gated action: calling it proposes the change for the user to approve; it does NOT take effect until approved. Call it once with the intended arguments and stop.`,
			execute: async (args) =>
				JSON.stringify({
					status: PROPOSAL_STATUS,
					tool: baseToolName(tool.name),
					input: args,
				} satisfies ToolProposal),
		}
	})
