// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromUnion, unionAll, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { httpDisplaySpanName } from "../../traces-shared"
import { CHNumber } from "../schema"
import { ServiceOperationsMinutely, Traces } from "../tables"
import { tracesBaseWhereConditions } from "./query-helpers"

export interface ServiceOperationsSummaryOpts {
	serviceName: string
	environments?: readonly string[]
	limit?: number
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
})

const displaySpanName = ($: ColumnAccessor<typeof Traces.columns>) =>
	httpDisplaySpanName($.SpanName, $.SpanAttributes.get("http.route"), $.SpanAttributes.get("url.path"))

const START_DT = "toDateTime(__PARAM_startTime__)"
const END_DT = "toDateTime(__PARAM_endTime__)"
const START_MINUTE = `toStartOfMinute(${START_DT})`
const END_MINUTE = `toStartOfMinute(${END_DT})`
const FIRST_FULL_MINUTE = `if(${START_DT} = ${START_MINUTE}, ${START_MINUTE}, ${START_MINUTE} + INTERVAL 1 MINUTE)`
const RAW_EDGE_CONDITION = `(Timestamp < ${FIRST_FULL_MINUTE} OR Timestamp >= ${END_MINUTE})`
const RAW_DURATION_STATE = "quantilesTDigestState(0.5, 0.95)(Duration)"
const ROLLUP_DURATION_STATE = "quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles)"

function rollupEnvironmentCondition(
	$: ColumnAccessor<typeof ServiceOperationsMinutely.columns>,
	environments: readonly string[] | undefined,
) {
	return environments?.length ? CH.inList($.DeploymentEnv, environments) : undefined
}

const mergedDurationQuantile = (index: 1 | 2) =>
	CH.rawExpr<number>(
		`if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95)(bDurationQuantiles), ${index}) / 1000000, 0)`,
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
			}
		})
		.where(($) =>
			tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
		)
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
			bDurationSum: CH.sum(CH.rawExpr<number>("toFloat64(Duration)")),
			bDurationQuantiles: CH.rawExpr<string>(RAW_DURATION_STATE),
		}))
		.where(($) => [
			...tracesBaseWhereConditions($, {
				serviceName: opts.serviceName,
				environments: opts.environments,
			}),
			CH.rawCond(RAW_EDGE_CONDITION),
		])
		.groupBy("bSpanName")

	const rollupInterior = from(ServiceOperationsMinutely)
		.select(($) => ({
			bSpanName: $.SpanName,
			bSpanCount: CH.sum($.SpanCount),
			bEstimatedSpanCount: CH.sum($.EstimatedSpanCount),
			bErrorCount: CH.sum($.ErrorCount),
			bEstimatedErrorCount: CH.sum($.EstimatedErrorCount),
			bDurationSum: CH.sum($.DurationSum),
			bDurationQuantiles: CH.rawExpr<string>(ROLLUP_DURATION_STATE),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironmentCondition($, opts.environments),
			$.Minute.gte(CH.rawExpr<string>(FIRST_FULL_MINUTE)),
			$.Minute.lt(CH.rawExpr<string>(END_MINUTE)),
		])
		.groupBy("bSpanName")

	return fromUnion(unionAll(rawEdges, rollupInterior), "operation_minutes")
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
			CH.rawCond(RAW_EDGE_CONDITION),
			CH.inList(displaySpanName($), opts.spanNames),
		])
		.groupBy("bucket", "spanName")

	const rollupInterior = from(ServiceOperationsMinutely)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Minute, param.int("bucketSeconds")),
			spanName: $.SpanName,
			count: CH.sum($.EstimatedSpanCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			rollupEnvironmentCondition($, opts.environments),
			$.Minute.gte(CH.rawExpr<string>(FIRST_FULL_MINUTE)),
			$.Minute.lt(CH.rawExpr<string>(END_MINUTE)),
			CH.inList($.SpanName, opts.spanNames),
		])
		.groupBy("bucket", "spanName")

	return fromUnion(unionAll(rawEdges, rollupInterior), "operation_buckets")
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
