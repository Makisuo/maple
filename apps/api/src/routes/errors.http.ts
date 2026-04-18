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
              status: query.status ?? "all",
              limit: query.limit ?? 100,
            })
            const response = yield* errors.listIssues(tenant.orgId, {
              status: query.status,
              service: query.service,
              deploymentEnv: query.deploymentEnv,
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
        .handle("updateIssue", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* Effect.annotateCurrentSpan({
              orgId: tenant.orgId,
              issueId: params.issueId,
              action: payload.status ?? "patch",
              patches: Object.keys(payload).join(","),
            })
            return yield* errors.updateIssue(
              tenant.orgId,
              tenant.userId,
              params.issueId,
              payload,
            )
          }).pipe(Effect.withSpan("HttpErrors.updateIssue")),
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
