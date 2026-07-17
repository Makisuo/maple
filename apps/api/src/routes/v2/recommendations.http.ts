import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { RecommendationIssue, RecommendationIssueId } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, notFound, paginateArray, serviceUnavailable } from "@maple/domain/http/v2"
import type { V2Recommendation } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { RecommendationIssueService } from "../../services/RecommendationIssueService"

const toV2Recommendation = (issue: RecommendationIssue): V2Recommendation => ({
	id: issue.id,
	object: "recommendation",
	number: issue.number,
	recommendation_key: issue.recommendationKey,
	kind: issue.kind,
	source_key: issue.sourceKey,
	canonical_key: issue.canonicalKey ?? null,
	status: issue.status,
	usage_count: issue.usageCount,
	opened_at: issue.openedAt,
	updated_at: issue.updatedAt,
	resolved_at: issue.resolvedAt ?? null,
})

/** Service tagged errors → v2 envelope errors. */
const mapMutationError = (error: { readonly _tag: string; readonly message: string }) =>
	error._tag === "@maple/http/errors/RecommendationIssueNotFoundError"
		? notFound(error.message, "id")
		: serviceUnavailable(error.message)

const mapPersistenceError = (error: { readonly message: string }) => serviceUnavailable(error.message)

/**
 * v1 mutations return the full reconciled list; v2 returns the mutated object.
 * The issue is always present after a successful mutation — the fallback guards
 * against a concurrent reconciliation dropping it from the list.
 */
const pickIssue = (
	issues: ReadonlyArray<RecommendationIssue>,
	id: RecommendationIssueId,
) => {
	const issue = issues.find((candidate) => candidate.id === id)
	return issue === undefined
		? Effect.fail(notFound("No such recommendation.", "id"))
		: Effect.succeed(issue)
}

export const HttpV2RecommendationsLive = HttpApiBuilder.group(
	MapleApiV2,
	"recommendations",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* RecommendationIssueService

			return handlers
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const response = yield* service
							.listReconciled(tenant)
							.pipe(Effect.mapError(mapPersistenceError))
						const page = paginateArray(response.issues.map(toV2Recommendation), query)
						return { object: "list" as const, ...page }
					}),
				)
				.handle("dismiss", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const response = yield* service
							.dismiss(tenant, params.id)
							.pipe(Effect.mapError(mapMutationError))
						const issue = yield* pickIssue(response.issues, params.id)
						return toV2Recommendation(issue)
					}),
				)
				.handle("reopen", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const response = yield* service
							.reopen(tenant, params.id)
							.pipe(Effect.mapError(mapMutationError))
						const issue = yield* pickIssue(response.issues, params.id)
						return toV2Recommendation(issue)
					}),
				)
		}),
)
