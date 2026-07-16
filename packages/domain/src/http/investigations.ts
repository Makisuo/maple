import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ErrorIssueId, InvestigationId, IsoDateTimeString, UserId } from "../primitives"
import { AiTriageIncidentKind, AiTriageResult } from "./ai-triage"
import { Authorization } from "./current-tenant"
import { IssueSeverity } from "./errors"

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a durable investigation "war-room". `investigating` covers the
 * autonomous diagnostic pass (the agent's first turn); `diagnosed` is set once
 * `submit_diagnosis` lands a report; `resolved` is a human-closed terminal.
 */
export const InvestigationStatus = Schema.Literals([
	"investigating",
	"diagnosed",
	"resolved",
	"failed",
]).annotate({
	identifier: "@maple/InvestigationStatus",
	title: "Investigation Status",
})
export type InvestigationStatus = Schema.Schema.Type<typeof InvestigationStatus>

/** Who opened the investigation: a person (attended) or an incident-open trigger. */
export const InvestigationSeededBy = Schema.Literals(["user", "system"]).annotate({
	identifier: "@maple/InvestigationSeededBy",
	title: "Investigation Seeded By",
})
export type InvestigationSeededBy = Schema.Schema.Type<typeof InvestigationSeededBy>

export const InvestigationConfidence = Schema.Literals(["high", "medium", "low"]).annotate({
	identifier: "@maple/InvestigationConfidence",
	title: "Investigation Confidence",
})
export type InvestigationConfidence = Schema.Schema.Type<typeof InvestigationConfidence>

// ---------------------------------------------------------------------------
// Subject (what is being investigated)
// ---------------------------------------------------------------------------

/**
 * A page/entity context hint carried by a free-form investigation — structurally
 * the web's `AutoContext` (service / trace / dashboard / error_issue / …). Kept
 * as an open record so the web can pass `deriveAutoContexts(pathname)` output
 * verbatim without a domain-side mapping layer; the agent reads them as JSON.
 */
export const InvestigationContextRef = Schema.Record(Schema.String, Schema.Unknown)
export type InvestigationContextRef = Schema.Schema.Type<typeof InvestigationContextRef>

/** Investigation anchored to a typed incident (error / alert / anomaly). */
export class InvestigationIncidentSubject extends Schema.Class<InvestigationIncidentSubject>(
	"InvestigationIncidentSubject",
)({
	type: Schema.Literal("incident"),
	incidentKind: AiTriageIncidentKind,
	incidentId: Schema.String,
	issueId: Schema.optionalKey(ErrorIssueId),
}) {}

/** "Investigate something else completely" — a user question with optional context. */
export class InvestigationFreeformSubject extends Schema.Class<InvestigationFreeformSubject>(
	"InvestigationFreeformSubject",
)({
	type: Schema.Literal("freeform"),
	title: Schema.String,
	prompt: Schema.String,
	contextRefs: Schema.Array(InvestigationContextRef),
}) {}

export const InvestigationSubject = Schema.Union([
	InvestigationIncidentSubject,
	InvestigationFreeformSubject,
]).annotate({ identifier: "@maple/InvestigationSubject", title: "Investigation Subject" })
export type InvestigationSubject = Schema.Schema.Type<typeof InvestigationSubject>

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export class InvestigationDocument extends Schema.Class<InvestigationDocument>("InvestigationDocument")({
	id: InvestigationId,
	status: InvestigationStatus,
	subject: InvestigationSubject,
	/** The latest structured diagnosis, or null until the first `submit_diagnosis`. */
	report: Schema.NullOr(AiTriageResult),
	model: Schema.NullOr(Schema.String),
	/** Denormalized from the report for cheap war-room list rendering. */
	severity: Schema.NullOr(IssueSeverity),
	confidence: Schema.NullOr(InvestigationConfidence),
	seededBy: InvestigationSeededBy,
	createdBy: Schema.NullOr(UserId),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	diagnosedAt: Schema.NullOr(IsoDateTimeString),
	updatedAt: IsoDateTimeString,
}) {}

export class InvestigationsListResponse extends Schema.Class<InvestigationsListResponse>(
	"InvestigationsListResponse",
)({
	investigations: Schema.Array(InvestigationDocument),
}) {}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class InvestigationCreateRequest extends Schema.Class<InvestigationCreateRequest>(
	"InvestigationCreateRequest",
)({
	subject: InvestigationSubject,
}) {}

export class InvestigationStatusUpdateRequest extends Schema.Class<InvestigationStatusUpdateRequest>(
	"InvestigationStatusUpdateRequest",
)({
	status: InvestigationStatus,
}) {}

/**
 * The internal write the chat-flue `submit_diagnosis` tool posts once the
 * agent finishes its diagnostic pass. Carries the structured report plus the
 * model + token usage for billing/observability. Re-uses `AiTriageResult` and
 * `AiTriageEvidence` verbatim — the report shape is unchanged.
 */
export class SubmitDiagnosisRequest extends Schema.Class<SubmitDiagnosisRequest>("SubmitDiagnosisRequest")({
	report: AiTriageResult,
	model: Schema.optionalKey(Schema.String),
	inputTokens: Schema.optionalKey(Schema.Number),
	outputTokens: Schema.optionalKey(Schema.Number),
}) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvestigationPersistenceError extends Schema.TaggedErrorClass<InvestigationPersistenceError>()(
	"@maple/http/investigations/InvestigationPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class InvestigationValidationError extends Schema.TaggedErrorClass<InvestigationValidationError>()(
	"@maple/http/investigations/InvestigationValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class InvestigationNotFoundError extends Schema.TaggedErrorClass<InvestigationNotFoundError>()(
	"@maple/http/investigations/InvestigationNotFoundError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const InvestigationsListQuery = Schema.Struct({
	/** War-room filter: only investigations for this error issue. */
	issueId: Schema.optional(ErrorIssueId),
	incidentKind: Schema.optional(AiTriageIncidentKind),
	incidentId: Schema.optional(Schema.String),
	status: Schema.optional(InvestigationStatus),
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
})

// ---------------------------------------------------------------------------
// API group (user-facing; diagnosis submission crosses the internal Worker RPC
// boundary and is not part of this Clerk-authenticated HTTP group)
// ---------------------------------------------------------------------------

export class InvestigationApiGroup extends HttpApiGroup.make("investigations")
	.add(
		HttpApiEndpoint.get("listInvestigations", "/", {
			query: InvestigationsListQuery,
			success: InvestigationsListResponse,
			error: InvestigationPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getInvestigation", "/:id", {
			params: { id: InvestigationId },
			success: InvestigationDocument,
			error: [InvestigationPersistenceError, InvestigationNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("createInvestigation", "/", {
			payload: InvestigationCreateRequest,
			success: InvestigationDocument,
			error: [InvestigationPersistenceError, InvestigationValidationError, InvestigationNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("updateInvestigationStatus", "/:id/status", {
			params: { id: InvestigationId },
			payload: InvestigationStatusUpdateRequest,
			success: InvestigationDocument,
			error: [InvestigationPersistenceError, InvestigationNotFoundError],
		}),
	)
	.prefix("/api/investigations")
	.middleware(Authorization) {}
