import { Clock, Config, Context, Effect, Layer, Metric } from "effect"
import {
	QueryEngineExecuteResponse,
	type QueryEngineEvaluateRequest,
	type QueryEngineExecuteRequest,
} from "@maple/query-engine"
import {
	buildCacheKey,
	buildDirectRouteCacheKey,
	buildEvaluateCacheKey,
	cacheTtlForQueryKind,
	computeBucketSeconds,
	computeAlertBuckets,
	decodeEvalSeries,
	encodeEvalPoints,
	makeQueryEngineEvaluate,
	makeQueryEngineEvaluateSeries,
	makeQueryEngineExecute,
	msToTinybirdDateTime,
	reduceAlertBuckets,
	resolveDirectRouteCachePolicy,
	toEpochMs,
	validateEvaluate,
	withTimeout,
	type BucketGroupObs,
	type GroupedAlertObservation,
	type DirectRouteCachePolicyInput,
	type QueryEngineDirectError,
	type AlertEvaluateRequest,
	type QueryEngineRouteError,
	type TimeRangeBounds,
} from "@maple/query-engine/runtime"
import type { QuerySpec } from "@maple/query-engine"
import type { TenantContext } from "./AuthService"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService } from "@maple/cache"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import * as QueryEngineMetrics from "../lib/QueryEngineMetrics"

// ---------------------------------------------------------------------------
// QueryEngineService — caching + orchestration. The pure lowering (validation,
// QuerySpec → CH, evaluate/raw-SQL) lives in `@maple/query-engine/runtime`; this
// service composes those impls, wires the edge + bucket caches, and exposes the
// tenant-scoped HTTP surface.
// ---------------------------------------------------------------------------

export interface QueryEngineServiceShape {
	readonly execute: (
		tenant: TenantContext,
		request: QueryEngineExecuteRequest,
	) => Effect.Effect<QueryEngineExecuteResponse, QueryEngineRouteError>
	/**
	 * Evaluate an alert query and return one observation per group. Takes any
	 * alert source — a structured spec or user-authored ClickHouse SQL (which is
	 * macro-expanded via `$__orgFilter` / `$__timeFilter` / `$__timeGroup` before
	 * execution) — so callers never branch on the rule kind. When the source has
	 * no grouping the result is a length-1 array with `groupKey = "all"`; the
	 * reducer collapses each group's bucket series down to a scalar.
	 */
	readonly evaluate: (
		tenant: TenantContext,
		request: AlertEvaluateRequest,
	) => Effect.Effect<ReadonlyArray<GroupedAlertObservation>, QueryEngineRouteError>
	/**
	 * Evaluate an alert query and return the per-(bucket, group) observations
	 * instead of a reduced scalar per group. One bucket == one evaluation window,
	 * so the series is exactly what the scheduler would have observed per tick.
	 * Uncached — backs the ad-hoc rule preview chart.
	 */
	readonly evaluateSeries: (
		tenant: TenantContext,
		request: AlertEvaluateRequest,
	) => Effect.Effect<ReadonlyArray<BucketGroupObs>, QueryEngineRouteError>
	/**
	 * Edge-cache a direct-route query keyed by `(orgId, routeName, payload)`.
	 * A numeric policy preserves the legacy TTL-aligned snap behavior. Routes can
	 * instead pass a versioned policy to tune TTL and time-key snapping
	 * independently without changing the storage service.
	 */
	readonly cachedDirect: <A>(
		tenant: TenantContext,
		routeName: string,
		payload: unknown,
		effect: Effect.Effect<A, QueryEngineDirectError>,
		policy?: DirectRouteCachePolicyInput,
	) => Effect.Effect<A, QueryEngineDirectError>
}
export class QueryEngineService extends Context.Service<QueryEngineService, QueryEngineServiceShape>()(
	"@maple/api/services/QueryEngineService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService
			const edgeCache = yield* EdgeCacheService
			const bucketCache = yield* BucketCacheService
			const executeImpl = makeQueryEngineExecute(warehouse)
			const evaluateImpl = makeQueryEngineEvaluate(warehouse)
			const evaluateSeriesImpl = makeQueryEngineEvaluateSeries(warehouse)
			// Off by default. Live measurement showed routing alert evaluation
			// through the bucket cache is a NET REGRESSION: each eval fans out into
			// ~3 warehouse queries (the flux tail + alignment gaps become separate
			// queries run with unbounded concurrency), so it TRIPLED alert-eval
			// warehouse QPS rather than reducing it — driving eval p50 150ms→~800ms,
			// p99 into the 30s timeout, and contending the warehouse for dashboards
			// too. Each eval query is only ~130ms/~1 row, so the blob path is cheaper.
			// Re-enable only after the fan-out is coalesced into ≤1 query per eval
			// (min(start)..max(end)) with bounded concurrency.
			const evalBucketCacheEnabled = yield* Config.boolean("QE_EVAL_BUCKET_CACHE_ENABLED").pipe(
				Config.withDefault(false),
			)

			const recordCacheOutcome = (hit: boolean) =>
				Metric.update(
					hit ? QueryEngineMetrics.cacheHitsTotal : QueryEngineMetrics.cacheMissesTotal,
					1,
				)

			const legacyBlobCachedExecute = Effect.fn("QueryEngineService.legacyBlobCachedExecute")(
				function* (tenant: TenantContext, request: QueryEngineExecuteRequest) {
					const startMs = yield* Clock.currentTimeMillis
					const key = buildCacheKey(tenant.orgId, request)
					const ttlSeconds = cacheTtlForQueryKind(request.query.kind)
					const { value, hit } = yield* edgeCache.getOrCompute(
						{
							bucket: "qe-execute",
							key,
							ttlSeconds,
							schema: QueryEngineExecuteResponse,
						},
						executeImpl(tenant, request),
					)
					yield* recordCacheOutcome(hit)
					yield* Effect.annotateCurrentSpan("cache.hit", hit)
					yield* Effect.annotateCurrentSpan("cache.ttlSeconds", ttlSeconds)
					yield* Metric.update(
						QueryEngineMetrics.executeDurationMs,
						(yield* Clock.currentTimeMillis) - startMs,
					)
					return value
				},
			)

			const bucketCachedExecute = Effect.fn("QueryEngineService.bucketCachedExecute")(function* (
				tenant: TenantContext,
				request: QueryEngineExecuteRequest,
				bucketSeconds: number,
				range: TimeRangeBounds,
			) {
				if (request.query.kind !== "timeseries") {
					return yield* legacyBlobCachedExecute(tenant, request)
				}
				const source = request.query.source
				const perfStartMs = yield* Clock.currentTimeMillis
				// Pin bucketSeconds onto the query so the fan-out's narrowed ranges
				// don't let validateExecute recompute a smaller step — buckets must
				// match the outer cache's step exactly.
				const pinnedQuery = { ...request.query, bucketSeconds }

				const outcome = yield* bucketCache.getOrComputeBuckets(
					{
						orgId: tenant.orgId,
						query: pinnedQuery,
						bucketSeconds,
						startMs: range.startMs,
						endMs: range.endMs,
					},
					({ startMs, endMs }) =>
						executeImpl(tenant, {
							...request,
							query: pinnedQuery,
							startTime: msToTinybirdDateTime(startMs),
							endTime: msToTinybirdDateTime(endMs),
						}).pipe(
							Effect.map((response) =>
								response.result.kind === "timeseries" ? response.result.data : [],
							),
						),
				)

				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsHit, outcome.bucketsHit)
				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsMissed, outcome.bucketsMissed)
				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsRequested, outcome.requestedBuckets)
				yield* Metric.update(
					QueryEngineMetrics.bucketCacheWarehouseQueries,
					outcome.warehouseQueryCount,
				)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentHits, outcome.segmentsHit)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentMisses, outcome.segmentsMissed)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentTimeouts, outcome.segmentsTimedOut)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentErrors, outcome.segmentsErrored)
				yield* Metric.update(QueryEngineMetrics.bucketCacheMissingRanges, outcome.missingRangeCount)
				yield* recordCacheOutcome(outcome.warehouseQueryCount === 0)
				yield* Effect.annotateCurrentSpan("cache.bucketsHit", outcome.bucketsHit)
				yield* Effect.annotateCurrentSpan("cache.bucketsMissed", outcome.bucketsMissed)
				yield* Effect.annotateCurrentSpan("cache.missingRangeCount", outcome.missingRangeCount)
				yield* Metric.update(
					QueryEngineMetrics.executeDurationMs,
					(yield* Clock.currentTimeMillis) - perfStartMs,
				)

				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries",
						source,
						data: outcome.points,
					},
				})
			})

			const execute = Effect.fn("QueryEngineService.execute")(function* (
				tenant: TenantContext,
				request: QueryEngineExecuteRequest,
			) {
				return yield* withTimeout(
					Effect.gen(function* () {
						if (!bucketCache.enabled || request.query.kind !== "timeseries") {
							return yield* legacyBlobCachedExecute(tenant, request)
						}

						const startEpochMs = toEpochMs(request.startTime)
						const endEpochMs = toEpochMs(request.endTime)
						if (
							Number.isNaN(startEpochMs) ||
							Number.isNaN(endEpochMs) ||
							endEpochMs <= startEpochMs
						) {
							return yield* legacyBlobCachedExecute(tenant, request)
						}
						const rangeBounds: TimeRangeBounds = {
							startMs: startEpochMs,
							endMs: endEpochMs,
							rangeSeconds: (endEpochMs - startEpochMs) / 1000,
						}

						const bucketSeconds =
							request.query.bucketSeconds ??
							computeBucketSeconds(rangeBounds.startMs, rangeBounds.endMs)

						if (rangeBounds.endMs - rangeBounds.startMs < bucketSeconds * 1000) {
							return yield* legacyBlobCachedExecute(tenant, request)
						}

						return yield* bucketCachedExecute(tenant, request, bucketSeconds, rangeBounds)
					}).pipe(
						Effect.withSpan("QueryEngineService.cachedExecute", {
							attributes: { orgId: tenant.orgId },
						}),
					),
				)
			})

			// Bucket-cached evaluate: each alert rule re-queries a near-fully-
			// overlapping window every tick, so route it through the same bucket
			// cache the dashboard timeseries path uses — only the missing tail is
			// fetched, and the flux boundary keeps the live tail fresh (no added
			// alert staleness). The reducer/sampleCountStrategy are applied AFTER
			// the fetch (unchanged), so the cache key is independent of them and two
			// rules over the same query+window share buckets.
			const bucketCachedEvaluate = Effect.fn("QueryEngineService.bucketCachedEvaluate")(function* (
				tenant: TenantContext,
				request: AlertEvaluateRequest & { readonly source: { kind: "spec"; query: QuerySpec } },
				bucketSeconds: number,
				range: { readonly startMs: number; readonly endMs: number },
			) {
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
				yield* Effect.annotateCurrentSpan("query.source", request.source.query.source)
				yield* Effect.annotateCurrentSpan("query.reducer", request.reducer)

				// Pin bucketSeconds + an `__eval` discriminator so evaluate points
				// (which encode value + sampleCount) never collide with dashboard
				// execute points (value only) under the shared cache namespace.
				const pinnedQuery = { ...request.source.query, bucketSeconds }

				const outcome = yield* bucketCache.getOrComputeBuckets(
					{
						orgId: tenant.orgId,
						query: { __eval: true, query: pinnedQuery },
						bucketSeconds,
						startMs: range.startMs,
						endMs: range.endMs,
					},
					({ startMs, endMs }) =>
						computeAlertBuckets(
							warehouse,
							tenant,
							{
								source: request.source,
								startTime: msToTinybirdDateTime(startMs),
								endTime: msToTinybirdDateTime(endMs),
							},
							bucketSeconds,
						).pipe(Effect.map(encodeEvalPoints)),
				)

				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsHit, outcome.bucketsHit)
				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsMissed, outcome.bucketsMissed)
				yield* Metric.update(QueryEngineMetrics.bucketCacheBucketsRequested, outcome.requestedBuckets)
				yield* Metric.update(
					QueryEngineMetrics.bucketCacheWarehouseQueries,
					outcome.warehouseQueryCount,
				)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentHits, outcome.segmentsHit)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentMisses, outcome.segmentsMissed)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentTimeouts, outcome.segmentsTimedOut)
				yield* Metric.update(QueryEngineMetrics.bucketCacheSegmentErrors, outcome.segmentsErrored)
				yield* Metric.update(QueryEngineMetrics.bucketCacheMissingRanges, outcome.missingRangeCount)
				yield* recordCacheOutcome(outcome.warehouseQueryCount === 0)
				yield* Effect.annotateCurrentSpan("cache.bucketsHit", outcome.bucketsHit)
				yield* Effect.annotateCurrentSpan("cache.bucketsMissed", outcome.bucketsMissed)
				yield* Effect.annotateCurrentSpan("cache.missingRangeCount", outcome.missingRangeCount)

				const result = reduceAlertBuckets(decodeEvalSeries(outcome.points), request.reducer)
				yield* Effect.annotateCurrentSpan("result.groupCount", result.length)
				return result
			})

			const cachedEvaluate = Effect.fn("QueryEngineService.cachedEvaluate")(function* (
				tenant: TenantContext,
				request: AlertEvaluateRequest,
			) {
				return yield* withTimeout(
					Effect.gen(function* () {
						// Raw SQL is never bucket-cached: its rows are user-defined, so the
						// cache cannot reason about which ranges are safely re-fetchable.
						const spec = request.source.kind === "spec" ? request.source.query : null
						const bucketable =
							spec != null &&
							spec.kind === "timeseries" &&
							(spec.source === "traces" || spec.source === "logs" || spec.source === "metrics")

						if (evalBucketCacheEnabled && bucketCache.enabled && bucketable) {
							const startMs = toEpochMs(request.startTime)
							const endMs = toEpochMs(request.endTime)
							const bucketSeconds = spec.bucketSeconds ?? computeBucketSeconds(startMs, endMs)
							if (
								Number.isFinite(startMs) &&
								Number.isFinite(endMs) &&
								endMs > startMs &&
								endMs - startMs >= bucketSeconds * 1000
							) {
								// Validate up front: the bucket path bypasses evaluateImpl,
								// whose generator is what otherwise runs validateEvaluate.
								yield* validateEvaluate(request)
								return yield* bucketCachedEvaluate(
									tenant,
									{ ...request, source: { kind: "spec", query: spec } },
									bucketSeconds,
									{ startMs, endMs },
								)
							}
						}

						// Fallback: legacy 30s blob cache around the direct evaluate
						// (tiny ranges, unsupported sources, or the kill switch off).
						const key = buildEvaluateCacheKey(tenant.orgId, request)
						const { value, hit } = yield* edgeCache.getOrCompute(
							{ bucket: "qe-evaluate", key, ttlSeconds: 30 },
							evaluateImpl(tenant, request),
						)
						yield* recordCacheOutcome(hit)
						yield* Effect.annotateCurrentSpan("cache.hit", hit)
						return value
					}).pipe(
						Effect.withSpan("QueryEngineService.cachedEvaluate", {
							attributes: { orgId: tenant.orgId },
						}),
					),
				)
			})

			const cachedDirect = Effect.fn("QueryEngineService.cachedDirect")(function* <A>(
				tenant: TenantContext,
				routeName: string,
				payload: unknown,
				effect: Effect.Effect<A, QueryEngineDirectError>,
				policyInput: DirectRouteCachePolicyInput = 15,
			) {
				return yield* withTimeout(
					Effect.gen(function* () {
						const startMs = yield* Clock.currentTimeMillis
						const policy = resolveDirectRouteCachePolicy(policyInput)
						const key = buildDirectRouteCacheKey(tenant.orgId, routeName, payload, policy)
						const { value, hit } = yield* edgeCache.getOrCompute(
							{ bucket: "qe-direct", key, ttlSeconds: policy.ttlSeconds },
							effect,
						)
						yield* recordCacheOutcome(hit)
						yield* Effect.annotateCurrentSpan("cache.hit", hit)
						yield* Effect.annotateCurrentSpan({
							"cache.policy_version": policy.version,
							"cache.snap_window_seconds": policy.snapWindowSeconds,
							"cache.ttlSeconds": policy.ttlSeconds,
						})
						yield* Metric.update(
							QueryEngineMetrics.executeDurationMs,
							(yield* Clock.currentTimeMillis) - startMs,
						)
						return value
					}).pipe(
						Effect.withSpan("QueryEngineService.cachedDirect", {
							attributes: { orgId: tenant.orgId, routeName },
						}),
					),
				)
			})

			// `withTimeout` INSIDE the span, not outside it. `Effect.timeoutOrElse` is
			// `raceFirst(self, flatMap(sleep, orElse))`, so `orElse` runs as a sibling
			// of `self` — with the wrapping the other way round, the `query.timeout`
			// attribute it sets landed on whatever span was current at the call site.
			// These two are plain arrows with no `Effect.fn` of their own, so that was
			// `AlertsService.evaluateRule` (AlertsService.ts:1613, :2988, :3008): a 30s
			// query-engine ceiling tagged on an alerting span, invisible to any
			// dashboard scoped to query-engine spans. This ordering also lets the span
			// record the `QueryEngineTimeoutError` (504, so `Error` status) instead of
			// closing interrupt-only as `Ok` — which is the point of marking timeouts.
			const evaluateSeries = (tenant: TenantContext, request: AlertEvaluateRequest) =>
				withTimeout(evaluateSeriesImpl(tenant, request)).pipe(
					Effect.withSpan("QueryEngineService.evaluateSeries", {
						attributes: { orgId: tenant.orgId },
					}),
				)

			return {
				execute,
				evaluate: cachedEvaluate,
				evaluateSeries,
				cachedDirect,
			} satisfies QueryEngineServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
