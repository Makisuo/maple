/**
 * Point-dot policy for time-series charts — Grafana's "Show points: Auto".
 *
 * A line segment needs two non-zero neighbours to be visible, so an isolated
 * bucket (both neighbours zero/missing) renders as nothing on a line/area chart
 * (MAP-49). Those points always get a dot. Every OTHER point gets one only when
 * the series is sparse enough for dots to be legible — a dot per point on a
 * 700-point line is noise, not information.
 */

/**
 * The spacing unit for the density rule: uPlot's `ptDia` for a 2px stroke
 * (`3 + 2 × lineWidth`), i.e. the point size Grafana draws — not our r=2.5
 * dot, so the rule matches Grafana's feel rather than our smaller marker.
 */
export const POINT_DOT_DIAMETER_PX = 7

/**
 * uPlot's default `points.show`: draw every point only when consecutive
 * points are at least two diameters apart. A 60-point hour on a 700px tile
 * (12px apart) stays clean; the same hour in the 1000px editor preview
 * (17px apart) gets its dots.
 */
export const MIN_PX_PER_POINT_FOR_DOTS = POINT_DOT_DIAMETER_PX * 2

export type PointsMode = "all" | "isolated" | "none"

function valueAt(row: Record<string, unknown> | undefined, key: string): number {
	const value = row?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Per series key, the row indexes whose value is non-zero while both
 * neighbours are zero or missing — the points a line cannot show.
 * Series with no isolated points are absent from the result.
 */
export function isolatedPointIndexes(
	data: ReadonlyArray<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlySet<number>> {
	const result = new Map<string, Set<number>>()
	if (data.length === 0 || keys.length === 0) return result

	for (const key of keys) {
		for (let i = 0; i < data.length; i++) {
			if (valueAt(data[i], key) === 0) continue
			if (valueAt(data[i - 1], key) !== 0 || valueAt(data[i + 1], key) !== 0) continue
			let indexes = result.get(key)
			if (!indexes) {
				indexes = new Set()
				result.set(key, indexes)
			}
			indexes.add(i)
		}
	}
	return result
}

/**
 * Whether every point should carry a dot, given how much horizontal room each
 * one has. `plotWidthPx` of 0 (not yet measured) says "no" — the isolated-point
 * rule still applies, so nothing is lost while the container settles.
 */
export function pointsFit(plotWidthPx: number, pointCount: number): boolean {
	if (pointCount <= 0 || plotWidthPx <= 0) return false
	return plotWidthPx / pointCount >= MIN_PX_PER_POINT_FOR_DOTS
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
