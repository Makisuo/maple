import { findNearestSeriesKey } from "@maple/ui/components/charts/_shared/nearest-series"
import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { crosshair, dot, whenFocused } from "@tanstack/charts"
import type { ChartLinearGradient, ChartPoint, ChartTooltipAnchor, ChartValue } from "@tanstack/charts"
import { tooltip } from "@tanstack/charts/tooltip"
import { useId, useSyncExternalStore, type ReactNode } from "react"

/** How far from a series' plotted point the cursor may sit and still emphasise it. */
const HIGHLIGHT_MAX_DISTANCE_PX = 24

/**
 * A DOM-safe unique id for gradients and anything else referenced as `url(#…)`.
 *
 * Gradient ids used to be module constants, which meant two instances of the
 * same chart on one page emitted duplicate `<defs>` ids and the second silently
 * painted with the first's stops. `area-spike.tsx` worked around it by threading
 * an `idPrefix` prop down from every call site — prop-drilling a uniqueness
 * concern the component can own.
 *
 * `useId()` alone is not enough: React 19 returns `«r0»`, and those brackets
 * inside a `fill="url(#…)"` reference are a portability risk across the SVG and
 * canvas renderers. Sanitizing to `[A-Za-z0-9_-]` is stable under any
 * `identifierPrefix`.
 */
export function useChartId(prefix: string): string {
	const raw = useId()
	return `${prefix}-${raw.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/**
 * The cursor-anchored tooltip every timeseries spike uses.
 *
 * Anchor to the CURSOR, not the datum. The default "point" anchor snaps the card
 * to each bucket's plotted position, and with placement "auto" it re-picks a side
 * as it goes — a 60px pointer move shifted the card 97px. `ChartFloatingTooltip`
 * anchors at the cursor with a fixed side for exactly this reason.
 *
 * Pass a focus store's `anchor` to also capture the scales the tooltip's row
 * highlight needs; pass `"pointer"` when the chart has no such highlight. Both
 * produce the same placement — the callback form just observes on the way past.
 *
 * `focus` and `focusRing` stay on the caller: they genuinely differ per chart
 * (`"group-x"`, `"nearest"`, `focusGroupAngle`) and each carries its own reason.
 */
export function cursorTooltip<TDatum>(anchor: ChartTooltipAnchor<TDatum, ChartValue, number> | "pointer") {
	return {
		use: tooltip,
		className: "maple-bench-tooltip",
		anchor,
		placement: "right",
		offset: 12,
	} as const
}

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
 * A dasharray that actually reads as dashes under a `lineY` mark.
 *
 * `lineY` hard-codes `lineCap: "round"` / `lineJoin: "round"` on every line node
 * it emits (`dist/line.js:123-124`) and `LineYOptions` exposes no `lineCap`, so
 * a semicircular cap of radius `strokeWidth / 2` is added to BOTH ends of every
 * dash. Recharts' `<Line>` leaves the default butt cap, so the `"4 4"` that
 * reads crisply there paints `4 + strokeWidth` of ink against a
 * `4 - strokeWidth` gap here — at a 2.5px stroke that is 6.5px on, 1.5px off,
 * which is why a ported incomplete tail reads as a wobbly solid line instead of
 * a dashed one.
 *
 * The fix is geometry, not taste: take the cap out of the dash and give it to
 * the gap. `on` and `off` are the widths you want to SEE.
 *
 * On duty cycle: Recharts' `"4 4"` at a 2px butt cap is a 50% duty cycle, and it
 * reads as dashed there partly because the solid twin beside it is BEADED with a
 * dot at every point (`shouldDot`), while the incomplete twin sets `dot={false}`.
 * These charts draw no dots at rest, so the dash is carrying the whole "this part
 * is different" signal on its own and has to be more open than production's to do
 * the same work.
 */
export function roundCapDasharray(on: number, off: number, strokeWidth: number): string {
	// A zero-length dash under a round cap still paints a dot, which is the
	// degenerate case worth keeping rather than collapsing to nothing.
	return `${Math.max(0.01, on - strokeWidth)} ${off + strokeWidth}`
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
export interface TooltipFocus {
	pointerY: number | null
	/**
	 * `ResolvedScale.map` declares `(value: unknown)`, but every y channel in
	 * these charts is a number — narrowed here so callers can't hand it an
	 * unparsed value. Assignment stays sound by contravariance.
	 */
	mapY: ((value: number) => number) | null
}

export interface TooltipFocusStore<TDatum> {
	anchor: ChartTooltipAnchor<TDatum, ChartValue, number>
	subscribe: (listener: () => void) => () => void
	getSnapshot: () => TooltipFocus
}

const EMPTY_FOCUS: TooltipFocus = { pointerY: null, mapY: null }

/**
 * A store rather than a mutable object, because `TooltipBody` reads this DURING
 * RENDER. An earlier revision handed the body a plain object that `anchor`
 * mutated in place, and that tears under concurrent rendering: any re-render not
 * caused by a pointer move — a theme flip, a parent update, StrictMode's second
 * pass — reads whatever the last anchor happened to leave behind.
 *
 * `useState` would be the obvious fix and the wrong one here: it adds a render
 * per pointer move to the exact path this bench exists to measure. A store read
 * through `useSyncExternalStore` costs nothing extra — `anchor` runs immediately
 * before the host's own `setTarget` (`dist/react/tooltip.js:56`), so React's
 * automatic batching collapses the notification into the render that already
 * happens on every tooltip update.
 */
export function createTooltipFocusStore<TDatum>(): TooltipFocusStore<TDatum> {
	let snapshot: TooltipFocus = EMPTY_FOCUS
	const listeners = new Set<() => void>()

	const anchor: ChartTooltipAnchor<TDatum, ChartValue, number> = (_points, context) => {
		const pointerY = context.pointer?.y ?? null
		const mapY = context.scales.y?.map ?? null
		// Re-anchoring at the same position must not notify — otherwise a scene
		// update that doesn't move the cursor costs a render the old object never did.
		if (pointerY !== snapshot.pointerY || mapY !== snapshot.mapY) {
			snapshot = { pointerY, mapY }
			for (const listener of listeners) listener()
		}
		return context.pointer
	}

	return {
		anchor,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		// Returns the CACHED object, never a fresh literal — `useSyncExternalStore`
		// compares snapshots by identity and would loop forever on a new one.
		getSnapshot: () => snapshot,
	}
}

export function useTooltipFocus<TDatum>(store: TooltipFocusStore<TDatum>): TooltipFocus {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
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
	focusStore,
}: {
	points: readonly ChartPoint<TDatum, ChartValue, number>[]
	series: readonly TooltipSeriesSpec<TDatum>[]
	heading: (datum: TDatum) => string
	focusStore: TooltipFocusStore<TDatum>
}): ReactNode {
	// Subscribed, not read off a mutable object — see `createTooltipFocusStore`.
	// Called before the early return below because it is a hook.
	const focus = useTooltipFocus(focusStore)

	const first = points[0]
	if (!first) return null
	const datum = first.datum

	// Emphasise the series whose plotted point is nearest the cursor, as
	// ChartTooltipContent does. Single-series charts emphasise nothing — there is
	// no ambiguity to resolve, and bolding the only row is just noise.
	let highlightLabel: string | undefined
	if (focus.mapY && focus.pointerY != null && series.length > 1) {
		const yByLabel: Record<string, number> = {}
		for (const spec of series) {
			const value = spec.value(datum)
			if (value != null) yByLabel[spec.label] = focus.mapY(value)
		}
		highlightLabel = findNearestSeriesKey(
			yByLabel,
			series.map((spec) => spec.label),
			focus.pointerY,
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
