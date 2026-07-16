import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { ListMetricsRequest, MetricName, MetricsSummaryRequest, ServiceName } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractAttributeValues,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

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

const GetMetricSparklinesInputSchema = Schema.Struct({
	metricType: MetricTypeSchema,
	// The runtime rejects requests with more than 50 names.
	metricNames: Schema.Array(MetricName),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type GetMetricSparklinesInput = (typeof GetMetricSparklinesInputSchema)["Encoded"]

export interface MetricSparklinePoint {
	bucket: string
	avgValue: number
	sumValue: number
	dataPointCount: number
}

export function getMetricSparklines({ data }: { data: GetMetricSparklinesInput }) {
	return getMetricSparklinesEffect({ data })
}

const getMetricSparklinesEffect = Effect.fn("QueryEngine.getMetricSparklines")(function* ({
	data,
}: {
	data: GetMetricSparklinesInput
}) {
	const input = yield* decodeInput(GetMetricSparklinesInputSchema, data, "getMetricSparklines")

	if (input.metricNames.length === 0) {
		return { data: [] as Array<{ metricName: string; points: MetricSparklinePoint[] }> }
	}

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const response = yield* executeQueryEngine(
		"queryEngine.getMetricSparklines",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "sparklines" as const,
				source: "metrics" as const,
				metricType: input.metricType,
				metricNames: input.metricNames,
				bucketSeconds: input.bucketSeconds,
			},
		}),
	)

	const result = response.result
	if (result.kind !== "sparklines") return { data: [] }

	return {
		data: result.data.map((series) => ({
			metricName: series.metricName,
			points: series.points.map((point) => ({
				bucket: point.bucket,
				avgValue: point.avgValue,
				sumValue: point.sumValue,
				dataPointCount: point.dataPointCount,
			})),
		})),
	}
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
