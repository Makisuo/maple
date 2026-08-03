// ---------------------------------------------------------------------------
// Top-N series cap for group-by timeseries queries
//
// High-cardinality group-by time charts can return hundreds of thousands of
// series — only a handful are ever drawn, but every series is still fetched,
// JSON-parsed, and zero-filled into a dense buckets×series matrix client-side,
// OOMing the browser tab. When a per-chart `seriesLimit` is set on a group-by
// query, `finalizeTimeseries` wraps the inner query in a CTE and restricts the
// outer query to the N groups with the largest value (ranked across all
// buckets), so the long tail is never fetched.
//
// The cap is opt-in: when `seriesLimit` is unset (or the query has no real
// group-by), the inner query is returned unchanged so existing SQL snapshots
// stay byte-identical.
// ---------------------------------------------------------------------------

import { compileCH } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, type CHQuery } from "@maple-dev/clickhouse-builder"
import { table } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"

const SERIES_BASE_ALIAS = "__series_base"

function hasRealGroupBy(groupBy: readonly string[] | undefined): boolean {
	return !!groupBy && groupBy.some((key) => key !== "none")
}

export interface FinalizeTimeseriesParams {
	/** Top-N series cap. When unset / < 1, no cap is applied. */
	seriesLimit?: number
	/** The query's group-by dimensions; the cap only applies to real group-bys. */
	groupBy?: readonly string[]
}

/**
 * Formats the inner timeseries query as JSON, capping it to the top-N series
 * when `seriesLimit` is set on a group-by query.
 *
 * @param inner          the inner timeseries query, WITHOUT a trailing `.format()`
 * @param outputColumns  synthetic column defs matching the inner query's output
 *                       (must include `bucket`, `groupName`, and `rankColumn`)
 * @param rankColumn     the output column to rank groups by (descending max)
 */
export function finalizeTimeseries<Output extends Record<string, unknown>>(
	inner: CHQuery<ColumnDefs, Output, Record<string, ColumnDefs>>,
	outputColumns: ColumnDefs,
	rankColumn: string,
	params: FinalizeTimeseriesParams,
): CHQuery<ColumnDefs, Output, Record<string, ColumnDefs>> {
	const limit = params.seriesLimit
	if (limit == null || !Number.isFinite(limit) || limit < 1 || !hasRealGroupBy(params.groupBy)) {
		return inner.format("JSON")
	}

	// Compile the inner query with placeholders intact ({} params, skipFormat) so
	// the outer `CH.compile()` substitutes them once — same pattern as the
	// list-query cutoff and the metrics-rate CTE.
	const innerCompiled = compileCH(inner, {}, { skipFormat: true })
	const innerSql = innerCompiled.sql
	const baseTable = table(SERIES_BASE_ALIAS, outputColumns)

	// Top-N group names, ranked by the max of `rankColumn` across all buckets.
	const ranked = from(baseTable)
		.select(() => ({
			groupName: CH.dynamicColumn<string>("groupName"),
			rank: CH.max_(CH.dynamicColumn<number>(rankColumn)),
		}))
		.groupBy("groupName")
		.orderBy(["rank", "desc"])
		.limit(Math.floor(limit))
	// Project down to just `groupName` so it can drive an `IN (...)` filter (the
	// IN subquery must return a single column). Wrapping the compiled SQL string
	// mirrors the list-query `cutoffSql` pattern.
	const rankedSql = compileCH(ranked, {}, { skipFormat: true }).sql
	const topGroupsSql = `SELECT groupName FROM (${rankedSql})`

	const passthrough: Record<string, CH.Expr<unknown>> = {}
	for (const key of Object.keys(outputColumns)) {
		passthrough[key] = CH.dynamicColumn(key)
	}

	const capped = from(baseTable)
		// The capped query reads only from this CTE, so it inherits the inner
		// query's tenant scope — which the opaque SQL string can't carry.
		.withCTE(SERIES_BASE_ALIAS, innerSql, { tenantScope: innerCompiled.tenantScope })
		.select(() => passthrough)
		.where(() => [CH.inSubquery(CH.dynamicColumn<string>("groupName"), topGroupsSql)])
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
		.format("JSON")

	return capped as unknown as CHQuery<ColumnDefs, Output, Record<string, ColumnDefs>>
}
