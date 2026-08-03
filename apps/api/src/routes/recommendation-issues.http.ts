import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"

export const HttpRecommendationIssuesLive = HttpApiBuilder.group(
	MapleApi,
	"recommendationIssues",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* RecommendationIssueService

			return handlers
				.handle("list", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						return yield* service.listReconciled(tenant)
					}).pipe(Effect.withSpan("HttpRecommendationIssues.list")),
				)
				.handle("dismiss", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, issueId: params.id })
						return yield* service.dismiss(tenant, params.id)
					}).pipe(Effect.withSpan("HttpRecommendationIssues.dismiss")),
				)
				.handle("reopen", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, issueId: params.id })
						return yield* service.reopen(tenant, params.id)
					}).pipe(Effect.withSpan("HttpRecommendationIssues.reopen")),
				)
		}),
)
