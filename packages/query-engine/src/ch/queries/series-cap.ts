// Top-N series cap for group-by timeseries queries
//
// High-cardinality group-by time charts can return hundreds of thousands of
// series — only a handful are ever drawn, but every series is still fetched,
// JSON-parsed, and zero-filled into a dense buckets×series matrix client-side,
// OOMing the browser tab. When a per-chart `seriesLimit` is set on a group-by
// query, `finalizeTimeseries` ranks the aggregated rows with window functions
// and restricts the result to the N groups with the largest value across all
// buckets, so the long tail is never fetched.
//
// The cap is opt-in: when `seriesLimit` is unset (or the query has no real
// group-by), the inner query is returned unchanged so existing SQL snapshots
// stay byte-identical.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { fromQuery, type CHQuery } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import { uint64 } from "@maple-dev/clickhouse-builder/types"

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

	// Typed from `outputColumns`, which is the whole reason the caller passes
	// them: the cap re-selects the inner query's columns by name, and an untyped
	// passthrough would drop every one of their schemas — taking the series-capped
	// shape of a timeseries from "decodes" to "decodes nothing" while the
	// uncapped shape of the same query still decoded.
	const passthrough: Record<string, CH.Expr<unknown>> = {}
	for (const [key, columnType] of Object.entries(outputColumns)) {
		passthrough[key] = CH.dynamicColumn(key, columnType)
	}

	const groupName = CH.dynamicColumn<string>("groupName", outputColumns.groupName)
	// A CTE referenced by both a top-groups subquery and the result query repeats
	// the base scan in ClickHouse. Windows rank the already aggregated buckets
	// while reading the tenant-scoped inner query once.
	const peaks = fromQuery(inner.orderBy(), "__series_base").select(() => ({
		...passthrough,
		__series_peak: CH.over(
			CH.max_(CH.dynamicColumn<number>(rankColumn, outputColumns[rankColumn])),
			CH.windowSpec({ partitionBy: [groupName] }),
		),
	}))
	const ranked = fromQuery(peaks, "__series_peaks").select(() => ({
		...passthrough,
		// All buckets of one group have the same rank. The group-name tie break
		// keeps the cap at N groups even when multiple groups share a peak.
		__series_rank: CH.over(
			CH.rawExpr("dense_rank()", uint64),
			CH.windowSpec({
				orderBy: [
					[CH.dynamicColumn<number>("__series_peak"), "desc"],
					[groupName, "asc"],
				],
			}),
		),
	}))
	const capped = fromQuery(ranked, "__series_ranked")
		.select(() => passthrough)
		.where(() => [CH.dynamicColumn<number>("__series_rank", uint64).lte(Math.floor(limit))])
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
		.format("JSON")

	return capped as CHQuery<ColumnDefs, Output, Record<string, ColumnDefs>>
}
