import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString, RecommendationIssueId } from "../primitives"
import { Authorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

export const RecommendationIssueKind = Schema.Literals(["rename", "double-emission", "naming"])
export type RecommendationIssueKind = typeof RecommendationIssueKind.Type

export const RecommendationIssueStatus = Schema.Literals(["open", "dismissed", "applied", "resolved"])
export type RecommendationIssueStatus = typeof RecommendationIssueStatus.Type

export class RecommendationIssue extends Schema.Class<RecommendationIssue>("RecommendationIssue")({
	id: RecommendationIssueId,
	/** Per-org monotonic display number (`#1`, `#2`, …). */
	number: Schema.Number,
	recommendationKey: Schema.String,
	kind: RecommendationIssueKind,
	sourceKey: Schema.String,
	canonicalKey: Schema.optionalKey(Schema.String),
	status: RecommendationIssueStatus,
	usageCount: Schema.Number,
	openedAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	resolvedAt: Schema.optionalKey(IsoDateTimeString),
}) {}

export class RecommendationIssuesListResponse extends Schema.Class<RecommendationIssuesListResponse>(
	"RecommendationIssuesListResponse",
)({
	issues: Schema.Array(RecommendationIssue),
}) {}

export class RecommendationIssuePersistenceError extends HttpTaggedError<RecommendationIssuePersistenceError>()(
	"@maple/http/errors/RecommendationIssuePersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "recommendations_unavailable",
		title: "Recommendations are temporarily unavailable",
		message: "Recommendations are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class RecommendationIssueNotFoundError extends HttpTaggedError<RecommendationIssueNotFoundError>()(
	"@maple/http/errors/RecommendationIssueNotFoundError",
	{ id: RecommendationIssueId, message: Schema.String },
	{
		status: 404,
		code: "recommendation_not_found",
		title: "Recommendation not found",
		message: "No such recommendation.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class RecommendationIssuesApiGroup extends HttpApiGroup.make("recommendationIssues")
	.add(
		// Reconciles live telemetry → persisted issues, then returns the full numbered list.
		HttpApiEndpoint.get("list", "/", {
			success: RecommendationIssuesListResponse,
			error: RecommendationIssuePersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("dismiss", "/:id/dismiss", {
			params: { id: RecommendationIssueId },
			success: RecommendationIssuesListResponse,
			error: [RecommendationIssueNotFoundError, RecommendationIssuePersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("reopen", "/:id/reopen", {
			params: { id: RecommendationIssueId },
			success: RecommendationIssuesListResponse,
			error: [RecommendationIssueNotFoundError, RecommendationIssuePersistenceError],
		}),
	)
	.prefix("/api/recommendation-issues")
	.middleware(Authorization) {}
