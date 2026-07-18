import { HttpApiBuilder } from "effect/unstable/httpapi"
import type {
	ActorId,
	AnomalyDetectorSettingsDocument,
	AnomalyIncidentDocument,
	AnomalyIncidentTimeseriesResponse,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/http"
import {
	AnomalyDetectorSettingsUpdateRequest,
	AnomalyForbiddenError,
	AnomalyPersistenceError,
	CurrentTenant,
} from "@maple/domain/http"
import {
	LIST_LIMIT_DEFAULT,
	MapleApiV2,
	decodeOffsetCursorEffect,
	encodeOffsetCursor,
	notFound,
	permissionError,
	serviceUnavailable,
} from "@maple/domain/http/v2"
import type { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2AnomalySettings } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { requireAdmin } from "../../lib/auth"
import { AnomalyDetectionService } from "../../services/AnomalyDetectionService"
import { ErrorsService } from "../../services/ErrorsService"

const toV2Incident = (doc: AnomalyIncidentDocument): V2AnomalyIncident => ({
	id: doc.id,
	object: "anomaly_incident",
	detector_key: doc.detectorKey,
	signal_type: doc.signalType,
	service_name: doc.serviceName,
	deployment_env: doc.deploymentEnv,
	fingerprint_hash: doc.fingerprintHash,
	error_issue_id: doc.errorIssueId,
	status: doc.status,
	severity: doc.severity,
	opened_value: doc.openedValue,
	baseline_median: doc.baselineMedian,
	baseline_sigma: doc.baselineSigma,
	threshold_value: doc.thresholdValue,
	last_observed_value: doc.lastObservedValue,
	last_sample_count: doc.lastSampleCount,
	first_triggered_at: doc.firstTriggeredAt,
	last_triggered_at: doc.lastTriggeredAt,
	resolved_at: doc.resolvedAt,
	resolve_reason: doc.resolveReason,
	triage_status: doc.triageStatus,
	fingerprints: doc.fingerprints.map((fp) => ({
		fingerprint_hash: fp.fingerprintHash,
		error_issue_id: fp.errorIssueId,
		opened_value: fp.openedValue,
		last_value: fp.lastValue,
		severity: fp.severity,
		attached_at: fp.attachedAt,
		resolved_at: fp.resolvedAt,
	})),
	reopen_count: doc.reopenCount,
	last_reopened_at: doc.lastReopenedAt,
})

const toV2Timeseries = (r: AnomalyIncidentTimeseriesResponse): V2AnomalyIncidentTimeseries => ({
	object: "anomaly_incident.timeseries",
	signal_type: r.signalType,
	unit: r.unit,
	bucket_seconds: r.bucketSeconds,
	buckets: r.buckets.map((b) => ({ bucket: b.bucket, value: b.value, sample_count: b.sampleCount })),
	baseline_median: r.baselineMedian,
	threshold_value: r.thresholdValue,
})

const toV2Settings = (s: AnomalyDetectorSettingsDocument): V2AnomalySettings => ({
	object: "anomaly_settings",
	enabled: s.enabled,
	sensitivity: s.sensitivity,
	muted_signals: s.mutedSignals,
	updated_at: s.updatedAt,
	updated_by: s.updatedBy,
})

/** Service tagged errors → v2 envelope errors (no 404). */
const mapCommonError = (error: { readonly message: string }) => serviceUnavailable(error.message)

/** Service tagged errors → v2 envelope errors (incident/linked-issue 404s). */
const mapWith404 = (error: { readonly _tag: string; readonly message: string }) => {
	switch (error._tag) {
		case "@maple/http/anomalies/AnomalyIncidentNotFoundError":
			return notFound(error.message, "id")
		case "@maple/http/anomalies/AnomalyLinkedIssueNotFoundError":
			return notFound(error.message, "issue_id")
		default:
			return serviceUnavailable(error.message)
	}
}

/** Settings mutation: forbidden → 403, else 503. */
const mapSettingsError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/anomalies/AnomalyForbiddenError"
		? permissionError("insufficient_permissions", error.message)
		: serviceUnavailable(error.message)

export const HttpV2AnomaliesLive = HttpApiBuilder.group(MapleApiV2, "anomalies", (handlers) =>
	Effect.gen(function* () {
		const anomalies = yield* AnomalyDetectionService
		const errors = yield* ErrorsService

		/** Best-effort issue-timeline audit entry; the link itself already committed. */
		const recordLinkEvent = (
			orgId: OrgId,
			actorId: ActorId,
			issueId: ErrorIssueId,
			action: "linked" | "unlinked",
			incident: AnomalyIncidentDocument,
		) =>
			errors
				.recordAnomalyLinkEvent(orgId, issueId, actorId, {
					action,
					incidentId: incident.id,
					signalType: incident.signalType,
					serviceName: incident.serviceName,
					deploymentEnv: incident.deploymentEnv,
				})
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning("Failed to record anomaly link event").pipe(
							Effect.annotateLogs({ issueId, action, message: error.message }),
						),
					),
				)

		return handlers
			.handle("listIncidents", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const limit = query.limit ?? LIST_LIMIT_DEFAULT
					const offset = yield* decodeOffsetCursorEffect(query.cursor)
					const response = yield* anomalies
						.listIncidents(tenant.orgId, {
							...(query.status !== undefined ? { status: query.status } : {}),
							...(query.signal_type !== undefined ? { signalType: query.signal_type } : {}),
							...(query.service !== undefined ? { service: query.service } : {}),
							...(query.deployment_env !== undefined
								? { deploymentEnv: query.deployment_env }
								: {}),
							...(query.error_issue_id !== undefined
								? { errorIssueId: query.error_issue_id }
								: {}),
							...(query.start_time !== undefined ? { startTime: query.start_time } : {}),
							...(query.end_time !== undefined ? { endTime: query.end_time } : {}),
							limit: limit + 1,
							offset,
						})
						.pipe(Effect.mapError(mapCommonError))
					const items = response.incidents.map(toV2Incident)
					const hasMore = items.length > limit
					return {
						object: "list" as const,
						data: hasMore ? items.slice(0, limit) : items,
						has_more: hasMore,
						next_cursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
					}
				}),
			)
			.handle("getIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* anomalies
						.getIncident(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapWith404))
					return toV2Incident(incident)
				}),
			)
			.handle("getIncidentTimeseries", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* anomalies
						.getIncidentTimeseries(tenant, params.id, {
							...(query.start_time !== undefined ? { startTime: query.start_time } : {}),
							...(query.end_time !== undefined ? { endTime: query.end_time } : {}),
						})
						.pipe(Effect.mapError(mapWith404))
					return toV2Timeseries(response)
				}),
			)
			.handle("resolveIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* anomalies
						.resolveIncidentManually(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapWith404))
					return toV2Incident(incident)
				}),
			)
			.handle("setIncidentIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* errors.ensureUserActor(tenant.orgId, tenant.userId).pipe(
						Effect.mapError((error) => new AnomalyPersistenceError({ message: error.message })),
						Effect.mapError(mapCommonError),
					)
					const { incident, previousIssueId } = yield* anomalies
						.setIncidentIssue(tenant.orgId, params.id, payload.issue_id)
						.pipe(Effect.mapError(mapWith404))
					if (previousIssueId !== null && previousIssueId !== payload.issue_id) {
						yield* recordLinkEvent(tenant.orgId, actor.id, previousIssueId, "unlinked", incident)
					}
					if (payload.issue_id !== null && payload.issue_id !== previousIssueId) {
						yield* recordLinkEvent(tenant.orgId, actor.id, payload.issue_id, "linked", incident)
					}
					return toV2Incident(incident)
				}),
			)
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const settings = yield* anomalies
						.getSettings(tenant.orgId)
						.pipe(Effect.mapError(mapCommonError))
					return toV2Settings(settings)
				}),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						() =>
							new AnomalyForbiddenError({
								message: "Only org admins can manage anomaly detector settings",
							}),
					).pipe(Effect.mapError(mapSettingsError))
					const settings = yield* anomalies
						.updateSettings(
							tenant.orgId,
							tenant.userId,
							new AnomalyDetectorSettingsUpdateRequest({
								...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
								...(payload.sensitivity !== undefined
									? { sensitivity: payload.sensitivity }
									: {}),
								...(payload.muted_signals !== undefined
									? { mutedSignals: payload.muted_signals }
									: {}),
							}),
						)
						.pipe(Effect.mapError(mapSettingsError))
					return toV2Settings(settings)
				}),
			)
	}),
)
