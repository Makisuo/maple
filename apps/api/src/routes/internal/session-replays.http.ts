import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	MapleInternalApi,
	ReplaysFacetsResponse,
	SessionTraceSummariesResponse,
	TraceId,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

const decodeTraceId = Schema.decodeSync(TraceId)

/**
 * Dashboard-only session-replay helpers.
 *
 * Facet counts feed the replays filter sidebar and trace summaries feed a
 * session's timeline — both are shaped by what those views render, so they stay
 * off the public API (`docs/http-api-migration.md` marks them "do not lift").
 */
export const HttpSessionReplaysInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"sessionReplaysInternal",
	(handlers) =>
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			return handlers
				.handle("facets", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const compiled = CH.compileUnion(
							CH.sessionReplaysFacetsQuery({
								serviceName: payload.serviceName,
								browser: payload.browser,
								country: payload.country,
								deviceType: payload.deviceType,
								userId: payload.userId,
								userSearch: payload.userSearch,
								groupName: payload.groupName,
								hasErrors: payload.hasErrors,
								search: payload.search,
							}),
							{
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
							},
						)
						const rows = yield* warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "replaysFacets",
						})
						// ClickHouse serializes integer aggregates (`uniq(...)`) as JSON strings,
						// while the Tinybird path returns numbers; this query declares no row
						// schema, so coerce at the edge before the Schema.Number response validates.
						const pick = (facetType: string) =>
							rows
								.filter((row) => row.facetType === facetType)
								.map((row) => ({ name: row.name, count: Number(row.count) }))
						// The percentile branches ride the same {name, count} shape as the
						// facets, with the quantile in `count` — read them back by label.
						const stat = (name: string) =>
							Number(
								rows.find((row) => row.facetType === "durationStat" && row.name === name)
									?.count ?? 0,
							)
						return new ReplaysFacetsResponse({
							services: pick("service"),
							browsers: pick("browser"),
							countries: pick("country"),
							devices: pick("device"),
							groups: pick("group"),
							errorCount: Number(rows.find((row) => row.facetType === "error")?.count ?? 0),
							durationBuckets: pick("durationBucket"),
							durationP50: stat("p50"),
							durationP95: stat("p95"),
						})
					}),
				)
				.handle("traceSummaries", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"maple.trace.count": payload.traceIds.length,
						})
						// `TraceId IN ()` is invalid SQL; a session with no correlated traces
						// short-circuits to an empty result without touching the warehouse.
						if (payload.traceIds.length === 0) {
							return new SessionTraceSummariesResponse({ data: [] })
						}
						const compiled = CH.compile(
							CH.sessionTraceSummariesQuery({
								traceIds: payload.traceIds,
								startTime: payload.windowStart,
								endTime: payload.windowEnd,
							}),
							{ orgId: tenant.orgId },
						)
						const rows = yield* warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "sessionTraceSummaries",
						})
						return new SessionTraceSummariesResponse({
							data: rows.map((row) => ({
								...row,
								traceId: decodeTraceId(row.traceId),
								// `count()` is UInt64 — same ClickHouse JSON-string coercion as
								// listReplays' traceCount; coerce before Schema.Number validates.
								spanCount: Number(row.spanCount),
							})),
						})
					}),
				)
		}),
)
