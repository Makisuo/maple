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
import { from, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { httpDisplaySpanName } from "../../traces-shared"
import { CHNumber } from "../schema"
import { Traces } from "../tables"
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

export function serviceOperationsSummaryQuery(opts: ServiceOperationsSummaryOpts) {
	return from(Traces)
		.select(($) => {
			const weight = CH.sum($.SampleRate)
			const errorWeight = CH.sumIf($.SampleRate, $.StatusCode.eq("Error"))
			return {
				spanName: displaySpanName($),
				spanCount: CH.count(),
				// Per-span weighted sum: SampleRate is 1.0 for unsampled rows or
				// 1/acceptanceProbability for sampled ones (see serviceOverviewQuery).
				estimatedSpanCount: weight,
				errorCount: CH.countIf($.StatusCode.eq("Error")),
				estimatedErrorCount: errorWeight,
				// 0–1 ratio end-to-end; ×100 only at display.
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

/**
 * Sampling-weighted per-bucket counts for the operations returned by
 * {@link serviceOperationsSummaryQuery}. `spanNames` carries display names, so
 * rows are matched on either the raw or rewritten spelling — mirroring the
 * `spanName` matcher in `tracesBaseWhereConditions`.
 */
export function serviceOperationsTimeseriesQuery(opts: ServiceOperationsTimeseriesOpts) {
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
			CH.inList($.SpanName, opts.spanNames).or(CH.inList(displaySpanName($), opts.spanNames)),
		])
		.groupBy("bucket", "spanName")
		.orderBy(["bucket", "asc"])
		.limit(10_000)
		.format("JSON")
}
