/**
 * When a run that still says `investigating` has been abandoned.
 *
 * This lives in one module because it used to live in two, and they drifted:
 * `InvestigationService` learned that a fan-out legitimately outlives the
 * single-pass budget while `ai-triage-enqueue` kept a flat 15 minutes, so the
 * incident-open path would mark a healthy five-lens run `diagnosis_timeout`
 * seconds before its diagnosis landed. Both now import from here.
 */
import type { InvestigationFanoutState } from "@maple/domain/http"

/** A single agent pass. If it has not answered in this long, it is not going to. */
export const SINGLE_PASS_STALE_MS = 15 * 60 * 1000

/**
 * A fan-out: N lens passes settle, then a validator ranks them. Longer on
 * purpose — the lens step timeout alone is 8 minutes.
 */
export const FANOUT_STALE_MS = 25 * 60 * 1000

/** Fan-out states that mean a workflow is still expected to be doing something. */
export const FANOUT_IN_FLIGHT_STATES: ReadonlyArray<InvestigationFanoutState> = [
	"queued",
	"running",
	"validating",
]

/** Everything else — the single-pass path and every terminal fan-out state. */
export const SINGLE_PASS_STATES: ReadonlyArray<InvestigationFanoutState> = [
	"none",
	"ranked",
	"rejected_all",
	"superseded",
]

/**
 * `[budget, states]` pairs covering the state enum exactly once. Callers that
 * sweep with SQL iterate this; callers holding a row use `staleBudgetMs`.
 */
export const STALE_BUDGETS: ReadonlyArray<readonly [number, ReadonlyArray<InvestigationFanoutState>]> = [
	[SINGLE_PASS_STALE_MS, SINGLE_PASS_STATES],
	[FANOUT_STALE_MS, FANOUT_IN_FLIGHT_STATES],
]

export const staleBudgetMs = (fanoutState: InvestigationFanoutState): number =>
	(FANOUT_IN_FLIGHT_STATES as ReadonlyArray<string>).includes(fanoutState)
		? FANOUT_STALE_MS
		: SINGLE_PASS_STALE_MS

export const staleTimeoutMessage = (budgetMs: number): string =>
	`diagnosis_timeout: no diagnosis was submitted within ${Math.round(budgetMs / 60_000)} minutes; retry`

/** True when this row has outlived the budget for its own path. */
export const isInvestigationStale = (
	row: {
		readonly status: string
		readonly startedAt: Date | null
		readonly fanoutState: InvestigationFanoutState
	},
	nowMs: number,
): boolean =>
	row.status === "investigating" &&
	row.startedAt !== null &&
	row.startedAt.getTime() < nowMs - staleBudgetMs(row.fanoutState)
