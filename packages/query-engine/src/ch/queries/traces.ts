// ---------------------------------------------------------------------------
// Typed Traces Queries
//
// DSL-based query definitions for traces timeseries, breakdown, and list.
// ---------------------------------------------------------------------------

import type { TracesMetric } from "../../query-engine"
import { compileCH, compileFnCall } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, type CHQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { Table } from "@maple-dev/clickhouse-builder"
import {
	ServiceOverviewSpans,
	TraceDetailSpans,
	TraceListMv,
	Traces,
	TracesAggregatesHourly,
} from "../tables"
import { METRIC_NEEDS } from "../../traces-shared"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import * as T from "@maple-dev/clickhouse-builder/types"
import { finalizeTimeseries } from "./series-cap"
import {
	apdexExprs,
	buildProjectedMapExpr,
	canUseServiceOverviewMv,
	canUseTracesAggregatesMv,
	serviceOverviewWhereConditions,
	tracesAggregatesWhereConditions,
	tracesBaseWhereConditions,
	type TracesBaseWhereOpts,
} from "./query-helpers"

// ---------------------------------------------------------------------------
// Metric SELECT expressions
// ---------------------------------------------------------------------------

/**
 * Minimal column shape the metric SELECT exprs need — satisfied by both
 * `Traces` and `ServiceOverviewSpans` (the MV pre-projects these).
 */
interface MetricCols {
	Duration: CH.Expr<number>
	StatusCode: CH.Expr<string>
	TraceState: CH.Expr<string>
	SampleRate: CH.Expr<number>
}

function metricSelectExprs(
	$: MetricCols,
	metric: TracesMetric,
	apdexThresholdMs: number,
	needsSampling: boolean,
	allMetrics?: boolean,
) {
	const needs = allMetrics
		? new Set<string>(["count", "avg_duration", "quantiles", "error_rate", "apdex"])
		: new Set(METRIC_NEEDS[metric])
	const durationMs = $.Duration.div(1000000)

	const apdex = needs.has("apdex")
		? apdexExprs(durationMs, apdexThresholdMs, $.StatusCode.eq("Error"))
		: {
				satisfiedCount: CH.lit(0),
				toleratingCount: CH.lit(0),
				apdexScore: CH.lit(0),
			}

	return {
		count: CH.count(),
		avgDuration: needs.has("avg_duration") ? CH.avg($.Duration).div(1000000) : CH.lit(0),
		p50Duration: needs.has("quantiles") ? CH.quantile(0.5)($.Duration).div(1000000) : CH.lit(0),
		p95Duration: needs.has("quantiles") ? CH.quantile(0.95)($.Duration).div(1000000) : CH.lit(0),
		p99Duration: needs.has("quantiles") ? CH.quantile(0.99)($.Duration).div(1000000) : CH.lit(0),
		errorRate: needs.has("error_rate")
			? CH.if_(CH.count().gt(0), CH.countIf($.StatusCode.eq("Error")).div(CH.count()), CH.lit(0))
			: CH.lit(0),
		...apdex,
		// Per-span weighted sum: each row contributes `SampleRate` (>= 1.0).
		// Replaces the old `sampledSpanCount * dominantWeight + unsampledSpanCount`
		// approximation, which mis-estimated buckets with mixed sampling rates
		// because `anyIf` picked one arbitrary threshold and applied it to all.
		estimatedSpanCount: needsSampling ? CH.sum($.SampleRate) : CH.lit(0),
	}
}

// ---------------------------------------------------------------------------
// GROUP BY expression builder
// ---------------------------------------------------------------------------

function buildGroupNameExpr(
	$: ColumnAccessor<typeof Traces.columns>,
	groupBy: readonly string[] | undefined,
	groupByAttributeKeys: readonly string[] | undefined,
): CH.Expr<string> {
	if (!groupBy || groupBy.length === 0) {
		return CH.lit("all")
	}

	const parts: CH.Expr<string>[] = []
	for (const g of groupBy) {
		switch (g) {
			case "service":
				parts.push(CH.toString_($.ServiceName))
				break
			case "span_name":
				parts.push(CH.toString_($.SpanName))
				break
			case "status_code":
				parts.push(CH.toString_($.StatusCode))
				break
			case "http_method":
				parts.push(CH.toString_($.SpanAttributes.get("http.method")))
				break
			case "attribute":
				if (groupByAttributeKeys?.length) {
					const keys: CH.Expr<string>[] = groupByAttributeKeys.map((k) =>
						CH.toString_($.SpanAttributes.get(k)),
					)
					// When multiple attribute keys, join them into a single part
					if (keys.length === 1) {
						parts.push(keys[0])
					} else {
						parts.push(CH.arrayStringConcat(keys, " \u00b7 "))
					}
				}
				break
			case "none":
				break
		}
	}

	if (parts.length === 0) {
		return CH.lit("all")
	}

	if (parts.length === 1) {
		return CH.coalesce(CH.nullIf(parts[0], ""), CH.lit("all"))
	}

	// Multi-part: filter empty strings before joining with separator
	const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
	return CH.coalesce(CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""), CH.lit("all"))
}

/**
 * Variant of buildGroupNameExpr for service_overview_spans_mv — only supports
 * dimensions whose source columns exist on the MV (service, status_code).
 * Caller must have already filtered incompatible groupBy keys via
 * `canUseServiceOverviewMv`.
 */
function buildMvGroupNameExpr(
	$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	groupBy: readonly string[] | undefined,
): CH.Expr<string> {
	if (!groupBy || groupBy.length === 0) return CH.lit("all")

	const parts: CH.Expr<string>[] = []
	for (const g of groupBy) {
		switch (g) {
			case "service":
				parts.push(CH.toString_($.ServiceName))
				break
			case "status_code":
				parts.push(CH.toString_($.StatusCode))
				break
			case "none":
				break
		}
	}

	if (parts.length === 0) return CH.lit("all")
	if (parts.length === 1) return CH.coalesce(CH.nullIf(parts[0]!, ""), CH.lit("all"))
	const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
	return CH.coalesce(CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""), CH.lit("all"))
}

function buildAggregatesGroupNameExpr(
	$: ColumnAccessor<typeof TracesAggregatesHourly.columns>,
	groupBy: readonly string[] | undefined,
): CH.Expr<string> {
	if (!groupBy || groupBy.length === 0) return CH.lit("all")

	const parts: CH.Expr<string>[] = []
	for (const g of groupBy) {
		switch (g) {
			case "service":
				parts.push(CH.toString_($.ServiceName))
				break
			case "span_name":
				parts.push(CH.toString_($.SpanName))
				break
			case "status_code":
				parts.push(CH.toString_($.StatusCode))
				break
			case "none":
				break
		}
	}

	if (parts.length === 0) return CH.lit("all")
	if (parts.length === 1) return CH.coalesce(CH.nullIf(parts[0]!, ""), CH.lit("all"))
	const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
	return CH.coalesce(CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""), CH.lit("all"))
}

function buildBreakdownGroupExpr(
	$: ColumnAccessor<typeof Traces.columns>,
	groupBy: string,
	groupByAttributeKey: string | undefined,
): CH.Expr<string> {
	switch (groupBy) {
		case "service":
			return $.ServiceName
		case "span_name":
			return $.SpanName
		case "status_code":
			return $.StatusCode
		case "http_method":
			return $.SpanAttributes.get("http.method")
		case "attribute":
			return groupByAttributeKey ? $.SpanAttributes.get(groupByAttributeKey) : $.ServiceName
		default:
			return $.ServiceName
	}
}

function buildMvBreakdownGroupExpr(
	$: ColumnAccessor<typeof ServiceOverviewSpans.columns>,
	groupBy: string,
): CH.Expr<string> {
	switch (groupBy) {
		case "status_code":
			return $.StatusCode
		case "service":
		case "none":
		default:
			return $.ServiceName
	}
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

function buildWhereConditions(
	$: ColumnAccessor<typeof Traces.columns>,
	opts: TracesQueryOpts,
): Array<CH.Condition | undefined> {
	return tracesBaseWhereConditions($, opts)
}

// ---------------------------------------------------------------------------
// Shared options interface
// ---------------------------------------------------------------------------

interface TracesQueryOpts extends TracesBaseWhereOpts {}

// ---------------------------------------------------------------------------
// Timeseries query
// ---------------------------------------------------------------------------

export interface TracesTimeseriesOpts extends TracesQueryOpts {
	metric: TracesMetric
	needsSampling: boolean
	groupBy?: readonly string[]
	groupByAttributeKeys?: readonly string[]
	bucketSeconds?: number
	apdexThresholdMs?: number
	/** When true, emit all metric columns regardless of the selected metric. Used by custom charts. */
	allMetrics?: boolean
	/**
	 * Opt-in top-N series cap for group-by charts. When set, only the N groups
	 * with the largest total count (across all buckets) are fetched — the long
	 * tail is dropped server-side to avoid OOMing the browser tab.
	 */
	seriesLimit?: number
}

export interface TracesTimeseriesOutput {
	readonly bucket: string
	readonly groupName: string
	readonly count: number
	readonly avgDuration: number
	readonly p50Duration: number
	readonly p95Duration: number
	readonly p99Duration: number
	readonly errorRate: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
	readonly estimatedSpanCount: number
}

// Synthetic column defs matching TracesTimeseriesOutput, used to wrap the inner
// query in a CTE when the top-N series cap is applied. CH types are nominal
// here (the cap helper references columns by name), so numerics use Float64.
const TRACES_TS_COLUMNS: ColumnDefs = {
	bucket: T.string,
	groupName: T.string,
	count: T.float64,
	avgDuration: T.float64,
	p50Duration: T.float64,
	p95Duration: T.float64,
	p99Duration: T.float64,
	errorRate: T.float64,
	satisfiedCount: T.float64,
	toleratingCount: T.float64,
	apdexScore: T.float64,
	estimatedSpanCount: T.float64,
}

export function tracesTimeseriesQuery(
	opts: TracesTimeseriesOpts,
): CHQuery<ColumnDefs, TracesTimeseriesOutput, {}> {
	const apdexThresholdMs = opts.apdexThresholdMs ?? 500

	if (
		!opts.allMetrics &&
		opts.metric !== "apdex" &&
		canUseTracesAggregatesMv(opts, opts.groupBy, opts.bucketSeconds)
	) {
		const needs = new Set(METRIC_NEEDS[opts.metric])
		const weightedCount = CH.rawExpr<number>("sum(WeightedCount)")
		const weightedQuantiles = "quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles)"
		const aggregates = from(TracesAggregatesHourly)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				groupName: buildAggregatesGroupNameExpr($, opts.groupBy),
				count: weightedCount,
				avgDuration: needs.has("avg_duration")
					? CH.rawExpr<number>(
							"if(sum(WeightedCount) > 0, sum(WeightedDurationSum) / sum(WeightedCount) / 1000000, 0)",
						)
					: CH.lit(0),
				p50Duration: needs.has("quantiles")
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 1) / 1000000`)
					: CH.lit(0),
				p95Duration: needs.has("quantiles")
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 2) / 1000000`)
					: CH.lit(0),
				p99Duration: needs.has("quantiles")
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 3) / 1000000`)
					: CH.lit(0),
				errorRate: needs.has("error_rate")
					? CH.rawExpr<number>(
							"if(sum(WeightedCount) > 0, sum(WeightedErrorCount) / sum(WeightedCount), 0)",
						)
					: CH.lit(0),
				satisfiedCount: CH.lit(0),
				toleratingCount: CH.lit(0),
				apdexScore: CH.lit(0),
				estimatedSpanCount: opts.needsSampling ? weightedCount : CH.lit(0),
			}))
			.where(($) => tracesAggregatesWhereConditions($, opts))
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"], ["groupName", "asc"])
		return finalizeTimeseries(aggregates, TRACES_TS_COLUMNS, "count", opts) as unknown as CHQuery<
			ColumnDefs,
			TracesTimeseriesOutput,
			{}
		>
	}

	// Fast path: when no filter or groupBy references span-level columns
	// (span name, attributes, http method), route the query to
	// service_overview_spans_mv. The MV pre-filters at write time to the same
	// span set that tracesBaseWhereConditions applies when rootOnly is set
	// (Server/Consumer OR root), and has Duration/StatusCode/TraceState ready,
	// so the query reads orders of magnitude fewer rows and bytes.
	if (canUseServiceOverviewMv(opts, opts.groupBy)) {
		const mv = from(ServiceOverviewSpans)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				groupName: buildMvGroupNameExpr($, opts.groupBy),
				...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling, opts.allMetrics),
			}))
			.where(($) => serviceOverviewWhereConditions($, opts))
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"], ["groupName", "asc"])
		return finalizeTimeseries(mv, TRACES_TS_COLUMNS, "count", opts) as unknown as CHQuery<
			ColumnDefs,
			TracesTimeseriesOutput,
			{}
		>
	}

	const raw = from(Traces)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			groupName: buildGroupNameExpr($, opts.groupBy, opts.groupByAttributeKeys),
			...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling, opts.allMetrics),
		}))
		.where(($) => buildWhereConditions($, opts))
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
	return finalizeTimeseries(raw, TRACES_TS_COLUMNS, "count", opts) as unknown as CHQuery<
		ColumnDefs,
		TracesTimeseriesOutput,
		{}
	>
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface TracesBreakdownOpts extends TracesQueryOpts {
	metric: TracesMetric
	groupBy: string
	groupByAttributeKey?: string
	limit?: number
	apdexThresholdMs?: number
	/** When true, emit all metric columns regardless of the selected metric. Used by custom charts. */
	allMetrics?: boolean
}

export interface TracesBreakdownOutput {
	readonly name: string
	readonly count: number
	readonly avgDuration: number
	readonly p50Duration: number
	readonly p95Duration: number
	readonly p99Duration: number
	readonly errorRate: number
	readonly satisfiedCount: number
	readonly toleratingCount: number
	readonly apdexScore: number
}

export function tracesBreakdownQuery(opts: TracesBreakdownOpts) {
	const apdexThresholdMs = opts.apdexThresholdMs ?? 500
	const limit = opts.limit ?? 10

	if (canUseServiceOverviewMv(opts, [opts.groupBy])) {
		const mv = from(ServiceOverviewSpans)
			.select(($) => {
				const { estimatedSpanCount: _estimatedSpanCount, ...metrics } = metricSelectExprs(
					$,
					opts.metric,
					apdexThresholdMs,
					false,
					opts.allMetrics,
				)
				return {
					name: buildMvBreakdownGroupExpr($, opts.groupBy),
					...metrics,
				}
			})
			.where(($) => serviceOverviewWhereConditions($, opts))
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)
			.format("JSON")
		return mv as unknown as CHQuery<ColumnDefs, TracesBreakdownOutput, {}>
	}

	const raw = from(Traces)
		.select(($) => {
			const { estimatedSpanCount: _estimatedSpanCount, ...metrics } = metricSelectExprs(
				$,
				opts.metric,
				apdexThresholdMs,
				false,
				opts.allMetrics,
			)
			return {
				name: buildBreakdownGroupExpr($, opts.groupBy, opts.groupByAttributeKey),
				...metrics,
			}
		})
		.where(($) => buildWhereConditions($, opts))
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(limit)
		.format("JSON")
	return raw as unknown as CHQuery<ColumnDefs, TracesBreakdownOutput, {}>
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface TracesListOpts extends TracesQueryOpts {
	limit?: number
	offset?: number
	/**
	 * Keyset pagination cursor. When set, only spans with `Timestamp < cursor`
	 * are returned. Mutually exclusive with `offset` in practice — the DSL applies
	 * both, but callers should pick one. Cursor is strictly preferred for deep
	 * pages: offset still scans all skipped rows.
	 */
	cursor?: string
	columns?: readonly string[]
}

export interface TracesListOutput {
	readonly traceId: string
	readonly timestamp: string
	readonly spanId: string
	readonly serviceName: string
	readonly spanName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly spanKind: string
	readonly hasError: number
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
}

/**
 * Two-stage list query. The `traces` sort key is
 * `(OrgId, ServiceName, SpanName, toDateTime(Timestamp))` — `ServiceName` and
 * `SpanName` sit between `OrgId` and the timestamp, so `ORDER BY Timestamp DESC`
 * is not a sort-key prefix and ClickHouse cannot read-in-order. A single-stage
 * query therefore scans the whole window and materializes the heavy
 * `SpanAttributes` / `ResourceAttributes` Map columns for every matching row
 * *before* `LIMIT` discards all but N, which OOMs on busy orgs.
 *
 * Stage 1 reads only `Timestamp` to find the cutoff (the (limit+offset)-th
 * newest matching timestamp). Stage 2 gates on `Timestamp >= cutoff`, so the
 * heavy columns are materialized only for the small slice of rows at/after the
 * cutoff. The outer `LIMIT` / `OFFSET` trims any ties at the cutoff timestamp.
 */
export function tracesListQuery(opts: TracesListOpts) {
	const limit = opts.limit ?? 25
	const offset = opts.offset ?? 0

	// Parse requested columns to determine which attribute keys are needed
	const requestedSpanAttrKeys: string[] = []
	const requestedResourceAttrKeys: string[] = []
	let needsFullMaps = !opts.columns

	if (opts.columns) {
		for (const col of opts.columns) {
			if (col.startsWith("spanAttributes.")) {
				requestedSpanAttrKeys.push(col.slice("spanAttributes.".length))
			} else if (col.startsWith("resourceAttributes.")) {
				requestedResourceAttrKeys.push(col.slice("resourceAttributes.".length))
			}
		}
	}

	const spanAttrExpr = needsFullMaps
		? undefined // use $.SpanAttributes directly
		: buildProjectedMapExpr(requestedSpanAttrKeys, "SpanAttributes")
	const resourceAttrExpr = needsFullMaps
		? undefined // use $.ResourceAttributes directly
		: buildProjectedMapExpr(requestedResourceAttrKeys, "ResourceAttributes")

	const cursor = opts.cursor

	const baseWhere = ($: ColumnAccessor<typeof Traces.columns>): Array<CH.Condition | undefined> => [
		...buildWhereConditions($, opts),
		CH.when(cursor, (v: string) => $.Timestamp.lt(v)),
	]

	// Stage 1: cheap scan — only `Timestamp` is read. Compiled with placeholders
	// intact ({} params) so the outer `CH.compile()` substitutes them once.
	// Limit is `limit + offset` so the cutoff covers every row the outer query
	// might examine, not just the slice it returns.
	const cutoffInner = from(Traces)
		.select(($) => ({ ts: $.Timestamp }))
		.where(baseWhere)
		.orderBy(["ts", "desc"])
		.limit(limit + offset)
	const cutoffSql = compileCH(cutoffInner, {}, { skipFormat: true }).sql
	const cutoff = CH.rawExpr<string>(`(SELECT min(ts) FROM (${cutoffSql}))`)

	// Stage 2: heavy columns read only for rows at/after the cutoff timestamp.
	let q = from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			timestamp: $.Timestamp,
			spanId: $.SpanId,
			serviceName: $.ServiceName,
			spanName: $.SpanName,
			durationMs: $.Duration.div(1000000),
			statusCode: $.StatusCode,
			spanKind: $.SpanKind,
			hasError: CH.if_($.StatusCode.eq("Error"), CH.lit(1), CH.lit(0)),
			spanAttributes: spanAttrExpr ?? $.SpanAttributes,
			resourceAttributes: resourceAttrExpr ?? $.ResourceAttributes,
		}))
		.where(($) => [...baseWhere($), $.Timestamp.gte(cutoff)])
		.orderBy(["timestamp", "desc"])
		.limit(limit)
		.format("JSON")

	if (offset > 0) {
		q = q.offset(offset)
	}

	return q
}

// ---------------------------------------------------------------------------
// Slow traces query
//
// DSL port of the previously string-interpolated query in
// `observability/find-slow-traces.ts`. Returns the slowest root spans
// (`ParentSpanId = ''`) ordered by Duration DESC at the database, so the
// caller gets the actual slowest traces in the window rather than the most
// recent. OrgId-scoped per the Warehouse Query Pattern.
// ---------------------------------------------------------------------------

export interface SlowTracesOpts {
	service?: string
	environment?: string
	limit?: number
}

export interface SlowTracesOutput {
	readonly traceId: string
	readonly spanName: string
	readonly serviceName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly timestamp: string
}

export function slowTracesQuery(opts: SlowTracesOpts) {
	return from(TraceListMv)
		.select(($) => ({
			traceId: $.TraceId,
			spanName: $.SpanName,
			serviceName: $.ServiceName,
			durationMs: $.Duration.div(1000000),
			statusCode: $.StatusCode,
			timestamp: CH.toString_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.service, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.environment, (v: string) => $.DeploymentEnv.eq(v)),
		])
		.orderBy(["durationMs", "desc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Span-level search query
//
// DSL port of the span-level search in `observability/search-traces.ts`
// (`spanLevelSearch`). Returns the matched span rows (not root summaries) for
// flexible span-level filtering: span name (exact or contains), service,
// error, duration bounds, attribute filters, and trace id. When a trace id is
// present, it reads `trace_detail_spans`, whose sort key starts with
// (OrgId, TraceId); otherwise it uses the raw `traces` search path.
// OrgId-scoped via `tracesBaseWhereConditions`.
// ---------------------------------------------------------------------------

export interface SpanSearchOpts extends TracesQueryOpts {
	traceId?: string
	limit?: number
	offset?: number
}

export interface SpanSearchOutput {
	readonly traceId: string
	readonly spanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
	readonly timestamp: string
}

type SpanSearchColumns = Pick<
	typeof Traces.columns,
	| "OrgId"
	| "Timestamp"
	| "TraceId"
	| "SpanId"
	| "ParentSpanId"
	| "SpanName"
	| "SpanKind"
	| "ServiceName"
	| "Duration"
	| "StatusCode"
	| "StatusMessage"
	| "SpanAttributes"
	| "ResourceAttributes"
>

function spanSearchFrom<Name extends string>(
	source: Table<Name, SpanSearchColumns>,
	opts: SpanSearchOpts,
	limit: number,
	offset: number,
) {
	const q = from(source)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			spanName: $.SpanName,
			serviceName: $.ServiceName,
			durationMs: $.Duration.div(1000000),
			statusCode: $.StatusCode,
			statusMessage: $.StatusMessage,
			spanAttributes: $.SpanAttributes,
			resourceAttributes: $.ResourceAttributes,
			timestamp: CH.toString_($.Timestamp),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, opts),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
		])
		.orderBy(["timestamp", "desc"])
		.limit(limit)
		.format("JSON")

	return offset > 0 ? q.offset(offset) : q
}

export function spanSearchQuery(opts: SpanSearchOpts) {
	const limit = opts.limit ?? 20
	const offset = opts.offset ?? 0

	if (opts.traceId) {
		return spanSearchFrom(TraceDetailSpans, opts, limit, offset)
	}

	return spanSearchFrom(Traces, opts, limit, offset)
}

// ---------------------------------------------------------------------------
// Root trace list query (aggregated root-span-level, for trace list UI)
// ---------------------------------------------------------------------------

export interface TracesRootListOpts extends TracesQueryOpts {
	limit?: number
	offset?: number
	/**
	 * Keyset pagination cursor. When set, only root spans with `Timestamp < cursor`
	 * are returned. Strictly preferred over `offset` for deep pagination.
	 */
	cursor?: string
}

export interface TracesRootListOutput {
	readonly traceId: string
	readonly startTime: string
	readonly endTime: string
	readonly durationMicros: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly rootSpanKind: string
	readonly rootSpanStatusCode: string
	readonly rootHttpMethod: string
	readonly rootHttpRoute: string
	readonly rootHttpStatusCode: string
	/**
	 * Projected HTTP attribute map (JSON string) for the root span. Carries the
	 * URL/host keys `rootHttp*` omits so `getHttpInfo` can render a client
	 * destination (`host/path`) instead of falling back to `http.client GET`.
	 */
	readonly rootSpanAttributes: string
	readonly hasError: number
}

export interface TraceSummariesOpts extends TracesBaseWhereOpts {
	serviceName?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	httpStatusCode?: string
	deploymentEnv?: string
	namespace?: string
	spanScope?: "root"
	httpRoute?: string
	limit?: number
	offset?: number
	cursor?: { timestamp: string; traceId: string }
}

export interface TraceSummaryOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMs: number
	readonly rootSpanName: string
	readonly rootSpanKind: string
	readonly rootServiceName: string
	readonly statusCode: string
	readonly hasError: number
	readonly deploymentEnvironment: string
	readonly serviceNamespace: string
	readonly httpMethod: string
	readonly httpRoute: string
	readonly httpStatusCode: string
}

const argMin = <T>(value: CH.Expr<T>, ordering: CH.Expr<unknown>): CH.Expr<T> =>
	compileFnCall<T>("argMin", value, ordering)

/**
 * Public trace catalog read over the root-span MV, ordered deterministically.
 * Signal filters match any span by default. A tenant/time-filtered `IN`
 * semi-join selects owning TraceIds before the root-summary MV is read, avoiding
 * a broad runtime JOIN while keeping the returned fields explicitly root-scoped.
 */
export function traceSummariesQuery(opts: TraceSummariesOpts) {
	const attributeFilters = [
		...(opts.attributeFilters ?? []),
		...(opts.httpMethod ? [{ key: "http.method", mode: "equals" as const, value: opts.httpMethod }] : []),
		...(opts.httpRoute ? [{ key: "http.route", mode: "equals" as const, value: opts.httpRoute }] : []),
		...(opts.httpStatusCode
			? [{ key: "http.status_code", mode: "equals" as const, value: opts.httpStatusCode }]
			: []),
	]
	const spanFilters: TracesBaseWhereOpts = {
		serviceName: opts.serviceName,
		spanName: opts.spanName,
		statusCode: opts.statusCode,
		rootOnly: opts.spanScope === "root" ? true : undefined,
		errorsOnly: opts.hasError,
		environments: opts.environments ?? (opts.deploymentEnv ? [opts.deploymentEnv] : undefined),
		namespaces: opts.namespaces ?? (opts.namespace ? [opts.namespace] : undefined),
		minDurationMs: opts.minDurationMs,
		maxDurationMs: opts.maxDurationMs,
		attributeFilters,
		resourceAttributeFilters: opts.resourceAttributeFilters,
	}
	const hasSpanFilters = Object.entries(spanFilters).some(([, value]) =>
		Array.isArray(value) ? value.length > 0 : value !== undefined,
	)
	const matchingTraceIds = hasSpanFilters
		? from(Traces)
				.select(($) => ({ traceId: $.TraceId }))
				.where(($) => tracesBaseWhereConditions($, spanFilters))
				.groupBy("traceId")
		: undefined
	const matchingTraceIdsSql = matchingTraceIds
		? compileCH(matchingTraceIds, {}, { skipFormat: true }).sql
		: undefined

	return from(TraceListMv)
		.select(($) => ({
			traceId: $.TraceId,
			startTime: CH.min_($.Timestamp),
			durationMs: argMin($.Duration, $.Timestamp).div(1000000),
			rootSpanName: argMin($.SpanName, $.Timestamp),
			rootSpanKind: argMin($.SpanKind, $.Timestamp),
			rootServiceName: argMin($.ServiceName, $.Timestamp),
			statusCode: argMin($.StatusCode, $.Timestamp),
			hasError: CH.max_($.HasError),
			deploymentEnvironment: argMin($.DeploymentEnv, $.Timestamp),
			serviceNamespace: argMin($.ServiceNamespace, $.Timestamp),
			httpMethod: argMin($.HttpMethod, $.Timestamp),
			httpRoute: argMin($.HttpRoute, $.Timestamp),
			httpStatusCode: argMin($.HttpStatusCode, $.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			matchingTraceIdsSql ? CH.rawCond(`TraceId IN (${matchingTraceIdsSql})`) : undefined,
			opts.cursor
				? $.Timestamp.lt(opts.cursor.timestamp).or(
						$.Timestamp.eq(opts.cursor.timestamp).and($.TraceId.lt(opts.cursor.traceId)),
					)
				: undefined,
		])
		.groupBy("traceId")
		.orderBy(["startTime", "desc"], ["traceId", "desc"])
		.limit(opts.limit ?? 20)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

/**
 * HTTP attribute keys projected into `rootSpanAttributes`. Mirrors the web app's
 * trace-list projection and the hierarchy query's `TREE_SPAN_ATTR_KEYS` so the
 * shared `getHttpInfo` / `HttpSpanLabel` render identically across surfaces.
 */
const ROOT_SPAN_ATTR_KEYS = [
	"http.method",
	"http.request.method",
	"http.route",
	"http.target",
	"http.status_code",
	"http.response.status_code",
	"http.url",
	"url.full",
	"url.path",
	"server.address",
	"net.peer.name",
] as const

/**
 * Two-stage root-trace list query. Same OOM avoidance as `tracesListQuery`:
 * the `traces` sort key is `(OrgId, ServiceName, SpanName, toDateTime(Timestamp))`,
 * so `ORDER BY Timestamp DESC` can't read-in-order. The single-stage form
 * materializes `SpanAttributes['http.method']` / `['http.route']` /
 * `['http.status_code']` Map lookups for every matching span before `LIMIT`
 * discards them.
 *
 * Stage 1 scans only `Timestamp` under the same WHERE (including `rootOnly`)
 * to find the (limit+offset)-th newest cutoff. Stage 2 reads the heavy
 * Map-lookup columns only for rows at/after the cutoff.
 */
export function tracesRootListQuery(opts: TracesRootListOpts) {
	const limit = opts.limit ?? 25
	const offset = opts.offset ?? 0

	const cursor = opts.cursor

	const baseWhere = ($: ColumnAccessor<typeof Traces.columns>): Array<CH.Condition | undefined> => [
		...buildWhereConditions($, { ...opts, rootOnly: true }),
		CH.when(cursor, (v: string) => $.Timestamp.lt(v)),
	]

	// Stage 1: cheap scan — only `Timestamp` is read, sharing the same WHERE
	// (rootOnly included) as the outer heavy query.
	const cutoffInner = from(Traces)
		.select(($) => ({ ts: $.Timestamp }))
		.where(baseWhere)
		.orderBy(["ts", "desc"])
		.limit(limit + offset)
	const cutoffSql = compileCH(cutoffInner, {}, { skipFormat: true }).sql
	const cutoff = CH.rawExpr<string>(`(SELECT min(ts) FROM (${cutoffSql}))`)

	// Stage 2: heavy SpanAttributes lookups read only for rows at/after the cutoff.
	let q = from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			startTime: $.Timestamp,
			endTime: $.Timestamp,
			durationMicros: CH.intDiv($.Duration, 1000),
			spanCount: CH.toUInt64(CH.lit(1)),
			services: CH.arrayOf($.ServiceName),
			rootSpanName: $.SpanName,
			rootSpanKind: $.SpanKind,
			rootSpanStatusCode: $.StatusCode,
			rootHttpMethod: $.SpanAttributes.get("http.method"),
			rootHttpRoute: $.SpanAttributes.get("http.route"),
			rootHttpStatusCode: $.SpanAttributes.get("http.status_code"),
			rootSpanAttributes: CH.toJSONString(buildProjectedMapExpr(ROOT_SPAN_ATTR_KEYS, "SpanAttributes")),
			hasError: CH.if_($.StatusCode.eq("Error"), CH.lit(1), CH.lit(0)),
		}))
		.where(($) => [...baseWhere($), $.Timestamp.gte(cutoff)])
		.orderBy(["startTime", "desc"])
		.limit(limit)
		.format("JSON")

	if (offset > 0) {
		q = q.offset(offset)
	}

	return q
}
