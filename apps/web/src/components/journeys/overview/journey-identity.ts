import type { JourneyRow } from "./journey-row"
import { formatJourneyClock, pluralize } from "./journeys-format"

// ---------------------------------------------------------------------------
// The identity ladder.
//
// The natural title of a journey is its first user message — and that is exactly
// what privacy modes strip. Each rung down is a real name, never a placeholder,
// and the typeface says which one you're reading: prose sets in the UI face, and
// every inferred fallback sets in mono beside a kind label. No row is ever empty.
// ---------------------------------------------------------------------------

export type JourneyTitleKind = "message" | "workflow" | "agent" | "journey"

export interface JourneyIdentity {
	readonly label: string
	readonly kind: JourneyTitleKind
	/** The small mono word after a fallback label (`workflow`, `agent`, `journey`).
	 *  Absent on a real first message — nothing to qualify. */
	readonly kindLabel?: string
}

export function journeyIdentity(journey: JourneyRow): JourneyIdentity {
	const title = journey.title?.trim()
	if (title) return { label: title, kind: "message" }

	const workflow = journey.workflowName?.trim()
	if (workflow) return { label: workflow, kind: "workflow", kindLabel: "workflow" }

	const agent = journey.agents.find((name) => name.trim() !== "")
	if (agent) return { label: agent, kind: "agent", kindLabel: "agent" }

	return { label: journey.journeyId, kind: "journey", kindLabel: "journey" }
}

/**
 * The second line: who ran it, how much it did, and when.
 *
 * Split into a lead (the agent that owns the journey, at full strength) and the
 * rest (muted), because the agent name is the one part of this line anyone scans
 * for. The lead is dropped when the title above it is already that agent's name.
 */
export interface JourneyMetaLine {
	readonly lead?: string
	readonly rest: string
}

export function journeyMetaLine(
	journey: JourneyRow,
	identity: JourneyIdentity,
	options: { readonly showRedacted: boolean; readonly nowMs?: number },
): JourneyMetaLine {
	const namedAgents = journey.agents.filter((name) => name.trim() !== "")
	const lead = namedAgents[0]
	// Don't repeat the title on the line below it.
	const showLead = lead != null && lead !== identity.label

	const parts: string[] = []
	if (!showLead && namedAgents.length === 0) parts.push("no agent reported")
	if (namedAgents.length > 0) parts.push(pluralize(namedAgents.length, "agent"))
	parts.push(journey.toolCallCount > 0 ? pluralize(journey.toolCallCount, "tool") : "no tools")
	if (journey.status === "error" && journey.errorCount > 0) {
		parts.push(pluralize(journey.errorCount, "error"))
	}
	if (options.showRedacted && journey.contentRedacted) parts.push("content redacted")
	parts.push(
		journey.status === "running" ? "running now" : formatJourneyClock(journey.startTime, options.nowMs),
	)

	const rest = parts.join(" · ")
	return showLead ? { lead, rest: `· ${rest}` } : { rest }
}

/**
 * The served model the row leads with, plus how many others the journey used.
 *
 * A journey can hop models mid-conversation; the list has room for one name, so
 * it shows the first served model and stays honest about the rest with a count.
 */
export interface JourneyModelSummary {
	readonly primary?: string
	readonly overflow: number
	/** All served models, for the title attribute — hovering names the rest. */
	readonly all: ReadonlyArray<string>
	/** A served model differed from the one that was requested — routine with a
	 *  router, and worth knowing before you compare costs. */
	readonly diverged: boolean
	readonly requested: ReadonlyArray<string>
}

export function journeyModels(journey: JourneyRow): JourneyModelSummary {
	const served = journey.models.filter((name) => name.trim() !== "")
	const requested = journey.requestedModels.filter((name) => name.trim() !== "")
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
export function isTruncated(journey: JourneyRow): boolean {
	return journey.finishReasons.includes("length")
}
