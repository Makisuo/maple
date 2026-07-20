import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ActorType, IssueKind, IssueSeverity, IssueSeveritySource, WorkflowState } from "../errors"
import { SpanId, TraceId, UserId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { ActorPublicId, ErrorIncidentPublicId, ErrorIssuePublicId } from "./resource-ids"

export const V2ErrorIssueActor = Schema.Struct({
	id: ActorPublicId,
	type: ActorType,
	user_id: Schema.NullOr(UserId),
	agent_name: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	capabilities: Schema.Array(Schema.String),
	last_active_at: Schema.NullOr(Timestamp),
}).annotate({
	identifier: "ErrorIssueActor",
	title: "Error issue actor",
	description: "A user or agent assigned to, or currently holding the lease for, an error issue.",
})
export type V2ErrorIssueActor = Schema.Schema.Type<typeof V2ErrorIssueActor>

export const V2ErrorIssue = Schema.Struct({
	id: ErrorIssuePublicId,
	object: Schema.Literal("error_issue"),
	kind: IssueKind,
	fingerprint_hash: Schema.String,
	service_name: Schema.String,
	exception_type: Schema.String,
	exception_message: Schema.String,
	error_label: Schema.String,
	top_frame: Schema.String,
	workflow_state: WorkflowState,
	priority: Schema.Number,
	severity: Schema.NullOr(IssueSeverity),
	severity_source: Schema.NullOr(IssueSeveritySource),
	source_ref: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
	assigned_actor: Schema.NullOr(V2ErrorIssueActor),
	lease_holder: Schema.NullOr(V2ErrorIssueActor),
	lease_expires_at: Schema.NullOr(Timestamp),
	claimed_at: Schema.NullOr(Timestamp),
	notes: Schema.NullOr(Schema.String),
	first_seen_at: Timestamp,
	last_seen_at: Timestamp,
	occurrence_count: Schema.Number,
	resolved_at: Schema.NullOr(Timestamp),
	snooze_until: Schema.NullOr(Timestamp),
	archived_at: Schema.NullOr(Timestamp),
	has_open_incident: Schema.Boolean,
}).annotate({
	identifier: "ErrorIssue",
	title: "Error issue",
	description: "A deduplicated error, alert, or integration issue tracked through Maple's workflow.",
})
export type V2ErrorIssue = Schema.Schema.Type<typeof V2ErrorIssue>

export const V2ErrorIssueTimeseriesPoint = Schema.Struct({
	bucket: Timestamp,
	count: Schema.Number,
}).annotate({ identifier: "ErrorIssueTimeseriesPoint" })
export type V2ErrorIssueTimeseriesPoint = Schema.Schema.Type<typeof V2ErrorIssueTimeseriesPoint>

export const V2ErrorIssueSampleTrace = Schema.Struct({
	trace_id: TraceId,
	span_id: SpanId,
	service_name: Schema.String,
	timestamp: Timestamp,
	exception_message: Schema.String,
	duration_micros: Schema.Number,
}).annotate({ identifier: "ErrorIssueSampleTrace" })
export type V2ErrorIssueSampleTrace = Schema.Schema.Type<typeof V2ErrorIssueSampleTrace>

export const V2ErrorIncident = Schema.Struct({
	id: ErrorIncidentPublicId,
	object: Schema.Literal("error_incident"),
	issue_id: ErrorIssuePublicId,
	status: Schema.Literals(["open", "resolved"]),
	reason: Schema.Literals(["first_seen", "regression", "manual"]),
	first_triggered_at: Timestamp,
	last_triggered_at: Timestamp,
	resolved_at: Schema.NullOr(Timestamp),
	occurrence_count: Schema.Number,
}).annotate({ identifier: "ErrorIncident", title: "Error incident" })
export type V2ErrorIncident = Schema.Schema.Type<typeof V2ErrorIncident>

export const V2ErrorIssueDetail = Schema.Struct({
	...V2ErrorIssue.fields,
	timeseries: Schema.Array(V2ErrorIssueTimeseriesPoint),
	sample_traces: Schema.Array(V2ErrorIssueSampleTrace),
	incidents: Schema.Array(V2ErrorIncident),
}).annotate({
	identifier: "ErrorIssueDetail",
	title: "Error issue detail",
	description: "The issue resource with its requested timeseries window, sample traces, and incidents.",
})
export type V2ErrorIssueDetail = Schema.Schema.Type<typeof V2ErrorIssueDetail>

export const V2ErrorIssueListQuery = Schema.Struct({
	...ListQuery.fields,
	workflow_state: Schema.optional(WorkflowState),
	severity: Schema.optional(Schema.Union([IssueSeverity, Schema.Literal("unset")])),
	kind: Schema.optional(IssueKind),
	service_name: Schema.optional(Schema.String),
	// Only issues observed in this deployment environment (resolved against the
	// warehouse's error events, scoped by start_time/end_time when provided).
	// Alert-kind issues carry no environment and are excluded when this is set.
	deployment_environment: Schema.optional(Schema.String),
	// Activity window: last_seen_at > start_time and first_seen_at < end_time.
	// Also bounds the deployment_environment lookup.
	start_time: Schema.optional(Timestamp),
	end_time: Schema.optional(Timestamp),
	actionable: Schema.optional(Schema.Literal("true")),
	sort: Schema.optional(Schema.Literals(["last_seen", "severity"])),
}).annotate({
	identifier: "ErrorIssueListQuery",
	title: "Error issue list query",
})

export const V2ErrorIssueDetailQuery = Schema.Struct({
	start_time: Schema.optional(Timestamp),
	end_time: Schema.optional(Timestamp),
	bucket_seconds: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 60, maximum: 86_400 })),
	),
	sample_limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
})

const ErrorIssueList = ListOf(V2ErrorIssue).annotate({
	identifier: "ErrorIssueList",
	title: "Error issue list",
})
const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

export class V2ErrorIssuesApiGroup extends HttpApiGroup.make("errorIssues")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2ErrorIssueListQuery,
			success: ErrorIssueList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listErrorIssues",
				summary: "List error issues",
				description:
					"Returns a bounded, cursor-paginated page of your organization's issues. Requires `error_issues:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: ErrorIssuePublicId },
			query: V2ErrorIssueDetailQuery,
			success: V2ErrorIssueDetail,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getErrorIssue",
				summary: "Retrieve an error issue",
				description:
					"Returns an issue with its timeseries, representative traces, and incident history. Requires `error_issues:read`.",
			}),
		),
	)
	.prefix("/v2/error_issues")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Error Issues",
			description:
				"Deduplicated errors and alert-backed issues tracked through Maple's triage workflow.",
		}),
	) {}
