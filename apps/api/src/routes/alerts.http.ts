import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AlertsService } from "../services/AlertsService"

export const HttpAlertsLive = HttpApiBuilder.group(
  MapleApi,
  "alerts",
  (handlers) =>
    Effect.gen(function* () {
      const alerts = yield* AlertsService

      return handlers
        .handle("listDestinations", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.listDestinations(tenant.orgId)
          }),
        )
        .handle("createDestination", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.createDestination(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              payload,
            )
          }),
        )
        .handle("updateDestination", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.updateDestination(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              params.destinationId,
              payload,
            )
          }),
        )
        .handle("deleteDestination", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.deleteDestination(
              tenant.orgId,
              tenant.roles,
              params.destinationId,
            )
          }),
        )
        .handle("testDestination", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.testDestination(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              params.destinationId,
            )
          }),
        )
        .handle("listRules", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.listRules(tenant.orgId)
          }),
        )
        .handle("createRule", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.createRule(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              payload,
            )
          }),
        )
        .handle("updateRule", ({ params, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.updateRule(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              params.ruleId,
              payload,
            )
          }),
        )
        .handle("deleteRule", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.deleteRule(
              tenant.orgId,
              tenant.roles,
              params.ruleId,
            )
          }),
        )
        .handle("testRule", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.testRule(
              tenant.orgId,
              tenant.userId,
              tenant.roles,
              payload.rule,
              payload.sendNotification ?? false,
            )
          }),
        )
        .handle("listIncidents", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.listIncidents(tenant.orgId)
          }),
        )
        .handle("listDeliveryEvents", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* alerts.listDeliveryEvents(tenant.orgId)
          }),
        )
    }),
)
