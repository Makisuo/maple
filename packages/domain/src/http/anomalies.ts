import { Schema } from "effect"
import { AnomalyIncidentId, ErrorIssueId, IsoDateTimeString, UserId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

// Literals

export const AnomalySignalType = Schema.Literals([
	"error_rate",
	"latency_p95",
	"throughput",
	"error_spike",
	"log_volume",
]).annotate({
	identifier: "@maple/AnomalySignalType",
	title: "Anomaly Signal Type",
})
export type AnomalySignalType = Schema.Schema.Type<typeof AnomalySignalType>

export const AnomalyIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
	identifier: "@maple/AnomalyIncidentStatus",
	title: "Anomaly Incident Status",
})
export type AnomalyIncidentStatus = Schema.Schema.Type<typeof AnomalyIncidentStatus>

export const AnomalyIncidentSeverity = Schema.Literals(["warning", "critical"]).annotate({
	identifier: "@maple/AnomalyIncidentSeverity",
	title: "Anomaly Incident Severity",
})
export type AnomalyIncidentSeverity = Schema.Schema.Type<typeof AnomalyIncidentSeverity>

export const AnomalyResolveReason = Schema.Literals(["returned_to_baseline", "no_data", "manual"]).annotate({
	identifier: "@maple/AnomalyResolveReason",
	title: "Anomaly Resolve Reason",
})
export type AnomalyResolveReason = Schema.Schema.Type<typeof AnomalyResolveReason>

export const AnomalySensitivity = Schema.Literals(["low", "normal", "high"]).annotate({
	identifier: "@maple/AnomalySensitivity",
	title: "Anomaly Sensitivity",
})
export type AnomalySensitivity = Schema.Schema.Type<typeof AnomalySensitivity>

export const AnomalyTriageStatus = Schema.Literals(["none", "pending", "completed", "skipped"]).annotate({
	identifier: "@maple/AnomalyTriageStatus",
	title: "Anomaly Triage Status",
})
export type AnomalyTriageStatus = Schema.Schema.Type<typeof AnomalyTriageStatus>

// Documents

/**
 * One fingerprint participating in a (possibly consolidated) error-spike
 * incident. Co-onset fingerprints on the same service+env share one incident
 * instead of opening duplicates.
 */
export class AnomalyIncidentFingerprint extends Schema.Class<AnomalyIncidentFingerprint>(
	"AnomalyIncidentFingerprint",
)({
	fingerprintHash: Schema.String,
	errorIssueId: Schema.NullOr(ErrorIssueId),
	openedValue: Schema.Number,
	lastValue: Schema.Number,
	severity: AnomalyIncidentSeverity,
	attachedAt: IsoDateTimeString,
	resolvedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class AnomalyIncidentDocument extends Schema.Class<AnomalyIncidentDocument>("AnomalyIncidentDocument")(
	{
		id: AnomalyIncidentId,
		detectorKey: Schema.String,
		signalType: AnomalySignalType,
		serviceName: Schema.String,
		deploymentEnv: Schema.String,
		fingerprintHash: Schema.NullOr(Schema.String),
		errorIssueId: Schema.NullOr(ErrorIssueId),
		status: AnomalyIncidentStatus,
		severity: AnomalyIncidentSeverity,
		openedValue: Schema.Number,
		baselineMedian: Schema.Number,
		baselineSigma: Schema.Number,
		thresholdValue: Schema.Number,
		lastObservedValue: Schema.Number,
		lastSampleCount: Schema.Number,
		firstTriggeredAt: IsoDateTimeString,
		lastTriggeredAt: IsoDateTimeString,
		resolvedAt: Schema.NullOr(IsoDateTimeString),
		resolveReason: Schema.NullOr(AnomalyResolveReason),
		triageStatus: AnomalyTriageStatus,
		/** All fingerprints sharing this incident; empty for golden-signal incidents. */
		fingerprints: Schema.Array(AnomalyIncidentFingerprint),
		reopenCount: Schema.Number,
		lastReopenedAt: Schema.NullOr(IsoDateTimeString),
	},
) {}

export class AnomalyIncidentsListResponse extends Schema.Class<AnomalyIncidentsListResponse>(
	"AnomalyIncidentsListResponse",
)({
	incidents: Schema.Array(AnomalyIncidentDocument),
}) {}

export class AnomalyIncidentLinkIssueRequest extends Schema.Class<AnomalyIncidentLinkIssueRequest>(
	"AnomalyIncidentLinkIssueRequest",
)({
	/** Issue to link the incident to; null clears an existing link. */
	issueId: Schema.NullOr(ErrorIssueId),
}) {}

export const AnomalyTimeseriesUnit = Schema.Literals([
	"ratio",
	"milliseconds",
	"per_minute",
	"count_per_30m",
]).annotate({
	identifier: "@maple/AnomalyTimeseriesUnit",
	title: "Anomaly Timeseries Unit",
})
export type AnomalyTimeseriesUnit = Schema.Schema.Type<typeof AnomalyTimeseriesUnit>

export class AnomalyTimeseriesBucket extends Schema.Class<AnomalyTimeseriesBucket>("AnomalyTimeseriesBucket")(
	{
		bucket: IsoDateTimeString,
		value: Schema.Number,
		/** Raw sample volume behind the bucket (requests, error logs, or spike count). */
		sampleCount: Schema.Number,
	},
) {}

export class AnomalyIncidentTimeseriesResponse extends Schema.Class<AnomalyIncidentTimeseriesResponse>(
	"AnomalyIncidentTimeseriesResponse",
)({
	signalType: AnomalySignalType,
	unit: AnomalyTimeseriesUnit,
	bucketSeconds: Schema.Number,
	buckets: Schema.Array(AnomalyTimeseriesBucket),
	baselineMedian: Schema.Number,
	thresholdValue: Schema.Number,
}) {}

export class AnomalyDetectorSettingsDocument extends Schema.Class<AnomalyDetectorSettingsDocument>(
	"AnomalyDetectorSettingsDocument",
)({
	enabled: Schema.Boolean,
	sensitivity: AnomalySensitivity,
	mutedSignals: Schema.Array(AnomalySignalType),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class AnomalyDetectorSettingsUpdateRequest extends Schema.Class<AnomalyDetectorSettingsUpdateRequest>(
	"AnomalyDetectorSettingsUpdateRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	sensitivity: Schema.optionalKey(AnomalySensitivity),
	mutedSignals: Schema.optionalKey(Schema.Array(AnomalySignalType)),
}) {}

// Errors

export class AnomalyPersistenceError extends HttpTaggedError<AnomalyPersistenceError>()(
	"@maple/http/anomalies/AnomalyPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "anomalies_unavailable",
		title: "Anomalies are temporarily unavailable",
		message: "Anomalies are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class AnomalyForbiddenError extends HttpTaggedError<AnomalyForbiddenError>()(
	"@maple/http/anomalies/AnomalyForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "anomaly_settings_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class AnomalyIncidentNotFoundError extends HttpTaggedError<AnomalyIncidentNotFoundError>()(
	"@maple/http/anomalies/AnomalyIncidentNotFoundError",
	{
		message: Schema.String,
		incidentId: AnomalyIncidentId,
	},
	{
		status: 404,
		code: "anomaly_incident_not_found",
		title: "Anomaly incident not found",
		message: "No such anomaly incident.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class AnomalyLinkedIssueNotFoundError extends HttpTaggedError<AnomalyLinkedIssueNotFoundError>()(
	"@maple/http/anomalies/AnomalyLinkedIssueNotFoundError",
	{
		message: Schema.String,
		issueId: ErrorIssueId,
	},
	{
		status: 404,
		code: "error_issue_not_found",
		title: "Error issue not found",
		message: "No such error issue.",
		param: "issue_id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
