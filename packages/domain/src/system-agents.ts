/**
 * Reserved agent-actor names.
 *
 * Maple writes to the issue audit trail as `type: "agent"` actor rows, one per
 * autonomous subsystem, so `error_issue_events` can attribute a change to the
 * thing that made it. Those names are identities: if an org could register an
 * agent under one of them, its API key would author events indistinguishable
 * from the platform's own.
 *
 * They live in the domain package because both sides need the same list: the
 * API guards registration against all of them, and the web renders these
 * first-party actors with the Maple mark instead of the generic agent glyph.
 */

/** The scheduled errors tick: issue creation, regressions, lease expiry. */
export const SYSTEM_ERRORS_AGENT_NAME = "system-errors-tick"

/** Alert-incident-backed issue creation in the issue hub. */
export const SYSTEM_ALERTS_AGENT_NAME = "system-alerts"

/** AI triage: severity assessments and `ai_triage` timeline events. */
export const TRIAGE_AGENT_NAME = "maple-triage-agent"

/** Auto-resolve: closes verified-resolved incidents and their issues. */
export const RESOLUTION_AGENT_NAME = "maple-resolution-agent"

export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
	SYSTEM_ERRORS_AGENT_NAME,
	SYSTEM_ALERTS_AGENT_NAME,
	TRIAGE_AGENT_NAME,
	RESOLUTION_AGENT_NAME,
])

export const isReservedAgentName = (name: string): boolean => RESERVED_AGENT_NAMES.has(name)

const INTERNAL_AGENT_LABELS = new Map<string, string>([
	[SYSTEM_ERRORS_AGENT_NAME, "Maple Errors"],
	[SYSTEM_ALERTS_AGENT_NAME, "Maple Alerts"],
	[TRIAGE_AGENT_NAME, "Maple Triage"],
	[RESOLUTION_AGENT_NAME, "Maple Resolution"],
])

/**
 * Human-facing label for a first-party agent, or `null` when the name is not
 * one of Maple's own — the raw agent name stays authoritative in the audit
 * trail, this is display only.
 */
export const internalAgentLabel = (agentName: string): string | null =>
	INTERNAL_AGENT_LABELS.get(agentName) ?? null
