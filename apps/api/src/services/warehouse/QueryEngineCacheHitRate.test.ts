import { describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { strict as assert } from "node:assert"
import { OrgId, UserId } from "@maple/domain"
import { baselineWarehouseCapabilities, QueryEngineExecuteRequest, type QuerySpec } from "@maple/query-engine"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { QueryEngineService } from "./QueryEngineService"
import type { TenantContext } from "@/services/auth/AuthService"
import { WarehouseQueryService, type WarehouseQueryServiceApi } from "./WarehouseQueryService"
import { BucketCacheService } from "@maple/query-engine/caching"
import {
	EdgeCacheService,
	makeEdgeCacheService,
	makeMemoryBackend,
	type EdgeCacheServiceApi,
} from "@maple/cache"

/**
 * Which cache a dashboard request actually lands on, and what that costs.
 *
 * `QueryEngineService.execute` picks between two very differently-priced paths
 * — the segment/bucket cache and the legacy whole-response blob cache — behind
 * four separate fallback conditions. A request that quietly takes the blob path
 * is indistinguishable, from the outside, from a bucket cache with a terrible
 * hit rate: same symptom, completely different fix. These tests pin which path
 * each shape of request takes by observing the cache namespace it touches
 * (`qe-ts-buckets` vs `qe-execute`), which is the same discriminator the
 * `cache.path` span attribute reports in production.
 */

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const tenant: TenantContext = {
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const BUCKET_NAMESPACE = "qe-ts-buckets"
const BLOB_NAMESPACE = "qe-execute"

const makeConfig = (overrides: Record<string, string> = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			QE_BUCKET_CACHE_ENABLED: "true",
			QE_BUCKET_CACHE_TTL_SECONDS: "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: "0",
			...overrides,
		}),
	)

/** Wraps a real edge cache so behaviour is unchanged but namespaces are recorded. */
const makeObservedEdgeCache = () => {
	const namespaces: string[] = []
	const inner = makeEdgeCacheService(makeMemoryBackend())
	const observed: EdgeCacheServiceApi = {
		getOrCompute: (options, compute) => {
			namespaces.push(options.bucket)
			return inner.getOrCompute(options, compute)
		},
		invalidate: inner.invalidate,
		rawGetDetailed: (bucket, key) => {
			namespaces.push(bucket)
			return inner.rawGetDetailed(bucket, key)
		},
		rawGet: inner.rawGet,
		rawPut: inner.rawPut,
	}
	return {
		layer: Layer.succeed(EdgeCacheService, observed),
		namespaces,
		touched: (namespace: string) => namespaces.includes(namespace),
	}
}

/**
 * Warehouse stub returning three 5-minute trace buckets. Rows are fixed, so a
 * point served from cache and a point computed fresh are necessarily identical
 * — any divergence is the cache's doing, not the query's.
 */
const traceRow = (bucket: string, count: number) => ({
	bucket,
	groupName: "all",
	// `name`/`value` let the same fixed rows decode as a breakdown result too,
	// so one stub serves both cache paths.
	name: "all",
	value: count,
	count,
	spanCount: count,
	avgDuration: 0,
	p50Duration: 0,
	p95Duration: 0,
	p99Duration: 0,
	errorRate: 0,
	// The count query selects a single `total`. Rows decode against the compiled
	// query's derived schema now, so the one fixture has to satisfy every shape
	// it is fed to.
	total: count,
	satisfiedCount: 0,
	toleratingCount: 0,
	apdexScore: 0,
	estimatedSpanCount: 0,
})

const ROWS = [
	traceRow("2026-01-01 00:00:00", 2),
	traceRow("2026-01-01 00:05:00", 3),
	traceRow("2026-01-01 00:10:00", 5),
]

const makeStub = (counter: { n: number }): WarehouseQueryServiceApi =>
	({
		query: () => Effect.die(new Error("query not expected")),
		sqlQuery: () => {
			counter.n += 1
			return Effect.succeed(ROWS as never)
		},
		compiledQuery: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) => {
			counter.n += 1
			return compiled.decodeRows(ROWS).pipe(Effect.orDie)
		},
		compiledQueryWithCapabilities: <Output>(
			_tenant: unknown,
			compile: (
				capabilities: ReturnType<typeof baselineWarehouseCapabilities>,
			) => CompiledQuery<Output>,
		) => {
			counter.n += 1
			return compile(baselineWarehouseCapabilities()).decodeRows(ROWS).pipe(Effect.orDie)
		},
		compiledQueryFirst: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) => {
			counter.n += 1
			return compiled.decodeFirstRow(ROWS).pipe(Effect.orDie)
		},
		// Deliberately does not touch `counter`: warming resolves route config, it
		// does not issue a warehouse query, and these tests assert query counts.
		warmRoute: () => Effect.void,
		ingest: () => Effect.void,
		sql: () => Promise.resolve({ data: [] }),
	}) as WarehouseQueryServiceApi

const makeLayer = (
	counter: { n: number },
	edge: ReturnType<typeof makeObservedEdgeCache>,
	config = makeConfig(),
) =>
	QueryEngineService.layer.pipe(
		Layer.provide(Layer.succeed(WarehouseQueryService, makeStub(counter))),
		Layer.provide(edge.layer),
		Layer.provide(BucketCacheService.layer.pipe(Layer.provide(edge.layer))),
		Layer.provide(config),
	)

const timeseriesRequest = (overrides: Partial<{ startTime: string; endTime: string }> = {}) =>
	new QueryEngineExecuteRequest({
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 00:15:00",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			bucketSeconds: 300,
		} as QuerySpec,
		...overrides,
	})

describe("QueryEngineService.execute — cache path selection", () => {
	it.live("routes a normal dashboard timeseries request through the bucket cache", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const first = yield* qe.execute(tenant, timeseriesRequest())
			const second = yield* qe.execute(tenant, timeseriesRequest())

			assert.equal(
				edge.touched(BUCKET_NAMESPACE),
				true,
				"a plain timeseries widget must use the bucket cache",
			)
			assert.equal(
				edge.touched(BLOB_NAMESPACE),
				false,
				"it must not silently fall back to the whole-response blob cache",
			)
			// The repeat is fully covered, so it costs no warehouse work...
			assert.equal(counter.n, 1)
			// ...and returns exactly what the first call did.
			assert.deepEqual(second, first)
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("falls back to the blob cache for a non-timeseries query", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()
		const request = new QueryEngineExecuteRequest({
			startTime: "2026-01-01 00:00:00",
			endTime: "2026-01-01 00:15:00",
			query: {
				kind: "breakdown",
				source: "traces",
				metric: "count",
				groupBy: "service",
			} as QuerySpec,
		})

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.execute(tenant, request)

			assert.equal(edge.touched(BLOB_NAMESPACE), true)
			assert.equal(edge.touched(BUCKET_NAMESPACE), false)
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("falls back to the blob cache when the window is shorter than one bucket", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()
		// 5-minute buckets, but only a 1-minute window: there is no whole bucket
		// to cache, so the bucket path has nothing to offer.
		const request = timeseriesRequest({
			startTime: "2026-01-01 00:00:00",
			endTime: "2026-01-01 00:01:00",
		})

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.execute(tenant, request)

			assert.equal(edge.touched(BLOB_NAMESPACE), true)
			assert.equal(edge.touched(BUCKET_NAMESPACE), false)
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("falls back to the blob cache when the time range is inverted", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()
		const request = timeseriesRequest({
			startTime: "2026-01-01 00:15:00",
			endTime: "2026-01-01 00:00:00",
		})

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* Effect.exit(qe.execute(tenant, request))

			assert.equal(edge.touched(BUCKET_NAMESPACE), false)
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("uses the blob cache for every request when the bucket cache is disabled", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.execute(tenant, timeseriesRequest())

			assert.equal(edge.touched(BLOB_NAMESPACE), true)
			assert.equal(edge.touched(BUCKET_NAMESPACE), false)
		}).pipe(Effect.provide(makeLayer(counter, edge, makeConfig({ QE_BUCKET_CACHE_ENABLED: "false" }))))
	})
})

describe("QueryEngineService.execute — repeated dashboard load", () => {
	it.live("caches log count by canonical definition identity", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()
		const request = new QueryEngineExecuteRequest({
			startTime: "2026-01-01 00:00:00",
			endTime: "2026-01-01 00:15:00",
			query: { kind: "count", source: "logs", filters: { severity: "ERROR" } },
		})

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.execute(tenant, request)
			yield* qe.execute(tenant, request)

			assert.equal(edge.touched(BLOB_NAMESPACE), true)
			assert.equal(counter.n, 1, "the repeat must reuse the definition-level result cache")
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("costs one warehouse query no matter how many times the widget refreshes", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const responses = yield* Effect.forEach(
				Array.from({ length: 6 }, () => timeseriesRequest()),
				(request) => qe.execute(tenant, request),
			)

			assert.equal(counter.n, 1, "refreshing an unchanged widget must not re-query")
			// Every refresh returns the same data — a hit that drifted would be a
			// worse failure than a miss.
			for (const response of responses) {
				assert.deepEqual(response, responses[0])
			}
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})

	it.live("keeps two orgs on separate entries for an identical request", () => {
		const counter = { n: 0 }
		const edge = makeObservedEdgeCache()
		const otherTenant: TenantContext = { ...tenant, orgId: asOrgId("org_other") }

		return Effect.gen(function* () {
			const qe = yield* QueryEngineService
			yield* qe.execute(tenant, timeseriesRequest())
			yield* qe.execute(otherTenant, timeseriesRequest())

			// The second org must not be served from the first's entries.
			assert.equal(counter.n, 2)
		}).pipe(Effect.provide(makeLayer(counter, edge)))
	})
})
