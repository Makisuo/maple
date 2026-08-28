import { HttpApiBuilder } from "effect/unstable/httpapi"
import type {
	ActorDocument,
	ErrorIncidentDocument,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	IssueListCursorFields,
	IssueSeverityListCursorFields,
} from "@maple/domain/http"
import { CurrentTenant, IssueListCursor, IssueSeverityListCursor } from "@maple/domain/http"
import type {
	V2ErrorIncident,
	V2ErrorIssue,
	V2ErrorIssueActor,
	V2ErrorIssueDetail,
} from "@maple/domain/http/v2"
import { MapleApiV2, V2CursorInvalid, V2CursorSortMismatch } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"

const toV2Actor = (actor: ActorDocument): V2ErrorIssueActor => ({
	id: actor.id,
	type: actor.type,
	user_id: actor.userId,
	agent_name: actor.agentName,
	model: actor.model,
	capabilities: actor.capabilities,
	last_active_at: actor.lastActiveAt,
})

export const toV2Issue = (issue: ErrorIssueDocument): V2ErrorIssue => ({
	id: issue.id,
	object: "error_issue",
	kind: issue.kind,
	fingerprint_hash: issue.fingerprintHash,
	service_name: issue.serviceName,
	exception_type: issue.exceptionType,
	exception_message: issue.exceptionMessage,
	error_label: issue.errorLabel,
	top_frame: issue.topFrame,
	workflow_state: issue.workflowState,
	priority: issue.priority,
	severity: issue.severity,
	severity_source: issue.severitySource,
	source_ref: issue.sourceRef,
	assigned_actor: issue.assignedActor === null ? null : toV2Actor(issue.assignedActor),
	lease_holder: issue.leaseHolder === null ? null : toV2Actor(issue.leaseHolder),
	lease_expires_at: issue.leaseExpiresAt,
	claimed_at: issue.claimedAt,
	notes: issue.notes,
	first_seen_at: issue.firstSeenAt,
	last_seen_at: issue.lastSeenAt,
	occurrence_count: issue.occurrenceCount,
	resolved_at: issue.resolvedAt,
	last_resolved_at: issue.lastResolvedAt,
	last_regressed_at: issue.lastRegressedAt,
	regression_count: issue.regressionCount,
	resolved_versions: issue.resolvedVersions,
	snooze_until: issue.snoozeUntil,
	archived_at: issue.archivedAt,
	has_open_incident: issue.hasOpenIncident,
	comment_count: issue.commentCount,
	open_pull_request_count: issue.openPullRequestCount,
	merged_pull_request_count: issue.mergedPullRequestCount,
})

const toV2Incident = (incident: ErrorIncidentDocument): V2ErrorIncident => ({
	id: incident.id,
	object: "error_incident",
	issue_id: incident.issueId,
	status: incident.status,
	reason: incident.reason,
	first_triggered_at: incident.firstTriggeredAt,
	last_triggered_at: incident.lastTriggeredAt,
	resolved_at: incident.resolvedAt,
	occurrence_count: incident.occurrenceCount,
})

export const toV2IssueDetail = (detail: ErrorIssueDetailResponse): V2ErrorIssueDetail => ({
	...toV2Issue(detail.issue),
	timeseries: detail.timeseries.map((point) => ({
		bucket: point.bucket,
		count: point.count,
	})),
	sample_traces: detail.sampleTraces.map((trace) => ({
		trace_id: trace.traceId,
		span_id: trace.spanId,
		service_name: trace.serviceName,
		timestamp: trace.timestamp,
		exception_message: trace.exceptionMessage,
		duration_micros: trace.durationMicros,
	})),
	incidents: detail.incidents.map(toV2Incident),
	environments: detail.environments.map((env) => ({ name: env.name, count: env.count })),
})

const decodeCursor = (
	cursor: string | undefined,
	sort: "last_seen" | "severity",
): Effect.Effect<
	IssueListCursorFields | IssueSeverityListCursorFields | undefined,
	ReturnType<typeof V2CursorInvalid.make> | ReturnType<typeof V2CursorSortMismatch.make>
> => {
	if (cursor === undefined) return Effect.succeed(undefined)
	if (sort === "severity") {
		if (!cursor.startsWith("sev_")) {
			return Effect.fail(V2CursorSortMismatch.make(undefined, { param: "cursor" }))
		}
		return Schema.decodeEffect(IssueSeverityListCursor)(cursor.slice(4)).pipe(
			Effect.mapError(() => V2CursorInvalid.make(undefined, { param: "cursor" })),
		)
	}
	if (cursor.startsWith("sev_")) {
		return Effect.fail(V2CursorSortMismatch.make(undefined, { param: "cursor" }))
	}
	return Schema.decodeEffect(IssueListCursor)(cursor).pipe(
		Effect.mapError(() => V2CursorInvalid.make(undefined, { param: "cursor" })),
	)
}

/**
 * `fingerprint_hash=1,2,3` -> `["1","2","3"]`, or `undefined` when the caller
 * did not filter. A param that is present but yields nothing stays an empty
 * array so it matches no issues, rather than silently widening to everything.
 */
function parseFingerprintHashes(raw: string | undefined): ReadonlyArray<string> | undefined {
	if (raw === undefined) return undefined
	return raw
		.split(",")
		.map((hash) => hash.trim())
		.filter((hash) => hash.length > 0)
}

export const HttpV2ErrorIssuesLive = HttpApiBuilder.group(MapleApiV2, "errorIssues", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* ErrorIssueReadModelsService
		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const sort = query.sort ?? "last_seen"
					const cursor = yield* decodeCursor(query.cursor, sort)
					const response = yield* readModels.listIssues(tenant.orgId, {
						workflowState: query.workflow_state,
						severity: query.severity,
						kind: query.kind,
						service: query.service_name,
						fingerprintHashes: parseFingerprintHashes(query.fingerprint_hash),
						deploymentEnv: query.deployment_environment,
						startTime: query.start_time,
						endTime: query.end_time,
						actionable: query.actionable === "true",
						sort,
						limit: query.limit ?? 20,
						cursor,
					})

					return {
						object: "list" as const,
						data: response.issues.map(toV2Issue),
						has_more: response.nextCursor !== undefined,
						next_cursor: response.nextCursor ?? null,
					}
				}),
			)
			.handle("serviceCounts", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const counts = yield* readModels.countOpenIssuesByService(tenant.orgId)

					return {
						object: "list" as const,
						data: counts.map((row) => ({
							service_name: row.serviceName,
							open_count: row.openCount,
						})),
						has_more: false,
						next_cursor: null,
					}
				}),
			)
			.handle("retrieve", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const detail = yield* readModels.getIssue(tenant.orgId, params.id, {
						startTime: query.start_time,
						endTime: query.end_time,
						bucketSeconds: query.bucket_seconds,
						sampleLimit: query.sample_limit,
					})

					return toV2IssueDetail(detail)
				}),
			)
	}),
)
