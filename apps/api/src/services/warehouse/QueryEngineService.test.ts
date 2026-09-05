// BOUNDARY: Test doubles mirror intentionally untyped external callbacks.
import { describe, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { strict as nodeAssert } from "node:assert"
import { MetricName, OrgId, ServiceName, UserId } from "@maple/domain"
import { RawSqlValidationError, WarehouseUpstreamError } from "@maple/domain/http"
import {
	baselineWarehouseCapabilities,
	type QueryEngineEvaluateRequest,
	type QueryEngineExecuteRequest,
	type QueryEngineResult,
	type TimeseriesPoint,
} from "@maple/query-engine"
import {
	makeQueryEngineEvaluate,
	makeQueryEngineExecute,
	withAlertEvaluationScope,
} from "@maple/query-engine/runtime"
import type { SqlQueryOptions } from "@maple/query-engine/profiles"
import type { CompiledQuery } from "@maple/query-engine/ch"
import type { TenantContext } from "@/services/auth/AuthService"
import { compiledQueryOf } from "@maple/query-engine/execution"

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
		spanCount: number
		estimatedSpanCount: number
	}> = {},
) => ({
	bucket: "2026-01-01 00:00:00",
	groupName: "checkout",
	count: 0,
	spanCount: 0,
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
	const rawSqlQuery = overrides.rawSqlQuery ?? sqlQuery

	return {
		...overrides,
		sqlQuery,
		rawSqlQuery,
		compiledQuery:
			overrides.compiledQuery ??
			((tenant, compiled, options) =>
				sqlQuery(tenant, compiledQueryOf(compiled).sql, options).pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				)),
		compiledQueryWithCapabilities:
			overrides.compiledQueryWithCapabilities ??
			((tenant, compile, options) => {
				const compiled = Effect.runSync(compile(baselineWarehouseCapabilities()))
				return sqlQuery(tenant, compiledQueryOf(compiled).sql, options).pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				)
			}),
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

	it.effect("executes log timeseries through its canonical definition", () =>
		Effect.gen(function* () {
			let context: string | undefined
			let profile: string | undefined
			let receivedSql = ""
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					compiledQueryWithCapabilities: <Output>(
						_tenant: unknown,
						compile: (
							capabilities: ReturnType<typeof baselineWarehouseCapabilities>,
						) => Effect.Effect<CompiledQuery<Output>, QueryBuilderError>,
						options?: SqlQueryOptions,
					) =>
						compile(baselineWarehouseCapabilities()).pipe(
							Effect.orDie,
							Effect.flatMap((compiled) => {
								receivedSql = compiledQueryOf(compiled).sql
								context = options?.context
								profile = options?.profile
								return compiled
									.decodeRows([makeTraceTimeseriesRow({ count: 7 })])
									.pipe(Effect.orDie)
							}),
						),
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "timeseries",
					source: "logs",
					metric: "count",
					groupBy: ["service"],
					bucketSeconds: 300,
				},
			})

			assert.strictEqual(context, "logsTimeseries")
			assert.strictEqual(profile, "aggregation")
			assert.include(receivedSql, "OrgId = 'org_test'")
			assert.deepStrictEqual(response.result, {
				kind: "timeseries",
				source: "logs",
				data: [
					{ bucket: "2026-01-01T00:00:00.000Z", series: { checkout: 7 } },
					{ bucket: "2026-01-01T00:05:00.000Z", series: {} },
				],
			})
		}),
	)

	it.effect("keeps log count execution policy on the definition", () =>
		Effect.gen(function* () {
			let context: string | undefined
			let profile: string | undefined
			let maxBlockSize: number | undefined
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					compiledQueryWithCapabilities: <Output>(
						_tenant: unknown,
						compile: (
							capabilities: ReturnType<typeof baselineWarehouseCapabilities>,
						) => Effect.Effect<CompiledQuery<Output>, QueryBuilderError>,
						options?: SqlQueryOptions,
					) =>
						compile(baselineWarehouseCapabilities()).pipe(
							Effect.orDie,
							Effect.flatMap((compiled) => {
								context = options?.context
								profile = options?.profile
								maxBlockSize = options?.settings?.maxBlockSize
								return compiledQueryOf(compiled)
									.decodeRows([{ total: 42 }])
									.pipe(Effect.orDie)
							}),
						),
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "count",
					source: "logs",
					filters: { search: "timeout" },
				},
			})

			assert.strictEqual(context, "logsCount")
			assert.strictEqual(profile, "discovery")
			assert.strictEqual(maxBlockSize, 512)
			assert.deepStrictEqual(response.result, {
				kind: "count",
				source: "logs",
				data: { total: 42 },
			})
		}),
	)

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
								groupName: "api",
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
								groupName: "worker",
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
								groupName: "api",
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
								groupName: "worker",
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

	it.effect("enriches opted-in trace-list rows with every service from the paged trace ids", () =>
		Effect.gen(function* () {
			const receivedSql: string[] = []
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) => {
						const query = String(sql)
						receivedSql.push(query)
						if (query.includes("FROM service_map_spans")) {
							return Effect.succeed([
								{
									traceId: "trace-1",
									services: ["gateway", "checkout", "payments"],
								},
							])
						}

						return Effect.succeed([
							{
								traceId: "trace-1",
								timestamp: "2026-01-01 00:01:00",
								spanId: "span-1",
								parentSpanId: "",
								serviceName: "gateway",
								spanName: "GET /checkout",
								durationMs: 120,
								statusCode: "Ok",
								spanKind: "Server",
								hasError: 0,
								spanAttributes: {},
								resourceAttributes: {},
							},
							{
								traceId: "trace-1",
								timestamp: "2026-01-01 00:02:00",
								spanId: "span-2",
								parentSpanId: "span-1",
								serviceName: "checkout",
								spanName: "charge",
								durationMs: 80,
								statusCode: "Ok",
								spanKind: "Server",
								hasError: 0,
								spanAttributes: {},
								resourceAttributes: {},
							},
							{
								traceId: "trace-2",
								timestamp: "2026-01-01 00:03:00",
								spanId: "span-3",
								parentSpanId: "",
								serviceName: "worker",
								spanName: "job",
								durationMs: 50,
								statusCode: "Ok",
								spanKind: "Internal",
								hasError: 0,
								spanAttributes: {},
								resourceAttributes: {},
							},
						])
					},
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "list",
					source: "traces",
					limit: 100,
					columns: ["services"],
					filters: { rootSpansOnly: true },
				},
			})

			assert.strictEqual(response.result.kind, "list")
			assert.deepStrictEqual(
				response.result.data.map((row) => row.services),
				[["gateway", "checkout", "payments"], ["gateway", "checkout", "payments"], ["worker"]],
			)
			assert.strictEqual(receivedSql.length, 2)
			const serviceSql = receivedSql[1] ?? ""
			assert.include(serviceSql, "FROM service_map_spans")
			assert.include(serviceSql, "TraceId IN ('trace-1', 'trace-2')")
			assert.include(serviceSql, "Timestamp >= '2025-12-31 00:01:00'")
			assert.include(serviceSql, "Timestamp <= '2026-01-02 00:03:00'")
		}),
	)

	it.effect("falls back to each row service when trace-list enrichment fails", () =>
		Effect.gen(function* () {
			const execute = makeQueryEngineExecute(
				makeTinybirdStub({
					sqlQuery: (_tenant: unknown, sql: unknown) =>
						String(sql).includes("FROM service_map_spans")
							? Effect.fail(
									new WarehouseUpstreamError({
										pipeName: "traceListServices",
										message: "temporary enrichment failure",
										upstreamStatus: 503,
									}),
								)
							: Effect.succeed([
									{
										traceId: "trace-1",
										timestamp: "2026-01-01 00:01:00",
										spanId: "span-1",
										parentSpanId: "",
										serviceName: "gateway",
										spanName: "GET /checkout",
										durationMs: 120,
										statusCode: "Ok",
										spanKind: "Server",
										hasError: 0,
										spanAttributes: {},
										resourceAttributes: {},
									},
								]),
				}),
			)

			const response = yield* execute(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				query: {
					kind: "list",
					source: "traces",
					columns: ["services"],
					filters: { rootSpansOnly: true },
				},
			})

			assert.strictEqual(response.result.kind, "list")
			assert.deepStrictEqual(response.result.data[0]?.services, ["gateway"])
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
	const countRequest: QueryEngineEvaluateRequest = {
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 00:05:00",
		reducer: "sum",
		sampleCountStrategy: "trace_count",
		source: {
			kind: "spec",
			query: { kind: "timeseries", source: "traces", metric: "count", bucketSeconds: 60 },
		},
	}
	const countRows = [
		makeTraceTimeseriesRow({ count: 10, spanCount: 1 }),
		makeTraceTimeseriesRow({ bucket: "2026-01-01 00:01:00", count: 20, spanCount: 2 }),
	]

	it.effect(
		"shares concurrent bucket reads across reducers while retaining their answers and actual sample counts",
		() =>
			Effect.gen(function* () {
				let calls = 0
				const evaluate = makeQueryEngineEvaluate(
					makeTinybirdStub({
						sqlQuery: () =>
							Effect.gen(function* () {
								calls++
								yield* Effect.yieldNow
								return countRows
							}),
					}),
				)
				const results = yield* withAlertEvaluationScope(
					Effect.all(
						[
							evaluate(tenant, countRequest),
							evaluate(
								{ ...tenant },
								{
									...countRequest,
									reducer: "max",
									source: {
										kind: "spec",
										query: {
											bucketSeconds: 60,
											metric: "count",
											source: "traces",
											kind: "timeseries",
										},
									},
								},
							),
						],
						{ concurrency: "unbounded" },
					),
				)
				assert.strictEqual(calls, 1)
				assert.strictEqual(results[0][0].value, 30)
				assert.strictEqual(results[1][0].value, 20)
				assert.strictEqual(results[0][0].sampleCount, 3)
				assert.strictEqual(results[1][0].sampleCount, 3)
			}),
	)

	it.effect("isolates invocation caches and leaves ordinary evaluations uncached", () =>
		Effect.gen(function* () {
			let calls = 0
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.sync(() => {
							calls++
							return countRows
						}),
				}),
			)
			const pair = Effect.all([evaluate(tenant, countRequest), evaluate(tenant, countRequest)], {
				concurrency: "unbounded",
			})
			yield* Effect.all([withAlertEvaluationScope(pair), withAlertEvaluationScope(pair)], {
				concurrency: "unbounded",
			})
			assert.strictEqual(calls, 2)
			yield* pair
			assert.strictEqual(calls, 4)
		}),
	)

	it.effect("separates tenants, warehouse instances, windows, and query metrics", () =>
		Effect.gen(function* () {
			let calls = 0
			const sqlQuery = () =>
				Effect.sync(() => {
					calls++
					return countRows
				})
			const evaluate = makeQueryEngineEvaluate(makeTinybirdStub({ sqlQuery }))
			const otherWarehouse = makeQueryEngineEvaluate(makeTinybirdStub({ sqlQuery }))
			yield* withAlertEvaluationScope(
				Effect.gen(function* () {
					yield* evaluate(tenant, countRequest)
					yield* evaluate({ ...tenant, orgId: asOrgId("org_other") }, countRequest)
					yield* otherWarehouse(tenant, countRequest)
					yield* evaluate(tenant, { ...countRequest, endTime: "2026-01-01 00:06:00" })
					yield* evaluate(tenant, {
						...countRequest,
						source: {
							kind: "spec",
							query: {
								kind: "timeseries",
								source: "traces",
								metric: "error_rate",
								bucketSeconds: 60,
							},
						},
					})
				}),
			)
			assert.strictEqual(calls, 5)
		}),
	)

	it.effect("does not retain a failed bucket lookup", () =>
		Effect.gen(function* () {
			let calls = 0
			const failure = new WarehouseUpstreamError({
				message: "temporarily unavailable",
				pipeName: "tracesAlertEval",
				upstreamStatus: 503,
			})
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.suspend(() =>
							++calls === 1 ? Effect.fail(failure) : Effect.succeed(countRows),
						),
				}),
			)
			yield* withAlertEvaluationScope(
				Effect.gen(function* () {
					assert(Exit.isFailure(yield* Effect.exit(evaluate(tenant, countRequest))))
					assert.strictEqual((yield* evaluate(tenant, countRequest))[0].value, 30)
				}),
			)
			assert.strictEqual(calls, 2)
		}),
	)

	it.effect("retries an interrupted lookup and expires successful results", () =>
		Effect.gen(function* () {
			let calls = 0
			const started = yield* Deferred.make<void>()
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.gen(function* () {
							calls++
							if (calls === 1) {
								yield* Deferred.succeed(started, undefined)
								return yield* Effect.never
							}
							return countRows
						}),
				}),
			)
			yield* withAlertEvaluationScope(
				Effect.gen(function* () {
					const running = yield* evaluate(tenant, countRequest).pipe(
						Effect.forkChild({ startImmediately: true }),
					)
					yield* Deferred.await(started)
					yield* Fiber.interrupt(running)
					assert.strictEqual((yield* evaluate(tenant, countRequest))[0].value, 30)
					assert.strictEqual(calls, 2)
					yield* evaluate(tenant, countRequest)
					assert.strictEqual(calls, 2)
					yield* TestClock.adjust("91 seconds")
					yield* evaluate(tenant, countRequest)
					assert.strictEqual(calls, 3)
				}),
			)
		}),
	)

	it.effect("bounds retained bucket results within a scheduler invocation", () =>
		Effect.gen(function* () {
			let calls = 0
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () =>
						Effect.sync(() => {
							calls++
							return countRows
						}),
				}),
			)
			yield* withAlertEvaluationScope(
				Effect.gen(function* () {
					yield* evaluate(tenant, countRequest)
					for (let second = 0; second < 32; second++) {
						yield* evaluate(tenant, {
							...countRequest,
							endTime: `2026-01-01 00:06:${String(second).padStart(2, "0")}`,
						})
					}
					yield* evaluate(tenant, countRequest)
				}),
			)
			assert.strictEqual(calls, 34)
		}),
	)

	it.effect("does not share potentially volatile raw SQL across reducers", () =>
		Effect.gen(function* () {
			let calls = 0
			const evaluate = makeQueryEngineEvaluate(
				makeTinybirdStub({
					rawSqlQuery: () =>
						Effect.sync(() => {
							calls++
							return [{ value: calls, samples: 1 }]
						}),
				}),
			)
			const request = {
				...countRequest,
				sampleCountStrategy: null,
				source: {
					kind: "raw_sql" as const,
					sql: "SELECT rand() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					windowMinutes: 5,
				},
			}
			yield* withAlertEvaluationScope(
				Effect.gen(function* () {
					yield* evaluate(tenant, request)
					yield* evaluate(tenant, { ...request, reducer: "max" })
				}),
			)
			assert.strictEqual(calls, 2)
		}),
	)

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
								spanCount: 200,
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
				source: {
					kind: "spec",
					query: {
						kind: "timeseries",
						source: "traces",
						metric: "error_rate",
						groupBy: ["none"],
					},
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
								spanCount: 40,
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
				source: {
					kind: "spec",
					query: {
						kind: "timeseries",
						source: "traces",
						metric: "apdex",
						groupBy: ["none"],
						apdexThresholdMs: 350,
					},
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
								groupName: "api",
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
				source: {
					kind: "spec",
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
				source: {
					kind: "spec",
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
				source: {
					kind: "spec",
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
				source: {
					kind: "spec",
					query: {
						kind: "timeseries",
						source: "logs",
						metric: "count",
						groupBy: ["service"],
						filters: {
							severity: "error",
						},
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

// Raw SQL now flows through the very same `evaluate` as every spec source.
describe("evaluate with a raw_sql source", () => {
	it.effect("translates raw warehouse limits once into the alert validation contract", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({
					rawSqlQuery: () =>
						Effect.fail(
							new RawSqlValidationError({
								code: "ResourceLimit",
								message: "Raw SQL results may contain at most 5000000 encoded bytes",
							}),
						),
				}),
			)

			const exit = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				source: {
					kind: "raw_sql",
					sql: "SELECT value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					windowMinutes: 5,
				},
				reducer: "identity",
				sampleCountStrategy: null,
			}).pipe(Effect.exit)
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit)) as
				| { readonly _tag?: string; readonly details?: ReadonlyArray<string> }
				| undefined

			assert.strictEqual(failure?._tag, "@maple/http/errors/QueryEngineValidationError")
			assert.deepStrictEqual(failure?.details, [
				"Raw SQL results may contain at most 5000000 encoded bytes",
			])
		}),
	)

	it.effect("groups raw SQL rows by the `group` column and reduces with the configured reducer", () =>
		Effect.gen(function* () {
			let profile: string | undefined
			let context: string | undefined
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({
					rawSqlQuery: (_tenant, _sql, options) => {
						profile = options?.profile
						context = options?.context
						return Effect.succeed([
							{ group: "checkout", value: 10, samples: 4 },
							{ group: "checkout", value: 30, samples: 6 },
							{ group: "payments", value: 5, samples: 2 },
						])
					},
				}),
			)

			const response = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				source: {
					kind: "raw_sql",
					sql: "SELECT group, value FROM otel_traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					windowMinutes: 5,
				},
				reducer: "max",
				sampleCountStrategy: null,
			})

			const byGroup = Object.fromEntries(response.map((o) => [o.groupKey, o]))
			assert.strictEqual(byGroup.checkout?.value, 30)
			assert.strictEqual(byGroup.checkout?.sampleCount, 10)
			assert.strictEqual(byGroup.checkout?.hasData, true)
			assert.strictEqual(byGroup.payments?.value, 5)
			assert.strictEqual(byGroup.payments?.sampleCount, 2)
			assert.strictEqual(byGroup.payments?.hasData, true)
			assert.strictEqual(profile, "rawAlert")
			assert.strictEqual(context, "alertRawQuery")
		}),
	)

	it.effect("rejects invalid sample counts returned by raw SQL", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () => Effect.succeed([{ value: 1, samples: -1 }]),
				}),
			)

			const exit = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				source: {
					kind: "raw_sql",
					sql: "SELECT value, samples FROM otel_traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					windowMinutes: 5,
				},
				reducer: "identity",
				sampleCountStrategy: null,
			}).pipe(Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit)) as
				| { details?: readonly string[] }
				| undefined
			assert.deepStrictEqual(failure?.details, [
				"Raw SQL alert samples must be finite and nonnegative.",
			])
		}),
	)

	it.effect("emits a single no-data observation when the query returns no rows", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({ sqlQuery: () => Effect.succeed([]) }),
			)

			const response = yield* evaluateRawSql(tenant, {
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 00:05:00",
				source: {
					kind: "raw_sql",
					sql: "SELECT value FROM otel_traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					windowMinutes: 5,
				},
				reducer: "identity",
				sampleCountStrategy: null,
			})

			assert.deepStrictEqual(response, [
				{ groupKey: "all", value: null, sampleCount: 0, hasData: false },
			])
		}),
	)

	it.effect("fails with a validation error when returned rows omit the value column", () =>
		Effect.gen(function* () {
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({
					sqlQuery: () => Effect.succeed([{ bucket: "2026-01-01 00:00:00", errors: 42 }]),
				}),
			)

			const exit = yield* Effect.exit(
				evaluateRawSql(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:05:00",
					source: {
						kind: "raw_sql",
						sql: "SELECT bucket, errors FROM otel_traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
						windowMinutes: 5,
					},
					reducer: "identity",
					sampleCountStrategy: null,
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
			const evaluateRawSql = makeQueryEngineEvaluate(
				makeTinybirdStub({ sqlQuery: () => Effect.die(new Error("should not run")) }),
			)

			const exit = yield* Effect.exit(
				evaluateRawSql(tenant, {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:05:00",
					source: {
						kind: "raw_sql",
						sql: "SELECT value FROM otel_traces",
						windowMinutes: 5,
					},
					reducer: "identity",
					sampleCountStrategy: null,
				}),
			)

			assert.isTrue(Exit.isFailure(exit))
		}),
	)
})
