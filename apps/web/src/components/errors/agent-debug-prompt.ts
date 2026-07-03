import type { ErrorIssueDocument } from "@maple/domain/http"

export interface AgentDebugPromptInput {
	/** Stable error identity — the input to the `error_detail` MCP tool. */
	fingerprintHash: string
	/** Human-readable error label (exception type / grouped label). */
	label: string
	/** Triage issue UUID — enables the claim_error_issue / propose_fix steps. Absent on the legacy errors-by-type page. */
	issueId?: string | null
	serviceName?: string | null
	/** Exception / sample message. */
	message?: string | null
	/** Top stack frame, when available. */
	topFrame?: string | null
	occurrenceCount?: number | null
	affectedServicesCount?: number | null
	/** First/last seen — pass an ISO string; rendered verbatim. */
	firstSeen?: string | null
	lastSeen?: string | null
}

/**
 * Build a ready-to-paste prompt that drives an MCP-connected coding agent
 * (Claude Code, Cursor, …) to debug a specific Maple error using the Maple MCP
 * tools. Mirrors the "Copy as prompt" pattern in the span detail panel, but
 * tailored to the error-debugging tool flow (`error_detail`, `inspect_trace`,
 * `search_logs`, and — when an issue id is present — `claim_error_issue` /
 * `propose_fix`).
 */
export function formatAgentDebugPrompt(input: AgentDebugPromptInput): string {
	const {
		fingerprintHash,
		label,
		issueId,
		serviceName,
		message,
		topFrame,
		occurrenceCount,
		affectedServicesCount,
		firstSeen,
		lastSeen,
	} = input

	const lines: string[] = [
		"I'm debugging a production error captured by Maple. You have the Maple MCP server connected — use its tools to investigate the root cause and propose a fix.",
		"",
		`**Error:** ${label}${serviceName ? ` in ${serviceName}` : ""}`,
		`**Maple fingerprint:** ${fingerprintHash}`,
	]

	if (issueId) {
		lines.push(`**Maple issue ID:** ${issueId}`)
	}

	if (typeof occurrenceCount === "number") {
		const seen =
			firstSeen && lastSeen ? ` (first seen ${firstSeen}, last seen ${lastSeen})` : ""
		const across =
			typeof affectedServicesCount === "number" && affectedServicesCount > 1
				? ` across ${affectedServicesCount} services`
				: ""
		lines.push(`**Occurrences:** ${occurrenceCount.toLocaleString()}${across}${seen}`)
	}

	if (message) {
		lines.push("", "**Message:**", "```", message, "```")
	}

	if (topFrame) {
		lines.push("", "**Top stack frame:**", "```", topFrame, "```")
	}

	const steps: string[] = [
		`1. Call \`error_detail\` with fingerprint "${fingerprintHash}" to pull sample traces, the full stack trace, and the error trend over time.`,
		"2. Use `inspect_trace` on one of the sample traces and `search_logs` to gather surrounding context and confirm the failure path.",
		"3. Locate the responsible code in this repository, then explain the root cause.",
		"4. Propose a concrete fix (a code change).",
	]

	if (issueId) {
		steps.push(
			`5. Optionally claim the issue first with \`claim_error_issue\` (issue_id "${issueId}"), and once you have a patch, record it with \`propose_fix\` (issue_id "${issueId}").`,
		)
	}

	lines.push("", "Please:", ...steps, "", "Start by calling error_detail.")

	return lines.join("\n")
}

/** Adapter for the error-issue surfaces (list context menu + detail header). */
export function agentPromptFromIssue(issue: ErrorIssueDocument): string {
	return formatAgentDebugPrompt({
		fingerprintHash: issue.fingerprintHash,
		label: issue.exceptionType || issue.errorLabel || "Unknown error",
		issueId: issue.id,
		serviceName: issue.serviceName,
		message: issue.exceptionMessage,
		topFrame: issue.topFrame,
		occurrenceCount: issue.occurrenceCount,
		firstSeen: issue.firstSeenAt,
		lastSeen: issue.lastSeenAt,
	})
}
