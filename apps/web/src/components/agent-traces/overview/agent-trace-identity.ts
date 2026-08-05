import type { AgentTraceRow } from "./agent-trace-row"
import { pluralize } from "./agent-traces-format"

// ---------------------------------------------------------------------------
// The identity ladder.
//
// The natural title of an agent trace is its first user message — and that is exactly
// what privacy modes strip. Each rung down is a real name, never a placeholder,
// and the typeface says which one you're reading: prose sets in the UI face, and
// every inferred fallback sets in mono beside a kind label. No row is ever empty.
// ---------------------------------------------------------------------------

export type AgentTraceTitleKind = "message" | "workflow" | "agent" | "agentTrace"

export interface AgentTraceIdentity {
	readonly label: string
	readonly kind: AgentTraceTitleKind
	/** The small mono word after a fallback label (`workflow`, `agent`, `agent trace`).
	 *  Absent on a real first message — nothing to qualify. */
	readonly kindLabel?: string
}

export function agentTraceIdentity(agentTrace: AgentTraceRow): AgentTraceIdentity {
	const title = agentTrace.title?.trim()
	if (title) return { label: title, kind: "message" }

	const workflow = agentTrace.workflowName?.trim()
	if (workflow) return { label: workflow, kind: "workflow", kindLabel: "workflow" }

	const agent = agentTrace.agents.find((name) => name.trim() !== "")
	if (agent) return { label: agent, kind: "agent", kindLabel: "agent" }

	return { label: agentTrace.agentTraceId, kind: "agentTrace", kindLabel: "agent trace" }
}

/**
 * The second line: who ran it, on what, and how much it did.
 *
 * It leads with the agent that owns the agent trace — the one part of this line
 * anyone scans for — dropped when the title above it is already that name. No
 * timestamp: the row's trailing lane carries "when", and repeating it here was
 * one more thing competing for attention in a line that reads as one phrase.
 *
 * Whole-line muted, deliberately. The title is what distinguishes one row from
 * the next; a second line at full strength turns every row into two headlines.
 */
export function agentTraceMetaLine(
	agentTrace: AgentTraceRow,
	identity: AgentTraceIdentity,
	models: AgentTraceModelSummary,
	options: { readonly showRedacted: boolean },
): string {
	const namedAgents = agentTrace.agents.filter((name) => name.trim() !== "")
	const lead = namedAgents[0]
	// Don't repeat the title on the line below it.
	const showLead = lead != null && lead !== identity.label

	const parts: string[] = []
	if (showLead) parts.push(lead)
	if (namedAgents.length === 0) parts.push("no agent reported")
	else if (namedAgents.length > 1) parts.push(pluralize(namedAgents.length, "agent"))
	// The model lost its own column when the header row went; it belongs with the
	// agent anyway — "who ran this, on what" is one thought.
	if (models.primary != null) {
		parts.push(models.overflow > 0 ? `${models.primary} +${models.overflow}` : models.primary)
	}
	parts.push(agentTrace.toolCallCount > 0 ? pluralize(agentTrace.toolCallCount, "tool") : "no tools")
	if (agentTrace.status === "error" && agentTrace.errorCount > 0) {
		parts.push(pluralize(agentTrace.errorCount, "error"))
	}
	if (options.showRedacted && agentTrace.contentRedacted) parts.push("content redacted")

	return parts.join(" · ")
}

/**
 * The served model the row leads with, plus how many others the agent trace used.
 *
 * An agent trace can hop models mid-conversation; the list has room for one name, so
 * it shows the first served model and stays honest about the rest with a count.
 */
export interface AgentTraceModelSummary {
	readonly primary?: string
	readonly overflow: number
	/** All served models, for the title attribute — hovering names the rest. */
	readonly all: ReadonlyArray<string>
	/** A served model differed from the one that was requested — routine with a
	 *  router, and worth knowing before you compare costs. */
	readonly diverged: boolean
	readonly requested: ReadonlyArray<string>
}

export function agentTraceModels(agentTrace: AgentTraceRow): AgentTraceModelSummary {
	const served = agentTrace.models.filter((name) => name.trim() !== "")
	const requested = agentTrace.requestedModels.filter((name) => name.trim() !== "")
	const servedSet = new Set(served)
	return {
		primary: served[0],
		overflow: Math.max(0, served.length - 1),
		all: served,
		diverged: requested.some((name) => !servedSet.has(name)),
		requested,
	}
}

/** A `length` finish reason is a response cut off by a token cap — a silent
 *  failure that otherwise reads as a finished answer. */
export function isTruncated(agentTrace: AgentTraceRow): boolean {
	return agentTrace.finishReasons.includes("length")
}
