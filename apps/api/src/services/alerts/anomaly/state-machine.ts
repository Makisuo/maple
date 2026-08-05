// ---------------------------------------------------------------------------
// Anomaly incident state machine — pure decision logic, no I/O.
//
// Mirrors the alert_rule_states hysteresis mechanics: a series must breach on
// N consecutive ticks to open an incident and be healthy on M consecutive
// ticks to resolve it. A cooldown after resolution stops flapping series from
// re-opening immediately (a guard the user-configured alerting path doesn't
// need, but a zero-config detector does).
// ---------------------------------------------------------------------------

import type { AnomalySignalType } from "@maple/domain/http"

import type { AnomalyEvaluation } from "./detection"

export interface DetectorStateSnapshot {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
	readonly openIncidentId: string | null
	readonly lastResolvedAt: number | null
}

export interface StateMachineConfig {
	/** Consecutive breaching ticks before an incident opens. */
	readonly breachesToOpen: number
	/** Consecutive healthy ticks before an open incident resolves. */
	readonly healthyToResolve: number
	/** Quiet period after a resolve during which the key cannot re-open. */
	readonly cooldownMs: number
}

export const DEFAULT_STATE_MACHINE_CONFIG: StateMachineConfig = {
	breachesToOpen: 2,
	healthyToResolve: 3,
	cooldownMs: 60 * 60 * 1000,
}

/**
 * Per-signal overrides. Throughput outages need an extra breaching tick (15
 * min sustained), but resolve as soon as traffic returns. The one-hour
 * cooldown still prevents an edge-of-threshold series from flapping.
 */
const STATE_MACHINE_CONFIG_OVERRIDES: Partial<Record<AnomalySignalType, Partial<StateMachineConfig>>> = {
	throughput: { breachesToOpen: 3, healthyToResolve: 1 },
}

export const stateMachineConfigFor = (signalType: AnomalySignalType): StateMachineConfig => ({
	...DEFAULT_STATE_MACHINE_CONFIG,
	...STATE_MACHINE_CONFIG_OVERRIDES[signalType],
})

type AnomalyTransition = "open" | "continue" | "resolve" | "noop"

export interface TransitionDecision {
	readonly transition: AnomalyTransition
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
}

export function decideTransition(
	state: DetectorStateSnapshot,
	evaluation: AnomalyEvaluation,
	config: StateMachineConfig,
	nowMs: number,
): TransitionDecision {
	// Skipped evaluations leave the counters untouched: a window with too few
	// samples is evidence of nothing, in either direction.
	if (evaluation.status === "skipped") {
		return {
			transition: "noop",
			consecutiveBreaches: state.consecutiveBreaches,
			consecutiveHealthy: state.consecutiveHealthy,
		}
	}

	if (evaluation.status === "breached") {
		const consecutiveBreaches = state.consecutiveBreaches + 1
		if (state.openIncidentId !== null) {
			return { transition: "continue", consecutiveBreaches, consecutiveHealthy: 0 }
		}
		const inCooldown = state.lastResolvedAt !== null && nowMs - state.lastResolvedAt < config.cooldownMs
		if (consecutiveBreaches >= config.breachesToOpen && !inCooldown) {
			return { transition: "open", consecutiveBreaches, consecutiveHealthy: 0 }
		}
		return { transition: "noop", consecutiveBreaches, consecutiveHealthy: 0 }
	}

	// healthy
	const consecutiveHealthy = state.consecutiveHealthy + 1
	if (state.openIncidentId !== null && consecutiveHealthy >= config.healthyToResolve) {
		return { transition: "resolve", consecutiveBreaches: 0, consecutiveHealthy }
	}
	return { transition: "noop", consecutiveBreaches: 0, consecutiveHealthy }
}
