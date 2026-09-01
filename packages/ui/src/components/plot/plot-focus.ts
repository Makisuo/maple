import { crosshair, dot, whenFocused } from "@tanstack/charts"
import type { ChartValue } from "@tanstack/charts"

import type { PlotChromeColors } from "./theme"

/**
 * The dashed vertical cursor.
 *
 * `crosshair()` is a single mark painted from the chart's existing focus state,
 * so the rule itself costs nothing per datum. The horizontal guide is off
 * because these charts draw no y cursor.
 */
export function focusCrosshair(chromeColors: PlotChromeColors) {
	return crosshair({
		x: {
			stroke: chromeColors.border,
			strokeWidth: 1,
			strokeDasharray: "3 3",
			// The default is 0.35, which over an already-dark `--border` renders as
			// nothing on Maple's background.
			strokeOpacity: 1,
		},
		y: false,
		// No marker here: it paints one colour for the whole chart, and its default
		// fill is the `Canvas` system colour, which the canvas renderer can't
		// resolve. Per-series dots come from `focusDot` instead.
		marker: false,
	})
}

/**
 * The active dot on a series line.
 *
 * Note the asymmetry with the tooltip: the dot layer resolves focus PER MARK, so
 * every series gets a dot at the hovered bucket — even though the tooltip's
 * `points` still carries only one (the open grouped-focus defect). Focus
 * grouping works for painting and not for reading.
 *
 * `whenFocused` emits a circle for every datum and sizes the unfocused ones to
 * zero rather than skipping them — measured at 435 nodes (145 buckets × 3
 * series) to show 3. That cost is **SVG-only**; the canvas renderer paints the
 * same result with no DOM at all, which is one reason canvas is the default.
 */
export function focusDot<TDatum>(
	rows: readonly TDatum[],
	x: (datum: TDatum) => ChartValue,
	// `null` is a real answer for a sparse series — a bucket the source never
	// reported. `dot` skips a null y, so the gap simply has no focus dot rather
	// than one pinned to zero.
	y: (datum: TDatum) => number | null,
	color: string,
	chromeColors: PlotChromeColors,
) {
	return whenFocused(
		dot(rows, {
			x,
			y,
			r: 3.5,
			fill: color,
			// A ring in the page background separates the dot from the line beneath.
			stroke: chromeColors.background,
			strokeWidth: 2,
		}),
	)
}
