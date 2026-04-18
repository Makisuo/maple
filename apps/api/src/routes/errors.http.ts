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
            return yield* errors.listIssues(tenant.orgId, {
              status: query.status,
              service: query.service,
              deploymentEnv: query.deploymentEnv,
              startTime: query.startTime,
              endTime: query.endTime,
              limit: query.limit,
            })
          }),
        )
        .handle("getIssue", ({ params, query }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.getIssue(tenant.orgId, params.issueId, {
              startTime: query.startTime,
              endTime: query.endTime,
              bucketSeconds: query.bucketSeconds,
              sampleLimit: query.sampleLimit,
            })
          }),
        )
        .handle("updateIssue", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.updateIssue(
              tenant.orgId,
              tenant.userId,
              params.issueId,
              payload,
            )
          }),
        )
        .handle("listIssueIncidents", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.listIssueIncidents(tenant.orgId, params.issueId)
          }),
        )
        .handle("listOpenIncidents", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.listOpenIncidents(tenant.orgId)
          }),
        )
        .handle("getNotificationPolicy", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.getNotificationPolicy(tenant.orgId)
          }),
        )
        .handle("upsertNotificationPolicy", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* errors.upsertNotificationPolicy(
              tenant.orgId,
              tenant.userId,
              payload,
            )
          }),
        )
    }),
)
