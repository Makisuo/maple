import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InvestigationDocument, InvestigationSubject } from "@maple/domain/http"
import {
	CurrentTenant,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
} from "@maple/domain/http"
import { MapleApiV2, invalidRequest, notFound, paginateArray, serviceUnavailable } from "@maple/domain/http/v2"
import type { V2Investigation, V2InvestigationSubject } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { InvestigationService } from "../../services/InvestigationService"

/** v1 list caps at the most recent N rows; v2 cursor-paginates over that window. */
const LIST_FETCH_LIMIT = 100

const toWireSubject = (subject: InvestigationSubject): V2InvestigationSubject =>
	subject.type === "incident"
		? {
				type: "incident",
				incident_kind: subject.incidentKind,
				incident_id: subject.incidentId,
				...(subject.issueId !== undefined ? { issue_id: subject.issueId } : {}),
			}
		: {
				type: "freeform",
				title: subject.title,
				prompt: subject.prompt,
				context_refs: subject.contextRefs,
			}

const toInternalSubject = (subject: V2InvestigationSubject): InvestigationSubject =>
	subject.type === "incident"
		? new InvestigationIncidentSubject({
				type: "incident",
				incidentKind: subject.incident_kind,
				incidentId: subject.incident_id,
				...(subject.issue_id !== undefined ? { issueId: subject.issue_id } : {}),
			})
		: new InvestigationFreeformSubject({
				type: "freeform",
				title: subject.title,
				prompt: subject.prompt,
				contextRefs: subject.context_refs,
			})

const toV2Investigation = (doc: InvestigationDocument): V2Investigation => ({
	id: doc.id,
	object: "investigation",
	status: doc.status,
	subject: toWireSubject(doc.subject),
	report: doc.report,
	model: doc.model,
	severity: doc.severity,
	confidence: doc.confidence,
	seeded_by: doc.seededBy,
	created_by: doc.createdBy,
	input_tokens: doc.inputTokens,
	output_tokens: doc.outputTokens,
	error: doc.error,
	created_at: doc.createdAt,
	diagnosed_at: doc.diagnosedAt,
	updated_at: doc.updatedAt,
})

/** Service tagged errors → v2 envelope errors (no 404 on the contract). */
const mapCommonError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/investigations/InvestigationValidationError"
		? invalidRequest("parameter_invalid", error.message)
		: serviceUnavailable(error.message)

/** Service tagged errors → v2 envelope errors (endpoints with a 404). */
const mapWith404 = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/investigations/InvestigationNotFoundError"
		? notFound(error.message, "id")
		: mapCommonError(error)

export const HttpV2InvestigationsLive = HttpApiBuilder.group(MapleApiV2, "investigations", (handlers) =>
	Effect.gen(function* () {
		const service = yield* InvestigationService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* service
						.listInvestigations(tenant.orgId, {
							...(query.status !== undefined ? { status: query.status } : {}),
							...(query.issue_id !== undefined ? { issueId: query.issue_id } : {}),
							...(query.incident_kind !== undefined ? { incidentKind: query.incident_kind } : {}),
							...(query.incident_id !== undefined ? { incidentId: query.incident_id } : {}),
							limit: LIST_FETCH_LIMIT,
						})
						.pipe(Effect.mapError(mapCommonError))
					const page = paginateArray(response.investigations.map(toV2Investigation), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service
						.getInvestigation(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapWith404))
					return toV2Investigation(doc)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service
						.createInvestigation(
							tenant.orgId,
							tenant.userId,
							new InvestigationCreateRequest({ subject: toInternalSubject(payload.subject) }),
						)
						.pipe(Effect.mapError(mapCommonError))
					return toV2Investigation(doc)
				}),
			)
			.handle("updateStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service
						.updateStatus(tenant.orgId, params.id, payload.status)
						.pipe(Effect.mapError(mapWith404))
					return toV2Investigation(doc)
				}),
			)
	}),
)
