import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { UserId } from "../../primitives"
import {
	AnomalyIncidentSeverity,
	AnomalyIncidentStatus,
	AnomalyResolveReason,
	AnomalySensitivity,
	AnomalySignalType,
	AnomalyTimeseriesUnit,
	AnomalyTriageStatus,
} from "../anomalies"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
} from "./errors"
import { AnomalyIncidentPublicId, ErrorIssuePublicId } from "./resource-ids"

export { AnomalyIncidentPublicId } from "./resource-ids"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

const signalTypeField = AnomalySignalType.annotate({
	description: "The monitored signal that triggered the anomaly.",
	examples: ["error_rate"],
})

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** One fingerprint sharing a consolidated error-spike incident. */
const V2AnomalyIncidentFingerprint = Schema.Struct({
	fingerprint_hash: Schema.String.annotate({ description: "The error fingerprint hash." }),
	error_issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The `iss_…` error issue for this fingerprint, or `null`.",
	}),
	opened_value: Schema.Number.annotate({ description: "The signal value when this fingerprint attached." }),
	last_value: Schema.Number.annotate({ description: "The most recent signal value for this fingerprint." }),
	severity: AnomalyIncidentSeverity.annotate({ description: "Severity contributed by this fingerprint." }),
	attached_at: Timestamp.annotate({ description: "When this fingerprint attached to the incident." }),
	resolved_at: Schema.NullOr(Timestamp).annotate({
		description: "When this fingerprint returned to baseline, or `null`.",
	}),
}).annotate({
	identifier: "AnomalyIncidentFingerprint",
	title: "Anomaly incident fingerprint",
	description: "One error fingerprint participating in a consolidated error-spike incident.",
})

const anomalyIncidentExample = {
	id: "anom_YofPTrK9782DWwcnXhpcCw",
	object: "anomaly_incident",
	detector_key: "error_rate:payments:production",
	signal_type: "error_rate",
	service_name: "payments",
	deployment_env: "production",
	fingerprint_hash: null,
	error_issue_id: null,
	status: "open",
	severity: "critical",
	opened_value: 0.12,
	baseline_median: 0.01,
	baseline_sigma: 0.004,
	threshold_value: 0.05,
	last_observed_value: 0.14,
	last_sample_count: 4200,
	first_triggered_at: "2026-07-15T09:12:00.000Z",
	last_triggered_at: "2026-07-15T09:18:00.000Z",
	resolved_at: null,
	resolve_reason: null,
	triage_status: "completed",
	fingerprints: [],
	reopen_count: 0,
	last_reopened_at: null,
} as const

export const V2AnomalyIncident = Schema.Struct({
	id: AnomalyIncidentPublicId,
	object: Schema.Literal("anomaly_incident").annotate({
		description: 'The object type — always `"anomaly_incident"`.',
		examples: ["anomaly_incident"],
	}),
	detector_key: Schema.String.annotate({
		description: "Stable key identifying the detector (signal + service + env) that opened the incident.",
	}),
	signal_type: signalTypeField,
	service_name: Schema.String.annotate({ description: "The service the anomaly was detected on." }),
	deployment_env: Schema.String.annotate({
		description: "The deployment environment (e.g. `production`).",
	}),
	fingerprint_hash: Schema.NullOr(Schema.String).annotate({
		description:
			"The error fingerprint for `error_spike` incidents, or `null` for golden-signal incidents.",
	}),
	error_issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The `iss_…` error issue linked to the incident, or `null`.",
	}),
	status: AnomalyIncidentStatus.annotate({
		description: "Incident status: `open` or `resolved`.",
		examples: ["open"],
	}),
	severity: AnomalyIncidentSeverity.annotate({
		description: "Incident severity: `warning` or `critical`.",
		examples: ["critical"],
	}),
	opened_value: Schema.Number.annotate({ description: "The signal value when the incident opened." }),
	baseline_median: Schema.Number.annotate({ description: "The learned baseline median for the signal." }),
	baseline_sigma: Schema.Number.annotate({ description: "The learned baseline standard deviation." }),
	threshold_value: Schema.Number.annotate({ description: "The threshold the signal crossed to trigger." }),
	last_observed_value: Schema.Number.annotate({ description: "The most recent observed signal value." }),
	last_sample_count: Schema.Number.annotate({
		description: "Raw sample volume behind the last observation.",
	}),
	first_triggered_at: Timestamp.annotate({ description: "When the incident first triggered." }),
	last_triggered_at: Timestamp.annotate({ description: "When the incident most recently triggered." }),
	resolved_at: Schema.NullOr(Timestamp).annotate({ description: "When the incident resolved, or `null`." }),
	resolve_reason: Schema.NullOr(AnomalyResolveReason).annotate({
		description: "Why the incident resolved (`returned_to_baseline`, `no_data`, `manual`), or `null`.",
	}),
	triage_status: AnomalyTriageStatus.annotate({
		description: "AI-triage state for the incident (`none`, `pending`, `completed`, `skipped`).",
	}),
	fingerprints: Schema.Array(V2AnomalyIncidentFingerprint).annotate({
		description: "Fingerprints sharing this incident; empty for golden-signal incidents.",
	}),
	reopen_count: Schema.Number.annotate({ description: "How many times the incident has reopened." }),
	last_reopened_at: Schema.NullOr(Timestamp).annotate({
		description: "When the incident last reopened, or `null`.",
	}),
}).annotate({
	identifier: "AnomalyIncident",
	title: "Anomaly incident",
	description:
		"A detected anomaly on a monitored signal (error rate, latency, throughput, error spike, or log volume) for a service and environment, opened by Maple's baseline detector.",
	examples: [wireExample(anomalyIncidentExample)],
})
export type V2AnomalyIncident = Schema.Schema.Type<typeof V2AnomalyIncident>

const V2AnomalyTimeseriesBucket = Schema.Struct({
	bucket: Timestamp.annotate({ description: "Bucket start time." }),
	value: Schema.Number.annotate({ description: "The signal value in the bucket." }),
	sample_count: Schema.Number.annotate({ description: "Raw sample volume behind the bucket." }),
}).annotate({ identifier: "AnomalyTimeseriesBucket", title: "Anomaly timeseries bucket" })

export const V2AnomalyIncidentTimeseries = Schema.Struct({
	object: Schema.Literal("anomaly_incident.timeseries").annotate({
		description: 'The object type — always `"anomaly_incident.timeseries"`.',
	}),
	signal_type: signalTypeField,
	unit: AnomalyTimeseriesUnit.annotate({
		description:
			"The unit of the bucketed values (`ratio`, `milliseconds`, `per_minute`, `count_per_30m`).",
	}),
	bucket_seconds: Schema.Number.annotate({ description: "Bucket width in seconds." }),
	buckets: Schema.Array(V2AnomalyTimeseriesBucket).annotate({
		description: "The signal timeseries around the incident window.",
	}),
	baseline_median: Schema.Number.annotate({ description: "The baseline median overlaid on the chart." }),
	threshold_value: Schema.Number.annotate({ description: "The threshold overlaid on the chart." }),
}).annotate({
	identifier: "AnomalyIncidentTimeseries",
	title: "Anomaly incident timeseries",
	description: "The monitored signal's timeseries around an incident, with the baseline and threshold.",
	examples: [
		wireExample({
			object: "anomaly_incident.timeseries",
			signal_type: "error_rate",
			unit: "ratio",
			bucket_seconds: 300,
			buckets: [{ bucket: "2026-07-15T09:10:00.000Z", value: 0.12, sample_count: 4200 }],
			baseline_median: 0.01,
			threshold_value: 0.05,
		}),
	],
})
export type V2AnomalyIncidentTimeseries = Schema.Schema.Type<typeof V2AnomalyIncidentTimeseries>

export const V2AnomalySettings = Schema.Struct({
	object: Schema.Literal("anomaly_settings").annotate({
		description: 'The object type — always `"anomaly_settings"`.',
	}),
	enabled: Schema.Boolean.annotate({ description: "Whether anomaly detection is enabled for the org." }),
	sensitivity: AnomalySensitivity.annotate({
		description: "Detector sensitivity (`low`, `normal`, `high`).",
		examples: ["normal"],
	}),
	muted_signals: Schema.Array(AnomalySignalType).annotate({
		description: "Signals the detector ignores.",
	}),
	updated_at: Schema.NullOr(Timestamp).annotate({
		description: "When settings were last updated, or `null`.",
	}),
	updated_by: Schema.NullOr(UserId).annotate({
		description: "The `user_…` who last updated settings, or `null`.",
	}),
}).annotate({
	identifier: "AnomalySettings",
	title: "Anomaly detector settings",
	description: "Org-wide anomaly detector configuration.",
	examples: [
		wireExample({
			object: "anomaly_settings",
			enabled: true,
			sensitivity: "normal",
			muted_signals: [],
			updated_at: "2026-07-15T09:12:00.000Z",
			updated_by: "user_2abc",
		}),
	],
})
export type V2AnomalySettings = Schema.Schema.Type<typeof V2AnomalySettings>

// ---------------------------------------------------------------------------
// Requests / queries
// ---------------------------------------------------------------------------

export const V2AnomalyLinkIssueParams = Schema.Struct({
	issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The `iss_…` error issue to link, or `null` to clear an existing link.",
	}),
}).annotate({
	identifier: "AnomalyLinkIssueParams",
	title: "Anomaly link-issue parameters",
	description: "Request body for linking (or unlinking) an error issue to an incident.",
	examples: [wireExample({ issue_id: "iss_YofPTrK9782DWwcnXhpcCw" })],
})
export type V2AnomalyLinkIssueParams = Schema.Schema.Type<typeof V2AnomalyLinkIssueParams>

export const V2AnomalySettingsUpdateParams = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Enable or disable detection." })),
	sensitivity: Schema.optionalKey(
		AnomalySensitivity.annotate({ description: "Set detector sensitivity." }),
	),
	muted_signals: Schema.optionalKey(
		Schema.Array(AnomalySignalType).annotate({ description: "Replace the set of muted signals." }),
	),
}).annotate({
	identifier: "AnomalySettingsUpdateParams",
	title: "Anomaly settings update parameters",
	description: "Request body for updating the detector settings. Omitted fields are left unchanged.",
	examples: [wireExample({ sensitivity: "high" })],
})
export type V2AnomalySettingsUpdateParams = Schema.Schema.Type<typeof V2AnomalySettingsUpdateParams>

export const V2AnomalyIncidentsListQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(AnomalyIncidentStatus.annotate({ description: "Filter by incident status." })),
	signal_type: Schema.optional(AnomalySignalType.annotate({ description: "Filter by signal type." })),
	service_name: Schema.optional(Schema.String.annotate({ description: "Filter by service name." })),
	deployment_env: Schema.optional(
		Schema.String.annotate({ description: "Filter by deployment environment." }),
	),
	error_issue_id: Schema.optional(
		ErrorIssuePublicId.annotate({ description: "Filter by linked `iss_…` error issue." }),
	),
	start_time: Schema.optional(
		Timestamp.annotate({ description: "Only incidents triggered at or after this time." }),
	),
	end_time: Schema.optional(
		Timestamp.annotate({ description: "Only incidents triggered at or before this time." }),
	),
}).annotate({
	identifier: "AnomalyIncidentsListQuery",
	title: "Anomaly incidents list query",
	description: "Pagination plus optional filters for the anomaly incidents list.",
})
export type V2AnomalyIncidentsListQuery = Schema.Schema.Type<typeof V2AnomalyIncidentsListQuery>

export const V2AnomalyTimeseriesQuery = Schema.Struct({
	start_time: Schema.optional(
		Timestamp.annotate({ description: "Window start; defaults to the incident window." }),
	),
	end_time: Schema.optional(
		Timestamp.annotate({ description: "Window end; defaults to the incident window." }),
	),
}).annotate({
	identifier: "AnomalyTimeseriesQuery",
	title: "Anomaly timeseries query",
	description: "Optional time window for the incident timeseries.",
})
export type V2AnomalyTimeseriesQuery = Schema.Schema.Type<typeof V2AnomalyTimeseriesQuery>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const AnomalyIncidentList = ListOf(V2AnomalyIncident).annotate({
	identifier: "AnomalyIncidentList",
	title: "Anomaly incident list",
	description: "A cursor-paginated page of anomaly incidents, newest first.",
})

export class V2AnomaliesApiGroup extends HttpApiGroup.make("anomalies")
	.add(
		HttpApiEndpoint.get("listIncidents", "/incidents", {
			query: V2AnomalyIncidentsListQuery,
			success: AnomalyIncidentList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAnomalyIncidents",
				summary: "List anomaly incidents",
				description:
					"Returns your organization's anomaly incidents, newest first, with optional filters. Cursor-paginated. Requires the `anomalies:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("getIncident", "/incidents/:id", {
			params: { id: AnomalyIncidentPublicId },
			success: V2AnomalyIncident,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAnomalyIncident",
				summary: "Retrieve an anomaly incident",
				description:
					"Returns a single anomaly incident by its `anom_…` ID. Requires the `anomalies:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("getIncidentTimeseries", "/incidents/:id/timeseries", {
			params: { id: AnomalyIncidentPublicId },
			query: V2AnomalyTimeseriesQuery,
			success: V2AnomalyIncidentTimeseries,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAnomalyIncidentTimeseries",
				summary: "Retrieve incident timeseries",
				description:
					"Returns the monitored signal's timeseries around the incident, with baseline and threshold overlays. Requires the `anomalies:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("resolveIncident", "/incidents/:id/resolve", {
			params: { id: AnomalyIncidentPublicId },
			success: V2AnomalyIncident,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveAnomalyIncident",
				summary: "Resolve an anomaly incident",
				description:
					"Manually resolves an open anomaly incident and returns it. Requires the `anomalies:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("setIncidentIssue", "/incidents/:id/issue", {
			params: { id: AnomalyIncidentPublicId },
			payload: V2AnomalyLinkIssueParams,
			success: V2AnomalyIncident,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "setAnomalyIncidentIssue",
				summary: "Link an error issue to an incident",
				description:
					"Links (or unlinks, with `issue_id: null`) an error issue to an anomaly incident. Requires the `anomalies:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: V2AnomalySettings,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAnomalySettings",
				summary: "Retrieve anomaly settings",
				description:
					"Returns the org-wide anomaly detector settings. Requires the `anomalies:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateSettings", "/settings", {
			payload: V2AnomalySettingsUpdateParams,
			success: V2AnomalySettings,
			error: [...commonErrors, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAnomalySettings",
				summary: "Update anomaly settings",
				description:
					"Updates the org-wide detector settings; omitted fields are unchanged. Org-admin only. Requires the `anomalies:write` scope.",
			}),
		),
	)
	.prefix("/v2/anomalies")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Anomalies",
			description:
				"Baseline-detected anomalies on monitored signals — list and inspect incidents, resolve them, link error issues, and manage detector settings.",
		}),
	) {}
