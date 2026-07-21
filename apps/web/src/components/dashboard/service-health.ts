import type { SeverityLevel } from "@/components/infra/format"
import type { ServiceLatencyBaseline } from "@/api/warehouse/services"
import type { AlertIncidentDocument, AnomalySignalType } from "@maple/domain/http"

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
 * Incident-backed health used by the main overview. Unlike the legacy metric
 * heuristic below, these causes have already passed either a user-authored
 * alert rule or Maple's volume-aware seasonal anomaly detector.
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

// Error-rate thresholds are global absolutes — an error ratio means the same
// thing for every service. Error rate is a fraction (errors / requests).
const ERROR_RATE_DEGRADED = 0.01 // 1%
const ERROR_RATE_UNHEALTHY = 0.05 // 5%

// Absolute p95 thresholds (ms). Only used as a FALLBACK when a service has no
// usable latency baseline (new service, sparse history) — otherwise latency
// health is judged relative to the service's own trailing-7d baseline, so
// slow-by-design services (batch workers, queue consumers) aren't permanently
// flagged for a p95 that is normal for them.
const P95_DEGRADED_MS = 1_000
const P95_UNHEALTHY_MS = 3_000

// Baseline-relative latency thresholds: flag only when the current p95 is a
// multiple of the service's own baseline p95.
const LATENCY_BASELINE_DEGRADED_RATIO = 2
const LATENCY_BASELINE_UNHEALTHY_RATIO = 4
// Never latency-flag below this absolute floor — a 5ms→15ms move is 3× but
// harmless, and sub-floor p95s are dominated by noise.
const LATENCY_ABS_FLOOR_MS = 250
// A baseline computed from fewer spans than this is noise; treat as "no
// baseline" and fall back to the absolute thresholds.
const MIN_BASELINE_SPANS = 100
// With fewer current-window spans than this, the weighted p95 is too noisy to
// flag latency at all (error rate still applies).
const MIN_CURRENT_SPANS = 50

export interface LatencyBaselineSignal {
	p95LatencyMs: number
	spanCount: number
}

interface ServiceSignals {
	errorRate: number
	p95LatencyMs: number
	spanCount: number
	baseline?: LatencyBaselineSignal
}

const SEVERITY_RANK: Record<SeverityLevel, number> = {
	ok: 0,
	warn: 1,
	crit: 2,
}

function maxSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

/**
 * Severity of a p95 latency value. Baseline-relative when the service has a
 * usable baseline; absolute-threshold fallback otherwise.
 */
export function latencySeverity(
	p95LatencyMs: number,
	spanCount?: number,
	baseline?: LatencyBaselineSignal,
): SeverityLevel {
	// Sparse current window → weighted p95 is noise, don't flag latency.
	if (spanCount !== undefined && spanCount < MIN_CURRENT_SPANS) return "ok"

	if (baseline !== undefined && baseline.spanCount >= MIN_BASELINE_SPANS && baseline.p95LatencyMs > 0) {
		const unhealthyAt = Math.max(
			LATENCY_ABS_FLOOR_MS,
			baseline.p95LatencyMs * LATENCY_BASELINE_UNHEALTHY_RATIO,
		)
		const degradedAt = Math.max(
			LATENCY_ABS_FLOOR_MS,
			baseline.p95LatencyMs * LATENCY_BASELINE_DEGRADED_RATIO,
		)
		if (p95LatencyMs >= unhealthyAt) return "crit"
		if (p95LatencyMs >= degradedAt) return "warn"
		return "ok"
	}

	if (p95LatencyMs >= P95_UNHEALTHY_MS) return "crit"
	if (p95LatencyMs >= P95_DEGRADED_MS) return "warn"
	return "ok"
}

const SEVERITY_TO_HEALTH: Record<SeverityLevel, ServiceHealth> = {
	ok: "healthy",
	warn: "degraded",
	crit: "unhealthy",
}

/**
 * Derive a service's health. An open alert incident always forces `unhealthy`
 * — an operator has explicitly decided this service is in a bad state, so it
 * outranks any threshold heuristic. Otherwise health is the worse of the
 * error-rate severity (global absolutes) and the latency severity
 * (baseline-relative, see {@link latencySeverity}).
 */
export function deriveServiceHealth(signals: ServiceSignals, hasOpenIncident: boolean): ServiceHealth {
	if (hasOpenIncident) return "unhealthy"
	const severity = maxSeverity(
		errorRateTone(signals.errorRate),
		latencySeverity(signals.p95LatencyMs, signals.spanCount, signals.baseline),
	)
	return SEVERITY_TO_HEALTH[severity]
}

/** Severity of an error-rate value on its own (independent of latency). */
export function errorRateTone(errorRate: number): SeverityLevel {
	if (errorRate >= ERROR_RATE_UNHEALTHY) return "crit"
	if (errorRate >= ERROR_RATE_DEGRADED) return "warn"
	return "ok"
}

/**
 * Severity of a p95 latency value on its own (independent of error rate).
 * Pass `spanCount`/`baseline` when available so cell tones agree with the
 * health badge; without them this is the legacy absolute-threshold tone.
 */
export function latencyTone(
	p95LatencyMs: number,
	spanCount?: number,
	baseline?: LatencyBaselineSignal,
): SeverityLevel {
	return latencySeverity(p95LatencyMs, spanCount, baseline)
}

/** Map a health level onto the `StatRail`/severity tone vocabulary. */
export function healthToTone(health: ServiceHealth): SeverityLevel {
	switch (health) {
		case "unhealthy":
			return "crit"
		case "degraded":
			return "warn"
		case "healthy":
			return "ok"
	}
}

// Higher = worse; used to sort the most-broken services to the top.
const HEALTH_RANK: Record<ServiceHealth, number> = {
	unhealthy: 2,
	degraded: 1,
	healthy: 0,
}

export function healthRank(health: ServiceHealth): number {
	return HEALTH_RANK[health]
}

/**
 * Key for matching a baseline row to an overview row. Overview metrics collapse
 * namespace variants by service name + environment, then retain the dominant
 * namespace for this baseline lookup. A mismatch silently (and fail-safely)
 * reverts that service to absolute thresholds.
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

// Only the fields the matcher reads — keeps the function testable without
// constructing a full branded `AlertIncidentDocument`.
type IncidentMatchFields = Pick<AlertIncidentDocument, "status" | "groupKey">

/**
 * Best-effort match of an open incident to a service. When an alert rule groups
 * by service, the incident's `groupKey` is the service name. Incidents without
 * a per-service group key (rule spanning many services) won't match here — the
 * org-wide firing count in the banner still counts them exactly.
 */
export function incidentMatchesService(incident: IncidentMatchFields, serviceName: string): boolean {
	return incident.status === "open" && incident.groupKey === serviceName
}
