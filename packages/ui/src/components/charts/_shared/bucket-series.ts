/**
 * Helpers for keeping high-cardinality charts readable by collapsing the
 * long tail of small series/categories into a single "Other" bucket.
 *
 * Categorical charts (pie) collapse rows; series-based charts (bar) collapse
 * the per-bucket series keys. Line/area intentionally do NOT use these — a
 * timeseries with many lines is often legitimate, and those legends scroll.
 */

/** Label used for the aggregated long-tail bucket. */
export const OTHER_LABEL = "Other"

/** Neutral color for the aggregated "Other" bucket. */
export const OTHER_COLOR = "var(--muted-foreground)"

/** Default cap on distinct categories/series before the rest roll into "Other". */
export const MAX_CATEGORICAL = 12
export const MAX_BAR_SERIES = 12

export interface CategoricalRow {
	name: string
	value: number
	/**
	 * How many source categories this row stands for. Only set on the aggregated
	 * `"Other"` row, so a legend can say *how much* it is hiding ("Other · 39
	 * groups") instead of leaving the reader to assume the chart is everything.
	 */
	collapsedCount?: number
}

/**
 * Keep the top `max - 1` rows by value (descending) and sum the remaining rows
 * into a single `{ name: "Other", value }` row appended at the end. When the
 * input already fits within `max`, it is returned sorted-but-unbucketed. Rows
 * are always sorted by value descending so the largest categories lead.
 */
export function bucketCategorical(
	rows: ReadonlyArray<CategoricalRow>,
	max: number = MAX_CATEGORICAL,
): CategoricalRow[] {
	const sorted = [...rows].sort((a, b) => b.value - a.value)
	if (max <= 1) return sorted
	if (sorted.length <= max) return sorted

	const head = sorted.slice(0, max - 1)
	const tail = sorted.slice(max - 1)
	const otherValue = tail.reduce((sum, r) => sum + r.value, 0)
	return [...head, { name: OTHER_LABEL, value: otherValue, collapsedCount: tail.length }]
}

export interface BucketedTimeseries<Row> {
	rows: Row[]
	/** Series keys to render, in display order (top series first, "Other" last). */
	keys: string[]
}

/**
 * Collapse a timeseries with many series keys down to the top `max - 1` keys
 * (ranked by total magnitude across all rows) plus an `"Other"` key that sums
 * the remaining keys within each row. Non-series fields (e.g. `bucket`) are
 * preserved. When `seriesKeys` already fits within `max`, the rows pass through
 * unchanged and `keys` is returned in its original order.
 *
 * `bucketField` names the per-row x-axis field to carry over verbatim
 * (defaults to `"bucket"`).
 */
export function bucketTimeseries<Row extends Record<string, unknown>>(
	rows: ReadonlyArray<Row>,
	seriesKeys: ReadonlyArray<string>,
	max: number = MAX_BAR_SERIES,
	bucketField: string = "bucket",
): BucketedTimeseries<Row> {
	if (max <= 1 || seriesKeys.length <= max) {
		return { rows: [...rows], keys: [...seriesKeys] }
	}

	// Rank keys by total magnitude across all rows.
	const totals = new Map<string, number>()
	for (const key of seriesKeys) totals.set(key, 0)
	for (const row of rows) {
		for (const key of seriesKeys) {
			const v = row[key]
			if (typeof v === "number" && Number.isFinite(v)) {
				totals.set(key, (totals.get(key) ?? 0) + Math.abs(v))
			}
		}
	}

	const ranked = [...seriesKeys].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
	const topKeys = ranked.slice(0, max - 1)
	const tailKeys = new Set(ranked.slice(max - 1))

	const topSet = new Set(topKeys)
	const newRows = rows.map((row) => {
		const next: Record<string, unknown> = {}
		next[bucketField] = row[bucketField]
		let other = 0
		for (const key of seriesKeys) {
			const v = row[key]
			const num = typeof v === "number" && Number.isFinite(v) ? v : 0
			if (topSet.has(key)) {
				next[key] = row[key]
			} else if (tailKeys.has(key)) {
				other += num
			}
		}
		next[OTHER_LABEL] = other
		return next as Row
	})

	return { rows: newRows, keys: [...topKeys, OTHER_LABEL] }
}
