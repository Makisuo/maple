import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AiTriageRunId, ErrorIssueId, IsoDateTimeString, UserId } from "../primitives"
import { Authorization } from "./current-tenant"
import { IssueSeverity } from "./errors"

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export const AiTriageIncidentKind = Schema.Literals(["error", "anomaly", "alert"]).annotate({
	identifier: "@maple/AiTriageIncidentKind",
	title: "AI Triage Incident Kind",
})
export type AiTriageIncidentKind = Schema.Schema.Type<typeof AiTriageIncidentKind>

export const AiTriageRunStatus = Schema.Literals(["queued", "running", "completed", "failed"]).annotate({
	identifier: "@maple/AiTriageRunStatus",
	title: "AI Triage Run Status",
})
export type AiTriageRunStatus = Schema.Schema.Type<typeof AiTriageRunStatus>

// ---------------------------------------------------------------------------
// Structured triage result (what the agent must submit)
// ---------------------------------------------------------------------------

export class AiTriageEvidence extends Schema.Class<AiTriageEvidence>("AiTriageEvidence")({
	traceIds: Schema.Array(Schema.String),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
}) {}

export class AiTriageResult extends Schema.Class<AiTriageResult>("AiTriageResult")({
	summary: Schema.String,
	suspectedCause: Schema.String,
	// Shares the canonical IssueSeverity literal so the agent's assessment can
	// be applied to issues verbatim without a mapping layer.
	severityAssessment: IssueSeverity,
	affectedScope: Schema.String,
	evidence: Schema.Array(AiTriageEvidence),
	suggestedActions: Schema.Array(Schema.String),
	confidence: Schema.Literals(["high", "medium", "low"]),
	/**
	 * Causes that were checked and eliminated, each with the evidence that
	 * eliminated it — "Deploy: service.version unchanged across 41k spans in the
	 * window".
	 *
	 * This is what makes a report believable in either direction. A named cause is
	 * only as credible as what else was considered, and an "unknown" that lists
	 * nothing is indistinguishable from not having investigated at all — which is
	 * precisely how a diagnosis of "it's an unknown error" used to be a compliant
	 * answer.
	 *
	 * `optionalKey` so every report already stored still decodes, and deliberately
	 * *not* enforced at the tool boundary: the prompts require it. A schema that
	 * rejects a submission teaches the model to satisfy the validator rather than
	 * to do the work, and a rejected submission at the end of a spent budget loses
	 * the whole investigation.
	 */
	ruledOut: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export class AiTriageRunDocument extends Schema.Class<AiTriageRunDocument>("AiTriageRunDocument")({
	id: AiTriageRunId,
	incidentKind: AiTriageIncidentKind,
	incidentId: Schema.String,
	issueId: Schema.NullOr(ErrorIssueId),
	status: AiTriageRunStatus,
	result: Schema.NullOr(AiTriageResult),
	model: Schema.NullOr(Schema.String),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	startedAt: Schema.NullOr(IsoDateTimeString),
	completedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class AiTriageRunsListResponse extends Schema.Class<AiTriageRunsListResponse>(
	"AiTriageRunsListResponse",
)({
	runs: Schema.Array(AiTriageRunDocument),
}) {}

export class AiTriageSettingsDocument extends Schema.Class<AiTriageSettingsDocument>(
	"AiTriageSettingsDocument",
)({
	enabled: Schema.Boolean,
	maxRunsPerDay: Schema.Number,
	/** Model passes per day — one investigation spends about six. */
	maxPassesPerDay: Schema.Number,
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class AiTriageSettingsUpdateRequest extends Schema.Class<AiTriageSettingsUpdateRequest>(
	"AiTriageSettingsUpdateRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	maxRunsPerDay: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
	maxPassesPerDay: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2000 })),
	),
}) {}

export class AiTriageRunCreateRequest extends Schema.Class<AiTriageRunCreateRequest>(
	"AiTriageRunCreateRequest",
)({
	incidentKind: AiTriageIncidentKind,
	incidentId: Schema.String,
	issueId: Schema.optionalKey(ErrorIssueId),
}) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AiTriagePersistenceError extends Schema.TaggedErrorClass<AiTriagePersistenceError>()(
	"@maple/http/ai-triage/AiTriagePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AiTriageForbiddenError extends Schema.TaggedErrorClass<AiTriageForbiddenError>()(
	"@maple/http/ai-triage/AiTriageForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class AiTriageValidationError extends Schema.TaggedErrorClass<AiTriageValidationError>()(
	"@maple/http/ai-triage/AiTriageValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class AiTriageNotFoundError extends Schema.TaggedErrorClass<AiTriageNotFoundError>()(
	"@maple/http/ai-triage/AiTriageNotFoundError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const RunsListQuery = Schema.Struct({
	issueId: Schema.optional(ErrorIssueId),
	incidentId: Schema.optional(Schema.String),
	incidentKind: Schema.optional(AiTriageIncidentKind),
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
})

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class AiTriageApiGroup extends HttpApiGroup.make("aiTriage")
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: AiTriageSettingsDocument,
			error: AiTriagePersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSettings", "/settings", {
			payload: AiTriageSettingsUpdateRequest,
			success: AiTriageSettingsDocument,
			error: [AiTriagePersistenceError, AiTriageForbiddenError, AiTriageValidationError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRuns", "/runs", {
			query: RunsListQuery,
			success: AiTriageRunsListResponse,
			error: AiTriagePersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("createRun", "/runs", {
			payload: AiTriageRunCreateRequest,
			success: AiTriageRunDocument,
			error: [AiTriagePersistenceError, AiTriageValidationError, AiTriageNotFoundError],
		}),
	)
	.prefix("/api/ai-triage")
	.middleware(Authorization) {}
