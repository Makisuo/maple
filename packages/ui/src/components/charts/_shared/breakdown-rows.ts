// ---------------------------------------------------------------------------
// Shared normalization for the row-per-category charts (funnel, horizontal bar).
//
// They read `{name, value}` rows from the breakdown endpoint, but a mis-wired
// widget can hand them timeseries rows instead, and a group value can be empty.
// Both cases used to be handled inside the funnel only; the horizontal bar chart
// needs exactly the same treatment, so it lives here rather than being copied.
// ---------------------------------------------------------------------------

export interface BreakdownRow {
	name: string
	/** True when the source row had no usable label. */
	unnamed: boolean
	value: number
}

export function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/** The first numeric column that isn't the category label. */
export function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

/**
 * Normalize source rows into named categories. Guards the mis-wired case where a
 * categorical chart receives timeseries rows (`{bucket, seriesA, seriesB}`)
 * instead of a breakdown (`{name, value}`): rendering one "—" row per time
 * bucket is meaningless, so aggregate each numeric series across buckets into a
 * single row instead (MAP-49).
 */
export function toBreakdownRows(
	source: ReadonlyArray<Record<string, unknown>>,
	valueField: string,
): BreakdownRow[] {
	const first = source[0]
	const isTimeseriesShaped = first != null && "bucket" in first && !("name" in first)
	if (isTimeseriesShaped) {
		const totals = new Map<string, number>()
		for (const row of source) {
			for (const [key, value] of Object.entries(row)) {
				if (key === "bucket" || typeof value !== "number") continue
				totals.set(key, (totals.get(key) ?? 0) + asFiniteNumber(value))
			}
		}
		return Array.from(totals, ([name, value]) => ({ name, unnamed: false, value })).sort(
			(a, b) => b.value - a.value,
		)
	}
	return source.map((row) => {
		const raw = row.name == null ? "" : String(row.name).trim()
		return {
			name: raw === "" ? "(no value)" : raw,
			unnamed: raw === "",
			value: asFiniteNumber(row[valueField]),
		}
	})
}
