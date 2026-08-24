import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { foldObservation, type HysteresisConfig, type HysteresisRow } from "./incident-hysteresis"

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

/**
 * Replay a status sequence the way a tick does: rebuild the row, fold one
 * observation, write the row back. This exercises the row adapter too, which is
 * the part the services actually call.
 */
const runMachine = (statuses: ReadonlyArray<Status>, config: HysteresisConfig) =>
	Effect.gen(function* () {
		let row: HysteresisRow = {
			consecutiveBreaches: 0,
			consecutiveHealthy: 0,
			incidentOpen: false,
			lastResolvedAtMs: null,
		}
		const decisions: Array<Decision> = []
		for (const [index, status] of statuses.entries()) {
			const nowMs = START_MS + index * TICK_MS
			const outcome = yield* foldObservation(row, status, config, nowMs)
			row = {
				consecutiveBreaches: outcome.consecutiveBreaches,
				consecutiveHealthy: outcome.consecutiveHealthy,
				incidentOpen:
					outcome.transition === "open"
						? true
						: outcome.transition === "resolve"
							? false
							: row.incidentOpen,
				lastResolvedAtMs: outcome.transition === "resolve" ? nowMs : row.lastResolvedAtMs,
			}
			if (outcome.transition === "open") decisions.push("opened")
			if (outcome.transition === "resolve") decisions.push("resolved")
		}
		return { row, decisions }
	})

/**
 * `decideTransition` as it stood before the machine replaced it, frozen here on
 * purpose. Keeping the predecessor in the test rather than in the source tree
 * is what lets this file keep proving equivalence without keeping dead code
 * around to be maintained, imported by mistake, or quietly edited into
 * agreement. Do not "fix" it — if it and the machine disagree, that is the
 * finding.
 */
interface FrozenDetectorState {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
	readonly openIncidentId: string | null
	readonly lastResolvedAt: number | null
}

const frozenDecideTransition = (
	state: FrozenDetectorState,
	status: Status,
	config: HysteresisConfig,
	nowMs: number,
) => {
	if (status === "skipped") {
		return {
			transition: "noop" as const,
			consecutiveBreaches: state.consecutiveBreaches,
			consecutiveHealthy: state.consecutiveHealthy,
		}
	}
	if (status === "breached") {
		const consecutiveBreaches = state.consecutiveBreaches + 1
		if (state.openIncidentId !== null) {
			return { transition: "continue" as const, consecutiveBreaches, consecutiveHealthy: 0 }
		}
		const inCooldown = state.lastResolvedAt !== null && nowMs - state.lastResolvedAt < config.cooldownMs
		if (consecutiveBreaches >= config.breachesToOpen && !inCooldown) {
			return { transition: "open" as const, consecutiveBreaches, consecutiveHealthy: 0 }
		}
		return { transition: "noop" as const, consecutiveBreaches, consecutiveHealthy: 0 }
	}
	const consecutiveHealthy = state.consecutiveHealthy + 1
	if (state.openIncidentId !== null && consecutiveHealthy >= config.healthyToResolve) {
		return { transition: "resolve" as const, consecutiveBreaches: 0, consecutiveHealthy }
	}
	return { transition: "noop" as const, consecutiveBreaches: 0, consecutiveHealthy }
}

/** What `AnomalyDetectionService` did with each frozen verdict. */
const runAnomaly = (statuses: ReadonlyArray<Status>, config: HysteresisConfig): ReadonlyArray<Decision> => {
	let state: FrozenDetectorState = {
		consecutiveBreaches: 0,
		consecutiveHealthy: 0,
		openIncidentId: null,
		lastResolvedAt: null,
	}
	const decisions: Array<Decision> = []
	for (const [index, status] of statuses.entries()) {
		const nowMs = START_MS + index * TICK_MS
		const decision = frozenDecideTransition(state, status, config, nowMs)
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

/**
 * `advanceAlertCounters` as it stood before the machine replaced it, frozen for
 * the same reason as {@link frozenDecideTransition}.
 */
const frozenAdvanceCounters = (
	previous: { readonly consecutiveBreaches: number; readonly consecutiveHealthy: number },
	status: Status,
	thresholds: {
		readonly consecutiveBreachesRequired: number
		readonly consecutiveHealthyRequired: number
	},
) => {
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

/** What `AlertsService.processEvaluation` did with each frozen counter fold. No cooldown. */
const runAlerting = (statuses: ReadonlyArray<Status>, config: HysteresisConfig) => {
	const thresholds = {
		consecutiveBreachesRequired: config.breachesToOpen,
		consecutiveHealthyRequired: config.healthyToResolve,
	}
	let counters = { consecutiveBreaches: 0, consecutiveHealthy: 0 }
	let open = false
	const decisions: Array<Decision> = []
	for (const status of statuses) {
		counters = frozenAdvanceCounters(counters, status, thresholds)
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
		const { row } = await Effect.runPromise(
			runMachine(["breached", "skipped", "breached"], ANOMALY_CONFIG),
		)
		// Without the freeze the second breach would have been the third tick and
		// nothing would distinguish it from a two-in-a-row run.
		expect(row.consecutiveBreaches).toBe(2)
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

	it("decides and counts exactly what the frozen alerting counters did", async () => {
		for (let seed = 1; seed <= 200; seed++) {
			const statuses = sequence(seed, 40)
			const { row, decisions } = await Effect.runPromise(runMachine(statuses, ALERTING_CONFIG))
			const expected = runAlerting(statuses, ALERTING_CONFIG)
			expect(decisions, `seed ${seed}`).toEqual(expected.decisions)
			expect(
				{
					consecutiveBreaches: row.consecutiveBreaches,
					consecutiveHealthy: row.consecutiveHealthy,
				},
				`seed ${seed}`,
			).toEqual({
				consecutiveBreaches: expected.counters.consecutiveBreaches,
				consecutiveHealthy: expected.counters.consecutiveHealthy,
			})
		}
	})
})
