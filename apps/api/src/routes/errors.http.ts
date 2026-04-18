import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { ErrorsService } from "../services/ErrorsService"

export const HttpErrorsLive = HttpApiBuilder.group(
  MapleApi,
  "errors",
  (handlers) =>
    Effect.gen(function* () {
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
              service: query.service,
              deploymentEnv: query.deploymentEnv,
              assignedActorId: query.assignedActorId,
              includeArchived: query.includeArchived === "1",
              startTime: query.startTime,
              endTime: query.endTime,
              limit: query.limit,
            })
            yield* Effect.annotateCurrentSpan(
              "issueCount",
              response.issues.length,
            )
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
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
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
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            const leaseDurationMs =
              payload.leaseDurationSeconds !== undefined
                ? payload.leaseDurationSeconds * 1000
                : undefined
            yield* Effect.annotateCurrentSpan({
              orgId: tenant.orgId,
              issueId: params.issueId,
              leaseDurationMs: leaseDurationMs ?? "default",
            })
            return yield* errors.claimIssue(
              tenant.orgId,
              actor.id,
              params.issueId,
              leaseDurationMs,
            )
          }).pipe(Effect.withSpan("HttpErrors.claimIssue")),
        )
        .handle("heartbeatIssue", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            return yield* errors.heartbeatIssue(
              tenant.orgId,
              actor.id,
              params.issueId,
            )
          }).pipe(Effect.withSpan("HttpErrors.heartbeatIssue")),
        )
        .handle("releaseIssue", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            return yield* errors.releaseIssue(
              tenant.orgId,
              actor.id,
              params.issueId,
              {
                transitionTo: payload.transitionTo,
                note: payload.note,
              },
            )
          }).pipe(Effect.withSpan("HttpErrors.releaseIssue")),
        )
        .handle("commentOnIssue", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            return yield* errors.commentOnIssue(
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
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            return yield* errors.proposeFix(
              tenant.orgId,
              actor.id,
              params.issueId,
              {
                patchSummary: payload.patchSummary,
                prUrl: payload.prUrl,
                artifacts: payload.artifacts,
              },
            )
          }).pipe(Effect.withSpan("HttpErrors.proposeFix")),
        )
        .handle("assignIssue", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const actor = yield* errors.ensureUserActor(
              tenant.orgId,
              tenant.userId,
            )
            return yield* errors.assignIssue(
              tenant.orgId,
              actor.id,
              params.issueId,
              payload.actorId,
            )
          }).pipe(Effect.withSpan("HttpErrors.assignIssue")),
        )
        .handle("listIssueEvents", ({ params, query }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* Effect.annotateCurrentSpan({
              orgId: tenant.orgId,
              issueId: params.issueId,
            })
            const response = yield* errors.listIssueEvents(
              tenant.orgId,
              params.issueId,
              { limit: query.limit },
            )
            yield* Effect.annotateCurrentSpan(
              "eventCount",
              response.events.length,
            )
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
            const response = yield* errors.listIssueIncidents(
              tenant.orgId,
              params.issueId,
            )
            yield* Effect.annotateCurrentSpan(
              "incidentCount",
              response.incidents.length,
            )
            return response
          }).pipe(Effect.withSpan("HttpErrors.listIssueIncidents")),
        )
        .handle("listOpenIncidents", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
            const response = yield* errors.listOpenIncidents(tenant.orgId)
            yield* Effect.annotateCurrentSpan(
              "incidentCount",
              response.incidents.length,
            )
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
            return yield* errors.registerAgent(tenant.orgId, tenant.userId, {
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
            return yield* errors.listAgents(tenant.orgId)
          }).pipe(Effect.withSpan("HttpErrors.listAgents")),
        )
        .handle("getNotificationPolicy", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
            return yield* errors.getNotificationPolicy(tenant.orgId)
          }).pipe(Effect.withSpan("HttpErrors.getNotificationPolicy")),
        )
        .handle("upsertNotificationPolicy", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
            return yield* errors.upsertNotificationPolicy(
              tenant.orgId,
              tenant.userId,
              payload,
            )
          }).pipe(Effect.withSpan("HttpErrors.upsertNotificationPolicy")),
        )
    }),
)
