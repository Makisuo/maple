import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { InvestigationService } from "@/services/errors/InvestigationService"

/**
 * User-facing investigation endpoints (Clerk-authed via the group's
 * Authorization middleware). The internal `submit_diagnosis` write the chat-flue
 * agent posts is a separate service-token-guarded group
 * (`InvestigationsInternalApiGroup`), not part of this one.
 */
export const HttpInvestigationsLive = HttpApiBuilder.group(MapleApi, "investigations", (handlers) =>
	Effect.gen(function* () {
		const service = yield* InvestigationService

		return handlers
			.handle("listInvestigations", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* service.listInvestigations(tenant.orgId, {
						issueId: query.issueId,
						incidentKind: query.incidentKind,
						incidentId: query.incidentId,
						status: query.status,
						limit: query.limit,
					})
				}).pipe(Effect.withSpan("HttpInvestigations.list")),
			)
			.handle("getInvestigation", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.id": params.id,
					})
					return yield* service.getInvestigation(tenant.orgId, params.id)
				}).pipe(Effect.withSpan("HttpInvestigations.get")),
			)
			.handle("createInvestigation", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.subject_type": payload.subject.type,
					})
					return yield* service.createAndStartInvestigation(tenant.orgId, tenant.userId, payload, {
						automatic: false,
					})
				}).pipe(Effect.withSpan("HttpInvestigations.create")),
			)
			.handle("restartInvestigation", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.id": params.id,
					})
					return yield* service.restartInvestigation(tenant.orgId, params.id)
				}).pipe(Effect.withSpan("HttpInvestigations.restart")),
			)
			.handle("updateInvestigationStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.id": params.id,
						"maple.investigation.status": payload.status,
					})
					return yield* service.updateStatus(tenant.orgId, params.id, payload.status)
				}).pipe(Effect.withSpan("HttpInvestigations.updateStatus")),
			)
	}),
)
