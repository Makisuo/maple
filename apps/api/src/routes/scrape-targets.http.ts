import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	IsoDateTimeString,
	MapleApi,
	ScrapeTargetCheckResponse,
	ScrapeTargetChecksListResponse,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { ScrapeTargetsService } from "@/services/integrations/ScrapeTargetsService"

const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

export const HttpScrapeTargetsLive = HttpApiBuilder.group(MapleApi, "scrapeTargets", (handlers) =>
	Effect.gen(function* () {
		const service = yield* ScrapeTargetsService

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.list(tenant.orgId)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.create(tenant.orgId, payload)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.update(tenant.orgId, params.targetId, payload)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.delete(tenant.orgId, params.targetId)
				}),
			)
			.handle("probe", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.probe(tenant.orgId, params.targetId)
				}),
			)
			.handle("listChecks", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					const rows = yield* service.listChecks(tenant.orgId, params.targetId, {
						...(query.since !== undefined ? { startTime: Date.parse(query.since) } : {}),
						...(query.until !== undefined ? { endTime: Date.parse(query.until) } : {}),
						...(query.limit !== undefined ? { limit: query.limit } : {}),
					})

					return new ScrapeTargetChecksListResponse({
						checks: rows.map(
							(row) =>
								new ScrapeTargetCheckResponse({
									timestamp: decodeIsoDateTimeStringSync(
										new Date(row.checkedAt).toISOString(),
									),
									success: row.error === null,
									subTargetKey: row.subTargetKey === "" ? null : row.subTargetKey,
									durationSeconds: row.durationMs === null ? null : row.durationMs / 1000,
									samplesScraped: row.samplesScraped,
									samplesPostMetricRelabeling: row.samplesPostRelabel,
									message: row.error,
								}),
						),
					})
				}),
			)
	}),
)
