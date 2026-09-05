import type { ServiceLatencyBaseline } from "@/api/warehouse/services"
import type { AnomalySignalType } from "@maple/domain/http"

/** Health rollup for a single service. */
export type ServiceHealth = "healthy" | "degraded" | "unhealthy"

export interface ServiceHealthCause {
	severity: "warning" | "critical"
	label: string
	metric?: "error" | "latency" | "traffic"
	direction?: "up" | "down"
}

/**
 * Direction detected by each baseline anomaly. These are detector semantics,
 * not a comparison with the latest sample: an incident can remain open while
 * it is recovering, but it was still opened for the direction shown here.
 */
export function anomalyDirection(signalType: AnomalySignalType): "up" | "down" {
	return signalType === "throughput" ? "down" : "up"
}

/**
 * Incident-backed health used by the main overview. These causes have passed
 * either a user-authored alert rule or Maple's volume-aware seasonal anomaly
 * detector.
 */
export function deriveServiceHealthFromCauses(causes: readonly ServiceHealthCause[]): ServiceHealth {
	if (causes.some((cause) => cause.severity === "critical")) return "unhealthy"
	if (causes.length > 0) return "degraded"
	return "healthy"
}

export function primaryServiceHealthCause(
	causes: readonly ServiceHealthCause[],
): ServiceHealthCause | undefined {
	return causes.find((cause) => cause.severity === "critical") ?? causes[0]
}

export interface LatencyBaselineSignal {
	p95LatencyMs: number
	spanCount: number
}

// Higher = worse; used to sort the most-broken services to the top.
const HEALTH_RANK: Record<ServiceHealth, number> = {
	unhealthy: 2,
	degraded: 1,
	healthy: 0,
} satisfies Record<ServiceHealth, number>

export function healthRank(health: ServiceHealth): number {
	return HEALTH_RANK[health]
}

/**
 * Key for matching a baseline row to an overview row. Overview metrics collapse
 * namespace variants by service name + environment, then retain the dominant
 * namespace for this baseline lookup. A mismatch leaves the baseline delta
 * unavailable for that service.
 */
export function baselineKey(serviceName: string, serviceNamespace: string, environment: string): string {
	return `${serviceName}::${serviceNamespace}::${environment}`
}

export function buildBaselineMap(
	rows: readonly ServiceLatencyBaseline[],
): Map<string, LatencyBaselineSignal> {
	const map = new Map<string, LatencyBaselineSignal>()
	for (const row of rows) {
		map.set(baselineKey(row.serviceName, row.serviceNamespace, row.environment), {
			p95LatencyMs: row.baselineP95LatencyMs,
			spanCount: row.baselineSpanCount,
		})
	}
	return map
}
