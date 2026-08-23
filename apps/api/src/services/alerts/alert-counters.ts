import type { AlertEvaluationStatus } from "@maple/domain/http"

/**
 * THE consecutive-observation state machine behind every alert rule.
 *
 * Two callers replay it and they must never disagree: the scheduler
 * (`processEvaluation`, one observation per tick against the persisted
 * `alert_rule_states` row) and the rule preview (`previewRule`, the whole
 * series replayed in one pass to shade "would have fired" spans). They were
 * open-coded separately — the same transitions spelled two different ways,
 * agreeing only by luck — which is the shape of divergence that survives
 * review: the preview promises to show what the scheduler will do, so a drift
 * here is invisible until a rule fires differently than its chart said it
 * would.
 */
export interface AlertCounters {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
}

/** The rule fields the machine reads — nothing else about a rule matters here. */
export interface AlertCounterThresholds {
	readonly consecutiveBreachesRequired: number
	readonly consecutiveHealthyRequired: number
}

export const ZERO_ALERT_COUNTERS: AlertCounters = {
	consecutiveBreaches: 0,
	consecutiveHealthy: 0,
}

/**
 * Fold one evaluation into the counters.
 *
 * - `breached` / `healthy` advance their own counter and clear the other.
 * - `skipped` freezes both. A window the evaluator could not judge is not
 *   evidence either way: it must neither advance an incident toward opening
 *   nor count toward resolving one.
 *
 * Counts saturate at the rule's requirement because they are only ever compared
 * with `>=` against it. That keeps open/resolve behavior identical while
 * letting a steady-state scheduler tick recognise its state as unchanged and
 * skip the `alert_rule_states` upsert.
 */
export const advanceAlertCounters = (
	previous: AlertCounters,
	status: AlertEvaluationStatus,
	thresholds: AlertCounterThresholds,
): AlertCounters => {
	switch (status) {
		case "skipped":
			return previous
		case "breached":
			return {
				consecutiveBreaches: Math.min(
					previous.consecutiveBreaches + 1,
					thresholds.consecutiveBreachesRequired,
				),
				consecutiveHealthy: 0,
			}
		case "healthy":
			return {
				consecutiveBreaches: 0,
				consecutiveHealthy: Math.min(
					previous.consecutiveHealthy + 1,
					thresholds.consecutiveHealthyRequired,
				),
			}
	}
}

/** One observation the preview replays, in the order the scheduler would see it. */
export interface SimulatedEvaluation {
	readonly bucketMs: number
	readonly status: AlertEvaluationStatus
	/**
	 * The trailing in-progress window. It charts, but the scheduler has not
	 * evaluated it yet, so it stays out of the simulation entirely.
	 */
	readonly provisional?: boolean
}

/** A stretch of wall time the rule would have held an incident open. */
export interface SimulatedFiringSpan {
	readonly startMs: number
	readonly endMs: number
}

/**
 * Replay a whole series through {@link advanceAlertCounters} and return the
 * spans during which the rule would have held an incident open.
 *
 * A span opens at the start of the run's *first* breached window, not at the
 * window that tripped the counter — the incident is understood to have begun
 * when the breach did. A run still open at the end of the series is closed at
 * the last complete window's boundary rather than left dangling.
 */
export const simulateFiringSpans = (
	evaluations: ReadonlyArray<SimulatedEvaluation>,
	thresholds: AlertCounterThresholds,
	windowMs: number,
): ReadonlyArray<SimulatedFiringSpan> => {
	const spans: SimulatedFiringSpan[] = []
	let counters = ZERO_ALERT_COUNTERS
	let openStartMs: number | null = null
	let lastCompleteBucketMs: number | null = null

	for (const evaluation of evaluations) {
		if (evaluation.provisional === true) continue
		lastCompleteBucketMs = evaluation.bucketMs
		counters = advanceAlertCounters(counters, evaluation.status, thresholds)

		if (openStartMs == null && counters.consecutiveBreaches >= thresholds.consecutiveBreachesRequired) {
			openStartMs = evaluation.bucketMs - (thresholds.consecutiveBreachesRequired - 1) * windowMs
		} else if (
			openStartMs != null &&
			counters.consecutiveHealthy >= thresholds.consecutiveHealthyRequired
		) {
			spans.push({ startMs: openStartMs, endMs: evaluation.bucketMs + windowMs })
			openStartMs = null
		}
	}

	if (openStartMs != null && lastCompleteBucketMs != null) {
		spans.push({ startMs: openStartMs, endMs: lastCompleteBucketMs + windowMs })
	}
	return spans
}
