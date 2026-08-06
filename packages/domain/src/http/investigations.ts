import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ErrorIssueId, InvestigationId, IsoDateTimeString, UserId } from "../primitives"
import { AiTriageEvidence, AiTriageIncidentKind, AiTriageResult } from "./ai-triage"
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
// Fan-out (lenses + validator)
// ---------------------------------------------------------------------------

/**
 * A lens is a *framing*, not a tool: each dispatched agent gets the same subject
 * and one question to answer about it. The catalogue is fixed rather than
 * generated per run, which is the whole reason "ruled out" is comparable across
 * two investigations — a lens that finds nothing is still a result worth
 * printing.
 *
 * Array order is dispatch order.
 */
export const LensId = Schema.Literals([
	"deploy_correlation",
	"downstream_dependency",
	"resource_saturation",
	"traffic_shape",
	"config_flags",
]).annotate({ identifier: "@maple/LensId", title: "Lens" })
export type LensId = Schema.Schema.Type<typeof LensId>

/** Where the lens itself got to, independent of what the validator made of it. */
export const LensRunStatus = Schema.Literals(["queued", "checking", "reported", "no_finding"]).annotate({
	identifier: "@maple/LensRunStatus",
	title: "Lens Run Status",
})
export type LensRunStatus = Schema.Schema.Type<typeof LensRunStatus>

/** What the validator did with the lens's candidate. `pending` = not ranked yet. */
export const LensVerdict = Schema.Literals([
	"pending",
	"promoted",
	"merged",
	"ruled_out",
	"rejected",
]).annotate({ identifier: "@maple/LensVerdict", title: "Lens Verdict" })
export type LensVerdict = Schema.Schema.Type<typeof LensVerdict>

/**
 * Where the run as a whole is. `none` is the single-pass path — the gate in
 * `fanout-policy` declined to fan out — and is what every pre-fan-out row
 * backfills to.
 *
 * `superseded` means a later `submit_diagnosis` (a human follow-up in the Chat
 * tab) overwrote the report the validator promoted, so the lens verdicts no
 * longer explain what is on screen.
 */
export const InvestigationFanoutState = Schema.Literals([
	"none",
	"queued",
	"running",
	"validating",
	"ranked",
	"rejected_all",
	"superseded",
]).annotate({ identifier: "@maple/InvestigationFanoutState", title: "Fan-out State" })
export type InvestigationFanoutState = Schema.Schema.Type<typeof InvestigationFanoutState>

/** One dispatched lens, as the boards render it. */
export class InvestigationLensRun extends Schema.Class<InvestigationLensRun>("InvestigationLensRun")({
	lensId: LensId,
	status: LensRunStatus,
	verdict: LensVerdict,
	/** The candidate cause this lens put forward, or null if it never reached one. */
	claim: Schema.NullOr(Schema.String),
	/** The validator's one-line reason — the trust payload of the whole section. */
	reason: Schema.NullOr(Schema.String),
	/** What it is doing right now, while `status` is `checking`. */
	progressNote: Schema.NullOr(Schema.String),
	confidence: Schema.NullOr(InvestigationConfidence),
	toolCount: Schema.Number,
	elapsedSeconds: Schema.NullOr(Schema.Number),
}) {}

export class InvestigationValidator extends Schema.Class<InvestigationValidator>("InvestigationValidator")({
	/** `blocked` while lenses are still reporting — the validator has nothing to rank yet. */
	status: Schema.Literals(["blocked", "ranked", "rejected_all"]),
	note: Schema.String,
	elapsedSeconds: Schema.NullOr(Schema.Number),
}) {}

export class InvestigationFanout extends Schema.Class<InvestigationFanout>("InvestigationFanout")({
	state: InvestigationFanoutState,
	/** How many lenses were dispatched. 1 means the single-pass path. */
	size: Schema.Number,
}) {}

/**
 * What a lens agent returns. Deliberately *not* `AiTriageResult`: a lens produces
 * a candidate to be ranked, not a diagnosis to be published, and conflating the
 * two is how five rivals end up each looking like a finished verdict.
 */
export class LensCandidate extends Schema.Class<LensCandidate>("LensCandidate")({
	/** One sentence: the cause this lens is putting forward. */
	claim: Schema.String,
	/** How it would produce the observed symptoms — the causal chain, not a restatement. */
	mechanism: Schema.String,
	confidence: InvestigationConfidence,
	evidence: Schema.Array(AiTriageEvidence),
	/**
	 * What would falsify this claim, in the lens's own words. The validator reads
	 * it, and a candidate that cannot say what would disprove it should lose.
	 */
	selfDoubt: Schema.String,
	/** Concrete steps a human should take. Text today; actionable later. */
	suggestedActions: Schema.Array(Schema.String),
}) {}

/** The validator's ruling on one rival it did not promote. */
export class LensRival extends Schema.Class<LensRival>("LensRival")({
	lensId: LensId,
	verdict: Schema.Literals(["merged", "ruled_out", "rejected"]),
	/** One sentence saying why it lost. A verdict without one proves nothing. */
	reason: Schema.String,
}) {}

/**
 * The validator's output. `promotedLensId` is null exactly when `report` is —
 * that pair is the `validation_inconclusive` outcome: the lenses reported and
 * none of them held up, which is a real answer and not a failure to produce one.
 */
export class ValidatorVerdict extends Schema.Class<ValidatorVerdict>("ValidatorVerdict")({
	promotedLensId: Schema.NullOr(LensId),
	report: Schema.NullOr(AiTriageResult),
	rivals: Schema.Array(LensRival),
	/** One line summarising the ranking, shown on the validator lane. */
	note: Schema.String,
}) {}

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

/**
 * Stable, normalized rendering context captured when an investigation is
 * opened. It deliberately contains display-ready strings instead of source
 * table identifiers so old investigations remain understandable after the
 * originating telemetry or incident has expired.
 */
export class InvestigationSnapshotFact extends Schema.Class<InvestigationSnapshotFact>(
	"InvestigationSnapshotFact",
)({
	label: Schema.String,
	value: Schema.String,
}) {}

export class InvestigationSnapshotReference extends Schema.Class<InvestigationSnapshotReference>(
	"InvestigationSnapshotReference",
)({
	label: Schema.String,
	url: Schema.String,
}) {}

export class InvestigationSubjectSnapshot extends Schema.Class<InvestigationSubjectSnapshot>(
	"InvestigationSubjectSnapshot",
)({
	title: Schema.String,
	scope: Schema.NullOr(Schema.String),
	status: Schema.String,
	severity: Schema.NullOr(IssueSeverity),
	facts: Schema.Array(InvestigationSnapshotFact),
	references: Schema.Array(InvestigationSnapshotReference),
	incidentStartedAt: Schema.NullOr(IsoDateTimeString),
	incidentEndedAt: Schema.NullOr(IsoDateTimeString),
}) {}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export class InvestigationDocument extends Schema.Class<InvestigationDocument>("InvestigationDocument")({
	id: InvestigationId,
	status: InvestigationStatus,
	subject: InvestigationSubject,
	snapshot: InvestigationSubjectSnapshot,
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
	/**
	 * When the current pass began. Re-stamped on every restart, which is what makes
	 * it — and not `createdAt` — the right start for "how long did this run take".
	 */
	startedAt: Schema.NullOr(IsoDateTimeString),
	diagnosedAt: Schema.NullOr(IsoDateTimeString),
	updatedAt: IsoDateTimeString,
	/**
	 * One entry per dispatched lens, in dispatch order. Empty on the single-pass
	 * path — which is what the UI keys "did this run fan out?" off, rather than
	 * `fanout.size`: the sizing table and the routing gate are different
	 * questions, so a run can compute a size of 5 and still have no lenses.
	 */
	lensRuns: Schema.Array(InvestigationLensRun),
	validator: Schema.NullOr(InvestigationValidator),
	fanout: InvestigationFanout,
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
	snapshot: Schema.optionalKey(InvestigationSubjectSnapshot),
}) {}

export class InvestigationStatusUpdateRequest extends Schema.Class<InvestigationStatusUpdateRequest>(
	"InvestigationStatusUpdateRequest",
)({
	status: InvestigationStatus,
}) {}

/**
 * The internal write the `submit_diagnosis` tool posts once the
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

export class InvestigationQuotaError extends Schema.TaggedErrorClass<InvestigationQuotaError>()(
	"@maple/http/investigations/InvestigationQuotaError",
	{
		message: Schema.String,
		limit: Schema.Number,
		retryableAt: IsoDateTimeString,
	},
	{ httpApiStatus: 429 },
) {}

export class InvestigationUnavailableError extends Schema.TaggedErrorClass<InvestigationUnavailableError>()(
	"@maple/http/investigations/InvestigationUnavailableError",
	{
		message: Schema.String,
		reason: Schema.Literals(["automation_disabled", "agent_unavailable", "start_failed"]),
		retryable: Schema.Boolean,
	},
	{ httpApiStatus: 503 },
) {}

export class InvestigationRejectedError extends Schema.TaggedErrorClass<InvestigationRejectedError>()(
	"@maple/http/investigations/InvestigationRejectedError",
	{
		message: Schema.String,
		status: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 400, maximum: 499 })),
	},
	{ httpApiStatus: 502 },
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
			error: [
				InvestigationPersistenceError,
				InvestigationValidationError,
				InvestigationNotFoundError,
				InvestigationQuotaError,
				InvestigationRejectedError,
				InvestigationUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("restartInvestigation", "/:id/restart", {
			params: { id: InvestigationId },
			success: InvestigationDocument,
			error: [
				InvestigationPersistenceError,
				InvestigationNotFoundError,
				InvestigationQuotaError,
				InvestigationRejectedError,
				InvestigationUnavailableError,
			],
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
