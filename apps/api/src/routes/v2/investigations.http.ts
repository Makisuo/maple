import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InvestigationDocument, InvestigationSubject } from "@maple/domain/http"
import {
	AlertIncidentId,
	AnomalyIncidentId,
	CurrentTenant,
	ErrorIncidentId,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
} from "@maple/domain/http"
import {
	LIST_LIMIT_DEFAULT,
	MapleApiV2,
	decodeOffsetCursorEffect,
	encodeOffsetCursor,
	invalidRequest,
	notFound,
	serviceUnavailable,
} from "@maple/domain/http/v2"
import type { V2Investigation, V2InvestigationSubject } from "@maple/domain/http/v2"
import { Effect, Match, Schema } from "effect"
import { InvestigationService } from "../../services/InvestigationService"

const decodeErrorIncidentId = Schema.decodeSync(ErrorIncidentId)
const decodeAnomalyIncidentId = Schema.decodeSync(AnomalyIncidentId)
const decodeAlertIncidentId = Schema.decodeSync(AlertIncidentId)

const toWireSubject = (subject: InvestigationSubject): V2InvestigationSubject => {
	if (subject.type === "freeform") {
		return {
			type: "freeform",
			title: subject.title,
			prompt: subject.prompt,
			context_refs: subject.contextRefs,
		}
	}
	const shared = {
		type: "incident" as const,
		...(subject.issueId !== undefined ? { issue_id: subject.issueId } : {}),
	}
	return Match.value(subject.incidentKind).pipe(
		Match.when("error", () => ({
			...shared,
			incident_kind: "error" as const,
			incident_id: decodeErrorIncidentId(subject.incidentId),
		})),
		Match.when("anomaly", () => ({
			...shared,
			incident_kind: "anomaly" as const,
			incident_id: decodeAnomalyIncidentId(subject.incidentId),
		})),
		Match.when("alert", () => ({
			...shared,
			incident_kind: "alert" as const,
			incident_id: decodeAlertIncidentId(subject.incidentId),
		})),
		Match.exhaustive,
	)
}

const toInternalSubject = (subject: V2InvestigationSubject): InvestigationSubject =>
	subject.type === "incident"
		? new InvestigationIncidentSubject({
				type: "incident",
				incidentKind: subject.incident_kind,
				incidentId: String(subject.incident_id),
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
					const limit = query.limit ?? LIST_LIMIT_DEFAULT
					const offset = yield* decodeOffsetCursorEffect(query.cursor)
					const response = yield* service
						.listInvestigations(tenant.orgId, {
							...(query.status !== undefined ? { status: query.status } : {}),
							...(query.issue_id !== undefined ? { issueId: query.issue_id } : {}),
							...(query.incident_kind !== undefined
								? { incidentKind: query.incident_kind }
								: {}),
							...(query.incident_id !== undefined
								? { incidentId: String(query.incident_id) }
								: {}),
							limit: limit + 1,
							offset,
						})
						.pipe(Effect.mapError(mapCommonError))
					const items = response.investigations.map(toV2Investigation)
					const hasMore = items.length > limit
					return {
						object: "list" as const,
						data: hasMore ? items.slice(0, limit) : items,
						has_more: hasMore,
						next_cursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
					}
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
