// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { Clock, Context, Effect, Layer, Metric } from "effect"
import { QueryEngineExecuteResponse, type QueryEngineExecuteRequest } from "@maple/query-engine"
import type { QueryEngineTimeoutError } from "@maple/domain/http"
import {
	buildCacheKey,
	buildDirectRouteCacheKey,
	buildEvaluateCacheKey,
	cacheTtlForQueryKind,
	computeBucketSeconds,
	makeQueryEngineEvaluate,
	makeQueryEngineEvaluateSeries,
	makeQueryEngineExecute,
	msToTinybirdDateTime,
	resolveDirectRouteCachePolicy,
	toEpochMs,
	withTimeout,
	type BucketGroupObs,
	type GroupedAlertObservation,
	type DirectRouteCachePolicyInput,
	type QueryEngineDirectError,
	type QueryEngineEvaluationError,
	type AlertEvaluateRequest,
	type QueryEngineRouteError,
	type TimeRangeBounds,
} from "@maple/query-engine/runtime"
import type { TenantContext } from "@/services/auth/AuthService"
import { BucketCacheService } from "@maple/query-engine/caching"
import {
	isTimeBucketQueryCachePolicy,
	logsCount,
	logsTimeseries,
	queryDefinitionCacheIdentity,
	resolveQueryDefinitionCache,
	toLogsCountInput,
	toLogsTimeseriesInput,
	type QueryDefinition,
} from "@maple/query-engine/registry"
import { EdgeCacheService } from "@maple/cache"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import * as QueryEngineMetrics from "@/observability/QueryEngineMetrics"

// QueryEngineService — caching + orchestration. The pure lowering (validation,
// QuerySpec → CH, evaluate/raw-SQL) lives in `@maple/query-engine/runtime`; this
// service composes those impls, wires the edge + bucket caches, and exposes the
// tenant-scoped HTTP surface.

export interface QueryEngineServiceApi {
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
	) => Effect.Effect<ReadonlyArray<GroupedAlertObservation>, QueryEngineEvaluationError>
	/**
	 * Evaluate an alert query and return the per-(bucket, group) observations
	 * instead of a reduced scalar per group. One bucket == one evaluation window,
	 * so the series is exactly what the scheduler would have observed per tick.
	 * Uncached — backs the ad-hoc rule preview chart.
	 */
	readonly evaluateSeries: (
		tenant: TenantContext,
		request: AlertEvaluateRequest,
	) => Effect.Effect<ReadonlyArray<BucketGroupObs>, QueryEngineEvaluationError>
	/**
	 * Edge-cache a direct-route query keyed by `(orgId, routeName, payload)`.
	 * A numeric policy preserves the legacy TTL-aligned snap behavior. Routes can
	 * instead pass a versioned policy to tune TTL and time-key snapping
	 * independently without changing the storage service.
	 */
	readonly cachedDirect: <A, E extends QueryEngineDirectError>(
		tenant: TenantContext,
		routeName: string,
		payload: unknown,
		effect: Effect.Effect<A, E>,
		policy?: DirectRouteCachePolicyInput,
	) => Effect.Effect<A, E | QueryEngineTimeoutError>
}
export class QueryEngineService extends Context.Service<QueryEngineService, QueryEngineServiceApi>()(
	"@maple/api/services/QueryEngineService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService
			const edgeCache = yield* EdgeCacheService
			const bucketCache = yield* BucketCacheService
			const executeImpl = makeQueryEngineExecute(warehouse)
			const evaluateImpl = makeQueryEngineEvaluate(warehouse)
			const evaluateSeriesImpl = makeQueryEngineEvaluateSeries(warehouse)

			const migratedDefinitionFor = (request: QueryEngineExecuteRequest, bucketSeconds?: number) => {
				if (request.query.source === "logs" && request.query.kind === "count") {
					return {
						kind: "count" as const,
						definition: logsCount,
						input: toLogsCountInput(request.startTime, request.endTime, request.query),
					}
				}
				if (request.query.source === "logs" && request.query.kind === "timeseries") {
					const resolvedBucketSeconds =
						bucketSeconds ??
						request.query.bucketSeconds ??
						computeBucketSeconds(toEpochMs(request.startTime), toEpochMs(request.endTime))
					return {
						kind: "time-buckets" as const,
						definition: logsTimeseries,
						input: toLogsTimeseriesInput(
							request.startTime,
							request.endTime,
							request.query,
							resolvedBucketSeconds,
						),
					}
				}
				return undefined
			}

			const canonicalResultCache = <Payload, Row>(
				tenant: TenantContext,
				definition: QueryDefinition<Payload, Row>,
				input: Payload,
				nowMs: number,
			) => {
				const declared = resolveQueryDefinitionCache(definition, input, nowMs)
				const policy = isTimeBucketQueryCachePolicy(declared) ? declared.fallback : declared
				if (policy === undefined) return undefined
				return {
					key: buildDirectRouteCacheKey(
						tenant.orgId,
						definition.id,
						queryDefinitionCacheIdentity(definition, input),
						policy,
					),
					policy,
				}
			}

			const recordCacheOutcome = (hit: boolean) =>
				Metric.update(
					hit ? QueryEngineMetrics.cacheHitsTotal : QueryEngineMetrics.cacheMissesTotal,
					1,
				)

			/**
			 * Coverage at or above which a bucket-cache lookup counts as a hit.
			 *
			 * The obvious test — "issued no warehouse query" — is unusable on this
			 * path: the trailing flux window is never cacheable, so a live dashboard
			 * always issues one, and the counter reported a miss on literally every
			 * request regardless of how well the cache was working. Coverage is what
			 * actually determines whether the request was cheap.
			 */
			const BUCKET_CACHE_HIT_COVERAGE = 0.9

			const recordBucketCacheOutcome = (outcome: {
				readonly bucketsHit: number
				readonly requestedBuckets: number
			}) =>
				Effect.gen(function* () {
					const coverage =
						outcome.requestedBuckets === 0 ? 1 : outcome.bucketsHit / outcome.requestedBuckets
					yield* Metric.update(QueryEngineMetrics.bucketCacheCoverageRatio, coverage)
					yield* recordCacheOutcome(coverage >= BUCKET_CACHE_HIT_COVERAGE)
				})

			const legacyBlobCachedExecute = Effect.fn("QueryEngineService.legacyBlobCachedExecute")(
				function* (tenant: TenantContext, request: QueryEngineExecuteRequest) {
					const startMs = yield* Clock.currentTimeMillis
					const migrated = migratedDefinitionFor(request)
					const canonical =
						migrated?.kind === "count"
							? canonicalResultCache(tenant, migrated.definition, migrated.input, startMs)
							: migrated?.kind === "time-buckets"
								? canonicalResultCache(tenant, migrated.definition, migrated.input, startMs)
								: undefined
					const key = canonical?.key ?? buildCacheKey(tenant.orgId, request)
					const ttlSeconds =
						canonical?.policy.ttlSeconds ?? cacheTtlForQueryKind(request.query.kind)
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
				const migrated = migratedDefinitionFor(request, bucketSeconds)
				const migratedPolicy =
					migrated?.kind === "time-buckets"
						? resolveQueryDefinitionCache(migrated.definition, migrated.input, 0)
						: undefined
				const cacheQuery =
					migrated?.kind === "time-buckets" && isTimeBucketQueryCachePolicy(migratedPolicy)
						? queryDefinitionCacheIdentity(
								migrated.definition,
								migrated.input,
								migratedPolicy.identity(migrated.input),
							)
						: pinnedQuery

				const outcome = yield* bucketCache.getOrComputeBuckets(
					{
						orgId: tenant.orgId,
						query: cacheQuery,
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
					// Resolve this org's warehouse route once before the fill fans
					// out. Without it each branch resolves it independently and they
					// all miss the in-isolate memo, because they start together:
					// measured in prod as the same config read running twice
					// concurrently at 2.90s each, against warehouse queries of 428ms
					// and 1179ms. The bucket cache only runs this on a >1-range fill,
					// so cache hits and single-range fills are unaffected.
					warehouse.warmRoute(tenant),
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
				yield* recordBucketCacheOutcome(outcome)
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
						// Every `return` below picks one of two very differently-priced
						// paths, and a request that quietly lands on the blob path looks
						// exactly like a bucket cache with a bad hit rate. Record which
						// path ran, and why, so the two are distinguishable in a trace.
						const useBlobPath = (reason: string) =>
							Effect.annotateCurrentSpan({
								"cache.path": "blob",
								"cache.blob_reason": reason,
							}).pipe(Effect.andThen(legacyBlobCachedExecute(tenant, request)))

						if (!bucketCache.enabled) return yield* useBlobPath("bucket_cache_disabled")
						if (request.query.kind !== "timeseries") return yield* useBlobPath("not_timeseries")

						const startEpochMs = toEpochMs(request.startTime)
						const endEpochMs = toEpochMs(request.endTime)
						if (
							Number.isNaN(startEpochMs) ||
							Number.isNaN(endEpochMs) ||
							endEpochMs <= startEpochMs
						) {
							return yield* useBlobPath("invalid_range")
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
							return yield* useBlobPath("range_below_one_bucket")
						}

						yield* Effect.annotateCurrentSpan("cache.path", "bucket")
						return yield* bucketCachedExecute(tenant, request, bucketSeconds, rangeBounds)
					}).pipe(
						Effect.withSpan("QueryEngineService.cachedExecute", {
							attributes: { orgId: tenant.orgId },
						}),
					),
				)
			})

			const cachedEvaluate = Effect.fn("QueryEngineService.cachedEvaluate")(function* (
				tenant: TenantContext,
				request: AlertEvaluateRequest,
			) {
				return yield* withTimeout(
					Effect.gen(function* () {
						// Alert evaluations are small and use a short whole-result cache.
						const key = buildEvaluateCacheKey(tenant.orgId, request)
						const { value, hit } = yield* edgeCache.getOrCompute(
							{ bucket: "qe-evaluate", key, ttlSeconds: 30 },
							evaluateImpl(tenant, request),
						)
						yield* recordCacheOutcome(hit)
						yield* Effect.annotateCurrentSpan("cache.hit", hit)
						return value
					}),
				)
			})

			const cachedDirect = Effect.fn("QueryEngineService.cachedDirect")(function* <
				A,
				E extends QueryEngineDirectError,
			>(
				tenant: TenantContext,
				routeName: string,
				payload: unknown,
				effect: Effect.Effect<A, E>,
				policyInput: DirectRouteCachePolicyInput = 15,
			) {
				// Attributes go on the `Effect.fn` span, not an inner `withSpan` of the
				// same name. Wrapping the body in a second same-named span emitted two
				// spans per call: the inner one closed interrupt-only as `Ok` while the
				// outer recorded the real `Error`, so every timed-out request showed up
				// twice — once at 30s `Ok`, once at 30s `Error`.
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, routeName })
				return yield* withTimeout(
					Effect.gen(function* () {
						const startMs = yield* Clock.currentTimeMillis
						// Settle the org's warehouse route BEFORE opening the cache read
						// below, not inside its `compute`.
						//
						// A Workers `cache.match()` holds one of the isolate's six
						// connection slots until it returns headers, and an abandoned read
						// is not cancellable — so a read issued while another is still
						// outstanding queues behind it. `compute` runs `resolveRoute` →
						// `resolveRuntimeConfig`, which used to issue exactly such a nested
						// read on the `org-ch-config` bucket while this one was still open.
						// Measured: every two-read request lost one of the two to the 40ms
						// deadline (46 of 46), and losing it cost this span a p50 of 720ms
						// against 140ms for a clean miss. One-read requests timed out 0
						// times in 36.
						//
						// Hoisting it does not merely reorder the two reads, it removes the
						// second: `resolveCachedSettings` keeps an isolate-level memo, so
						// the call inside `compute` now answers from memory.
						//
						// `warmRoute` swallows its own failures — this is a warm, not a
						// gate. A genuine config failure still surfaces from `compute`,
						// with its own error channel and span, exactly as before.
						yield* warehouse.warmRoute(tenant)
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
					}),
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
			} satisfies QueryEngineServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
