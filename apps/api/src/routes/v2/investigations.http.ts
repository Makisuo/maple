import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { InvestigationDocument, InvestigationSubject } from "@maple/domain/http"
import {
	AlertIncidentId,
	AnomalyIncidentId,
	CurrentTenant,
	ErrorIncidentId,
	InvestigationCreateRequest,
	InvestigationDataCorruptionError,
	InvestigationFreeformSubject,
	InvestigationId,
	InvestigationIncidentSubject,
	InvestigationSubjectSnapshot,
	TraceId,
} from "@maple/domain/http"
import { MapleApiV2, paginateOffsetQuery } from "@maple/domain/http/v2"
import type {
	V2Investigation,
	V2InvestigationCreateParams,
	V2InvestigationCreateSubject,
	V2InvestigationSubject,
} from "@maple/domain/http/v2"
import { Effect, Match, Schema } from "effect"
import { InvestigationService } from "@/services/errors/InvestigationService"

const toWireSubject = Effect.fn("HttpV2Investigations.toWireSubject")(function* (
	investigationId: InvestigationId,
	subject: InvestigationSubject,
): Effect.fn.Return<V2InvestigationSubject, InvestigationDataCorruptionError> {
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
		new InvestigationDataCorruptionError({
			investigationId,
			field: "subject.incident_id",
			value: subject.incidentId,
			incidentKind: subject.incidentKind,
			incidentId: subject.incidentId,
			message: "Stored investigation subject contains an invalid incident identifier",
		})
	return yield* Match.value(subject.incidentKind).pipe(
		Match.when("error", () =>
			Schema.decodeEffect(ErrorIncidentId)(subject.incidentId).pipe(
				Effect.mapError(decodeFailure),
				Effect.map((incidentId) => ({
					...shared,
					incident_kind: "error" as const,
					incident_id: incidentId,
				})),
			),
		),
		Match.when("anomaly", () =>
			Schema.decodeEffect(AnomalyIncidentId)(subject.incidentId).pipe(
				Effect.mapError(decodeFailure),
				Effect.map((incidentId) => ({
					...shared,
					incident_kind: "anomaly" as const,
					incident_id: incidentId,
				})),
			),
		),
		Match.when("alert", () =>
			Schema.decodeEffect(AlertIncidentId)(subject.incidentId).pipe(
				Effect.mapError(decodeFailure),
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

const toInternalSnapshot = (snapshot: V2InvestigationCreateParams["snapshot"] | undefined) =>
	snapshot === undefined ? undefined : Schema.decodeSync(InvestigationSubjectSnapshot)(snapshot)

const toV2Investigation = Effect.fn("HttpV2Investigations.toV2Investigation")(function* (
	doc: InvestigationDocument,
): Effect.fn.Return<V2Investigation, InvestigationDataCorruptionError> {
	yield* Effect.annotateCurrentSpan("investigationId", doc.id)
	const decodeReportTraceId = (traceId: string) =>
		Schema.decodeEffect(TraceId)(traceId).pipe(
			Effect.mapError(
				() =>
					new InvestigationDataCorruptionError({
						investigationId: doc.id,
						field: "report.evidence.trace_ids",
						value: traceId,
						message: "Stored investigation report contains an invalid trace identifier",
					}),
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
		snapshot: doc.snapshot,
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
		started_at: doc.startedAt,
		diagnosed_at: doc.diagnosedAt,
		updated_at: doc.updatedAt,
		// Ordering is a contract — `LENS_DISPATCH_ORDER` decides which lenses a
		// narrow run gets — and the service already returns them ordered by ordinal.
		lens_runs: doc.lensRuns.map((lens) => ({
			lensId: lens.lensId,
			status: lens.status,
			verdict: lens.verdict,
			claim: lens.claim,
			reason: lens.reason,
			progressNote: lens.progressNote,
			confidence: lens.confidence,
			toolCount: lens.toolCount,
			elapsedSeconds: lens.elapsedSeconds,
			name: lens.name,
			question: lens.question,
			priority: lens.priority,
			deadlineHit: lens.deadlineHit,
		})),
		validator:
			doc.validator === null
				? null
				: {
						status: doc.validator.status,
						note: doc.validator.note,
						elapsedSeconds: doc.validator.elapsedSeconds,
					},
		fanout: { state: doc.fanout.state, size: doc.fanout.size },
	}
})

const logSubjectDecodeError = (error: InvestigationDataCorruptionError) =>
	Effect.logError(error.message).pipe(
		Effect.annotateLogs({
			investigationId: error.investigationId,
			field: error.field,
			value: error.value,
			...(error.incidentKind !== undefined ? { incidentKind: error.incidentKind } : {}),
			...(error.incidentId !== undefined ? { incidentId: error.incidentId } : {}),
		}),
	)

const serializeInvestigation = (doc: InvestigationDocument) =>
	toV2Investigation(doc).pipe(Effect.tapError(logSubjectDecodeError))

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
								Effect.flatMap((response) =>
									Effect.forEach(response.investigations, serializeInvestigation),
								),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service.getInvestigation(tenant.orgId, params.id)

					return yield* serializeInvestigation(doc)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service.createAndStartInvestigation(
						tenant.orgId,
						tenant.userId,
						new InvestigationCreateRequest({
							subject: toInternalSubject(payload.subject),
							...(payload.snapshot !== undefined
								? { snapshot: toInternalSnapshot(payload.snapshot) }
								: {}),
						}),
					)

					return yield* serializeInvestigation(doc)
				}),
			)
			.handle("restart", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service.restartInvestigation(tenant.orgId, params.id)

					return yield* serializeInvestigation(doc)
				}),
			)
			.handle("updateStatus", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const doc = yield* service.updateStatus(tenant.orgId, params.id, payload.status)

					return yield* serializeInvestigation(doc)
				}),
			)
	}),
)
