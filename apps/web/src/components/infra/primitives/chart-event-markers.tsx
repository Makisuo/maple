// Discrete events drawn onto a time-series chart.
//
// A utilization chart answers "what happened"; it can't answer "why". A deploy
// marker next to a CPU cliff turns two separate investigations into one glance.
// Nothing shared existed for this — `ReferenceLine` appears in six charts in
// this codebase and every one of them is a horizontal threshold, not an event.
//
// Two things make this non-trivial and are the reason it lives here rather than
// inline in one chart:
//
//  1. **The x-axis is categorical.** These charts plot bucket *labels* produced
//     by `makeBucketLabeler`, not timestamps, and those labels are not unique
//     over a multi-day window ("14:00" appears once per day). A marker therefore
//     has to be snapped by bucket *index* and then read its label back out.
//  2. **Recharts requires ReferenceLine/ReferenceArea to be direct children** of
//     the chart element, so this exports a fragment-returning function to call
//     inside `<LineChart>`, not a wrapper component around it.

import { Fragment } from "react"
import { ReferenceArea, ReferenceLine } from "recharts"

export type ChartEventTone = "neutral" | "warn" | "crit"

export interface ChartEventMarker {
	readonly id: string
	/** ISO timestamp of the event. */
	readonly at: string
	readonly label: string
	readonly tone: ChartEventTone
	/** When present the marker is drawn as a band rather than a line. */
	readonly endsAt?: string
}

export interface SnappedMarker {
	readonly marker: ChartEventMarker
	/** The bucket label the marker sits on. */
	readonly x: string
	/** End label, for banded markers. */
	readonly x2?: string
}

/**
 * Place each marker on the bucket it falls in.
 *
 * Snapping is by index (then the label is read back), because labels repeat
 * across days. Markers outside the window are dropped rather than clamped to an
 * edge: a deploy pinned to the first visible bucket reads as "this deploy caused
 * the thing at the start of the window", which is exactly the wrong conclusion.
 *
 * `bucketIsos` must be ascending, which is what every timeseries builder here
 * already returns.
 */
export function snapMarkersToBuckets(
	markers: ReadonlyArray<ChartEventMarker>,
	bucketIsos: ReadonlyArray<string>,
	labelFor: (iso: string) => string,
): ReadonlyArray<SnappedMarker> {
	if (bucketIsos.length === 0 || markers.length === 0) return []

	const times = bucketIsos.map((iso) => Date.parse(iso))
	const first = times[0]!
	const last = times[times.length - 1]!
	// Buckets are evenly spaced; the width is what makes the last bucket a real
	// interval rather than an instant, so an event inside it still lands.
	const width = times.length > 1 ? times[1]! - first : 0

	/** Index of the bucket containing `t`, or -1 when it falls outside. */
	const indexOf = (t: number): number => {
		if (Number.isNaN(t) || t < first || t > last + width) return -1
		let low = 0
		let high = times.length - 1
		let found = -1
		while (low <= high) {
			const mid = (low + high) >> 1
			if (times[mid]! <= t) {
				found = mid
				low = mid + 1
			} else {
				high = mid - 1
			}
		}
		return found
	}

	const snapped: SnappedMarker[] = []
	for (const marker of markers) {
		const index = indexOf(Date.parse(marker.at))
		if (index === -1) continue
		const x = labelFor(bucketIsos[index]!)
		if (marker.endsAt === undefined) {
			snapped.push({ marker, x })
			continue
		}
		const endIndex = indexOf(Date.parse(marker.endsAt))
		// An unresolvable end (still running, or past the window) degrades to a
		// line — better than a band that silently stops early.
		snapped.push(
			endIndex === -1 || endIndex <= index
				? { marker, x }
				: { marker, x, x2: labelFor(bucketIsos[endIndex]!) },
		)
	}
	return snapped
}

const TONE_STROKE: Record<ChartEventTone, string> = {
	neutral: "var(--muted-foreground)",
	warn: "var(--severity-warn)",
	crit: "var(--severity-error)",
} satisfies Record<ChartEventTone, string>

/**
 * Above this many visible markers the labels stop being readable and the chart
 * turns into a picket fence — the activity feed carries the detail instead.
 */
const MAX_LABELLED_MARKERS = 3

/**
 * Render markers as Recharts children. Call inside the chart element:
 *
 * ```tsx
 * <LineChart data={data}>
 *   <CartesianGrid … />
 *   {renderChartEventMarkers(snapped)}
 *   <Line … />
 * </LineChart>
 * ```
 */
export function renderChartEventMarkers(snapped: ReadonlyArray<SnappedMarker>) {
	if (snapped.length === 0) return null
	const labelled = snapped.length <= MAX_LABELLED_MARKERS

	return snapped.map(({ marker, x, x2 }) => (
		<Fragment key={marker.id}>
			{x2 === undefined ? (
				<ReferenceLine
					x={x}
					stroke={TONE_STROKE[marker.tone]}
					strokeDasharray="3 3"
					strokeWidth={1}
					// Markers must never win the pointer: they'd fight the tooltip cursor.
					style={{ pointerEvents: "none" }}
					label={
						labelled
							? {
									value: marker.label,
									position: "top",
									fontSize: 9,
									fill: "var(--muted-foreground)",
								}
							: undefined
					}
				/>
			) : (
				<ReferenceArea
					x1={x}
					x2={x2}
					fill={TONE_STROKE[marker.tone]}
					fillOpacity={0.08}
					stroke="none"
					style={{ pointerEvents: "none" }}
				/>
			)}
		</Fragment>
	))
}
