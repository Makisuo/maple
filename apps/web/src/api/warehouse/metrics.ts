import { QueryEngineExecuteRequest, type MetricType } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { ListMetricsRequest, MetricName, MetricsSummaryRequest, ServiceName } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { mapleApiClientLayer } from "@/lib/registry"
import {
	WarehouseDateTimeString,
	WarehouseQueryError,
	decodeInput,
	executeQueryEngine,
	extractAttributeValues,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"
import { computeBucketSeconds } from "@/api/warehouse/timeseries-utils"

const MetricTypeSchema = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])

const ListMetricsInputSchema = Schema.Struct({
	limit: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
	),
	offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	service: Schema.optional(ServiceName),
	metricType: Schema.optional(MetricTypeSchema),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	search: Schema.optional(Schema.String),
})

export type ListMetricsInput = (typeof ListMetricsInputSchema)["Encoded"]

export interface Metric {
	metricName: string
	metricType: string
	serviceName: string
	metricDescription: string
	metricUnit: string
	dataPointCount: number
	firstSeen: string
	lastSeen: string
	isMonotonic: boolean
}

function transformMetric(raw: Record<string, unknown>): Metric {
	return {
		metricName: String(raw.metricName ?? ""),
		metricType: String(raw.metricType ?? ""),
		serviceName: String(raw.serviceName ?? ""),
		metricDescription: String(raw.metricDescription ?? ""),
		metricUnit: String(raw.metricUnit ?? ""),
		dataPointCount: Number(raw.dataPointCount ?? 0),
		firstSeen: String(raw.firstSeen ?? ""),
		lastSeen: String(raw.lastSeen ?? ""),
		isMonotonic: Boolean(raw.isMonotonic),
	}
}

export function listMetrics({ data }: { data: ListMetricsInput }) {
	return listMetricsEffect({ data })
}

const listMetricsEffect = Effect.fn("QueryEngine.listMetrics")(function* ({
	data,
}: {
	data: ListMetricsInput
}) {
	const input = yield* decodeInput(ListMetricsInputSchema, data ?? {}, "listMetrics")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("listMetrics", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.listMetrics({
				payload: new ListMetricsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					limit: input.limit,
					offset: input.offset,
					service: input.service,
					metricType: input.metricType,
					search: input.search,
				}),
			})
		}),
	)

	return {
		data: result.data.map(transformMetric),
	}
})

const GetMetricTimeSeriesInputSchema = Schema.Struct({
	metricName: MetricName,
	metricType: MetricTypeSchema,
	service: Schema.optional(ServiceName),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type GetMetricTimeSeriesInput = (typeof GetMetricTimeSeriesInputSchema)["Encoded"]

interface MetricTimeSeriesPoint {
	bucket: string
	serviceName: string
	attributeValue: string
	avgValue: number
	minValue: number
	maxValue: number
	sumValue: number
	dataPointCount: number
}

export interface MetricTimeSeriesResponse {
	data: MetricTimeSeriesPoint[]
}

function toMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback
}

function executeMetricsQueryEngine(payload: QueryEngineExecuteRequest) {
	return Effect.gen(function* () {
		const client = yield* MapleApiAtomClient
		return yield* client.queryEngine.execute({
			payload: new QueryEngineExecuteRequest(payload),
		})
	}).pipe(
		Effect.provide(mapleApiClientLayer),
		Effect.mapError(
			(cause) =>
				new WarehouseQueryError({
					operation: "queryEngine.execute",
					message: toMessage(cause, "Metrics query engine request failed"),
					cause,
				}),
		),
	)
}

export function getMetricTimeSeries({ data }: { data: GetMetricTimeSeriesInput }) {
	return getMetricTimeSeriesEffect({ data })
}

const getMetricTimeSeriesEffect = Effect.fn("QueryEngine.getMetricTimeSeries")(function* ({
	data,
}: {
	data: GetMetricTimeSeriesInput
}) {
	const input = yield* decodeInput(GetMetricTimeSeriesInputSchema, data, "getMetricTimeSeries")

	const bucketSeconds = input.bucketSeconds ?? computeBucketSeconds(input.startTime, input.endTime)

	const makeRequest = (metric: string) =>
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? "2020-01-01 00:00:00",
			endTime: input.endTime ?? "2099-12-31 23:59:59",
			query: {
				kind: "timeseries" as const,
				source: "metrics" as const,
				metric: metric as any,
				groupBy: ["service"],
				filters: {
					metricName: input.metricName,
					metricType: input.metricType as MetricType,
					serviceName: input.service,
				},
				bucketSeconds,
			},
		})

	// The five aggregation queries fan out concurrently; wrap them in their own
	// span so the per-metric work is traceable and annotated, rather than landing
	// untracked under the parent. orgId is resolved server-side (not available
	// here), so we annotate the metric identifiers we do have.
	const [avgRes, sumRes, minRes, maxRes, countRes] = yield* Effect.all(
		[
			executeMetricsQueryEngine(makeRequest("avg")),
			executeMetricsQueryEngine(makeRequest("sum")),
			executeMetricsQueryEngine(makeRequest("min")),
			executeMetricsQueryEngine(makeRequest("max")),
			executeMetricsQueryEngine(makeRequest("count")),
		],
		{ concurrency: 5 },
	).pipe(
		Effect.withSpan("warehouse.metrics.getMetricTimeSeries", {
			attributes: {
				metricName: input.metricName,
				metricType: input.metricType,
				...(input.service ? { service: input.service } : {}),
				aggregations: "avg,sum,min,max,count",
				bucketSeconds,
			},
		}),
	)

	// Build a map of bucket::service -> { avg, sum, min, max, count }
	const valueMap = new Map<string, MetricTimeSeriesPoint>()

	const processResult = (
		res: typeof avgRes,
		field: keyof Pick<
			MetricTimeSeriesPoint,
			"avgValue" | "sumValue" | "minValue" | "maxValue" | "dataPointCount"
		>,
	) => {
		if (res.result.kind !== "timeseries") return
		for (const point of res.result.data) {
			const bucket = point.bucket
			for (const [serviceName, value] of Object.entries(point.series)) {
				const key = `${bucket}::${serviceName}`
				let row = valueMap.get(key)
				if (!row) {
					row = {
						bucket,
						serviceName,
						attributeValue: "",
						avgValue: 0,
						minValue: 0,
						maxValue: 0,
						sumValue: 0,
						dataPointCount: 0,
					}
					valueMap.set(key, row)
				}
				;(row as any)[field] = Number(value)
			}
		}
	}

	processResult(avgRes, "avgValue")
	processResult(sumRes, "sumValue")
	processResult(minRes, "minValue")
	processResult(maxRes, "maxValue")
	processResult(countRes, "dataPointCount")

	const rows = Array.from(valueMap.values()).toSorted((a, b) => a.bucket.localeCompare(b.bucket))

	return { data: rows }
})

const GetMetricsSummaryInputSchema = Schema.Struct({
	service: Schema.optional(ServiceName),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetMetricsSummaryInput = (typeof GetMetricsSummaryInputSchema)["Encoded"]

export function getMetricsSummary({ data }: { data: GetMetricsSummaryInput }) {
	return getMetricsSummaryEffect({ data })
}

const getMetricsSummaryEffect = Effect.fn("QueryEngine.getMetricsSummary")(function* ({
	data,
}: {
	data: GetMetricsSummaryInput
}) {
	const input = yield* decodeInput(GetMetricsSummaryInputSchema, data ?? {}, "getMetricsSummary")

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("metricsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.metricsSummary({
				payload: new MetricsSummaryRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					service: input.service,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			metricType: raw.metricType,
			metricCount: Number(raw.metricCount),
			dataPointCount: Number(raw.dataPointCount),
		})),
	}
})

const GetMetricAttributeKeysInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(MetricTypeSchema),
})

export type GetMetricAttributeKeysInput = Schema.Schema.Type<typeof GetMetricAttributeKeysInputSchema>

export function getMetricAttributeKeys({ data }: { data: GetMetricAttributeKeysInput }) {
	return getMetricAttributeKeysEffect({ data })
}

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

const getMetricAttributeKeysEffect = Effect.fn("QueryEngine.getMetricAttributeKeys")(function* ({
	data,
}: {
	data: GetMetricAttributeKeysInput
}) {
	const input = yield* decodeInput(GetMetricAttributeKeysInputSchema, data ?? {}, "getMetricAttributeKeys")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? fallback.startTime,
		endTime: input.endTime ?? fallback.endTime,
		query: {
			kind: "attributeKeys" as const,
			source: "metrics" as const,
			metricName: input.metricName,
			metricType: input.metricType,
		},
	})
	const response = yield* executeQueryEngine("queryEngine.getMetricAttributeKeys", request)
	const result = response.result
	if (result.kind !== "attributeKeys") return { data: [] }

	return {
		data: result.data.map((row) => ({
			attributeKey: row.key,
			usageCount: Number(row.count),
		})),
	}
})

const GetMetricAttributeValuesInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	attributeKey: Schema.String,
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(MetricTypeSchema),
})

export type GetMetricAttributeValuesInput = Schema.Schema.Type<typeof GetMetricAttributeValuesInputSchema>

export function getMetricAttributeValues({ data }: { data: GetMetricAttributeValuesInput }) {
	return getMetricAttributeValuesEffect({ data })
}

const getMetricAttributeValuesEffect = Effect.fn("QueryEngine.getMetricAttributeValues")(function* ({
	data,
}: {
	data: GetMetricAttributeValuesInput
}) {
	const input = yield* decodeInput(GetMetricAttributeValuesInputSchema, data ?? {}, "getMetricAttributeValues")

	yield* Effect.annotateCurrentSpan("attributeKey", input.attributeKey)

	if (!input.attributeKey) {
		return { data: [] }
	}

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getMetricAttributeValues",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "attributeValues" as const,
				source: "metrics" as const,
				scope: "metric" as const,
				attributeKey: input.attributeKey,
				metricName: input.metricName,
				metricType: input.metricType,
			},
		}),
	)

	return {
		data: extractAttributeValues(response).map((row) => ({
			attributeValue: row.value,
			usageCount: Number(row.count),
		})),
	}
})
