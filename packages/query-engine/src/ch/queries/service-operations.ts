// Service Operations
//
// Per-operation (SpanName) breakdown for one service: throughput, error rate,
// and latency quantiles, plus a companion timeseries for per-operation
// sparklines. Backs the "Operations" tab on the service detail page.
//
// Operations are keyed by the *display* span name ("GET /api/users" instead of
// "http.server GET") via `httpDisplaySpanName` — the same rewrite the trace
// list and span-name facets use, so a row click can drill into /traces with a
// `spanNames` filter and `tracesBaseWhereConditions` matches either spelling.
//
// Reads raw `traces` (the service_overview_spans MV has no SpanName column).
// Counts are sampling-weighted via `sum(SampleRate)`; quantiles stay
// unweighted, matching every other raw-Traces query.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { defineCondFn, from, fromUnion, unionAll, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { httpDisplaySpanName } from "../../traces-shared"
import { CHNumber } from "../schema"
import { ServiceOperationsHourly, ServiceOperationsMinutely, Traces } from "../tables"
import { tracesBaseWhereConditions } from "./query-helpers"
import { edgeCondition, hourGrain, interiorConditions, minuteGrain } from "./rollup-splice"
import * as T from "@maple-dev/clickhouse-builder/types"

export interface ServiceOperationsSummaryOpts {
	serviceName: string
	environments?: readonly string[]
	limit?: number
	/**
	 * Restrict to HTTP server endpoints — rows whose normalized name is
	 * `METHOD /route`. Backs the service detail page's API tab; the Operations
	 * tab leaves it unset and keeps internal spans in the ranking.
	 */
	httpOnly?: boolean
}

export interface ServiceOperationsSummaryOutput {
	readonly spanName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
}

/**
 * UInt64 columns (`count`, `countIf`) arrive as JSON strings from BYO
 * ClickHouse; {@link CHNumber} coerces them centrally via `decodeRows`.
 */
export const serviceOperationsSummaryRowSchema = Schema.Struct({
	spanName: Schema.String,
	spanCount: CHNumber,
	estimatedSpanCount: CHNumber,
	errorCount: CHNumber,
	estimatedErrorCount: CHNumber,
	errorRate: CHNumber,
	avgDurationMs: CHNumber,
	p50DurationMs: CHNumber,
	p95DurationMs: CHNumber,
	p99DurationMs: CHNumber,
})

const displaySpanName = ($: ColumnAccessor<typeof Traces.columns>) =>
	httpDisplaySpanName($.SpanName, $.SpanAttributes.get("http.route"), $.SpanAttributes.get("url.path"))

// p50/p95/p99 off states that `service_operations_minutely/_hourly` wrote with
// only `quantilesTDigest(0.5, 0.95)` (migration 0008). ClickHouse takes a WIDER
// parameter list on the merge combinator than the stored state declares — the
// t-digest centroids are the state, the quantile levels are a finalize-time
// parameter — so p99 needed no migration and covers the full 90d/365d history,
// not just buckets sealed after a schema change. Verified on CH 26.2 against a
// real `AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)` column and
// through the cascading `MergeState`, which re-types to the wider signature and
// so unions cleanly with the raw branch's three-level state.
/**
 * The method set is deliberately identical to the one `normalizedSpanNameExpr`
 * rewrites on. Widening it here (TRACE, CONNECT) would match spans the
 * normalizer never produced — a span literally named `TRACE foo` is not an
 * HTTP endpoint — so the read filter and the write-side rewrite move together.
 */
const HTTP_ENDPOINT_NAME_RE = "^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) "

const matchRegex = defineCondFn<[CH.Expr<string>, string]>("match")

/**
 * KNOWN GAP — this matches the NAME, not the span kind, so an outbound HTTP call
 * named `GET` with a `url.path` attribute normalizes to `GET /path` and is
 * listed as an endpoint this service serves. Measured on Maple's own org over
 * 24h: 406 such Client spans against 114,335 Server spans, one of them an
 * outbound Slack call.
 *
 * It is not fixable on the read side. `service_operations_minutely/_hourly` do
 * not retain SpanKind, and adding the predicate to the raw branch alone would
 * give the two tiers different semantics — the splice would count a span in the
 * boundary minutes and not in the interior, which inflates or deflates totals
 * depending only on where the window edge falls. That failure is silent and the
 * SQL looks reasonable while it happens.
 *
 * The fix is a SpanKind (or endpoint-discriminator) column in the rollup's
 * GROUP BY, applied to both tiers at once. Same shape as the `http.route`
 * discriminator the web layer's `unrouted` bucket is guessing at, and worth
 * doing as one migration rather than two.
 */

/** Undefined when `httpOnly` is unset, so the Operations tab's SQL is unchanged. */
const httpEndpointCondition = (name: CH.Expr<string>, httpOnly: boolean | undefined) =>
	httpOnly ? matchRegex(name, HTTP_ENDPOINT_NAME_RE) : undefined

const RAW_DURATION_STATE = "quantilesTDigestState(0.5, 0.95, 0.99)(Duration)"
const ROLLUP_DURATION_STATE = "quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)"

/** The t-digest type both branches above produce — opaque, merged by the outer
 *  level, never decoded as a row. */
const DURATION_STATE = T.aggregateState("quantilesTDigest(0.5, 0.95, 0.99)", "UInt64")

function rollupEnvironmentCondition(
	$: ColumnAccessor<typeof ServiceOperationsMinutely.columns>,
	environments: readonly string[] | undefined,
) {
	return environments?.length ? CH.inList($.DeploymentEnv, environments) : undefined
}

function hourlyEnvironmentCondition(
	$: ColumnAccessor<typeof ServiceOperationsHourly.columns>,
	environments: readonly string[] | undefined,
) {
	return environments?.length ? CH.inList($.DeploymentEnv, environments) : undefined
}

const mergedDurationQuantile = (index: 1 | 2 | 3) =>
	CH.rawExpr(
		`if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), ${index}) / 1000000, 0)`,
		T.float64,
	)

/**
 * Previous all-raw implementation retained as an explicit rollout rollback
 * path until managed and BYO rollup parity/latency have been observed.
 */
export function serviceOperationsSummaryRawQuery(opts: ServiceOperationsSummaryOpts) {
	return from(Traces)
		.select(($) => {
			const weight = CH.sum($.SampleRate)
			const errorWeight = CH.sumIf($.SampleRate, $.StatusCode.eq("Error"))
			return {
				spanName: displaySpanName($),
				spanCount: CH.count(),
				estimatedSpanCount: weight,
				errorCount: CH.countIf($.StatusCode.eq("Error")),
				estimatedErrorCount: errorWeight,
				errorRate: CH.if_(weight.gt(0), errorWeight.div(weight), CH.lit(0)),
				avgDurationMs: CH.avg($.Duration).div(1_000_000),
				p50DurationMs: CH.quantile(0.5)($.Duration).div(1_000_000),
				p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
				p99DurationMs: CH.quantile(0.99)($.Duration).div(1_000_000),
			}
		})
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			httpEndpointCondition(displaySpanName($), opts.httpOnly),
		])
		.groupBy("spanName")
		.orderBy(["estimatedSpanCount", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

export function serviceOperationsSummaryQuery(opts: ServiceOperationsSummaryOpts) {
	const rawEdges = from(Traces)
		.select(($) => ({
			bSpanName: displaySpanName($),
			bSpanCount: CH.count(),
			bEstimatedSpanCount: CH.sum($.SampleRate),
			bErrorCount: CH.countIf($.StatusCode.eq("Error")),
			bEstimatedErrorCount: CH.sumIf($.SampleRate, $.StatusCode.eq("Error")),
			bDurationSum: CH.sum(CH.rawExpr("toFloat64(Duration)", T.float64)),
			bDurationQuantiles: CH.rawExpr(RAW_DURATION_STATE, DURATION_STATE),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			edgeCondition("Timestamp", minuteGrain),
			httpEndpointCondition(displaySpanName($), opts.httpOnly),
		])
		.groupBy("bSpanName")

	const minutelyEdges = from(ServiceOperationsMinutely)
		.select(($) => ({
			bSpanName: $.SpanName,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr(ROLLUP_DURATION_STATE, DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironmentCondition($, opts.environments),
			...interiorConditions($.Minute, minuteGrain),
			edgeCondition("Minute", hourGrain),
			httpEndpointCondition($.SpanName, opts.httpOnly),
		])
		.groupBy("bSpanName")

	const hourlyInterior = from(ServiceOperationsHourly)
		.select(($) => ({
			bSpanName: $.SpanName,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr(ROLLUP_DURATION_STATE, DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			hourlyEnvironmentCondition($, opts.environments),
			...interiorConditions($.Hour, hourGrain),
			httpEndpointCondition($.SpanName, opts.httpOnly),
		])
		.groupBy("bSpanName")

	return fromUnion(unionAll(rawEdges, minutelyEdges, hourlyInterior), "operation_windows")
		.select(($) => {
			const spanCount = CH.sum($.bSpanCount)
			const estimatedSpanCount = CH.sum($.bEstimatedSpanCount)
			const estimatedErrorCount = CH.sum($.bEstimatedErrorCount)
			return {
				spanName: $.bSpanName,
				spanCount,
				estimatedSpanCount,
				errorCount: CH.sum($.bErrorCount),
				estimatedErrorCount,
				errorRate: CH.if_(
					estimatedSpanCount.gt(0),
					estimatedErrorCount.div(estimatedSpanCount),
					CH.lit(0),
				),
				avgDurationMs: CH.if_(
					spanCount.gt(0),
					CH.sum($.bDurationSum).div(spanCount).div(1_000_000),
					CH.lit(0),
				),
				p50DurationMs: mergedDurationQuantile(1),
				p95DurationMs: mergedDurationQuantile(2),
				p99DurationMs: mergedDurationQuantile(3),
			}
		})
		.groupBy("spanName")
		.orderBy(["estimatedSpanCount", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

export interface ServiceOperationsTimeseriesOpts {
	serviceName: string
	spanNames: readonly string[]
	environments?: readonly string[]
	bucketSeconds?: number
}

export interface ServiceOperationsTimeseriesOutput {
	readonly bucket: string
	readonly spanName: string
	readonly count: number
}

export const serviceOperationsTimeseriesRowSchema = Schema.Struct({
	bucket: Schema.String,
	spanName: Schema.String,
	count: CHNumber,
})

/** All-raw sparkline rollback companion to {@link serviceOperationsSummaryRawQuery}. */
export function serviceOperationsTimeseriesRawQuery(opts: ServiceOperationsTimeseriesOpts) {
	return from(Traces)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			spanName: displaySpanName($),
			count: CH.sum($.SampleRate),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			CH.inList(displaySpanName($), opts.spanNames),
		])
		.groupBy("bucket", "spanName")
		.orderBy(["bucket", "asc"])
		.limit(10_000)
		.format("JSON")
}

/**
 * Sampling-weighted per-bucket counts for the operations returned by
 * {@link serviceOperationsSummaryQuery}. `spanNames` carries display names, so
 * complete minutes match directly on the stored normalized name. Only the two
 * raw edge fragments compute the display name at read time.
 */
export function serviceOperationsTimeseriesQuery(opts: ServiceOperationsTimeseriesOpts) {
	const rawEdges = from(Traces)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			spanName: displaySpanName($),
			count: CH.sum($.SampleRate),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			edgeCondition("Timestamp", minuteGrain),
			CH.inList(displaySpanName($), opts.spanNames),
		])
		.groupBy("bucket", "spanName")

	const minutelyInterior = from(ServiceOperationsMinutely)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Minute, param.int("bucketSeconds")),
			spanName: $.SpanName,
			count: CH.sum($.EstimatedSpanCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironmentCondition($, opts.environments),
			...interiorConditions($.Minute, minuteGrain),
			opts.bucketSeconds != null && opts.bucketSeconds >= 3600
				? edgeCondition("Minute", hourGrain)
				: undefined,
			CH.inList($.SpanName, opts.spanNames),
		])
		.groupBy("bucket", "spanName")

	const hourlyInterior = from(ServiceOperationsHourly)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
			spanName: $.SpanName,
			count: CH.sum($.EstimatedSpanCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			hourlyEnvironmentCondition($, opts.environments),
			...interiorConditions($.Hour, hourGrain),
			CH.inList($.SpanName, opts.spanNames),
		])
		.groupBy("bucket", "spanName")

	const combined =
		opts.bucketSeconds != null && opts.bucketSeconds >= 3600
			? unionAll(rawEdges, minutelyInterior, hourlyInterior)
			: unionAll(rawEdges, minutelyInterior)

	return fromUnion(combined, "operation_buckets")
		.select(($) => ({
			bucket: $.bucket,
			spanName: $.spanName,
			count: CH.sum($.count),
		}))
		.groupBy("bucket", "spanName")
		.orderBy(["bucket", "asc"])
		.limit(10_000)
		.format("JSON")
}
