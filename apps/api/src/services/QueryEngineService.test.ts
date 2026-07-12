import { describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import { strict as nodeAssert } from "node:assert"
import { MetricName, OrgId, ServiceName, UserId } from "@maple/domain"
import type {
	QueryEngineEvaluateRequest,
	QueryEngineExecuteRequest,
	QueryEngineResult,
	TimeseriesPoint,
} from "@maple/query-engine"
import {
	makeQueryEngineEvaluate,
	makeQueryEngineEvaluateRawSql,
	makeQueryEngineExecute,
} from "@maple/query-engine/runtime"
import type { TenantContext } from "./AuthService"

const assert: typeof nodeAssert & {
	isTrue: (value: unknown) => void
	isDefined: (value: unknown) => void
	include: (actual: string, expected: string) => void
} = Object.assign(nodeAssert, {
	isTrue: (value: unknown) => nodeAssert.strictEqual(value, true),
	isDefined: (value: unknown) => nodeAssert.notStrictEqual(value, undefined),
	include: (actual: string, expected: string) => nodeAssert.ok(actual.includes(expected)),
})

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asServiceName = Schema.decodeUnknownSync(ServiceName)
const asMetricName = Schema.decodeUnknownSync(MetricName)

const tenant: TenantContext = {
	orgId: asOrgId("org_test"),
	userId: asUserId("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const makeTraceTimeseriesRow = (
	overrides: Partial<{
		bucket: string
		groupName: string
		count: number
		avgDuration: number
		p50Duration: number
		p95Duration: number
		p99Duration: number
		errorRate: number
		satisfiedCount: number
		toleratingCount: number
		apdexScore: number
		estimatedSpanCount: number
	}> = {},
) => ({
	bucket: "2026-01-01 00:00:00",
	groupName: "checkout",
	count: 0,
	avgDuration: 0,
	p50Duration: 0,
	p95Duration: 0,
	p99Duration: 0,
	errorRate: 0,
	satisfiedCount: 0,
	toleratingCount: 0,
	apdexScore: 0,
	estimatedSpanCount: 0,
	...overrides,
})

function makeTinybirdStub(overrides: Partial<Parameters<typeof makeQueryEngineExecute>[0]> = {}) {
	const unexpected = (name: string) => () =>
		Effect.die(new Error(`Unexpected tinybird call in test: ${name}`))
	const sqlQuery = overrides.sqlQuery ?? unexpected("sqlQuery")

	return {
		sqlQuery,
		compiledQuery: (tenant, compiled, options) =>
			sqlQuery(tenant, compiled.sql, options).pipe(
				Effect.flatMap((rows) => compiled.decodeRows(rows).pipe(Effect.orDie)),
			),
		...overrides,
	} satisfies Parameters<typeof makeQueryEngineExecute>[0]
}

const timeseriesData = (result: QueryEngineResult): ReadonlyArray<TimeseriesPoint> => {
	if (result.kind !== "timeseries") {
		throw new Error(`expected timeseries result, got ${result.kind}`)
	}
	return result.data
}

describe("makeQueryEngineExecute", () => {
	const getFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
		Option.getOrUndefined(Exit.findErrorOption(exit))

	it.effect("fills missing buckets while preserving existing traces values", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							makeTraceTimeseriesRow({ count: 2 }),
							makeTraceTimeseriesRow({
								bucket: "2026-01-01 00:10:00",
								count: 5,
							}),
						]),
				}),
			)

			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:15:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					groupBy: ["service"],
					bucketSeconds: 300,
				},
			}

			const response = yield* execute(tenant, request)

			assert.strictEqual(response.result.kind, "timeseries")
			assert.strictEqual(response.result.source, "traces")
			const data = timeseriesData(response.result)
			assert.strictEqual(data.length, 4)
			assert.deepStrictEqual(data[0], {
				bucket: "2026-01-01T00:00:00.000Z",
				series: { checkout: 2 },
			})
			assert.deepStrictEqual(data[1], {
				bucket: "2026-01-01T00:05:00.000Z",
				series: {},
			})
			assert.deepStrictEqual(data[2], {
				bucket: "2026-01-01T00:10:00.000Z",
				series: { checkout: 5 },
			})
			assert.deepStrictEqual(data[3], {
				bucket: "2026-01-01T00:15:00.000Z",
				series: {},
			})
		}),
	)

	it.effect("preserves traces series when Tinybird buckets are datetime strings", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							makeTraceTimeseriesRow({ count: 2 }),
							makeTraceTimeseriesRow({
								bucket: "2026-01-01 00:10:00",
								count: 5,
							}),
						]),
				}),
			)

			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:15:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					groupBy: ["service"],
					bucketSeconds: 300,
				},
			}

			const response = yield* execute(tenant, request)

			assert.strictEqual(response.result.kind, "timeseries")
			assert.strictEqual(response.result.source, "traces")
			const data = timeseriesData(response.result)
			assert.strictEqual(data.length, 4)
			assert.deepStrictEqual(data[0], {
				bucket: "2026-01-01T00:00:00.000Z",
				series: { checkout: 2 },
			})
			assert.deepStrictEqual(data[1], {
				bucket: "2026-01-01T00:05:00.000Z",
				series: {},
			})
			assert.deepStrictEqual(data[2], {
				bucket: "2026-01-01T00:10:00.000Z",
				series: { checkout: 5 },
			})
			assert.deepStrictEqual(data[3], {
				bucket: "2026-01-01T00:15:00.000Z",
				series: {},
			})
		}),
	)

	it.effect("preserves grouped all-metrics rows in one bucket", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							makeTraceTimeseriesRow({
								groupName: "checkout",
								count: 3,
								p95Duration: 25,
								errorRate: 0.1,
								apdexScore: 0.95,
								estimatedSpanCount: 6,
							}),
							makeTraceTimeseriesRow({
								groupName: "payments",
								count: 7,
								p95Duration: 50,
								errorRate: 0.2,
								apdexScore: 0.9,
								estimatedSpanCount: 14,
							}),
						]),
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					allMetrics: true,
					groupBy: ["service"],
					bucketSeconds: 300,
				},
			})

			assert.strictEqual(response.result.kind, "timeseries")
			const data = timeseriesData(response.result)
			assert.deepStrictEqual(data[0]?.series, {
				"count::checkout": 3,
				"avg_duration::checkout": 0,
				"p50_duration::checkout": 0,
				"p95_duration::checkout": 25,
				"p99_duration::checkout": 0,
				"error_rate::checkout": 0.1,
				"apdex::checkout": 0.95,
				"estimated_span_count::checkout": 6,
				"count::payments": 7,
				"avg_duration::payments": 0,
				"p50_duration::payments": 0,
				"p95_duration::payments": 50,
				"p99_duration::payments": 0,
				"error_rate::payments": 0.2,
				"apdex::payments": 0.9,
				"estimated_span_count::payments": 14,
			})
		}),
	)

	it.effect("rejects timeseries requests that exceed the point budget", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(makeTinybirdStub())
			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:33:21",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					bucketSeconds: 1,
				},
			}

			const exit = yield* Effect.exit(execute(tenant, request))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/QueryEngineValidationError")
			assert.strictEqual(failure?.message, "Timeseries query too expensive")
		}),
	)

	it.effect("rejects invalid traces attribute grouping when attribute key is missing", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(makeTinybirdStub())
			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					groupBy: ["attribute"],
				},
			}

			const exit = yield* Effect.exit(execute(tenant, request))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/QueryEngineValidationError")
			assert.strictEqual(failure?.message, "Invalid traces attribute filters")
		}),
	)

	it.effect("forwards http method grouping for traces timeseries", () =>
		Effect.gen(function* () {
			let receivedSql: string | undefined

			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						receivedSql = sql as string
						return Effect.succeed([
							makeTraceTimeseriesRow({
								groupName: "GET",
								count: 3,
							}),
						])
					},
				}),
			)

			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					groupBy: ["http_method"],
					bucketSeconds: 300,
				},
			}

			const response = yield* execute(tenant, request)

			assert.include(receivedSql ?? "", "http.method")
			assert.deepStrictEqual(response.result, {
				kind: "timeseries",
				source: "traces",
				data: [
					{
						bucket: "2026-01-01T00:00:00.000Z",
						series: { GET: 3 },
					},
					{
						bucket: "2026-01-01T00:05:00.000Z",
						series: {},
					},
				],
			})
		}),
	)

	it.effect("routes metric-scoped attributeKeys to the raw metric table", () =>
		Effect.gen(function* () {
			let receivedSql: string | undefined

			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						receivedSql = sql as string
						return Effect.succeed([{ attributeKey: "region", usageCount: 12 }])
					},
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "attributeKeys",
					source: "metrics",
					metricName: "http.server.duration",
					metricType: "gauge",
				},
			})

			assert.include(receivedSql ?? "", "metrics_gauge")
			assert.include(receivedSql ?? "", "arrayJoin(mapKeys(Attributes))")
			assert.include(receivedSql ?? "", "MetricName = 'http.server.duration'")
			assert.deepStrictEqual(response.result, {
				kind: "attributeKeys",
				source: "metrics",
				data: [{ key: "region", count: 12 }],
			})
		}),
	)

	it.effect("keeps unscoped metrics attributeKeys on the hourly rollup", () =>
		Effect.gen(function* () {
			let receivedSql: string | undefined

			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						receivedSql = sql as string
						return Effect.succeed([{ attributeKey: "region", usageCount: 12 }])
					},
				}),
			)

			yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: { kind: "attributeKeys", source: "metrics" },
			})

			assert.include(receivedSql ?? "", "attribute_keys_hourly")
			assert.include(receivedSql ?? "", "AttributeScope = 'metric'")
		}),
	)

	it.effect("routes metric-scoped attributeValues to the raw metric table", () =>
		Effect.gen(function* () {
			let receivedSql: string | undefined

			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						receivedSql = sql as string
						return Effect.succeed([{ attributeValue: "eu-west-1", usageCount: 7 }])
					},
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "attributeValues",
					source: "metrics",
					scope: "metric",
					attributeKey: "region",
					metricName: "http.server.duration",
					metricType: "sum",
				},
			})

			assert.include(receivedSql ?? "", "metrics_sum")
			assert.include(receivedSql ?? "", "Attributes['region']")
			assert.include(receivedSql ?? "", "MetricName = 'http.server.duration'")
			assert.deepStrictEqual(response.result, {
				kind: "attributeValues",
				source: "metrics",
				data: [{ value: "eu-west-1", count: 7 }],
			})
		}),
	)

	it.effect("maps apdex traces execution and forwards the apdex threshold", () =>
		Effect.gen(function* () {
			let receivedSql: string | undefined

			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						receivedSql = sql as string
						return Effect.succeed([
							makeTraceTimeseriesRow({
								count: 20,
								satisfiedCount: 15,
								toleratingCount: 2,
								apdexScore: 0.8,
							}),
						])
					},
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "apdex",
					groupBy: ["service"],
					bucketSeconds: 300,
					apdexThresholdMs: 300,
				},
			})

			assert.include(receivedSql ?? "", "300")
			assert.include(receivedSql ?? "", "apdexScore")
			assert.deepStrictEqual(response.result, {
				kind: "timeseries",
				source: "traces",
				data: [
					{
						bucket: "2026-01-01T00:00:00.000Z",
						series: { checkout: 0.8 },
					},
					{
						bucket: "2026-01-01T00:05:00.000Z",
						series: {},
					},
				],
			})
		}),
	)

	it.effect("aggregates metrics timeseries into an all series when groupBy=none", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								serviceName: "api",
								attributeValue: "",
								avgValue: 10,
								minValue: 5,
								maxValue: 20,
								sumValue: 30,
								dataPointCount: 3,
							},
							{
								bucket: "2026-01-01 00:00:00",
								serviceName: "worker",
								attributeValue: "",
								avgValue: 20,
								minValue: 10,
								maxValue: 40,
								sumValue: 40,
								dataPointCount: 2,
							},
						]),
				}),
			)

			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["none"],
					bucketSeconds: 300,
					filters: {
						metricName: asMetricName("request.duration"),
						metricType: "histogram",
					},
				},
			}

			const response = yield* execute(tenant, request)

			assert.deepStrictEqual(response.result, {
				kind: "timeseries",
				source: "metrics",
				data: [
					{
						bucket: "2026-01-01T00:00:00.000Z",
						series: { all: 14 },
					},
					{
						bucket: "2026-01-01T00:05:00.000Z",
						series: {},
					},
				],
			})
		}),
	)

	it.effect("preserves per-service metrics timeseries when groupBy=service", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								serviceName: "api",
								attributeValue: "",
								avgValue: 10,
								minValue: 10,
								maxValue: 10,
								sumValue: 10,
								dataPointCount: 1,
							},
							{
								bucket: "2026-01-01 00:00:00",
								serviceName: "worker",
								attributeValue: "",
								avgValue: 20,
								minValue: 20,
								maxValue: 20,
								sumValue: 20,
								dataPointCount: 1,
							},
						]),
				}),
			)

			const request: QueryEngineExecuteRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["service"],
					bucketSeconds: 300,
					filters: {
						metricName: asMetricName("cpu.usage"),
						metricType: "gauge",
					},
				},
			}

			const response = yield* execute(tenant, request)

			assert.deepStrictEqual(response.result, {
				kind: "timeseries",
				source: "metrics",
				data: [
					{
						bucket: "2026-01-01T00:00:00.000Z",
						series: { api: 10, worker: 20 },
					},
					{
						bucket: "2026-01-01T00:05:00.000Z",
						series: {},
					},
				],
			})
		}),
	)

	it.effect("rejects breakdown queries beyond a 30-day range", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () => Effect.die(new Error("should not be called")),
				}),
			)

			const exit = yield* Effect.exit(
				execute(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-31 12:00:00", // 30.5 days — between breakdown cap (30d) and global cap (31d)
					query: {
						kind: "breakdown",
						source: "traces",
						metric: "count",
						groupBy: "service",
						filters: { serviceName: asServiceName("checkout") },
					},
				}),
			)

			const failure = getFailure(exit)
			assert.isDefined(failure)
			assert.include(
				(failure as { message?: string })?.message ?? "",
				"Breakdown query time range too large",
			)
		}),
	)

	it.effect("rejects breakdown queries over 24h with no narrowing filter", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () => Effect.die(new Error("should not be called")),
				}),
			)

			const exit = yield* Effect.exit(
				execute(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-05 00:00:00", // 4 days, no filters
					query: {
						kind: "breakdown",
						source: "traces",
						metric: "count",
						groupBy: "service",
					},
				}),
			)

			const failure = getFailure(exit)
			assert.isDefined(failure)
			assert.include(
				(failure as { message?: string })?.message ?? "",
				"Breakdown query too broad without filters",
			)
		}),
	)

	it.effect("allows breakdown queries over 24h when a serviceName filter is present", () =>
		Effect.gen(function* () {
			let called = false
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: () => {
						called = true
						return Effect.succeed([])
					},
				}),
			)

			yield* Effect.exit(
				execute(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-05 00:00:00",
					query: {
						kind: "breakdown",
						source: "traces",
						metric: "count",
						groupBy: "service",
						filters: { serviceName: asServiceName("checkout") },
					},
				}),
			)

			assert.isTrue(called)
		}),
	)
})

describe("makeQueryEngineEvaluate", () => {
	// The evaluate path now drives the same dashboard timeseries queries the
	// widget renderer uses, so stub rows always carry `bucket` + `groupName`.
	// Ungrouped alerts collapse to a single-element array with groupKey "all".

	it.effect("evaluates traces error rate alerts from the aggregate path", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								groupName: "all",
								count: 200,
								avgDuration: 12,
								p50Duration: 10,
								p95Duration: 120,
								p99Duration: 240,
								errorRate: 7.5,
								satisfiedCount: 180,
								toleratingCount: 10,
								apdexScore: 0.925,
								estimatedSpanCount: 200,
							},
						]),
				}),
			)

			const request: QueryEngineEvaluateRequest = {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "trace_count",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "error_rate",
					groupBy: ["none"],
				},
			}

			const response = yield* evaluate(tenant, request)

			assert.strictEqual(response.length, 1)
			assert.strictEqual(response[0]?.groupKey, "all")
			assert.strictEqual(response[0]?.value, 7.5)
			assert.strictEqual(response[0]?.sampleCount, 200)
			assert.strictEqual(response[0]?.hasData, true)
		}),
	)

	it.effect("evaluates traces apdex alerts and returns correct value", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								groupName: "all",
								count: 40,
								avgDuration: 0,
								p50Duration: 0,
								p95Duration: 0,
								p99Duration: 0,
								errorRate: 0,
								satisfiedCount: 30,
								toleratingCount: 6,
								apdexScore: 0.825,
								estimatedSpanCount: 40,
							},
						]),
				}),
			)

			const response = yield* evaluate(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "trace_count",
				query: {
					kind: "timeseries",
					source: "traces",
					metric: "apdex",
					groupBy: ["none"],
					apdexThresholdMs: 350,
				},
			})

			assert.strictEqual(response.length, 1)
			assert.strictEqual(response[0]?.value, 0.825)
			assert.strictEqual(response[0]?.sampleCount, 40)
		}),
	)

	it.effect("evaluates metrics alerts with metric data point sample counts", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								serviceName: "api",
								attributeValue: "",
								avgValue: 18,
								minValue: 5,
								maxValue: 40,
								sumValue: 90,
								dataPointCount: 5,
							},
						]),
				}),
			)

			const response = yield* evaluate(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "metric_data_points",
				query: {
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					groupBy: ["none"],
					filters: {
						metricName: asMetricName("cpu.usage"),
						metricType: "gauge",
					},
				},
			})

			assert.strictEqual(response.length, 1)
			assert.strictEqual(response[0]?.groupKey, "all")
			assert.strictEqual(response[0]?.value, 18)
			assert.strictEqual(response[0]?.sampleCount, 5)
			assert.strictEqual(response[0]?.hasData, true)
		}),
	)

	it.effect("returns hasData=false when the aggregate response has zero samples", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () => Effect.succeed([]),
				}),
			)

			const response = yield* evaluate(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "metric_data_points",
				query: {
					kind: "timeseries",
					source: "metrics",
					metric: "sum",
					groupBy: ["none"],
					filters: {
						metricName: asMetricName("requests"),
						metricType: "sum",
					},
				},
			})

			assert.strictEqual(response.length, 1)
			assert.strictEqual(response[0]?.groupKey, "all")
			assert.strictEqual(response[0]?.value, null)
			assert.strictEqual(response[0]?.sampleCount, 0)
			assert.strictEqual(response[0]?.hasData, false)
		}),
	)

	it.effect("evaluates logs alerts with log-count sample counts", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								groupName: "all",
								count: 42,
							},
						]),
				}),
			)

			const response = yield* evaluate(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "log_count",
				query: {
					kind: "timeseries",
					source: "logs",
					metric: "count",
					groupBy: ["none"],
					filters: {
						serviceName: asServiceName("checkout"),
						severity: "error",
					},
				},
			})

			assert.strictEqual(response.length, 1)
			assert.strictEqual(response[0]?.groupKey, "all")
			assert.strictEqual(response[0]?.value, 42)
			assert.strictEqual(response[0]?.sampleCount, 42)
			assert.strictEqual(response[0]?.hasData, true)
		}),
	)

	it.effect("evaluates grouped logs alerts per service", () =>
		Effect.gen(function* () {
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{
								bucket: "2026-01-01 00:00:00",
								groupName: "checkout",
								count: 11,
							},
							{
								bucket: "2026-01-01 00:00:00",
								groupName: "billing",
								count: 3,
							},
						]),
				}),
			)

			const response = yield* evaluate(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				reducer: "identity",
				sampleCountStrategy: "log_count",
				query: {
					kind: "timeseries",
					source: "logs",
					metric: "count",
					groupBy: ["service"],
					filters: {
						severity: "error",
					},
				},
			})

			assert.deepStrictEqual(response, [
				{
					groupKey: "checkout",
					value: 11,
					sampleCount: 11,
					hasData: true,
				},
				{
					groupKey: "billing",
					value: 3,
					sampleCount: 3,
					hasData: true,
				},
			])
		}),
	)
})

describe("makeQueryEngineEvaluateRawSql", () => {
	it.effect("groups raw SQL rows by the `group` column and reduces with the configured reducer", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluateRawSql(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.succeed([
							{ group: "checkout", value: 10, samples: 4 },
							{ group: "checkout", value: 30, samples: 6 },
							{ group: "payments", value: 5, samples: 2 },
						]),
				}),
			)

			const response = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				sql: "SELECT group, value FROM otel_traces WHERE $__orgFilter",
				reducer: "max",
				windowMinutes: 5,
			})

			const byGroup = Object.fromEntries(response.map((o) => [o.groupKey, o]))
			assert.strictEqual(byGroup.checkout?.value, 30)
			assert.strictEqual(byGroup.checkout?.sampleCount, 10)
			assert.strictEqual(byGroup.checkout?.hasData, true)
			assert.strictEqual(byGroup.payments?.value, 5)
			assert.strictEqual(byGroup.payments?.sampleCount, 2)
			assert.strictEqual(byGroup.payments?.hasData, true)
		}),
	)

	it.effect("emits a single no-data observation when the query returns no rows", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluateRawSql(
				makeTinybirdStub({ sqlQuery: () => Effect.succeed([]) }),
			)

			const response = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				sql: "SELECT value FROM otel_traces WHERE $__orgFilter",
				reducer: "identity",
				windowMinutes: 5,
			})

			assert.deepStrictEqual(response, [
				{ groupKey: "all", value: null, sampleCount: 0, hasData: false },
			])
		}),
	)

	it.effect("fails with a validation error when returned rows omit the value column", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluateRawSql(
				makeTinybirdStub({
					sqlQuery: () => Effect.succeed([{ bucket: "2026-01-01 00:00:00", errors: 42 }]),
				}),
			)

			const exit = yield* Effect.exit(
				evaluateRawSql(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:05:00",
					sql: "SELECT bucket, errors FROM otel_traces WHERE $__orgFilter",
					reducer: "identity",
					windowMinutes: 5,
				}),
			)
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit)) as
				| { _tag?: string; message?: string; details?: readonly string[] }
				| undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/QueryEngineValidationError")
			assert.strictEqual(failure?.message, "Invalid raw SQL alert query")
			assert.deepStrictEqual(failure?.details, [
				"Raw SQL alert queries must return a column named value.",
			])
		}),
	)

	it.effect("fails with a validation error when the SQL omits $__orgFilter", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluateRawSql(
				makeTinybirdStub({ sqlQuery: () => Effect.die(new Error("should not run")) }),
			)

			const exit = yield* Effect.exit(
				evaluateRawSql(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:05:00",
					sql: "SELECT value FROM otel_traces",
					reducer: "identity",
					windowMinutes: 5,
				}),
			)

			assert.isTrue(Exit.isFailure(exit))
		}),
	)
})
