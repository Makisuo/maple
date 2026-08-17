import {
	AnomalyIncidentDocument,
	AnomalyIncidentFingerprint,
	AnomalyIncidentTimeseriesResponse,
	AnomalyTimeseriesBucket,
	IsoDateTimeString,
} from "@maple/domain/http"
import type {
	V2AnomalyIncident,
	V2AnomalyIncidentTimeseries,
	V2AnomalyServiceCount,
} from "@maple/domain/http/v2"
import { Schema } from "effect"

/**
 * v2 wire → the domain documents the anomaly components are typed on.
 *
 * Mirrors `error-issues.ts`. Keeping the rename in one module is what lets the
 * ~12 components that consume `AnomalyIncidentDocument` stay untouched by the
 * v1 → v2 migration; their tests double as its regression oracle.
 *
 * Both wires are already ISO-8601, so this is a field rename, not a format
 * conversion — `asIso` only re-applies the domain brand.
 */
const asIso = Schema.decodeUnknownSync(IsoDateTimeString)
const asIsoOrNull = (value: string | null) => (value === null ? null : asIso(value))

export const anomalyIncidentFromV2 = (incident: V2AnomalyIncident): AnomalyIncidentDocument =>
	new AnomalyIncidentDocument({
		id: incident.id,
		detectorKey: incident.detector_key,
		signalType: incident.signal_type,
		serviceName: incident.service_name,
		deploymentEnv: incident.deployment_env,
		fingerprintHash: incident.fingerprint_hash,
		errorIssueId: incident.error_issue_id,
		status: incident.status,
		severity: incident.severity,
		openedValue: incident.opened_value,
		baselineMedian: incident.baseline_median,
		baselineSigma: incident.baseline_sigma,
		thresholdValue: incident.threshold_value,
		lastObservedValue: incident.last_observed_value,
		lastSampleCount: incident.last_sample_count,
		firstTriggeredAt: asIso(incident.first_triggered_at),
		lastTriggeredAt: asIso(incident.last_triggered_at),
		resolvedAt: asIsoOrNull(incident.resolved_at),
		resolveReason: incident.resolve_reason,
		triageStatus: incident.triage_status,
		fingerprints: incident.fingerprints.map(
			(fingerprint) =>
				new AnomalyIncidentFingerprint({
					fingerprintHash: fingerprint.fingerprint_hash,
					errorIssueId: fingerprint.error_issue_id,
					openedValue: fingerprint.opened_value,
					lastValue: fingerprint.last_value,
					severity: fingerprint.severity,
					attachedAt: asIso(fingerprint.attached_at),
					resolvedAt: asIsoOrNull(fingerprint.resolved_at),
				}),
		),
		reopenCount: incident.reopen_count,
		lastReopenedAt: asIsoOrNull(incident.last_reopened_at),
	})

export const anomalyTimeseriesFromV2 = (
	timeseries: V2AnomalyIncidentTimeseries,
): AnomalyIncidentTimeseriesResponse =>
	new AnomalyIncidentTimeseriesResponse({
		signalType: timeseries.signal_type,
		unit: timeseries.unit,
		bucketSeconds: timeseries.bucket_seconds,
		buckets: timeseries.buckets.map(
			(bucket) =>
				new AnomalyTimeseriesBucket({
					bucket: asIso(bucket.bucket),
					value: bucket.value,
					sampleCount: bucket.sample_count,
				}),
		),
		baselineMedian: timeseries.baseline_median,
		thresholdValue: timeseries.threshold_value,
	})

/**
 * One (service, environment, signal) group from `/v2/anomalies/incidents/service_counts`.
 *
 * Deliberately not an `AnomalyIncidentDocument`: the fleet-health surfaces only
 * ever shaded rows from these five fields, and pretending a group is an incident
 * would invent an id that identifies nothing.
 */
export interface AnomalyServiceCount {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly signalType: AnomalyIncidentDocument["signalType"]
	readonly severity: AnomalyIncidentDocument["severity"]
	readonly incidentCount: number
	readonly lastTriggeredAt: string
	readonly status: AnomalyIncidentDocument["status"]
}

export const anomalyServiceCountFromV2 = (row: V2AnomalyServiceCount): AnomalyServiceCount => ({
	serviceName: row.service_name,
	deploymentEnv: row.deployment_env,
	signalType: row.signal_type,
	severity: row.severity,
	incidentCount: row.incident_count,
	lastTriggeredAt: row.last_triggered_at,
	// The endpoint aggregates open incidents; carrying the status keeps
	// `anomalyAffectsServiceHealth`'s predicate readable at the call site.
	status: "open",
})
