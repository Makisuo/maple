import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain"
import type { TimeseriesPoint } from "@maple/query-engine"
import {
	BucketCacheService,
	findMissingRanges,
	generateFingerprint,
	mergeAndDeduplicateBuckets,
	pointsToBuckets,
	type BucketedCacheData,
	type CachedBucket,
} from "./BucketCacheService"
import { EdgeCacheService } from "./EdgeCacheService"

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

const BucketLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheService.layer))

describe("BucketCacheService.getOrComputeBuckets", () => {
	it("fetches the whole range on a cold start, then serves the same range from cache", async () => {
		const request = {
			orgId,
			query: { source: "traces", kind: "timeseries" },
			bucketSeconds: 60,
			startMs: 0,
			endMs: 3 * MIN,
		}

		const computeCalls: Array<{ startMs: number; endMs: number }> = []

		const program = Effect.gen(function* () {
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
			return { first, second }
		})

		const { first, second } = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(computeCalls).toHaveLength(1)
		expect(computeCalls[0]).toEqual({ startMs: 0, endMs: 3 * MIN })
		expect(first.bucketsMissed).toBeGreaterThan(0)
		expect(first.points).toHaveLength(3)

		expect(second.bucketsMissed).toBe(0)
		expect(second.missingRangeCount).toBe(0)
		expect(second.points).toHaveLength(3)
	})

	it("refetches only the tail slice when the window shifts forward", async () => {
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

		const program = Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const base = {
				orgId,
				query: { source: "traces", kind: "timeseries" },
				bucketSeconds: 60,
			}
			yield* svc.getOrComputeBuckets({ ...base, startMs: startOriginal, endMs: endOriginal }, compute)
			return yield* svc.getOrComputeBuckets(
				{ ...base, startMs: startOriginal + MIN, endMs: endOriginal + MIN },
				compute,
			)
		})

		const second = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(computeCalls).toHaveLength(2)
		expect(computeCalls[1]).toEqual({ startMs: 3 * MIN, endMs: 4 * MIN })
		expect(second.missingRangeCount).toBe(1)
		expect(second.points).toHaveLength(3)
	})

	it("propagates errors from compute and does not poison the cache", async () => {
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

		const program = Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const failExit = yield* Effect.exit(svc.getOrComputeBuckets(base, compute))
			const ok = yield* svc.getOrComputeBuckets(base, compute)
			return { failExit, ok }
		})

		const { failExit, ok } = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(failExit._tag).toBe("Failure")
		expect(computeAttempt).toBe(2) // first failed, second recomputed (no poison)
		expect(ok.points).toHaveLength(3)
		expect(ok.bucketsMissed).toBeGreaterThan(0)
	})

	it("bypasses cache on a bucketSeconds mismatch (different fingerprint)", async () => {
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

		const program = Effect.gen(function* () {
			const svc = yield* BucketCacheService
			yield* svc.getOrComputeBuckets({ ...base, bucketSeconds: 60 }, makeCompute(60))
			// Same range, different step → different fingerprint → full recompute.
			return yield* svc.getOrComputeBuckets({ ...base, bucketSeconds: 180 }, makeCompute(180))
		})

		const second = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(computeCalls).toHaveLength(2)
		expect(computeCalls[0]!.bucketSeconds).toBe(60)
		expect(computeCalls[1]!.bucketSeconds).toBe(180)
		expect(second.bucketsMissed).toBeGreaterThan(0)
	})

	it("treats a version-skewed cache payload as a miss", async () => {
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

		const program = Effect.gen(function* () {
			const edge = yield* EdgeCacheService
			const svc = yield* BucketCacheService

			// Pre-seed a payload with a future version that should be ignored.
			const fingerprint = yield* Effect.promise(() =>
				generateFingerprint(request.orgId, request.query, request.bucketSeconds),
			)
			const cacheKey = `v1:${request.orgId}:${fingerprint}`
			// Cast through `unknown` because we're intentionally writing a
			// non-current version to simulate a post-migration read.
			const future = {
				version: 99,
				fingerprint,
				bucketSeconds: 60,
				buckets: [],
			} as unknown as BucketedCacheData
			yield* edge.rawPut("qe-ts-buckets", cacheKey, future, 60)

			return yield* svc.getOrComputeBuckets(request, compute)
		})

		const outcome = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(computed).toBe(1)
		expect(outcome.bucketsMissed).toBeGreaterThan(0)
		expect(outcome.points).toHaveLength(3)
	})

	it("dedupes concurrent identical requests through the in-flight map", async () => {
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

		const program = Effect.gen(function* () {
			const svc = yield* BucketCacheService
			return yield* Effect.all(
				[svc.getOrComputeBuckets(request, compute), svc.getOrComputeBuckets(request, compute)],
				{ concurrency: "unbounded" },
			)
		})

		const [a, b] = await Effect.runPromise(
			program.pipe(Effect.provide(BucketLive), Effect.provide(makeConfig())),
		)

		expect(computeCalls).toBe(1) // second caller dedup'd
		expect(a.points).toHaveLength(3)
		expect(b.points).toHaveLength(3)
	})
})
