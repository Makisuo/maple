import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { advanceAlertCounters, ZERO_ALERT_COUNTERS } from "./alert-counters"
import type { AnomalyEvaluation } from "./anomaly/detection"
import { decideTransition, type DetectorStateSnapshot } from "./anomaly/state-machine"
import {
	HysteresisEvent,
	type HysteresisConfig,
	HysteresisStates,
	IncidentHysteresis,
} from "./incident-hysteresis"

/**
 * Parity harness. The machine replaces two hand-rolled implementations, so the
 * bar is not "the machine looks right" — it is "the machine decides exactly
 * what both predecessors decided", over sequences neither suite covers.
 */

type Status = "breached" | "healthy" | "skipped"
type Decision = "opened" | "resolved"

/** Deterministic PRNG: a failing sequence must reproduce from its seed alone. */
const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff)

const sequence = (seed: number, length: number): ReadonlyArray<Status> => {
	const next = lcg(seed)
	return Array.from({ length }, () => {
		const roll = next()
		return roll < 0.45 ? "breached" : roll < 0.9 ? "healthy" : "skipped"
	})
}

const TICK_MS = 5 * 60 * 1000
const START_MS = Date.parse("2026-06-11T12:00:00Z")

/** Replay a status sequence through the machine, collecting emitted decisions. */
const runMachine = (statuses: ReadonlyArray<Status>, config: HysteresisConfig) =>
	Effect.gen(function* () {
		const initial = yield* Machine.planInitial(IncidentHysteresis)
		let snapshot: Machine.Snapshot<typeof HysteresisStates.states> = initial.startingState
		const decisions: Array<Decision> = []
		for (const [index, status] of statuses.entries()) {
			const nowMs = START_MS + index * TICK_MS
			const event =
				status === "skipped"
					? HysteresisEvent.Skipped()
					: status === "breached"
						? HysteresisEvent.Breached({ nowMs, config })
						: HysteresisEvent.Recovered({ nowMs, config })
			const planned = yield* Machine.plan(IncidentHysteresis, snapshot, event)
			snapshot = planned.next
			for (const emitted of planned.emittedEvents) {
				decisions.push(emitted._tag === "IncidentOpened" ? "opened" : "resolved")
			}
		}
		return { snapshot, decisions }
	})

/** What `AnomalyDetectionService` does with each `decideTransition` verdict. */
const runAnomaly = (statuses: ReadonlyArray<Status>, config: HysteresisConfig): ReadonlyArray<Decision> => {
	let state: DetectorStateSnapshot = {
		consecutiveBreaches: 0,
		consecutiveHealthy: 0,
		openIncidentId: null,
		lastResolvedAt: null,
	}
	const decisions: Array<Decision> = []
	for (const [index, status] of statuses.entries()) {
		const nowMs = START_MS + index * TICK_MS
		const evaluation = { status } as AnomalyEvaluation
		const decision = decideTransition(state, evaluation, config, nowMs)
		state = {
			consecutiveBreaches: decision.consecutiveBreaches,
			consecutiveHealthy: decision.consecutiveHealthy,
			openIncidentId:
				decision.transition === "open"
					? "inc_1"
					: decision.transition === "resolve"
						? null
						: state.openIncidentId,
			lastResolvedAt: decision.transition === "resolve" ? nowMs : state.lastResolvedAt,
		}
		if (decision.transition === "open") decisions.push("opened")
		if (decision.transition === "resolve") decisions.push("resolved")
	}
	return decisions
}

/** What `AlertsService.processEvaluation` does with each counter fold. No cooldown. */
const runAlerting = (statuses: ReadonlyArray<Status>, config: HysteresisConfig) => {
	const thresholds = {
		consecutiveBreachesRequired: config.breachesToOpen,
		consecutiveHealthyRequired: config.healthyToResolve,
	}
	let counters = ZERO_ALERT_COUNTERS
	let open = false
	const decisions: Array<Decision> = []
	for (const status of statuses) {
		counters = advanceAlertCounters(counters, status, thresholds)
		if (!open && counters.consecutiveBreaches >= thresholds.consecutiveBreachesRequired) {
			open = true
			decisions.push("opened")
		} else if (open && counters.consecutiveHealthy >= thresholds.consecutiveHealthyRequired) {
			open = false
			decisions.push("resolved")
		}
	}
	return { counters, decisions }
}

/** The counters the machine's snapshot implies, in `alert_rule_states` terms. */
const countersOf = (snapshot: Machine.Snapshot<typeof HysteresisStates.states>) => {
	const value = snapshot.value
	switch (value._tag) {
		case "Clear":
			return { consecutiveBreaches: 0, consecutiveHealthy: value.consecutiveHealthy }
		case "Breaching":
			return { consecutiveBreaches: value.consecutiveBreaches, consecutiveHealthy: 0 }
		case "Open":
			return {
				consecutiveBreaches: value.consecutiveBreaches,
				consecutiveHealthy: value.consecutiveHealthy,
			}
	}
}

const ANOMALY_CONFIG: HysteresisConfig = {
	breachesToOpen: 2,
	healthyToResolve: 3,
	cooldownMs: 60 * 60 * 1000,
}
const THROUGHPUT_CONFIG: HysteresisConfig = {
	breachesToOpen: 3,
	healthyToResolve: 1,
	cooldownMs: 60 * 60 * 1000,
}
const ALERTING_CONFIG: HysteresisConfig = { breachesToOpen: 2, healthyToResolve: 2, cooldownMs: 0 }

describe("IncidentHysteresis", () => {
	it("opens once the breach run reaches the threshold and resolves on a healthy run", async () => {
		const { decisions } = await Effect.runPromise(
			runMachine(["breached", "breached", "healthy", "healthy", "healthy"], {
				breachesToOpen: 2,
				healthyToResolve: 3,
				cooldownMs: 0,
			}),
		)
		expect(decisions).toEqual(["opened", "resolved"])
	})

	it("leaves the counters untouched on a skipped window", async () => {
		const { snapshot } = await Effect.runPromise(
			runMachine(["breached", "skipped", "breached"], ANOMALY_CONFIG),
		)
		// Without the freeze the second breach would have been the third tick and
		// nothing would distinguish it from a two-in-a-row run.
		expect(countersOf(snapshot).consecutiveBreaches).toBe(2)
	})

	it("suppresses a re-open inside the cooldown and allows it once the window passes", async () => {
		const shortCooldown: HysteresisConfig = { ...ANOMALY_CONFIG, cooldownMs: 3 * TICK_MS }
		const inside = await Effect.runPromise(
			runMachine(
				["breached", "breached", "healthy", "healthy", "healthy", "breached", "breached"],
				shortCooldown,
			),
		)
		expect(inside.decisions).toEqual(["opened", "resolved"])

		const outside = await Effect.runPromise(
			runMachine(
				[
					"breached",
					"breached",
					"healthy",
					"healthy",
					"healthy",
					"skipped",
					"skipped",
					"skipped",
					"skipped",
					"breached",
					"breached",
				],
				shortCooldown,
			),
		)
		expect(outside.decisions).toEqual(["opened", "resolved", "opened"])
	})

	// A plain loop, not `describe.each`: vitest's `each` overloads are expensive
	// enough against this type graph to OOM `tsc --noEmit`.
	for (const [label, config] of [
		["anomaly defaults", ANOMALY_CONFIG],
		["throughput overrides", THROUGHPUT_CONFIG],
	] as ReadonlyArray<readonly [string, HysteresisConfig]>) {
		it(`decides exactly what decideTransition decides, over 200 generated sequences (${label})`, async () => {
			for (let seed = 1; seed <= 200; seed++) {
				const statuses = sequence(seed, 40)
				const { decisions } = await Effect.runPromise(runMachine(statuses, config))
				expect(decisions, `seed ${seed}`).toEqual(runAnomaly(statuses, config))
			}
		})
	}

	it("decides and counts exactly what advanceAlertCounters does", async () => {
		for (let seed = 1; seed <= 200; seed++) {
			const statuses = sequence(seed, 40)
			const { snapshot, decisions } = await Effect.runPromise(runMachine(statuses, ALERTING_CONFIG))
			const expected = runAlerting(statuses, ALERTING_CONFIG)
			expect(decisions, `seed ${seed}`).toEqual(expected.decisions)
			expect(countersOf(snapshot), `seed ${seed}`).toEqual({
				consecutiveBreaches: expected.counters.consecutiveBreaches,
				consecutiveHealthy: expected.counters.consecutiveHealthy,
			})
		}
	})
})
