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
//  1. **The window decides what is drawn.** The x axis is a time scale (see
//     `makeBucketAxis`), so a marker sits at its own instant — but only inside
//     the plotted window. An event just outside it is dropped, never clamped to
//     an edge, and a band whose end is unknown degrades to a line.
//  2. **Markers are MARKS, not children.** Recharts wanted `ReferenceLine` as a
//     direct child of the chart element; here they are spread into
//     `defineChart({ marks })` like any other mark, and they are `decorative` so
//     they neither take focus nor widen the chart's point type.

import { ruleX, rect, text } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { resolvePlotColor } from "@maple/ui/components/plot"
import { toEpochMs } from "@maple/ui/lib/time-format"

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

export interface PlacedMarker {
	readonly marker: ChartEventMarker
	/** The instant the marker sits on. */
	readonly x: Date
	/** End instant, for banded markers. */
	readonly x2?: Date
}

/**
 * Keep the markers that fall inside the plotted window, at their own instant.
 *
 * The window runs from the first bucket to the END of the last one — buckets
 * are intervals, so an event 45 minutes into the final hourly bucket is still
 * in view. Markers outside it are dropped rather than clamped to an edge: a
 * deploy pinned to the first visible bucket reads as "this deploy caused the
 * thing at the start of the window", which is exactly the wrong conclusion.
 *
 * Bucket order is not assumed; the extent is taken over all of them.
 */
export function placeMarkersInWindow(
	markers: ReadonlyArray<ChartEventMarker>,
	bucketIsos: ReadonlyArray<string>,
): ReadonlyArray<PlacedMarker> {
	if (bucketIsos.length === 0 || markers.length === 0) return []

	const times = bucketIsos
		.map((iso) => toEpochMs(iso))
		.filter((ms) => Number.isFinite(ms))
		.toSorted((a, b) => a - b)
	const first = times[0]
	const last = times[times.length - 1]
	if (first === undefined || last === undefined) return []
	// With a single bucket the width is unknown, so only the instant itself lands.
	const width = times.length > 1 ? times[1]! - first : 0
	const end = last + width

	const inWindow = (t: number) => Number.isFinite(t) && t >= first && t <= end

	const placed: PlacedMarker[] = []
	for (const marker of markers) {
		const at = toEpochMs(marker.at)
		if (!inWindow(at)) continue
		const x = new Date(at)
		if (marker.endsAt === undefined) {
			placed.push({ marker, x })
			continue
		}
		const until = toEpochMs(marker.endsAt)
		// An unresolvable end (still running, or past the window) degrades to a
		// line — better than a band that silently stops early.
		placed.push(inWindow(until) && until > at ? { marker, x, x2: new Date(until) } : { marker, x })
	}
	return placed
}

/**
 * Tone tokens and the literals they fall back to.
 *
 * Resolved rather than passed through: these now reach a canvas 2D context,
 * which takes literal colour strings and silently paints nothing for a `var()`.
 */
const TONE_TOKENS = {
	neutral: ["--muted-foreground", "#71717a"],
	warn: ["--severity-warn", "#f59e0b"],
	crit: ["--severity-error", "#ef4444"],
} satisfies Record<ChartEventTone, readonly [token: string, fallback: string]>

function toneColor(tone: ChartEventTone): string {
	const [token, fallback] = TONE_TOKENS[tone]
	return resolvePlotColor(token, fallback)
}

/**
 * Above this many visible markers the labels stop being readable and the chart
 * turns into a picket fence — the activity feed carries the detail instead.
 */
const MAX_LABELLED_MARKERS = 3

export interface ChartEventMarkerOptions {
	/**
	 * The chart's resolved y domain, `[min, max]`.
	 *
	 * A banded marker is a `rect`, and a rect needs both edges — there is no
	 * "span the plot" channel. Recharts got this free because `ReferenceArea` with
	 * no `y1`/`y2` filled the plot rect, which is a layout concept marks do not
	 * have. Pass the SAME domain the y axis was built with (see `linearYDomain` /
	 * `niceLinearDomain`), or the band will stop short of the axis it is meant to
	 * span.
	 */
	yDomain: readonly [number, number]
}

/**
 * Markers as marks. Spread into the chart definition:
 *
 * ```tsx
 * defineChart({
 *   marks: [dashedGridY(), ...chartEventMarkerMarks(placed, { yDomain }), lineY(…)],
 * })
 * ```
 *
 * Everything here is `decorative`: a marker must never win the pointer (it would
 * fight the tooltip cursor), and a `text` or `rect` mark otherwise emits
 * interactive points that would turn up as hoverable data and widen the chart's
 * point union beyond its row type.
 */
export function chartEventMarkerMarks(
	placed: ReadonlyArray<PlacedMarker>,
	{ yDomain }: ChartEventMarkerOptions,
) {
	if (placed.length === 0) return []
	const labelled = placed.length <= MAX_LABELLED_MARKERS

	const lines = placed.filter((entry) => entry.x2 === undefined)
	const bands = placed.filter((entry) => entry.x2 !== undefined)

	const marks = []

	// One rect mark PER TONE. `RectOptions.fill` is a scalar, not a channel — a
	// single mark over mixed tones would paint every band in whichever tone
	// happened to come first, which is exactly wrong for the case that matters
	// (a warn window overlapping a crit one).
	for (const tone of ["neutral", "warn", "crit"] as const) {
		const ofTone = bands.filter((entry) => entry.marker.tone === tone)
		if (ofTone.length === 0) continue
		marks.push(
			decorative(
				rect(ofTone, {
					x1: (entry: PlacedMarker) => entry.x,
					x2: (entry: PlacedMarker) => entry.x2 ?? entry.x,
					y1: () => yDomain[0],
					y2: () => yDomain[1],
					fill: toneColor(tone),
					fillOpacity: 0.08,
					stroke: "none",
				}),
			),
		)
	}

	if (lines.length > 0) {
		marks.push(
			decorative(
				ruleX(lines, {
					x: (entry: PlacedMarker) => entry.x,
					stroke: (entry: PlacedMarker) => toneColor(entry.marker.tone),
					strokeOpacity: 1,
					strokeWidth: 1,
					strokeDasharray: "3 3",
				}),
			),
		)

		if (labelled) {
			marks.push(
				decorative(
					text(lines, {
						x: (entry: PlacedMarker) => entry.x,
						// Anchored at the top of the domain, which is where Recharts'
						// `position: "top"` put it.
						y: () => yDomain[1],
						text: (entry: PlacedMarker) => entry.marker.label,
						fill: resolvePlotColor("--muted-foreground", "#71717a"),
						anchor: "middle",
						dy: -4,
						fontSize: 9,
					}),
				),
			)
		}
	}

	return marks
}
