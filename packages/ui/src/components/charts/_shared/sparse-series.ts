/**
 * Sparse-series detection for time-series charts.
 *
 * Low-volume data (a handful of non-zero buckets among zero-filled ones)
 * renders as invisible zero-width spikes on line/area charts. When a series
 * is "sparse" — mostly zeros, or containing isolated non-zero points whose
 * neighbors are all zero — charts auto-enable point dots so single-bucket
 * values stay visible (MAP-49).
 */

const SPARSE_NONZERO_FRACTION = 0.3

function valueAt(row: Record<string, unknown> | undefined, key: string): number {
	const value = row?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function isSparseSeries(
	data: ReadonlyArray<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): boolean {
	if (data.length < 3 || keys.length === 0) return false

	let nonZero = 0
	let total = 0
	for (const key of keys) {
		for (let i = 0; i < data.length; i++) {
			const value = valueAt(data[i], key)
			total++
			if (value === 0) continue
			nonZero++
			// An isolated point (both neighbors zero/missing) can never render as
			// a visible line segment — that alone warrants dots.
			const prev = valueAt(data[i - 1], key)
			const next = valueAt(data[i + 1], key)
			if (prev === 0 && next === 0) return true
		}
	}

	if (nonZero === 0) return false
	return nonZero / total < SPARSE_NONZERO_FRACTION
}

/**
 * True when every finite value across the given keys is an integer — used to
 * suppress fractional y-axis ticks (0.5, 1.5) on count-like axes while keeping
 * decimal ticks for rates/ratios.
 */
export function hasOnlyIntegerValues(
	data: ReadonlyArray<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): boolean {
	let sawValue = false
	for (const row of data) {
		for (const key of keys) {
			const value = row[key]
			if (typeof value !== "number" || !Number.isFinite(value)) continue
			if (!Number.isInteger(value)) return false
			sawValue = true
		}
	}
	return sawValue
}
