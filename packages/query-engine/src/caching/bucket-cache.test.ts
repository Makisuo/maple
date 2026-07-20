import { assert, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain"
import type { TimeseriesPoint } from "../query-engine"
import {
	BucketCacheService,
	findMissingRanges,
	generateFingerprint,
	mergeAndDeduplicateBuckets,
	pointsToBuckets,
	type BucketCacheSegmentData,
	type CachedBucket,
} from "./bucket-cache"
import { EdgeCacheService, makeEdgeCacheService, type EdgeCacheBackend } from "./edge-cache"
import { MemoryCacheBackendLive } from "./cache-backend"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const orgId = asOrgId("org_test")

const FAR_FUTURE_FLUX = Number.MAX_SAFE_INTEGER
const MIN = 60_000

const bucket = (startMs: number, endMs: number, points: TimeseriesPoint[] = []): CachedBucket => ({
	startMs,
	endMs,
	points,
})

const point = (iso: string, series: Record<string, number> = {}): TimeseriesPoint => ({
	bucket: iso,
	series,
})

describe("findMissingRanges", () => {
	it("returns the entire range when cache is empty", () => {
		const missing = findMissingRanges([], 0, 10 * MIN, MIN, FAR_FUTURE_FLUX)
		expect(missing).toEqual([{ range: { startMs: 0, endMs: 10 * MIN }, cachable: true }])
	})

	it("returns nothing when cached buckets fully cover the range", () => {
		const buckets = [bucket(0, MIN), bucket(MIN, 2 * MIN), bucket(2 * MIN, 3 * MIN)]
		expect(findMissingRanges(buckets, 0, 3 * MIN, MIN, FAR_FUTURE_FLUX)).toEqual([])
	})

	it("emits head + tail gaps when middle is cached", () => {
		const buckets = [bucket(2 * MIN, 3 * MIN), bucket(3 * MIN, 4 * MIN)]
		const missing = findMissingRanges(buckets, 0, 6 * MIN, MIN, FAR_FUTURE_FLUX)
		expect(missing).toEqual([
			{ range: { startMs: 0, endMs: 2 * MIN }, cachable: true },
			{ range: { startMs: 4 * MIN, endMs: 6 * MIN }, cachable: true },
		])
	})

	it("emits a partial head when start is not step-aligned", () => {
		const missing = findMissingRanges([], 30_000, 2 * MIN, MIN, FAR_FUTURE_FLUX)
		expect(missing).toEqual([
			{ range: { startMs: 30_000, endMs: MIN }, cachable: true },
			{ range: { startMs: MIN, endMs: 2 * MIN }, cachable: true },
		])
	})

	it("splits the tail across the flux boundary", () => {
		// bucketed cache knows [0, 2m); request [0, 4m); flux boundary at 3m.
		const buckets = [bucket(0, MIN), bucket(MIN, 2 * MIN)]
		const flux = 3 * MIN
		const missing = findMissingRanges(buckets, 0, 4 * MIN, MIN, flux)
		expect(missing).toEqual([
			{ range: { startMs: 2 * MIN, endMs: 3 * MIN }, cachable: true },
			{ range: { startMs: 3 * MIN, endMs: 4 * MIN }, cachable: false },
		])
	})

	it("marks the whole range non-cachable when it sits past the flux boundary", () => {
		const missing = findMissingRanges([], 10 * MIN, 12 * MIN, MIN, 5 * MIN)
		expect(missing).toEqual([{ range: { startMs: 10 * MIN, endMs: 12 * MIN }, cachable: false }])
	})

	it("handles unaligned end inside a gap", () => {
		const missing = findMissingRanges([], 0, MIN + 15_000, MIN, FAR_FUTURE_FLUX)
		expect(missing).toEqual([{ range: { startMs: 0, endMs: MIN + 15_000 }, cachable: true }])
	})
})

describe("pointsToBuckets", () => {
	it("groups points by bucket window and drops live (post-flux) buckets", () => {
		const bucketMs = MIN
		// Flux at 3m: bucket [0,1m) cachable, [3m,4m) crosses flux → dropped.
		const flux = 3 * MIN
		const points: TimeseriesPoint[] = [
			point("1970-01-01T00:00:00.000Z", { v: 1 }),
			point("1970-01-01T00:01:00.000Z", { v: 2 }),
			point("1970-01-01T00:03:00.000Z", { v: 4 }),
		]
		const buckets = pointsToBuckets(points, bucketMs, flux)
		expect(buckets.map((b) => b.startMs)).toEqual([0, MIN])
		expect(buckets[0]!.points).toHaveLength(1)
		expect(buckets[1]!.points).toHaveLength(1)
	})

	it("skips points with an unparseable bucket timestamp", () => {
		const points: TimeseriesPoint[] = [
			point("not-a-date", { v: 1 }),
			point("1970-01-01T00:00:00.000Z", { v: 2 }),
		]
		const buckets = pointsToBuckets(points, MIN, FAR_FUTURE_FLUX)
		expect(buckets).toHaveLength(1)
		expect(buckets[0]!.points).toHaveLength(1)
	})
})

describe("mergeAndDeduplicateBuckets", () => {
	it("keeps existing buckets when no overlap with fresh", () => {
		const existing = [bucket(0, MIN, [point("1970-01-01T00:00:00.000Z")])]
		const fresh = [bucket(MIN, 2 * MIN, [point("1970-01-01T00:01:00.000Z")])]
		const merged = mergeAndDeduplicateBuckets(existing, fresh)
		expect(merged.map((b) => b.startMs)).toEqual([0, MIN])
	})

	it("prefers fresh bucket when startMs collides", () => {
		const existing = [bucket(0, MIN, [point("1970-01-01T00:00:00.000Z", { stale: 1 })])]
		const fresh = [bucket(0, MIN, [point("1970-01-01T00:00:00.000Z", { fresh: 2 })])]
		const merged = mergeAndDeduplicateBuckets(existing, fresh)
		expect(merged).toHaveLength(1)
		expect(merged[0]!.points[0]!.series).toEqual({ fresh: 2 })
	})
})

describe("generateFingerprint", () => {
	it("is stable regardless of object key order", async () => {
		const a = await generateFingerprint("org", { b: 1, a: 2, nested: { y: 1, x: 2 } }, 60)
		const b = await generateFingerprint("org", { a: 2, b: 1, nested: { x: 2, y: 1 } }, 60)
		expect(a).toBe(b)
	})

	it("changes when bucketSeconds changes", async () => {
		const query = { source: "traces", kind: "timeseries" }
		const a = await generateFingerprint("org", query, 60)
		const b = await generateFingerprint("org", query, 300)
		expect(a).not.toBe(b)
	})

	it("changes when orgId changes", async () => {
		const query = { source: "traces", kind: "timeseries" }
		const a = await generateFingerprint("org-1", query, 60)
		const b = await generateFingerprint("org-2", query, 60)
		expect(a).not.toBe(b)
	})
})

// --- Service-level integration: in-memory EdgeCache backing. ---

const makeConfig = (overrides: Record<string, string> = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			QE_BUCKET_CACHE_ENABLED: "true",
			QE_BUCKET_CACHE_TTL_SECONDS: "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: "0",
			...overrides,
		}),
	)

const BucketLive = BucketCacheService.layer.pipe(
	Layer.provideMerge(EdgeCacheService.layer),
	Layer.provide(MemoryCacheBackendLive),
)

const makeBucketLive = (backend: EdgeCacheBackend, readTimeoutMs?: number) =>
	BucketCacheService.layer.pipe(
		Layer.provide(Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend, readTimeoutMs))),
	)

// These exercise the live cache backend and compute flux boundaries relative to
// the real clock, so they run under it.live rather than the default TestClock.
describe("BucketCacheService.getOrComputeBuckets", () => {
	it.live("fetches the whole range on a cold start, then serves the same range from cache", () => {
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		const computeCalls: Array<{ startMs: number; endMs: number }> = []

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
				computeCalls.push({ startMs, endMs })
				return Effect.succeed([
					point(new Date(startMs).toISOString(), { v: 1 }),
					point(new Date(startMs + MIN).toISOString(), { v: 2 }),
					point(new Date(startMs + 2 * MIN).toISOString(), { v: 3 }),
				] satisfies TimeseriesPoint[])
			}
			const first = yield* svc.getOrComputeBuckets(request, compute)
			const second = yield* svc.getOrComputeBuckets(request, compute)

			assert.strictEqual(computeCalls.length, 1)
			assert.deepStrictEqual(computeCalls[0], { startMs: 0, endMs: 3 * MIN })
			assert.isTrue(first.bucketsMissed > 0)
			assert.strictEqual(first.requestedBuckets, 3)
			assert.strictEqual(first.warehouseQueryCount, 1)
			assert.strictEqual(first.points.length, 3)

			assert.strictEqual(second.bucketsHit, 3)
			assert.strictEqual(second.bucketsMissed, 0)
			assert.strictEqual(second.missingRangeCount, 0)
			assert.strictEqual(second.warehouseQueryCount, 0)
			assert.strictEqual(second.points.length, 3)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("refetches only the tail slice when the window shifts forward", () => {
		const startOriginal = 0
		const endOriginal = 3 * MIN

		const computeCalls: Array<{ startMs: number; endMs: number }> = []

		const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
			computeCalls.push({ startMs, endMs })
			const out: TimeseriesPoint[] = []
			for (let t = startMs; t < endMs; t += MIN) {
				out.push(point(new Date(t).toISOString(), { v: t }))
			}
			return Effect.succeed(out)
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const base = {
				orgId,
				query: { source: "traces", kind: "timeseries" },
				bucketSeconds: 60,
			}
			yield* svc.getOrComputeBuckets({ ...base, startMs: startOriginal, endMs: endOriginal }, compute)
			const second = yield* svc.getOrComputeBuckets(
				{ ...base, startMs: startOriginal + MIN, endMs: endOriginal + MIN },
				compute,
			)

			assert.strictEqual(computeCalls.length, 2)
			assert.deepStrictEqual(computeCalls[1], { startMs: 3 * MIN, endMs: 4 * MIN })
			assert.strictEqual(second.missingRangeCount, 1)
			assert.strictEqual(second.points.length, 3)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("propagates errors from compute and does not poison the cache", () => {
		const base = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		const okPoints: TimeseriesPoint[] = [
			point(new Date(0).toISOString(), { v: 1 }),
			point(new Date(MIN).toISOString(), { v: 2 }),
			point(new Date(2 * MIN).toISOString(), { v: 3 }),
		]

		let computeAttempt = 0
		const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
			computeAttempt++
			if (computeAttempt === 1) {
				return Effect.fail(new Error("tinybird down") as unknown as never)
			}
			void startMs
			void endMs
			return Effect.succeed(okPoints)
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const failExit = yield* Effect.exit(svc.getOrComputeBuckets(base, compute))
			const ok = yield* svc.getOrComputeBuckets(base, compute)

			assert.isTrue(Exit.isFailure(failExit))
			assert.strictEqual(computeAttempt, 2) // first failed, second recomputed (no poison)
			assert.strictEqual(ok.points.length, 3)
			assert.isTrue(ok.bucketsMissed > 0)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("bypasses cache on a bucketSeconds mismatch (different fingerprint)", () => {
		const base = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			startMs: 0,
			endMs: 3 * MIN,
		}

		const computeCalls: Array<{ startMs: number; endMs: number; bucketSeconds: number }> = []
		const makeCompute =
			(bucketSeconds: number) =>
			({ startMs, endMs }: { startMs: number; endMs: number }) => {
				computeCalls.push({ startMs, endMs, bucketSeconds })
				const out: TimeseriesPoint[] = []
				for (let t = startMs; t < endMs; t += bucketSeconds * 1000) {
					out.push(point(new Date(t).toISOString(), { v: t }))
				}
				return Effect.succeed(out)
			}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			yield* svc.getOrComputeBuckets({ ...base, bucketSeconds: 60 }, makeCompute(60))
			// Same range, different step → different fingerprint → full recompute.
			const second = yield* svc.getOrComputeBuckets({ ...base, bucketSeconds: 180 }, makeCompute(180))

			assert.strictEqual(computeCalls.length, 2)
			assert.strictEqual(computeCalls[0]!.bucketSeconds, 60)
			assert.strictEqual(computeCalls[1]!.bucketSeconds, 180)
			assert.isTrue(second.bucketsMissed > 0)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("treats a version-skewed cache payload as a miss", () => {
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		const okPoints: TimeseriesPoint[] = [
			point(new Date(0).toISOString(), { v: 1 }),
			point(new Date(MIN).toISOString(), { v: 2 }),
			point(new Date(2 * MIN).toISOString(), { v: 3 }),
		]

		let computed = 0
		const compute = () => {
			computed++
			return Effect.succeed(okPoints)
		}

		return Effect.gen(function* () {
			const edge = yield* EdgeCacheService
			const svc = yield* BucketCacheService

			// Pre-seed a payload with a future version that should be ignored.
			const fingerprint = yield* Effect.promise(() =>
				generateFingerprint(request.orgId, request.query, request.bucketSeconds),
			)
			const cacheKey = `v2:${request.orgId}:${fingerprint}:0`
			// Cast through `unknown` because we're intentionally writing a
			// non-current version to simulate a post-migration read.
			const future = {
				version: 99,
				fingerprint,
				bucketSeconds: 60,
				segmentStartMs: 0,
				segmentEndMs: 120 * MIN,
				buckets: [],
			} as unknown as BucketCacheSegmentData
			yield* edge.rawPut("qe-ts-buckets", cacheKey, future, 60)

			const outcome = yield* svc.getOrComputeBuckets(request, compute)

			assert.strictEqual(computed, 1)
			assert.isTrue(outcome.bucketsMissed > 0)
			assert.strictEqual(outcome.points.length, 3)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("treats a malformed segment payload as a miss instead of defecting", () => {
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries", malformedTest: true },
			bucketSeconds: 60,
			startMs: 0,
			endMs: MIN,
		}
		let computed = 0

		return Effect.gen(function* () {
			const edge = yield* EdgeCacheService
			const svc = yield* BucketCacheService
			const fingerprint = yield* Effect.promise(() =>
				generateFingerprint(request.orgId, request.query, request.bucketSeconds),
			)
			yield* edge.rawPut("qe-ts-buckets", `v2:${request.orgId}:${fingerprint}:0`, "corrupt", 60)

			const outcome = yield* svc.getOrComputeBuckets(request, () => {
				computed++
				return Effect.succeed([point(new Date(0).toISOString(), { v: 1 })])
			})

			assert.strictEqual(computed, 1)
			assert.strictEqual(outcome.segmentsMissed, 1)
			assert.strictEqual(outcome.points.length, 1)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	it.live("stores bounded fixed-size segments instead of one growing query blob", () => {
		const reads: string[] = []
		const writes: Array<{ key: string; value: unknown }> = []
		const backend: EdgeCacheBackend = {
			get: async (_bucket, key) => {
				reads.push(key)
				return undefined
			},
			put: async (_bucket, key, value) => {
				writes.push({ key, value })
			},
			delete: async () => {},
		}
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 5 * MIN,
		}
		const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
			const points: TimeseriesPoint[] = []
			for (let cursor = startMs; cursor < endMs; cursor += MIN) {
				points.push(point(new Date(cursor).toISOString(), { v: cursor }))
			}
			return Effect.succeed(points)
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const outcome = yield* svc.getOrComputeBuckets(request, compute)

			assert.strictEqual(reads.length, 3)
			assert.strictEqual(writes.length, 3)
			assert.strictEqual(outcome.segmentsMissed, 3)
			for (const write of writes) {
				const segment = write.value as BucketCacheSegmentData
				assert.isAtMost(segment.buckets.length, 2)
				assert.strictEqual(segment.segmentEndMs - segment.segmentStartMs, 2 * MIN)
			}
		}).pipe(
			Effect.provide(makeBucketLive(backend)),
			Effect.provide(makeConfig({ QE_BUCKET_CACHE_SEGMENT_BUCKETS: "2" })),
		)
	})

	it.live("recomputes after a segment timeout without overwriting unknown cache state", () => {
		let writes = 0
		let computes = 0
		const backend: EdgeCacheBackend = {
			get: async () => await new Promise<never>(() => {}),
			put: async () => {
				writes++
			},
			delete: async () => {},
		}
		const request = {
			orgId,
			query: { source: "logs", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 2 * MIN,
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const outcome = yield* svc.getOrComputeBuckets(request, () => {
				computes++
				return Effect.succeed([point(new Date(0).toISOString(), { v: 1 })])
			})

			assert.strictEqual(computes, 1)
			assert.strictEqual(writes, 0)
			assert.strictEqual(outcome.segmentsTimedOut, 1)
			assert.strictEqual(outcome.warehouseQueryCount, 1)
		}).pipe(
			Effect.provide(makeBucketLive(backend, 10)),
			Effect.provide(makeConfig()),
			Effect.timeout(200),
		)
	})

	it.live("caches explicit empty-bucket coverage for sparse query results", () => {
		let computes = 0
		const request = {
			orgId,
			query: { source: "metrics", kind: "timeseries", filter: "no matches" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const compute = () => {
				computes++
				return Effect.succeed([] as ReadonlyArray<TimeseriesPoint>)
			}
			const first = yield* svc.getOrComputeBuckets(request, compute)
			const second = yield* svc.getOrComputeBuckets(request, compute)

			assert.strictEqual(computes, 1)
			assert.strictEqual(first.warehouseQueryCount, 1)
			assert.strictEqual(second.bucketsHit, 3)
			assert.strictEqual(second.warehouseQueryCount, 0)
			assert.deepStrictEqual(second.points, [])
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})

	// Uses a real wall-clock sleep to keep both fibers in-flight simultaneously,
	// so it runs under it.live rather than the default TestClock.
	it.live("dedupes concurrent identical requests through the in-flight map", () => {
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		let computeCalls = 0
		const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
			computeCalls++
			const out: TimeseriesPoint[] = []
			for (let t = startMs; t < endMs; t += MIN) {
				out.push(point(new Date(t).toISOString(), { v: t }))
			}
			return Effect.sleep("5 millis").pipe(Effect.as(out))
		}

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const [a, b] = yield* Effect.all(
				[svc.getOrComputeBuckets(request, compute), svc.getOrComputeBuckets(request, compute)],
				{ concurrency: "unbounded" },
			)

			assert.strictEqual(computeCalls, 1) // second caller dedup'd
			assert.strictEqual(a.points.length, 3)
			assert.strictEqual(b.points.length, 3)
		}).pipe(Effect.provide(BucketLive), Effect.provide(makeConfig()))
	})
})
