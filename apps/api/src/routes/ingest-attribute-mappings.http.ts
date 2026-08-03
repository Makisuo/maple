import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { IngestAttributeMappingService } from "@/services/IngestAttributeMappingService"

export const HttpIngestAttributeMappingsLive = HttpApiBuilder.group(
	MapleApi,
	"ingestAttributeMappings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* IngestAttributeMappingService

			return handlers
				.handle("list", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						return yield* service.list(tenant.orgId)
					}).pipe(Effect.withSpan("HttpIngestAttributeMappings.list")),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						return yield* service.create(tenant.orgId, payload)
					}).pipe(Effect.withSpan("HttpIngestAttributeMappings.create")),
				)
				.handle("update", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							mappingId: params.mappingId,
						})
						return yield* service.update(tenant.orgId, params.mappingId, payload)
					}).pipe(Effect.withSpan("HttpIngestAttributeMappings.update")),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							mappingId: params.mappingId,
						})
						return yield* service.delete(tenant.orgId, params.mappingId)
					}).pipe(Effect.withSpan("HttpIngestAttributeMappings.delete")),
				)
		}),
)
