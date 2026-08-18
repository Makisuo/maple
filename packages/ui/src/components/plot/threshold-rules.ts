import { ruleY } from "@tanstack/charts"

import { validateCssColor } from "../../lib/sanitizers"
import { roundCapDasharray } from "./plot-paint"
import type { DomainThreshold } from "./plot-scales"

export interface PlotThreshold extends DomainThreshold {
	value: number
	/**
	 * A user-supplied colour string off the persisted widget config.
	 *
	 * Validated rather than trusted: it now reaches a canvas 2D context, where an
	 * unparseable value silently paints nothing instead of throwing.
	 */
	color?: string
	label?: string
}

/** Used when a threshold carries no colour, or one canvas cannot resolve. */
const DEFAULT_THRESHOLD_COLOR = "#ef4444"
const THRESHOLD_STROKE_WIDTH = 1

/**
 * `validateCssColor` deliberately ALLOWS `var(--token)` and `currentColor` —
 * both are legitimate CSS and safe against injection, which is the question that
 * function answers. They are still wrong here: the canvas 2D context resolves
 * neither, so such a threshold would validate cleanly and then paint nothing.
 * The dev-mode assertion in `PlotFrame` would catch it locally; this keeps a
 * production build from losing the line silently.
 */
function canvasSafeColor(color: string | undefined): string {
	const validated = validateCssColor(color)
	if (validated == null) return DEFAULT_THRESHOLD_COLOR
	if (/var\(|currentcolor/i.test(validated)) return DEFAULT_THRESHOLD_COLOR
	return validated
}

/**
 * Threshold lines as a single mark.
 *
 * One mark, not one per threshold: `stroke` is a `VisualChannel`, so it can vary
 * per datum, and N marks would each carry their own scale resolution for no
 * gain. (`strokeDasharray` is a scalar, but every threshold shares a dash.)
 *
 * Two things Recharts did for free that do not survive:
 *
 * - `ifOverflow="extendDomain"` has no equivalent. A rule above the data paints
 *   OUTSIDE the plot — `clip` defaults to false, so it is not even clipped, it
 *   overlaps the axis labels. Pass the same thresholds to `linearYDomain` so the
 *   axis makes room for them.
 * - `<ReferenceLine label>` has no equivalent; a rule takes no text. A label
 *   needs a sibling `text` mark, which is the caller's job because only the
 *   caller knows where there is room for it.
 */
export function thresholdRules(thresholds: ReadonlyArray<PlotThreshold>) {
	const valid = thresholds.filter((threshold) => Number.isFinite(threshold.value))
	if (valid.length === 0) return []

	return [
		ruleY(valid, {
			y: (threshold: PlotThreshold) => threshold.value,
			stroke: (threshold: PlotThreshold) => canvasSafeColor(threshold.color),
			strokeWidth: THRESHOLD_STROKE_WIDTH,
			strokeDasharray: roundCapDasharray(4, 4, THRESHOLD_STROKE_WIDTH),
		}),
	]
}
