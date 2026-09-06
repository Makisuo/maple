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
	CurrentTenant,
} from "@maple/domain/http"
import { MapleApiV2, paginateOffsetQuery, timestamp } from "@maple/domain/http/v2"
import type { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2AnomalySettings } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { requireAdmin } from "@/services/auth/auth"
import { AnomalyDetectionService } from "@/services/alerts/AnomalyDetectionService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"

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

export const HttpV2AnomaliesLive = HttpApiBuilder.group(MapleApiV2, "anomalies", (handlers) =>
	Effect.gen(function* () {
		const anomalies = yield* AnomalyDetectionService
		const errors = yield* ErrorsService
		const actors = yield* ErrorActorsService

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
					Effect.tapError((error) =>
						Effect.logWarning("Failed to record anomaly link event").pipe(
							Effect.annotateLogs({ issueId, action, errorTag: error._tag }),
						),
					),
					Effect.ignore,
				)

		return handlers
			.handle("listIncidents", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						anomalies
							.listIncidents(tenant.orgId, {
								...(query.status !== undefined ? { status: query.status } : undefined),
								...(query.signal_type !== undefined
									? { signalType: query.signal_type }
									: undefined),
								...(query.service_name !== undefined
									? { service: query.service_name }
									: undefined),
								...(query.deployment_env !== undefined
									? {
											deploymentEnv: query.deployment_env,
										}
									: undefined),
								...(query.error_issue_id !== undefined
									? {
											errorIssueId: query.error_issue_id,
										}
									: undefined),
								...(query.start_time !== undefined
									? { startTime: query.start_time }
									: undefined),
								...(query.end_time !== undefined ? { endTime: query.end_time } : undefined),
								limit,
								offset,
							})
							.pipe(Effect.map((response) => response.incidents.map(toV2Incident))),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("serviceCounts", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* anomalies.countIncidentsByService(
						tenant.orgId,
						query.status !== undefined ? { status: query.status } : {},
					)

					return {
						object: "list" as const,
						data: rows.map((row) => ({
							object: "anomaly_service_count" as const,
							service_name: row.serviceName,
							deployment_env: row.deploymentEnv,
							signal_type: row.signalType,
							severity: row.severity,
							incident_count: row.incidentCount,
							last_triggered_at: timestamp(row.lastTriggeredAt),
						})),
						has_more: false,
						next_cursor: null,
					}
				}),
			)
			.handle("getIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* anomalies.getIncident(tenant.orgId, params.id)

					return toV2Incident(incident)
				}),
			)
			.handle("getIncidentTimeseries", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* anomalies.getIncidentTimeseries(tenant, params.id, {
						...(query.start_time !== undefined ? { startTime: query.start_time } : undefined),
						...(query.end_time !== undefined ? { endTime: query.end_time } : undefined),
					})

					return toV2Timeseries(response)
				}),
			)
			.handle("resolveIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* anomalies.resolveIncidentManually(tenant.orgId, params.id)
					yield* recordHttpAudit("anomaly_incident.resolved", {
						resourceId: incident.id,
						metadata: {
							signal_type: incident.signalType,
							service_name: incident.serviceName,
						},
					})

					return toV2Incident(incident)
				}),
			)
			.handle("setIncidentIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)

					const { incident, previousIssueId } = yield* anomalies.setIncidentIssue(
						tenant.orgId,
						params.id,
						payload.issue_id,
					)

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
					const settings = yield* anomalies.getSettings(tenant.orgId)

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
					)
					const settings = yield* anomalies.updateSettings(
						tenant.orgId,
						tenant.userId,
						new AnomalyDetectorSettingsUpdateRequest({
							...(payload.enabled !== undefined ? { enabled: payload.enabled } : undefined),
							...(payload.sensitivity !== undefined
								? { sensitivity: payload.sensitivity }
								: undefined),
							...(payload.muted_signals !== undefined
								? {
										mutedSignals: payload.muted_signals,
									}
								: undefined),
						}),
					)

					yield* recordHttpAudit("anomaly_settings.updated", {
						metadata: { enabled: settings.enabled, sensitivity: settings.sensitivity },
					})

					return toV2Settings(settings)
				}),
			)
	}),
)
