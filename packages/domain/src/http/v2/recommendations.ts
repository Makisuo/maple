import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { RecommendationIssueId } from "../../primitives"
import { RecommendationIssueKind, RecommendationIssueStatus } from "../recommendation-issues"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/** `rec_…` public ID ⇄ internal `RecommendationIssueId` (raw UUID). */
export const RecommendationPublicId = PublicId(PublicIdPrefixes.recommendation, RecommendationIssueId)

const recommendationExample = {
	id: "rec_YofPTrK9782DWwcnXhpcCw",
	object: "recommendation",
	number: 7,
	recommendation_key: "rename:http.status_code",
	kind: "rename",
	source_key: "http.status_code",
	canonical_key: "http.response.status_code",
	status: "open",
	usage_count: 4182,
	opened_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
	resolved_at: null,
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2Recommendation = Schema.Struct({
	id: RecommendationPublicId,
	object: Schema.Literal("recommendation").annotate({
		description: 'The object type — always `"recommendation"`.',
		examples: ["recommendation"],
	}),
	number: Schema.Number.annotate({
		description: "Per-organization monotonic display number (`#1`, `#2`, …).",
		examples: [7],
	}),
	recommendation_key: Schema.String.annotate({
		description: "Stable key identifying the recommendation across reconciliation runs.",
		examples: ["rename:http.status_code"],
	}),
	kind: RecommendationIssueKind.annotate({
		description:
			"What kind of instrumentation issue was detected: `rename` (a non-canonical attribute name), `double-emission` (the same signal emitted twice), or `naming` (a convention violation).",
		examples: ["rename"],
	}),
	source_key: Schema.String.annotate({
		description: "The attribute or signal name the recommendation is about, as observed in your telemetry.",
		examples: ["http.status_code"],
	}),
	canonical_key: Schema.NullOr(Schema.String).annotate({
		description: "The canonical (recommended) name to migrate to, or `null` when not applicable.",
		examples: ["http.response.status_code"],
	}),
	status: RecommendationIssueStatus.annotate({
		description: "Lifecycle state: `open`, `dismissed`, `applied`, or `resolved`.",
		examples: ["open"],
	}),
	usage_count: Schema.Number.annotate({
		description: "How many recent telemetry items exhibit the issue.",
		examples: [4182],
	}),
	opened_at: Timestamp.annotate({ description: "When the recommendation was first detected." }),
	updated_at: Timestamp.annotate({ description: "When the recommendation was last updated." }),
	resolved_at: Schema.NullOr(Timestamp).annotate({
		description: "When the recommendation was resolved, or `null` while it is still open or dismissed.",
	}),
}).annotate({
	identifier: "Recommendation",
	title: "Recommendation",
	description:
		"An instrumentation improvement detected from your live telemetry — for example a non-canonical attribute name that should be renamed. Recommendations are reconciled automatically against incoming data; dismiss ones you don't plan to act on.",
	examples: [wireExample(recommendationExample)],
})
export type V2Recommendation = Schema.Schema.Type<typeof V2Recommendation>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const RecommendationList = ListOf(V2Recommendation).annotate({
	identifier: "RecommendationList",
	title: "Recommendation list",
	description: "A cursor-paginated page of recommendations.",
})

export class V2RecommendationsApiGroup extends HttpApiGroup.make("recommendations")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: RecommendationList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listRecommendations",
				summary: "List recommendations",
				description:
					"Reconciles recommendations against your live telemetry and returns the full numbered list. Cursor-paginated. Requires the `recommendations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("dismiss", "/:id/dismiss", {
			params: { id: RecommendationPublicId },
			success: V2Recommendation,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "dismissRecommendation",
				summary: "Dismiss a recommendation",
				description:
					"Marks a recommendation as dismissed so it stops appearing as actionable. Requires the `recommendations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("reopen", "/:id/reopen", {
			params: { id: RecommendationPublicId },
			success: V2Recommendation,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "reopenRecommendation",
				summary: "Reopen a recommendation",
				description:
					"Returns a dismissed recommendation to the `open` state. Requires the `recommendations:write` scope.",
			}),
		),
	)
	.prefix("/v2/recommendations")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Recommendations",
			description:
				"Automatically detected instrumentation improvements — attribute renames toward canonical semantic conventions, double emissions, and naming violations. List them, and dismiss or reopen individual recommendations.",
		}),
	) {}
