import { toEpochMs } from "@maple/ui/lib/time-format"

// Generic number/byte/percent formatting lives in `@maple/ui/lib/format`; only
// infra-specific status policy stays here.

/**
 * Collector freshness, which is all a metrics window can honestly report.
 *
 * `ended` is deliberately not "down": a series that stops mid-window means the
 * resource stopped reporting, and for a pod on an autoscaled fleet that is
 * almost always a normal termination — scale-in, a rollout, a replaced Fargate
 * task. Calling that an error painted the expected case red. A real down state
 * needs an expectation signal (`k8s.pod.phase`, or a workload's available vs
 * desired replicas), and belongs beside these rather than instead of them.
 */
export type HostStatus = "active" | "idle" | "ended"
export type SeverityLevel = "ok" | "warn" | "crit"

export function severityLevel(fraction: number): SeverityLevel {
	if (!Number.isFinite(fraction)) return "ok"
	if (fraction >= 0.9) return "crit"
	if (fraction >= 0.6) return "warn"
	return "ok"
}

const SCRAPE_INTERVAL_MS = 30_000

export function deriveHostStatus(lastSeenIso: string, reference: number | string = Date.now()): HostStatus {
	const lastSeen = toEpochMs(lastSeenIso)
	if (!Number.isFinite(lastSeen)) return "ended"
	const referenceMs = typeof reference === "number" ? reference : toEpochMs(reference)
	const ref = Number.isFinite(referenceMs) ? referenceMs : Date.now()
	const age = ref - lastSeen
	if (age < SCRAPE_INTERVAL_MS * 2) return "active"
	if (age < SCRAPE_INTERVAL_MS * 10) return "idle"
	return "ended"
}
