import { findNearestSeriesKey } from "@maple/ui/components/charts/_shared/nearest-series"
import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { crosshair, dot, whenFocused } from "@tanstack/charts"
import type { ChartLinearGradient, ChartPoint, ChartTooltipAnchor, ChartValue } from "@tanstack/charts"
import type { ReactNode } from "react"

/** How far from a series' plotted point the cursor may sit and still emphasise it. */
const HIGHLIGHT_MAX_DISTANCE_PX = 24

/**
 * `VerticalGradient` (packages/ui) expressed as a TanStack spec gradient.
 * TanStack takes gradients as data on the spec rather than as `<defs>` JSX, so
 * the two libraries express the same fill very differently — this is the
 * closest structural equivalent.
 */
export function verticalGradient(
	id: string,
	color: string,
	startOpacity = 0.8,
	endOpacity = 0.1,
): ChartLinearGradient {
	return {
		id,
		x1: 0,
		y1: 0,
		x2: 0,
		y2: 1,
		stops: [
			{ offset: 0.05, color, opacity: startOpacity },
			{ offset: 0.95, color, opacity: endOpacity },
		],
	}
}

/**
 * The dashed vertical cursor, matching what Recharts draws: `ChartContainer`
 * styles `.recharts-tooltip-cursor` as `stroke-border` with a `3 3` dasharray.
 *
 * `crosshair()` is a single mark painted from the chart's existing focus state,
 * so the rule itself costs nothing per datum. The horizontal guide is off
 * because Recharts draws no y cursor here.
 */
export function focusCrosshair(chromeColors: PlotChromeColors) {
	return crosshair({
		x: {
			stroke: chromeColors.border,
			strokeWidth: 1,
			strokeDasharray: "3 3",
			// The default is 0.35, which over an already-dark `--border` renders as
			// nothing on Maple's background. Recharts' cursor is full strength.
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
 * The active dot on a series line, matching Recharts' `activeDot`.
 *
 * Note the asymmetry with the tooltip: the dot layer resolves focus PER MARK, so
 * all three latency series get a dot at the hovered bucket — even though the
 * tooltip's `points` still carries only one (bug 2). Focus grouping works for
 * painting and not for reading.
 *
 * `whenFocused` still carries bug 3: it emits a circle for every datum and sizes
 * the unfocused ones to zero rather than skipping them — measured at 435 nodes
 * (145 buckets × 3 series) to show 3. That cost is **SVG-only**; the canvas arm
 * paints the same result with no DOM at all, which is the sharpest illustration
 * in this pilot of why the canvas renderer is the interesting one.
 */
export function focusDot<TDatum>(
	rows: readonly TDatum[],
	x: (datum: TDatum) => ChartValue,
	y: (datum: TDatum) => number,
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

/**
 * Chrome colours every chart needs, resolved once per theme.
 *
 * Module scope, not an inline literal: `usePlotColors` memoizes on this object's
 * identity, so a fresh literal per render would re-read computed style on every
 * frame.
 */
export const PLOT_CHROME_TOKENS = {
	border: ["--border", "#3f3f46"],
	background: ["--background", "#0c0a09"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

export type PlotChromeColors = Readonly<Record<keyof typeof PLOT_CHROME_TOKENS, string>>

/** The chrome colours, re-resolved whenever the theme flips. */
export function usePlotChromeColors(): PlotChromeColors {
	return usePlotColors(PLOT_CHROME_TOKENS)
}

/**
 * Captures the pointer position and the resolved y scale on every tooltip
 * update, so the body can emphasise the series nearest the cursor the way
 * Recharts' `resolveHighlightKey` does.
 *
 * It rides on the `anchor` callback because that is the only tooltip hook handed
 * the pointer and the scales — `renderTooltipBody` receives neither, and (bug 2)
 * its single point can't be used to reconstruct where the other series sit. The
 * anchor still returns the pointer, so this also *is* the `anchor: "pointer"`
 * behaviour, not an extra pass.
 */
export interface TooltipFocusProbe {
	pointerY: number | null
	/**
	 * `ResolvedScale.map` declares `(value: unknown)`, but every y channel in
	 * these charts is a number — narrowed here so callers can't hand it an
	 * unparsed value. Assignment stays sound by contravariance.
	 */
	mapY: ((value: number) => number) | null
}

export function createTooltipFocusProbe<TDatum>(): {
	probe: TooltipFocusProbe
	anchor: ChartTooltipAnchor<TDatum, ChartValue, number>
} {
	const probe: TooltipFocusProbe = { pointerY: null, mapY: null }

	const anchor: ChartTooltipAnchor<TDatum, ChartValue, number> = (_points, context) => {
		probe.pointerY = context.pointer?.y ?? null
		probe.mapY = context.scales.y?.map ?? null
		return context.pointer
	}

	return { probe, anchor }
}

export interface TooltipSeriesSpec<TDatum> {
	label: string
	color: string
	dashed?: boolean
	value: (datum: TDatum) => number | null | undefined
	format: (value: number) => string
}

/**
 * The tooltip body, matching `ChartTooltipContent`'s row layout.
 *
 * Rows are read off `points[0].datum` — NOT by iterating `points`.
 *
 * `focus: "group-x"` (and the exported `focusGroupX` strategy, which behaves
 * identically) hands back only the point belonging to the mark under the cursor:
 * every point arrives with `group: null` and `points.length === 1`, even with
 * three marks sharing an x scale. That was open at 0.6.4 and is still open at
 * 0.14.0. TanStack groups by the `z` channel *within* one mark, so Recharts'
 * one-mark-per-series idiom yields no group at all — reading the datum is the
 * workaround that preserves mark-for-mark parity with the Recharts arm.
 */
export function TooltipBody<TDatum>({
	points,
	series,
	heading,
	probe,
}: {
	points: readonly ChartPoint<TDatum, ChartValue, number>[]
	series: readonly TooltipSeriesSpec<TDatum>[]
	heading: (datum: TDatum) => string
	probe?: TooltipFocusProbe
}): ReactNode {
	const first = points[0]
	if (!first) return null
	const datum = first.datum

	// Emphasise the series whose plotted point is nearest the cursor, as
	// ChartTooltipContent does. Single-series charts emphasise nothing — there is
	// no ambiguity to resolve, and bolding the only row is just noise.
	let highlightLabel: string | undefined
	if (probe?.mapY && probe.pointerY != null && series.length > 1) {
		const yByLabel: Record<string, number> = {}
		for (const spec of series) {
			const value = spec.value(datum)
			if (value != null) yByLabel[spec.label] = probe.mapY(value)
		}
		highlightLabel = findNearestSeriesKey(
			yByLabel,
			series.map((spec) => spec.label),
			probe.pointerY,
			HIGHLIGHT_MAX_DISTANCE_PX,
		)
	}

	return (
		<div className="grid min-w-[9rem] items-start gap-1.5">
			<div className="border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight">
				{heading(datum)}
			</div>
			<div className="grid gap-1.5">
				{series.map((spec) => {
					const value = spec.value(datum)
					if (value == null) return null
					return (
						<div
							key={spec.label}
							// Same emphasis as ChartTooltipContent's highlight row.
							className={
								spec.label === highlightLabel
									? "flex w-full items-center gap-2 [&_*]:font-semibold"
									: "flex w-full items-center gap-2"
							}
						>
							<span
								className={
									spec.dashed
										? "size-2.5 shrink-0 rounded-[2px] border border-dashed"
										: "size-2.5 shrink-0 rounded-[2px]"
								}
								style={
									spec.dashed
										? { borderColor: spec.color }
										: { backgroundColor: spec.color }
								}
							/>
							{/*
							 * `justify-between` + `tabular-nums`, as in ChartTooltipContent:
							 * values right-align into a column so digits line up across rows,
							 * and stay put as the cursor moves between buckets.
							 */}
							<div className="flex flex-1 items-center justify-between gap-3 leading-none">
								<span className="text-muted-foreground">{spec.label}</span>
								<span className="font-mono font-semibold text-foreground tabular-nums">
									{spec.format(value)}
								</span>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}
