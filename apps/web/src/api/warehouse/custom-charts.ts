import {
	QueryEngineExecuteRequest,
	type MetricsMetric,
	type QueryEngineExecuteResponse,
	type QuerySpec,
	type TracesMetric,
} from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"

import {
	buildBucketTimeline,
	computeBucketSeconds,
	firstFullBucketIso,
	toIsoBucket,
	trimSparseLeadingBuckets,
} from "@/api/warehouse/timeseries-utils"
import {
	CommitSha,
	DeploymentEnvironment,
	MetricName,
	ServiceDetailOverviewRequest,
	ServiceName,
	ServiceNamespace,
	SpanName,
} from "@maple/domain/http"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	invalidWarehouseInput,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import type { ServiceDetailTimeSeriesPoint, ServiceTimeSeriesPoint } from "@/api/warehouse/services"
const dateTimeString = WarehouseDateTimeString

const asMetricName = Schema.decodeUnknownSync(MetricName)
const asServiceName = Schema.decodeUnknownSync(ServiceName)
const asDeploymentEnv = Schema.decodeUnknownSync(DeploymentEnvironment)

/**
 * Map the service list's synthetic `"unknown"` environment label back to the raw
 * empty-string `DeploymentEnv` value the warehouse actually stores (see
 * `coerceRow` in `services.ts`, which coerces `"" -> "unknown"` for display).
 * Without this, scoping a detail page to an `"unknown"` row would emit
 * `DeploymentEnv IN ('unknown')` and match nothing.
 */
const toEnvFilter = (
	environments: ReadonlyArray<DeploymentEnvironment> | undefined,
): ReadonlyArray<DeploymentEnvironment> | undefined =>
	environments?.map((e) => (e === "unknown" ? asDeploymentEnv("") : e))

// SpanMetrics connector metric names — namespaced first, then default. Both are
// matched in a single `MetricName IN (...)` query (see `querySpanMetricsCalls`),
// so no separate catalog round-trip is needed to discover which one an org emits.
const SPANMETRICS_CALLS_CANDIDATES = ["span.metrics.calls", "calls"] as const

/**
 * Per-bucket exact pre-sampling throughput from the OTel SpanMetrics Connector
 * `calls` counter. Resolves the counter under either known spelling via a single
 * `IN (...)` filter (no `listMetrics` preflight). Returns flat
 * `{ bucket, serviceName, sumValue }` rows; callers aggregate as needed.
 *
 * This is the slow path (raw `metrics_sum` window scan at sub-hour buckets), so
 * it is only ever invoked from the sampling-gated refinement effects below — not
 * on a chart's first-paint critical path.
 */
function querySpanMetricsCalls(params: {
	service?: string
	start_time?: string
	end_time?: string
	bucket_seconds: number
}) {
	return Effect.gen(function* () {
		const response = yield* executeQueryEngine(
			"queryEngine.spanMetricsCalls",
			new QueryEngineExecuteRequest({
				startTime: params.start_time ?? "2020-01-01 00:00:00",
				endTime: params.end_time ?? "2099-12-31 23:59:59",
				query: {
					kind: "timeseries",
					source: "metrics",
					// `calls` is a monotonic cumulative counter — aggregate it as a
					// per-bucket `increase` (counter-reset safe), not raw `sum`, which
					// would plot the accumulated total as a linear ramp.
					metric: "increase",
					groupBy: ["service"],
					filters: {
						// `metricName` is the required canonical; `metricNames` drives the
						// actual `IN (...)` filter so whichever spelling the org emits matches.
						metricName: asMetricName(SPANMETRICS_CALLS_CANDIDATES[0]),
						metricNames: SPANMETRICS_CALLS_CANDIDATES.map((name) => asMetricName(name)),
						metricType: "sum",
						serviceName: params.service ? asServiceName(params.service) : undefined,
						attributeFilters: [{ key: "span.kind", value: "SPAN_KIND_SERVER", mode: "equals" }],
					},
					bucketSeconds: params.bucket_seconds,
				},
			}),
		).pipe(Effect.orElseSucceed(() => null))

		if (!response || response.result.kind !== "timeseries" || response.result.data.length === 0) {
			return { data: [] as never[] }
		}

		// Transform grouped timeseries back to flat rows for compatibility
		const data: Array<Record<string, unknown>> = []
		for (const point of response.result.data) {
			for (const [serviceName, value] of Object.entries(point.series)) {
				data.push({
					bucket: point.bucket,
					serviceName,
					sumValue: value,
				})
			}
		}
		return { data }
	})
}

function sortByBucket<T extends { bucket: string }>(rows: T[]): T[] {
	return rows.toSorted((left, right) => left.bucket.localeCompare(right.bucket))
}

/**
 * How recent a bucket can be before it's treated as still-settling. A bucket
 * whose window ends within this budget of "now" is under-filled (OTLP batch
 * export + collector + MV materialization lag), so it's flagged `partial` and
 * rendered as the dashed in-progress segment instead of a solid end-of-chart
 * crater. Only ranges ending near "now" are affected — historical windows end
 * well before `now - budget`, so nothing is flagged.
 */
const INGESTION_LAG_MS = 120_000

export function fillServiceDetailPoints(
	points: ServiceDetailTimeSeriesPoint[],
	startTime: string | undefined,
	endTime: string | undefined,
	bucketSeconds: number,
	nowMs: number,
): ServiceDetailTimeSeriesPoint[] {
	const bucketMs = bucketSeconds * 1000
	const partialFromMs = nowMs - INGESTION_LAG_MS
	const isPartial = (bucketIso: string): boolean => {
		const bucketStartMs = Date.parse(bucketIso)
		return Number.isNaN(bucketStartMs) ? false : bucketStartMs + bucketMs > partialFromMs
	}

	const timeline = buildBucketTimeline(startTime, endTime, bucketSeconds)
	if (timeline.length === 0) {
		return sortByBucket(
			points.map((point) => ({ ...point, partial: isPartial(toIsoBucket(point.bucket)) })),
		)
	}

	const byBucket = new Map<string, ServiceDetailTimeSeriesPoint>()
	for (const point of points) {
		byBucket.set(toIsoBucket(point.bucket), point)
	}

	const filled = timeline.map((bucket): ServiceDetailTimeSeriesPoint => {
		const existing = byBucket.get(bucket)
		if (existing) {
			return { ...existing, partial: isPartial(bucket) }
		}

		return {
			bucket,
			throughput: 0,
			tracedThroughput: 0,
			hasSampling: false,
			samplingWeight: 1,
			errorRate: 0,
			p50LatencyMs: 0,
			p95LatencyMs: 0,
			p99LatencyMs: 0,
			apdexScore: 0,
			totalCount: 0,
			partial: isPartial(bucket),
		}
	})

	// Trim leading buckets where the trace count is essentially zero next to the
	// rest of the chart. Without this, ingestion ramp-up at the start of the
	// requested window plots a leading 0 → spike that reads as a broken chart.
	return trimSparseLeadingBuckets(filled, (row) => row.tracedThroughput ?? 0)
}

function fillServiceSparklinePoints(
	points: ServiceTimeSeriesPoint[],
	timeline: string[],
): ServiceTimeSeriesPoint[] {
	if (timeline.length === 0) {
		return sortByBucket(points)
	}

	const byBucket = new Map<string, ServiceTimeSeriesPoint>()
	for (const point of points) {
		byBucket.set(toIsoBucket(point.bucket), point)
	}

	return timeline.map((bucket) => {
		const existing = byBucket.get(bucket)
		if (existing) {
			return existing
		}

		return {
			bucket,
			throughput: 0,
			tracedThroughput: 0,
			hasSampling: false,
			errorRate: 0,
		}
	})
}

const SharedFiltersSchema = Schema.Struct({
	serviceName: Schema.optional(ServiceName),
	spanName: Schema.optional(SpanName),
	severity: Schema.optional(Schema.String),
	metricName: Schema.optional(MetricName),
	metricType: Schema.optional(Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])),
	rootSpansOnly: Schema.optional(Schema.Boolean),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	namespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
	commitShas: Schema.optional(Schema.mutable(Schema.Array(CommitSha))),
	groupByAttributeKeys: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	groupByAttributeKey: Schema.optional(Schema.String),
	attributeFilters: Schema.optional(
		Schema.mutable(
			Schema.Array(
				Schema.Struct({
					key: Schema.String,
					value: Schema.optional(Schema.String),
					mode: Schema.Literals(["equals", "exists"]),
				}),
			),
		),
	),
	resourceAttributeFilters: Schema.optional(
		Schema.mutable(
			Schema.Array(
				Schema.Struct({
					key: Schema.String,
					value: Schema.optional(Schema.String),
					mode: Schema.Literals(["equals", "exists"]),
				}),
			),
		),
	),
})

const CustomChartTimeSeriesInputSchema = Schema.Struct({
	source: Schema.Literals(["traces", "logs", "metrics"]),
	metric: Schema.String,
	groupBy: Schema.optional(
		Schema.Literals([
			"service",
			"span_name",
			"status_code",
			"http_method",
			"severity",
			"attribute",
			"none",
		]),
	),
	filters: Schema.optional(SharedFiltersSchema),
	startTime: dateTimeString,
	endTime: dateTimeString,
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	apdexThresholdMs: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
})

export type CustomChartTimeSeriesInput = (typeof CustomChartTimeSeriesInputSchema)["Encoded"]
type CustomChartTimeSeriesDecoded = (typeof CustomChartTimeSeriesInputSchema)["Type"]

interface CustomChartTimeSeriesPoint {
	bucket: string
	series: Record<string, number>
}

export interface CustomChartTimeSeriesResponse {
	data: CustomChartTimeSeriesPoint[]
}

const tracesMetrics = new Set<TracesMetric>([
	"count",
	"avg_duration",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"error_rate",
	"apdex",
])
const metricsMetrics = new Set<MetricsMetric>(["avg", "sum", "min", "max", "count", "rate", "increase"])
const metricsBreakdownMetrics = new Set<"avg" | "sum" | "count">(["avg", "sum", "count"])

function buildTimeseriesQuerySpec(data: CustomChartTimeSeriesDecoded): QuerySpec | string {
	if (data.source === "traces") {
		if (!tracesMetrics.has(data.metric as TracesMetric)) {
			return `Unknown trace metric: ${data.metric}`
		}
		if (
			data.groupBy &&
			!["service", "span_name", "status_code", "http_method", "attribute", "none"].includes(
				data.groupBy,
			)
		) {
			return `Unsupported traces groupBy: ${data.groupBy}`
		}

		return {
			kind: "timeseries",
			source: "traces",
			metric: data.metric as TracesMetric,
			apdexThresholdMs: data.apdexThresholdMs,
			groupBy: data.groupBy ? ([data.groupBy] as any) : undefined,
			filters: {
				serviceName: data.filters?.serviceName,
				spanName: data.filters?.spanName,
				rootSpansOnly: data.filters?.rootSpansOnly,
				environments: data.filters?.environments,
				namespaces: data.filters?.namespaces,
				commitShas: data.filters?.commitShas,
				groupByAttributeKeys: data.filters?.groupByAttributeKeys,
				attributeFilters: data.filters?.attributeFilters,
				resourceAttributeFilters: data.filters?.resourceAttributeFilters,
			},
			bucketSeconds: data.bucketSeconds,
		}
	}

	if (data.source === "logs") {
		if (data.metric !== "count") {
			return `Unknown logs metric: ${data.metric}`
		}
		if (data.groupBy && !["service", "severity", "none"].includes(data.groupBy)) {
			return `Unsupported logs groupBy: ${data.groupBy}`
		}

		return {
			kind: "timeseries",
			source: "logs",
			metric: "count",
			groupBy: data.groupBy ? ([data.groupBy] as any) : undefined,
			filters: {
				serviceName: data.filters?.serviceName,
				severity: data.filters?.severity,
				environments: data.filters?.environments,
				namespaces: data.filters?.namespaces,
			},
			bucketSeconds: data.bucketSeconds,
		}
	}

	if (!metricsMetrics.has(data.metric as MetricsMetric)) {
		return `Unknown metrics metric: ${data.metric}`
	}
	if (!data.filters?.metricName || !data.filters.metricType) {
		return "metricName and metricType are required for metrics source"
	}
	if (data.groupBy && !["service", "attribute", "none"].includes(data.groupBy)) {
		return `Unsupported metrics groupBy: ${data.groupBy}`
	}

	const metricsGroupBy = data.groupBy as "service" | "attribute" | "none" | undefined

	return {
		kind: "timeseries",
		source: "metrics",
		metric: data.metric as MetricsMetric,
		groupBy:
			metricsGroupBy === "none"
				? ["none"]
				: metricsGroupBy === "attribute"
					? ["attribute"]
					: ["service"],
		filters: {
			metricName: data.filters.metricName,
			metricType: data.filters.metricType,
			serviceName: data.filters.serviceName,
			groupByAttributeKey: data.filters.groupByAttributeKey,
			attributeFilters: data.filters.attributeFilters,
		},
		bucketSeconds: data.bucketSeconds,
	}
}

export function getCustomChartTimeSeries({ data }: { data: CustomChartTimeSeriesInput }) {
	return getCustomChartTimeSeriesEffect({ data })
}

const getCustomChartTimeSeriesEffect = Effect.fn("QueryEngine.getCustomChartTimeSeries")(function* ({
	data,
}: {
	data: CustomChartTimeSeriesInput
}) {
	const input = yield* decodeInput(CustomChartTimeSeriesInputSchema, data, "getCustomChartTimeSeries")

	const query = buildTimeseriesQuerySpec(input)
	if (typeof query === "string") {
		return yield* invalidWarehouseInput("getCustomChartTimeSeries", query)
	}

	const request = yield* decodeInput(
		QueryEngineExecuteRequest,
		{
			startTime: input.startTime,
			endTime: input.endTime,
			query,
		},
		"getCustomChartTimeSeries.request",
	)

	const response = yield* executeQueryEngine("queryEngine.customChartTimeSeries", request)
	if (response.result.kind !== "timeseries") {
		return yield* invalidWarehouseInput("getCustomChartTimeSeries", "Unexpected query result kind")
	}

	// Drop the partial leading bucket that ClickHouse returns for `Timestamp >= startTime`
	// when startTime isn't bucket-aligned — matches the `ceil` invariant in
	// `buildBucketTimeline` used by `fillServiceDetailPoints`. Without this, charts
	// like Log Volume divide a fractional bucket's count by full `bucketSeconds`
	// and render a near-zero leading point.
	const bucketSeconds = input.bucketSeconds ?? computeBucketSeconds(input.startTime, input.endTime)
	const firstIso = firstFullBucketIso(input.startTime, bucketSeconds)

	const filtered = response.result.data
		.filter((point) => firstIso == null || toIsoBucket(point.bucket) >= firstIso)
		.map((point) => ({
			bucket: point.bucket,
			series: { ...point.series },
		}))

	// Also trim leading buckets whose total volume is a tiny fraction of the next.
	// Covers the case where the first full bucket of the window happens to fall in
	// an ingestion ramp-up — the row exists but contains only a few stray events.
	const sumSeries = (p: { series: Record<string, number> }) =>
		Object.values(p.series).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0)
	return { data: trimSparseLeadingBuckets(filtered, sumSeries) }
})

const CustomChartBreakdownInputSchema = Schema.Struct({
	source: Schema.Literals(["traces", "logs", "metrics"]),
	metric: Schema.String,
	groupBy: Schema.Literals(["service", "span_name", "status_code", "http_method", "severity", "attribute"]),
	filters: Schema.optional(SharedFiltersSchema),
	startTime: dateTimeString,
	endTime: dateTimeString,
	limit: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
	),
})

export type CustomChartBreakdownInput = (typeof CustomChartBreakdownInputSchema)["Encoded"]
type CustomChartBreakdownDecoded = (typeof CustomChartBreakdownInputSchema)["Type"]

function buildBreakdownQuerySpec(data: CustomChartBreakdownDecoded): QuerySpec | string {
	if (data.source === "traces") {
		if (!tracesMetrics.has(data.metric as TracesMetric)) {
			return `Unknown trace metric: ${data.metric}`
		}
		if (!["service", "span_name", "status_code", "http_method", "attribute"].includes(data.groupBy)) {
			return `Unsupported traces groupBy: ${data.groupBy}`
		}

		return {
			kind: "breakdown",
			source: "traces",
			metric: data.metric as TracesMetric,
			groupBy: data.groupBy as "service" | "span_name" | "status_code" | "http_method" | "attribute",
			filters: {
				serviceName: data.filters?.serviceName,
				spanName: data.filters?.spanName,
				rootSpansOnly: data.filters?.rootSpansOnly,
				environments: data.filters?.environments,
				commitShas: data.filters?.commitShas,
				attributeFilters: data.filters?.attributeFilters,
				resourceAttributeFilters: data.filters?.resourceAttributeFilters,
			},
			limit: data.limit,
		}
	}

	if (data.source === "logs") {
		if (data.metric !== "count") {
			return `Unknown logs metric: ${data.metric}`
		}
		if (!["service" as const, "severity" as const].includes(data.groupBy as "service" | "severity")) {
			return `Unsupported logs groupBy: ${data.groupBy}`
		}

		return {
			kind: "breakdown",
			source: "logs",
			metric: "count",
			groupBy: data.groupBy as "service" | "severity",
			filters: {
				serviceName: data.filters?.serviceName,
				severity: data.filters?.severity,
				environments: data.filters?.environments,
			},
			limit: data.limit,
		}
	}

	if (!metricsBreakdownMetrics.has(data.metric as "avg" | "sum" | "count")) {
		return `Unknown metrics metric: ${data.metric}`
	}
	if (!data.filters?.metricName || !data.filters.metricType) {
		return "metricName and metricType are required for metrics source"
	}
	if (data.groupBy !== "service") {
		return `Unsupported metrics groupBy: ${data.groupBy}`
	}

	return {
		kind: "breakdown",
		source: "metrics",
		metric: data.metric as "avg" | "sum" | "count",
		groupBy: "service",
		filters: {
			metricName: data.filters.metricName,
			metricType: data.filters.metricType,
			serviceName: data.filters.serviceName,
		},
		limit: data.limit,
	}
}

export function getCustomChartBreakdown({ data }: { data: CustomChartBreakdownInput }) {
	return getCustomChartBreakdownEffect({ data })
}

const getCustomChartBreakdownEffect = Effect.fn("QueryEngine.getCustomChartBreakdown")(function* ({
	data,
}: {
	data: CustomChartBreakdownInput
}) {
	const input = yield* decodeInput(CustomChartBreakdownInputSchema, data, "getCustomChartBreakdown")

	const query = buildBreakdownQuerySpec(input)
	if (typeof query === "string") {
		return yield* invalidWarehouseInput("getCustomChartBreakdown", query)
	}

	const request = yield* decodeInput(
		QueryEngineExecuteRequest,
		{
			startTime: input.startTime,
			endTime: input.endTime,
			query,
		},
		"getCustomChartBreakdown.request",
	)

	const response = yield* executeQueryEngine("queryEngine.customChartBreakdown", request)
	if (response.result.kind !== "breakdown") {
		return yield* invalidWarehouseInput("getCustomChartBreakdown", "Unexpected query result kind")
	}

	return {
		data: response.result.data.map((item) => ({
			name: item.name,
			value: item.value,
		})),
	}
})

const GetCustomChartServiceDetailInputSchema = Schema.Struct({
	serviceName: ServiceName,
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	// Scopes the detail charts to a single deployment environment. Carries the
	// service list's display value (incl. the synthetic `"unknown"`); the
	// `"unknown" -> ""` remap to the raw warehouse value happens in `toEnvFilter`.
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
})

type GetCustomChartServiceDetailInput = (typeof GetCustomChartServiceDetailInputSchema)["Encoded"]

export function getCustomChartServiceDetail({ data }: { data: GetCustomChartServiceDetailInput }) {
	return getCustomChartServiceDetailEffect({ data })
}

function makeAllMetricsTimeseriesRequest(opts: {
	startTime?: string
	endTime?: string
	bucketSeconds: number
	serviceName?: ServiceName
	rootSpansOnly?: boolean
	environments?: ReadonlyArray<DeploymentEnvironment>
	commitShas?: ReadonlyArray<CommitSha>
	groupBy?: string[]
}) {
	return new QueryEngineExecuteRequest({
		startTime: opts.startTime ?? "2020-01-01 00:00:00",
		endTime: opts.endTime ?? "2099-12-31 23:59:59",
		query: {
			kind: "timeseries" as const,
			source: "traces" as const,
			metric: "count" as const,
			allMetrics: true,
			groupBy: opts.groupBy as any,
			filters: {
				serviceName: opts.serviceName,
				rootSpansOnly: opts.rootSpansOnly ?? true,
				environments: opts.environments,
				commitShas: opts.commitShas,
			},
			bucketSeconds: opts.bucketSeconds,
		},
	})
}

interface AllMetricsPoint {
	count: number
	errorRate: number
	p50: number
	p95: number
	p99: number
	apdexScore: number
	estimatedSpanCount: number
}

/**
 * Resolve the throughput value for a bucket, in priority order:
 *   1. SpanMetrics Connector — per-bucket `increase` of the monotonic `calls`
 *      counter (see `querySpanMetricsCalls`), exact pre-sampling counts.
 *   2. `sum(SampleRate)` from the query engine (per-row weighted sum).
 *   3. Raw traced count — when neither is available (no sampling configured).
 *
 * `?? rawCount` won't work as the fallback because `estimatedSpanCount` is
 * coerced to 0 when the column is missing; treat 0 as "no value" explicitly.
 */
export function resolveThroughput(
	rawCount: number,
	estimatedSpanCount: number,
	metricsThroughput: number | undefined,
): number {
	if (metricsThroughput != null && metricsThroughput > 0) return metricsThroughput
	if (estimatedSpanCount > 0) return estimatedSpanCount
	return rawCount
}

function extractAllMetricsSeries(response: QueryEngineExecuteResponse): Map<string, AllMetricsPoint> {
	const map = new Map<string, AllMetricsPoint>()
	if (response.result.kind !== "timeseries") return map
	for (const point of response.result.data) {
		// Normalize to ISO so this map's keys line up with `metricsMap` (which already
		// `toIsoBucket`s its keys). Without this, the same time bucket lands under two
		// different string keys in the merged `allBuckets` Set, producing duplicate
		// points — one with traces data only, one with metrics throughput only — and
		// the metrics-only duplicate (sorted after the raw key) overwrites the traces
		// entry in `byBucket`, dropping latency/error-rate and stranding throughput.
		map.set(toIsoBucket(point.bucket), {
			count: point.series.count ?? 0,
			errorRate: point.series.error_rate ?? 0,
			p50: point.series.p50_duration ?? 0,
			p95: point.series.p95_duration ?? 0,
			p99: point.series.p99_duration ?? 0,
			apdexScore: point.series.apdex ?? 0,
			estimatedSpanCount: point.series.estimated_span_count ?? 0,
		})
	}
	return map
}

const GROUPED_ALL_METRICS_KEYS = [
	"count",
	"error_rate",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"apdex",
	"estimated_span_count",
] as const

function emptyAllMetricsPoint(): AllMetricsPoint {
	return {
		count: 0,
		errorRate: 0,
		p50: 0,
		p95: 0,
		p99: 0,
		apdexScore: 0,
		estimatedSpanCount: 0,
	}
}

function assignAllMetric(point: AllMetricsPoint, metric: string, value: number) {
	switch (metric) {
		case "count":
			point.count = value
			break
		case "error_rate":
			point.errorRate = value
			break
		case "p50_duration":
			point.p50 = value
			break
		case "p95_duration":
			point.p95 = value
			break
		case "p99_duration":
			point.p99 = value
			break
		case "apdex":
			point.apdexScore = value
			break
		case "estimated_span_count":
			point.estimatedSpanCount = value
			break
	}
}

function extractGroupedAllMetricsSeries(
	response: QueryEngineExecuteResponse,
): Map<string, Map<string, AllMetricsPoint>> {
	const services = new Map<string, Map<string, AllMetricsPoint>>()
	if (response.result.kind !== "timeseries") return services

	for (const bucketPoint of response.result.data) {
		const bucket = toIsoBucket(bucketPoint.bucket)
		for (const [seriesKey, rawValue] of Object.entries(bucketPoint.series)) {
			const metric = GROUPED_ALL_METRICS_KEYS.find((key) => seriesKey.startsWith(`${key}::`))
			if (!metric) continue

			const service = seriesKey.slice(metric.length + 2)
			let buckets = services.get(service)
			if (!buckets) {
				buckets = new Map()
				services.set(service, buckets)
			}

			let point = buckets.get(bucket)
			if (!point) {
				point = emptyAllMetricsPoint()
				buckets.set(bucket, point)
			}
			assignAllMetric(point, metric, Number(rawValue))
		}
	}

	return services
}

// Shared point-builder for the service-detail chart: turns an all-metrics
// timeseries response into filled `ServiceDetailTimeSeriesPoint`s. Used by both
// the standalone chart fetch and the `serviceDetailOverview` bundle so the two
// paths can't drift.
function buildServiceDetailPoints(
	allMetricsRes: QueryEngineExecuteResponse,
	startTime: string | undefined,
	endTime: string | undefined,
	bucketSeconds: number,
	nowMs: number,
): ServiceDetailTimeSeriesPoint[] {
	const allMetrics = extractAllMetricsSeries(allMetricsRes)

	const points = Array.from(allMetrics.keys())
		.toSorted()
		.map((bucket): ServiceDetailTimeSeriesPoint => {
			const m = allMetrics.get(bucket)
			const rawCount = m?.count ?? 0
			const throughput = resolveThroughput(rawCount, m?.estimatedSpanCount ?? 0, undefined)
			const samplingWeight = rawCount > 0 ? throughput / rawCount : 1
			const hasSampling = samplingWeight > 1.01

			return {
				bucket,
				throughput,
				tracedThroughput: rawCount,
				hasSampling,
				samplingWeight,
				errorRate: m?.errorRate ?? 0,
				p50LatencyMs: m?.p50 ?? 0,
				p95LatencyMs: m?.p95 ?? 0,
				p99LatencyMs: m?.p99 ?? 0,
				apdexScore: m?.apdexScore ?? 0,
				totalCount: rawCount,
				partial: false,
			}
		})

	return fillServiceDetailPoints(points, startTime, endTime, bucketSeconds, nowMs)
}

const getCustomChartServiceDetailEffect = Effect.fn("QueryEngine.getCustomChartServiceDetail")(function* ({
	data,
}: {
	data: GetCustomChartServiceDetailInput
}) {
	const input = yield* decodeInput(
		GetCustomChartServiceDetailInputSchema,
		data,
		"getCustomChartServiceDetail",
	)

	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
	const reqOpts = {
		startTime: input.startTime,
		endTime: input.endTime,
		bucketSeconds,
		serviceName: input.serviceName,
		rootSpansOnly: true,
		environments: toEnvFilter(input.environments),
	}

	// Throughput renders immediately from the sampling-aware `estimatedSpanCount`
	// (sum of SampleRate). The exact pre-sampling SpanMetrics `calls` counter is a
	// slow window scan, so it's fetched separately by
	// `getServiceDetailThroughputRefinement` (sampling-gated, off the first-paint
	// path) and merged client-side via `mergeExactThroughput`.
	const allMetricsRes = yield* executeQueryEngine(
		"queryEngine.serviceDetail.allMetrics",
		makeAllMetricsTimeseriesRequest(reqOpts),
	)

	const nowMs = yield* Clock.currentTimeMillis
	return {
		data: buildServiceDetailPoints(allMetricsRes, input.startTime, input.endTime, bucketSeconds, nowMs),
	}
})

/**
 * Service-detail Overview tab in one request: the primary all-metrics chart,
 * the releases timeline, and the service's distinct environments — run
 * server-side under a single tenant/config resolution (see the
 * `serviceDetailOverview` handler). The environment switcher and the chart grid
 * read the SAME atom key, so this fires once for the whole tab instead of three
 * independent browser→Worker round-trips.
 */
export interface ServiceDetailOverviewResult {
	data: ServiceDetailTimeSeriesPoint[]
	releases: ReadonlyArray<{ bucket: string; commitSha: CommitSha; count: number }>
	environments: string[]
}

export function getServiceDetailOverview({ data }: { data: GetCustomChartServiceDetailInput }) {
	return getServiceDetailOverviewEffect({ data })
}

const getServiceDetailOverviewEffect = Effect.fn("QueryEngine.getServiceDetailOverview")(function* ({
	data,
}: {
	data: GetCustomChartServiceDetailInput
}) {
	const input = yield* decodeInput(GetCustomChartServiceDetailInputSchema, data, "getServiceDetailOverview")

	const nowMs = yield* Clock.currentTimeMillis
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	const startTime = input.startTime ?? fmt(nowMs - 24 * 60 * 60 * 1000)
	const endTime = input.endTime ?? fmt(nowMs)
	const bucketSeconds = computeBucketSeconds(startTime, endTime)

	const timeseriesRequest = makeAllMetricsTimeseriesRequest({
		startTime,
		endTime,
		bucketSeconds,
		serviceName: input.serviceName,
		rootSpansOnly: true,
		environments: toEnvFilter(input.environments),
	})

	const result = yield* runWarehouseQuery("serviceDetailOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDetailOverview({
				payload: new ServiceDetailOverviewRequest({
					serviceName: input.serviceName,
					startTime,
					endTime,
					timeseries: timeseriesRequest,
					releasesBucketSeconds: bucketSeconds,
				}),
			})
		}),
	)

	return {
		data: buildServiceDetailPoints(result.timeseries, startTime, endTime, bucketSeconds, nowMs),
		releases: result.releases.map((r) => ({
			bucket: toIsoBucket(r.bucket),
			commitSha: r.commitSha,
			count: Number(r.count),
		})),
		environments: [...result.environments],
	} satisfies ServiceDetailOverviewResult
})

const GetOverviewTimeSeriesInputSchema = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
})

type GetOverviewTimeSeriesInput = (typeof GetOverviewTimeSeriesInputSchema)["Encoded"]

export function getOverviewTimeSeries({ data }: { data: GetOverviewTimeSeriesInput }) {
	return getOverviewTimeSeriesEffect({ data })
}

const getOverviewTimeSeriesEffect = Effect.fn("QueryEngine.getOverviewTimeSeries")(function* ({
	data,
}: {
	data: GetOverviewTimeSeriesInput
}) {
	const input = yield* decodeInput(GetOverviewTimeSeriesInputSchema, data ?? {}, "getOverviewTimeSeries")

	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
	const reqOpts = {
		startTime: input.startTime,
		endTime: input.endTime,
		bucketSeconds,
		rootSpansOnly: true,
		environments: input.environments,
	}

	// Throughput renders from the sampling-aware `estimatedSpanCount`; exact
	// pre-sampling counts come from `getOverviewThroughputRefinement` (sampling-
	// gated, merged client-side). See `getCustomChartServiceDetail`.
	const allMetricsRes = yield* executeQueryEngine(
		"queryEngine.overview.allMetrics",
		makeAllMetricsTimeseriesRequest(reqOpts),
	)

	const allMetrics = extractAllMetricsSeries(allMetricsRes)

	const points = Array.from(allMetrics.keys())
		.toSorted()
		.map((bucket): ServiceDetailTimeSeriesPoint => {
			const m = allMetrics.get(bucket)
			const rawCount = m?.count ?? 0
			const throughput = resolveThroughput(rawCount, m?.estimatedSpanCount ?? 0, undefined)
			const samplingWeight = rawCount > 0 ? throughput / rawCount : 1
			const hasSampling = samplingWeight > 1.01

			return {
				bucket,
				throughput,
				tracedThroughput: rawCount,
				hasSampling,
				samplingWeight,
				errorRate: m?.errorRate ?? 0,
				p50LatencyMs: m?.p50 ?? 0,
				p95LatencyMs: m?.p95 ?? 0,
				p99LatencyMs: m?.p99 ?? 0,
				apdexScore: m?.apdexScore ?? 0,
				totalCount: rawCount,
				partial: false,
			}
		})

	const nowMs = yield* Clock.currentTimeMillis
	return {
		data: fillServiceDetailPoints(points, input.startTime, input.endTime, bucketSeconds, nowMs),
	}
})

const GetCustomChartServiceSparklinesInputSchema = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	commitShas: Schema.optional(Schema.mutable(Schema.Array(CommitSha))),
})

type GetCustomChartServiceSparklinesInput = (typeof GetCustomChartServiceSparklinesInputSchema)["Encoded"]

export function getCustomChartServiceSparklines({ data }: { data: GetCustomChartServiceSparklinesInput }) {
	return getCustomChartServiceSparklinesEffect({ data })
}

const getCustomChartServiceSparklinesEffect = Effect.fn("QueryEngine.getCustomChartServiceSparklines")(
	function* ({ data }: { data: GetCustomChartServiceSparklinesInput }) {
		const input = yield* decodeInput(
			GetCustomChartServiceSparklinesInputSchema,
			data ?? {},
			"getCustomChartServiceSparklines",
		)

		const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
		const reqOpts = {
			startTime: input.startTime,
			endTime: input.endTime,
			bucketSeconds,
			rootSpansOnly: true,
			environments: input.environments,
			commitShas: input.commitShas,
			groupBy: ["service"] as string[],
		}

		// The services-list sparkline shape uses the sampling-aware
		// `estimatedSpanCount`, matching how `getServiceOverview` resolves the
		// headline throughput number (it also avoids the SpanMetrics counter on
		// per-environment rows). Keeping both on the same basis prevents a
		// shape/number mismatch and removes the ~11s all-services SpanMetrics scan
		// the services list used to fire on every load.
		const allMetricsRes = yield* executeQueryEngine(
			"queryEngine.sparklines.allMetrics",
			makeAllMetricsTimeseriesRequest(reqOpts),
		)

		const allMetricsByService = extractGroupedAllMetricsSeries(allMetricsRes)

		const timeline = buildBucketTimeline(input.startTime, input.endTime, bucketSeconds)
		const grouped: Record<string, ServiceTimeSeriesPoint[]> = {}

		for (const [service, buckets] of allMetricsByService) {
			const points: ServiceTimeSeriesPoint[] = []

			for (const [bucket, metrics] of buckets) {
				const rawCount = metrics.count
				const throughput = resolveThroughput(rawCount, metrics.estimatedSpanCount, undefined)

				points.push({
					bucket,
					throughput,
					tracedThroughput: rawCount,
					hasSampling: throughput > rawCount * 1.01,
					errorRate: metrics.errorRate,
				})
			}

			grouped[service] = points
		}

		const filledGrouped = Object.fromEntries(
			Object.entries(grouped).map(([service, points]) => [
				service,
				fillServiceSparklinePoints(points, timeline),
			]),
		)

		return { data: filledGrouped }
	},
)

// ---------------------------------------------------------------------------
// Throughput refinement — exact pre-sampling counts (SpanMetrics `calls`)
//
// The primary chart effects above resolve throughput from the sampling-aware
// `estimatedSpanCount` so they never block on the slow SpanMetrics window scan.
// These refinement effects fetch the exact pre-sampling counter and are invoked
// from a separate, non-blocking atom — but only when the already-loaded primary
// chart shows sampling is active (`samplingActive`), so unsampled services never
// issue the expensive query at all. Env-scoped views also skip it: the counter
// is service-level / all-environment and can't be filtered by `DeploymentEnv`.
// ---------------------------------------------------------------------------

export interface ThroughputRefinementPoint {
	/** ISO bucket — matches `ServiceDetailTimeSeriesPoint.bucket`. */
	bucket: string
	throughput: number
}

/**
 * Overlay exact pre-sampling throughput onto already-built chart points, keyed
 * by ISO bucket. Where an exact value is present (>0) it overrides the estimate
 * and the sampling weight / flag are recomputed against the traced count. A
 * value of 0 (or a missing bucket) means "no exact data" — the estimate stays.
 */
export function mergeExactThroughput(
	points: ReadonlyArray<ServiceDetailTimeSeriesPoint>,
	exactByBucket: ReadonlyMap<string, number>,
): ServiceDetailTimeSeriesPoint[] {
	if (exactByBucket.size === 0) return points as ServiceDetailTimeSeriesPoint[]
	return points.map((point) => {
		const exact = exactByBucket.get(point.bucket)
		if (exact == null || exact <= 0) return point
		const samplingWeight = point.tracedThroughput > 0 ? exact / point.tracedThroughput : 1
		return { ...point, throughput: exact, samplingWeight, hasSampling: samplingWeight > 1.01 }
	})
}

function aggregateSpanMetricsByBucket(
	rows: ReadonlyArray<Record<string, unknown>>,
): ThroughputRefinementPoint[] {
	const byBucket = new Map<string, number>()
	for (const row of rows) {
		const key = toIsoBucket(String(row.bucket))
		byBucket.set(key, (byBucket.get(key) ?? 0) + Number(row.sumValue))
	}
	return Array.from(byBucket, ([bucket, throughput]) => ({ bucket, throughput }))
}

const ThroughputRefinementShared = {
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	// The caller's sampling verdict, derived from the already-loaded primary
	// chart. When false (or absent) the exact query is skipped — the estimate is
	// already correct. Including it in the input makes it part of the atom key, so
	// an unsampled window can't inherit a stale exact line.
	samplingActive: Schema.optional(Schema.Boolean),
}

const GetServiceDetailThroughputRefinementInputSchema = Schema.Struct({
	serviceName: ServiceName,
	...ThroughputRefinementShared,
})

type GetServiceDetailThroughputRefinementInput =
	(typeof GetServiceDetailThroughputRefinementInputSchema)["Encoded"]

export function getServiceDetailThroughputRefinement({
	data,
}: {
	data: GetServiceDetailThroughputRefinementInput
}) {
	return getServiceDetailThroughputRefinementEffect({ data })
}

const getServiceDetailThroughputRefinementEffect = Effect.fn(
	"QueryEngine.getServiceDetailThroughputRefinement",
)(function* ({ data }: { data: GetServiceDetailThroughputRefinementInput }) {
	const input = yield* decodeInput(
		GetServiceDetailThroughputRefinementInputSchema,
		data,
		"getServiceDetailThroughputRefinement",
	)

	const envScoped = (input.environments?.length ?? 0) > 0
	if (!input.samplingActive || envScoped) {
		return { data: [] as ThroughputRefinementPoint[] }
	}

	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
	const result = yield* querySpanMetricsCalls({
		service: input.serviceName,
		start_time: input.startTime,
		end_time: input.endTime,
		bucket_seconds: bucketSeconds,
	})
	return { data: aggregateSpanMetricsByBucket(result.data) }
})

const GetOverviewThroughputRefinementInputSchema = Schema.Struct({
	...ThroughputRefinementShared,
})

type GetOverviewThroughputRefinementInput = (typeof GetOverviewThroughputRefinementInputSchema)["Encoded"]

export function getOverviewThroughputRefinement({ data }: { data: GetOverviewThroughputRefinementInput }) {
	return getOverviewThroughputRefinementEffect({ data })
}

const getOverviewThroughputRefinementEffect = Effect.fn("QueryEngine.getOverviewThroughputRefinement")(
	function* ({ data }: { data: GetOverviewThroughputRefinementInput }) {
		const input = yield* decodeInput(
			GetOverviewThroughputRefinementInputSchema,
			data ?? {},
			"getOverviewThroughputRefinement",
		)

		const envScoped = (input.environments?.length ?? 0) > 0
		if (!input.samplingActive || envScoped) {
			return { data: [] as ThroughputRefinementPoint[] }
		}

		const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
		// No service filter → aggregate the per-service rows across all services.
		const result = yield* querySpanMetricsCalls({
			start_time: input.startTime,
			end_time: input.endTime,
			bucket_seconds: bucketSeconds,
		})
		return { data: aggregateSpanMetricsByBucket(result.data) }
	},
)
