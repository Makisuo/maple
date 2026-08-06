/**
 * Whether an investigation fans out, and how wide.
 *
 * These are two separate questions and they must stay two separate functions.
 * `fanoutSize` is the design's sizing table — how many angles a subject of this
 * shape deserves. `shouldFanOut` is the rollout gate — whether we are willing to
 * spend N+1 model passes on it at all. Collapsing them produces the bug where an
 * automatic medium-severity alert computes a size of 5, fans out zero lenses, and
 * the UI renders a Hypotheses tab over an empty array.
 *
 * Nothing here touches the database or the network: it is a pure decision over
 * the subject, the snapshot and two booleans, which is what makes the whole
 * routing rule testable as a table.
 */

import type {
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	IssueSeverity,
	LensId,
} from "@maple/domain/http"

/**
 * Dispatch order. The fan-out takes the first N, so this order decides *which*
 * lenses a size-2 run gets, not just how they are listed.
 *
 * Kept as a local constant rather than read off the `LensId` schema's literal
 * order: the schema's job is validation, and a reordering there for readability
 * must not silently change which lenses a medium-severity incident dispatches.
 */
export const LENS_DISPATCH_ORDER: ReadonlyArray<LensId> = [
	"deploy_correlation",
	"downstream_dependency",
	"resource_saturation",
	"traffic_shape",
	"config_flags",
]

export interface FanoutPlanInput {
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	/** True for incident-open triggers, false when a person started this. */
	readonly automatic: boolean
	/** Per-org kill switch. Fan-out ships dark. */
	readonly enabled: boolean
}

export interface FanoutPlan {
	/** How many lenses to dispatch. 1 means the single-pass path. */
	readonly size: number
	/** The lenses themselves, in dispatch order. Empty when `size` is 1. */
	readonly lenses: ReadonlyArray<LensId>
	/**
	 * Billable model passes: the lenses plus the validator. This is the unit the
	 * daily cap counts, because it is the unit that costs money.
	 */
	readonly passCount: number
}

/** Severities we consider worth the extra passes on an *automatic* trigger. */
const FANOUT_SEVERITIES: ReadonlySet<IssueSeverity> = new Set(["critical", "high"])

/**
 * The design's sizing table: severity × signal kind. A free-form question gets
 * one agent and no validator — there is nothing to compare — and an anomaly is
 * capped at two regardless of severity because an anomaly is already a narrow
 * claim about one signal.
 *
 * This is the *width* only. It says nothing about whether we fan out at all.
 */
export function fanoutSize(
	subject: InvestigationSubject,
	snapshot: InvestigationSubjectSnapshot | null,
): number {
	if (subject.type === "freeform") return 1
	if (subject.incidentKind === "alert") return LENS_DISPATCH_ORDER.length
	if (subject.incidentKind === "anomaly") return 2
	switch (snapshot?.severity) {
		case "critical":
			return 5
		case "high":
			return 4
		case "medium":
			return 3
		case "low":
			return 2
		default:
			return 3
	}
}

/**
 * The rollout gate. A person asking for an investigation has already decided it
 * is worth the wait, so manual starts always qualify; automatic triggers have to
 * earn it with severity.
 */
export function shouldFanOut(input: FanoutPlanInput): boolean {
	if (!input.enabled) return false
	if (input.subject.type === "freeform") return false
	if (!input.automatic) return true
	return input.snapshot?.severity !== undefined && input.snapshot.severity !== null
		? FANOUT_SEVERITIES.has(input.snapshot.severity)
		: false
}

export function fanoutPlan(input: FanoutPlanInput): FanoutPlan {
	if (!shouldFanOut(input)) return { size: 1, lenses: [], passCount: 1 }
	const size = fanoutSize(input.subject, input.snapshot)
	// A size of 1 has no rivals to rank, so it is the single pass by another name.
	if (size <= 1) return { size: 1, lenses: [], passCount: 1 }
	return {
		size,
		lenses: LENS_DISPATCH_ORDER.slice(0, size),
		passCount: size + 1,
	}
}
