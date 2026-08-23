import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	ActorType,
	ErrorIssueNotFoundError,
	ErrorPersistenceError,
	IssueKind,
	IssueSeverity,
	IssueSeveritySource,
	WorkflowState,
} from "../errors"
import { SpanId, TraceId, UserId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2CursorInvalid, V2CursorSortMismatch } from "./errors"
import { publicErrors } from "./public-error"
import { V2WarehouseReadErrors } from "./query-errors"
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
	// Fix history, so a consumer can tell "never triaged" from "fixed before and
	// came back" without replaying the event log.
	last_resolved_at: Schema.NullOr(Timestamp),
	last_regressed_at: Schema.NullOr(Timestamp),
	regression_count: Schema.Number,
	resolved_versions: Schema.Array(Schema.String),
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

export const V2ErrorIssueEnvironment = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
}).annotate({
	identifier: "ErrorIssueEnvironment",
	description:
		"A deployment environment the issue was observed in over the requested window, with its occurrence count.",
})
export type V2ErrorIssueEnvironment = Schema.Schema.Type<typeof V2ErrorIssueEnvironment>

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
	environments: Schema.Array(V2ErrorIssueEnvironment),
}).annotate({
	identifier: "ErrorIssueDetail",
	title: "Error issue detail",
	description:
		"The issue resource with its requested timeseries window, sample traces, incidents, and the environments it was seen in.",
})
export type V2ErrorIssueDetail = Schema.Schema.Type<typeof V2ErrorIssueDetail>

export const V2ErrorIssueListQuery = Schema.Struct({
	...ListQuery.fields,
	workflow_state: Schema.optional(WorkflowState),
	severity: Schema.optional(Schema.Union([IssueSeverity, Schema.Literal("unset")])),
	kind: Schema.optional(IssueKind),
	service_name: Schema.optional(Schema.String),
	// Comma-separated fingerprint hashes. The unified errors list ranks
	// fingerprints by warehouse volume first, then asks for exactly those
	// issues — the reverse of the usual "list issues, then look up volume".
	// A repeated param would be the other idiom; a delimited string keeps the
	// v2 query surface to plain scalars, and these hashes are decimal digits so
	// the delimiter is never ambiguous.
	fingerprint_hash: Schema.optional(Schema.String),
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

export const V2ErrorIssueServiceCount = Schema.Struct({
	service_name: Schema.String,
	open_count: Schema.Number,
}).annotate({
	identifier: "ErrorIssueServiceCount",
	title: "Error issue service count",
	description: "Number of open (actionable-state) error issues for one service.",
})
export type V2ErrorIssueServiceCount = Schema.Schema.Type<typeof V2ErrorIssueServiceCount>

const ErrorIssueServiceCountList = ListOf(V2ErrorIssueServiceCount).annotate({
	identifier: "ErrorIssueServiceCountList",
	title: "Error issue service count list",
})

const [errorIssueNotFound, errorPersistence] = publicErrors(ErrorIssueNotFoundError, ErrorPersistenceError)

export class V2ErrorIssuesApiGroup extends HttpApiGroup.make("errorIssues")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2ErrorIssueListQuery,
			success: ErrorIssueList,
			error: [
				V2CursorInvalid.schema,
				V2CursorSortMismatch.schema,
				errorPersistence,
				...V2WarehouseReadErrors,
			],
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
		// Static path — must be registered before the `/:id` param route.
		HttpApiEndpoint.get("serviceCounts", "/service_counts", {
			success: ErrorIssueServiceCountList,
			error: errorPersistence,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listErrorIssueServiceCounts",
				summary: "List open issue counts by service",
				description:
					"Returns the number of open (actionable-state) error issues per service, in one call. Alert-kind issues are excluded. Requires `error_issues:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: ErrorIssuePublicId },
			query: V2ErrorIssueDetailQuery,
			success: V2ErrorIssueDetail,
			error: [errorIssueNotFound, errorPersistence, ...V2WarehouseReadErrors],
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
	.annotateMerge(
		OpenApi.annotations({
			title: "Error Issues",
			description:
				"Deduplicated errors and alert-backed issues tracked through Maple's triage workflow.",
		}),
	) {}
