import {
	ActorDocument,
	ErrorIncidentDocument,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	ErrorIssueSampleTrace,
	ErrorIssueTimeseriesPoint,
	IsoDateTimeString,
	type IssueKind,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"
import {
	V2ErrorIssueListQuery,
	type V2ErrorIssue,
	type V2ErrorIssueActor,
	type V2ErrorIssueDetail,
} from "@maple/domain/http/v2"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import { Schema } from "effect"

const asIso = Schema.decodeUnknownSync(IsoDateTimeString)
const asIsoOrNull = (value: string | null) => (value === null ? null : asIso(value))

export type ErrorIssueListQuery = typeof V2ErrorIssueListQuery.Type

export const buildErrorIssueListQuery = (filters: {
	readonly workflowState?: WorkflowState | "all"
	readonly severity?: IssueSeverity | "unset" | "all"
	readonly kind?: IssueKind | "all"
}): ErrorIssueListQuery => ({
	limit: 100,
	...(filters.workflowState === undefined || filters.workflowState === "all"
		? {}
		: { workflow_state: filters.workflowState }),
	...(filters.severity === undefined || filters.severity === "all" ? {} : { severity: filters.severity }),
	...(filters.kind === undefined || filters.kind === "all" ? {} : { kind: filters.kind }),
})

export interface ServiceOpenIssuesScope {
	/**
	 * Deployment environment to scope the list to (the service list's display
	 * label — the synthetic `"unknown"` is remapped to the raw empty-string
	 * warehouse value here, mirroring `toEnvFilter` in custom-charts.ts).
	 */
	readonly environment?: string
	/** Warehouse-format ("YYYY-MM-DD HH:mm:ss") or ISO datetimes. */
	readonly startTime?: string
	readonly endTime?: string
}

export const buildServiceOpenIssuesQuery = (
	serviceName: string,
	scope?: ServiceOpenIssuesScope,
): ErrorIssueListQuery => ({
	service_name: serviceName,
	actionable: "true",
	sort: "severity",
	limit: 5,
	// The env filter is resolved against the warehouse's error events, so it is
	// inherently window-scoped — the page's time range rides along only when an
	// environment is selected. The unfiltered panel stays all-time.
	...(scope?.environment === undefined
		? {}
		: {
				deployment_environment: scope.environment === "unknown" ? "" : scope.environment,
				...(scope.startTime ? { start_time: warehouseDateTimeToIso(scope.startTime) } : {}),
				...(scope.endTime ? { end_time: warehouseDateTimeToIso(scope.endTime) } : {}),
			}),
})

/** Append a fetched page while keeping the first occurrence of each issue ID. */
export const appendUniqueErrorIssues = (
	current: ReadonlyArray<ErrorIssueDocument>,
	incoming: ReadonlyArray<ErrorIssueDocument>,
): ReadonlyArray<ErrorIssueDocument> => {
	const byId = new Map(current.map((issue) => [issue.id, issue]))
	for (const issue of incoming) if (!byId.has(issue.id)) byId.set(issue.id, issue)
	return [...byId.values()]
}

const actorFromV2 = (actor: V2ErrorIssueActor): ActorDocument =>
	new ActorDocument({
		id: actor.id,
		type: actor.type,
		userId: actor.user_id,
		agentName: actor.agent_name,
		model: actor.model,
		capabilities: actor.capabilities,
		lastActiveAt: asIsoOrNull(actor.last_active_at),
	})

export const errorIssueFromV2 = (issue: V2ErrorIssue): ErrorIssueDocument =>
	new ErrorIssueDocument({
		id: issue.id,
		kind: issue.kind,
		fingerprintHash: issue.fingerprint_hash,
		serviceName: issue.service_name,
		exceptionType: issue.exception_type,
		exceptionMessage: issue.exception_message,
		errorLabel: issue.error_label,
		topFrame: issue.top_frame,
		workflowState: issue.workflow_state,
		priority: issue.priority,
		severity: issue.severity,
		severitySource: issue.severity_source,
		sourceRef: issue.source_ref,
		assignedActor: issue.assigned_actor === null ? null : actorFromV2(issue.assigned_actor),
		leaseHolder: issue.lease_holder === null ? null : actorFromV2(issue.lease_holder),
		leaseExpiresAt: asIsoOrNull(issue.lease_expires_at),
		claimedAt: asIsoOrNull(issue.claimed_at),
		notes: issue.notes,
		firstSeenAt: asIso(issue.first_seen_at),
		lastSeenAt: asIso(issue.last_seen_at),
		occurrenceCount: issue.occurrence_count,
		resolvedAt: asIsoOrNull(issue.resolved_at),
		snoozeUntil: asIsoOrNull(issue.snooze_until),
		archivedAt: asIsoOrNull(issue.archived_at),
		hasOpenIncident: issue.has_open_incident,
	})

export const errorIssueDetailFromV2 = (detail: V2ErrorIssueDetail): ErrorIssueDetailResponse =>
	new ErrorIssueDetailResponse({
		issue: errorIssueFromV2(detail),
		timeseries: detail.timeseries.map(
			(point) => new ErrorIssueTimeseriesPoint({ bucket: asIso(point.bucket), count: point.count }),
		),
		sampleTraces: detail.sample_traces.map(
			(trace) =>
				new ErrorIssueSampleTrace({
					traceId: trace.trace_id,
					spanId: trace.span_id,
					serviceName: trace.service_name,
					timestamp: asIso(trace.timestamp),
					exceptionMessage: trace.exception_message,
					durationMicros: trace.duration_micros,
				}),
		),
		incidents: detail.incidents.map(
			(incident) =>
				new ErrorIncidentDocument({
					id: incident.id,
					issueId: incident.issue_id,
					status: incident.status,
					reason: incident.reason,
					firstTriggeredAt: asIso(incident.first_triggered_at),
					lastTriggeredAt: asIso(incident.last_triggered_at),
					resolvedAt: asIsoOrNull(incident.resolved_at),
					occurrenceCount: incident.occurrence_count,
				}),
		),
	})
