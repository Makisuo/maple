import {
	ActorDocument,
	ActorId,
	ActorType,
	ErrorIncidentDocument,
	ErrorIncidentId,
	ErrorIncidentReason,
	ErrorIncidentStatus,
	ErrorIssueDocument,
	ErrorIssueId,
	IssueKind,
	IssueSeverity,
	IssueSeveritySource,
	IsoDateTimeString,
	UserId,
	WorkflowState,
} from "@maple/domain/http"
import { Option, Schema } from "effect"
import { createSyncedCollection, timestamptzParser } from "./shape-fetch"

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
const asActorId = Schema.decodeUnknownSync(ActorId)
const asActorType = Schema.decodeUnknownSync(ActorType)
const asUserId = Schema.decodeUnknownSync(UserId)
const asErrorIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const asErrorIncidentId = Schema.decodeUnknownSync(ErrorIncidentId)
const asIssueKind = Schema.decodeUnknownSync(IssueKind)
const asWorkflowState = Schema.decodeUnknownSync(WorkflowState)
const asSeverity = Schema.decodeUnknownSync(IssueSeverity)
const asSeveritySource = Schema.decodeUnknownSync(IssueSeveritySource)
const asIncidentStatus = Schema.decodeUnknownSync(ErrorIncidentStatus)
const asIncidentReason = Schema.decodeUnknownSync(ErrorIncidentReason)

const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

/** capabilities_json → string[] (default []), mirroring `parseCapabilities`. */
const parseCapabilities = (value: unknown): ReadonlyArray<string> =>
	Option.getOrElse(decodeStringArray(value), () => [] as ReadonlyArray<string>)

/** source_ref_json → Record<string, unknown> | null, mirroring `parseSourceRef`. */
const parseSourceRef = (value: unknown): Record<string, unknown> | null =>
	value == null ? null : Option.getOrElse(decodeRecord(value), () => null)

// ---------------------------------------------------------------------------
// error_issues
// ---------------------------------------------------------------------------

export const ErrorIssueRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	kind: Schema.String,
	source_ref_json: Schema.NullOr(Schema.Unknown),
	fingerprint_hash: Schema.String,
	service_name: Schema.String,
	exception_type: Schema.String,
	exception_message: Schema.String,
	error_label: Schema.String,
	top_frame: Schema.String,
	workflow_state: Schema.String,
	priority: Schema.Number,
	severity: Schema.NullOr(Schema.String),
	severity_source: Schema.NullOr(Schema.String),
	assigned_actor_id: Schema.NullOr(Schema.String),
	lease_holder_actor_id: Schema.NullOr(Schema.String),
	lease_expires_at: Schema.NullOr(Schema.String),
	claimed_at: Schema.NullOr(Schema.String),
	notes: Schema.NullOr(Schema.String),
	first_seen_at: Schema.String,
	last_seen_at: Schema.String,
	occurrence_count: Schema.Number,
	resolved_at: Schema.NullOr(Schema.String),
	resolved_by_actor_id: Schema.NullOr(Schema.String),
	snooze_until: Schema.NullOr(Schema.String),
	archived_at: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
})
export type ErrorIssueRow = typeof ErrorIssueRowSchema.Type

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

export const ActorRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	type: Schema.String,
	user_id: Schema.NullOr(Schema.String),
	agent_name: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	capabilities_json: Schema.Unknown,
	created_by: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	last_active_at: Schema.NullOr(Schema.String),
})
export type ActorRow = typeof ActorRowSchema.Type

// ---------------------------------------------------------------------------
// error_incidents (shape: open_error_incidents)
// ---------------------------------------------------------------------------

export const ErrorIncidentRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	issue_id: Schema.String,
	status: Schema.String,
	reason: Schema.String,
	first_triggered_at: Schema.String,
	last_triggered_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String),
	occurrence_count: Schema.Number,
	created_at: Schema.String,
	updated_at: Schema.String,
})
export type ErrorIncidentRow = typeof ErrorIncidentRowSchema.Type

// ---------------------------------------------------------------------------
// Mappers (mirror the server row→document mappers in ErrorsService.ts)
// ---------------------------------------------------------------------------

/** Decodes an `actors` row into {@link ActorDocument}, mirroring `rowToActor`. */
export const rowToActor = (row: ActorRow): ActorDocument =>
	new ActorDocument({
		id: asActorId(row.id),
		type: asActorType(row.type),
		userId: row.user_id != null ? asUserId(row.user_id) : null,
		agentName: row.agent_name ?? null,
		model: row.model ?? null,
		capabilities: parseCapabilities(row.capabilities_json),
		lastActiveAt: row.last_active_at != null ? decodeIso(row.last_active_at) : null,
	})

/**
 * Decodes an `error_issues` row into {@link ErrorIssueDocument}, mirroring
 * `rowToIssue`. `hasOpenIncident` and the `actorMap` (assigned/lease-holder
 * actors) are supplied by the caller — the same joins the server performs.
 */
export const rowToIssue = (
	row: ErrorIssueRow,
	hasOpenIncident: boolean,
	actorMap: Map<string, ActorDocument>,
): ErrorIssueDocument =>
	new ErrorIssueDocument({
		id: asErrorIssueId(row.id),
		kind: asIssueKind(row.kind),
		fingerprintHash: row.fingerprint_hash,
		serviceName: row.service_name,
		exceptionType: row.exception_type,
		exceptionMessage: row.exception_message,
		errorLabel: row.error_label,
		topFrame: row.top_frame,
		workflowState: asWorkflowState(row.workflow_state),
		priority: row.priority,
		severity: row.severity != null ? asSeverity(row.severity) : null,
		severitySource: row.severity_source != null ? asSeveritySource(row.severity_source) : null,
		sourceRef: parseSourceRef(row.source_ref_json),
		assignedActor: row.assigned_actor_id != null ? (actorMap.get(row.assigned_actor_id) ?? null) : null,
		leaseHolder:
			row.lease_holder_actor_id != null ? (actorMap.get(row.lease_holder_actor_id) ?? null) : null,
		leaseExpiresAt: row.lease_expires_at != null ? decodeIso(row.lease_expires_at) : null,
		claimedAt: row.claimed_at != null ? decodeIso(row.claimed_at) : null,
		notes: row.notes ?? null,
		firstSeenAt: decodeIso(row.first_seen_at),
		lastSeenAt: decodeIso(row.last_seen_at),
		occurrenceCount: row.occurrence_count,
		resolvedAt: row.resolved_at != null ? decodeIso(row.resolved_at) : null,
		snoozeUntil: row.snooze_until != null ? decodeIso(row.snooze_until) : null,
		archivedAt: row.archived_at != null ? decodeIso(row.archived_at) : null,
		hasOpenIncident,
	})

/** Decodes an `error_incidents` row into {@link ErrorIncidentDocument}, mirroring `rowToIncident`. */
export const rowToErrorIncident = (row: ErrorIncidentRow): ErrorIncidentDocument =>
	new ErrorIncidentDocument({
		id: asErrorIncidentId(row.id),
		issueId: asErrorIssueId(row.issue_id),
		status: asIncidentStatus(row.status),
		reason: asIncidentReason(row.reason),
		firstTriggeredAt: decodeIso(row.first_triggered_at),
		lastTriggeredAt: decodeIso(row.last_triggered_at),
		resolvedAt: row.resolved_at != null ? decodeIso(row.resolved_at) : null,
		occurrenceCount: row.occurrence_count,
	})

// ---------------------------------------------------------------------------
// Collections (read-only — no write handlers)
// ---------------------------------------------------------------------------

export const createErrorIssuesCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "error_issues",
		orgId,
		schema: ErrorIssueRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createActorsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "actors",
		orgId,
		schema: ActorRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createOpenErrorIncidentsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "open_error_incidents",
		orgId,
		schema: ErrorIncidentRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export type ErrorIssuesCollection = ReturnType<typeof createErrorIssuesCollection>
export type ActorsCollection = ReturnType<typeof createActorsCollection>
export type OpenErrorIncidentsCollection = ReturnType<typeof createOpenErrorIncidentsCollection>
