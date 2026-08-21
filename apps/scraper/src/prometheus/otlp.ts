/**
 * Converts parsed Prometheus metric families into an OTLP/JSON
 * `ExportMetricsServiceRequest` for the Maple ingest gateway
 * (`POST /v1/metrics`, `Content-Type: application/json`).
 *
 * Sending OTLP through the gateway (instead of writing warehouse rows
 * directly) means scraped metrics are billed (Autumn byte metering +
 * enforcement) and routed per org (Tinybird vs self-managed ClickHouse)
 * exactly like customer OTLP traffic.
 *
 * JSON shape contract — pinned by the Rust deserializer
 * (`opentelemetry-proto` 0.31 `with-serde`, used in `apps/ingest`; see the
 * `scraper_contract` test in `apps/ingest/src/telemetry.rs`):
 * - camelCase field names; oneofs flattened (`asDouble`, `gauge`/`sum`/`histogram`)
 * - `timeUnixNano`/`startTimeUnixNano` MUST be strings (custom u64-from-string)
 * - histogram `count`/`bucketCounts` MUST be JSON numbers (plain serde u64 —
 *   deviates from the OTLP/JSON spec, which would use strings)
 * - attribute values as `{ "stringValue": "…" }`
 */
import type { PromMetricFamily, PromSample } from "./parser"

export interface ScrapeOtlpContext {
	readonly targetId: string
	readonly targetName: string
	/** `job` data-point attribute and `service.name` resource attribute. */
	readonly serviceName: string
	/** `instance` data-point attribute: host of the target URL. */
	readonly instance: string
	/** Extra labels configured on the target (parsed `labelsJson`). */
	readonly targetLabels: Readonly<Record<string, string>>
	readonly scrapeTimeMs: number
}

interface OtlpKeyValue {
	readonly key: string
	readonly value: { readonly stringValue: string }
}

interface OtlpNumberDataPoint {
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	readonly startTimeUnixNano: string
	readonly timeUnixNano: string
	readonly asDouble: number
}

interface OtlpHistogramDataPoint {
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	readonly startTimeUnixNano: string
	readonly timeUnixNano: string
	readonly count: number
	readonly sum?: number
	readonly bucketCounts: ReadonlyArray<number>
	readonly explicitBounds: ReadonlyArray<number>
}

export interface OtlpMetric {
	readonly name: string
	readonly description: string
	readonly unit: string
	readonly gauge?: { readonly dataPoints: ReadonlyArray<OtlpNumberDataPoint> }
	readonly sum?: {
		readonly dataPoints: ReadonlyArray<OtlpNumberDataPoint>
		readonly aggregationTemporality: number
		readonly isMonotonic: boolean
	}
	readonly histogram?: {
		readonly dataPoints: ReadonlyArray<OtlpHistogramDataPoint>
		readonly aggregationTemporality: number
	}
}

export interface OtlpExportRequest {
	readonly resourceMetrics: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeMetrics: ReadonlyArray<{
			readonly scope: { readonly name: string }
			readonly metrics: ReadonlyArray<OtlpMetric>
		}>
	}>
}

export interface ConvertedOtlp {
	/** Null when the scrape produced no representable data points. */
	readonly request: OtlpExportRequest | null
	readonly dataPointCounts: { readonly sum: number; readonly gauge: number; readonly histogram: number }
	/** Series dropped because a required component was non-finite or incomplete. */
	readonly droppedSeriesCount: number
}

/** Cumulative aggregation temporality (OTLP enum value). */
const CUMULATIVE = 2

/** OTLP "unknown start time": zero nanos. */
const EPOCH_NANO = "0"

const SCOPE_NAME = "maple-prometheus-scraper"

/**
 * Epoch ms → ns string. Nanosecond epochs exceed `Number.MAX_SAFE_INTEGER`
 * (~9.0e15 < 1.7e18), so this must go through BigInt.
 */
export const toUnixNano = (epochMs: number): string => (BigInt(Math.round(epochMs)) * 1_000_000n).toString()

/**
 * Target labels first, then scraped labels, then system labels last — a
 * scrape-supplied `job`/`instance` must never override target attribution.
 */
const mergeAttributes = (
	ctx: ScrapeOtlpContext,
	sampleLabels: Readonly<Record<string, string>>,
): ReadonlyArray<OtlpKeyValue> => {
	const merged: Record<string, string> = {
		...ctx.targetLabels,
		...sampleLabels,
		job: ctx.serviceName,
		instance: ctx.instance,
	} satisfies Record<string, string>
	return Object.entries(merged).map(([key, value]) => ({ key, value: { stringValue: value } }))
}

const numberDataPoint = (
	ctx: ScrapeOtlpContext,
	labels: Readonly<Record<string, string>>,
	value: number,
	timestampMs: number | null,
): OtlpNumberDataPoint => ({
	attributes: mergeAttributes(ctx, labels),
	startTimeUnixNano: EPOCH_NANO,
	timeUnixNano: toUnixNano(timestampMs ?? ctx.scrapeTimeMs),
	asDouble: value,
})

/** Stable fingerprint of a label set, excluding a component label. */
const seriesKey = (labels: Readonly<Record<string, string>>, exclude: string): string =>
	JSON.stringify(
		Object.keys(labels)
			.filter((key) => key !== exclude)
			.sort()
			.map((key) => [key, labels[key]]),
	)

const withoutLabel = (labels: Readonly<Record<string, string>>, name: string): Record<string, string> => {
	const { [name]: _, ...rest } = labels
	return rest
}

interface HistogramSeries {
	labels: Record<string, string>
	buckets: Array<{ le: number; cumulative: number }>
	sum: number | null
	count: number | null
	timestampMs: number | null
}

interface ConversionState {
	readonly metrics: Array<OtlpMetric>
	counts: { sum: number; gauge: number; histogram: number }
	dropped: number
}

/** Group samples by exact sample name (counters may emit `X_total` under family `X`). */
const groupByName = (samples: ReadonlyArray<PromSample>): Map<string, Array<PromSample>> => {
	const groups = new Map<string, Array<PromSample>>()
	for (const sample of samples) {
		const group = groups.get(sample.name)
		if (group) group.push(sample)
		else groups.set(sample.name, [sample])
	}
	return groups
}

const convertNumberFamily = (
	family: PromMetricFamily,
	ctx: ScrapeOtlpContext,
	state: ConversionState,
	kind: "counter" | "gauge",
): void => {
	for (const [name, samples] of groupByName(family.samples)) {
		const dataPoints: Array<OtlpNumberDataPoint> = []
		for (const sample of samples) {
			// JSON cannot carry NaN/Infinity; drop non-finite points.
			if (!Number.isFinite(sample.value)) {
				state.dropped++
				continue
			}
			dataPoints.push(numberDataPoint(ctx, sample.labels, sample.value, sample.timestampMs))
		}
		if (dataPoints.length === 0) continue
		if (kind === "counter") {
			state.metrics.push({
				name,
				description: family.help ?? "",
				unit: family.unit ?? "",
				sum: { dataPoints, aggregationTemporality: CUMULATIVE, isMonotonic: true },
			})
			state.counts.sum += dataPoints.length
		} else {
			state.metrics.push({
				name,
				description: family.help ?? "",
				unit: family.unit ?? "",
				gauge: { dataPoints },
			})
			state.counts.gauge += dataPoints.length
		}
	}
}

const convertHistogramFamily = (
	family: PromMetricFamily,
	ctx: ScrapeOtlpContext,
	state: ConversionState,
): void => {
	const series = new Map<string, HistogramSeries>()

	const seriesFor = (sample: PromSample): HistogramSeries => {
		const key = seriesKey(sample.labels, "le")
		let entry = series.get(key)
		if (!entry) {
			entry = {
				labels: withoutLabel(sample.labels, "le"),
				buckets: [],
				sum: null,
				count: null,
				timestampMs: sample.timestampMs,
			}
			series.set(key, entry)
		}
		return entry
	}

	for (const sample of family.samples) {
		if (sample.name === `${family.name}_bucket`) {
			const le = sample.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample.labels.le)
			if (sample.labels.le === undefined || Number.isNaN(le) || !Number.isFinite(sample.value)) {
				state.dropped++
				continue
			}
			seriesFor(sample).buckets.push({ le, cumulative: sample.value })
		} else if (sample.name === `${family.name}_sum`) {
			seriesFor(sample).sum = sample.value
		} else if (sample.name === `${family.name}_count`) {
			seriesFor(sample).count = sample.value
		}
		// A bare `family.name` sample inside a histogram family is malformed; ignore.
	}

	const dataPoints: Array<OtlpHistogramDataPoint> = []
	for (const entry of series.values()) {
		entry.buckets.sort((a, b) => a.le - b.le)

		const infBucket = entry.buckets.find((bucket) => bucket.le === Number.POSITIVE_INFINITY)
		const totalCount = entry.count ?? infBucket?.cumulative ?? null
		if (totalCount === null || !Number.isFinite(totalCount)) {
			state.dropped++
			continue
		}

		const finiteBuckets = entry.buckets.filter((bucket) => Number.isFinite(bucket.le))
		const explicitBounds = finiteBuckets.map((bucket) => bucket.le)

		// Prometheus buckets are cumulative; OTLP bucket_counts are per-bucket.
		// The +Inf bucket becomes the final entry, so
		// bucketCounts.length === explicitBounds.length + 1.
		const bucketCounts: Array<number> = []
		let previous = 0
		for (const bucket of finiteBuckets) {
			bucketCounts.push(Math.max(0, bucket.cumulative - previous))
			previous = bucket.cumulative
		}
		bucketCounts.push(Math.max(0, totalCount - previous))

		dataPoints.push({
			attributes: mergeAttributes(ctx, entry.labels),
			startTimeUnixNano: EPOCH_NANO,
			timeUnixNano: toUnixNano(entry.timestampMs ?? ctx.scrapeTimeMs),
			count: totalCount,
			...(entry.sum !== null && Number.isFinite(entry.sum) ? { sum: entry.sum } : undefined),
			bucketCounts,
			explicitBounds,
		})
	}

	if (dataPoints.length > 0) {
		state.metrics.push({
			name: family.name,
			description: family.help ?? "",
			unit: family.unit ?? "",
			histogram: { dataPoints, aggregationTemporality: CUMULATIVE },
		})
		state.counts.histogram += dataPoints.length
	}
}

/**
 * The gateway drops OTLP Summary metrics (no warehouse table), so summaries
 * degrade here: `_sum`/`_count` as cumulative sums, quantile series as a
 * gauge keeping the `quantile` attribute — same shape the contrib exporter
 * uses when summaries are unsupported.
 */
const convertSummaryFamily = (
	family: PromMetricFamily,
	ctx: ScrapeOtlpContext,
	state: ConversionState,
): void => {
	const sumPoints: Array<OtlpNumberDataPoint> = []
	const countPoints: Array<OtlpNumberDataPoint> = []
	const quantilePoints: Array<OtlpNumberDataPoint> = []

	for (const sample of family.samples) {
		if (!Number.isFinite(sample.value)) {
			// Includes NaN quantiles ("no observations yet").
			state.dropped++
			continue
		}
		const point = numberDataPoint(ctx, sample.labels, sample.value, sample.timestampMs)
		if (sample.name === `${family.name}_sum`) sumPoints.push(point)
		else if (sample.name === `${family.name}_count`) countPoints.push(point)
		else quantilePoints.push(point)
	}

	if (sumPoints.length > 0) {
		state.metrics.push({
			name: `${family.name}_sum`,
			description: family.help ?? "",
			unit: family.unit ?? "",
			// Summary sums can decrease with negative observations.
			sum: { dataPoints: sumPoints, aggregationTemporality: CUMULATIVE, isMonotonic: false },
		})
		state.counts.sum += sumPoints.length
	}
	if (countPoints.length > 0) {
		state.metrics.push({
			name: `${family.name}_count`,
			description: family.help ?? "",
			unit: family.unit ?? "",
			sum: { dataPoints: countPoints, aggregationTemporality: CUMULATIVE, isMonotonic: true },
		})
		state.counts.sum += countPoints.length
	}
	if (quantilePoints.length > 0) {
		state.metrics.push({
			name: family.name,
			description: family.help ?? "",
			unit: family.unit ?? "",
			gauge: { dataPoints: quantilePoints },
		})
		state.counts.gauge += quantilePoints.length
	}
}

export const convertFamiliesToOtlp = (
	families: ReadonlyArray<PromMetricFamily>,
	ctx: ScrapeOtlpContext,
): ConvertedOtlp => {
	const state: ConversionState = {
		metrics: [],
		counts: { sum: 0, gauge: 0, histogram: 0 },
		dropped: 0,
	}

	for (const family of families) {
		switch (family.type) {
			case "counter":
				convertNumberFamily(family, ctx, state, "counter")
				break
			case "gauge":
			case "untyped":
				convertNumberFamily(family, ctx, state, "gauge")
				break
			case "histogram":
				convertHistogramFamily(family, ctx, state)
				break
			case "summary":
				convertSummaryFamily(family, ctx, state)
				break
		}
	}

	const request: OtlpExportRequest | null =
		state.metrics.length === 0
			? null
			: {
					resourceMetrics: [
						{
							resource: {
								attributes: [
									// maple_org_id is intentionally NOT set: the gateway strips
									// any client-supplied org attribution and injects it from
									// the ingest key.
									{ key: "service.name", value: { stringValue: ctx.serviceName } },
									{ key: "maple_scrape_target_id", value: { stringValue: ctx.targetId } },
									{
										key: "maple_scrape_target_name",
										value: { stringValue: ctx.targetName },
									},
								],
							},
							scopeMetrics: [{ scope: { name: SCOPE_NAME }, metrics: state.metrics }],
						},
					],
				}

	return { request, dataPointCounts: state.counts, droppedSeriesCount: state.dropped }
}
