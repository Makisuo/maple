import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AlertsService } from "../services/AlertsService"

export const HttpAlertsLive = HttpApiBuilder.group(MapleApi, "alerts", (handlers) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService

		return handlers
			.handle("listDestinations", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* alerts.listDestinations(tenant.orgId)
				}).pipe(Effect.withSpan("alerts.listDestinations")),
			)
			.handle("createDestination", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, userId: tenant.userId })
					return yield* alerts.createDestination(tenant.orgId, tenant.userId, tenant.roles, payload)
				}).pipe(Effect.withSpan("alerts.createDestination")),
			)
			.handle("updateDestination", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						userId: tenant.userId,
						destinationId: params.destinationId,
					})
					return yield* alerts.updateDestination(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.destinationId,
						payload,
					)
				}).pipe(Effect.withSpan("alerts.updateDestination")),
			)
			.handle("deleteDestination", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						destinationId: params.destinationId,
					})
					return yield* alerts.deleteDestination(tenant.orgId, tenant.roles, params.destinationId)
				}).pipe(Effect.withSpan("alerts.deleteDestination")),
			)
			.handle("testDestination", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						userId: tenant.userId,
						destinationId: params.destinationId,
					})
					return yield* alerts.testDestination(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.destinationId,
					)
				}).pipe(Effect.withSpan("alerts.testDestination")),
			)
			.handle("listRules", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* alerts.listRules(tenant.orgId)
				}).pipe(Effect.withSpan("alerts.listRules")),
			)
			.handle("createRule", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, userId: tenant.userId })
					return yield* alerts.createRule(tenant.orgId, tenant.userId, tenant.roles, payload)
				}).pipe(Effect.withSpan("alerts.createRule")),
			)
			.handle("updateRule", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						userId: tenant.userId,
						ruleId: params.ruleId,
					})
					return yield* alerts.updateRule(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.ruleId,
						payload,
					)
				}).pipe(Effect.withSpan("alerts.updateRule")),
			)
			.handle("deleteRule", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, ruleId: params.ruleId })
					return yield* alerts.deleteRule(tenant.orgId, tenant.roles, params.ruleId)
				}).pipe(Effect.withSpan("alerts.deleteRule")),
			)
			.handle("testRule", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, userId: tenant.userId })
					return yield* alerts.testRule(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						payload.rule,
						payload.sendNotification ?? false,
					)
				}).pipe(Effect.withSpan("alerts.testRule")),
			)
			.handle("previewRule", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* alerts.previewRule(tenant.orgId, payload)
				}).pipe(Effect.withSpan("alerts.previewRule")),
			)
			.handle("listIncidents", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* alerts.listIncidents(tenant.orgId)
				}).pipe(Effect.withSpan("alerts.listIncidents")),
			)
			.handle("listRuleChecks", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, ruleId: params.ruleId })
					return yield* alerts.listRuleChecks(tenant.orgId, params.ruleId, {
						groupKey: query.groupKey,
						since: query.since,
						until: query.until,
						limit: query.limit ?? 500,
					})
				}).pipe(Effect.withSpan("alerts.listRuleChecks")),
			)
			.handle("listDeliveryEvents", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* alerts.listDeliveryEvents(tenant.orgId)
				}).pipe(Effect.withSpan("alerts.listDeliveryEvents")),
			)
	}),
)
