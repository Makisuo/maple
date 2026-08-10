// Top Operations
//
// DSL port of the previously string-interpolated query in
// `observability/top-operations.ts`. Groups spans for one service by SpanName
// and ranks them by the requested metric (count, latency quantiles, error
// rate, or apdex). OrgId-scoped per the Warehouse Query Pattern.

import { Match } from "effect"
import type { TracesMetric } from "@maple/domain/query-engine"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { avg, count, countIf, quantile } from "@maple-dev/clickhouse-builder"
import { if_ } from "@maple-dev/clickhouse-builder"
import { round_ } from "@maple-dev/clickhouse-builder"
import { param } from "@maple-dev/clickhouse-builder"
import { from } from "@maple-dev/clickhouse-builder"
import { Traces } from "../tables"

/**
 * Wrap an expression in parentheses. The DSL's arithmetic combinators
 * (`add`/`mul`/`div`) emit flat infix SQL without grouping, so explicit
 * grouping is required when a sum must bind before a division.
 */
const paren = (expr: CH.Expr<number>): CH.Expr<number> =>
	CH.rawExpr<number>(`(${compile(expr.toFragment())})`)

export type TopOperationsMetric = TracesMetric

export interface TopOperationsOpts {
	readonly metric: TopOperationsMetric
	readonly limit?: number
}

export interface TopOperationsOutput {
	readonly name: string
	readonly value: number
}

const durationMs = (col: CH.Expr<number>): CH.Expr<number> => col.div(1_000_000)

const metricExpr = (
	metric: TopOperationsMetric,
	$: { readonly Duration: CH.Expr<number>; readonly StatusCode: CH.Expr<string> },
): CH.Expr<number> =>
	Match.value(metric).pipe(
		Match.when("count", () => count()),
		Match.when("avg_duration", () => durationMs(avg($.Duration))),
		Match.when("p50_duration", () => durationMs(quantile(0.5)($.Duration))),
		Match.when("p95_duration", () => durationMs(quantile(0.95)($.Duration))),
		Match.when("p99_duration", () => durationMs(quantile(0.99)($.Duration))),
		Match.when("error_rate", () =>
			if_(count().gt(0), countIf($.StatusCode.eq("Error")).div(count()), CH.lit(0)),
		),
		Match.when("apdex", () =>
			if_(
				count().gt(0),
				round_(
					// (satisfied + tolerating * 0.5) / total — the numerator must be
					// grouped so the division binds after the sum.
					paren(
						countIf(durationMs($.Duration).lt(500)).add(
							countIf(durationMs($.Duration).gte(500).and(durationMs($.Duration).lt(2000))).mul(
								0.5,
							),
						),
					).div(count()),
					4,
				),
				CH.lit(0),
			),
		),
		Match.exhaustive,
	)

export function topOperationsQuery(opts: TopOperationsOpts) {
	const limit = opts.limit ?? 20

	return from(Traces)
		.select(($) => ({
			name: $.SpanName,
			value: metricExpr(opts.metric, $),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
		])
		.groupBy("name")
		.orderBy(["value", "desc"])
		.limit(limit)
		.format("JSON")
}
