/**
 * Converts Railway `metrics` GraphQL query results into an OTLP/JSON
 * `ExportMetricsServiceRequest` of gauges for the Maple ingest gateway
 * (`POST /v1/metrics`). Gauges land in the `metrics_gauge` datasource.
 */
import {
	buildResourceAttributes,
	msToUnixNano,
	type OtlpKeyValue,
	type RailwayResourceContext,
} from "./common"

/** The measurements polled for every service, all in one query. */
export const RAILWAY_MEASUREMENTS = [
	"CPU_USAGE",
	"CPU_LIMIT",
	"MEMORY_USAGE_GB",
	"MEMORY_LIMIT_GB",
	"NETWORK_RX_GB",
	"NETWORK_TX_GB",
	"DISK_USAGE_GB",
] as const

export type RailwayMeasurement = (typeof RAILWAY_MEASUREMENTS)[number]

const GB = 1_000_000_000

/**
 * Railway measurement → OTLP gauge. GB-denominated measurements convert to
 * bytes so dashboards can format them with the standard byte units.
 * NETWORK_RX/TX arrive as windowed totals, not lifetime counters, so they
 * stay gauges rather than cumulative sums.
 */
const MEASUREMENT_SPECS: Record<
	RailwayMeasurement,
	{ readonly name: string; readonly unit: string; readonly description: string; readonly scale: number }
> = {
	CPU_USAGE: {
		name: "railway.cpu.usage",
		unit: "{cpu}",
		description: "vCPU cores in use by the Railway service",
		scale: 1,
	},
	CPU_LIMIT: {
		name: "railway.cpu.limit",
		unit: "{cpu}",
		description: "vCPU core limit of the Railway service",
		scale: 1,
	},
	MEMORY_USAGE_GB: {
		name: "railway.memory.usage",
		unit: "By",
		description: "Memory in use by the Railway service",
		scale: GB,
	},
	MEMORY_LIMIT_GB: {
		name: "railway.memory.limit",
		unit: "By",
		description: "Memory limit of the Railway service",
		scale: GB,
	},
	NETWORK_RX_GB: {
		name: "railway.network.rx",
		unit: "By",
		description: "Network bytes received by the Railway service",
		scale: GB,
	},
	NETWORK_TX_GB: {
		name: "railway.network.tx",
		unit: "By",
		description: "Network bytes transmitted by the Railway service",
		scale: GB,
	},
	DISK_USAGE_GB: {
		name: "railway.disk.usage",
		unit: "By",
		description: "Disk in use by the Railway service",
		scale: GB,
	},
}

export interface RailwayMetricSeries {
	readonly measurement: string
	/** Samples as (epoch ms, value). */
	readonly points: ReadonlyArray<{ readonly tsMs: number; readonly value: number }>
}

/**
 * Tolerant decode of the `metrics` query result: `[{ measurement, values:
 * [{ ts, value }] }]` with `ts` in epoch seconds (Railway) or milliseconds.
 * Unknown measurements and malformed points are skipped, never fatal.
 */
export const decodeRailwayMetrics = (raw: unknown): RailwayMetricSeries[] => {
	if (typeof raw !== "object" || raw === null) return []
	const data = raw as Record<string, unknown>
	const metrics = data.metrics
	if (!Array.isArray(metrics)) return []

	const series: RailwayMetricSeries[] = []
	for (const item of metrics) {
		if (typeof item !== "object" || item === null) continue
		const entry = item as Record<string, unknown>
		if (typeof entry.measurement !== "string" || !Array.isArray(entry.values)) continue

		const points: Array<{ tsMs: number; value: number }> = []
		for (const value of entry.values) {
			if (typeof value !== "object" || value === null) continue
			const point = value as Record<string, unknown>
			if (typeof point.ts !== "number" || typeof point.value !== "number") continue
			if (!Number.isFinite(point.ts) || !Number.isFinite(point.value)) continue
			// Railway timestamps are epoch seconds; tolerate ms just in case.
			const tsMs = point.ts > 10_000_000_000 ? point.ts : point.ts * 1000
			points.push({ tsMs, value: point.value })
		}
		series.push({ measurement: entry.measurement, points })
	}
	return series
}

interface OtlpNumberDataPoint {
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	readonly startTimeUnixNano: string
	readonly timeUnixNano: string
	readonly asDouble: number
}

export interface OtlpMetricsExportRequest {
	readonly resourceMetrics: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeMetrics: ReadonlyArray<{
			readonly scope: { readonly name: string }
			readonly metrics: ReadonlyArray<{
				readonly name: string
				readonly description: string
				readonly unit: string
				readonly gauge: { readonly dataPoints: ReadonlyArray<OtlpNumberDataPoint> }
			}>
		}>
	}>
}

const SCOPE_NAME = "railway.metrics"

export interface MetricsBatchResult {
	readonly request: OtlpMetricsExportRequest | null
	readonly dataPointCount: number
	/** Epoch ms of the newest sample converted — the next window's watermark. */
	readonly maxSampleMs: number | null
}

/**
 * Build one gauge export for a single Railway service. Samples at or before
 * `afterMs` are dropped (already ingested in a previous window).
 */
export const buildMetricsExportRequest = (
	series: ReadonlyArray<RailwayMetricSeries>,
	context: RailwayResourceContext,
	afterMs: number | null,
): MetricsBatchResult => {
	const metrics: Array<{
		name: string
		description: string
		unit: string
		gauge: { dataPoints: OtlpNumberDataPoint[] }
	}> = []
	let dataPointCount = 0
	let maxSampleMs: number | null = null

	for (const entry of series) {
		const spec = MEASUREMENT_SPECS[entry.measurement as RailwayMeasurement]
		if (spec === undefined) continue

		const dataPoints: OtlpNumberDataPoint[] = []
		for (const point of entry.points) {
			if (afterMs !== null && point.tsMs <= afterMs) continue
			dataPoints.push({
				attributes: [],
				startTimeUnixNano: msToUnixNano(point.tsMs),
				timeUnixNano: msToUnixNano(point.tsMs),
				asDouble: point.value * spec.scale,
			})
			if (maxSampleMs === null || point.tsMs > maxSampleMs) maxSampleMs = point.tsMs
		}
		if (dataPoints.length === 0) continue

		dataPointCount += dataPoints.length
		metrics.push({
			name: spec.name,
			description: spec.description,
			unit: spec.unit,
			gauge: { dataPoints },
		})
	}

	if (metrics.length === 0) return { request: null, dataPointCount: 0, maxSampleMs }

	return {
		request: {
			resourceMetrics: [
				{
					resource: { attributes: buildResourceAttributes(context) },
					scopeMetrics: [{ scope: { name: SCOPE_NAME }, metrics }],
				},
			],
		},
		dataPointCount,
		maxSampleMs,
	}
}
