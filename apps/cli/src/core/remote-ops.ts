// v2-backed implementations of the CLI operations, used in remote mode.
//
// Each function returns the same output type as its local counterpart in
// `@maple/query-engine/observability`, so commands and renderers are unaware
// of which backend answered. Where v2 cannot express what local mode returns,
// the operation fails loudly (see `unsupportedInRemote`) rather than quietly
// returning a narrower answer — a partially-correct observability answer is
// worse than a refusal, because nothing about the output says it was partial.

import { Effect } from "effect"
import { Schema } from "effect"
import { ServiceName, SpanId, TraceId } from "@maple/domain"
import { clusterLogPatterns } from "@maple/query-engine/observability"
import type {
	InspectTraceOutput,
	LogEntry,
	SearchLogsOutput,
	SearchTracesOutput,
	ServiceEdge,
	ServiceSummary,
	SpanNode,
	SpanResult,
} from "@maple/query-engine/observability"
import type { Range } from "./time"
import { type MapleV2Client, toV2Window, unsupportedInRemote } from "./v2-client"

/**
 * v2 list endpoints cap `limit` at 100 (LIST_LIMIT_MAX) and paginate by opaque
 * cursor. Local mode has no such ceiling, so a remote list can be shorter than
 * the same command run locally. Requesting the maximum keeps the gap as small
 * as the API allows.
 */
const V2_LIST_MAX = 100

const clampListLimit = (limit: number | undefined): number => Math.min(limit ?? V2_LIST_MAX, V2_LIST_MAX)

/** v2 filters take branded ids; decode rather than cast so a bad value fails here. */
const serviceName = (value: string) => Schema.decodeSync(ServiceName)(value)
const traceId = (value: string) => Schema.decodeSync(TraceId)(value)

export const listServices = (
	client: MapleV2Client,
	p: { range: Range; environment?: string },
): Effect.Effect<ReadonlyArray<ServiceSummary>, unknown> =>
	Effect.map(
		client.services.list({
			query: {
				...toV2Window(p.range),
				limit: V2_LIST_MAX,
				...(p.environment ? { deployment_environment: p.environment } : undefined),
			},
		}),
		(list) =>
			list.data.map(
				(s): ServiceSummary => ({
					name: s.name,
					throughput: s.throughput,
					errorCount: s.error_count,
					errorRate: s.error_rate,
					p50Ms: s.p50_latency_ms,
					p95Ms: s.p95_latency_ms,
					p99Ms: s.p99_latency_ms,
				}),
			),
	)

export const serviceMap = (
	client: MapleV2Client,
	p: { range: Range; service?: string; environment?: string },
): Effect.Effect<ReadonlyArray<ServiceEdge>, unknown> =>
	Effect.map(
		client.serviceMap.retrieve({
			query: {
				...toV2Window(p.range),
				...(p.service ? { service_name: serviceName(p.service) } : undefined),
				...(p.environment ? { deployment_environment: p.environment } : undefined),
			},
		}),
		(map) =>
			map.edges.map(
				(e): ServiceEdge => ({
					sourceService: e.source_service,
					targetService: e.target_service,
					callCount: e.call_count,
					errorCount: e.error_count,
					avgDurationMs: e.avg_duration_ms,
					maxDurationMs: e.max_duration_ms,
				}),
			),
	)

export const searchTraces = (
	client: MapleV2Client,
	p: {
		range: Range
		service?: string
		spanName?: string
		hasError?: boolean
		minDurationMs?: number
		maxDurationMs?: number
		httpMethod?: string
		traceId?: string
		rootOnly?: boolean
		limit?: number
		offset?: number
	},
): Effect.Effect<SearchTracesOutput, unknown> => {
	// Local mode switches to a span-level scan whenever a span name is given
	// without --root-only. v2 search only ever returns root-based summaries.
	if (p.spanName && !p.rootOnly) {
		return unsupportedInRemote(
			"span_search",
			"filtering traces by span name searches individual spans, and /v2/traces/search only returns root spans.",
		)
	}
	if (p.offset !== undefined && p.offset > 0) {
		return unsupportedInRemote(
			"list_traces",
			"/v2/traces/search paginates by opaque cursor and cannot seek to a numeric --offset.",
		)
	}
	const limit = clampListLimit(p.limit)
	return Effect.map(
		client.traces.search({
			payload: {
				...toV2Window(p.range),
				limit,
				filters: {
					span_scope: "root",
					...(p.service ? { service_name: serviceName(p.service) } : undefined),
					...(p.hasError ? { has_error: true } : undefined),
					...(p.minDurationMs != null ? { min_duration_ms: p.minDurationMs } : undefined),
					...(p.maxDurationMs != null ? { max_duration_ms: p.maxDurationMs } : undefined),
					...(p.httpMethod ? { http_method: p.httpMethod } : undefined),
				},
			},
		}),
		(list): SearchTracesOutput => ({
			timeRange: p.range,
			// Every row is a root span, so the span fields describe the root. v2
			// search carries no attribute maps or span id; those are only available
			// per-span via `GET /v2/traces/:id`.
			spans: list.data.map(
				(t): SpanResult => ({
					traceId: t.id,
					spanId: null,
					spanName: t.root_span_name,
					serviceName: t.root_service_name,
					durationMs: t.duration_ms,
					statusCode: t.root_status_code,
					statusMessage: "",
					attributes: {},
					resourceAttributes: {},
					timestamp: t.start_time,
				}),
			),
			pagination: { offset: 0, limit, hasMore: list.has_more },
		}),
	)
}

/** Rebuild the nested span tree v2 flattens into a parent-linked collection. */
const buildSpanTree = (
	spans: ReadonlyArray<{
		id: string
		parent_span_id: string | null
		name: string
		service_name: string
		kind: string
		duration_ms: number
		status_code: string
		status_message: string | null
		attributes: Record<string, string>
		resource_attributes: Record<string, string>
	}>,
): SpanNode[] => {
	const nodes = new Map<string, SpanNode>()
	for (const s of spans) {
		nodes.set(s.id, {
			spanId: Schema.decodeSync(SpanId)(s.id),
			parentSpanId: s.parent_span_id ?? "",
			spanName: s.name,
			serviceName: s.service_name,
			spanKind: s.kind,
			durationMs: s.duration_ms,
			statusCode: s.status_code,
			statusMessage: s.status_message ?? "",
			attributes: s.attributes,
			resourceAttributes: s.resource_attributes,
			children: [],
		})
	}
	const roots: SpanNode[] = []
	for (const s of spans) {
		const node = nodes.get(s.id)
		if (!node) continue
		const parent = s.parent_span_id ? nodes.get(s.parent_span_id) : undefined
		// A span whose parent is absent from the trace (sampled away, or the
		// trace was truncated) is surfaced as a root rather than dropped.
		if (parent) parent.children.push(node)
		else roots.push(node)
	}
	return roots
}

export const inspectTrace = (
	client: MapleV2Client,
	p: { traceId: string },
): Effect.Effect<InspectTraceOutput, unknown> =>
	Effect.gen(function* () {
		const id = traceId(p.traceId)
		const trace = yield* client.traces.retrieve({ params: { trace_id: id } })
		// `maple trace <id>` takes no time flags, and it should not have to: the
		// trace reports its own bounds, which are exactly the window its logs
		// fall in. Deriving the window here keeps the command's shape unchanged.
		const logs = yield* client.logs.search({
			payload: {
				start_time: trace.start_time,
				end_time: trace.end_time,
				limit: V2_LIST_MAX,
				filters: { trace_id: id },
			},
		})
		return {
			traceId: trace.id,
			serviceCount: trace.service_count,
			spanCount: trace.span_count,
			rootDurationMs: trace.duration_ms,
			spans: buildSpanTree(trace.spans),
			logs: logs.data.map((l) => ({
				timestamp: l.timestamp,
				severityText: l.severity_text,
				serviceName: l.service_name,
				body: l.body,
				spanId: l.span_id ?? "",
			})),
		} satisfies InspectTraceOutput
	})

const toLogEntry = (l: {
	timestamp: string
	severity_text: string
	service_name: string
	body: string
	trace_id: string | null
	span_id: string | null
}): LogEntry => ({
	timestamp: l.timestamp,
	severityText: l.severity_text,
	serviceName: l.service_name,
	body: l.body,
	traceId: l.trace_id ?? "",
	spanId: l.span_id ?? "",
})

const logFilters = (p: { service?: string; severity?: string; search?: string; traceId?: string }) => ({
	...(p.service ? { service_name: serviceName(p.service) } : undefined),
	...(p.severity ? { severity: p.severity } : undefined),
	...(p.search ? { body_search: p.search } : undefined),
	...(p.traceId ? { trace_id: traceId(p.traceId) } : undefined),
})

export const searchLogs = (
	client: MapleV2Client,
	p: {
		range: Range
		service?: string
		severity?: string
		search?: string
		traceId?: string
		limit?: number
		offset?: number
	},
): Effect.Effect<SearchLogsOutput, unknown> => {
	if (p.offset !== undefined && p.offset > 0) {
		return unsupportedInRemote(
			"list_logs",
			"/v2/logs/search paginates by opaque cursor and cannot seek to a numeric --offset.",
		)
	}
	const limit = clampListLimit(p.limit)
	return Effect.gen(function* () {
		const filters = logFilters(p)
		const [page, series] = yield* Effect.all(
			[
				client.logs.search({ payload: { ...toV2Window(p.range), limit, filters } }),
				// `total` is the match count for the whole window, not the page, so
				// it needs its own aggregate — the page length would under-report
				// exactly when it matters (a truncated result).
				client.logs.timeseries({
					payload: { ...toV2Window(p.range), aggregation: "count", filters },
				}),
			],
			{ concurrency: 2 },
		)
		const total = series.series.reduce(
			(sum, s) => sum + s.points.reduce((acc, pt) => acc + pt.value, 0),
			0,
		)
		return {
			timeRange: p.range,
			total,
			logs: page.data.map(toLogEntry),
			pagination: { offset: 0, limit, hasMore: page.has_more },
		} satisfies SearchLogsOutput
	})
}

export const mineLogPatterns = (
	client: MapleV2Client,
	p: { range: Range; service?: string; severity?: string; search?: string; limit?: number },
) =>
	Effect.map(
		client.logs.search({
			payload: { ...toV2Window(p.range), limit: V2_LIST_MAX, filters: logFilters(p) },
		}),
		(page) => {
			// Clustering runs over whatever the API returns. v2 caps a page at 100,
			// so remote mode samples far less than local's 10k default — the
			// templates are the same, their counts are drawn from a smaller sample.
			const rows = page.data.map((l) => ({
				body: l.body,
				severityText: l.severity_text,
				serviceName: l.service_name,
			}))
			const { patterns } = clusterLogPatterns(rows, p.limit)
			return {
				timeRange: p.range,
				sampleSize: V2_LIST_MAX,
				totalSampled: rows.length,
				patterns,
			}
		},
	)

export const listMetrics = (
	client: MapleV2Client,
	p: { range: Range; service?: string; search?: string; limit?: number },
) =>
	Effect.map(
		client.metrics.list({
			query: {
				...toV2Window(p.range),
				limit: clampListLimit(p.limit),
				...(p.service ? { service_name: serviceName(p.service) } : undefined),
				...(p.search ? { search: p.search } : undefined),
			},
		}),
		(list) => list.data,
	)

/**
 * Local mode emits every metric per bucket from one pipe; v2 answers one
 * aggregation per request. Issuing them together and merging by timestamp
 * keeps the command's output shape rather than silently narrowing it to a
 * single series.
 *
 * `apdex` is deliberately absent: v2 requires an explicit
 * `apdex_threshold_ms` and the command exposes no threshold flag, so any value
 * chosen here would be invented.
 */
const TRACE_AGGREGATIONS = [
	["count", "count"],
	["avgDurationMs", "avg_duration"],
	["p50DurationMs", "p50_duration"],
	["p95DurationMs", "p95_duration"],
	["p99DurationMs", "p99_duration"],
	["errorRate", "error_rate"],
] as const

type TraceGroupBy = "service" | "span_name" | "status_code" | "http_method"

const traceGroupBy = (groupBy?: string): TraceGroupBy | undefined =>
	groupBy === "service" || groupBy === "span_name" || groupBy === "status_code" || groupBy === "http_method"
		? groupBy
		: undefined

const traceFilters = (p: {
	service?: string
	spanName?: string
	errorsOnly?: boolean
	environment?: string
}) => ({
	...(p.service ? { service_name: serviceName(p.service) } : undefined),
	...(p.spanName ? { span_name: p.spanName } : undefined),
	...(p.errorsOnly ? { has_error: true } : undefined),
	...(p.environment ? { deployment_environment: p.environment } : undefined),
})

export const tracesTimeseries = (
	client: MapleV2Client,
	p: {
		range: Range
		service?: string
		spanName?: string
		groupBy?: string
		errorsOnly?: boolean
		environment?: string
		bucketSeconds?: number
	},
) =>
	Effect.gen(function* () {
		const group = traceGroupBy(p.groupBy)
		const filters = traceFilters(p)
		const results = yield* Effect.all(
			TRACE_AGGREGATIONS.map(([, aggregation]) =>
				client.traces.timeseries({
					payload: {
						...toV2Window(p.range),
						aggregation,
						filters,
						...(group ? { group_by: group } : undefined),
						...(p.bucketSeconds ? { bucket_seconds: p.bucketSeconds } : undefined),
					},
				}),
			),
			{ concurrency: TRACE_AGGREGATIONS.length },
		)

		// Merge the parallel series into one row per (bucket, group), matching the
		// tabular shape `--format table` expects.
		const rows = new Map<string, Record<string, unknown>>()
		results.forEach((result, index) => {
			const field = TRACE_AGGREGATIONS[index]![0]
			for (const series of result.series) {
				for (const point of series.points) {
					const key = `${point.timestamp}\0${series.group ?? ""}`
					const row = rows.get(key) ?? { timestamp: point.timestamp, group: series.group }
					row[field] = point.value
					rows.set(key, row)
				}
			}
		})
		return Array.from(rows.values()).sort((a, b) =>
			String(a.timestamp).localeCompare(String(b.timestamp)),
		)
	})

export const tracesBreakdown = (
	client: MapleV2Client,
	p: {
		range: Range
		service?: string
		spanName?: string
		groupBy?: string
		limit?: number
		errorsOnly?: boolean
		environment?: string
	},
) =>
	Effect.gen(function* () {
		const group = traceGroupBy(p.groupBy ?? "service") ?? "service"
		const filters = traceFilters(p)
		const results = yield* Effect.all(
			TRACE_AGGREGATIONS.map(([, aggregation]) =>
				client.traces.breakdown({
					payload: {
						...toV2Window(p.range),
						aggregation,
						group_by: group,
						filters,
						...(p.limit ? { limit: p.limit } : undefined),
					},
				}),
			),
			{ concurrency: TRACE_AGGREGATIONS.length },
		)

		const rows = new Map<string, Record<string, unknown>>()
		results.forEach((result, index) => {
			const field = TRACE_AGGREGATIONS[index]![0]
			for (const item of result.data) {
				const row = rows.get(item.name) ?? { name: item.name }
				row[field] = item.value
				rows.set(item.name, row)
			}
		})
		return Array.from(rows.values())
	})
