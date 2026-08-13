import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	AnomalyForbiddenError,
	type AnomalyIncidentDocument,
	AnomalyPersistenceError,
	type ActorId,
	CurrentTenant,
	type ErrorIssueId,
	MapleApi,
	type OrgId,
} from "@maple/domain/http"
import { Effect } from "effect"
import {
	AnomalyDetectionService,
	makePersistenceError as makeAnomalyPersistenceError,
} from "@/services/alerts/AnomalyDetectionService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { requireAdmin } from "@/services/auth/auth"
import { warehouseHandlers } from "@/services/warehouse/warehouse-error-handlers"

// v1 keeps its historical generic persistence failure; v2 exposes each warehouse tag directly.
const legacyPersistenceFailure = (error: { readonly message: string }) =>
	Effect.fail(makeAnomalyPersistenceError(error))

export const HttpAnomaliesLive = HttpApiBuilder.group(MapleApi, "anomalies", (handlers) =>
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
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						status: query.status ?? "all",
						signalType: query.signalType ?? "all",
					})
					const response = yield* anomalies.listIncidents(tenant.orgId, {
						status: query.status,
						signalType: query.signalType,
						service: query.service,
						deploymentEnv: query.deploymentEnv,
						errorIssueId: query.errorIssueId,
						startTime: query.startTime,
						endTime: query.endTime,
						limit: query.limit,
					})
					yield* Effect.annotateCurrentSpan("incidentCount", response.incidents.length)
					return response
				}).pipe(Effect.withSpan("HttpAnomalies.listIncidents")),
			)
			.handle("getIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						incidentId: params.incidentId,
					})
					return yield* anomalies.getIncident(tenant.orgId, params.incidentId)
				}).pipe(Effect.withSpan("HttpAnomalies.getIncident")),
			)
			.handle("getIncidentTimeseries", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						incidentId: params.incidentId,
					})
					return yield* anomalies
						.getIncidentTimeseries(tenant, params.incidentId, {
							startTime: query.startTime,
							endTime: query.endTime,
						})
						.pipe(Effect.catchTags(warehouseHandlers(legacyPersistenceFailure)))
				}).pipe(Effect.withSpan("HttpAnomalies.getIncidentTimeseries")),
			)
			.handle("resolveIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						incidentId: params.incidentId,
					})
					return yield* anomalies.resolveIncidentManually(tenant.orgId, params.incidentId)
				}).pipe(Effect.withSpan("HttpAnomalies.resolveIncident")),
			)
			.handle("setIncidentIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						incidentId: params.incidentId,
						issueId: payload.issueId ?? "(none)",
					})
					const actor = yield* errors
						.ensureUserActor(tenant.orgId, tenant.userId)
						.pipe(
							Effect.mapError(
								(error) => new AnomalyPersistenceError({ message: error.message }),
							),
						)
					const { incident, previousIssueId } = yield* anomalies.setIncidentIssue(
						tenant.orgId,
						params.incidentId,
						payload.issueId,
					)
					if (previousIssueId !== null && previousIssueId !== payload.issueId) {
						yield* recordLinkEvent(tenant.orgId, actor.id, previousIssueId, "unlinked", incident)
					}
					if (payload.issueId !== null && payload.issueId !== previousIssueId) {
						yield* recordLinkEvent(tenant.orgId, actor.id, payload.issueId, "linked", incident)
					}
					return incident
				}).pipe(Effect.withSpan("HttpAnomalies.setIncidentIssue")),
			)
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* anomalies.getSettings(tenant.orgId)
				}).pipe(Effect.withSpan("HttpAnomalies.getSettings")),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* requireAdmin(
						tenant.roles,
						() =>
							new AnomalyForbiddenError({
								message: "Only org admins can manage anomaly detector settings",
							}),
					)
					return yield* anomalies.updateSettings(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpAnomalies.updateSettings")),
			)
	}),
)
