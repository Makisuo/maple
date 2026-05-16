import type { OrgId } from "@maple/domain"
import type { TimeseriesPoint } from "@maple/query-engine"
import { Array as Arr, Clock, Config, Context, Deferred, Effect, Layer, Option } from "effect"
import { EdgeCacheService } from "./EdgeCacheService"

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

export interface MissingRange {
	readonly range: TimeRange
	/** If false, results for this range must not be written back to cache. */
	readonly cachable: boolean
}

export interface BucketCacheOutcome {
	readonly points: ReadonlyArray<TimeseriesPoint>
	readonly bucketsHit: number
	readonly bucketsMissed: number
	readonly missingRangeCount: number
}

export interface BucketCacheRequest {
	readonly orgId: OrgId
	readonly query: unknown
	readonly bucketSeconds: number
	readonly startMs: number
	readonly endMs: number
}

const BUCKET_CACHE_NAMESPACE = "qe-ts-buckets"
const CACHE_VERSION = 1 as const
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
		const ms = new Date(point.bucket).getTime()
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
			const ms = new Date(point.bucket).getTime()
			if (Number.isNaN(ms)) continue
			if (ms >= startMs && ms < endMs) {
				out.push(point)
			}
		}
	}
	return out
}

// --- Service -------------------------------------------------------------

interface DeferredAwaiter {
	readonly await: Effect.Effect<BucketCacheOutcome, unknown>
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

export class BucketCacheService extends Context.Service<BucketCacheService, BucketCacheServiceShape>()(
	"BucketCacheService",
	{
		make: Effect.gen(function* () {
			const edgeCache = yield* EdgeCacheService
			const enabled = yield* enabledConfig
			const ttlSeconds = yield* ttlSecondsConfig
			const fluxSeconds = yield* fluxSecondsConfig

			// Heterogeneous in-flight map. Each entry stores a pre-typed awaiter so
			// callers never need to cast Deferred<any, any>. The error channel is
			// `unknown` here; callers re-narrow it when awaiting.
			const inFlight = new Map<string, DeferredAwaiter>()

			const fingerprintRange = (ranges: ReadonlyArray<TimeRange>): string => {
				const sorted = [...ranges].sort((a, b) =>
					a.startMs === b.startMs ? a.endMs - b.endMs : a.startMs - b.startMs,
				)
				return sorted.map((r) => `${r.startMs}-${r.endMs}`).join(",")
			}

			const getOrComputeBuckets = <E, R>(
				request: BucketCacheRequest,
				computeRange: (range: TimeRange) => Effect.Effect<ReadonlyArray<TimeseriesPoint>, E, R>,
			): Effect.Effect<BucketCacheOutcome, E, R> =>
				Effect.gen(function* () {
					const bucketMs = request.bucketSeconds * 1000
					const now = yield* Clock.currentTimeMillis
					const fluxBoundaryMs = now - fluxSeconds * 1000

					const fingerprint = yield* Effect.promise(() =>
						generateFingerprint(request.orgId, request.query, request.bucketSeconds),
					)
					const cacheKey = `v${CACHE_VERSION}:${request.orgId}:${fingerprint}`

					yield* Effect.annotateCurrentSpan("cache.fingerprint", fingerprint.slice(0, 12))

					// Cache read is best-effort: a read failure is logged and treated as
					// a miss rather than failing the user's query.
					const cached = yield* edgeCache
						.rawGet<BucketedCacheData>(BUCKET_CACHE_NAMESPACE, cacheKey)
						.pipe(
							Effect.tapError((error) =>
								Effect.logWarning("Bucket cache read failed").pipe(
									Effect.annotateLogs({
										fingerprint: fingerprint.slice(0, 12),
										orgId: request.orgId,
										error: error.cause,
									}),
								),
							),
							Effect.orElseSucceed(() => Option.none<BucketedCacheData>()),
						)

					const existingBuckets = Option.match(cached, {
						onNone: () => EMPTY_BUCKETS,
						onSome: (data) =>
							data.version === CACHE_VERSION && data.bucketSeconds === request.bucketSeconds
								? data.buckets
								: EMPTY_BUCKETS,
					})

					const missing = findMissingRanges(
						existingBuckets,
						request.startMs,
						request.endMs,
						bucketMs,
						fluxBoundaryMs,
					)

					yield* Effect.log(
						`[bucket-cache] fp=${fingerprint.slice(0, 8)} bucketSeconds=${request.bucketSeconds} cachedBuckets=${existingBuckets.length} missing=${missing.length}`,
					)

					if (missing.length === 0) {
						return {
							points: slicePointsFromBuckets(existingBuckets, request.startMs, request.endMs),
							bucketsHit: existingBuckets.length,
							bucketsMissed: 0,
							missingRangeCount: 0,
						}
					}

					// In-flight dedup keyed by fingerprint + the set of missing ranges.
					const composite = `${fingerprint}|${fingerprintRange(missing.map((m) => m.range))}`
					const existingAwaiter = inFlight.get(composite)
					if (existingAwaiter) {
						yield* Effect.annotateCurrentSpan("cache.dedup.waited", true)
						return yield* existingAwaiter.await as Effect.Effect<BucketCacheOutcome, E>
					}

					const deferred = yield* Deferred.make<BucketCacheOutcome, E>()
					inFlight.set(composite, {
						await: Deferred.await(deferred) as Effect.Effect<BucketCacheOutcome, unknown>,
					})

					const fillMissingRanges = Effect.gen(function* () {
						const freshByRange = yield* Effect.forEach(missing, (m) => computeRange(m.range), {
							concurrency: "unbounded",
						})

						const rangeResults = Arr.zip(missing, freshByRange)

						const freshCachableBuckets = Arr.flatMap(rangeResults, ([m, rangePoints]) =>
							m.cachable
								? Array.from(pointsToBuckets(rangePoints, bucketMs, fluxBoundaryMs))
								: [],
						)

						const merged = mergeAndDeduplicateBuckets(existingBuckets, freshCachableBuckets)

						if (freshCachableBuckets.length > 0) {
							const payload: BucketedCacheData = {
								version: CACHE_VERSION,
								fingerprint,
								bucketSeconds: request.bucketSeconds,
								buckets: merged,
							}
							// Cache write is best-effort: a write failure is logged but does
							// not fail the user's query.
							yield* edgeCache
								.rawPut(BUCKET_CACHE_NAMESPACE, cacheKey, payload, ttlSeconds)
								.pipe(
									Effect.tapError((error) =>
										Effect.logWarning("Bucket cache write failed").pipe(
											Effect.annotateLogs({
												fingerprint: fingerprint.slice(0, 12),
												orgId: request.orgId,
												bucketCount: merged.length,
												error: error.cause,
											}),
										),
									),
									Effect.ignore,
								)
						}

						const liveTailPoints = Arr.flatMap(rangeResults, ([m, rangePoints]) =>
							m.cachable
								? []
								: rangePoints.filter((point) => {
										const ms = new Date(point.bucket).getTime()
										return (
											!Number.isNaN(ms) && ms >= request.startMs && ms < request.endMs
										)
									}),
						)

						const freshCachedPoints = slicePointsFromBuckets(
							merged,
							request.startMs,
							request.endMs,
						)

						const seen = new Set<string>()
						const combined: TimeseriesPoint[] = []
						for (const point of freshCachedPoints) {
							if (seen.has(point.bucket)) continue
							seen.add(point.bucket)
							combined.push(point)
						}
						for (const point of liveTailPoints) {
							if (seen.has(point.bucket)) continue
							seen.add(point.bucket)
							combined.push(point)
						}
						combined.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))

						return {
							points: combined,
							bucketsHit: existingBuckets.length,
							bucketsMissed: freshCachableBuckets.length,
							missingRangeCount: missing.length,
						} satisfies BucketCacheOutcome
					}).pipe(
						Effect.withSpan("BucketCacheService.fillMissingRanges", {
							attributes: {
								"cache.missingRangeCount": missing.length,
								"cache.existingBucketCount": existingBuckets.length,
							},
						}),
					)

					const outcome = yield* fillMissingRanges.pipe(
						Effect.tap((value) => Deferred.succeed(deferred, value)),
						Effect.tapError((error) => Deferred.fail(deferred, error)),
						Effect.onInterrupt(() => Deferred.interrupt(deferred)),
						Effect.ensuring(
							Effect.sync(() => {
								inFlight.delete(composite)
							}),
						),
					)
					return outcome
				}).pipe(
					Effect.withSpan("BucketCacheService.getOrComputeBuckets", {
						attributes: {
							orgId: request.orgId,
							"cache.bucketSeconds": request.bucketSeconds,
							"cache.rangeMs": request.endMs - request.startMs,
						},
					}),
				)

			return {
				enabled,
				getOrComputeBuckets,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
