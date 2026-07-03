/**
 * Pure mapping from decoded Cloudflare GraphQL analytics groups to Tinybird metric rows
 * (`metrics_sum` / `metrics_gauge`, collector-exporter shape — the same row layout
 * `apps/api/src/services/demo/fixtures.ts` writes).
 *
 * Conventions:
 * - ServiceName `cloudflare/{zoneName}` for edge HTTP metrics (matches the Logpush ingest path)
 *   and `cloudflare-worker/{scriptName}` for Workers metrics.
 * - Counters are DELTA sums (`aggregation_temporality: 1`): each 5-minute bucket is an
 *   independent increment, which is exactly what the GraphQL API returns. Chart with sum/rate.
 * - Pre-computed percentiles are gauges with a `quantile` attribute ("0.5" | "0.95" | "0.99")
 *   so one query grouped by `attr.quantile` renders all lines.
 * - ABR sampling: true request count = `count × avg.sampleInterval`; `sum.*` fields are already
 *   sampling-adjusted by Cloudflare, so they pass through untouched.
 */
import { fmtMetricTs, type MetricGaugeRow, type MetricSumRow } from "../../lib/metric-rows"
import type {
	HttpGroupShape,
	HttpLatencyGroupShape,
	WorkersGroupShape,
} from "./queries"

type Attrs = Record<string, string>

export const SCOPE_NAME = "@maple/cloudflare-analytics"

export const METRIC_HTTP_REQUESTS = "cloudflare.http.requests"
export const METRIC_HTTP_BYTES = "cloudflare.http.bytes"
export const METRIC_HTTP_VISITS = "cloudflare.http.visits"
export const METRIC_HTTP_EDGE_TTFB = "cloudflare.http.edge.ttfb"
export const METRIC_HTTP_ORIGIN_DURATION = "cloudflare.http.origin.duration"
export const METRIC_WORKER_REQUESTS = "cloudflare.worker.requests"
export const METRIC_WORKER_ERRORS = "cloudflare.worker.errors"
export const METRIC_WORKER_CPU_TIME = "cloudflare.worker.cpu_time"
export const METRIC_WORKER_DURATION = "cloudflare.worker.duration"

export type { MetricGaugeRow, MetricSumRow }

export interface CloudflareMetricRows {
	sumRows: MetricSumRow[]
	gaugeRows: MetricGaugeRow[]
}

/** GraphQL buckets arrive as RFC 3339 datetimes ("2026-07-03T10:05:00Z"). */
const bucketToTs = (bucket: string): string => fmtMetricTs(Date.parse(bucket))

const DELTA_TEMPORALITY = 1

const baseRow = (options: {
	readonly bucket: string
	readonly metricName: string
	readonly description: string
	readonly unit: string
	readonly attributes: Attrs
	readonly serviceName: string
	readonly resourceAttributes: Attrs
	readonly value: number
}): MetricGaugeRow => {
	const ts = bucketToTs(options.bucket)
	return {
		timestamp: ts,
		start_timestamp: ts,
		metric_name: options.metricName,
		metric_description: options.description,
		metric_unit: options.unit,
		metric_attributes: options.attributes,
		service_name: options.serviceName,
		resource_schema_url: "",
		resource_attributes: options.resourceAttributes,
		scope_schema_url: "",
		scope_name: SCOPE_NAME,
		scope_version: "",
		scope_attributes: {},
		value: options.value,
		flags: 0,
		exemplars_trace_id: [],
		exemplars_span_id: [],
		exemplars_timestamp: [],
		exemplars_value: [],
		exemplars_filtered_attributes: [],
	}
}

const sumRow = (options: Parameters<typeof baseRow>[0]): MetricSumRow => ({
	...baseRow(options),
	aggregation_temporality: DELTA_TEMPORALITY,
	is_monotonic: true,
})

/** Collapse a raw edge status (e.g. 503) into its class ("5xx"); out-of-range → "unknown". */
export const statusClass = (status: number | null | undefined): string => {
	if (status == null || status < 100 || status > 599) return "unknown"
	return `${Math.floor(status / 100)}xx`
}

const httpResourceAttrs = (orgId: string, zoneId: string, zoneName: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": `cloudflare/${zoneName}`,
	"cloud.provider": "cloudflare",
	"cloudflare.zone.id": zoneId,
})

export interface MapHttpGroupsInput {
	readonly orgId: string
	readonly zoneId: string
	readonly zoneName: string
	readonly groups: ReadonlyArray<HttpGroupShape>
	readonly latency: ReadonlyArray<HttpLatencyGroupShape>
}

export const mapHttpGroups = (input: MapHttpGroupsInput): CloudflareMetricRows => {
	const serviceName = `cloudflare/${input.zoneName}`
	const resourceAttributes = httpResourceAttrs(input.orgId, input.zoneId, input.zoneName)
	const sumRows: MetricSumRow[] = []
	const gaugeRows: MetricGaugeRow[] = []

	for (const group of input.groups) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const attributes: Attrs = {
			"cache.status": group.dimensions.cacheStatus ?? "unknown",
			"http.status_class": statusClass(group.dimensions.edgeResponseStatus),
		}
		const sampleInterval = group.avg?.sampleInterval ?? 1
		const counters: ReadonlyArray<readonly [string, string, string, number]> = [
			[
				METRIC_HTTP_REQUESTS,
				"Edge HTTP requests (ABR-adjusted estimate)",
				"{requests}",
				Math.round(group.count * (sampleInterval > 0 ? sampleInterval : 1)),
			],
			[METRIC_HTTP_BYTES, "Edge response bytes served", "By", group.sum?.edgeResponseBytes ?? 0],
			[METRIC_HTTP_VISITS, "Edge visits (initial page loads)", "{visits}", group.sum?.visits ?? 0],
		]
		for (const [metricName, description, unit, value] of counters) {
			if (value <= 0) continue
			sumRows.push(
				sumRow({ bucket, metricName, description, unit, attributes, serviceName, resourceAttributes, value }),
			)
		}
	}

	for (const group of input.latency) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const quantiles = group.quantiles
		if (!quantiles) continue
		const ttfb: ReadonlyArray<readonly [string, number | null | undefined]> = [
			["0.5", quantiles.edgeTimeToFirstByteMsP50],
			["0.95", quantiles.edgeTimeToFirstByteMsP95],
			["0.99", quantiles.edgeTimeToFirstByteMsP99],
		]
		for (const [quantile, value] of ttfb) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName: METRIC_HTTP_EDGE_TTFB,
					description: "Edge time to first byte",
					unit: "ms",
					attributes: { quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
		const origin: ReadonlyArray<readonly [string, number | null | undefined]> = [
			["0.5", quantiles.originResponseDurationMsP50],
			["0.95", quantiles.originResponseDurationMsP95],
			["0.99", quantiles.originResponseDurationMsP99],
		]
		for (const [quantile, value] of origin) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName: METRIC_HTTP_ORIGIN_DURATION,
					description: "Origin response duration (uncached requests)",
					unit: "ms",
					attributes: { quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}

	return { sumRows, gaugeRows }
}

export interface MapWorkersGroupsInput {
	readonly orgId: string
	readonly accountId: string
	readonly groups: ReadonlyArray<WorkersGroupShape>
}

export const mapWorkersGroups = (input: MapWorkersGroupsInput): CloudflareMetricRows => {
	const sumRows: MetricSumRow[] = []
	const gaugeRows: MetricGaugeRow[] = []

	for (const group of input.groups) {
		const bucket = group.dimensions.datetimeFiveMinutes
		const scriptName = group.dimensions.scriptName
		const serviceName = `cloudflare-worker/${scriptName}`
		const resourceAttributes: Attrs = {
			maple_org_id: input.orgId,
			"service.name": serviceName,
			"cloud.provider": "cloudflare",
			"cloudflare.account.id": input.accountId,
		}
		const attributes: Attrs = { "worker.status": group.dimensions.status ?? "unknown" }

		const counters: ReadonlyArray<readonly [string, string, string, number]> = [
			[METRIC_WORKER_REQUESTS, "Worker invocations", "{requests}", group.sum?.requests ?? 0],
			[METRIC_WORKER_ERRORS, "Worker invocation errors", "{errors}", group.sum?.errors ?? 0],
		]
		for (const [metricName, description, unit, value] of counters) {
			if (value <= 0) continue
			sumRows.push(
				sumRow({ bucket, metricName, description, unit, attributes, serviceName, resourceAttributes, value }),
			)
		}

		const quantiles = group.quantiles
		if (!quantiles) continue
		// cpuTime arrives in microseconds, duration in seconds — normalize both to ms.
		const gauges: ReadonlyArray<readonly [string, string, string, number | null | undefined]> = [
			[METRIC_WORKER_CPU_TIME, "Worker CPU time", "0.5", scale(quantiles.cpuTimeP50, 1 / 1000)],
			[METRIC_WORKER_CPU_TIME, "Worker CPU time", "0.99", scale(quantiles.cpuTimeP99, 1 / 1000)],
			[METRIC_WORKER_DURATION, "Worker duration (wall time billed)", "0.5", scale(quantiles.durationP50, 1000)],
			[METRIC_WORKER_DURATION, "Worker duration (wall time billed)", "0.99", scale(quantiles.durationP99, 1000)],
		]
		for (const [metricName, description, quantile, value] of gauges) {
			if (value == null) continue
			gaugeRows.push(
				baseRow({
					bucket,
					metricName,
					description,
					unit: "ms",
					attributes: { ...attributes, quantile },
					serviceName,
					resourceAttributes,
					value,
				}),
			)
		}
	}

	return { sumRows, gaugeRows }
}

const scale = (value: number | null | undefined, factor: number): number | null =>
	value == null ? null : value * factor
