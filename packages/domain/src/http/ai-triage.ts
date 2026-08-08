import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString, UserId } from "../primitives"
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
// Settings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AiTriagePersistenceError extends Schema.TaggedError<AiTriagePersistenceError>()(
	"@maple/http/ai-triage/AiTriagePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AiTriageForbiddenError extends Schema.TaggedError<AiTriageForbiddenError>()(
	"@maple/http/ai-triage/AiTriageForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class AiTriageValidationError extends Schema.TaggedError<AiTriageValidationError>()(
	"@maple/http/ai-triage/AiTriageValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

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
	.prefix("/api/ai-triage")
	.middleware(Authorization) {}
