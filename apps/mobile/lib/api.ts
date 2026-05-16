const API_BASE_URL =
	process.env.EXPO_PUBLIC_API_BASE_URL ?? (__DEV__ ? "http://127.0.0.1:3472" : "https://api.maple.dev")

let getToken: (() => Promise<string | null>) | undefined

export function setAuthTokenProvider(provider: () => Promise<string | null>) {
	getToken = provider
}

async function apiRequest<T>(path: string, body: unknown): Promise<T> {
	const token = getToken ? await getToken() : null
	const headers: Record<string, string> = { "content-type": "application/json" }
	if (token) headers.authorization = `Bearer ${token}`

	const res = await fetch(`${API_BASE_URL}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		throw new Error(`API ${path} failed: ${res.status}`)
	}

	return res.json()
}

async function apiGet<T>(path: string): Promise<T> {
	const token = getToken ? await getToken() : null
	const headers: Record<string, string> = { accept: "application/json" }
	if (token) headers.authorization = `Bearer ${token}`

	const res = await fetch(`${API_BASE_URL}${path}`, {
		method: "GET",
		headers,
	})

	if (!res.ok) {
		throw new Error(`API ${path} failed: ${res.status}`)
	}

	return res.json()
}

// ── Queries ──

export interface ServiceUsage {
	serviceName: string
	totalLogs: number
	totalTraces: number
	totalMetrics: number
	dataSizeBytes: number
}

export async function fetchServiceUsage(startTime: string, endTime: string): Promise<ServiceUsage[]> {
	const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
		"/api/query-engine/service-usage",
		{ startTime, endTime },
	)

	return (res.data ?? []).map((row) => ({
		serviceName: String(row.serviceName ?? ""),
		totalLogs: Number(row.totalLogCount ?? 0),
		totalTraces: Number(row.totalTraceCount ?? 0),
		totalMetrics:
			Number(row.totalSumMetricCount ?? 0) +
			Number(row.totalGaugeMetricCount ?? 0) +
			Number(row.totalHistogramMetricCount ?? 0) +
			Number(row.totalExpHistogramMetricCount ?? 0),
		dataSizeBytes: Number(row.totalSizeBytes ?? 0),
	}))
}

export interface TimeSeriesPoint {
	bucket: string
	throughput: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
}

export async function fetchOverviewTimeSeries(
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<TimeSeriesPoint[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			filters: { rootSpansOnly: true },
			bucketSeconds,
		},
	})

	if (res.result.kind !== "timeseries") return []

	return res.result.data.map((p) => ({
		bucket: p.bucket,
		throughput: p.series.count ?? 0,
		errorRate: p.series.error_rate ?? 0,
		p50LatencyMs: p.series.p50_duration ?? 0,
		p95LatencyMs: p.series.p95_duration ?? 0,
		p99LatencyMs: p.series.p99_duration ?? 0,
	}))
}

export interface LogsTimeSeriesPoint {
	bucket: string
	count: number
}

export async function fetchLogsTimeSeries(
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<LogsTimeSeriesPoint[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "timeseries",
			source: "logs",
			metric: "count",
			bucketSeconds,
		},
	})

	if (res.result.kind !== "timeseries") return []

	return res.result.data.map((p) => ({
		bucket: p.bucket,
		count: p.series.all ?? p.series.count ?? 0,
	}))
}

// ── Services ──

export interface ServiceOverview {
	serviceName: string
	environment: string
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	errorRate: number // ratio 0-1
	/** req/s. Sampling-extrapolated value when `hasSampling` is true, else raw root-span count/sec. */
	throughput: number
	/** req/s of actually-traced spans. Equals `throughput` when `hasSampling` is false. */
	tracedThroughput: number
	hasSampling: boolean
	/** Extrapolation weight (1 / acceptanceProbability) derived from the OTel TraceState `th:` value. */
	samplingWeight: number
}

/**
 * Summarize sampling-aware throughput for a single row.
 * Mirrors apps/web/src/lib/sampling.ts:summarizeSampling — including the
 * estimatedSpanCount=0 fallback for historical buckets that pre-date the
 * SampleRateSum column.
 */
function summarizeSampling(
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

export async function fetchServiceOverview(startTime: string, endTime: string): Promise<ServiceOverview[]> {
	const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
		"/api/query-engine/service-overview",
		{ startTime, endTime },
	)

	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const durationSeconds = Math.max((endMs - startMs) / 1000, 1)

	// Group raw rows by service+environment and aggregate. The service-overview
	// SQL groups by (service, environment, commitSha), so multiple rows can map
	// to the same service+environment when there are multiple commits in flight.
	interface RawRow {
		serviceName: string
		environment: string
		spanCount: number
		errorCount: number
		p50LatencyMs: number
		p95LatencyMs: number
		p99LatencyMs: number
		estimatedSpanCount: number
	}

	const groups = new Map<string, RawRow[]>()

	for (const raw of res.data ?? []) {
		const serviceName = String(raw.serviceName ?? "")
		const environment = String(raw.environment ?? "unknown")
		const key = `${serviceName}::${environment}`

		const row: RawRow = {
			serviceName,
			environment,
			spanCount: Number(raw.spanCount ?? 0),
			errorCount: Number(raw.errorCount ?? 0),
			p50LatencyMs: Number(raw.p50LatencyMs ?? 0),
			p95LatencyMs: Number(raw.p95LatencyMs ?? 0),
			p99LatencyMs: Number(raw.p99LatencyMs ?? 0),
			estimatedSpanCount: Number(raw.estimatedSpanCount ?? 0),
		}

		const group = groups.get(key)
		if (group) {
			group.push(row)
		} else {
			groups.set(key, [row])
		}
	}

	const results: ServiceOverview[] = []

	for (const group of groups.values()) {
		const totalSpans = group.reduce((sum, r) => sum + r.spanCount, 0)
		const totalErrors = group.reduce((sum, r) => sum + r.errorCount, 0)
		const totalEstimated = group.reduce((sum, r) => sum + r.estimatedSpanCount, 0)

		const sampling = summarizeSampling(totalEstimated, totalSpans, durationSeconds)

		let p50 = 0
		let p95 = 0
		let p99 = 0
		if (totalSpans > 0) {
			for (const r of group) {
				const weight = r.spanCount / totalSpans
				p50 += r.p50LatencyMs * weight
				p95 += r.p95LatencyMs * weight
				p99 += r.p99LatencyMs * weight
			}
		}

		results.push({
			serviceName: group[0].serviceName,
			environment: group[0].environment,
			p50LatencyMs: p50,
			p95LatencyMs: p95,
			p99LatencyMs: p99,
			errorRate: totalSpans > 0 ? totalErrors / totalSpans : 0,
			throughput: sampling.hasSampling ? sampling.estimated : sampling.traced,
			tracedThroughput: sampling.traced,
			hasSampling: sampling.hasSampling,
			samplingWeight: sampling.weight,
		})
	}

	results.sort((a, b) => b.throughput - a.throughput)
	return results
}

/** Fetch per-service error rate timeseries for sparklines. Returns a map of serviceName → error rate values. */
export async function fetchServiceSparklines(
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<Record<string, number[]>> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "error_rate",
			filters: { rootSpansOnly: true },
			groupBy: ["service"],
			bucketSeconds,
		},
	})

	if (res.result.kind !== "timeseries") return {}

	// series keys are service names, values are error rates per bucket
	const byService: Record<string, number[]> = {}
	for (const point of res.result.data) {
		for (const [service, value] of Object.entries(point.series)) {
			if (!byService[service]) byService[service] = []
			byService[service].push(value)
		}
	}
	return byService
}

// ── Service Detail ──

export interface ServiceDetailPoint {
	bucket: string
	/**
	 * Requests per second. Sampling-extrapolated value when `hasSampling` is true,
	 * otherwise raw root-span count divided by bucket seconds. Already divided by
	 * bucketSeconds — unlike `fetchOverviewTimeSeries`, which returns raw bucket counts.
	 */
	throughput: number
	/** req/s of actually-traced spans. Equals `throughput` when `hasSampling` is false. */
	tracedThroughput: number
	/** True when SpanMetrics-derived throughput was used (sampling detected/extrapolation applied). */
	hasSampling: boolean
	/** `metricsCount / rawCount` when sampling detected, else 1. */
	samplingWeight: number
	/** Error rate as a percentage 0–100 (the query engine already multiplies by 100). */
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
}

// SpanMetrics connector metric names — try namespaced first, then default.
// Mirrors apps/web/src/api/tinybird/custom-charts.ts:22.
const SPANMETRICS_CALLS_CANDIDATES = ["span.metrics.calls", "calls"] as const

/**
 * Normalize Tinybird-style bucket strings (`"YYYY-MM-DD HH:MM:SS"`) to ISO so that
 * keys from two different query-engine responses align in a Map. Defensive: both
 * queries hit the same endpoint and should already match, but normalizing makes
 * the merge robust to any future drift.
 */
function normalizeBucket(bucket: string): string {
	let out = bucket.includes(" ") ? bucket.replace(" ", "T") : bucket
	if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(out)) out = `${out}Z`
	return out
}

/**
 * Query the OpenTelemetry SpanMetrics Connector for unsampled call counts per bucket.
 * Returns an empty Map if the metric is not present or the query fails — callers
 * should treat that as "no sampling extrapolation available".
 *
 * Mirrors apps/web/src/api/tinybird/custom-charts.ts:24-74 (querySpanMetricsCalls).
 */
async function fetchSpanMetricsCalls(
	serviceName: string,
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<Map<string, number>> {
	try {
		for (const metricName of SPANMETRICS_CALLS_CANDIDATES) {
			const res = await apiRequest<{
				result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
			}>("/api/query-engine/execute", {
				startTime,
				endTime,
				query: {
					kind: "timeseries",
					source: "metrics",
					metric: "sum",
					groupBy: ["service"],
					filters: {
						metricName,
						metricType: "sum",
						serviceName,
						attributeFilters: [{ key: "span.kind", value: "SPAN_KIND_SERVER", mode: "equals" }],
					},
					bucketSeconds,
				},
			})

			if (res.result.kind !== "timeseries" || res.result.data.length === 0) continue

			const map = new Map<string, number>()
			for (const point of res.result.data) {
				// Sum all numeric series entries — there's only one because we filter by
				// serviceName, but summing protects against minor name normalization
				// differences in how the collector reports the service.
				let total = 0
				for (const value of Object.values(point.series)) {
					if (typeof value === "number") total += value
				}
				if (total > 0) map.set(normalizeBucket(point.bucket), total)
			}
			if (map.size > 0) return map
		}
	} catch {
		// Swallow — if span metrics are unavailable we fall back to traced throughput.
	}
	return new Map()
}

export async function fetchServiceDetailTimeSeries(
	serviceName: string,
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<ServiceDetailPoint[]> {
	const tracesPromise = apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			filters: { rootSpansOnly: true, serviceName },
			bucketSeconds,
		},
	})

	// Two parallel requests:
	//  1. The trace timeseries (count + per-bucket `estimated_span_count` —
	//     the per-row weighted sum from the query engine).
	//  2. The SpanMetrics-based throughput (preferred — works when the OTel
	//     Collector SpanMetrics Connector is deployed).
	const [tracesRes, metricsByBucket] = await Promise.all([
		tracesPromise,
		fetchSpanMetricsCalls(serviceName, startTime, endTime, bucketSeconds),
	])

	const divisor = bucketSeconds > 0 ? bucketSeconds : 1

	interface TracesEntry {
		count: number
		estimatedSpanCount: number
		errorRate: number
		p50: number
		p95: number
		p99: number
	}

	const tracesByBucket = new Map<string, TracesEntry>()
	if (tracesRes.result.kind === "timeseries") {
		for (const p of tracesRes.result.data) {
			tracesByBucket.set(normalizeBucket(p.bucket), {
				count: p.series.count ?? 0,
				estimatedSpanCount: p.series.estimated_span_count ?? 0,
				errorRate: p.series.error_rate ?? 0,
				p50: p.series.p50_duration ?? 0,
				p95: p.series.p95_duration ?? 0,
				p99: p.series.p99_duration ?? 0,
			})
		}
	}

	const allBuckets = new Set<string>()
	for (const k of tracesByBucket.keys()) allBuckets.add(k)
	for (const k of metricsByBucket.keys()) allBuckets.add(k)

	const sortedBuckets = [...allBuckets].sort()

	return sortedBuckets.map((bucket): ServiceDetailPoint => {
		const t = tracesByBucket.get(bucket)
		const rawCount = t?.count ?? 0
		const metricsCount = metricsByBucket.get(bucket) ?? 0
		const rawPerSec = rawCount / divisor

		// Prefer SpanMetrics Connector when present (exact pre-sampling counts).
		// Otherwise use the per-row weighted sum from the query engine, which is
		// correct under mixed sampling rates. Fall back to rawCount when neither
		// is available (e.g. no sampling configured) — `?? rawCount` is wrong
		// here because estimatedSpanCount is coerced to 0 when missing.
		const estimatedFromQuery = t?.estimatedSpanCount ?? 0
		const estimatedCount =
			metricsCount > 0 ? metricsCount : estimatedFromQuery > 0 ? estimatedFromQuery : rawCount
		const throughput = estimatedCount / divisor
		const samplingWeight = rawCount > 0 ? estimatedCount / rawCount : 1
		const hasSampling = samplingWeight > 1.01

		return {
			bucket,
			throughput,
			tracedThroughput: rawPerSec,
			hasSampling,
			samplingWeight,
			errorRate: t?.errorRate ?? 0,
			p50LatencyMs: t?.p50 ?? 0,
			p95LatencyMs: t?.p95 ?? 0,
			p99LatencyMs: t?.p99 ?? 0,
		}
	})
}

export interface ApdexPoint {
	bucket: string
	apdexScore: number
	totalCount: number
}

export async function fetchServiceApdex(
	serviceName: string,
	startTime: string,
	endTime: string,
	bucketSeconds: number,
): Promise<ApdexPoint[]> {
	const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
		"/api/query-engine/service-apdex",
		{ serviceName, startTime, endTime, bucketSeconds },
	)

	return (res.data ?? []).map((row) => ({
		bucket: String(row.bucket ?? ""),
		apdexScore: Number(row.apdexScore ?? 0),
		totalCount: Number(row.totalCount ?? 0),
	}))
}

// ── Span Hierarchy ──

export interface SpanHierarchyRow {
	traceId: string
	spanId: string
	parentSpanId: string
	spanName: string
	serviceName: string
	spanKind: string
	durationMs: number
	startTime: string
	statusCode: string
	statusMessage: string
	spanAttributes: string
	resourceAttributes: string
}

export interface Span {
	traceId: string
	spanId: string
	parentSpanId: string
	spanName: string
	serviceName: string
	spanKind: string
	durationMs: number
	startTime: string
	statusCode: string
	statusMessage: string
	spanAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

export interface SpanNode extends Span {
	children: SpanNode[]
	depth: number
	isMissing?: boolean
}

export async function fetchSpanHierarchy(traceId: string): Promise<SpanHierarchyRow[]> {
	const res = await apiRequest<{ data: SpanHierarchyRow[] }>("/api/query-engine/span-hierarchy", {
		traceId,
	})
	return res.data ?? []
}

// ── Traces ──

export interface HttpInfo {
	method: string
	route: string | null
	statusCode: number | null
	isError: boolean
}

export interface Trace {
	traceId: string
	startTime: string
	durationMs: number
	spanCount: number
	services: string[]
	rootSpanName: string
	hasError: boolean
	http: HttpInfo | null
	statusCode: string
}

export function getHttpInfo(spanName: string, attrs: Record<string, string>): HttpInfo | null {
	const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
	let method = attrs["http.method"] || attrs["http.request.method"]
	let route: string | null = attrs["http.route"] || attrs["http.target"] || attrs["url.path"] || null

	if (!method) {
		const parts = spanName.split(" ")
		if (spanName.startsWith("http.server ") && parts.length >= 2) {
			method = parts[1]
			if (!route && parts.length >= 3) route = parts.slice(2).join(" ")
		} else if (
			parts.length >= 2 &&
			HTTP_METHODS.includes(parts[0].toUpperCase() as (typeof HTTP_METHODS)[number])
		) {
			method = parts[0].toUpperCase()
			if (!route) route = parts.slice(1).join(" ")
		} else if (HTTP_METHODS.includes(spanName.toUpperCase() as (typeof HTTP_METHODS)[number])) {
			method = spanName.toUpperCase()
		}
	}

	if (!method) return null

	const rawStatus = attrs["http.status_code"] || attrs["http.response.status_code"]
	const statusCode = rawStatus ? parseInt(rawStatus, 10) || null : null

	return {
		method: method.toUpperCase(),
		route,
		statusCode,
		isError: statusCode != null && statusCode >= 500,
	}
}

function transformTraceRow(row: Record<string, unknown>): Trace {
	const spanAttrs = (row.spanAttributes ?? {}) as Record<string, string>
	const httpAttrs: Record<string, string> = {}
	for (const key of [
		"http.method",
		"http.route",
		"http.status_code",
		"http.request.method",
		"url.path",
		"http.response.status_code",
		"http.target",
	]) {
		if (spanAttrs[key]) httpAttrs[key] = spanAttrs[key]
	}

	return {
		traceId: String(row.traceId),
		startTime: String(row.timestamp),
		durationMs: Number(row.durationMs),
		spanCount: 1,
		services: [String(row.serviceName)],
		rootSpanName: String(row.spanName),
		hasError: row.hasError === true || row.hasError === 1,
		http: getHttpInfo(String(row.spanName), httpAttrs),
		statusCode: String(row.statusCode),
	}
}

export interface TraceFilters {
	serviceName?: string
	spanName?: string
	errorsOnly?: boolean
}

export async function fetchTraces(
	startTime: string,
	endTime: string,
	opts?: { limit?: number; offset?: number; filters?: TraceFilters },
): Promise<Trace[]> {
	const f = opts?.filters
	const matchModes: Record<string, string> = {}
	if (f?.serviceName) matchModes.serviceName = "contains"
	if (f?.spanName) matchModes.spanName = "contains"

	const res = await apiRequest<{
		result: { kind: string; data: Array<Record<string, unknown>> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "list",
			source: "traces",
			limit: opts?.limit ?? 50,
			offset: opts?.offset ?? 0,
			filters: {
				rootSpansOnly: true,
				serviceName: f?.serviceName,
				spanName: f?.spanName,
				errorsOnly: f?.errorsOnly,
				matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
			},
		},
	})

	if (res.result.kind !== "list") return []

	return res.result.data.map(transformTraceRow)
}

export interface TracesFacets {
	services: Array<{ name: string; count: number }>
	spanNames: Array<{ name: string; count: number }>
}

export async function fetchTracesFacets(startTime: string, endTime: string): Promise<TracesFacets> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<Record<string, unknown>> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "facets",
			source: "traces",
			filters: { rootSpansOnly: true },
		},
	})

	if (res.result.kind !== "facets") return { services: [], spanNames: [] }

	const toItem = (row: Record<string, unknown>) => ({
		name: String(row.name ?? ""),
		count: Number(row.count ?? 0),
	})
	const byType = (type: string) => res.result.data.filter((r) => String(r.facetType) === type).map(toItem)

	return {
		services: byType("service"),
		spanNames: byType("spanName"),
	}
}

// ── Logs ──

export interface Log {
	timestamp: string
	severityText: string
	severityNumber: number
	serviceName: string
	body: string
	traceId: string
	spanId: string
	logAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

export interface LogsPage {
	data: Log[]
	cursor: string | null
}

function parseAttributes(value: unknown): Record<string, string> {
	if (!value || typeof value !== "string") return {}
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

function transformLogRow(row: Record<string, unknown>): Log {
	return {
		timestamp: String(row.timestamp ?? ""),
		severityText: String(row.severityText ?? ""),
		severityNumber: Number(row.severityNumber ?? 0),
		serviceName: String(row.serviceName ?? ""),
		body: String(row.body ?? ""),
		traceId: String(row.traceId ?? ""),
		spanId: String(row.spanId ?? ""),
		logAttributes: parseAttributes(row.logAttributes),
		resourceAttributes: parseAttributes(row.resourceAttributes),
	}
}

export interface LogsFacets {
	services: Array<{ name: string; count: number }>
	severities: Array<{ name: string; count: number }>
}

export async function fetchLogsFacets(startTime: string, endTime: string): Promise<LogsFacets> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<Record<string, unknown>> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: {
			kind: "facets",
			source: "logs",
		},
	})

	if (res.result.kind !== "facets") return { services: [], severities: [] }

	const toItem = (row: Record<string, unknown>) => ({
		name: String(row.name ?? ""),
		count: Number(row.count ?? 0),
	})
	const byType = (type: string) => res.result.data.filter((r) => String(r.facetType) === type).map(toItem)

	return {
		services: byType("service"),
		severities: byType("severity"),
	}
}

export interface LogsFilters {
	service?: string
	severity?: string
	search?: string
}

export async function fetchLogs(
	startTime: string,
	endTime: string,
	opts?: { limit?: number; cursor?: string; filters?: LogsFilters },
): Promise<LogsPage> {
	const limit = opts?.limit ?? 50
	const f = opts?.filters

	const res = await apiRequest<{ data: Array<Record<string, unknown>> }>("/api/query-engine/list-logs", {
		startTime,
		endTime,
		limit,
		cursor: opts?.cursor,
		service: f?.service,
		severity: f?.severity,
		search: f?.search,
	})

	const logs = (res.data ?? []).map(transformLogRow)
	const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null

	return { data: logs, cursor }
}

// ── Dashboards ──
//
// Narrow TS mirrors of the Effect schema in packages/domain/src/http/dashboards.ts.
// We deliberately don't import the Effect schema — the mobile app stays Effect-free.

export type WidgetTimeRange =
	| { type: "relative"; value: string }
	| { type: "absolute"; startTime: string; endTime: string }

export interface WidgetAttributeFilter {
	key: string
	value?: string
	mode: "equals" | "exists"
}

export interface WidgetFilters {
	serviceName?: string
	spanName?: string
	severity?: string
	metricName?: string
	metricType?: "sum" | "gauge" | "histogram" | "exponential_histogram"
	rootSpansOnly?: boolean
	environments?: string[]
	commitShas?: string[]
	attributeFilters?: WidgetAttributeFilter[]
	resourceAttributeFilters?: WidgetAttributeFilter[]
}

export interface WidgetTimeseriesParams {
	source: "traces" | "logs" | "metrics"
	metric: string
	groupBy?: "service" | "span_name" | "status_code" | "severity" | "attribute" | "none"
	filters?: WidgetFilters
	bucketSeconds?: number
	apdexThresholdMs?: number
}

export interface WidgetBreakdownParams {
	source: "traces" | "logs" | "metrics"
	metric: string
	groupBy: "service" | "span_name" | "status_code" | "http_method" | "severity" | "attribute"
	filters?: WidgetFilters
	limit?: number
}

export interface WidgetDataSource {
	endpoint: string
	params?: Record<string, unknown>
	transform?: {
		fieldMap?: Record<string, string>
		flattenSeries?: { valueField: string }
		reduceToValue?: { field: string; aggregate?: string }
		computeRatio?: { numeratorName: string; denominatorNames: string[] }
		limit?: number
		sortBy?: { field: string; direction: string }
	}
}

export interface WidgetThreshold {
	value: number
	color: string
	label?: string
}

export interface WidgetDisplayConfig {
	title?: string
	description?: string
	chartId?: string
	unit?: string
	prefix?: string
	suffix?: string
	stacked?: boolean
	thresholds?: WidgetThreshold[]
	colorOverrides?: Record<string, string>
	seriesMapping?: Record<string, string>
}

export interface WidgetLayout {
	x: number
	y: number
	w: number
	h: number
}

export interface DashboardWidget {
	id: string
	visualization: string // "chart" | "stat" | "table" | "list"
	dataSource: WidgetDataSource
	display: WidgetDisplayConfig
	layout: WidgetLayout
}

export interface DashboardDocument {
	id: string
	name: string
	description?: string
	tags?: string[]
	timeRange: WidgetTimeRange
	widgets: DashboardWidget[]
	createdAt: string
	updatedAt: string
}

export async function fetchDashboards(): Promise<DashboardDocument[]> {
	const res = await apiGet<{ dashboards: DashboardDocument[] }>("/api/dashboards/")
	return res.dashboards ?? []
}

/** Map a `WidgetTimeseriesParams` shape into the query-engine `kind: "timeseries"` body. */
function buildTimeseriesQuery(params: WidgetTimeseriesParams, bucketSeconds: number) {
	const filters: Record<string, unknown> = {
		serviceName: params.filters?.serviceName,
		spanName: params.filters?.spanName,
		severity: params.filters?.severity,
		metricName: params.filters?.metricName,
		metricType: params.filters?.metricType,
		rootSpansOnly: params.filters?.rootSpansOnly,
		environments: params.filters?.environments,
		commitShas: params.filters?.commitShas,
		attributeFilters: params.filters?.attributeFilters,
		resourceAttributeFilters: params.filters?.resourceAttributeFilters,
	}

	return {
		kind: "timeseries" as const,
		source: params.source,
		metric: params.metric,
		groupBy: params.groupBy && params.groupBy !== "none" ? [params.groupBy] : undefined,
		apdexThresholdMs: params.apdexThresholdMs,
		filters,
		bucketSeconds,
	}
}

export interface CustomTimeseriesPoint {
	bucket: string
	series: Record<string, number>
}

export async function fetchCustomTimeseries(
	startTime: string,
	endTime: string,
	bucketSeconds: number,
	params: WidgetTimeseriesParams,
): Promise<CustomTimeseriesPoint[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: buildTimeseriesQuery(params, bucketSeconds),
	})

	if (res.result.kind !== "timeseries") return []
	return res.result.data.map((p) => ({ bucket: p.bucket, series: { ...p.series } }))
}

function buildBreakdownQuery(params: WidgetBreakdownParams) {
	const filters: Record<string, unknown> = {
		serviceName: params.filters?.serviceName,
		spanName: params.filters?.spanName,
		severity: params.filters?.severity,
		metricName: params.filters?.metricName,
		metricType: params.filters?.metricType,
		rootSpansOnly: params.filters?.rootSpansOnly,
		environments: params.filters?.environments,
		commitShas: params.filters?.commitShas,
		attributeFilters: params.filters?.attributeFilters,
		resourceAttributeFilters: params.filters?.resourceAttributeFilters,
	}

	return {
		kind: "breakdown" as const,
		source: params.source,
		metric: params.metric,
		groupBy: params.groupBy,
		filters,
		limit: params.limit,
	}
}

export interface CustomBreakdownItem {
	name: string
	value: number
}

// ── Query-builder widgets (custom_query_builder_*) ──
//
// The dashboard builder's "query builder" widgets store an array of
// QueryBuilderQueryDraft objects in `dataSource.params.queries`. Mobile sends
// them as-is to the new /api/query-engine/execute-query-builder endpoint, which
// translates each draft into a QuerySpec and merges results.

interface QueryBuilderQueryDraftBase {
	id: string
	name: string
	enabled: boolean
	whereClause: string
	aggregation: string
	stepInterval: string
	addOns: { groupBy: boolean; having: boolean; orderBy: boolean; limit: boolean; legend: boolean }
	groupBy: string[]
	// Optional fields — included if present in the saved widget params
	hidden?: boolean
	orderByDirection?: "desc" | "asc"
	having?: string
	orderBy?: string
	limit?: string
	legend?: string
}

// Source-discriminated: trace/log queries never carry metric-only fields.
export type QueryBuilderQueryDraft =
	| (QueryBuilderQueryDraftBase & { dataSource: "traces" })
	| (QueryBuilderQueryDraftBase & { dataSource: "logs" })
	| (QueryBuilderQueryDraftBase & {
			dataSource: "metrics"
			signalSource?: "default" | "meter"
			metricName: string
			metricType: "sum" | "gauge" | "histogram" | "exponential_histogram"
			isMonotonic?: boolean
	  })

export async function fetchQueryBuilderTimeseries(
	startTime: string,
	endTime: string,
	queries: QueryBuilderQueryDraft[],
): Promise<CustomTimeseriesPoint[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
	}>("/api/query-engine/execute-query-builder", {
		startTime,
		endTime,
		kind: "timeseries",
		queries,
	})

	if (res.result.kind !== "timeseries") return []
	return res.result.data.map((p) => ({ bucket: p.bucket, series: { ...p.series } }))
}

export async function fetchQueryBuilderBreakdown(
	startTime: string,
	endTime: string,
	queries: QueryBuilderQueryDraft[],
): Promise<CustomBreakdownItem[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<{ name: string; value: number }> }
	}>("/api/query-engine/execute-query-builder", {
		startTime,
		endTime,
		kind: "breakdown",
		queries,
	})

	if (res.result.kind !== "breakdown") return []
	return res.result.data.map((item) => ({ name: item.name, value: item.value }))
}

export async function fetchCustomBreakdown(
	startTime: string,
	endTime: string,
	params: WidgetBreakdownParams,
): Promise<CustomBreakdownItem[]> {
	const res = await apiRequest<{
		result: { kind: string; data: Array<Record<string, unknown>> }
	}>("/api/query-engine/execute", {
		startTime,
		endTime,
		query: buildBreakdownQuery(params),
	})

	if (res.result.kind !== "breakdown") return []
	return res.result.data.map((row) => ({
		name: String(row.name ?? row.label ?? ""),
		value: Number(row.value ?? 0),
	}))
}
