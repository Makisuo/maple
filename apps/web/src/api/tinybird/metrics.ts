import { QueryEngineExecuteRequest, type MetricType } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { ListMetricsRequest, MetricsSummaryRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { mapleApiClientLayer } from "@/lib/registry"
import {
	TinybirdDateTimeString,
	TinybirdQueryError,
	decodeInput,
	executeQueryEngine,
	runTinybirdQuery,
} from "@/api/tinybird/effect-utils"
import { computeBucketSeconds } from "@/api/tinybird/timeseries-utils"

const MetricTypeSchema = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])

const ListMetricsInputSchema = Schema.Struct({
	limit: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
	),
	offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	service: Schema.optional(Schema.String),
	metricType: Schema.optional(MetricTypeSchema),
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
	search: Schema.optional(Schema.String),
})

export type ListMetricsInput = Schema.Schema.Type<typeof ListMetricsInputSchema>

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

export interface MetricsResponse {
	data: Metric[]
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
	const fallback = defaultTimeRange()

	const result = yield* runTinybirdQuery("listMetrics", () =>
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
	metricName: Schema.String,
	metricType: MetricTypeSchema,
	service: Schema.optional(Schema.String),
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type GetMetricTimeSeriesInput = Schema.Schema.Type<typeof GetMetricTimeSeriesInputSchema>

export interface MetricTimeSeriesPoint {
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
				new TinybirdQueryError({
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

const getMetricTimeSeriesEffect = Effect.fn("Tinybird.getMetricTimeSeries")(function* ({
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

	const [avgRes, sumRes, minRes, maxRes, countRes] = yield* Effect.all(
		[
			executeMetricsQueryEngine(makeRequest("avg")),
			executeMetricsQueryEngine(makeRequest("sum")),
			executeMetricsQueryEngine(makeRequest("min")),
			executeMetricsQueryEngine(makeRequest("max")),
			executeMetricsQueryEngine(makeRequest("count")),
		],
		{ concurrency: 5 },
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
	service: Schema.optional(Schema.String),
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetMetricsSummaryInput = Schema.Schema.Type<typeof GetMetricsSummaryInputSchema>

export interface MetricTypeSummary {
	metricType: string
	metricCount: number
	dataPointCount: number
}

export interface MetricsSummaryResponse {
	data: MetricTypeSummary[]
}

export function getMetricsSummary({ data }: { data: GetMetricsSummaryInput }) {
	return getMetricsSummaryEffect({ data })
}

const getMetricsSummaryEffect = Effect.fn("QueryEngine.getMetricsSummary")(function* ({
	data,
}: {
	data: GetMetricsSummaryInput
}) {
	const input = yield* decodeInput(GetMetricsSummaryInputSchema, data ?? {}, "getMetricsSummary")

	const fallback = defaultTimeRange()
	const result = yield* runTinybirdQuery("metricsSummary", () =>
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
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(Schema.String),
})

export type GetMetricAttributeKeysInput = Schema.Schema.Type<typeof GetMetricAttributeKeysInputSchema>

export function getMetricAttributeKeys({ data }: { data: GetMetricAttributeKeysInput }) {
	return getMetricAttributeKeysEffect({ data })
}

const defaultTimeRange = () => {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

const getMetricAttributeKeysEffect = Effect.fn("QueryEngine.getMetricAttributeKeys")(function* ({
	data,
}: {
	data: GetMetricAttributeKeysInput
}) {
	const input = yield* decodeInput(GetMetricAttributeKeysInputSchema, data ?? {}, "getMetricAttributeKeys")
	const fallback = defaultTimeRange()
	const request = new QueryEngineExecuteRequest({
		startTime: input.startTime ?? fallback.startTime,
		endTime: input.endTime ?? fallback.endTime,
		query: { kind: "attributeKeys" as const, source: "metrics" as const },
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
