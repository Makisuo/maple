import { describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { strict as assert } from "node:assert"
import { OrgId, UserId } from "@maple/domain"
import { baselineWarehouseCapabilities, type QueryEngineEvaluateRequest } from "@maple/query-engine"
import type { CompiledQuery } from "@maple/query-engine/ch"
import {
	makeQueryEngineEvaluate,
	makeQueryEngineEvaluateSeries,
	type AlertEvaluateRequest,
} from "@maple/query-engine/runtime"
import { QueryEngineService } from "./QueryEngineService"
import type { TenantContext } from "@/services/auth/AuthService"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceShape,
} from "@/services/warehouse/WarehouseQueryService"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService, type EdgeCacheServiceShape } from "@maple/cache"
import { traceCacheTtlSeconds } from "@/services/warehouse/trace-detail-cache"

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

const countRequest = (reducer: QueryEngineEvaluateRequest["reducer"]): AlertEvaluateRequest =>
	({
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 00:15:00",
		source: {
			kind: "spec",
			query: { kind: "timeseries", source: "traces", metric: "count", bucketSeconds: 300 },
		},
		reducer,
		sampleCountStrategy: "trace_count",
	}) as AlertEvaluateRequest

const evalStub = (rows: ReadonlyArray<Record<string, unknown>>) =>
	({
		sqlQuery: () => Effect.succeed(rows as never),
		rawSqlQuery: () => Effect.die(new Error("rawSqlQuery is not used by evaluate cache tests")),
		compiledQuery: (_tenant, compiled) => compiled.decodeRows(rows).pipe(Effect.orDie),
		compiledQueryWithCapabilities: (_tenant, compile) =>
			compile(baselineWarehouseCapabilities()).decodeRows(rows).pipe(Effect.orDie),
	}) satisfies Parameters<typeof makeQueryEngineEvaluate>[0]

describe("makeQueryEngineEvaluate (shared alert-lowering core)", () => {
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
				source: { kind: "spec", query: { ...req.source.query, groupBy: ["service"] } },
			} as AlertEvaluateRequest)
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
				source: { kind: "spec", query: { ...req.source.query, groupBy: ["service"] } },
			} as AlertEvaluateRequest)
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

const rawStub = (rows: ReadonlyArray<Record<string, unknown>>) =>
	({
		sqlQuery: () => Effect.die(new Error("sqlQuery is not used by raw SQL tests")),
		rawSqlQuery: () => Effect.succeed(rows),
		compiledQuery: () => Effect.die(new Error("compiledQuery is not used by raw SQL tests")),
		compiledQueryWithCapabilities: () =>
			Effect.die(new Error("compiledQueryWithCapabilities is not used by raw SQL tests")),
	}) satisfies Parameters<typeof makeQueryEngineEvaluate>[0]

const rawRequest = (reducer: QueryEngineEvaluateRequest["reducer"]): AlertEvaluateRequest => ({
	startTime: "2026-01-01 00:00:00",
	endTime: "2026-01-01 00:15:00",
	source: {
		kind: "raw_sql",
		sql: "SELECT $__timeGroup(Timestamp) AS bucket, count() AS value FROM Logs WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket",
		windowMinutes: 5,
	},
	reducer,
	sampleCountStrategy: null,
})

// Raw SQL goes through the very same `evaluate` as every spec source — there is
// no separate entry point to test.
describe("evaluate with a raw_sql source", () => {
	it.effect("reduces bucketed rows exactly like the spec sources do", () =>
		Effect.gen(function* () {
			// Same 2/3/5 shape as COUNT_ROWS, so the reduced result must match
			// the trace built-in's byte for byte.
			const rows = [
				{ bucket: "2026-01-01 00:00:00", value: 2, samples: 2 },
				{ bucket: "2026-01-01 00:05:00", value: 3, samples: 3 },
				{ bucket: "2026-01-01 00:10:00", value: 5, samples: 5 },
			]
			const raw = yield* makeQueryEngineEvaluate(rawStub(rows))(tenant, rawRequest("sum"))
			const spec = yield* makeQueryEngineEvaluate(evalStub(COUNT_ROWS))(tenant, countRequest("sum"))
			assert.deepStrictEqual(raw, spec)
		}),
	)

	it.effect("collapses an unbucketed query into one synthetic bucket", () =>
		Effect.gen(function* () {
			const raw = yield* makeQueryEngineEvaluate(rawStub([{ value: 10, samples: 10 }]))(
				tenant,
				rawRequest("sum"),
			)
			assert.deepStrictEqual(raw, [{ groupKey: "all", value: 10, sampleCount: 10, hasData: true }])
		}),
	)

	it.effect("treats a null value as no data rather than a missing scalar", () =>
		Effect.gen(function* () {
			// `hasData === sampleCount > 0` must hold for raw rows exactly as it does
			// for the spec sources.
			const raw = yield* makeQueryEngineEvaluate(rawStub([{ value: null }]))(tenant, rawRequest("sum"))
			assert.deepStrictEqual(raw, [{ groupKey: "all", value: null, sampleCount: 0, hasData: false }])
		}),
	)

	it.effect("emits a single no-data observation when there are no rows", () =>
		Effect.gen(function* () {
			const raw = yield* makeQueryEngineEvaluate(rawStub([]))(tenant, rawRequest("sum"))
			const spec = yield* makeQueryEngineEvaluate(evalStub([]))(tenant, countRequest("sum"))
			assert.deepStrictEqual(raw, spec)
		}),
	)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			QE_BUCKET_CACHE_ENABLED: "true",
			QE_BUCKET_CACHE_TTL_SECONDS: "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: "0",
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
		compiledQueryWithCapabilities: <Output>(
			_tenant: unknown,
			compile: (
				capabilities: ReturnType<typeof baselineWarehouseCapabilities>,
			) => CompiledQuery<Output>,
		) => {
			counter.n += 1
			return compile(baselineWarehouseCapabilities()).decodeRows(rows).pipe(Effect.orDie)
		},
		compiledQueryFirst: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) => {
			counter.n += 1
			return compiled.decodeFirstRow(rows).pipe(Effect.orDie)
		},
		// Deliberately does not touch `counter`: warming resolves route config, it
		// does not issue a warehouse query, and these tests assert query counts.
		warmRoute: () => Effect.void,
		ingest: () => Effect.void,
		sql: () => Promise.resolve({ data: [] }),
	}) as unknown as WarehouseQueryServiceShape

// Records cache options so we can assert both TTL plumbing and the matching
// time-snap window used by each direct route key.
const makeRecordingEdge = (
	calls: Array<{ bucket: string; key: string; ttlSeconds: number }>,
): EdgeCacheServiceShape => ({
	getOrCompute: (options, compute) => {
		calls.push({
			bucket: options.bucket,
			key: options.key,
			ttlSeconds: typeof options.ttlSeconds === "function" ? -1 : options.ttlSeconds,
		})
		return Effect.map(compute, (value) => ({ value, hit: false }))
	},
	invalidate: () => Effect.void,
	rawGetDetailed: () => Effect.succeed({ status: "miss" as const, value: Option.none(), readMs: 0 }),
	rawGet: () => Effect.succeed(Option.none()),
	rawPut: () => Effect.void,
})

describe("QueryEngineService.cachedDirect TTL", () => {
	it.effect("passes the per-route ttlSeconds to the edge cache and defaults to 15s", () => {
		const calls: Array<{ bucket: string; key: string; ttlSeconds: number }> = []
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

			assert.deepStrictEqual(
				calls.map(({ bucket, ttlSeconds }) => ({ bucket, ttlSeconds })),
				[
					{ bucket: "qe-direct", ttlSeconds: 3600 },
					{ bucket: "qe-direct", ttlSeconds: 15 },
				],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("snaps direct cache keys to the route TTL, capped at one hour", () => {
		const calls: Array<{ bucket: string; key: string; ttlSeconds: number }> = []
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
			const run = (route: string, second: string, ttlSeconds?: number) =>
				qe.cachedDirect(
					tenant,
					route,
					{
						startTime: `2026-01-01 00:00:${second}`,
						endTime: `2026-01-01 01:00:${second}`,
					},
					Effect.succeed([{ ok: true }]),
					ttlSeconds,
				)

			// Both timestamps fall in the same 60-second cache window.
			yield* run("serviceUsage", "05", 60)
			yield* run("serviceUsage", "45", 60)
			// The default remains 15 seconds, so these produce distinct keys.
			yield* run("serviceOverview", "05")
			yield* run("serviceOverview", "20")
			// TTLs above one hour use the one-hour cap.
			yield* qe.cachedDirect(
				tenant,
				"longRoute",
				{ startTime: "2026-01-01 00:10:00", endTime: "2026-01-01 02:10:00" },
				Effect.succeed([{ ok: true }]),
				7200,
			)
			yield* qe.cachedDirect(
				tenant,
				"longRoute",
				{ startTime: "2026-01-01 00:50:00", endTime: "2026-01-01 02:50:00" },
				Effect.succeed([{ ok: true }]),
				7200,
			)

			assert.strictEqual(calls[0]?.key, calls[1]?.key)
			assert.notStrictEqual(calls[2]?.key, calls[3]?.key)
			assert.strictEqual(calls[4]?.key, calls[5]?.key)
		}).pipe(Effect.provide(layer))
	})

	it.effect("versions direct policies and canonicalizes set-like filters", () => {
		const calls: Array<{ bucket: string; key: string; ttlSeconds: number }> = []
		const recordingEdge = Layer.succeed(EdgeCacheService, makeRecordingEdge(calls))
		const counter = { n: 0 }
		const layer = QueryEngineService.layer.pipe(
			Layer.provide(Layer.succeed(WarehouseQueryService, makeFullStub([], counter))),
			Layer.provide(recordingEdge),
			Layer.provide(BucketCacheService.layer.pipe(Layer.provide(recordingEdge))),
			Layer.provide(makeConfig()),
		)
		const policy = { version: 2, ttlSeconds: 300, snapWindowSeconds: 60 } as const

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.cachedDirect(
				tenant,
				"serviceUsage",
				{
					startTime: "2026-01-01 00:00:05",
					environments: ["production", "staging", "production"],
				},
				Effect.succeed([{ ok: true }]),
				policy,
			)
			yield* qe.cachedDirect(
				tenant,
				"serviceUsage",
				{
					startTime: "2026-01-01 00:00:45",
					environments: ["staging", "production"],
				},
				Effect.succeed([{ ok: true }]),
				policy,
			)

			assert.strictEqual(calls[0]?.key, calls[1]?.key)
			assert.match(calls[0]?.key ?? "", /^direct:v2:/)
			assert.deepStrictEqual(
				calls.map(({ ttlSeconds }) => ttlSeconds),
				[300, 300],
			)
		}).pipe(Effect.provide(layer))
	})
})

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
