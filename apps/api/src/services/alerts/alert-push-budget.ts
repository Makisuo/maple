import type { AlertSeverity, OrgId } from "@maple/domain/http"
import { Effect, Ref } from "effect"

/**
 * How many phone notifications one tick of the scheduler may send, and how
 * many of those any single rule may claim.
 *
 * Two different storms, two different limits. The tick-wide budget bounds the
 * wall time the tick can spend inside APNs (the send is awaited, so a slow
 * fan-out delays every other rule that minute). The per-rule share bounds what
 * a *person* receives: a grouped rule that breaks across forty services opens
 * forty incidents in one evaluation, and without this each of them is its own
 * banner on every phone in the organization — the single worst notification
 * experience the product can produce, and one nobody can fix from a phone
 * anyway.
 *
 * Past its share a rule's remaining incidents are counted rather than sent,
 * and the tick closes with one digest push per rule saying how many there
 * were. Three is deliberately small: the first few name the services that
 * broke, which is the part a human acts on; the rest are a number.
 */
const PUSHES_PER_TICK = 25
const PUSHES_PER_RULE_PER_TICK = 3

/** What a rule's held-back incidents become: one push, sent after the tick. */
export interface SuppressedRulePushes {
	readonly orgId: OrgId
	readonly ruleId: string
	readonly ruleName: string
	readonly severity: AlertSeverity
	readonly suppressed: number
	readonly linkUrl: string
}

export interface IncidentPushClaim {
	readonly orgId: OrgId
	readonly ruleId: string
	readonly ruleName: string
	readonly severity: AlertSeverity
	readonly linkUrl: string
	/**
	 * Only a firing event spends the rule's share. A resolve is still bounded by
	 * the tick-wide budget — it is an awaited APNs send like any other — but it
	 * can never be folded into the digest, because a digest counts what is
	 * breaking and a held-back resolve would leave the alarm it cancels standing
	 * as the last word on the phone.
	 */
	readonly kind: "firing" | "resolve"
}

export interface IncidentPushBudget {
	/** True when this incident may push. False records it for the digest. */
	readonly claim: (incident: IncidentPushClaim) => Effect.Effect<boolean>
	/** The rules that went over their share, once the tick's rules are done. */
	readonly suppressed: Effect.Effect<ReadonlyArray<SuppressedRulePushes>>
}

interface RuleTally {
	readonly claimed: number
	readonly suppressed: number
	readonly incident: IncidentPushClaim
}

interface BudgetState {
	readonly remaining: number
	readonly rules: ReadonlyMap<string, RuleTally>
}

/**
 * A fresh budget for one scheduler tick.
 *
 * Ref-backed rather than a mutable closure: rules are evaluated under a
 * concurrent `forEach`, so both counters are written from several fibers.
 */
export const makeIncidentPushBudget: Effect.Effect<IncidentPushBudget> = Effect.map(
	Ref.make<BudgetState>({ remaining: PUSHES_PER_TICK, rules: new Map() }),
	(state) => ({
		claim: (incident) =>
			Ref.modify(state, (current): [boolean, BudgetState] => {
				const tally = current.rules.get(incident.ruleId)
				const claimed = tally?.claimed ?? 0
				const firing = incident.kind === "firing"
				const allowed = current.remaining > 0 && (!firing || claimed < PUSHES_PER_RULE_PER_TICK)
				const rules = new Map(current.rules)
				rules.set(incident.ruleId, {
					claimed: allowed && firing ? claimed + 1 : claimed,
					suppressed: (tally?.suppressed ?? 0) + (allowed || !firing ? 0 : 1),
					incident,
				})
				return [allowed, { remaining: allowed ? current.remaining - 1 : current.remaining, rules }]
			}),
		suppressed: Effect.map(Ref.get(state), (current) =>
			[...current.rules.values()].flatMap((tally) =>
				tally.suppressed === 0
					? []
					: [
							{
								orgId: tally.incident.orgId,
								ruleId: tally.incident.ruleId,
								ruleName: tally.incident.ruleName,
								severity: tally.incident.severity,
								suppressed: tally.suppressed,
								linkUrl: tally.incident.linkUrl,
							},
						],
			),
		),
	}),
)
