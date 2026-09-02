import { ruleY, text, type ChartValue } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"

import { validateCssColor } from "../../lib/sanitizers"
import type { DomainThreshold } from "./plot-scales"
import { resolvePlotColor } from "./theme"

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

export interface ThresholdRulesOptions {
	/**
	 * Where along the x axis the labels sit — pass the chart's x domain MAXIMUM
	 * (the last bucket's `Date` for a time series).
	 *
	 * A `text` mark positions itself through the x scale like any other mark; it
	 * has no notion of a plot corner, so Recharts' `position: "insideTopRight"`
	 * has to be spelled out as "at the right end of the domain, anchored to its
	 * end, nudged inward". Without an anchor there is no honest place to put the
	 * text, so omitting this omits the labels rather than guessing.
	 */
	labelX?: ChartValue
}

/**
 * Used when a threshold carries no colour, or when one cannot reach the canvas.
 *
 * `--destructive` is what the Recharts predecessor fell back to, and it is the
 * token that follows the theme; the literal is only the value it resolves to
 * when there is no document to read (SSR, tests) or the token is unset.
 */
const DEFAULT_THRESHOLD_TOKEN = "--destructive"
const DEFAULT_THRESHOLD_COLOR = "#ef4444"
const THRESHOLD_STROKE_WIDTH = 1.5
const THRESHOLD_LABEL_FONT_SIZE = 10
/** Keeps the label off the right edge and just above its own rule. */
const THRESHOLD_LABEL_DX = -4
const THRESHOLD_LABEL_DY = -6

/**
 * `validateCssColor` deliberately ALLOWS `var(--token)` and `currentColor` —
 * both are legitimate CSS and safe against injection, which is the question that
 * function answers. Neither reaches a canvas 2D context intact, so each has to
 * be turned into a literal here or the line validates cleanly and then paints
 * nothing.
 *
 * `var(--token)` is RESOLVED rather than discarded. Rejecting it swapped a
 * deliberately configured threshold colour for the default red, which reads as
 * the chart ignoring the setting; `resolvePlotColor` already unwraps exactly the
 * one-property form and leaves `var(--x, #abc)` alone, so anything still
 * carrying `var(` or `currentColor` after resolution genuinely has no literal
 * and falls back.
 */
export function canvasSafeThresholdColor(color: string | undefined): string {
	const fallback = resolvePlotColor(DEFAULT_THRESHOLD_TOKEN, DEFAULT_THRESHOLD_COLOR)
	const validated = validateCssColor(color)
	if (validated == null) return fallback
	const resolved = resolvePlotColor(validated, fallback)
	return /var\(|currentcolor/i.test(resolved) ? fallback : resolved
}

/**
 * Threshold lines, and their labels, as marks.
 *
 * One `ruleY` for all of them, not one per threshold: `stroke` is a
 * `VisualChannel`, so it can vary per datum, and N marks would each carry their
 * own scale resolution for no gain.
 *
 * The dasharray is the plain `"4 4"` the predecessor drew. `roundCapDasharray`
 * does not belong here: only `lineY` hard-codes `lineCap: "round"`
 * (`dist/line.js:126` at 0.16.0), while `ruleY` emits rule nodes with no cap at all
 * (`dist/rule.js`), so compensating for a cap that is not applied just paints
 * 3-on/5-off dashes where 4/4 was asked for.
 *
 * One thing Recharts did for free that does not survive: `ifOverflow=
 * "extendDomain"` has no equivalent. A rule above the data paints OUTSIDE the
 * plot — `clip` defaults to false, so it is not even clipped, it overlaps the
 * axis labels. Pass the same thresholds to `linearYDomain` so the axis makes
 * room for them.
 */
export function thresholdRules(
	thresholds: ReadonlyArray<PlotThreshold>,
	options: ThresholdRulesOptions = {},
) {
	const valid = thresholds.filter((threshold) => Number.isFinite(threshold.value))
	if (valid.length === 0) return []

	const rules = ruleY(valid, {
		y: (threshold: PlotThreshold) => threshold.value,
		stroke: (threshold: PlotThreshold) => canvasSafeThresholdColor(threshold.color),
		// `ruleY` defaults to `strokeOpacity: 0.5`, which on top of a hairline
		// stroke left a threshold too faint to read against a gridline. The
		// predecessor drew it fully opaque.
		strokeOpacity: 1,
		strokeWidth: THRESHOLD_STROKE_WIDTH,
		strokeDasharray: "4 4",
	})

	// The label is part of the threshold, not an extra the caller opts into: a
	// widget that names a threshold "SLO" and then draws an anonymous line has
	// lost the only thing distinguishing it from every other dashed rule.
	const labelX = options.labelX
	const labelled =
		labelX == null ? [] : valid.filter((threshold) => threshold.label != null && threshold.label !== "")
	if (labelX == null || labelled.length === 0) return [rules]

	return [
		rules,
		// `decorative` keeps the label's geometry and its contribution to the
		// scales while stripping interaction ownership. Two things need that: a
		// `text` mark emits interactive POINTS (a `ruleY` emits only focus
		// anchors), so a threshold label would otherwise turn up as a hoverable
		// datum in the shared tooltip, and its datum type would widen the chart's
		// point union from the row type to `row | PlotThreshold`.
		decorative(
			text(labelled, {
				x: () => labelX,
				y: (threshold: PlotThreshold) => threshold.value,
				text: (threshold: PlotThreshold) => threshold.label ?? "",
				fill: (threshold: PlotThreshold) => canvasSafeThresholdColor(threshold.color),
				anchor: "end",
				dx: THRESHOLD_LABEL_DX,
				dy: THRESHOLD_LABEL_DY,
				fontSize: THRESHOLD_LABEL_FONT_SIZE,
			}),
		),
	]
}
