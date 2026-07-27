import { defineTool, type JsonValue, type ToolDefinition } from "@flue/runtime"
import { toJsonValue } from "./json.ts"
import { baseToolName } from "./mcp.ts"

/**
 * Mutating Maple tools (base names). The legacy chat agent gated these with
 * `@cloudflare/ai-chat`'s approval interrupt — Flue's event stream has no
 * human-in-the-loop interrupt, so we use **propose-then-apply** instead: the
 * agent calls the tool, but its `execute` returns a proposal marker WITHOUT
 * performing the mutation. The web client renders an approval card from that
 * result and performs the real mutation (via Maple's existing API) on approve.
 *
 * Keep in sync with the mutating tools in apps/api/src/mcp/tools.
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
export type ToolProposal = {
	status: "proposed"
	tool: string
	input: JsonValue
}

export const PROPOSAL_STATUS = "proposed" as const

/**
 * Parse a tool result back into a {@link ToolProposal}, or `null`.
 *
 * Tool results are structured JSON, so the marker normally arrives as an object.
 * The string arm covers results recorded by an older runtime, whose tools could
 * only return strings — a live conversation must not lose its approval cards
 * when the worker is upgraded underneath it.
 */
export const parseToolProposal = (result: unknown): ToolProposal | null => {
	if (typeof result === "string") {
		try {
			return parseToolProposal(JSON.parse(result))
		} catch {
			return null
		}
	}
	if (result === null || typeof result !== "object") return null
	const marker: Record<string, unknown> = { ...result }
	return marker.status === PROPOSAL_STATUS && typeof marker.tool === "string"
		? { status: PROPOSAL_STATUS, tool: marker.tool, input: toJsonValue(marker.input) }
		: null
}

/**
 * Swap `run` on every mutating tool for one that returns a proposal marker (no
 * side effect). Read-only tools pass through unchanged. The tool's name and
 * parameter schema are preserved so the model calls it exactly as it would the
 * real tool.
 */
export const applyApprovalGates = (tools: readonly ToolDefinition[]): ToolDefinition[] =>
	tools.map((tool) => {
		if (!MUTATING_TOOL_NAMES.has(baseToolName(tool.name))) return tool
		return defineTool({
			name: tool.name,
			description: `${tool.description}\n\nThis is an approval-gated action: calling it proposes the change for the user to approve; it does NOT take effect until approved. Call it once with the intended arguments and stop.`,
			input: tool.input,
			// The real tool's output schema describes the mutation's result, which a
			// proposal never produces — validating against it would reject the marker.
			output: undefined,
			run: (context): ToolProposal => ({
				status: PROPOSAL_STATUS,
				tool: baseToolName(tool.name),
				input: toJsonValue("input" in context ? context.input : undefined),
			}),
		}) as ToolDefinition
	})
