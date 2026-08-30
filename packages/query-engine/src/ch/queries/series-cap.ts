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

import * as CH from "@maple-dev/clickhouse-builder/expr"
// From the root, not `/expr`: takes a `CHQuery`, so the subquery stays typed.
import { inSubquery } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type CHQuery } from "@maple-dev/clickhouse-builder"
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

	const baseTable = table(SERIES_BASE_ALIAS, outputColumns)

	// Top-N group names, ranked by the max of `rankColumn` across all buckets.
	const ranked = from(baseTable)
		.select(() => ({
			groupName: CH.dynamicColumn<string>("groupName", outputColumns.groupName),
			rank: CH.max_(CH.dynamicColumn<number>(rankColumn, outputColumns[rankColumn])),
		}))
		.groupBy("groupName")
		.orderBy(["rank", "desc"])
		.limit(Math.floor(limit))
	// Project down to just `groupName`: an IN subquery must return one column.
	const topGroups = fromQuery(ranked, "ranked").select(($) => ({ groupName: $.groupName }))

	// Typed from `outputColumns`, which is the whole reason the caller passes
	// them: the cap re-selects the inner query's columns by name, and an untyped
	// passthrough would drop every one of their schemas — taking the series-capped
	// shape of a timeseries from "decodes" to "decodes nothing" while the
	// uncapped shape of the same query still decoded.
	const passthrough: Record<string, CH.Expr<unknown>> = {}
	for (const [key, columnType] of Object.entries(outputColumns)) {
		passthrough[key] = CH.dynamicColumn(key, columnType)
	}

	const capped = from(baseTable)
		// The capped query reads only from this CTE, so it inherits the inner
		// query's tenant scope — derived at compile time, not asserted here.
		.withCTE(SERIES_BASE_ALIAS, inner)
		.select(() => passthrough)
		.where(() => [inSubquery(CH.dynamicColumn<string>("groupName"), topGroups)])
		.orderBy(["bucket", "asc"], ["groupName", "asc"])
		.format("JSON")

	return capped as CHQuery<ColumnDefs, Output, Record<string, ColumnDefs>>
}
