import type { ChartPoint, ChartTooltipAnchor, ChartValue } from "@tanstack/charts"
import { tooltip } from "@tanstack/charts/tooltip"
import { useSyncExternalStore, type ReactNode } from "react"

import { findNearestSeriesKey } from "../charts/_shared/nearest-series"

/** How far from a series' plotted point the cursor may sit and still emphasise it. */
const HIGHLIGHT_MAX_DISTANCE_PX = 24

/**
 * The cursor-anchored tooltip every cartesian chart uses.
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
		className: "maple-plot-tooltip",
		anchor,
		placement: "right",
		offset: 12,
	} as const
}

/**
 * Suppression: build the spec WITHOUT a tooltip rather than rendering an empty
 * body.
 *
 * Returning `null` from `renderTooltipBody` still paints the shell — an empty
 * card follows the cursor. The only way to actually suppress is to omit
 * `tooltip:` from the definition, which rebuilds it. That is affordable because
 * suppression is edge-triggered (an overlay marker takes the pointer), not
 * per-tick.
 */
export function maybeTooltip<TDatum>(
	suppressed: boolean,
	anchor: ChartTooltipAnchor<TDatum, ChartValue, number> | "pointer",
) {
	return suppressed ? undefined : cursorTooltip(anchor)
}

/**
 * Captures the pointer position and the resolved y scale on every tooltip
 * update, so the body can emphasise the series nearest the cursor.
 *
 * It rides on the `anchor` callback because that is the only tooltip hook handed
 * the pointer and the scales — `renderTooltipBody` receives neither, and its
 * single point can't be used to reconstruct where the other series sit. The
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
 * A store rather than a mutable object, because `PlotTooltipBody` reads this
 * DURING RENDER. An earlier revision handed the body a plain object that
 * `anchor` mutated in place, and that tears under concurrent rendering: any
 * re-render not caused by a pointer move — a theme flip, a parent update,
 * StrictMode's second pass — reads whatever the last anchor happened to leave
 * behind.
 *
 * `useState` would be the obvious fix and the wrong one here: it adds a render
 * per pointer move to the hottest path in the chart layer. A store read through
 * `useSyncExternalStore` costs nothing extra — `anchor` runs immediately before
 * the host's own `setTarget` (`dist/react/tooltip.js:56`), so React's automatic
 * batching collapses the notification into the render that already happens on
 * every tooltip update.
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

export interface PlotTooltipSeries<TDatum> {
	label: string
	color: string
	dashed?: boolean
	value: (datum: TDatum) => number | null | undefined
	format: (value: number) => string
}

/**
 * The tooltip body.
 *
 * Rows are read off `points[0].datum` — NOT by iterating `points`.
 *
 * `focus: "group-x"` (and the exported `focusGroupX` strategy, which behaves
 * identically) hands back only the point belonging to the mark under the cursor:
 * every point arrives with `group: null` and `points.length === 1`, even with
 * several marks sharing an x scale. Still open at 0.14.0. TanStack groups by the
 * `z` channel *within* one mark, so the one-mark-per-series idiom yields no
 * group at all — reading the datum is the workaround.
 *
 * **This only works while every series lives in the same row object.** Long-form
 * charts (a stacked bar, where one datum is one cell rather than one bucket)
 * must resolve the bucket's rows through their own `Map` instead. Handing this
 * component a long-form datum yields a one-row tooltip and no error.
 */
export function PlotTooltipBody<TDatum>({
	points,
	series,
	heading,
	focusStore,
}: {
	points: readonly ChartPoint<TDatum, ChartValue, number>[]
	series: readonly PlotTooltipSeries<TDatum>[]
	heading: (datum: TDatum) => string
	focusStore: TooltipFocusStore<TDatum>
}): ReactNode {
	// Subscribed, not read off a mutable object — see `createTooltipFocusStore`.
	// Called before the early return below because it is a hook.
	const focus = useTooltipFocus(focusStore)

	const first = points[0]
	if (!first) return null
	const datum = first.datum

	// Emphasise the series whose plotted point is nearest the cursor. Single-series
	// charts emphasise nothing — there is no ambiguity to resolve, and bolding the
	// only row is just noise.
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
							 * `justify-between` + `tabular-nums`: values right-align into a
							 * column so digits line up across rows, and stay put as the cursor
							 * moves between buckets.
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
