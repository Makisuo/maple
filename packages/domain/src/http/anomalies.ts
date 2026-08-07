import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AnomalyIncidentId, ErrorIssueId, IsoDateTimeString, UserId } from "../primitives"
import { Authorization } from "./current-tenant"

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AnomalyPersistenceError extends Schema.TaggedError<AnomalyPersistenceError>()(
	"@maple/http/anomalies/AnomalyPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AnomalyForbiddenError extends Schema.TaggedError<AnomalyForbiddenError>()(
	"@maple/http/anomalies/AnomalyForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class AnomalyIncidentNotFoundError extends Schema.TaggedError<AnomalyIncidentNotFoundError>()(
	"@maple/http/anomalies/AnomalyIncidentNotFoundError",
	{
		message: Schema.String,
		incidentId: AnomalyIncidentId,
	},
	{ httpApiStatus: 404 },
) {}

export class AnomalyLinkedIssueNotFoundError extends Schema.TaggedError<AnomalyLinkedIssueNotFoundError>()(
	"@maple/http/anomalies/AnomalyLinkedIssueNotFoundError",
	{
		message: Schema.String,
		issueId: ErrorIssueId,
	},
	{ httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const IncidentListQuery = Schema.Struct({
	status: Schema.optional(AnomalyIncidentStatus),
	signalType: Schema.optional(AnomalySignalType),
	service: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(Schema.String),
	errorIssueId: Schema.optional(ErrorIssueId),
	startTime: Schema.optional(IsoDateTimeString),
	endTime: Schema.optional(IsoDateTimeString),
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
})

const IncidentTimeseriesQuery = Schema.Struct({
	startTime: Schema.optional(IsoDateTimeString),
	endTime: Schema.optional(IsoDateTimeString),
})

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class AnomaliesApiGroup extends HttpApiGroup.make("anomalies")
	.add(
		HttpApiEndpoint.get("listIncidents", "/incidents", {
			query: IncidentListQuery,
			success: AnomalyIncidentsListResponse,
			error: AnomalyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getIncident", "/incidents/:incidentId", {
			params: { incidentId: AnomalyIncidentId },
			success: AnomalyIncidentDocument,
			error: [AnomalyPersistenceError, AnomalyIncidentNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getIncidentTimeseries", "/incidents/:incidentId/timeseries", {
			params: { incidentId: AnomalyIncidentId },
			query: IncidentTimeseriesQuery,
			success: AnomalyIncidentTimeseriesResponse,
			error: [AnomalyPersistenceError, AnomalyIncidentNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("resolveIncident", "/incidents/:incidentId/resolve", {
			params: { incidentId: AnomalyIncidentId },
			success: AnomalyIncidentDocument,
			error: [AnomalyPersistenceError, AnomalyIncidentNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.put("setIncidentIssue", "/incidents/:incidentId/issue", {
			params: { incidentId: AnomalyIncidentId },
			payload: AnomalyIncidentLinkIssueRequest,
			success: AnomalyIncidentDocument,
			error: [AnomalyPersistenceError, AnomalyIncidentNotFoundError, AnomalyLinkedIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: AnomalyDetectorSettingsDocument,
			error: AnomalyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSettings", "/settings", {
			payload: AnomalyDetectorSettingsUpdateRequest,
			success: AnomalyDetectorSettingsDocument,
			error: [AnomalyPersistenceError, AnomalyForbiddenError],
		}),
	)
	.prefix("/api/anomalies")
	.middleware(Authorization) {}
