import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema, SchemaGetter } from "effect"
import {
	ActorId,
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	ErrorIssuePullRequestId,
	ErrorIssueVerificationId,
	InvestigationId,
	IsoDateTimeString,
	IssueEscalationId,
	PostgresTransactionId,
	SpanId,
	TraceId,
	UserId,
} from "../primitives"
import { Authorization } from "./current-tenant"
import { AlertSeverity } from "./alerts"
import {
	PullRequestLinkSource,
	PullRequestLinkState,
	VerificationStatus,
	VerificationVerdict,
} from "./fix-verification"
import { VcsProviderId } from "./vcs"
import { HttpTaggedError } from "./error-policy"

// Workflow state machine literals

export const WorkflowState = Schema.Literals([
	"triage",
	// Set by the errors tick when a resolved issue starts firing again. Distinct
	// from `triage` on purpose: reopening into `triage` erased the fact that the
	// issue had ever been fixed, so the next person or agent to pick it up saw a
	// brand-new bug and fixed it again. Ordered second so it surfaces near the top
	// of the hub.
	"regressed",
	"todo",
	"in_progress",
	"in_review",
	// A linked pull request has merged and the fix is being confirmed against real
	// traffic. Machine-owned like `regressed`: entering it asserts an observation
	// (a merge landed) rather than an intention, and the verification tick owns
	// the exit. Ordered after `in_review` because that is where work flows from.
	"verifying",
	"done",
	"cancelled",
	"wontfix",
]).annotate({
	identifier: "@maple/WorkflowState",
	title: "Workflow State",
})
export type WorkflowState = Schema.Schema.Type<typeof WorkflowState>

/**
 * The legal workflow-state moves. Rows are the "from" state, values the allowed
 * "to" states.
 *
 * Single source of truth on purpose — this used to be copied into
 * `ErrorsService`, the `transition_error_issue` tool description, and the web's
 * `StateSelect`, where the three drifted independently and the tool description
 * was the copy nobody remembered to update.
 *
 * `done` is reachable from every actionable state, not just `in_review`. The
 * narrower rule made sense for code-review-shaped work but not for the issue
 * hub at large: alert- and integration-kind issues are created in `triage` and
 * nothing ever advances them through review, so requiring `in_review` first
 * left them with no way to be retired at all — by a human or by auto-resolve.
 *
 * `cancelled` stays terminal. `done → regressed` is the errors tick's reopen
 * path; `done → triage` stays legal for a human who wants to re-triage a fixed
 * issue by hand.
 */
export const WORKFLOW_TRANSITIONS: Record<WorkflowState, ReadonlyArray<WorkflowState>> = {
	triage: ["todo", "in_progress", "done", "cancelled", "wontfix"],
	regressed: ["triage", "todo", "in_progress", "done", "cancelled", "wontfix"],
	todo: ["triage", "in_progress", "done", "cancelled", "wontfix"],
	in_progress: ["triage", "todo", "in_review", "verifying", "done", "cancelled", "wontfix"],
	in_review: ["triage", "in_progress", "verifying", "done", "cancelled", "wontfix"],
	verifying: ["triage", "todo", "in_progress", "in_review", "done", "cancelled", "wontfix"],
	// `done → verifying` is the merge path for an issue somebody already closed by
	// hand: the merge is still worth confirming, and a verdict of "not fixed" is
	// how it gets reopened without waiting for the next occurrence.
	done: ["triage", "regressed", "in_progress", "verifying", "cancelled", "wontfix"],
	cancelled: [],
	wontfix: ["triage", "cancelled"],
} satisfies Record<WorkflowState, ReadonlyArray<WorkflowState>>

/**
 * Every workflow state in canonical display order. The order the issue hub
 * shows states in — groups, selects, and status menus — so a list of states
 * reads the same everywhere.
 */
export const WORKFLOW_STATE_ORDER: ReadonlyArray<WorkflowState> = WorkflowState.literals

/**
 * States only the errors tick may move an issue into.
 *
 * `regressed` records something observed — a fixed issue started firing from a
 * build that was not running when it was resolved. A human picking it from a
 * menu would be asserting that observation rather than making it, and the
 * evaluator would overwrite the claim on its next tick anyway. `verifying` is
 * the same shape: it says a linked pull request merged and a verification window
 * is running, which is a fact about the world rather than a decision, and the
 * verification tick owns the exit. Both edges stay legal in
 * {@link WORKFLOW_TRANSITIONS} because the ticks do travel them; it is the
 * human-facing surfaces that filter them out.
 */
export const MACHINE_OWNED_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
	"regressed",
	"verifying",
])

/**
 * The states that *every* one of `from` can legally move to — the intersection
 * of their rows in {@link WORKFLOW_TRANSITIONS}, in canonical order.
 *
 * This is what a menu should offer: for one issue it is that issue's row, and
 * for a multi-issue selection it is the moves the server would accept for all
 * of them, so a bulk action can never half-apply. A state with no outgoing
 * moves (`cancelled`) contributes an empty row and therefore collapses the
 * result to nothing, and an empty input yields nothing (nothing selected, no
 * legal move). Machine-owned targets are excluded — see
 * {@link MACHINE_OWNED_WORKFLOW_STATES}.
 */
export const allowedTransitionsForAll = (from: Iterable<WorkflowState>): ReadonlyArray<WorkflowState> => {
	const rows = Array.from(from, (state) => WORKFLOW_TRANSITIONS[state])
	if (rows.length === 0) return []
	return WORKFLOW_STATE_ORDER.filter(
		(target) => !MACHINE_OWNED_WORKFLOW_STATES.has(target) && rows.every((row) => row.includes(target)),
	)
}

/**
 * States in which the work is over: the lease is dropped on arrival and the
 * issue cannot be claimed.
 *
 * NOT "no further transition is possible", which is what the old name
 * (`CLOSED_WORKFLOW_STATES`) claimed and what `done` plainly contradicts —
 * `done` reopens to `regressed` on the errors tick, to `verifying` when a linked
 * PR merges, and to `triage` for a human re-triaging by hand. `cancelled` is the
 * only state with genuinely no outgoing moves.
 */
export const CLOSED_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
	"done",
	"cancelled",
])

/**
 * The states to walk through to get an issue to `in_review`, from wherever it is.
 *
 * `triage → in_review` is deliberately NOT a legal edge — an issue nobody has
 * picked up cannot be under review — and for months that meant `propose_fix` on
 * an untriaged issue failed outright with "Illegal transition from 'triage' to
 * 'in_review'". Agents do not read the state machine before acting; they land on
 * an issue in `triage`, propose the fix they just wrote, and get an error. It
 * fired 18 times in production in two days.
 *
 * So the route is computed instead of assumed: one hop where the matrix allows
 * it, otherwise via `in_progress`, which is the same state a claim moves an
 * issue into. Empty means `in_review` is unreachable and the caller should say
 * so *before* writing anything.
 */
export const fixProposalRoute = (from: WorkflowState): ReadonlyArray<WorkflowState> => {
	if (from === "in_review") return []
	if (WORKFLOW_TRANSITIONS[from].includes("in_review")) return ["in_review"]
	if (WORKFLOW_TRANSITIONS[from].includes("in_progress")) return ["in_progress", "in_review"]
	return []
}

/** Whether {@link fixProposalRoute} can get `from` to `in_review` at all. */
export const canReachInReview = (from: WorkflowState): boolean =>
	from === "in_review" || fixProposalRoute(from).length > 0

/**
 * Renders the matrix as the prose an LLM tool description needs, so the
 * description can never drift from the rules the server actually enforces.
 *
 * Machine-owned targets are omitted, because the only caller is agent-facing and
 * every surface that lets a caller *pick* a state filters them out — see
 * {@link MACHINE_OWNED_WORKFLOW_STATES}. Listing `in_review→verifying` in the
 * `transition_error_issue` description while the tool rejected `verifying` was
 * an instruction to make a call that could only fail.
 */
export const describeWorkflowTransitions = (): string =>
	Object.entries(WORKFLOW_TRANSITIONS)
		.map(
			([from, targets]) =>
				[from, targets.filter((target) => !MACHINE_OWNED_WORKFLOW_STATES.has(target))] as const,
		)
		.filter(([, targets]) => targets.length > 0)
		.map(([from, targets]) => `${from}→(${targets.join("|")})`)
		.join("; ")

export const ActorType = Schema.Literals(["user", "agent"]).annotate({
	identifier: "@maple/ActorType",
	title: "Actor Type",
})
export type ActorType = Schema.Schema.Type<typeof ActorType>

/**
 * Canonical triage severity for issues of every kind. The same literal backs
 * the AI triage agent's `severityAssessment` (see ai-triage.ts) so the two can
 * never drift apart.
 */
export const IssueSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
	identifier: "@maple/IssueSeverity",
	title: "Issue Severity",
})
export type IssueSeverity = Schema.Schema.Type<typeof IssueSeverity>

/**
 * Who set the issue's current severity. Precedence is manual > ai > detector:
 * AI triage only writes when the source is not "manual", and the detector
 * mapping only applies while severity is still unset.
 */
export const IssueSeveritySource = Schema.Literals(["detector", "ai", "manual"]).annotate({
	identifier: "@maple/IssueSeveritySource",
	title: "Issue Severity Source",
})
export type IssueSeveritySource = Schema.Schema.Type<typeof IssueSeveritySource>

/**
 * What kind of signal backs the issue. "error" issues are fingerprint groups
 * from the errors tick; "alert" issues are created when an alert incident
 * opens (their fingerprintHash is the synthetic `alert:{ruleId}:{groupKey}`);
 * "integration" issues come from third-party webhooks (e.g. PlanetScale
 * branch.out_of_memory — fingerprint `planetscale:{database}:{event}`).
 */
export const IssueKind = Schema.Literals(["error", "alert", "integration"]).annotate({
	identifier: "@maple/IssueKind",
	title: "Issue Kind",
})
export type IssueKind = Schema.Schema.Type<typeof IssueKind>

export const ErrorIssueEventType = Schema.Literals([
	"created",
	"state_change",
	"assignment",
	"claim",
	"release",
	"lease_expired",
	"comment",
	"agent_note",
	"fix_proposed",
	"regression",
	"snooze",
	"unsnooze",
	"ai_triage",
	"anomaly_linked",
	"severity_change",
	"pr_linked",
	"pr_unlinked",
	"pr_merged",
	"verification_started",
	"verification_verdict",
]).annotate({
	identifier: "@maple/ErrorIssueEventType",
	title: "Error Issue Event Type",
})
export type ErrorIssueEventType = Schema.Schema.Type<typeof ErrorIssueEventType>

export const ErrorIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
	identifier: "@maple/ErrorIncidentStatus",
	title: "Error Incident Status",
})
export type ErrorIncidentStatus = Schema.Schema.Type<typeof ErrorIncidentStatus>

export const ErrorIncidentReason = Schema.Literals(["first_seen", "regression", "manual"]).annotate({
	identifier: "@maple/ErrorIncidentReason",
	title: "Error Incident Reason",
})
export type ErrorIncidentReason = Schema.Schema.Type<typeof ErrorIncidentReason>

/**
 * Silence, in minutes, after which the error tick auto-resolves an open
 * incident. Shared so the dashboard can explain the `resolved` status with the
 * same number the evaluator applies.
 */
export const ERROR_INCIDENT_AUTO_RESOLVE_MINUTES = 30

// Actor documents

export class ActorDocument extends Schema.Class<ActorDocument>("ActorDocument")({
	id: ActorId,
	type: ActorType,
	userId: Schema.NullOr(UserId),
	agentName: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	capabilities: Schema.Array(Schema.String),
	lastActiveAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class ActorsListResponse extends Schema.Class<ActorsListResponse>("ActorsListResponse")({
	actors: Schema.Array(ActorDocument),
}) {}

// Issue + event documents

export class ErrorIssueDocument extends Schema.Class<ErrorIssueDocument>("ErrorIssueDocument")({
	id: ErrorIssueId,
	kind: IssueKind,
	fingerprintHash: Schema.String,
	serviceName: Schema.String,
	exceptionType: Schema.String,
	exceptionMessage: Schema.String,
	errorLabel: Schema.String,
	topFrame: Schema.String,
	workflowState: WorkflowState,
	priority: Schema.Number,
	severity: Schema.NullOr(IssueSeverity),
	severitySource: Schema.NullOr(IssueSeveritySource),
	sourceRef: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
	assignedActor: Schema.NullOr(ActorDocument),
	leaseHolder: Schema.NullOr(ActorDocument),
	leaseExpiresAt: Schema.NullOr(IsoDateTimeString),
	claimedAt: Schema.NullOr(IsoDateTimeString),
	notes: Schema.NullOr(Schema.String),
	firstSeenAt: IsoDateTimeString,
	lastSeenAt: IsoDateTimeString,
	occurrenceCount: Schema.Number,
	resolvedAt: Schema.NullOr(IsoDateTimeString),
	// Fix history. Carried on the document rather than left in the event log
	// because the event log is not what a triaging human or agent reads first:
	// with only `workflowState`, an issue that was fixed last week and came back
	// looked exactly like one nobody had ever touched, so the same bug got
	// investigated and fixed from scratch more than once.
	lastResolvedAt: Schema.NullOr(IsoDateTimeString),
	lastRegressedAt: Schema.NullOr(IsoDateTimeString),
	regressionCount: Schema.Number,
	/** Builds this issue was known to affect when it was last marked done. */
	resolvedVersions: Schema.Array(Schema.String),
	snoozeUntil: Schema.NullOr(IsoDateTimeString),
	archivedAt: Schema.NullOr(IsoDateTimeString),
	hasOpenIncident: Schema.Boolean,
	// Activity rollups for list surfaces: is anyone talking about this issue,
	// and where do its linked PRs stand — without a per-issue events fetch.
	// Comment count includes agent notes; abandoned (closed-unmerged) PRs are
	// deliberately not counted anywhere.
	commentCount: Schema.Number,
	openPullRequestCount: Schema.Number,
	mergedPullRequestCount: Schema.Number,
	// Postgres txid of the write, present only on mutation responses so the web's
	// ElectricSQL error_issues collection can resolve optimistic state on the exact
	// synced transaction. Absent on list/read responses.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class ErrorIssuesListResponse extends Schema.Class<ErrorIssuesListResponse>("ErrorIssuesListResponse")(
	{
		issues: Schema.Array(ErrorIssueDocument),
		// Opaque cursor for the next page (pass back as `?cursor=`); absent on
		// the last page.
		nextCursor: Schema.optionalKey(Schema.String),
	},
) {}

export class ErrorIssueTimeseriesPoint extends Schema.Class<ErrorIssueTimeseriesPoint>(
	"ErrorIssueTimeseriesPoint",
)({
	bucket: IsoDateTimeString,
	count: Schema.Number,
}) {}

export class ErrorIssueSampleTrace extends Schema.Class<ErrorIssueSampleTrace>("ErrorIssueSampleTrace")({
	traceId: TraceId,
	spanId: SpanId,
	serviceName: Schema.String,
	timestamp: IsoDateTimeString,
	exceptionMessage: Schema.String,
	durationMicros: Schema.Number,
}) {}

/** One deployment environment a fingerprint was observed in over the detail window. */
export class ErrorIssueEnvironment extends Schema.Class<ErrorIssueEnvironment>("ErrorIssueEnvironment")({
	name: Schema.String,
	count: Schema.Number,
}) {}

export class ErrorIncidentDocument extends Schema.Class<ErrorIncidentDocument>("ErrorIncidentDocument")({
	id: ErrorIncidentId,
	issueId: ErrorIssueId,
	status: ErrorIncidentStatus,
	reason: ErrorIncidentReason,
	firstTriggeredAt: IsoDateTimeString,
	lastTriggeredAt: IsoDateTimeString,
	resolvedAt: Schema.NullOr(IsoDateTimeString),
	occurrenceCount: Schema.Number,
}) {}

export class ErrorIssueDetailResponse extends Schema.Class<ErrorIssueDetailResponse>(
	"ErrorIssueDetailResponse",
)({
	issue: ErrorIssueDocument,
	timeseries: Schema.Array(ErrorIssueTimeseriesPoint),
	sampleTraces: Schema.Array(ErrorIssueSampleTrace),
	incidents: Schema.Array(ErrorIncidentDocument),
	// Environments the fingerprint was seen in over the requested window. The
	// issue row itself has none: one fingerprint spans environments.
	environments: Schema.Array(ErrorIssueEnvironment),
}) {}

export class ErrorIncidentsListResponse extends Schema.Class<ErrorIncidentsListResponse>(
	"ErrorIncidentsListResponse",
)({
	incidents: Schema.Array(ErrorIncidentDocument),
}) {}

export class ErrorIssueEventDocument extends Schema.Class<ErrorIssueEventDocument>("ErrorIssueEventDocument")(
	{
		id: ErrorIssueEventId,
		issueId: ErrorIssueId,
		actor: Schema.NullOr(ActorDocument),
		type: ErrorIssueEventType,
		fromState: Schema.NullOr(WorkflowState),
		toState: Schema.NullOr(WorkflowState),
		payload: Schema.Record(Schema.String, Schema.Unknown),
		createdAt: IsoDateTimeString,
	},
) {}

export class ErrorIssueEventsResponse extends Schema.Class<ErrorIssueEventsResponse>(
	"ErrorIssueEventsResponse",
)({
	events: Schema.Array(ErrorIssueEventDocument),
}) {}

// Request payloads

export class ErrorIssueTransitionRequest extends Schema.Class<ErrorIssueTransitionRequest>(
	"ErrorIssueTransitionRequest",
)({
	toState: WorkflowState,
	note: Schema.optionalKey(Schema.String),
	snoozeUntil: Schema.optionalKey(Schema.NullOr(IsoDateTimeString)),
}) {}

export class ErrorIssueClaimRequest extends Schema.Class<ErrorIssueClaimRequest>("ErrorIssueClaimRequest")({
	leaseDurationSeconds: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 60, maximum: 7200 })),
	),
}) {}

export class ErrorIssueReleaseRequest extends Schema.Class<ErrorIssueReleaseRequest>(
	"ErrorIssueReleaseRequest",
)({
	transitionTo: Schema.optionalKey(WorkflowState),
	note: Schema.optionalKey(Schema.String),
}) {}

export class ErrorIssueAssignRequest extends Schema.Class<ErrorIssueAssignRequest>("ErrorIssueAssignRequest")(
	{
		actorId: Schema.NullOr(ActorId),
	},
) {}

export class ErrorIssueCommentRequest extends Schema.Class<ErrorIssueCommentRequest>(
	"ErrorIssueCommentRequest",
)({
	body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
	visibility: Schema.optionalKey(Schema.Literals(["internal", "public"])),
	kind: Schema.optionalKey(Schema.Literals(["comment", "agent_note"])),
}) {}

export class ErrorIssueProposeFixRequest extends Schema.Class<ErrorIssueProposeFixRequest>(
	"ErrorIssueProposeFixRequest",
)({
	patchSummary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
	prUrl: Schema.optionalKey(Schema.String),
	artifacts: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class ErrorIssueSetSeverityRequest extends Schema.Class<ErrorIssueSetSeverityRequest>(
	"ErrorIssueSetSeverityRequest",
)({
	severity: Schema.NullOr(IssueSeverity),
	note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
}) {}

// Pull request links + fix verification

export class ErrorIssuePullRequestDocument extends Schema.Class<ErrorIssuePullRequestDocument>(
	"ErrorIssuePullRequestDocument",
)({
	id: ErrorIssuePullRequestId,
	issueId: ErrorIssueId,
	provider: VcsProviderId,
	/** `owner/name`. */
	repoFullName: Schema.String,
	number: Schema.Number,
	url: Schema.String,
	title: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	state: PullRequestLinkState,
	mergedAt: Schema.NullOr(IsoDateTimeString),
	mergeCommitSha: Schema.NullOr(Schema.String),
	linkSource: PullRequestLinkSource,
	linkedByActor: Schema.NullOr(ActorDocument),
	createdAt: IsoDateTimeString,
}) {}

export class ErrorIssuePullRequestsResponse extends Schema.Class<ErrorIssuePullRequestsResponse>(
	"ErrorIssuePullRequestsResponse",
)({
	pullRequests: Schema.Array(ErrorIssuePullRequestDocument),
	/**
	 * The repository (`owner/name`) the attach-a-PR picker should open on, or null
	 * when nothing in the org's connected repos points at this issue clearly enough
	 * to guess. A default, never a fact: the user can always pick another, and an
	 * ambiguous signal deliberately yields null rather than a plausible wrong repo.
	 */
	suggestedRepository: Schema.NullOr(Schema.String),
}) {}

export class ErrorIssueLinkPullRequestRequest extends Schema.Class<ErrorIssueLinkPullRequestRequest>(
	"ErrorIssueLinkPullRequestRequest",
)({
	/** A full pull request URL. Parsed server-side — see `parsePullRequestUrl`. */
	url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
}) {}

/**
 * A post-merge verification run, as the issue page renders it.
 *
 * `verifyAfter` and `baselineRatePerHour` travel together on purpose: the UI
 * explains the wait ("~6h, because this fired ~3x/hour before the merge") and
 * needs both halves to do it. A window with no explanation reads as arbitrary.
 */
export class ErrorIssueVerificationDocument extends Schema.Class<ErrorIssueVerificationDocument>(
	"ErrorIssueVerificationDocument",
)({
	id: ErrorIssueVerificationId,
	issueId: ErrorIssueId,
	pullRequestId: ErrorIssuePullRequestId,
	status: VerificationStatus,
	mergedAt: IsoDateTimeString,
	verifyAfter: IsoDateTimeString,
	baselineVersions: Schema.Array(Schema.String),
	baselineOccurrenceCount: Schema.Number,
	baselineRatePerHour: Schema.Number,
	postMergeOccurrenceCount: Schema.Number,
	investigationId: Schema.NullOr(InvestigationId),
	verdict: Schema.NullOr(VerificationVerdict),
	verdictNote: Schema.NullOr(Schema.String),
	attempt: Schema.Number,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class ErrorIssueVerificationsResponse extends Schema.Class<ErrorIssueVerificationsResponse>(
	"ErrorIssueVerificationsResponse",
)({
	verifications: Schema.Array(ErrorIssueVerificationDocument),
}) {}

export class RegisterAgentRequest extends Schema.Class<RegisterAgentRequest>("RegisterAgentRequest")({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	model: Schema.optionalKey(Schema.String),
	capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

// Notification policy

export class ErrorNotificationPolicyDocument extends Schema.Class<ErrorNotificationPolicyDocument>(
	"ErrorNotificationPolicyDocument",
)({
	enabled: Schema.Boolean,
	destinationIds: Schema.Array(AlertDestinationId),
	notifyOnFirstSeen: Schema.Boolean,
	notifyOnRegression: Schema.Boolean,
	notifyOnResolve: Schema.Boolean,
	notifyOnTransitionInReview: Schema.Boolean,
	notifyOnTransitionDone: Schema.Boolean,
	notifyOnClaim: Schema.Boolean,
	minOccurrenceCount: Schema.Number,
	severity: AlertSeverity,
	updatedAt: IsoDateTimeString,
	updatedBy: UserId,
}) {}

export class ErrorNotificationPolicyUpsertRequest extends Schema.Class<ErrorNotificationPolicyUpsertRequest>(
	"ErrorNotificationPolicyUpsertRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	destinationIds: Schema.optionalKey(Schema.Array(AlertDestinationId)),
	notifyOnFirstSeen: Schema.optionalKey(Schema.Boolean),
	notifyOnRegression: Schema.optionalKey(Schema.Boolean),
	notifyOnResolve: Schema.optionalKey(Schema.Boolean),
	notifyOnTransitionInReview: Schema.optionalKey(Schema.Boolean),
	notifyOnTransitionDone: Schema.optionalKey(Schema.Boolean),
	notifyOnClaim: Schema.optionalKey(Schema.Boolean),
	minOccurrenceCount: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100_000 })),
	),
	severity: Schema.optionalKey(AlertSeverity),
}) {}

// Escalation policy (severity → destination routing for triage outcomes)

export const EscalationConfidence = Schema.Literals(["low", "medium", "high"]).annotate({
	identifier: "@maple/EscalationConfidence",
	title: "Escalation Confidence",
})
export type EscalationConfidence = Schema.Schema.Type<typeof EscalationConfidence>

export class IssueEscalationPolicyRule extends Schema.Class<IssueEscalationPolicyRule>(
	"IssueEscalationPolicyRule",
)({
	severity: IssueSeverity,
	destinationIds: Schema.Array(AlertDestinationId),
	/** Gates AI escalations only; manual severity changes always route. */
	minConfidence: Schema.optionalKey(EscalationConfidence),
}) {}

export class IssueEscalationPolicyDocument extends Schema.Class<IssueEscalationPolicyDocument>(
	"IssueEscalationPolicyDocument",
)({
	enabled: Schema.Boolean,
	rules: Schema.Array(IssueEscalationPolicyRule),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class IssueEscalationPolicyUpsertRequest extends Schema.Class<IssueEscalationPolicyUpsertRequest>(
	"IssueEscalationPolicyUpsertRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	rules: Schema.optionalKey(Schema.Array(IssueEscalationPolicyRule)),
}) {}

// Query schemas

/**
 * Keyset cursor for `listIssues`: the sort key of the last row of the previous
 * page (lastSeenAt epoch-ms, id as tiebreaker). The wire form is opaque
 * base64url JSON, and the whole codec is declarative Schema — a tampered or
 * malformed cursor fails decode at the HTTP boundary instead of reaching the
 * query.
 */
export const IssueListCursorFields = Schema.Struct({
	lastSeenAt: Schema.Number,
	id: ErrorIssueId,
}).annotate({ identifier: "@maple/IssueListCursorFields" })
export type IssueListCursorFields = Schema.Schema.Type<typeof IssueListCursorFields>

export const IssueListCursor = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.decodeBase64UrlString(),
		encode: SchemaGetter.encodeBase64Url(),
	}),
	Schema.decodeTo(Schema.fromJsonString(IssueListCursorFields)),
).annotate({ identifier: "@maple/IssueListCursor", title: "Issue List Cursor" })

/** Alternate keyset used by the v2 urgency-sorted issue list. */
export const IssueSeverityListCursorFields = Schema.Struct({
	severityRank: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 4 })),
	lastSeenAt: Schema.Number,
	id: ErrorIssueId,
}).annotate({ identifier: "@maple/IssueSeverityListCursorFields" })
export type IssueSeverityListCursorFields = Schema.Schema.Type<typeof IssueSeverityListCursorFields>

export const IssueSeverityListCursor = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.decodeBase64UrlString(),
		encode: SchemaGetter.encodeBase64Url(),
	}),
	Schema.decodeTo(Schema.fromJsonString(IssueSeverityListCursorFields)),
).annotate({ identifier: "@maple/IssueSeverityListCursor", title: "Issue Severity List Cursor" })

const IssueListQuery = Schema.Struct({
	cursor: Schema.optional(IssueListCursor),
	workflowState: Schema.optional(WorkflowState),
	severity: Schema.optional(Schema.Union([IssueSeverity, Schema.Literal("unset")])),
	kind: Schema.optional(IssueKind),
	service: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(Schema.String),
	assignedActorId: Schema.optional(ActorId),
	includeArchived: Schema.optional(Schema.Literals(["0", "1"])),
	startTime: Schema.optional(IsoDateTimeString),
	endTime: Schema.optional(IsoDateTimeString),
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
})

const IssueDetailQuery = Schema.Struct({
	startTime: Schema.optional(IsoDateTimeString),
	endTime: Schema.optional(IsoDateTimeString),
	bucketSeconds: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 60, maximum: 86_400 })),
	),
	sampleLimit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
})

const IssueEventsQuery = Schema.Struct({
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
})

// Errors

export class ErrorPersistenceError extends HttpTaggedError<ErrorPersistenceError>()(
	"@maple/http/errors/ErrorPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "error_issues_unavailable",
		title: "Error issues are temporarily unavailable",
		message: "Error issues are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export const EscalationSkipReason = Schema.Literals([
	"policy_disabled",
	"no_destinations_for_severity",
	"below_min_confidence",
	"no_enabled_destinations",
	"issue_missing",
]).annotate({
	identifier: "@maple/EscalationSkipReason",
	title: "Escalation Skip Reason",
})
export type EscalationSkipReason = Schema.Schema.Type<typeof EscalationSkipReason>

export class EscalationPolicyEvaluationRequest extends Schema.Class<EscalationPolicyEvaluationRequest>(
	"EscalationPolicyEvaluationRequest",
)({
	severity: IssueSeverity,
	source: Schema.Literals(["ai", "manual"]),
	confidence: Schema.optionalKey(EscalationConfidence),
}) {}

export class EscalationPolicyEvaluationDocument extends Schema.Class<EscalationPolicyEvaluationDocument>(
	"EscalationPolicyEvaluationDocument",
)({
	outcome: Schema.Literals(["route", "skip"]),
	destinationIds: Schema.Array(AlertDestinationId),
	skipReason: Schema.NullOr(EscalationSkipReason),
}) {}

export class EscalationDestinationOutcome extends Schema.Class<EscalationDestinationOutcome>(
	"EscalationDestinationOutcome",
)({
	destinationId: AlertDestinationId,
	destinationName: Schema.NullOr(Schema.String),
	status: Schema.Literals(["delivered", "failed", "disabled", "missing"]),
	error: Schema.NullOr(Schema.String),
}) {}

export class IssueEscalationAttemptDocument extends Schema.Class<IssueEscalationAttemptDocument>(
	"IssueEscalationAttemptDocument",
)({
	id: IssueEscalationId,
	issueId: ErrorIssueId,
	investigationId: Schema.NullOr(InvestigationId),
	severity: IssueSeverity,
	source: Schema.Literals(["ai", "manual"]),
	reason: Schema.Literals(["severity_set", "severity_escalated"]),
	status: Schema.Literals(["queued", "sent", "skipped", "failed"]),
	attempts: Schema.Number,
	skipReason: Schema.NullOr(EscalationSkipReason),
	deliveries: Schema.Array(EscalationDestinationOutcome),
	createdAt: IsoDateTimeString,
	processedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class IssueEscalationAttemptsResponse extends Schema.Class<IssueEscalationAttemptsResponse>(
	"IssueEscalationAttemptsResponse",
)({
	attempts: Schema.Array(IssueEscalationAttemptDocument),
}) {}

export class ErrorValidationError extends Schema.TaggedError<ErrorValidationError>()(
	"@maple/http/errors/ErrorValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

export class ErrorIssuePullRequestInvalidError extends Schema.TaggedError<ErrorIssuePullRequestInvalidError>()(
	"@maple/http/errors/ErrorIssuePullRequestInvalidError",
	{
		message: Schema.String,
		/** Echoed back unparsed and explicitly named `raw` — it never became a link. */
		rawUrl: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ErrorIssuePullRequestNotFoundError extends Schema.TaggedError<ErrorIssuePullRequestNotFoundError>()(
	"@maple/http/errors/ErrorIssuePullRequestNotFoundError",
	{
		message: Schema.String,
		pullRequestId: ErrorIssuePullRequestId,
	},
	{ httpApiStatus: 404 },
) {}

export class ErrorForbiddenError extends Schema.TaggedError<ErrorForbiddenError>()(
	"@maple/http/errors/ErrorForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class ErrorIssueNotFoundError extends HttpTaggedError<ErrorIssueNotFoundError>()(
	"@maple/http/errors/ErrorIssueNotFoundError",
	{
		message: Schema.String,
		issueId: ErrorIssueId,
	},
	{
		status: 404,
		code: "error_issue_not_found",
		title: "Error issue not found",
		message: "No such error issue.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {
	static forIssue(id: ErrorIssueId) {
		return new ErrorIssueNotFoundError({
			message: `No such error issue: '${id}'`,
			issueId: id,
		})
	}
}

export class ErrorIssueTransitionError extends Schema.TaggedError<ErrorIssueTransitionError>()(
	"@maple/http/errors/ErrorIssueTransitionError",
	{
		message: Schema.String,
		issueId: ErrorIssueId,
		fromState: WorkflowState,
		toState: WorkflowState,
	},
	{ httpApiStatus: 409 },
) {}

export class ErrorIssueLeaseConflictError extends Schema.TaggedError<ErrorIssueLeaseConflictError>()(
	"@maple/http/errors/ErrorIssueLeaseConflictError",
	{
		message: Schema.String,
		issueId: ErrorIssueId,
		currentHolderActorId: Schema.NullOr(ActorId),
		leaseExpiresAt: Schema.NullOr(IsoDateTimeString),
	},
	{ httpApiStatus: 409 },
) {}

export class ActorNotFoundError extends Schema.TaggedError<ActorNotFoundError>()(
	"@maple/http/errors/ActorNotFoundError",
	{
		message: Schema.String,
		actorId: ActorId,
	},
	{ httpApiStatus: 404 },
) {}

// API group

export class ErrorsApiGroup extends HttpApiGroup.make("errors")
	.add(
		HttpApiEndpoint.get("listIssues", "/issues", {
			query: IssueListQuery,
			success: ErrorIssuesListResponse,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getIssue", "/issues/:issueId", {
			params: { issueId: ErrorIssueId },
			query: IssueDetailQuery,
			success: ErrorIssueDetailResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("transitionIssue", "/issues/:issueId/transitions", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueTransitionRequest,
			success: ErrorIssueDocument,
			error: [
				ErrorPersistenceError,
				ErrorIssueNotFoundError,
				ErrorIssueTransitionError,
				ErrorValidationError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("claimIssue", "/issues/:issueId/claim", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueClaimRequest,
			success: ErrorIssueDocument,
			error: [
				ErrorPersistenceError,
				ErrorIssueNotFoundError,
				ErrorIssueLeaseConflictError,
				ErrorIssueTransitionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("heartbeatIssue", "/issues/:issueId/heartbeat", {
			params: { issueId: ErrorIssueId },
			success: ErrorIssueDocument,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError, ErrorIssueLeaseConflictError],
		}),
	)
	.add(
		HttpApiEndpoint.post("releaseIssue", "/issues/:issueId/release", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueReleaseRequest,
			success: ErrorIssueDocument,
			error: [
				ErrorPersistenceError,
				ErrorIssueNotFoundError,
				ErrorIssueLeaseConflictError,
				ErrorIssueTransitionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("commentOnIssue", "/issues/:issueId/comments", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueCommentRequest,
			success: ErrorIssueEventDocument,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("proposeFix", "/issues/:issueId/propose-fix", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueProposeFixRequest,
			success: ErrorIssueDocument,
			// `ErrorIssueLeaseConflictError`: proposing a fix takes the lease, so it
			// can collide with whoever is already working the issue.
			error: [
				ErrorPersistenceError,
				ErrorIssueNotFoundError,
				ErrorIssueTransitionError,
				ErrorIssueLeaseConflictError,
				// A `prUrl` that is not a pull request URL is a 400, not a silent
				// no-op that reports the fix as attached.
				ErrorIssuePullRequestInvalidError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.put("assignIssue", "/issues/:issueId/assignee", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueAssignRequest,
			success: ErrorIssueDocument,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError, ActorNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.put("setIssueSeverity", "/issues/:issueId/severity", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueSetSeverityRequest,
			success: ErrorIssueDocument,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listIssueEvents", "/issues/:issueId/events", {
			params: { issueId: ErrorIssueId },
			query: IssueEventsQuery,
			success: ErrorIssueEventsResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listIssueIncidents", "/issues/:issueId/incidents", {
			params: { issueId: ErrorIssueId },
			success: ErrorIncidentsListResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listOpenIncidents", "/incidents", {
			success: ErrorIncidentsListResponse,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("registerAgent", "/agents", {
			payload: RegisterAgentRequest,
			success: ActorDocument,
			error: [ErrorPersistenceError, ErrorValidationError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listAgents", "/agents", {
			success: ActorsListResponse,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getNotificationPolicy", "/policy", {
			success: ErrorNotificationPolicyDocument,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("upsertNotificationPolicy", "/policy", {
			payload: ErrorNotificationPolicyUpsertRequest,
			success: ErrorNotificationPolicyDocument,
			error: [ErrorForbiddenError, ErrorPersistenceError, ErrorValidationError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getEscalationPolicy", "/escalation-policy", {
			success: IssueEscalationPolicyDocument,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("upsertEscalationPolicy", "/escalation-policy", {
			payload: IssueEscalationPolicyUpsertRequest,
			success: IssueEscalationPolicyDocument,
			error: [ErrorForbiddenError, ErrorPersistenceError, ErrorValidationError],
		}),
	)
	.add(
		HttpApiEndpoint.post("evaluateEscalationPolicy", "/escalation-policy/evaluate", {
			payload: EscalationPolicyEvaluationRequest,
			success: EscalationPolicyEvaluationDocument,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listIssueEscalations", "/issues/:issueId/escalations", {
			params: { issueId: ErrorIssueId },
			success: IssueEscalationAttemptsResponse,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listRecentEscalations", "/escalations/recent", {
			query: {
				limit: Schema.optional(
					Schema.NumberFromString.check(
						Schema.isInt(),
						Schema.isBetween({ minimum: 1, maximum: 100 }),
					),
				),
			},
			success: IssueEscalationAttemptsResponse,
			error: ErrorPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listIssuePullRequests", "/issues/:issueId/pull-requests", {
			params: { issueId: ErrorIssueId },
			success: ErrorIssuePullRequestsResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("linkIssuePullRequest", "/issues/:issueId/pull-requests", {
			params: { issueId: ErrorIssueId },
			payload: ErrorIssueLinkPullRequestRequest,
			success: ErrorIssuePullRequestDocument,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError, ErrorIssuePullRequestInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("unlinkIssuePullRequest", "/issues/:issueId/pull-requests/:pullRequestId", {
			params: { issueId: ErrorIssueId, pullRequestId: ErrorIssuePullRequestId },
			success: ErrorIssuePullRequestsResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError, ErrorIssuePullRequestNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listIssueVerifications", "/issues/:issueId/verifications", {
			params: { issueId: ErrorIssueId },
			success: ErrorIssueVerificationsResponse,
			error: [ErrorPersistenceError, ErrorIssueNotFoundError],
		}),
	)
	.prefix("/api/errors")
	.middleware(Authorization) {}
