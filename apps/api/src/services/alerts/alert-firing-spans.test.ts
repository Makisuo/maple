import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
	simulateFiringSpans,
	type AlertCounterThresholds,
	type SimulatedEvaluation,
} from "./alert-firing-spans"

// The simulation runs the shared hysteresis, which is an Effect only because
// `Machine.plan` is. It has no services, no failures, and no time of its own.
const spansOf = (
	evaluations: ReadonlyArray<SimulatedEvaluation>,
	thresholds: AlertCounterThresholds,
	windowMs: number,
) => Effect.runSync(simulateFiringSpans(evaluations, thresholds, windowMs))

const thresholds = (breaches: number, healthy: number): AlertCounterThresholds => ({
	consecutiveBreachesRequired: breaches,
	consecutiveHealthyRequired: healthy,
})

const MINUTE = 60_000

describe("simulateFiringSpans", () => {
	const evaluations = (
		statuses: ReadonlyArray<SimulatedEvaluation["status"]>,
		options?: { readonly provisionalLast?: boolean },
	): ReadonlyArray<SimulatedEvaluation> =>
		statuses.map((status, i) => ({
			bucketMs: i * MINUTE,
			status,
			provisional: options?.provisionalLast === true && i === statuses.length - 1,
		}))

	it("opens at the start of the run's first breached window, not the one that tripped it", () => {
		const spans = spansOf(
			evaluations(["healthy", "breached", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		// The second breach trips the counter at t=2m, but the incident began with
		// the first breach at t=1m; it resolves at the end of the second healthy.
		expect(spans).toEqual([{ startMs: 1 * MINUTE, endMs: 5 * MINUTE }])
	})

	it("does not resolve on a single healthy window when two are required", () => {
		const spans = spansOf(
			evaluations(["breached", "breached", "healthy", "breached", "breached"]),
			thresholds(2, 2),
			MINUTE,
		)
		// One healthy resets the breach counter but never reaches the resolve bar,
		// so the whole stretch is one continuous span left open at the end.
		expect(spans).toEqual([{ startMs: 0, endMs: 5 * MINUTE }])
	})

	// Skipped windows freeze the machine, so a breach run survives a gap in data
	// instead of being silently reset by it.
	it("carries a breach run across a skipped window", () => {
		const spans = spansOf(
			evaluations(["breached", "skipped", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([{ startMs: 1 * MINUTE, endMs: 5 * MINUTE }])
	})

	// The trailing in-progress window charts, but the scheduler has not evaluated
	// it — letting it fire would show an incident the rule has not opened.
	it("ignores the provisional window entirely", () => {
		const spans = spansOf(
			evaluations(["healthy", "healthy", "breached", "breached"], { provisionalLast: true }),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})

	it("closes a still-open run at the last complete window's boundary", () => {
		const spans = spansOf(evaluations(["breached", "breached", "breached"]), thresholds(2, 2), MINUTE)
		expect(spans).toEqual([{ startMs: 0, endMs: 3 * MINUTE }])
	})

	it("returns nothing when the breach requirement is never met", () => {
		const spans = spansOf(
			evaluations(["breached", "healthy", "breached", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})
})
