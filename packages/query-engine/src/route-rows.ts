/**
 * Row shaping for the `route`-kind widget endpoints — the last step between a
 * registry query's rows and what a dashboard tile renders.
 *
 * Each of these used to live only in the browser's server function for the
 * endpoint (`apps/web/src/api/warehouse/*`), so the signed-in board saw shaped
 * rows while the share API — which reuses the same registry `QueryDefinition`
 * but returned its rows verbatim — served the unshaped ones. For
 * `service_overview` that is not cosmetic: the browser turns `spanCount` into a
 * per-second, sampling-corrected `throughput`, so a "Traffic" stat summing it
 * read 5.6K on the board and 24.4M (raw span totals) on its share link.
 *
 * Both hosts call these now. Pure and host-free: no clock, no transport, no
 * driver — the one input a shaper needs beyond its rows is the window's
 * duration, and the caller hands that in.
 */
import { Schema } from "effect"
import { SpanId, TraceId } from "@maple/domain"
import { parseWarehouseDateTime, warehouseDateTimeToIso } from "./datetime"

// ---------------------------------------------------------------------------
// Sampling helpers (shared with the browser's service pages and custom charts)
// ---------------------------------------------------------------------------

/**
 * Summarize sampling-aware throughput for a single (service, env, …) row.
 *
 * The query engine emits `estimatedSpanCount` as a per-row weighted sum
 * (each span contributes its `SampleRate` factor). `tracedSpanCount` is the
 * unweighted row count actually stored in ClickHouse.
 *
 * - `traced`: per-second rate of stored spans.
 * - `estimated`: per-second rate after extrapolating sampled spans.
 * - `hasSampling`: true when the extrapolation factor is meaningfully above 1.
 * - `weight`: estimated/traced ratio (display-only).
 *
 * Treats `estimatedSpanCount = 0` as "no extrapolation data available" (e.g.
 * historical hourly buckets that pre-date the SampleRateSum column) — falls
 * back to `tracedSpanCount`, yielding weight=1 / hasSampling=false. Without
 * this guard the UI would render "x0" weight badges on old time ranges.
 */
export function summarizeSampling(
	estimatedSpanCount: number,
	tracedSpanCount: number,
	durationSeconds: number,
): { traced: number; estimated: number; hasSampling: boolean; weight: number } {
	const effectiveEstimated = estimatedSpanCount > 0 ? estimatedSpanCount : tracedSpanCount
	const weight = tracedSpanCount > 0 ? effectiveEstimated / tracedSpanCount : 1
	const hasSampling = weight > 1.01
	return {
		traced: durationSeconds > 0 ? tracedSpanCount / durationSeconds : 0,
		estimated: durationSeconds > 0 ? effectiveEstimated / durationSeconds : 0,
		hasSampling,
		weight,
	}
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

/** Seconds spanned by a warehouse window; `fallbackSeconds` when a bound is missing or unparseable. */
export function windowDurationSeconds(
	startTime: string | undefined,
	endTime: string | undefined,
	fallbackSeconds = 3600,
): number {
	const startMs = startTime ? parseWarehouseDateTime(startTime) : 0
	const endMs = endTime ? parseWarehouseDateTime(endTime) : 0
	return startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : fallbackSeconds
}

// ---------------------------------------------------------------------------
// service_overview
// ---------------------------------------------------------------------------

export interface CommitBreakdown {
	commitSha: string
	spanCount: number
	percentage: number
	errorCount: number
	/** Earliest span for this commit inside the queried window ("" when unknown). */
	firstSeen: string
}

export interface ServiceOverview {
	serviceName: string
	serviceNamespace: string
	environment: string
	commits: CommitBreakdown[]
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	errorRate: number
	/** Requests per second, sampling-corrected when the data carries a weight. */
	throughput: number
	/** Requests per second, stored spans only. */
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	spanCount: number
}

/**
 * ClickHouse serializes `tuple(...)` as a positional array in `FORMAT JSON`:
 * `[sha, spanCount, errorCount, firstSeen]`.
 */
type RawCommitTuple = readonly [unknown, unknown, unknown, unknown]

const isCommitTuple = (value: unknown): value is RawCommitTuple => Array.isArray(value) && value.length === 4

/**
 * One services-list row, already collapsed to (service, environment) by
 * `serviceOverviewQuery`.
 *
 * There used to be a re-aggregation step here — the server returned one row per
 * (service, namespace, env, commit) and the client regrouped them, taking a
 * span-count-weighted MEAN of p50/p95/p99. A weighted mean of quantiles is not a
 * quantile. The tDigest states live in ClickHouse, so the merge happens there
 * now and this is a straight decode.
 *
 * `resolveThroughput` / `summarizeSampling` stay here: they need the window
 * duration, which is a property of the request rather than of the row.
 */
export function coerceServiceOverviewRow(
	raw: Record<string, unknown>,
	durationSeconds: number,
): ServiceOverview {
	const spanCount = Number(raw.spanCount ?? 0)
	const errorCount = Number(raw.errorCount ?? 0)
	const estimatedSpanCount = Number(raw.estimatedSpanCount ?? 0)
	const estimatedErrorCount = raw.estimatedErrorCount == null ? undefined : Number(raw.estimatedErrorCount)

	const resolvedCount = resolveThroughput(spanCount, estimatedSpanCount, undefined)
	const sampling = summarizeSampling(resolvedCount, spanCount, durationSeconds)

	const rawCommits = Array.isArray(raw.commits) ? raw.commits : []
	const commits: CommitBreakdown[] = rawCommits.filter(isCommitTuple).map((tuple) => {
		const commitSpanCount = Number(tuple[1] ?? 0)
		return {
			commitSha: String(tuple[0] ?? "N/A"),
			spanCount: commitSpanCount,
			percentage: spanCount > 0 ? Math.round((commitSpanCount / spanCount) * 100) : 0,
			errorCount: Number(tuple[2] ?? 0),
			firstSeen: String(tuple[3] ?? ""),
		}
	})

	return {
		serviceName: String(raw.serviceName ?? ""),
		serviceNamespace: String(raw.serviceNamespace ?? ""),
		environment: String(raw.environment ?? "unknown"),
		commits,
		p50LatencyMs: Number(raw.p50LatencyMs ?? 0),
		p95LatencyMs: Number(raw.p95LatencyMs ?? 0),
		p99LatencyMs: Number(raw.p99LatencyMs ?? 0),
		// Prefer the sampling-corrected ratio; fall back to the raw one when the
		// weighted error count is absent.
		errorRate:
			estimatedErrorCount != null && Number.isFinite(estimatedErrorCount) && estimatedSpanCount > 0
				? estimatedErrorCount / estimatedSpanCount
				: spanCount > 0
					? errorCount / spanCount
					: 0,
		throughput: sampling.hasSampling ? sampling.estimated : sampling.traced,
		tracedThroughput: sampling.traced,
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
		spanCount,
	}
}

/** Rows arrive pre-sorted by throughput from the query's `ORDER BY`. */
export function coerceServiceOverviewRows(
	rows: ReadonlyArray<Record<string, unknown>>,
	durationSeconds: number,
): ServiceOverview[] {
	return rows.map((row) => coerceServiceOverviewRow(row, durationSeconds))
}

// ---------------------------------------------------------------------------
// service_usage
// ---------------------------------------------------------------------------

export interface ServiceUsage {
	serviceName: string
	totalLogs: number
	totalTraces: number
	totalMetrics: number
	dataSizeBytes: number
	logSizeBytes: number
	traceSizeBytes: number
	metricSizeBytes: number
}

export interface ServiceUsageTotals {
	logs: number
	traces: number
	metrics: number
	dataSize: number
}

export function coerceServiceUsageRows(rows: ReadonlyArray<Record<string, unknown>>): ServiceUsage[] {
	return rows.map((row) => ({
		serviceName: String(row.serviceName ?? ""),
		totalLogs: Number(row.totalLogCount ?? 0),
		totalTraces: Number(row.totalTraceCount ?? 0),
		totalMetrics:
			Number(row.totalSumMetricCount ?? 0) +
			Number(row.totalGaugeMetricCount ?? 0) +
			Number(row.totalHistogramMetricCount ?? 0) +
			Number(row.totalExpHistogramMetricCount ?? 0),
		dataSizeBytes: Number(row.totalSizeBytes ?? 0),
		logSizeBytes: Number(row.totalLogSizeBytes ?? 0),
		traceSizeBytes: Number(row.totalTraceSizeBytes ?? 0),
		metricSizeBytes:
			Number(row.totalSumMetricSizeBytes ?? 0) +
			Number(row.totalGaugeMetricSizeBytes ?? 0) +
			Number(row.totalHistogramMetricSizeBytes ?? 0) +
			Number(row.totalExpHistogramMetricSizeBytes ?? 0),
	}))
}

/**
 * When a previous window was requested, the rows carry `previous*` columns;
 * fold them into a single aggregate for the delta chips so the caller doesn't
 * need a second request.
 */
export function serviceUsagePreviousTotals(rows: ReadonlyArray<Record<string, unknown>>): ServiceUsageTotals {
	return rows.reduce<ServiceUsageTotals>(
		(acc, row) => ({
			logs: acc.logs + Number(row.previousLogCount ?? 0),
			traces: acc.traces + Number(row.previousTraceCount ?? 0),
			metrics:
				acc.metrics +
				Number(row.previousSumMetricCount ?? 0) +
				Number(row.previousGaugeMetricCount ?? 0) +
				Number(row.previousHistogramMetricCount ?? 0) +
				Number(row.previousExpHistogramMetricCount ?? 0),
			dataSize: acc.dataSize + Number(row.previousSizeBytes ?? 0),
		}),
		{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
	)
}

// ---------------------------------------------------------------------------
// errors_by_type / errors_summary
// ---------------------------------------------------------------------------

export interface ErrorByType {
	fingerprintHash: string
	errorLabel: string
	sampleMessage: string
	count: number
	affectedServicesCount: number
	firstSeen: Date
	lastSeen: Date
}

export function coerceErrorsByTypeRows(rows: ReadonlyArray<Record<string, unknown>>): ErrorByType[] {
	return rows.map((raw) => ({
		fingerprintHash: String(raw.fingerprintHash ?? ""),
		errorLabel: String(raw.errorLabel ?? ""),
		sampleMessage: String(raw.sampleMessage ?? ""),
		count: Number(raw.count),
		affectedServicesCount: Number(raw.affectedServicesCount),
		firstSeen: new Date(warehouseDateTimeToIso(String(raw.firstSeen ?? ""))),
		lastSeen: new Date(warehouseDateTimeToIso(String(raw.lastSeen ?? ""))),
	}))
}

export interface ErrorsSummary {
	totalErrors: number
	totalSpans: number
	errorRate: number
	affectedServicesCount: number
	affectedTracesCount: number
}

/** The summary is one row; the board renders it as a scalar object, not a one-row list. */
export function coerceErrorsSummary(row: Record<string, unknown> | null | undefined): ErrorsSummary | null {
	if (!row) return null
	return {
		totalErrors: Number(row.totalErrors),
		totalSpans: Number(row.totalSpans),
		errorRate: Number(row.errorRate),
		affectedServicesCount: Number(row.affectedServicesCount),
		affectedTracesCount: Number(row.affectedTracesCount),
	}
}

// ---------------------------------------------------------------------------
// list_logs
// ---------------------------------------------------------------------------

export interface LogRow {
	timestamp: string
	severityText: string
	severityNumber: number
	serviceName: string
	body: string
	traceId: TraceId | undefined
	spanId: SpanId | undefined
	logAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)

function parseAttributes(value: unknown): Record<string, string> {
	if (typeof value !== "string" || value.length === 0) return {}
	try {
		const parsed: unknown = JSON.parse(value)
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
		// SAFETY: the warehouse serialises attribute maps as JSON objects of
		// strings; a non-string value is a schema drift the readers tolerate.
		return parsed as Record<string, string>
	} catch {
		return {}
	}
}

export function coerceLogRow(raw: Record<string, unknown>): LogRow {
	return {
		timestamp: String(raw.timestamp ?? ""),
		severityText: String(raw.severityText ?? ""),
		severityNumber: Number(raw.severityNumber ?? 0),
		serviceName: String(raw.serviceName ?? ""),
		body: String(raw.body ?? ""),
		traceId: raw.traceId ? toTraceId(String(raw.traceId)) : undefined,
		spanId: raw.spanId ? toSpanId(String(raw.spanId)) : undefined,
		logAttributes: parseAttributes(raw.logAttributes),
		resourceAttributes: parseAttributes(raw.resourceAttributes),
	}
}

export function coerceLogRows(rows: ReadonlyArray<Record<string, unknown>>): LogRow[] {
	return rows.map(coerceLogRow)
}
