/**
 * Raw-SQL widget rows, reshaped for the renderer.
 *
 * A `raw_sql_chart` data source returns whatever columns the author selected.
 * For the time-series display types the line/area/bar charts want
 * `{ bucket, [series]: number }` — the same wide shape
 * `custom_query_builder_timeseries` produces — so the first DateTime-like column
 * becomes `bucket` and every remaining numeric column a series. Every other
 * display type gets the rows untouched (a table shows them, a stat pairs them
 * with `reduceToValue`, pie/histogram/heatmap pick their own columns).
 *
 * Lived in the browser's `raw-sql-chart` server function; the share API, which
 * runs the same SQL server-side, had no reshaping at all, so a raw-SQL line
 * chart on a shared board was fed a table. Both hosts import this now.
 */

export const TIME_SERIES_DISPLAY_TYPES: ReadonlyArray<"line" | "area" | "bar"> = ["line", "area", "bar"]

export const isTimeSeriesDisplayType = (displayType: unknown): displayType is "line" | "area" | "bar" =>
	typeof displayType === "string" &&
	(TIME_SERIES_DISPLAY_TYPES as ReadonlyArray<string>).includes(displayType)

const ISO_OR_WAREHOUSE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})/

function looksLikeDateTime(value: unknown): boolean {
	if (value instanceof Date) return true
	if (typeof value !== "string") return false
	return ISO_OR_WAREHOUSE_DATETIME_RE.test(value)
}

function pickBucketColumn(columns: ReadonlyArray<string>, firstRow: Record<string, unknown>): string | null {
	// 1. Explicit `bucket` column (matches the rest of the codebase convention).
	if (columns.includes("bucket") && looksLikeDateTime(firstRow.bucket)) {
		return "bucket"
	}
	// 2. First column whose value looks like a datetime.
	for (const col of columns) {
		if (looksLikeDateTime(firstRow[col])) {
			return col
		}
	}
	return null
}

export function toLineChartRows(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, string | number>> {
	if (rows.length === 0) return []
	const columns = Object.keys(rows[0])
	const bucketCol = pickBucketColumn(columns, rows[0])
	if (!bucketCol) {
		// Couldn't infer a time axis — return rows untouched so the user can debug
		// in the table view. The chart renderer will simply render an empty plot.
		return rows as Array<Record<string, string | number>>
	}

	const seriesCols = columns.filter((c) => c !== bucketCol)

	return rows.map((row) => {
		const out: Record<string, string | number> = {
			bucket: String(
				row[bucketCol] instanceof Date ? (row[bucketCol] as Date).toISOString() : row[bucketCol],
			),
		} satisfies Record<string, string | number>
		for (const col of seriesCols) {
			const value = row[col]
			const num = typeof value === "number" ? value : Number(value)
			if (Number.isFinite(num)) {
				out[col] = num
			}
		}
		return out
	})
}

/**
 * Rows as the widget renderer receives them: reshaped for a time-series
 * display type, untouched otherwise. The one call both hosts make.
 */
export function rawSqlRowsForDisplay(
	rows: ReadonlyArray<Record<string, unknown>>,
	displayType: unknown,
): Array<Record<string, unknown>> {
	return isTimeSeriesDisplayType(displayType)
		? toLineChartRows(rows)
		: (rows as Array<Record<string, unknown>>)
}
