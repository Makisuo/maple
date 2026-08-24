import { Effect } from "effect"

import type { AlertEvaluationStatus } from "@maple/domain/http"

import { foldObservation, type HysteresisConfig, type HysteresisRow } from "./incident-hysteresis"

/** The rule fields the hysteresis reads — nothing else about a rule matters here. */
export interface AlertCounterThresholds {
	readonly consecutiveBreachesRequired: number
	readonly consecutiveHealthyRequired: number
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
 * Replay a whole series through the shared incident hysteresis and return the
 * spans during which the rule would have held an incident open.
 *
 * The preview promises to show what the scheduler will do, so it must not be a
 * second implementation of the scheduler: both run the same `foldObservation`,
 * and a drift here would only ever show up as a rule firing differently than
 * its chart said it would.
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
): Effect.Effect<ReadonlyArray<SimulatedFiringSpan>> =>
	Effect.gen(function* () {
		const config: HysteresisConfig = {
			breachesToOpen: thresholds.consecutiveBreachesRequired,
			healthyToResolve: thresholds.consecutiveHealthyRequired,
			cooldownMs: 0,
		}
		const spans: SimulatedFiringSpan[] = []
		let row: HysteresisRow = {
			consecutiveBreaches: 0,
			consecutiveHealthy: 0,
			incidentOpen: false,
			lastResolvedAtMs: null,
		}
		let openStartMs: number | null = null
		let lastCompleteBucketMs: number | null = null

		for (const evaluation of evaluations) {
			if (evaluation.provisional === true) continue
			lastCompleteBucketMs = evaluation.bucketMs
			const outcome = yield* foldObservation(row, evaluation.status, config, evaluation.bucketMs)
			row = {
				consecutiveBreaches: outcome.consecutiveBreaches,
				consecutiveHealthy: outcome.consecutiveHealthy,
				incidentOpen:
					outcome.transition === "open"
						? true
						: outcome.transition === "resolve"
							? false
							: row.incidentOpen,
				lastResolvedAtMs: row.lastResolvedAtMs,
			}
			if (outcome.transition === "open") {
				openStartMs = evaluation.bucketMs - (thresholds.consecutiveBreachesRequired - 1) * windowMs
			} else if (outcome.transition === "resolve" && openStartMs != null) {
				spans.push({ startMs: openStartMs, endMs: evaluation.bucketMs + windowMs })
				openStartMs = null
			}
		}

		if (openStartMs != null && lastCompleteBucketMs != null) {
			spans.push({ startMs: openStartMs, endMs: lastCompleteBucketMs + windowMs })
		}
		return spans
	})
