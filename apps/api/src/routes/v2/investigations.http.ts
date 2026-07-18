import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InvestigationDocument, InvestigationSubject } from "@maple/domain/http"
import {
	AlertIncidentId,
	AnomalyIncidentId,
	CurrentTenant,
	ErrorIncidentId,
	InvestigationCreateRequest,
	InvestigationFreeformSubject,
	InvestigationId,
	InvestigationIncidentSubject,
	TraceId,
} from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	invalidRequest,
	paginateOffsetQuery,
	resourceNotFound,
} from "@maple/domain/http/v2"
import type {
	V2Investigation,
	V2InvestigationCreateSubject,
	V2InvestigationSubject,
} from "@maple/domain/http/v2"
import { Effect, Match, Schema } from "effect"
import { InvestigationService } from "../../services/InvestigationService"

class InvestigationSubjectDecodeError extends Schema.TaggedErrorClass<InvestigationSubjectDecodeError>()(
	"@maple/api/routes/v2/InvestigationSubjectDecodeError",
	{
		investigationId: InvestigationId,
		field: Schema.String,
		value: Schema.String,
		incidentKind: Schema.optionalKey(Schema.String),
		incidentId: Schema.optionalKey(Schema.String),
		message: Schema.String,
	},
) {}

const toWireSubject = Effect.fn("HttpV2Investigations.toWireSubject")(function* (
	investigationId: InvestigationId,
	subject: InvestigationSubject,
): Effect.fn.Return<V2InvestigationSubject, InvestigationSubjectDecodeError> {
	yield* Effect.annotateCurrentSpan(
		subject.type === "incident"
			? {
					investigationId,
					incidentKind: subject.incidentKind,
					incidentId: subject.incidentId,
				}
			: { investigationId },
	)
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
		issue_id: subject.issueId ?? null,
	}
	const decodeFailure = () =>
		new InvestigationSubjectDecodeError({
			investigationId,
			field: "subject.incident_id",
			value: subject.incidentId,
			incidentKind: subject.incidentKind,
			incidentId: subject.incidentId,
			message: "Stored investigation subject contains an invalid incident identifier",
		})
	return yield* Match.value(subject.incidentKind).pipe(
		Match.when("error", () =>
			Schema.decodeUnknownEffect(ErrorIncidentId)(subject.incidentId).pipe(
				Effect.catchTag("SchemaError", () => Effect.fail(decodeFailure())),
				Effect.map((incidentId) => ({
					...shared,
					incident_kind: "error" as const,
					incident_id: incidentId,
				})),
			),
		),
		Match.when("anomaly", () =>
			Schema.decodeUnknownEffect(AnomalyIncidentId)(subject.incidentId).pipe(
				Effect.catchTag("SchemaError", () => Effect.fail(decodeFailure())),
				Effect.map((incidentId) => ({
					...shared,
					incident_kind: "anomaly" as const,
					incident_id: incidentId,
				})),
			),
		),
		Match.when("alert", () =>
			Schema.decodeUnknownEffect(AlertIncidentId)(subject.incidentId).pipe(
				Effect.catchTag("SchemaError", () => Effect.fail(decodeFailure())),
				Effect.map((incidentId) => ({
					...shared,
					incident_kind: "alert" as const,
					incident_id: incidentId,
				})),
			),
		),
		Match.exhaustive,
	)
})

const toInternalSubject = (subject: V2InvestigationCreateSubject): InvestigationSubject =>
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

const toV2Investigation = Effect.fn("HttpV2Investigations.toV2Investigation")(function* (
	doc: InvestigationDocument,
): Effect.fn.Return<V2Investigation, InvestigationSubjectDecodeError> {
	yield* Effect.annotateCurrentSpan("investigationId", doc.id)
	const decodeReportTraceId = (traceId: string) =>
		Schema.decodeUnknownEffect(TraceId)(traceId).pipe(
			Effect.catchTag("SchemaError", () =>
				Effect.fail(
					new InvestigationSubjectDecodeError({
						investigationId: doc.id,
						field: "report.evidence.trace_ids",
						value: traceId,
						message: "Stored investigation report contains an invalid trace identifier",
					}),
				),
			),
		)
	const report =
		doc.report === null
			? null
			: {
					...doc.report,
					evidence: yield* Effect.forEach(doc.report.evidence, (entry) =>
						Effect.map(Effect.forEach(entry.traceIds, decodeReportTraceId), (traceIds) => ({
							...entry,
							traceIds,
						})),
					),
				}
	return {
		id: doc.id,
		object: "investigation",
		status: doc.status,
		subject: yield* toWireSubject(doc.id, doc.subject),
		report,
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
	}
})

/** Service tagged errors → v2 envelope errors (no 404 on the contract). */
const mapCommonError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/investigations/InvestigationValidationError"
		? invalidRequest("parameter_invalid", error.message)
		: dependencyUnavailable("investigation_operation_unavailable")

/** Service tagged errors → v2 envelope errors (endpoints with a 404). */
const mapWith404 = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/investigations/InvestigationNotFoundError"
		? resourceNotFound("investigation", "No such investigation.")
		: mapCommonError(error)

const mapSubjectDecodeError = (error: InvestigationSubjectDecodeError) =>
	Effect.logError(error.message).pipe(
		Effect.annotateLogs({
			investigationId: error.investigationId,
			field: error.field,
			value: error.value,
			...(error.incidentKind !== undefined ? { incidentKind: error.incidentKind } : {}),
			...(error.incidentId !== undefined ? { incidentId: error.incidentId } : {}),
		}),
		Effect.andThen(Effect.fail(dependencyUnavailable("investigation_subject_decode_failed"))),
	)

export const HttpV2InvestigationsLive = HttpApiBuilder.group(MapleApiV2, "investigations", (handlers) =>
	Effect.gen(function* () {
		const service = yield* InvestigationService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						service
							.listInvestigations(tenant.orgId, {
								...(query.status !== undefined ? { status: query.status } : {}),
								...(query.issue_id !== undefined ? { issueId: query.issue_id } : {}),
								...(query.incident_kind !== undefined
									? { incidentKind: query.incident_kind }
									: {}),
								...(query.incident_id !== undefined ? { incidentId: query.incident_id } : {}),
								limit,
								offset,
							})
							.pipe(
								Effect.mapError(mapCommonError),
								Effect.flatMap((response) =>
									Effect.forEach(response.investigations, toV2Investigation),
								),
								Effect.catchTag(
									"@maple/api/routes/v2/InvestigationSubjectDecodeError",
									mapSubjectDecodeError,
								),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service
						.getInvestigation(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapWith404))
					return yield* toV2Investigation(doc).pipe(
						Effect.catchTag(
							"@maple/api/routes/v2/InvestigationSubjectDecodeError",
							mapSubjectDecodeError,
						),
					)
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
					return yield* toV2Investigation(doc).pipe(
						Effect.catchTag(
							"@maple/api/routes/v2/InvestigationSubjectDecodeError",
							mapSubjectDecodeError,
						),
					)
				}),
			)
			.handle("updateStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service
						.updateStatus(tenant.orgId, params.id, payload.status)
						.pipe(Effect.mapError(mapWith404))
					return yield* toV2Investigation(doc).pipe(
						Effect.catchTag(
							"@maple/api/routes/v2/InvestigationSubjectDecodeError",
							mapSubjectDecodeError,
						),
					)
				}),
			)
	}),
)
