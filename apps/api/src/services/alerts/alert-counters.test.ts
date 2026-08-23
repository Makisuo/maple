import { describe, expect, it } from "vitest"

import {
	advanceAlertCounters,
	simulateFiringSpans,
	ZERO_ALERT_COUNTERS,
	type AlertCounterThresholds,
	type SimulatedEvaluation,
} from "./alert-counters"

const thresholds = (breaches: number, healthy: number): AlertCounterThresholds => ({
	consecutiveBreachesRequired: breaches,
	consecutiveHealthyRequired: healthy,
})

const MINUTE = 60_000

describe("advanceAlertCounters", () => {
	const rule = thresholds(2, 2)

	it("advances one counter and clears the other", () => {
		const afterBreach = advanceAlertCounters(ZERO_ALERT_COUNTERS, "breached", rule)
		expect(afterBreach).toEqual({ consecutiveBreaches: 1, consecutiveHealthy: 0 })

		const afterHealthy = advanceAlertCounters(afterBreach, "healthy", rule)
		expect(afterHealthy).toEqual({ consecutiveBreaches: 0, consecutiveHealthy: 1 })
	})

	// Saturation is what lets a steady-state scheduler tick recognise its own
	// state as unchanged and skip the alert_rule_states upsert.
	it("saturates at the rule's requirement rather than counting on", () => {
		let counters = ZERO_ALERT_COUNTERS
		for (let i = 0; i < 10; i += 1) counters = advanceAlertCounters(counters, "breached", rule)
		expect(counters.consecutiveBreaches).toBe(2)
	})

	// A window the evaluator could not judge is evidence for neither side: it
	// must not advance an incident toward opening nor toward resolving.
	it("freezes both counters on a skipped window", () => {
		const partway = advanceAlertCounters(ZERO_ALERT_COUNTERS, "breached", rule)
		expect(advanceAlertCounters(partway, "skipped", rule)).toEqual(partway)
	})
})

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
		const spans = simulateFiringSpans(
			evaluations(["healthy", "breached", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		// The second breach trips the counter at t=2m, but the incident began with
		// the first breach at t=1m; it resolves at the end of the second healthy.
		expect(spans).toEqual([{ startMs: 1 * MINUTE, endMs: 5 * MINUTE }])
	})

	it("does not resolve on a single healthy window when two are required", () => {
		const spans = simulateFiringSpans(
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
		const spans = simulateFiringSpans(
			evaluations(["breached", "skipped", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([{ startMs: 1 * MINUTE, endMs: 5 * MINUTE }])
	})

	// The trailing in-progress window charts, but the scheduler has not evaluated
	// it — letting it fire would show an incident the rule has not opened.
	it("ignores the provisional window entirely", () => {
		const spans = simulateFiringSpans(
			evaluations(["healthy", "healthy", "breached", "breached"], { provisionalLast: true }),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})

	it("closes a still-open run at the last complete window's boundary", () => {
		const spans = simulateFiringSpans(
			evaluations(["breached", "breached", "breached"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([{ startMs: 0, endMs: 3 * MINUTE }])
	})

	it("returns nothing when the breach requirement is never met", () => {
		const spans = simulateFiringSpans(
			evaluations(["breached", "healthy", "breached", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})
})
