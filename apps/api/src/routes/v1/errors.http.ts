import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, ErrorForbiddenError, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@/services/errors/ErrorPolicyService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { requireAdmin } from "@/services/auth/auth"

export const HttpErrorsLive = HttpApiBuilder.group(MapleApi, "errors", (handlers) =>
	Effect.gen(function* () {
		const actors = yield* ErrorActorsService
		const workflow = yield* ErrorIssueWorkflowService
		const policies = yield* ErrorPolicyService
		const errors = yield* ErrorsService

		return handlers
			.handle("listIssues", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						workflowState: query.workflowState ?? "all",
						limit: query.limit ?? 100,
					})
					const response = yield* errors.listIssues(tenant.orgId, {
						workflowState: query.workflowState,
						severity: query.severity,
						kind: query.kind,
						service: query.service,
						deploymentEnv: query.deploymentEnv,
						assignedActorId: query.assignedActorId,
						includeArchived: query.includeArchived === "1",
						startTime: query.startTime,
						endTime: query.endTime,
						limit: query.limit,
						cursor: query.cursor,
					})
					yield* Effect.annotateCurrentSpan("issueCount", response.issues.length)
					return response
				}).pipe(Effect.withSpan("HttpErrors.listIssues")),
			)
			.handle("getIssue", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
					})
					return yield* errors.getIssue(tenant.orgId, params.issueId, {
						startTime: query.startTime,
						endTime: query.endTime,
						bucketSeconds: query.bucketSeconds,
						sampleLimit: query.sampleLimit,
					})
				}).pipe(Effect.withSpan("HttpErrors.getIssue")),
			)
			.handle("transitionIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
						toState: payload.toState,
					})
					return yield* errors.transitionIssue(
						tenant.orgId,
						actor.id,
						params.issueId,
						payload.toState,
						{
							note: payload.note,
							snoozeUntil: payload.snoozeUntil,
						},
					)
				}).pipe(Effect.withSpan("HttpErrors.transitionIssue")),
			)
			.handle("claimIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					const leaseDurationMs =
						payload.leaseDurationSeconds !== undefined
							? payload.leaseDurationSeconds * 1000
							: undefined
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
						leaseDurationMs: leaseDurationMs ?? "default",
					})
					return yield* errors.claimIssue(tenant.orgId, actor.id, params.issueId, leaseDurationMs)
				}).pipe(Effect.withSpan("HttpErrors.claimIssue")),
			)
			.handle("heartbeatIssue", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					return yield* workflow.heartbeatIssue(tenant.orgId, actor.id, params.issueId)
				}).pipe(Effect.withSpan("HttpErrors.heartbeatIssue")),
			)
			.handle("releaseIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					return yield* workflow.releaseIssue(tenant.orgId, actor.id, params.issueId, {
						transitionTo: payload.transitionTo,
						note: payload.note,
					})
				}).pipe(Effect.withSpan("HttpErrors.releaseIssue")),
			)
			.handle("commentOnIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					return yield* workflow.commentOnIssue(
						tenant.orgId,
						actor.id,
						params.issueId,
						payload.body,
						{
							visibility: payload.visibility,
							kind: payload.kind,
						},
					)
				}).pipe(Effect.withSpan("HttpErrors.commentOnIssue")),
			)
			.handle("proposeFix", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					return yield* errors.proposeFix(tenant.orgId, actor.id, params.issueId, {
						patchSummary: payload.patchSummary,
						prUrl: payload.prUrl,
						artifacts: payload.artifacts,
					})
				}).pipe(Effect.withSpan("HttpErrors.proposeFix")),
			)
			.handle("assignIssue", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					return yield* workflow.assignIssue(
						tenant.orgId,
						actor.id,
						params.issueId,
						payload.actorId,
					)
				}).pipe(Effect.withSpan("HttpErrors.assignIssue")),
			)
			.handle("setIssueSeverity", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
						severity: payload.severity ?? "null",
					})
					return yield* workflow.setSeverity(
						tenant.orgId,
						actor.id,
						params.issueId,
						payload.severity,
						{
							note: payload.note,
							source: "manual",
						},
					)
				}).pipe(Effect.withSpan("HttpErrors.setIssueSeverity")),
			)
			.handle("listIssueEvents", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
					})
					const response = yield* workflow.listIssueEvents(tenant.orgId, params.issueId, {
						limit: query.limit,
					})
					yield* Effect.annotateCurrentSpan("eventCount", response.events.length)
					return response
				}).pipe(Effect.withSpan("HttpErrors.listIssueEvents")),
			)
			.handle("listIssueIncidents", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						issueId: params.issueId,
					})
					const response = yield* errors.listIssueIncidents(tenant.orgId, params.issueId)
					yield* Effect.annotateCurrentSpan("incidentCount", response.incidents.length)
					return response
				}).pipe(Effect.withSpan("HttpErrors.listIssueIncidents")),
			)
			.handle("listOpenIncidents", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const response = yield* errors.listOpenIncidents(tenant.orgId)
					yield* Effect.annotateCurrentSpan("incidentCount", response.incidents.length)
					return response
				}).pipe(Effect.withSpan("HttpErrors.listOpenIncidents")),
			)
			.handle("registerAgent", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						agentName: payload.name,
					})
					return yield* actors.registerAgent(tenant.orgId, tenant.userId, {
						name: payload.name,
						model: payload.model,
						capabilities: payload.capabilities,
					})
				}).pipe(Effect.withSpan("HttpErrors.registerAgent")),
			)
			.handle("listAgents", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* actors.listAgents(tenant.orgId)
				}).pipe(Effect.withSpan("HttpErrors.listAgents")),
			)
			.handle("getNotificationPolicy", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* policies.getNotificationPolicy(tenant.orgId)
				}).pipe(Effect.withSpan("HttpErrors.getNotificationPolicy")),
			)
			.handle("upsertNotificationPolicy", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* requireAdmin(
						tenant.roles,
						() =>
							new ErrorForbiddenError({
								message: "Only org admins can manage error notification policy",
							}),
					)
					return yield* policies.upsertNotificationPolicy(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpErrors.upsertNotificationPolicy")),
			)
			.handle("getEscalationPolicy", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* policies.getEscalationPolicy(tenant.orgId)
				}).pipe(Effect.withSpan("HttpErrors.getEscalationPolicy")),
			)
			.handle("upsertEscalationPolicy", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* requireAdmin(
						tenant.roles,
						() =>
							new ErrorForbiddenError({
								message: "Only org admins can manage the escalation policy",
							}),
					)
					return yield* policies.upsertEscalationPolicy(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpErrors.upsertEscalationPolicy")),
			)
			.handle("evaluateEscalationPolicy", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* policies.evaluateEscalationPolicy(tenant.orgId, payload)
				}).pipe(Effect.withSpan("HttpErrors.evaluateEscalationPolicy")),
			)
			.handle("listIssueEscalations", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.issue.id": params.issueId,
					})
					return yield* policies.listIssueEscalations(tenant.orgId, params.issueId)
				}).pipe(Effect.withSpan("HttpErrors.listIssueEscalations")),
			)
			.handle("listRecentEscalations", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* policies.listRecentEscalations(tenant.orgId, query.limit)
				}).pipe(Effect.withSpan("HttpErrors.listRecentEscalations")),
			)
	}),
)
