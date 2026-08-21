/**
 * Min/Max/Mean/Last per series — the figures the stats legend prints.
 *
 * Lifted out of `query-builder-legend.tsx` unchanged. It is pure data with no
 * renderer in it, so it outlives the Recharts legend that used to own it.
 *
 * Note it is computed over ALL series, including hidden ones: a hidden series
 * keeps its legend row and its numbers so it can be brought back. See
 * `useSeriesVisibility` for where that ordering matters.
 */
export interface SeriesStats {
	min: number
	max: number
	mean: number
	last: number
}

export interface StatsSeries {
	/** Internal chart key (s1, s2, …). */
	key: string
	label: string
	/** A RESOLVED colour literal — canvas cannot read `var()`. */
	color: string
}

export function computeSeriesStats(
	data: ReadonlyArray<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): Record<string, SeriesStats> {
	const result: Record<string, SeriesStats> = {}

	for (const key of keys) {
		let min = Number.POSITIVE_INFINITY
		let max = Number.NEGATIVE_INFINITY
		let sum = 0
		let count = 0
		let last = 0

		for (const row of data) {
			const value = row[key]
			if (typeof value !== "number" || !Number.isFinite(value)) continue
			if (value < min) min = value
			if (value > max) max = value
			sum += value
			count += 1
			last = value
		}

		result[key] =
			count === 0 ? { min: 0, max: 0, mean: 0, last: 0 } : { min, max, mean: sum / count, last }
	}

	return result
}

export function isAllZeroStats(stats: SeriesStats | undefined): boolean {
	return stats == null || (stats.min === 0 && stats.max === 0)
}

/**
 * Pushes all-zero series to the end of the legend.
 *
 * A stable sort, so series that carry data keep their incoming order — the
 * legend order has to match the paint order or the swatches stop identifying
 * anything.
 */
export function sortZeroSeriesLast<T extends StatsSeries>(
	series: ReadonlyArray<T>,
	stats: Record<string, SeriesStats>,
): T[] {
	return [...series].sort(
		(a, b) => Number(isAllZeroStats(stats[a.key])) - Number(isAllZeroStats(stats[b.key])),
	)
}
