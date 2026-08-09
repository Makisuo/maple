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
 * The standing catalogue of framings.
 *
 * It used to *be* `LensId` — every investigation dispatched some prefix of this
 * list regardless of what the incident was. Two of the five had no instrument
 * behind them (`config_flags` had no configuration-change tool at all, and said
 * so in its own prompt), so a fixed catalogue guaranteed that a fraction of every
 * run was spent on questions the telemetry could not answer.
 *
 * It survives as a *seed*: what the planner is shown as prior art, and what a run
 * falls back to when the planner produces nothing usable. Comparability across
 * investigations comes from the validator's rival table now, not from every run
 * asking the same five questions.
 */
export const SeedLensId = Schema.Literals([
	"deploy_correlation",
	"downstream_dependency",
	"resource_saturation",
	"traffic_shape",
]).annotate({ identifier: "@maple/SeedLensId", title: "Seed Lens" })
export type SeedLensId = Schema.Schema.Type<typeof SeedLensId>

/**
 * A lane's id — planner-generated, so this is a *shape* constraint rather than a
 * catalogue.
 *
 * It must be a stable lowercase slug for two mechanical reasons, and both are
 * load-bearing: it keys the `(investigation_id, attempt, lens_id)` unique index
 * that makes a replayed workflow step idempotent, and it is interpolated into
 * span names. Anything with whitespace or punctuation breaks one or the other.
 * Old rows — including `config_flags` — still decode, which is why this widening
 * needs no backfill.
 */
export const LensId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{2,47}$/)).annotate({
	identifier: "@maple/LensId",
	title: "Lens",
})
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
 * Where the run as a whole is. `none` is the single-pass path — a free-form
 * question, or an org that opted out of planning — and is what every row
 * predating the multi-hypothesis flow backfills to.
 *
 * `superseded` means a later `submit_diagnosis` (a human follow-up in the Chat
 * tab) overwrote the report the validator promoted, so the lane verdicts no
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
	/**
	 * Display label and question, written by the planner.
	 *
	 * Server-side now, because the ids are per-incident: the web used to map a
	 * closed `LensId` to static copy, which cannot name "the 14:02 payments-api
	 * rollout". Null on legacy rows, where the static catalogue still applies.
	 */
	name: Schema.NullOr(Schema.String),
	question: Schema.NullOr(Schema.String),
	/** 1 = test first. Null on legacy rows, which were ordered by dispatch alone. */
	priority: Schema.NullOr(Schema.Number),
	/**
	 * True when this lane answered because its clock ran out, not because it was
	 * done. Without it "checked and found nothing" and "never got to look" are the
	 * same row, and the validator is explicitly told to treat a clean negative as
	 * evidence that can rule out a rival.
	 */
	deadlineHit: Schema.Boolean,
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
// The plan (what the planner decided is worth testing)
// ---------------------------------------------------------------------------

/**
 * One falsifiable proposition about *this* incident, and the tools needed to test
 * it.
 *
 * The unit that replaced the fixed lens catalogue. The difference that matters is
 * not that the id is dynamic — it is that a hypothesis is only written once the
 * planner has confirmed an evidence source exists for it, so a lane can no longer
 * be dispatched to ask a question the telemetry cannot answer.
 */
export class InvestigationHypothesis extends Schema.Class<InvestigationHypothesis>("InvestigationHypothesis")(
	{
		/**
		 * The model's own name for this hypothesis. Slugified into a {@link LensId} by
		 * `normalizePlan` before it becomes a lane.
		 *
		 * Deliberately NOT `LensId` here, and the distinction is load-bearing: this
		 * schema is the planner's *submit tool*, so a strict pattern rejects the whole
		 * plan — every hypothesis, not just the malformed id — the moment a model
		 * writes "Pool exhaustion in payments-api". The forgiving schema sits at the
		 * model boundary and the strict one at the storage boundary, which is the only
		 * arrangement where the normalization step can actually do its job.
		 */
		id: Schema.String,
		/** Short label, rendered as the lane's title. */
		name: Schema.String,
		/** The single question this lane exists to answer, phrased as a question. */
		question: Schema.String,
		/**
		 * The proposition itself, written so a lane can come back and say "no, I
		 * checked, and here is why not". A claim that cannot fail is not worth a pass.
		 */
		claimToTest: Schema.String,
		/** Why the scoping sweep made this plausible. Must cite what was actually seen. */
		rationale: Schema.String,
		/**
		 * Tools this lane needs. Intersected server-side with the universe of read-only
		 * investigation tools and never trusted as given — a model naming a tool that
		 * does not exist would otherwise produce a lane that cannot act.
		 */
		toolNames: Schema.Array(Schema.String),
		/** 1 = test first. Clamped into range by normalization for the same reason `id` is. */
		priority: Schema.Number,
		/** Set when this came from the seed catalogue rather than from the incident. */
		seedLensId: Schema.NullOr(SeedLensId),
	},
) {}

/**
 * What the planner produced: the scope it established and the hypotheses worth
 * spending a pass on.
 */
export class InvestigationPlan extends Schema.Class<InvestigationPlan>("InvestigationPlan")({
	/** What the sweep established, in 2-3 sentences. Prefixed onto every lane's prompt. */
	scopeSummary: Schema.String,
	/**
	 * The interval the planner *established*, which supersedes the snapshot's
	 * guess. The snapshot's interval is whatever the incident producer happened to
	 * know; this one was confirmed against the telemetry.
	 */
	incidentStartedAt: Schema.NullOr(IsoDateTimeString),
	incidentEndedAt: Schema.NullOr(IsoDateTimeString),
	hypotheses: Schema.Array(InvestigationHypothesis),
	/**
	 * Non-null exactly when the plan collapsed to one hypothesis: why the cause was
	 * unambiguous enough not to warrant rivals. A collapse with no stated reason is
	 * indistinguishable from a planner that simply gave up, so this is how the two
	 * stay tellable apart on the boards.
	 */
	collapseReason: Schema.NullOr(Schema.String),
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

	// The identifiers an agent needs to *act*, as opposed to the display facts
	// above. These were being thrown away at the producer: the incident-open path
	// already carried the fingerprint, the exception and the first/last-seen
	// timestamps, and the snapshot kept none of them — so the prompt could tell the
	// agent to "establish the exact incident interval" and to "call error_detail
	// with the fingerprint" while handing it neither. Every one is `optionalKey`
	// so the snapshots already stored still decode unchanged.
	/** The error group's fingerprint. `error_detail` cannot be called without it. */
	fingerprintHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
	topFrame: Schema.optionalKey(Schema.NullOr(Schema.String)),
	errorLabel: Schema.optionalKey(Schema.NullOr(Schema.String)),
	occurrenceCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	deploymentEnv: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** Alert and anomaly subjects: which signal fired, and against what. */
	signalType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	observedValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	thresholdValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
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

export class InvestigationPersistenceError extends Schema.TaggedError<InvestigationPersistenceError>()(
	"@maple/http/investigations/InvestigationPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class InvestigationValidationError extends Schema.TaggedError<InvestigationValidationError>()(
	"@maple/http/investigations/InvestigationValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class InvestigationNotFoundError extends Schema.TaggedError<InvestigationNotFoundError>()(
	"@maple/http/investigations/InvestigationNotFoundError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class InvestigationQuotaError extends Schema.TaggedError<InvestigationQuotaError>()(
	"@maple/http/investigations/InvestigationQuotaError",
	{
		message: Schema.String,
		/**
		 * Which of the two daily ceilings was hit. Carried because a run and a model
		 * pass are different units with different settings, and an operator told only
		 * "quota reached" cannot tell which number to raise.
		 */
		dimension: Schema.Literals(["runs", "passes"]),
		limit: Schema.Number,
		retryableAt: IsoDateTimeString,
	},
	{ httpApiStatus: 429 },
) {}

export class InvestigationUnavailableError extends Schema.TaggedError<InvestigationUnavailableError>()(
	"@maple/http/investigations/InvestigationUnavailableError",
	{
		message: Schema.String,
		reason: Schema.Literals(["automation_disabled", "agent_unavailable", "start_failed"]),
		retryable: Schema.Boolean,
	},
	{ httpApiStatus: 503 },
) {}

export class InvestigationRejectedError extends Schema.TaggedError<InvestigationRejectedError>()(
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
