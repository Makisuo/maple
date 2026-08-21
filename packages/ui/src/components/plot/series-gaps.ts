/**
 * There is no `connectNulls`.
 *
 * `lineY` validates each y with `isFiniteNumber` and starts a NEW keyed segment
 * on failure (`dist/line.js:103-152`), so a null always produces a visible gap
 * and one path per run. Recharts' `connectNulls` has no equivalent option at any
 * level; the only way to bridge a hole is to remove it from the data before the
 * mark sees it.
 *
 * Which behaviour is right is a PRODUCT question, not an implementation detail,
 * and it differs per chart: for a query-builder series a missing bucket is
 * usually a zero reading and bridging is fine, while for a service health chart
 * a gap means "we had no data" and drawing through it invents a measurement.
 * Call this only where the first reading is the intended one, and say so at the
 * call site.
 */
/** What a series accessor can yield — a reading, or the absence of one. */
export type SeriesValue = number | null | undefined

export function dropNullPoints<T>(rows: readonly T[], value: (row: T) => SeriesValue): readonly T[] {
	let hasNull = false
	for (const row of rows) {
		const candidate = value(row)
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
			hasNull = true
			break
		}
	}
	// Identity-stable when there is nothing to drop: the result feeds a mark, and
	// a fresh array every render would rebuild the scene on every commit.
	if (!hasNull) return rows

	return rows.filter((row) => {
		const candidate = value(row)
		return typeof candidate === "number" && Number.isFinite(candidate)
	})
}
