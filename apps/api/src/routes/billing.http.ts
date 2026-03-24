import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  CurrentTenant,
  MapleApi,
  BillingError,
  BillingCustomerResponse,
  BillingPlansListResponse,
  BillingAttachResponse,
  BillingPreviewAttachResponse,
  BillingAggregateEventsResponse,
  BillingCustomerPortalResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { AutumnService } from "../services/AutumnService"

const mapAutumnError = Effect.mapError(
  (err: unknown) =>
    new BillingError({
      message: err instanceof Error ? err.message : "Billing request failed",
    }),
)

function assertOk(result: { response: unknown; statusCode: number }) {
  if (result.statusCode >= 200 && result.statusCode < 300) return Effect.void
  const msg =
    (result.response as Record<string, unknown>)?.message ??
    `Autumn returned ${result.statusCode}`
  return Effect.fail(new BillingError({ message: String(msg) }))
}

export const HttpBillingLive = HttpApiBuilder.group(
  MapleApi,
  "billing",
  (handlers) =>
    Effect.gen(function* () {
      const autumnService = yield* AutumnService

      return handlers
        .handle("getCustomer", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("getOrCreateCustomer", {}, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingCustomerResponse(result.response as never)
          }),
        )
        .handle("listPlans", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("listPlans", {}, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingPlansListResponse({ plans: result.response as never })
          }),
        )
        .handle("attach", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("attach", payload, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingAttachResponse(result.response as never)
          }),
        )
        .handle("previewAttach", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("previewAttach", payload, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingPreviewAttachResponse(result.response as never)
          }),
        )
        .handle("aggregateEvents", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("aggregateEvents", payload, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingAggregateEventsResponse(result.response as never)
          }),
        )
        .handle("openCustomerPortal", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            const result = yield* autumnService.call("openCustomerPortal", payload, tenant.orgId).pipe(mapAutumnError)
            yield* assertOk(result)
            return new BillingCustomerPortalResponse(result.response as never)
          }),
        )
    }),
)
