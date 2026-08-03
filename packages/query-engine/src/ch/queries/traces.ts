// ---------------------------------------------------------------------------
// Typed Traces Queries
//
// DSL-based query definitions for traces timeseries, breakdown, and list.
// ---------------------------------------------------------------------------

import type { TracesMetric } from "../../query-engine"
import { compileCH, compileFnCall } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromUnion, unionAll, type CHQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import type { Table } from "@maple-dev/clickhouse-builder"
import {
	ServiceOverviewSpans,
	ServiceOverviewHourly,
	TraceDetailSpans,
	TraceListMv,
	Traces,
	TracesAggregatesHourly,
} from "../tables"
import { METRIC_NEEDS } from "../../traces-shared"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import * as T from "@maple-dev/clickhouse-builder/types"
import { finalizeTimeseries } from "./series-cap"
import { edgeCondition, interiorBounds, interiorConditions } from "./rollup-splice"
import {
	apdexExprs,
	buildProjectedMapExpr,
	canUseServiceOverviewMv,
	canUseTracesAggregatesMv,
	inclusionValues,
	serviceOverviewWhereConditions,
	tracesAggregatesWhereConditions,
	tracesBaseWhereConditions,
	type TracesBaseWhereOpts,
	matchOrIn,
} from "./query-helpers"

// ---------------------------------------------------------------------------
// Metric SELECT expressions
//
// COUNT SEMANTICS — read this before touching `count`.
//
// `count` is the **sample-weighted estimate of how many spans actually
// happened**, never the number of rows we happened to store: every row
// contributes its `SampleRate` (a multiplier >= 1.0, DEFAULT 1.0 for unsampled
// spans — see `SAMPLE_RATE_EXPR` in @maple/domain's datasources).
//
// This is forced, not chosen. `traces_aggregates_hourly` — which serves every
// hourly+ trace timeseries — only stores `WeightedCount`; the raw row count is
// not recoverable from it. A "stored rows" definition would therefore be
// unimplementable on the rollup routes, whereas the weighted one is
// implementable everywhere (raw `traces` and `service_overview_spans` both
// carry `SampleRate`). It is also the definition the rest of the product
// already uses for throughput: `resolveThroughput` in the web app prefers
// `estimatedSpanCount` over `count`, and the service map / service overview /
// service operations queries all report `sum(SampleRate)`.
//
// Consequence: the number is sampling-config-independent. Turning head sampling
// on must not make a dashboard's "spans" number drop.
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

	// Per-span weighted sum: each row contributes `SampleRate` (>= 1.0). Matches
	// `sum(WeightedCount)` on `traces_aggregates_hourly`, so both routes answer
	// the same question. See the COUNT SEMANTICS note above.
	const weightedCount = CH.sum($.SampleRate)

	return {
		count: weightedCount,
		// Rows actually observed, unweighted. Not a user-facing metric — it is the
		// statistical-confidence input behind an alert rule's `minimumSampleCount`,
		// which must not be inflated by extrapolation.
		spanCount: CH.count(),
		avgDuration: needs.has("avg_duration") ? CH.avg($.Duration).div(1000000) : CH.lit(0),
		p50Duration: needs.has("quantiles") ? CH.quantile(0.5)($.Duration).div(1000000) : CH.lit(0),
		p95Duration: needs.has("quantiles") ? CH.quantile(0.95)($.Duration).div(1000000) : CH.lit(0),
		p99Duration: needs.has("quantiles") ? CH.quantile(0.99)($.Duration).div(1000000) : CH.lit(0),
		// Weighted on both sides of the ratio, matching
		// `sum(WeightedErrorCount) / sum(WeightedCount)` on the hourly rollup.
		// Leaving the numerator raw while `count` is weighted would make
		// `count * errorRate` disagree with any error count on the same widget.
		errorRate: needs.has("error_rate")
			? CH.if_(
					weightedCount.gt(0),
					CH.sumIf($.SampleRate, $.StatusCode.eq("Error")).div(weightedCount),
					CH.lit(0),
				)
			: CH.lit(0),
		// Apdex intentionally stays on raw `count()` (inside `apdexExprs`): it is a
		// self-consistent ratio of raw satisfied/tolerating/total, and the hourly
		// rollup carries no weighted apdex buckets to match against anyway.
		...apdex,
		// Retained as a distinct output column because `@maple/domain`'s series
		// keys and the web app's `resolveThroughput` still read it; it is now by
		// construction equal to `count` whenever it is emitted.
		estimatedSpanCount: needsSampling ? weightedCount : CH.lit(0),
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
	/** Sample-weighted estimate of spans that happened. See COUNT SEMANTICS. */
	readonly count: number
	/** Raw rows observed. Confidence input for alerting, not a display metric. */
	readonly spanCount: number
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
	spanCount: T.float64,
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

/**
 * Whether a timeseries request can be served by the one-year service-overview
 * rollup (raw partial edge hours + `service_overview_hourly` interior) instead
 * of scanning `traces`.
 *
 * Exported because it names a distinct SQL *route*: the SQL it selects is
 * structurally unlike every other branch of `tracesTimeseriesQuery`, so the
 * catalog sweep in `sql-catalog.ts` asserts a fixture exercises it both ways.
 * A route with no fixture is a route no test has ever executed — which is
 * exactly how a `NO_COMMON_TYPE` shipped to prod here.
 */
export function canUseAnnualServiceOverview(opts: TracesTimeseriesOpts): boolean {
	return (
		opts.allMetrics === true &&
		(opts.apdexThresholdMs ?? 500) === 500 &&
		opts.rootOnly === true &&
		(opts.bucketSeconds ?? 0) >= 3600 &&
		(opts.groupBy == null || opts.groupBy.length === 0) &&
		opts.spanName == null &&
		opts.statusCode == null &&
		!opts.errorsOnly &&
		opts.minDurationMs == null &&
		opts.maxDurationMs == null &&
		!opts.excludedSpanNames?.length &&
		!opts.attributeFilters?.length &&
		!opts.resourceAttributeFilters?.length &&
		!Object.values(opts.matchModes ?? {}).includes("contains")
	)
}

export function tracesTimeseriesQuery(
	opts: TracesTimeseriesOpts,
): CHQuery<ColumnDefs, TracesTimeseriesOutput, {}> {
	const apdexThresholdMs = opts.apdexThresholdMs ?? 500

	if (canUseAnnualServiceOverview(opts)) {
		const rawEdges = from(ServiceOverviewSpans)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				bCount: CH.count(),
				bEstimatedSpanCount: CH.sum($.SampleRate),
				bErrorCount: CH.countIf($.StatusCode.eq("Error")),
				bDurationSum: CH.sum(CH.rawExpr<number>("toFloat64(Duration)")),
				bDurationQuantiles: CH.rawExpr<string>("quantilesTDigestState(0.5, 0.95, 0.99)(Duration)"),
				bSatisfiedCount: CH.countIf($.StatusCode.neq("Error").and($.Duration.lt(500_000_000))),
				bToleratingCount: CH.countIf(
					$.StatusCode.neq("Error")
						.and($.Duration.gte(500_000_000))
						.and($.Duration.lt(2_000_000_000)),
				),
			}))
			.where(($) => [
				...serviceOverviewWhereConditions($, opts),
				edgeCondition("Timestamp"),
			])
			.groupBy("bucket")

		const hourlyInterior = from(ServiceOverviewHourly)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				bCount: CH.sum($.SpanCount),
				bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
				bErrorCount: CH.sum($.ErrorCount),
				bDurationSum: CH.sum($.DurationSum),
				bDurationQuantiles: CH.rawExpr<string>(
					"quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)",
				),
				bSatisfiedCount: CH.sum($.ApdexSatisfiedCount),
				bToleratingCount: CH.sum($.ApdexToleratingCount),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				...interiorConditions($.Hour),
				opts.serviceName ? $.ServiceName.eq(opts.serviceName) : undefined,
				opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
				opts.namespaces?.length ? CH.inList($.ServiceNamespace, opts.namespaces) : undefined,
				opts.commitShas?.length ? CH.inList($.CommitSha, opts.commitShas) : undefined,
				opts.excludedServiceNames?.length
					? CH.notInList($.ServiceName, opts.excludedServiceNames)
					: undefined,
				opts.excludedEnvironments?.length
					? CH.notInList($.DeploymentEnv, opts.excludedEnvironments)
					: undefined,
				opts.excludedNamespaces?.length
					? CH.notInList($.ServiceNamespace, opts.excludedNamespaces)
					: undefined,
			])
			.groupBy("bucket")

		const annual = fromUnion(unionAll(rawEdges, hourlyInterior), "service_metric_windows")
			.select(($) => {
				// `rawTotal` is the stored-row count; it stays the apdex denominator
				// because the satisfied/tolerating numerators are raw counts too.
				const rawTotal = CH.sum($.bCount)
				// `service_overview_hourly.EstimatedSpanCount` post-dates the table, so
				// buckets written before it carry 0 — fall back to the raw count rather
				// than reporting a hole. Mirrors `resolveThroughput` in the web app.
				// The `toFloat64` is load-bearing: `if()` needs a supertype for both
				// arms, and ClickHouse refuses Float64/UInt64 ("no floating point type
				// that can exactly represent all required integers") — the whole query
				// 500s without it.
				const weightedTotal = CH.rawExpr<number>(
					"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount)))",
				)
				const satisfied = CH.sum($.bSatisfiedCount)
				const tolerating = CH.sum($.bToleratingCount)
				const quantiles = "quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)"
				return {
					bucket: $.bucket,
					groupName: CH.lit("all"),
					count: weightedTotal,
					spanCount: rawTotal,
					avgDuration: CH.rawExpr<number>(
						"if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0)",
					),
					p50Duration: CH.rawExpr<number>(`arrayElement(${quantiles}, 1) / 1000000`),
					p95Duration: CH.rawExpr<number>(`arrayElement(${quantiles}, 2) / 1000000`),
					p99Duration: CH.rawExpr<number>(`arrayElement(${quantiles}, 3) / 1000000`),
					// Raw ratio: `service_overview_hourly` stores no weighted error count.
					// Unbiased as long as errored and non-errored spans share a sampling
					// rate, which head sampling (trace-level) guarantees.
					errorRate: CH.rawExpr<number>("if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0)"),
					satisfiedCount: satisfied,
					toleratingCount: tolerating,
					apdexScore: CH.if_(
						rawTotal.gt(0),
						CH.round_(satisfied.div(rawTotal).add(tolerating.mul(0.5).div(rawTotal)), 4),
						CH.lit(0),
					),
					estimatedSpanCount: weightedTotal,
				}
			})
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"], ["groupName", "asc"])
		return finalizeTimeseries(annual, TRACES_TS_COLUMNS, "count", opts) as unknown as CHQuery<
			ColumnDefs,
			TracesTimeseriesOutput,
			{}
		>
	}

	if (
		!opts.allMetrics &&
		opts.metric !== "apdex" &&
		canUseTracesAggregatesMv(opts, opts.groupBy, opts.bucketSeconds)
	) {
		const needs = new Set(METRIC_NEEDS[opts.metric])
		const wantsQuantiles = needs.has("quantiles")

		// The MV is keyed on whole hours, but dashboard ranges are relative
		// ("now - 24h") and practically never land on an hour boundary. Reading it
		// with `Hour BETWEEN startTime AND endTime` drops the partial head hour
		// entirely and takes the trailing hour whole, so an hourly chart silently
		// under-reported a row-level breakdown of the identical window by up to an
		// hour of traffic. Instead: raw `traces` covers the two partial edge hours,
		// the MV covers the whole-hour interior, and the two tile the window
		// exactly. Same shape as the annual service-overview branch above.

		// The union's branches must agree on aggregate-state types, so the raw side
		// emits `quantilesTDigestWeightedState(…)(Duration, toUInt32(…))` to match
		// the MV column's `AggregateFunction(quantilesTDigestWeighted(...), UInt64,
		// UInt32)`, and the MV side re-emits state via `-MergeState`. When the
		// metric needs no quantiles both branches emit `''` instead — still the
		// same type on both sides, and no t-digest work.
		const rawQuantileState = wantsQuantiles
			? "quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(greatest(SampleRate, 1.0)))"
			: "''"
		const mvQuantileState = wantsQuantiles
			? "quantilesTDigestWeightedMergeState(0.5, 0.95, 0.99)(DurationQuantiles)"
			: "''"

		const spanNames = inclusionValues(opts.spanName, opts.spanNames)
		const rawEdges = from(Traces)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
				groupName: buildGroupNameExpr($, opts.groupBy, undefined),
				bWeightedCount: CH.sum($.SampleRate),
				// `toFloat64` is load-bearing: the MV side of this column is
				// `sum(WeightedCount)` (Float64), and ClickHouse refuses a UNION of
				// UInt64 with Float64 outright ("there is no supertype ... because
				// some of them are integers and some are floating point").
				bSpanCount: CH.rawExpr<number>("toFloat64(count())"),
				bWeightedDurationSum: CH.sum(CH.rawExpr<number>("toFloat64(Duration) * SampleRate")),
				bWeightedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
				bDurationQuantiles: CH.rawExpr<string>(rawQuantileState),
			}))
			.where(($) => [
				// Span-name matching is narrowed to the MV's spelling: the raw table
				// also matches the *display* name ("GET /api/users"), which
				// `traces_aggregates_hourly` cannot store. Leaving that OR in would
				// make the edge hours select rows the interior hours could not,
				// which is the same class of bug this union exists to close.
				...tracesBaseWhereConditions($, { ...opts, spanName: undefined, spanNames: undefined }),
				CH.when(spanNames, (v: readonly string[]) =>
					matchOrIn($.SpanName, v, opts.matchModes?.spanName === "contains"),
				),
				edgeCondition("Timestamp"),
			])
			.groupBy("bucket", "groupName")

		const hourlyInterior = from(TracesAggregatesHourly)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				groupName: buildAggregatesGroupNameExpr($, opts.groupBy),
				bWeightedCount: CH.sum($.WeightedCount),
				// The MV stores no raw row count, so the weighted value stands in for
				// it on interior hours. An hourly alert rule routed here therefore
				// evaluates `minimumSampleCount` against a partly-estimated sample
				// count; sub-hour rules stay on row-level tables and get the true one.
				bSpanCount: CH.sum($.WeightedCount),
				bWeightedDurationSum: CH.sum($.WeightedDurationSum),
				bWeightedErrorCount: CH.sum($.WeightedErrorCount),
				bDurationQuantiles: CH.rawExpr<string>(mvQuantileState),
			}))
			.where(($) => tracesAggregatesWhereConditions($, opts, interiorBounds()))
			.groupBy("bucket", "groupName")

		const weightedCount = CH.rawExpr<number>("sum(bWeightedCount)")
		const weightedQuantiles = "quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(bDurationQuantiles)"
		const aggregates = fromUnion(unionAll(rawEdges, hourlyInterior), "traces_metric_windows")
			.select(($) => ({
				bucket: $.bucket,
				groupName: $.groupName,
				count: weightedCount,
				spanCount: CH.sum($.bSpanCount),
				avgDuration: needs.has("avg_duration")
					? CH.rawExpr<number>(
							"if(sum(bWeightedCount) > 0, sum(bWeightedDurationSum) / sum(bWeightedCount) / 1000000, 0)",
						)
					: CH.lit(0),
				p50Duration: wantsQuantiles
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 1) / 1000000`)
					: CH.lit(0),
				p95Duration: wantsQuantiles
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 2) / 1000000`)
					: CH.lit(0),
				p99Duration: wantsQuantiles
					? CH.rawExpr<number>(`arrayElement(${weightedQuantiles}, 3) / 1000000`)
					: CH.lit(0),
				errorRate: needs.has("error_rate")
					? CH.rawExpr<number>(
							"if(sum(bWeightedCount) > 0, sum(bWeightedErrorCount) / sum(bWeightedCount), 0)",
						)
					: CH.lit(0),
				satisfiedCount: CH.lit(0),
				toleratingCount: CH.lit(0),
				apdexScore: CH.lit(0),
				estimatedSpanCount: opts.needsSampling ? weightedCount : CH.lit(0),
			}))
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
	/** Sample-weighted estimate of spans that happened. See COUNT SEMANTICS. */
	readonly count: number
	readonly spanCount: number
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

// ---------------------------------------------------------------------------
// Trace list query (one row per TraceId, for trace list UIs)
// ---------------------------------------------------------------------------

export interface TraceListOpts extends TracesQueryOpts {
	limit?: number
	offset?: number
	/**
	 * Keyset pagination cursor — the previous page's last row (`startTime`,
	 * `traceId`). Composite because root timestamps are not unique: a bare
	 * `Timestamp < cursor` silently drops every trace sharing the boundary
	 * timestamp. Strictly preferred over `offset` for deep pagination.
	 */
	cursor?: { timestamp: string; traceId: string }
}

export interface TraceListOutput {
	readonly traceId: string
	/** Root span timestamp — the keyset cursor field, paired with `traceId`. */
	readonly startTime: string
	/** When the last span finished, so `endTime - startTime` is the duration below. */
	readonly endTime: string
	/** Wall-clock extent of the whole trace, not the root span's own duration. */
	readonly durationMicros: number
	/** Every span in the trace, not just the ones matching the filters. */
	readonly spanCount: number
	/** Root service first, remaining participants sorted. */
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly rootSpanKind: string
	readonly rootSpanStatusCode: string
	readonly rootHttpMethod: string
	readonly rootHttpRoute: string
	readonly rootHttpStatusCode: string
	/** Projected HTTP attribute map (JSON string) for the root span — see `ROOT_SPAN_ATTR_KEYS`. */
	readonly rootSpanAttributes: string
	readonly hasError: number
}

const arraySort = <T>(arr: CH.Expr<ReadonlyArray<T>>): CH.Expr<ReadonlyArray<T>> =>
	compileFnCall<ReadonlyArray<T>>("arraySort", arr)

const arrayPushFront = <T>(arr: CH.Expr<ReadonlyArray<T>>, el: CH.Expr<T>): CH.Expr<ReadonlyArray<T>> =>
	compileFnCall<ReadonlyArray<T>>("arrayPushFront", arr, el)

const arrayDistinct = <T>(arr: CH.Expr<ReadonlyArray<T>>): CH.Expr<ReadonlyArray<T>> =>
	compileFnCall<ReadonlyArray<T>>("arrayDistinct", arr)

const fromUnixTimestamp64Nano = (nanos: CH.Expr<number>): CH.Expr<string> =>
	compileFnCall<string>("fromUnixTimestamp64Nano", nanos)

/**
 * Two-stage **trace**-level list: exactly one row per TraceId, carrying the real
 * span count, every participating service, and the trace's wall-clock duration.
 *
 * Distinct from `tracesRootListQuery`, which lists *entry-point spans*
 * (`SpanKind IN ('Server','Consumer') OR ParentSpanId = ''`). A trace crossing N
 * services has N entry points, so that query emits N rows for it — correct for a
 * span list, wrong for anything whose columns say "Trace" and "Spans".
 *
 * Stage 1 pages over true roots (`ParentSpanId = ''`, one per trace by
 * construction) in `traces`, reading only TraceId + Timestamp under the caller's
 * filters — so filtering, ordering and the cursor stay root-scoped, matching the
 * `trace_list_mv`-backed sidebar facets. Stage 2 aggregates that page's traces in
 * `trace_detail_spans`, whose `(OrgId, TraceId, SpanId)` sort key turns the
 * `limit` trace ids into primary-key seeks; the heavy SpanAttributes lookups are
 * materialized only there, for at most one page of traces.
 *
 * Stage 2 is deliberately not time-bounded: a trace's children can outlive the
 * requested window, and clipping them would undercount `spanCount` at the window
 * edge. The TraceId seek is what keeps it cheap, not partition pruning.
 */
export function traceListQuery(opts: TraceListOpts) {
	const limit = opts.limit ?? 25
	const offset = opts.offset ?? 0
	const cursor = opts.cursor

	let page = from(Traces)
		.select(($) => ({ traceId: $.TraceId, ts: $.Timestamp }))
		.where(($) => [
			...buildWhereConditions($, opts),
			$.ParentSpanId.eq(""),
			cursor
				? $.Timestamp.lt(cursor.timestamp).or(
						$.Timestamp.eq(cursor.timestamp).and($.TraceId.lt(cursor.traceId)),
					)
				: undefined,
		])
		.orderBy(["ts", "desc"], ["traceId", "desc"])
		.limit(limit)
	if (offset > 0) {
		page = page.offset(offset)
	}
	const pageSql = compileCH(page, {}, { skipFormat: true }).sql

	// Lexicographic tuple ordering: true root first, earliest span as the
	// tiebreaker for the (malformed) traces that ship no root at all.
	const rootOrder = CH.rawExpr<unknown>("(if(ParentSpanId = '', 0, 1), Timestamp)")

	return from(TraceDetailSpans)
		.select(($) => {
			const rootServiceName = argMin($.ServiceName, rootOrder)
			const startNanos = CH.toUnixTimestamp64Nano($.Timestamp)
			const endNanos = CH.max_(startNanos.add(CH.toInt64($.Duration)))
			return {
				traceId: $.TraceId,
				startTime: argMin($.Timestamp, rootOrder),
				endTime: fromUnixTimestamp64Nano(endNanos),
				durationMicros: CH.intDiv(endNanos.sub(CH.min_(startNanos)), 1000),
				spanCount: CH.count(),
				services: arrayDistinct(
					arrayPushFront(arraySort(CH.groupUniqArray($.ServiceName)), rootServiceName),
				),
				rootSpanName: argMin($.SpanName, rootOrder),
				rootSpanKind: argMin($.SpanKind, rootOrder),
				rootSpanStatusCode: argMin($.StatusCode, rootOrder),
				rootHttpMethod: argMin($.SpanAttributes.get("http.method"), rootOrder),
				rootHttpRoute: argMin($.SpanAttributes.get("http.route"), rootOrder),
				rootHttpStatusCode: argMin($.SpanAttributes.get("http.status_code"), rootOrder),
				rootSpanAttributes: argMin(
					CH.toJSONString(buildProjectedMapExpr(ROOT_SPAN_ATTR_KEYS, "SpanAttributes")),
					rootOrder,
				),
				// Root-scoped, matching the `errorsOnly` filter stage 1 applies and
				// the sidebar's trace_list_mv error count — not "any span errored".
				hasError: CH.if_(argMin($.StatusCode, rootOrder).eq("Error"), CH.lit(1), CH.lit(0)),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			CH.rawCond(`TraceId IN (SELECT traceId FROM (${pageSql}))`),
		])
		.groupBy("traceId")
		.orderBy(["startTime", "desc"], ["traceId", "desc"])
		.limit(limit)
		.format("JSON")
}
