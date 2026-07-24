import type {
	AnomalyIncidentDocument,
	AnomalyResolveReason,
	AnomalySignalType,
	AnomalyTriageStatus,
} from "@maple/domain/http"
import { BoltIcon, ChartLineIcon, CircleWarningIcon, FileIcon, PulseIcon } from "@/components/icons"

export const SIGNAL_LABEL: Record<AnomalySignalType, string> = {
	error_rate: "Error rate",
	latency_p95: "p95 latency",
	throughput: "Throughput",
	error_spike: "Error frequency increase",
	log_volume: "Log volume",
}

export const ANOMALY_STALE_AFTER_MS = 60 * 60 * 1000

export function isStaleOpenIncident(
	incident: {
		readonly status: AnomalyIncidentDocument["status"]
		readonly lastTriggeredAt: string
	},
	nowMs = Date.now(),
): boolean {
	if (incident.status !== "open") return false
	const lastTriggeredMs = Date.parse(incident.lastTriggeredAt)
	return !Number.isFinite(lastTriggeredMs) || nowMs - lastTriggeredMs > ANOMALY_STALE_AFTER_MS
}

/**
 * Fingerprint-frequency regressions remain useful investigation events, but
 * they are not service-health signals. Error-rate incidents own that meaning.
 */
export function anomalyAffectsServiceHealth(
	incident: {
		readonly status: AnomalyIncidentDocument["status"]
		readonly signalType: AnomalyIncidentDocument["signalType"]
		readonly lastTriggeredAt: string
	},
	nowMs = Date.now(),
): boolean {
	return (
		incident.status === "open" &&
		incident.signalType !== "error_spike" &&
		!isStaleOpenIncident(incident, nowMs)
	)
}

export const SIGNAL_ICON: Record<AnomalySignalType, typeof PulseIcon> = {
	error_rate: CircleWarningIcon,
	latency_p95: ChartLineIcon,
	throughput: PulseIcon,
	error_spike: BoltIcon,
	log_volume: FileIcon,
}

export function formatSignalValue(signalType: AnomalySignalType, value: number): string {
	switch (signalType) {
		case "error_rate":
			return `${(value * 100).toFixed(1)}%`
		case "latency_p95":
			return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`
		case "throughput":
		case "log_volume":
			return `${value.toFixed(1)}/min`
		case "error_spike":
			return `${Math.round(value)} occurrences / 30m`
	}
}

export interface AnomalyDeviation {
	readonly kind: "sigma" | "ratio" | "percent" | "new"
	readonly sigma: number | null
	readonly ratio: number | null
	/** Canonical short label, e.g. "+3.2σ", "4.1× baseline", or "−83%". */
	readonly label: string
}

/**
 * Past this many sigmas a z-score stops communicating anything ("+99.4σ");
 * switch to a ratio, which still reads at any magnitude.
 */
const SIGMA_LABEL_LIMIT = 10
const RATIO_LABEL_CAP = 999

const ratioLabel = (ratio: number): string =>
	`${Math.min(ratio, RATIO_LABEL_CAP).toFixed(ratio >= 10 ? 0 : 1)}× baseline`

/**
 * One canonical deviation figure used by rows, hero, and sidebar so the
 * numbers never disagree between surfaces.
 */
export function deviation(
	incident: Pick<
		AnomalyIncidentDocument,
		"signalType" | "lastObservedValue" | "baselineMedian" | "baselineSigma"
	>,
): AnomalyDeviation {
	// Throughput drops read as a percent of baseline — the MAD-derived σ on
	// drop-clamped thresholds produces honest-but-meaningless figures ("−1.2σ"
	// for a full outage).
	if (incident.signalType === "throughput" && incident.baselineMedian > 0) {
		const ratio = incident.lastObservedValue / incident.baselineMedian
		const percent = (ratio - 1) * 100
		const sign = percent >= 0 ? "+" : "−"
		return { kind: "percent", sigma: null, ratio, label: `${sign}${Math.abs(percent).toFixed(0)}%` }
	}
	const delta = incident.lastObservedValue - incident.baselineMedian
	if (incident.baselineSigma > 0) {
		const sigma = delta / incident.baselineSigma
		if (Math.abs(sigma) > SIGMA_LABEL_LIMIT && incident.baselineMedian > 0) {
			const ratio = incident.lastObservedValue / incident.baselineMedian
			return { kind: "ratio", sigma, ratio, label: ratioLabel(ratio) }
		}
		const sign = sigma >= 0 ? "+" : "−"
		return { kind: "sigma", sigma, ratio: null, label: `${sign}${Math.abs(sigma).toFixed(1)}σ` }
	}
	if (incident.baselineMedian > 0) {
		const ratio = incident.lastObservedValue / incident.baselineMedian
		return { kind: "ratio", sigma: null, ratio, label: ratioLabel(ratio) }
	}
	return { kind: "new", sigma: null, ratio: null, label: "new signal" }
}

export interface SeverityTone {
	/** Badge/chip classes, e.g. "bg-destructive/10 text-destructive". */
	readonly badge: string
	/** Solid accent (left bar, dots). */
	readonly accent: string
	/** Plain text tone. */
	readonly text: string
}

export const SEVERITY_TONE: Record<"critical" | "warning" | "resolved", SeverityTone> = {
	critical: {
		badge: "bg-destructive/10 text-destructive",
		accent: "bg-destructive",
		text: "text-destructive",
	},
	warning: {
		badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
		accent: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	resolved: {
		badge: "bg-muted text-muted-foreground",
		accent: "bg-border/60",
		text: "text-muted-foreground",
	},
}

export function severityToneFor(
	incident: Pick<AnomalyIncidentDocument, "status" | "severity">,
): SeverityTone {
	if (incident.status !== "open") return SEVERITY_TONE.resolved
	return SEVERITY_TONE[incident.severity]
}

export const RESOLVE_REASON_LABEL: Record<AnomalyResolveReason, string> = {
	returned_to_baseline: "Returned to baseline",
	no_data: "No data",
	manual: "Resolved manually",
}

export const TRIAGE_STATUS_CHIP: Record<AnomalyTriageStatus, { label: string; tone: string } | null> = {
	none: null,
	pending: { label: "triaging…", tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
	completed: { label: "triaged", tone: "bg-success/10 text-success" },
	skipped: { label: "triage skipped", tone: "bg-muted text-muted-foreground" },
}
