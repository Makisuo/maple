import type { OrgId } from "@maple/domain"
import type { TimeseriesPoint } from "../query-engine"
import { parseWarehouseDateTime } from "../datetime"
import { Clock, Config, Context, Deferred, Effect, Layer, Option } from "effect"
import { EdgeCacheService } from "./edge-cache"

/**
 * Inclusive start, exclusive end. Epoch milliseconds.
 */
export interface TimeRange {
	readonly startMs: number
	readonly endMs: number
}

/**
 * A cached bucket represents the result points for a step-aligned window.
 * `points` is a readonly slice of `TimeseriesPoint`; bucket keys (ISO 8601)
 * live inside the points themselves.
 */
export interface CachedBucket {
	readonly startMs: number
	readonly endMs: number
	readonly points: ReadonlyArray<TimeseriesPoint>
}

export interface BucketedCacheData {
	readonly version: 1
	readonly fingerprint: string
	readonly bucketSeconds: number
	readonly buckets: ReadonlyArray<CachedBucket>
}

export interface BucketCacheSegmentData {
	readonly version: 2
	readonly fingerprint: string
	readonly bucketSeconds: number
	readonly segmentStartMs: number
	readonly segmentEndMs: number
	readonly buckets: ReadonlyArray<CachedBucket>
}

export interface MissingRange {
	readonly range: TimeRange
	/** If false, results for this range must not be written back to cache. */
	readonly cachable: boolean
}

export interface BucketCacheOutcome {
	readonly points: ReadonlyArray<TimeseriesPoint>
	readonly requestedBuckets: number
	readonly bucketsHit: number
	readonly bucketsMissed: number
	readonly missingRangeCount: number
	readonly warehouseQueryCount: number
	readonly segmentsHit: number
	readonly segmentsMissed: number
	readonly segmentsTimedOut: number
	readonly segmentsErrored: number
}

export interface BucketCacheRequest {
	readonly orgId: OrgId
	readonly query: unknown
	readonly bucketSeconds: number
	readonly startMs: number
	readonly endMs: number
}

const BUCKET_CACHE_NAMESPACE = "qe-ts-buckets"
const CACHE_VERSION = 2 as const
const EMPTY_BUCKETS: ReadonlyArray<CachedBucket> = []

// --- Fingerprint helpers -------------------------------------------------

/**
 * Deterministically stringify `value` by recursively sorting object keys and
 * dropping `undefined`. Arrays preserve order. Non-serializable values are
 * coerced to `String(...)`.
 */
const canonicalJSON = (value: unknown): string => {
	const seen = new WeakSet<object>()
	const walk = (v: unknown): unknown => {
		if (v === null) return null
		if (v === undefined) return undefined
		const t = typeof v
		if (t === "string" || t === "number" || t === "boolean") return v
		if (t === "bigint") return v.toString()
		if (Array.isArray(v)) {
			return v.map((item) => walk(item))
		}
		if (t === "object") {
			if (seen.has(v as object)) return null
			seen.add(v as object)
			const entries = Object.entries(v as Record<string, unknown>)
				.filter(([, nested]) => nested !== undefined)
				.map(([key, nested]) => [key, walk(nested)] as const)
				.sort(([a], [b]) => a.localeCompare(b))
			return Object.fromEntries(entries)
		}
		return String(v)
	}
	return JSON.stringify(walk(value))
}

const sha256Hex = async (input: string): Promise<string> => {
	const bytes = new TextEncoder().encode(input)
	const digest = await crypto.subtle.digest("SHA-256", bytes)
	const view = new Uint8Array(digest)
	let out = ""
	for (let i = 0; i < view.length; i++) {
		out += view[i]!.toString(16).padStart(2, "0")
	}
	return out
}

export const generateFingerprint = async (
	orgId: OrgId | string,
	query: unknown,
	bucketSeconds: number,
): Promise<string> => {
	const canonical = canonicalJSON({ orgId, query, bucketSeconds })
	return sha256Hex(canonical)
}

// --- Miss-range algorithm ------------------------------------------------

/**
 * Walk sorted cached buckets and emit the gaps that must be fetched from
 * source, tagging each gap as cachable or non-cachable based on the flux
 * boundary. A gap whose `endMs` exceeds `fluxBoundaryMs` is split into a
 * cachable head and a non-cachable tail.
 */
export const findMissingRanges = (
	buckets: ReadonlyArray<CachedBucket>,
	startMs: number,
	endMs: number,
	bucketMs: number,
	fluxBoundaryMs: number,
): ReadonlyArray<MissingRange> => {
	if (endMs <= startMs) return []

	const sorted = [...buckets].sort((a, b) => a.startMs - b.startMs)
	const missing: MissingRange[] = []

	const emit = (from: number, to: number) => {
		if (to <= from) return
		if (to <= fluxBoundaryMs) {
			missing.push({ range: { startMs: from, endMs: to }, cachable: true })
			return
		}
		if (from >= fluxBoundaryMs) {
			missing.push({ range: { startMs: from, endMs: to }, cachable: false })
			return
		}
		missing.push({
			range: { startMs: from, endMs: fluxBoundaryMs },
			cachable: true,
		})
		missing.push({
			range: { startMs: fluxBoundaryMs, endMs: to },
			cachable: false,
		})
	}

	let cursor = startMs

	if (cursor % bucketMs !== 0) {
		const nextAligned = cursor - (cursor % bucketMs) + bucketMs
		emit(cursor, Math.min(nextAligned, endMs))
		cursor = nextAligned
	}

	for (const bucket of sorted) {
		if (bucket.endMs <= cursor) continue
		if (bucket.startMs >= endMs) break

		const alignedStart =
			bucket.startMs % bucketMs === 0
				? bucket.startMs
				: bucket.startMs - (bucket.startMs % bucketMs) + bucketMs

		if (cursor < alignedStart && cursor < endMs) {
			emit(cursor, Math.min(alignedStart, endMs))
		}

		let bucketEnd = Math.min(bucket.endMs, endMs)
		if (bucketEnd % bucketMs !== 0 && bucketEnd < endMs) {
			bucketEnd = bucketEnd - (bucketEnd % bucketMs)
		}
		cursor = Math.max(cursor, bucketEnd)
	}

	if (cursor < endMs) {
		emit(cursor, endMs)
	}

	return missing
}

// --- Bucket merging ------------------------------------------------------

/**
 * Group a flat point array by bucket window and emit cachable buckets only.
 * Any bucket whose `endMs > fluxBoundaryMs` is dropped — its points remain in
 * the caller's returned result set but must not be persisted.
 */
export const pointsToBuckets = (
	points: ReadonlyArray<TimeseriesPoint>,
	bucketMs: number,
	fluxBoundaryMs: number,
): ReadonlyArray<CachedBucket> => {
	const byBucket = new Map<number, TimeseriesPoint[]>()

	for (const point of points) {
		const ms = parseWarehouseDateTime(point.bucket)
		if (Number.isNaN(ms)) continue
		const aligned = Math.floor(ms / bucketMs) * bucketMs
		const existing = byBucket.get(aligned)
		if (existing) {
			existing.push(point)
		} else {
			byBucket.set(aligned, [point])
		}
	}

	const buckets: CachedBucket[] = []
	for (const [startMs, bucketPoints] of byBucket) {
		const endMs = startMs + bucketMs
		if (endMs > fluxBoundaryMs) continue
		buckets.push({ startMs, endMs, points: bucketPoints })
	}

	return buckets.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Merge existing and fresh buckets, deduping by `startMs`. Fresh buckets
 * supersede existing buckets with the same start (later-writer-wins).
 */
export const mergeAndDeduplicateBuckets = (
	existing: ReadonlyArray<CachedBucket>,
	fresh: ReadonlyArray<CachedBucket>,
): ReadonlyArray<CachedBucket> => {
	const byStart = new Map<number, CachedBucket>()
	for (const bucket of existing) {
		byStart.set(bucket.startMs, bucket)
	}
	for (const bucket of fresh) {
		byStart.set(bucket.startMs, bucket)
	}
	return [...byStart.values()].sort((a, b) => a.startMs - b.startMs)
}

/**
 * Slice cached buckets' points to only those whose `bucket` timestamp falls
 * within `[startMs, endMs)`. Used to build the final response from cache.
 */
const slicePointsFromBuckets = (
	buckets: ReadonlyArray<CachedBucket>,
	startMs: number,
	endMs: number,
): ReadonlyArray<TimeseriesPoint> => {
	const out: TimeseriesPoint[] = []
	for (const bucket of buckets) {
		if (bucket.endMs <= startMs) continue
		if (bucket.startMs >= endMs) break
		for (const point of bucket.points) {
			const ms = parseWarehouseDateTime(point.bucket)
			if (Number.isNaN(ms)) continue
			if (ms >= startMs && ms < endMs) {
				out.push(point)
			}
		}
	}
	return out
}

const requestedBucketStarts = (startMs: number, endMs: number, bucketMs: number): number[] => {
	if (endMs <= startMs) return []
	const first = Math.floor(startMs / bucketMs) * bucketMs
	const last = Math.floor((endMs - 1) / bucketMs) * bucketMs
	const starts: number[] = []
	for (let cursor = first; cursor <= last; cursor += bucketMs) starts.push(cursor)
	return starts
}

const segmentStartsForRange = (startMs: number, endMs: number, segmentMs: number): number[] => {
	if (endMs <= startMs) return []
	const first = Math.floor(startMs / segmentMs) * segmentMs
	const last = Math.floor((endMs - 1) / segmentMs) * segmentMs
	const starts: number[] = []
	for (let cursor = first; cursor <= last; cursor += segmentMs) starts.push(cursor)
	return starts
}

const pointsToCoveredBuckets = (
	points: ReadonlyArray<TimeseriesPoint>,
	range: TimeRange,
	bucketMs: number,
	fluxBoundaryMs: number,
): ReadonlyArray<CachedBucket> => {
	const pointsByStart = new Map<number, TimeseriesPoint[]>()
	for (const point of points) {
		const pointMs = parseWarehouseDateTime(point.bucket)
		if (Number.isNaN(pointMs)) continue
		const startMs = Math.floor(pointMs / bucketMs) * bucketMs
		const existing = pointsByStart.get(startMs)
		if (existing) existing.push(point)
		else pointsByStart.set(startMs, [point])
	}

	const firstFullBucket = Math.ceil(range.startMs / bucketMs) * bucketMs
	const buckets: CachedBucket[] = []
	for (let startMs = firstFullBucket; startMs + bucketMs <= range.endMs; startMs += bucketMs) {
		const endMs = startMs + bucketMs
		if (endMs > fluxBoundaryMs) break
		buckets.push({ startMs, endMs, points: pointsByStart.get(startMs) ?? [] })
	}
	return buckets
}

const isBucketCacheSegmentData = (
	value: unknown,
	expected: {
		readonly fingerprint: string
		readonly bucketSeconds: number
		readonly bucketMs: number
		readonly segmentStartMs: number
		readonly segmentEndMs: number
	},
): value is BucketCacheSegmentData => {
	if (value === null || typeof value !== "object") return false
	const data = value as Partial<BucketCacheSegmentData>
	if (
		data.version !== CACHE_VERSION ||
		data.fingerprint !== expected.fingerprint ||
		data.bucketSeconds !== expected.bucketSeconds ||
		data.segmentStartMs !== expected.segmentStartMs ||
		data.segmentEndMs !== expected.segmentEndMs ||
		!Array.isArray(data.buckets)
	) {
		return false
	}
	return data.buckets.every((cachedBucket) => {
		if (cachedBucket === null || typeof cachedBucket !== "object") return false
		return (
			Number.isFinite(cachedBucket.startMs) &&
			Number.isFinite(cachedBucket.endMs) &&
			cachedBucket.startMs >= expected.segmentStartMs &&
			cachedBucket.endMs <= expected.segmentEndMs &&
			cachedBucket.endMs - cachedBucket.startMs === expected.bucketMs &&
			cachedBucket.startMs % expected.bucketMs === 0 &&
			Array.isArray(cachedBucket.points) &&
			cachedBucket.points.every((point: unknown) => {
				if (point === null || typeof point !== "object") return false
				const candidate = point as Partial<TimeseriesPoint>
				return (
					typeof candidate.bucket === "string" &&
					candidate.series !== null &&
					typeof candidate.series === "object"
				)
			})
		)
	})
}

// --- Service -------------------------------------------------------------

interface DeferredAwaiter<E = unknown> {
	readonly await: Effect.Effect<BucketCacheOutcome, E>
}

export interface BucketCacheServiceShape {
	readonly enabled: boolean
	readonly getOrComputeBuckets: <E, R>(
		request: BucketCacheRequest,
		computeRange: (range: TimeRange) => Effect.Effect<ReadonlyArray<TimeseriesPoint>, E, R>,
	) => Effect.Effect<BucketCacheOutcome, E, R>
}

const enabledConfig = Config.boolean("QE_BUCKET_CACHE_ENABLED").pipe(Config.withDefault(true))
const ttlSecondsConfig = Config.number("QE_BUCKET_CACHE_TTL_SECONDS").pipe(Config.withDefault(86400))
const fluxSecondsConfig = Config.number("QE_BUCKET_CACHE_FLUX_SECONDS").pipe(Config.withDefault(60))
const segmentBucketsConfig = Config.number("QE_BUCKET_CACHE_SEGMENT_BUCKETS").pipe(Config.withDefault(120))
// A validated query contains at most 1,500 points, so 120-bucket segments
// produce at most 13 reads. Sixteen keeps the normal path within one shared
// edge-read deadline while still bounding malformed/internal callers.
const readConcurrencyConfig = Config.number("QE_BUCKET_CACHE_READ_CONCURRENCY").pipe(Config.withDefault(16))
// Cap how many missing sub-ranges fan out to the warehouse per cache miss. A
// single cold dashboard request only ever splits into a few ranges, but
// "unbounded" let a burst of concurrent misses multiply into a warehouse
// stampede (the mechanism behind the eval-bucket-cache regression). Bound it.
const fillConcurrencyConfig = Config.number("QE_BUCKET_CACHE_FILL_CONCURRENCY").pipe(Config.withDefault(4))

export class BucketCacheService extends Context.Service<BucketCacheService, BucketCacheServiceShape>()(
	"@maple/api/lib/BucketCacheService",
	{
		make: Effect.gen(function* () {
			const edgeCache = yield* EdgeCacheService
			const enabled = yield* enabledConfig
			const ttlSeconds = yield* ttlSecondsConfig
			const fluxSeconds = yield* fluxSecondsConfig
			const configuredFillConcurrency = yield* fillConcurrencyConfig
			const configuredSegmentBucketCount = yield* segmentBucketsConfig
			const configuredReadConcurrency = yield* readConcurrencyConfig
			const fillConcurrency = Math.max(1, Math.floor(configuredFillConcurrency))
			const segmentBucketCount = Math.max(1, Math.floor(configuredSegmentBucketCount))
			const readConcurrency = Math.max(1, Math.floor(configuredReadConcurrency))
			const inFlight = new Map<string, DeferredAwaiter<any>>()

			const getOrComputeBuckets = Effect.fn("BucketCacheService.getOrComputeBuckets")(function* <E, R>(
				request: BucketCacheRequest,
				computeRange: (range: TimeRange) => Effect.Effect<ReadonlyArray<TimeseriesPoint>, E, R>,
			) {
				const bucketMs = request.bucketSeconds * 1000
				const segmentMs = bucketMs * segmentBucketCount
				const fluxBoundaryMs = (yield* Clock.currentTimeMillis) - fluxSeconds * 1000
				const fingerprint = yield* Effect.promise(() =>
					generateFingerprint(request.orgId, request.query, request.bucketSeconds),
				)
				const composite = `${fingerprint}|${request.startMs}-${request.endMs}`

				yield* Effect.annotateCurrentSpan({
					"cache.fingerprint": fingerprint.slice(0, 12),
					"cache.bucketSeconds": request.bucketSeconds,
					"cache.rangeMs": request.endMs - request.startMs,
					orgId: request.orgId,
				})

				const existingAwaiter = inFlight.get(composite)
				if (existingAwaiter) {
					yield* Effect.annotateCurrentSpan("cache.dedup.waited", true)
					return (yield* existingAwaiter.await) as BucketCacheOutcome
				}

				const deferred = yield* Deferred.make<BucketCacheOutcome, E>()
				const awaiter = { await: Deferred.await(deferred) } satisfies DeferredAwaiter<E>
				inFlight.set(composite, awaiter)

				const readOrCompute = Effect.gen(function* () {
					const requestedStarts = requestedBucketStarts(request.startMs, request.endMs, bucketMs)
					const requestedSet = new Set(requestedStarts)
					const segmentStarts = segmentStartsForRange(request.startMs, request.endMs, segmentMs)
					type SegmentRead = {
						readonly segmentStartMs: number
						readonly status: "hit" | "miss" | "timeout" | "error"
						readonly buckets: ReadonlyArray<CachedBucket>
					}

					const segmentReads = yield* Effect.forEach(
						segmentStarts,
						(segmentStartMs): Effect.Effect<SegmentRead> => {
							const key = `v${CACHE_VERSION}:${request.orgId}:${fingerprint}:${segmentStartMs}`
							return edgeCache.rawGetDetailed<unknown>(BUCKET_CACHE_NAMESPACE, key).pipe(
								Effect.map((read): SegmentRead => {
									if (read.status !== "hit" || Option.isNone(read.value)) {
										return {
											segmentStartMs,
											status: read.status,
											buckets: EMPTY_BUCKETS,
										}
									}
									const data = read.value.value
									const valid = isBucketCacheSegmentData(data, {
										fingerprint,
										bucketSeconds: request.bucketSeconds,
										bucketMs,
										segmentStartMs,
										segmentEndMs: segmentStartMs + segmentMs,
									})
									return valid
										? { segmentStartMs, status: "hit", buckets: data.buckets }
										: { segmentStartMs, status: "miss", buckets: EMPTY_BUCKETS }
								}),
								Effect.catch((error) =>
									Effect.logWarning("Bucket cache segment read failed").pipe(
										Effect.annotateLogs({
											fingerprint: fingerprint.slice(0, 12),
											orgId: request.orgId,
											segmentStartMs,
											error: error.cause,
										}),
										Effect.as({
											segmentStartMs,
											status: "error",
											buckets: EMPTY_BUCKETS,
										} as const),
									),
								),
							)
						},
						{ concurrency: readConcurrency },
					)

					const existingBySegment = new Map<number, ReadonlyArray<CachedBucket>>()
					const readStatusBySegment = new Map<number, SegmentRead["status"]>()
					const existingBuckets: CachedBucket[] = []
					for (const read of segmentReads) {
						existingBySegment.set(read.segmentStartMs, read.buckets)
						readStatusBySegment.set(read.segmentStartMs, read.status)
						existingBuckets.push(...read.buckets)
					}
					existingBuckets.sort((a, b) => a.startMs - b.startMs)

					const cachedRequestedStarts = new Set(
						existingBuckets
							.filter((cachedBucket) => requestedSet.has(cachedBucket.startMs))
							.map((cachedBucket) => cachedBucket.startMs),
					)
					const bucketsHit = cachedRequestedStarts.size
					const bucketsMissed = Math.max(0, requestedStarts.length - bucketsHit)
					const missing = findMissingRanges(
						existingBuckets,
						request.startMs,
						request.endMs,
						bucketMs,
						fluxBoundaryMs,
					)
					const freshByRange = yield* Effect.forEach(missing, (item) => computeRange(item.range), {
						concurrency: fillConcurrency,
					})
					const rangeResults = missing.map((item, index) => ({
						item,
						points: freshByRange[index]!,
					}))
					const freshCachableBuckets = rangeResults.flatMap(({ item, points }) =>
						item.cachable
							? pointsToCoveredBuckets(points, item.range, bucketMs, fluxBoundaryMs)
							: EMPTY_BUCKETS,
					)
					const freshBySegment = new Map<number, CachedBucket[]>()
					for (const cachedBucket of freshCachableBuckets) {
						const segmentStartMs = Math.floor(cachedBucket.startMs / segmentMs) * segmentMs
						const grouped = freshBySegment.get(segmentStartMs)
						if (grouped) grouped.push(cachedBucket)
						else freshBySegment.set(segmentStartMs, [cachedBucket])
					}

					yield* Effect.forEach(
						[...freshBySegment.entries()],
						([segmentStartMs, freshBuckets]) => {
							const readStatus = readStatusBySegment.get(segmentStartMs) ?? "miss"
							if (readStatus === "timeout" || readStatus === "error") return Effect.void
							const merged = mergeAndDeduplicateBuckets(
								existingBySegment.get(segmentStartMs) ?? EMPTY_BUCKETS,
								freshBuckets,
							)
							const key = `v${CACHE_VERSION}:${request.orgId}:${fingerprint}:${segmentStartMs}`
							const payload: BucketCacheSegmentData = {
								version: CACHE_VERSION,
								fingerprint,
								bucketSeconds: request.bucketSeconds,
								segmentStartMs,
								segmentEndMs: segmentStartMs + segmentMs,
								buckets: merged,
							}
							return edgeCache.rawPut(BUCKET_CACHE_NAMESPACE, key, payload, ttlSeconds).pipe(
								Effect.tapError((error) =>
									Effect.logWarning("Bucket cache segment write failed").pipe(
										Effect.annotateLogs({
											fingerprint: fingerprint.slice(0, 12),
											orgId: request.orgId,
											segmentStartMs,
											bucketCount: merged.length,
											error: error.cause,
										}),
									),
								),
								Effect.ignore,
							)
						},
						{ concurrency: readConcurrency, discard: true },
					)

					const pointsByBucket = new Map<string, TimeseriesPoint>()
					for (const cachedPoint of slicePointsFromBuckets(
						existingBuckets,
						request.startMs,
						request.endMs,
					)) {
						pointsByBucket.set(cachedPoint.bucket, cachedPoint)
					}
					for (const { points } of rangeResults) {
						for (const freshPoint of points) {
							const pointMs = parseWarehouseDateTime(freshPoint.bucket)
							if (
								!Number.isNaN(pointMs) &&
								pointMs >= request.startMs &&
								pointMs < request.endMs
							) {
								pointsByBucket.set(freshPoint.bucket, freshPoint)
							}
						}
					}
					const points = [...pointsByBucket.values()].sort((a, b) =>
						a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0,
					)
					const countStatus = (status: SegmentRead["status"]) =>
						segmentReads.filter((read) => read.status === status).length
					const outcome = {
						points,
						requestedBuckets: requestedStarts.length,
						bucketsHit,
						bucketsMissed,
						missingRangeCount: missing.length,
						warehouseQueryCount: missing.length,
						segmentsHit: countStatus("hit"),
						segmentsMissed: countStatus("miss"),
						segmentsTimedOut: countStatus("timeout"),
						segmentsErrored: countStatus("error"),
					} satisfies BucketCacheOutcome
					const coverageRatio =
						outcome.requestedBuckets === 0 ? 1 : outcome.bucketsHit / outcome.requestedBuckets
					yield* Effect.annotateCurrentSpan({
						"cache.requestedBuckets": outcome.requestedBuckets,
						"cache.bucketsHit": outcome.bucketsHit,
						"cache.bucketsMissed": outcome.bucketsMissed,
						"cache.coverage_ratio": coverageRatio,
						"cache.missingRangeCount": outcome.missingRangeCount,
						"cache.warehouse_query_count": outcome.warehouseQueryCount,
						"cache.warehouse_avoided": outcome.warehouseQueryCount === 0,
						"cache.segments_hit": outcome.segmentsHit,
						"cache.segments_missed": outcome.segmentsMissed,
						"cache.segments_timed_out": outcome.segmentsTimedOut,
						"cache.segments_errored": outcome.segmentsErrored,
					})
					return outcome
				}).pipe(
					Effect.withSpan("BucketCacheService.readOrCompute", {
						attributes: { "cache.segmentBucketCount": segmentBucketCount },
					}),
				)

				const outcome = yield* readOrCompute.pipe(
					Effect.tap((value) => Deferred.succeed(deferred, value)),
					Effect.tapError((error) => Deferred.fail(deferred, error)),
					Effect.onInterrupt(() => Deferred.interrupt(deferred)),
					Effect.ensuring(
						Effect.sync(() => {
							if (inFlight.get(composite) === awaiter) inFlight.delete(composite)
						}),
					),
				)
				return outcome
			})

			return { enabled, getOrComputeBuckets } satisfies BucketCacheServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
