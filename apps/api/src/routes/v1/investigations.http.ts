import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	InvestigationDataCorruptionError,
	InvestigationPersistenceError,
	MapleApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { InvestigationService } from "@/services/errors/InvestigationService"

// v1 keeps its existing generic persistence response for unreadable stored
// investigation data; v2 exposes the exact corruption tag.
const preserveV1InvestigationErrors = <A, E, R>(
	effect: Effect.Effect<A, E | InvestigationDataCorruptionError, R>,
) =>
	effect.pipe(
		Effect.catchTag("@maple/http/investigations/InvestigationDataCorruptionError", (error) =>
			Effect.fail(
				new InvestigationPersistenceError({
					message:
						error instanceof InvestigationDataCorruptionError
							? error.message
							: "Stored investigation data is invalid",
				}),
			),
		),
	)

/**
 * User-facing investigation endpoints (Clerk-authed via the group's
 * Authorization middleware). The internal `submit_diagnosis` write is a separate
 * service-token-guarded group
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
					return yield* service
						.listInvestigations(tenant.orgId, {
							issueId: query.issueId,
							incidentKind: query.incidentKind,
							incidentId: query.incidentId,
							status: query.status,
							limit: query.limit,
						})
						.pipe(preserveV1InvestigationErrors)
				}).pipe(Effect.withSpan("HttpInvestigations.list")),
			)
			.handle("getInvestigation", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.id": params.id,
					})
					return yield* service
						.getInvestigation(tenant.orgId, params.id)
						.pipe(preserveV1InvestigationErrors)
				}).pipe(Effect.withSpan("HttpInvestigations.get")),
			)
			.handle("createInvestigation", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.subject_type": payload.subject.type,
					})
					return yield* service
						.createAndStartInvestigation(tenant.orgId, tenant.userId, payload)
						.pipe(preserveV1InvestigationErrors)
				}).pipe(Effect.withSpan("HttpInvestigations.create")),
			)
			.handle("restartInvestigation", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.investigation.id": params.id,
					})
					return yield* service
						.restartInvestigation(tenant.orgId, params.id)
						.pipe(preserveV1InvestigationErrors)
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
					return yield* service
						.updateStatus(tenant.orgId, params.id, payload.status)
						.pipe(preserveV1InvestigationErrors)
				}).pipe(Effect.withSpan("HttpInvestigations.updateStatus")),
			)
	}),
)
