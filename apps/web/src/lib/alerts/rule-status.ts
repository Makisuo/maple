import type {
	AlertDeliveryEventDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"

/**
 * Derived health of an alert rule, in display-priority order:
 * disabled → firing → error → stale → no-data → healthy.
 */
export type RuleStatus = "disabled" | "firing" | "error" | "stale" | "no-data" | "healthy"

export interface RuleAttention {
	/** Enabled but routed nowhere — it can fire but nobody gets told. */
	readonly noDestinations: boolean
	/** The most recent delivery attempt for this rule failed. */
	readonly recentDeliveryFailure: boolean
}

export interface DerivedRuleStatus {
	readonly status: RuleStatus
	readonly attention: RuleAttention
	/** Why the status is what it is — one short human sentence. */
	readonly reason: string | null
}

/**
 * A rule counts as stale when it hasn't been evaluated for 3× the larger of
 * its evaluation window and the scheduler cadence (~1 min). Shared with the
 * diagnosis panel so both surfaces agree on "stale".
 */
export const staleThresholdMs = (rule: Pick<AlertRuleDocument, "windowMinutes">): number =>
	3 * Math.max(rule.windowMinutes, 5) * 60_000

const lastEvaluatedMs = (
	rule: AlertRuleDocument,
	states: ReadonlyArray<AlertRuleStateRow>,
): number | null => {
	let latest: number | null =
		rule.lastEvaluatedAt != null ? new Date(rule.lastEvaluatedAt).getTime() : null
	for (const state of states) {
		if (state.last_evaluated_at == null) continue
		const t = new Date(state.last_evaluated_at).getTime()
		if (!Number.isFinite(t)) continue
		if (latest == null || t > latest) latest = t
	}
	return latest
}

/** The state row worth displaying: breached > error > skipped > healthy, latest first. */
export function worstState(states: ReadonlyArray<AlertRuleStateRow>): AlertRuleStateRow | null {
	const rank = (state: AlertRuleStateRow): number => {
		if (state.last_status === "breached") return 3
		if (state.last_error != null) return 2
		if (state.last_status === "skipped") return 1
		return 0
	}
	let best: AlertRuleStateRow | null = null
	for (const state of states) {
		if (best == null) {
			best = state
			continue
		}
		const cmp = rank(state) - rank(best)
		if (cmp > 0) best = state
		else if (cmp === 0) {
			const a = state.last_evaluated_at != null ? new Date(state.last_evaluated_at).getTime() : 0
			const b = best.last_evaluated_at != null ? new Date(best.last_evaluated_at).getTime() : 0
			if (a > b) best = state
		}
	}
	return best
}

/**
 * Derive the display status for a rule from everything the client knows about
 * it: the rule document, its live-synced per-group states (may be empty on
 * non-Electric builds — the derivation then degrades to the rule doc fields),
 * its open incidents, and its recent delivery events (pre-filtered to this
 * rule, newest first — the org-wide listDeliveryEvents order).
 */
export function deriveRuleStatus(input: {
	rule: AlertRuleDocument
	states: ReadonlyArray<AlertRuleStateRow>
	openIncidents: ReadonlyArray<AlertIncidentDocument>
	deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	now: number
}): DerivedRuleStatus {
	const { rule, states, openIncidents, deliveryEvents, now } = input

	const latestDelivery = deliveryEvents[0] ?? null
	const attention: RuleAttention = {
		noDestinations: rule.enabled && rule.destinationIds.length === 0,
		recentDeliveryFailure: latestDelivery?.status === "failed",
	}

	if (!rule.enabled) {
		return { status: "disabled", attention, reason: "Rule is disabled" }
	}

	if (openIncidents.length > 0) {
		return {
			status: "firing",
			attention,
			reason:
				openIncidents.length === 1 ? "1 open incident" : `${openIncidents.length} open incidents`,
		}
	}

	const errorState = states.find((s) => s.last_error != null)
	const errorMessage = errorState?.last_error ?? rule.lastEvaluationError
	if (errorMessage != null) {
		return { status: "error", attention, reason: errorMessage }
	}

	const evaluatedAt = lastEvaluatedMs(rule, states)
	if (evaluatedAt == null || now - evaluatedAt > staleThresholdMs(rule)) {
		return {
			status: "stale",
			attention,
			reason: evaluatedAt == null ? "Never evaluated" : "Not evaluated recently",
		}
	}

	// No data only when we have state rows and ALL of them last skipped —
	// a single skipped group among healthy ones is normal for grouped rules.
	if (states.length > 0 && states.every((s) => s.last_status === "skipped")) {
		return { status: "no-data", attention, reason: "All recent checks were skipped (no data)" }
	}

	return { status: "healthy", attention, reason: null }
}

/** Whether the derived status (or an attention flag) needs the user's eyes. */
export function needsAttention(derived: DerivedRuleStatus): boolean {
	return (
		derived.status === "error" ||
		derived.status === "stale" ||
		derived.status === "no-data" ||
		derived.attention.noDestinations ||
		derived.attention.recentDeliveryFailure
	)
}
