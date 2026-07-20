import { describe, expect, it } from "vitest"
import type { AnomalyEvaluation } from "./detection"
import {
	decideTransition,
	DEFAULT_STATE_MACHINE_CONFIG,
	stateMachineConfigFor,
	type DetectorStateSnapshot,
} from "./state-machine"

const nowMs = Date.parse("2026-06-11T12:00:00Z")

const evaluation = (status: AnomalyEvaluation["status"]): AnomalyEvaluation => ({
	detectorKey: "error_rate:production:api",
	signalType: "error_rate",
	serviceName: "api",
	deploymentEnv: "production",
	fingerprintHash: null,
	status,
	value: 0.2,
	baselineMedian: 0.01,
	baselineSigma: 0.005,
	threshold: 0.05,
	sampleCount: 1000,
	severity: "warning",
})

const state = (overrides: Partial<DetectorStateSnapshot> = {}): DetectorStateSnapshot => ({
	consecutiveBreaches: 0,
	consecutiveHealthy: 0,
	openIncidentId: null,
	lastResolvedAt: null,
	...overrides,
})

describe("decideTransition", () => {
	it("does not open on the first breach", () => {
		const d = decideTransition(state(), evaluation("breached"), DEFAULT_STATE_MACHINE_CONFIG, nowMs)
		expect(d.transition).toBe("noop")
		expect(d.consecutiveBreaches).toBe(1)
	})

	it("opens on the second consecutive breach", () => {
		const d = decideTransition(
			state({ consecutiveBreaches: 1 }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("open")
		expect(d.consecutiveBreaches).toBe(2)
	})

	it("continues an open incident on further breaches", () => {
		const d = decideTransition(
			state({ consecutiveBreaches: 5, openIncidentId: "inc_1" }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("continue")
	})

	it("requires three consecutive healthy ticks to resolve", () => {
		const open = state({ openIncidentId: "inc_1" })
		const first = decideTransition(open, evaluation("healthy"), DEFAULT_STATE_MACHINE_CONFIG, nowMs)
		expect(first.transition).toBe("noop")
		expect(first.consecutiveHealthy).toBe(1)

		const third = decideTransition(
			state({ openIncidentId: "inc_1", consecutiveHealthy: 2 }),
			evaluation("healthy"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(third.transition).toBe("resolve")
	})

	it("a breach resets the healthy counter", () => {
		const d = decideTransition(
			state({ openIncidentId: "inc_1", consecutiveHealthy: 2 }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("continue")
		expect(d.consecutiveHealthy).toBe(0)
	})

	it("cooldown blocks reopening right after a resolve", () => {
		const d = decideTransition(
			state({ consecutiveBreaches: 3, lastResolvedAt: nowMs - 10 * 60 * 1000 }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("noop")
	})

	it("opens again once the cooldown has elapsed", () => {
		const d = decideTransition(
			state({ consecutiveBreaches: 3, lastResolvedAt: nowMs - 2 * 60 * 60 * 1000 }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("open")
	})

	it("a manual resolve suppresses re-open for the cooldown, then allows it", () => {
		// resolveIncidentManually leaves exactly this snapshot behind: pointer
		// cleared, counters zeroed, lastResolvedAt stamped.
		const afterManualResolve = state({
			openIncidentId: null,
			consecutiveBreaches: 0,
			consecutiveHealthy: 0,
			lastResolvedAt: nowMs,
		})

		// Still breaching right after the manual resolve: counters rebuild but
		// the cooldown blocks a re-open.
		const first = decideTransition(
			afterManualResolve,
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs + 5 * 60 * 1000,
		)
		expect(first.transition).toBe("noop")
		const second = decideTransition(
			state({ ...afterManualResolve, consecutiveBreaches: first.consecutiveBreaches }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs + 10 * 60 * 1000,
		)
		expect(second.transition).toBe("noop")

		// Once the cooldown has elapsed a persistent breach opens again.
		const afterCooldown = decideTransition(
			state({ ...afterManualResolve, consecutiveBreaches: second.consecutiveBreaches }),
			evaluation("breached"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs + DEFAULT_STATE_MACHINE_CONFIG.cooldownMs + 5 * 60 * 1000,
		)
		expect(afterCooldown.transition).toBe("open")
	})

	it("throughput requires a third consecutive breach to open", () => {
		const config = stateMachineConfigFor("throughput")
		expect(config.breachesToOpen).toBe(3)
		expect(config.healthyToResolve).toBe(1)

		const second = decideTransition(
			state({ consecutiveBreaches: 1 }),
			evaluation("breached"),
			config,
			nowMs,
		)
		expect(second.transition).toBe("noop")
		expect(second.consecutiveBreaches).toBe(2)

		const third = decideTransition(
			state({ consecutiveBreaches: 2 }),
			evaluation("breached"),
			config,
			nowMs,
		)
		expect(third.transition).toBe("open")
	})

	it("resolves a throughput incident on the first healthy tick", () => {
		const decision = decideTransition(
			state({ openIncidentId: "incident-1" }),
			evaluation("healthy"),
			stateMachineConfigFor("throughput"),
			nowMs,
		)
		expect(decision.transition).toBe("resolve")
	})

	it("other signals keep the default two-breach open", () => {
		expect(stateMachineConfigFor("error_rate")).toEqual(DEFAULT_STATE_MACHINE_CONFIG)
		expect(stateMachineConfigFor("error_spike").breachesToOpen).toBe(2)
	})

	it("skipped evaluations leave counters untouched", () => {
		const d = decideTransition(
			state({ consecutiveBreaches: 1, consecutiveHealthy: 0 }),
			evaluation("skipped"),
			DEFAULT_STATE_MACHINE_CONFIG,
			nowMs,
		)
		expect(d.transition).toBe("noop")
		expect(d.consecutiveBreaches).toBe(1)
	})
})
