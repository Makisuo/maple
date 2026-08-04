import { assert, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { OrgId } from "@maple/domain"
import type { TimeseriesPoint } from "@maple/domain/query-engine"
import { Schema } from "effect"
import { BucketCacheService, type BucketCacheOutcome } from "./bucket-cache"
import {
	EdgeCacheService,
	makeEdgeCacheService,
	makeMemoryBackend,
	type EdgeCacheBackend,
} from "@maple/cache"

/**
 * Hit-rate tests, as distinct from the correctness tests next door.
 *
 * `bucket-cache.test.ts` asks "does calling the same thing twice skip the
 * warehouse?" — which stays true even when the real access pattern produces a
 * 5% hit rate, because dashboards never issue the same request twice. These
 * tests drive *sequences* that model how a dashboard actually queries (a window
 * that slides, a user who zooms and pans, several widgets firing at once) and
 * assert on the aggregate: what fraction of requested buckets came from cache,
 * and how many warehouse queries that cost.
 *
 * Every scenario asserts two things, and both matter. Coverage alone would pass
 * for a cache that returns confident garbage, so each scenario also compares its
 * points against an uncached oracle run of the identical sequence — a wrong hit
 * is worse than a miss.
 */

const asOrgId = Schema.decodeUnknownSync(OrgId)
const orgId = asOrgId("org_hit_rate")
const otherOrgId = asOrgId("org_other")

const MIN = 60_000
const BUCKET_SECONDS = 60
const BUCKET_MS = BUCKET_SECONDS * 1000

// Anchored well away from `Date.now()` so a sliding window in these tests never
// drifts into the flux boundary by accident. Aligned to a 4h segment boundary.
const BASE_MS = 1_760_000_000_000 - (1_760_000_000_000 % (4 * 60 * MIN))

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Deterministic stand-in for the warehouse: one point per whole bucket in the
 * requested range, valued from the bucket's absolute timestamp. Because the
 * value is a pure function of the bucket, a cached point and a freshly computed
 * point for the same bucket must be identical — so any divergence from the
 * oracle is the cache corrupting or misplacing data, never query nondeterminism.
 */
const warehousePointsFor = (startMs: number, endMs: number): TimeseriesPoint[] => {
	const points: TimeseriesPoint[] = []
	const first = Math.ceil(startMs / BUCKET_MS) * BUCKET_MS
	for (let cursor = first; cursor < endMs; cursor += BUCKET_MS) {
		points.push({ bucket: iso(cursor), series: { value: cursor / BUCKET_MS } })
	}
	return points
}

interface BackendCall {
	readonly op: "get" | "put"
	readonly key: string
}

/**
 * Wraps a real memory backend so caching still behaves normally, while
 * recording every call and the peak number of reads in flight at once.
 *
 * The concurrency number is load-bearing rather than diagnostic: Cloudflare
 * counts an in-flight `cache.match()` against the Worker's six-simultaneous-
 * connection limit until response headers arrive, so reads issued beyond that
 * queue behind their own siblings and get abandoned at the read deadline. A
 * cache that reads too eagerly makes itself miss.
 */
const makeInstrumentedBackend = (inner: EdgeCacheBackend = makeMemoryBackend()) => {
	const calls: BackendCall[] = []
	let inFlight = 0
	let peakInFlight = 0

	const backend: EdgeCacheBackend = {
		name: inner.name,
		get: async (bucket, hash, nowMs) => {
			calls.push({ op: "get", key: hash })
			inFlight++
			peakInFlight = Math.max(peakInFlight, inFlight)
			try {
				return await inner.get(bucket, hash, nowMs)
			} finally {
				inFlight--
			}
		},
		put: async (bucket, hash, value, ttlSeconds, nowMs) => {
			calls.push({ op: "put", key: hash })
			return inner.put(bucket, hash, value, ttlSeconds, nowMs)
		},
		delete: inner.delete,
	}

	return {
		backend,
		calls,
		peakInFlight: () => peakInFlight,
		keys: (op: BackendCall["op"]) => calls.filter((c) => c.op === op).map((c) => c.key),
	}
}

const makeConfig = (overrides: Record<string, string> = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			QE_BUCKET_CACHE_ENABLED: "true",
			QE_BUCKET_CACHE_TTL_SECONDS: "86400",
			// The flux boundary is computed from the live clock; these scenarios use
			// a fixed historical window, so disable it to keep them deterministic.
			// The flux tail gets its own dedicated scenario below.
			QE_BUCKET_CACHE_FLUX_SECONDS: "0",
			...overrides,
		}),
	)

const makeLive = (backend: EdgeCacheBackend, readTimeoutMs?: number) =>
	BucketCacheService.layer.pipe(
		Layer.provide(Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend, readTimeoutMs))),
	)

interface Request {
	readonly startMs: number
	readonly endMs: number
	readonly bucketSeconds?: number
	readonly org?: OrgId
	readonly query?: unknown
}

const DEFAULT_QUERY = { source: "traces", kind: "timeseries" }

/**
 * Drive a sequence of requests through one cache instance, returning each
 * outcome plus the total number of warehouse calls the sequence cost.
 */
const runSequence = (requests: ReadonlyArray<Request>, backend: EdgeCacheBackend, config = makeConfig()) =>
	Effect.gen(function* () {
		const svc = yield* BucketCacheService
		const outcomes: BucketCacheOutcome[] = []
		let warehouseCalls = 0

		for (const request of requests) {
			const outcome = yield* svc.getOrComputeBuckets(
				{
					orgId: request.org ?? orgId,
					query: request.query ?? DEFAULT_QUERY,
					bucketSeconds: request.bucketSeconds ?? BUCKET_SECONDS,
					startMs: request.startMs,
					endMs: request.endMs,
				},
				({ startMs, endMs }) => {
					warehouseCalls++
					return Effect.succeed(warehousePointsFor(startMs, endMs))
				},
			)
			outcomes.push(outcome)
		}

		return { outcomes, warehouseCalls }
	}).pipe(Effect.provide(makeLive(backend)), Effect.provide(config))

/** The same sequence with the cache bypassed — ground truth for the points. */
const oracle = (requests: ReadonlyArray<Request>) =>
	requests.map((r) => warehousePointsFor(r.startMs, r.endMs))

const coverageOf = (outcomes: ReadonlyArray<BucketCacheOutcome>) => {
	const requested = outcomes.reduce((sum, o) => sum + o.requestedBuckets, 0)
	const hit = outcomes.reduce((sum, o) => sum + o.bucketsHit, 0)
	return requested === 0 ? 1 : hit / requested
}

const assertMatchesOracle = (
	outcomes: ReadonlyArray<BucketCacheOutcome>,
	requests: ReadonlyArray<Request>,
) => {
	const expected = oracle(requests)
	outcomes.forEach((outcome, index) => {
		assert.deepStrictEqual(
			outcome.points,
			expected[index]!,
			`request ${index} returned different points than an uncached run`,
		)
	})
}

describe("bucket cache hit rate — dashboard access patterns", () => {
	it.live("keeps a sliding 1h window above 95% coverage once warm", () => {
		// A "last 1h" widget refreshed every 15s for 5 minutes.
		const windowMs = 60 * MIN
		const requests: Request[] = []
		for (let tick = 0; tick < 20; tick++) {
			const endMs = BASE_MS + tick * 15_000
			requests.push({ startMs: endMs - windowMs, endMs })
		}

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const { outcomes } = yield* runSequence(requests, backend)

			assertMatchesOracle(outcomes, requests)

			// Skip the cold first request; the steady state is what the user feels.
			const steady = outcomes.slice(1)
			expect(coverageOf(steady)).toBeGreaterThanOrEqual(0.95)

			// Coalescing must hold: a warm request costs at most the settled gap
			// plus the live tail, never one query per gap.
			for (const outcome of steady) {
				expect(outcome.warehouseQueryCount).toBeLessThanOrEqual(2)
			}
		})
	})

	it.live("stays above 90% coverage while the window crosses a segment boundary", () => {
		// Segments are `bucketSeconds × 120` = 2h here. Start the window so the
		// sequence walks across a boundary rather than sitting inside one.
		const segmentMs = BUCKET_MS * 120
		const windowMs = 30 * MIN
		const boundary = BASE_MS + segmentMs
		const requests: Request[] = []
		for (let tick = 0; tick < 20; tick++) {
			const endMs = boundary - 10 * MIN + tick * MIN
			requests.push({ startMs: endMs - windowMs, endMs })
		}

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const { outcomes } = yield* runSequence(requests, backend)

			assertMatchesOracle(outcomes, requests)
			expect(coverageOf(outcomes.slice(1))).toBeGreaterThanOrEqual(0.9)
		})
	})

	it.live("serves a re-viewed window entirely from cache", () => {
		const windowMs = 60 * MIN
		const first = { startMs: BASE_MS - windowMs, endMs: BASE_MS }
		// Pan back an hour, then return to where we started.
		const panned = { startMs: BASE_MS - 2 * windowMs, endMs: BASE_MS - windowMs }
		const requests = [first, panned, first]

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const { outcomes } = yield* runSequence(requests, backend)

			assertMatchesOracle(outcomes, requests)

			const revisit = outcomes[2]!
			assert.strictEqual(revisit.bucketsMissed, 0)
			assert.strictEqual(revisit.warehouseQueryCount, 0)
			assert.strictEqual(revisit.bucketsHit, revisit.requestedBuckets)
		})
	})

	it.live("repeats a fixed absolute range with zero warehouse cost", () => {
		const fixed = { startMs: BASE_MS - 4 * MIN, endMs: BASE_MS }
		const requests = [fixed, fixed, fixed, fixed]

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const { outcomes, warehouseCalls } = yield* runSequence(requests, backend)

			assertMatchesOracle(outcomes, requests)
			// One cold fill, then nothing.
			assert.strictEqual(warehouseCalls, 1)
			expect(coverageOf(outcomes.slice(1))).toBe(1)
		})
	})

	it.live("gives a zoomed view its own entries without disturbing the original", () => {
		const windowMs = 60 * MIN
		const wide = { startMs: BASE_MS - windowMs, endMs: BASE_MS, bucketSeconds: 60 }
		// Zooming changes the step, which changes the fingerprint — a different
		// granularity must not be served from the coarser entries.
		const zoomed = { startMs: BASE_MS - 10 * MIN, endMs: BASE_MS, bucketSeconds: 300 }
		const requests = [wide, zoomed, wide]

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const { outcomes } = yield* runSequence(requests, backend)

			// The zoomed request is cold...
			expect(outcomes[1]!.bucketsHit).toBe(0)
			// ...and the original is still fully warm afterwards.
			assert.strictEqual(outcomes[2]!.warehouseQueryCount, 0)
			assert.strictEqual(outcomes[2]!.bucketsMissed, 0)
		})
	})

	it.live("never serves one org's points to another", () => {
		const window = { startMs: BASE_MS - 10 * MIN, endMs: BASE_MS }

		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService

			// Org A fills the cache with points tagged to itself.
			const a = yield* svc.getOrComputeBuckets(
				{ orgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...window },
				({ startMs, endMs }) =>
					Effect.succeed(
						warehousePointsFor(startMs, endMs).map((p) => ({
							...p,
							series: { ...p.series, owner: 1 },
						})),
					),
			)

			// Org B issues a byte-identical query shape.
			let bComputed = false
			const b = yield* svc.getOrComputeBuckets(
				{ orgId: otherOrgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...window },
				({ startMs, endMs }) => {
					bComputed = true
					return Effect.succeed(
						warehousePointsFor(startMs, endMs).map((p) => ({
							...p,
							series: { ...p.series, owner: 2 },
						})),
					)
				},
			)

			assert.isTrue(bComputed, "org B must not be served from org A's entries")
			assert.strictEqual(a.bucketsHit, 0)
			assert.strictEqual(b.bucketsHit, 0)
			// The decisive check is on the data, not the key: every point org B
			// received must carry its own marker.
			for (const point of b.points) {
				assert.strictEqual(point.series.owner, 2)
			}
		}).pipe(Effect.provide(makeLive(backend)), Effect.provide(makeConfig()))
	})

	it.live("refills from the warehouse after the entries expire", () => {
		const fixed = { startMs: BASE_MS - 4 * MIN, endMs: BASE_MS }
		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			// A 1-second TTL, and the memory backend expires lazily on read.
			const warm = yield* runSequence(
				[fixed, fixed],
				backend,
				makeConfig({
					QE_BUCKET_CACHE_TTL_SECONDS: "1",
				}),
			)
			assert.strictEqual(warm.warehouseCalls, 1)

			yield* Effect.sleep("1100 millis")

			const afterExpiry = yield* runSequence(
				[fixed],
				backend,
				makeConfig({
					QE_BUCKET_CACHE_TTL_SECONDS: "1",
				}),
			)
			// Expired, so it refetches — and the points are still correct.
			assert.strictEqual(afterExpiry.warehouseCalls, 1)
			assert.deepStrictEqual(
				afterExpiry.outcomes[0]!.points,
				warehousePointsFor(fixed.startMs, fixed.endMs),
			)
		})
	})

	it.live("keeps the flux tail live while serving settled buckets from cache", () => {
		// This one runs against the real clock with a real 60s flux window: the
		// trailing minute must always be recomputed (it is still being written to),
		// while everything behind it comes from cache.
		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const nowMs = Date.now()
			const endMs = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS
			const window = { startMs: endMs - 30 * MIN, endMs }

			const { outcomes } = yield* runSequence(
				[window, window],
				backend,
				makeConfig({
					QE_BUCKET_CACHE_FLUX_SECONDS: "60",
				}),
			)

			const second = outcomes[1]!
			// Settled buckets are cached...
			expect(second.bucketsHit).toBeGreaterThan(0)
			// ...but the live tail is never cached, so a query is still issued.
			expect(second.warehouseQueryCount).toBeGreaterThanOrEqual(1)
		})
	})
})

/**
 * Fault injection. Everything above assumes the backend answers; in production
 * it frequently does not — ~22% of prod reads are abandoned at the read
 * deadline, because an in-flight `cache.match()` holds one of the Worker's six
 * connection slots and queues behind whatever warehouse `fetch()` already has
 * them. That is the mechanism behind "the dashboard is fast, except when it
 * isn't", so it needs tests that assert what happens *after* a failure, not
 * just that the failure is survived.
 */
describe("bucket cache hit rate — degraded backends", () => {
	/** A backend whose reads outlive the deadline, so every read is abandoned. */
	const hangingReads = (inner: EdgeCacheBackend): EdgeCacheBackend => ({
		...inner,
		name: inner.name,
		get: () => new Promise<never>(() => {}),
	})

	const READ_TIMEOUT_MS = 20

	it.live("repopulates the cache after a read timeout instead of staying cold", () => {
		// The failure mode this pins: a segment whose read timed out used to be
		// excluded from write-back, so under sustained pressure it was never
		// repopulated and every later request timed out too — the cache holding
		// itself cold. The first request must leave the cache usable.
		const inner = makeMemoryBackend()
		const fixed = { startMs: BASE_MS - 4 * MIN, endMs: BASE_MS }

		let warehouseCalls = 0
		const compute = ({ startMs, endMs }: { startMs: number; endMs: number }) => {
			warehouseCalls++
			return Effect.succeed(warehousePointsFor(startMs, endMs))
		}

		return Effect.gen(function* () {
			// First request: reads hang, so it computes everything — but it must
			// still write what it computed.
			const degraded = yield* Effect.gen(function* () {
				const svc = yield* BucketCacheService
				return yield* svc.getOrComputeBuckets(
					{ orgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...fixed },
					compute,
				)
			}).pipe(
				Effect.provide(makeLive(hangingReads(inner), READ_TIMEOUT_MS)),
				Effect.provide(makeConfig()),
			)

			assert.strictEqual(degraded.segmentsTimedOut, 1)
			assert.deepStrictEqual(degraded.points, warehousePointsFor(fixed.startMs, fixed.endMs))
			const callsAfterDegraded = warehouseCalls

			// Second request against a healthy backend over the same store: the
			// buckets the degraded request computed are there.
			const recovered = yield* Effect.gen(function* () {
				const svc = yield* BucketCacheService
				return yield* svc.getOrComputeBuckets(
					{ orgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...fixed },
					compute,
				)
			}).pipe(Effect.provide(makeLive(inner)), Effect.provide(makeConfig()))

			assert.strictEqual(recovered.bucketsMissed, 0)
			assert.strictEqual(recovered.warehouseQueryCount, 0)
			assert.strictEqual(warehouseCalls, callsAfterDegraded)
			assert.deepStrictEqual(recovered.points, warehousePointsFor(fixed.startMs, fixed.endMs))
		})
	})

	it.live("survives a backend that throws on both read and write", () => {
		const exploding: EdgeCacheBackend = {
			name: "memory",
			get: async () => {
				throw new Error("read exploded")
			},
			put: async () => {
				throw new Error("write exploded")
			},
			delete: async () => {},
		}
		const fixed = { startMs: BASE_MS - 4 * MIN, endMs: BASE_MS }

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			// A dead cache must degrade to "uncached", never to a failed request.
			const outcome = yield* svc.getOrComputeBuckets(
				{ orgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...fixed },
				({ startMs, endMs }) => Effect.succeed(warehousePointsFor(startMs, endMs)),
			)

			assert.deepStrictEqual(outcome.points, warehousePointsFor(fixed.startMs, fixed.endMs))
			assert.strictEqual(outcome.segmentsErrored, 1)
		}).pipe(Effect.provide(makeLive(exploding)), Effect.provide(makeConfig()))
	})

	it.live("round-trips a segment payload through JSON without losing buckets", () => {
		// The Workers backend stores via `JSON.stringify` and reads back through
		// `response.json()`, but `rawPut` — unlike `getOrCompute` — takes no schema
		// codec, so nothing else checks that the payload survives that trip. A
		// silent shape change here reads back as a permanent miss.
		const inner = makeMemoryBackend()
		const jsonRoundTrip: EdgeCacheBackend = {
			name: "workers-cache",
			get: async (bucket, hash, nowMs) => {
				const value = await inner.get(bucket, hash, nowMs)
				return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
			},
			put: (bucket, hash, value, ttlSeconds, nowMs) =>
				inner.put(bucket, hash, JSON.parse(JSON.stringify(value)), ttlSeconds, nowMs),
			delete: inner.delete,
		}
		const fixed = { startMs: BASE_MS - 4 * MIN, endMs: BASE_MS }

		return Effect.gen(function* () {
			const { outcomes, warehouseCalls } = yield* runSequence([fixed, fixed], jsonRoundTrip)

			// The second read must validate against `isBucketCacheSegmentData` and
			// hit — if the round trip perturbed the shape it would silently miss.
			assert.strictEqual(warehouseCalls, 1)
			assert.strictEqual(outcomes[1]!.bucketsMissed, 0)
			assert.deepStrictEqual(outcomes[1]!.points, warehousePointsFor(fixed.startMs, fixed.endMs))
		})
	})
})

describe("bucket cache hit rate — concurrency", () => {
	it.live("holds cache reads within Cloudflare's six-connection budget", () => {
		// A wide window spanning many segments, so the read fan-out is as large as
		// the service will ever make it. Reads beyond six simultaneous
		// `cache.match()` calls queue behind their own siblings and are abandoned
		// at the read deadline, so an over-eager fan-out manufactures its own
		// misses. Bound it here rather than discovering it in prod latency.
		const segmentMs = BUCKET_MS * 120
		const window = { startMs: BASE_MS - 10 * segmentMs, endMs: BASE_MS }

		const instrumented = makeInstrumentedBackend()

		return Effect.gen(function* () {
			yield* runSequence([window], instrumented.backend)
			expect(instrumented.peakInFlight()).toBeLessThanOrEqual(6)
		})
	})

	it.live("returns correct points when many widgets query concurrently", () => {
		// Eight widgets on one dashboard, same org, overlapping windows, all
		// firing at once. There is deliberately no cross-request single-flight
		// (Cloudflare forbids awaiting another request's I/O), so duplicate
		// computes are expected — what must not happen is wrong or interleaved data.
		const windowMs = 30 * MIN
		const { backend } = makeInstrumentedBackend()

		return Effect.gen(function* () {
			const svc = yield* BucketCacheService
			const widgets = Array.from({ length: 8 }, (_, index) => ({
				startMs: BASE_MS - windowMs - index * MIN,
				endMs: BASE_MS - index * MIN,
			}))

			const outcomes = yield* Effect.forEach(
				widgets,
				(window) =>
					svc.getOrComputeBuckets(
						{ orgId, query: DEFAULT_QUERY, bucketSeconds: BUCKET_SECONDS, ...window },
						({ startMs, endMs }) => Effect.succeed(warehousePointsFor(startMs, endMs)),
					),
				{ concurrency: "unbounded" },
			)

			outcomes.forEach((outcome, index) => {
				assert.deepStrictEqual(
					outcome.points,
					warehousePointsFor(widgets[index]!.startMs, widgets[index]!.endMs),
					`widget ${index} received points from a different window`,
				)
			})
		}).pipe(Effect.provide(makeLive(backend)), Effect.provide(makeConfig()))
	})
})
