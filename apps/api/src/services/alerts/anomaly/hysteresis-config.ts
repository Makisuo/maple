// Hysteresis tuning for the zero-config anomaly detector.
//
// The mechanic itself lives in `../incident-hysteresis`, shared with the
// user-configured alerting path. What is anomaly-specific is only the tuning:
// a detector nobody opted into needs a cooldown that the alerting path, whose
// thresholds a human chose, does not.

import type { AnomalySignalType } from "@maple/domain/http"

import type { HysteresisConfig } from "../incident-hysteresis"

export const DEFAULT_HYSTERESIS_CONFIG: HysteresisConfig = {
	breachesToOpen: 2,
	healthyToResolve: 3,
	cooldownMs: 60 * 60 * 1000,
}

/**
 * Per-signal overrides. Throughput outages need an extra breaching tick (15
 * min sustained), but resolve as soon as traffic returns. The one-hour
 * cooldown still prevents an edge-of-threshold series from flapping.
 */
const OVERRIDES: Partial<Record<AnomalySignalType, Partial<HysteresisConfig>>> = {
	throughput: { breachesToOpen: 3, healthyToResolve: 1 },
} satisfies Partial<Record<AnomalySignalType, Partial<HysteresisConfig>>>

export const hysteresisConfigFor = (signalType: AnomalySignalType): HysteresisConfig => ({
	...DEFAULT_HYSTERESIS_CONFIG,
	...OVERRIDES[signalType],
})
