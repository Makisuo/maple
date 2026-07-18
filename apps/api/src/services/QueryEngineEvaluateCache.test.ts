import { describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { strict as assert } from "node:assert"
import { OrgId, UserId } from "@maple/domain"
import type { QueryEngineEvaluateRequest } from "@maple/query-engine"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { makeQueryEngineEvaluate, makeQueryEngineEvaluateSeries } from "@maple/query-engine/runtime"
import { QueryEngineService } from "./QueryEngineService"
import type { TenantContext } from "./AuthService"
import { WarehouseQueryService, type WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import {
	EdgeCacheService,
	BucketCacheService,
	type EdgeCacheServiceShape,
} from "@maple/query-engine/caching"
import { CacheBackendLive } from "../lib/CacheBackendLive"
import { traceCacheTtlSeconds } from "../lib/trace-detail-cache"

const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const tenant: TenantContext = {
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const traceRow = (
	overrides: Partial<{
		bucket: string
		groupName: string
		count: number
		avgDuration: number
		p50Duration: number
		p95Duration: number
		p99Duration: number
		errorRate: number
		apdexScore: number
		estimatedSpanCount: number
	}> = {},
) => ({
	bucket: "2026-01-01 00:00:00",
	groupName: "all",
	count: 0,
	avgDuration: 0,
	p50Duration: 0,
	p95Duration: 0,
	p99Duration: 0,
	errorRate: 0,
	apdexScore: 0,
	estimatedSpanCount: 0,
	...overrides,
})

// Three buckets within [00:00, 00:15) at the 5-min grid, counts 2/3/5.
const COUNT_ROWS = [
	traceRow({ bucket: "2026-01-01 00:00:00", count: 2 }),
	traceRow({ bucket: "2026-01-01 00:05:00", count: 3 }),
	traceRow({ bucket: "2026-01-01 00:10:00", count: 5 }),
]

const countRequest = (reducer: QueryEngineEvaluateRequest["reducer"]): QueryEngineEvaluateRequest =>
	({
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 00:15:00",
		query: { kind: "timeseries", source: "traces", metric: "count", bucketSeconds: 300 },
		reducer,
		sampleCountStrategy: "trace_count",
	}) as QueryEngineEvaluateRequest

const evalStub = (rows: ReadonlyArray<Record<string, unknown>>) =>
	({
		sqlQuery: () => Effect.succeed(rows as never),
		rawSqlQuery: () => Effect.die(new Error("rawSqlQuery is not used by evaluate cache tests")),
		compiledQuery: (_tenant, compiled) => compiled.decodeRows(rows).pipe(Effect.orDie),
	}) satisfies Parameters<typeof makeQueryEngineEvaluate>[0]

describe("makeQueryEngineEvaluate (shared bucket-encoding core)", () => {
	it.effect("reduces per-bucket values with sum and sums sample counts", () =>
		Effect.gen(function* () {
			const result = yield* makeQueryEngineEvaluate(evalStub(COUNT_ROWS))(tenant, countRequest("sum"))
			assert.deepStrictEqual(result, [{ groupKey: "all", value: 10, sampleCount: 10, hasData: true }])
		}),
	)

	it.effect("reduces with avg over the populated buckets", () =>
		Effect.gen(function* () {
			const result = yield* makeQueryEngineEvaluate(evalStub(COUNT_ROWS))(tenant, countRequest("avg"))
			assert.deepStrictEqual(result, [
				{ groupKey: "all", value: (2 + 3 + 5) / 3, sampleCount: 10, hasData: true },
			])
		}),
	)

	it.effect("keeps groups separate", () =>
		Effect.gen(function* () {
			const rows = [
				traceRow({ bucket: "2026-01-01 00:00:00", groupName: "a", count: 2 }),
				traceRow({ bucket: "2026-01-01 00:00:00", groupName: "b", count: 3 }),
				traceRow({ bucket: "2026-01-01 00:05:00", groupName: "a", count: 4 }),
			]
			const req = countRequest("sum")
			const result = yield* makeQueryEngineEvaluate(evalStub(rows))(tenant, {
				...req,
				query: { ...req.query, groupBy: ["service"] },
			} as QueryEngineEvaluateRequest)
			assert.deepStrictEqual(result, [
				{ groupKey: "a", value: 6, sampleCount: 6, hasData: true },
				{ groupKey: "b", value: 3, sampleCount: 3, hasData: true },
			])
		}),
	)

	it.effect("emits a single no-data observation when there are no rows", () =>
		Effect.gen(function* () {
			const result = yield* makeQueryEngineEvaluate(evalStub([]))(tenant, countRequest("sum"))
			assert.deepStrictEqual(result, [{ groupKey: "all", value: null, sampleCount: 0, hasData: false }])
		}),
	)
})

describe("makeQueryEngineEvaluateSeries (per-bucket preview core)", () => {
	it.effect("returns one observation per bucket that evaluate reduces to the same scalar", () =>
		Effect.gen(function* () {
			const series = yield* makeQueryEngineEvaluateSeries(evalStub(COUNT_ROWS))(
				tenant,
				countRequest("sum"),
			)
			assert.deepStrictEqual(series, [
				{ bucket: "2026-01-01T00:00:00.000Z", groupKey: "all", value: 2, sampleCount: 2 },
				{ bucket: "2026-01-01T00:05:00.000Z", groupKey: "all", value: 3, sampleCount: 3 },
				{ bucket: "2026-01-01T00:10:00.000Z", groupKey: "all", value: 5, sampleCount: 5 },
			])

			// The reduced evaluate path must agree with the sum of the series.
			const reduced = yield* makeQueryEngineEvaluate(evalStub(COUNT_ROWS))(tenant, countRequest("sum"))
			const total = series.reduce((sum, obs) => sum + (obs.value ?? 0), 0)
			assert.equal(reduced[0]?.value, total)
		}),
	)

	it.effect("keeps groups separate with per-bucket granularity", () =>
		Effect.gen(function* () {
			const rows = [
				traceRow({ bucket: "2026-01-01 00:00:00", groupName: "a", count: 2 }),
				traceRow({ bucket: "2026-01-01 00:00:00", groupName: "b", count: 3 }),
				traceRow({ bucket: "2026-01-01 00:05:00", groupName: "a", count: 4 }),
			]
			const req = countRequest("sum")
			const series = yield* makeQueryEngineEvaluateSeries(evalStub(rows))(tenant, {
				...req,
				query: { ...req.query, groupBy: ["service"] },
			} as QueryEngineEvaluateRequest)
			assert.deepStrictEqual(series, [
				{ bucket: "2026-01-01T00:00:00.000Z", groupKey: "a", value: 2, sampleCount: 2 },
				{ bucket: "2026-01-01T00:00:00.000Z", groupKey: "b", value: 3, sampleCount: 3 },
				{ bucket: "2026-01-01T00:05:00.000Z", groupKey: "a", value: 4, sampleCount: 4 },
			])
		}),
	)

	it.effect("returns an empty series when there are no rows", () =>
		Effect.gen(function* () {
			const series = yield* makeQueryEngineEvaluateSeries(evalStub([]))(tenant, countRequest("sum"))
			assert.deepStrictEqual(series, [])
		}),
	)
})

// --- Full-service: the bucket-cached evaluate path. ---

const makeConfig = (overrides: Record<string, string> = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			QE_BUCKET_CACHE_ENABLED: "true",
			QE_BUCKET_CACHE_TTL_SECONDS: "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: "0",
			QE_EVAL_BUCKET_CACHE_ENABLED: "true",
			...overrides,
		}),
	)

const makeFullStub = (
	rows: ReadonlyArray<Record<string, unknown>>,
	counter: { n: number },
): WarehouseQueryServiceShape =>
	({
		query: () => Effect.die(new Error("query not expected")),
		sqlQuery: () => {
			counter.n += 1
			return Effect.succeed(rows as never)
		},
		compiledQuery: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) => {
			counter.n += 1
			return compiled.decodeRows(rows).pipe(Effect.orDie)
		},
		compiledQueryFirst: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) => {
			counter.n += 1
			return compiled.decodeFirstRow(rows).pipe(Effect.orDie)
		},
		ingest: () => Effect.void,
		sql: () => Promise.resolve({ data: [] }),
	}) as unknown as WarehouseQueryServiceShape

const makeQueryEngineLayer = (stub: WarehouseQueryServiceShape) =>
	QueryEngineService.layer.pipe(
		Layer.provide(Layer.succeed(WarehouseQueryService, stub)),
		Layer.provide(edgeCacheLive),
		Layer.provide(BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))),
		Layer.provide(makeConfig()),
	)

describe("QueryEngineService.evaluate via bucket cache", () => {
	it.live("matches the direct path and serves an identical repeat from cache", () => {
		const counter = { n: 0 }
		const layer = makeQueryEngineLayer(makeFullStub(COUNT_ROWS, counter))

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const first = yield* qe.evaluate(tenant, countRequest("sum"))
			const second = yield* qe.evaluate(tenant, countRequest("sum"))

			// Parity: cached repeat equals the first (computed) result.
			assert.deepStrictEqual(second, first)
			// The second evaluation is a pure bucket-cache hit — no new SQL.
			assert.strictEqual(counter.n, 1)
			// Parity with the uncached direct path.
			const direct = yield* makeQueryEngineEvaluate(evalStub(COUNT_ROWS))(tenant, countRequest("sum"))
			assert.deepStrictEqual(first, direct)
			assert.deepStrictEqual(first, [{ groupKey: "all", value: 10, sampleCount: 10, hasData: true }])
		}).pipe(Effect.provide(layer))
	})

	it.live("falls back to the blob path and never caches when the kill switch is off", () => {
		const counter = { n: 0 }
		const layer = QueryEngineService.layer.pipe(
			Layer.provide(Layer.succeed(WarehouseQueryService, makeFullStub(COUNT_ROWS, counter))),
			Layer.provide(edgeCacheLive),
			Layer.provide(BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))),
			Layer.provide(makeConfig({ QE_EVAL_BUCKET_CACHE_ENABLED: "false" })),
		)

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const result = yield* qe.evaluate(tenant, countRequest("sum"))
			// Same answer as the bucket path.
			assert.deepStrictEqual(result, [{ groupKey: "all", value: 10, sampleCount: 10, hasData: true }])
		}).pipe(Effect.provide(layer))
	})
})

// --- cachedDirect: per-route TTL plumbing. ---

// Records the `ttlSeconds` of every getOrCompute call so we can assert the
// per-route TTL reaches the edge cache (and that omitting it defaults to 15s).
const makeRecordingEdge = (
	calls: Array<{ bucket: string; ttlSeconds: number }>,
): EdgeCacheServiceShape => ({
	getOrCompute: (options, compute) => {
		calls.push({ bucket: options.bucket, ttlSeconds: options.ttlSeconds })
		return Effect.map(compute, (value) => ({ value, hit: false }))
	},
	invalidate: () => Effect.void,
	rawGet: () => Effect.succeed(Option.none()),
	rawPut: () => Effect.void,
})

describe("QueryEngineService.cachedDirect TTL", () => {
	it.effect("passes the per-route ttlSeconds to the edge cache and defaults to 15s", () => {
		const calls: Array<{ bucket: string; ttlSeconds: number }> = []
		const recordingEdge = Layer.succeed(EdgeCacheService, makeRecordingEdge(calls))
		const counter = { n: 0 }
		const layer = QueryEngineService.layer.pipe(
			Layer.provide(Layer.succeed(WarehouseQueryService, makeFullStub([], counter))),
			Layer.provide(recordingEdge),
			Layer.provide(BucketCacheService.layer.pipe(Layer.provide(recordingEdge))),
			Layer.provide(makeConfig()),
		)

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			// Explicit long TTL (the serviceHealthBaseline case).
			yield* qe.cachedDirect(
				tenant,
				"serviceHealthBaseline",
				{ startTime: "2026-01-01 00:00:00", endTime: "2026-01-08 00:00:00" },
				Effect.succeed([{ ok: true }]),
				3600,
			)
			// Omitted TTL falls back to the 15s default (the serviceOverview case).
			yield* qe.cachedDirect(tenant, "serviceOverview", { a: 1 }, Effect.succeed([{ ok: true }]))

			assert.deepStrictEqual(calls, [
				{ bucket: "qe-direct", ttlSeconds: 3600 },
				{ bucket: "qe-direct", ttlSeconds: 15 },
			])
		}).pipe(Effect.provide(layer))
	})
})

// --- trace-detail cache TTL: age-conditional tiers. ---

describe("traceCacheTtlSeconds", () => {
	const nowMs = Date.parse("2026-07-17T12:00:00Z")

	it("caches settled traces (window ended >15min ago) for 600s", () => {
		assert.strictEqual(traceCacheTtlSeconds("2026-07-17 11:00:00", nowMs), 600)
		assert.strictEqual(traceCacheTtlSeconds("2026-07-01 00:00:00", nowMs), 600)
	})

	it("keeps live traces (window still recent or in the future) on the 15s default", () => {
		assert.strictEqual(traceCacheTtlSeconds("2026-07-17 11:50:00", nowMs), 15)
		// ±1h windows around a fresh timestamp end in the future.
		assert.strictEqual(traceCacheTtlSeconds("2026-07-17 12:45:00", nowMs), 15)
	})

	it("uses a conservative 60s when the payload has no window (probe path)", () => {
		assert.strictEqual(traceCacheTtlSeconds(undefined, nowMs), 60)
	})

	it("falls back to 15s on an unparseable timestamp", () => {
		assert.strictEqual(traceCacheTtlSeconds("not-a-date", nowMs), 15)
	})
})
