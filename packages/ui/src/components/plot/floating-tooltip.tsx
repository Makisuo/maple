import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * The renderer-agnostic tooltip surface, and the suppression channel overlays
 * use to quiet it.
 *
 * Lifted out of `ui/chart.tsx` unchanged. None of it is Recharts-specific: the
 * charts that compute their own anchor (pie, heatmap) already went straight
 * through `ChartFloatingTooltip`, and the TanStack charts that build a tooltip
 * outside `cursorTooltip` need the same card.
 */
const EMPTY_SUPPRESSORS: ReadonlySet<string> = new Set()

/**
 * Lets in-chart overlays (e.g. commit deploy markers) temporarily hide the
 * default data tooltip so a marker card and the data tooltip never show at once.
 * An overlay's suppression requires a `ChartTooltipSuppressionProvider` above the
 * chart (e.g. the one MetricsGrid mounts around a synced grid) so a marker card on
 * any chart also quiets the synced tooltips on its siblings; without one, the
 * suppression calls are no-ops. Suppressors are tracked by id (each overlay owns
 * one) so concurrent charts don't clobber each other's flag.
 *
 * While suppressed the tooltip stays MOUNTED (rendered transparent) instead of
 * unmounting — so when it un-suppresses it resumes its position transition from
 * where it was (next to the marker) rather than snapping in from the origin.
 */
// Split into two contexts so a suppression toggle only rerenders the
// components that read the boolean (the tooltip contents), not every overlay
// holding the stable setter — in a synced grid one marker hover would
// otherwise fan a render out to all sibling charts' overlays.
const ChartTooltipSuppressedContext = React.createContext<boolean>(false)
const ChartTooltipSetSuppressedContext = React.createContext<
	((id: string, suppressed: boolean) => void) | null
>(null)

export function ChartTooltipSuppressionProvider({ children }: { children: React.ReactNode }) {
	const [suppressors, setSuppressors] = React.useState<ReadonlySet<string>>(EMPTY_SUPPRESSORS)
	const setSuppressed = React.useCallback((id: string, suppressed: boolean) => {
		setSuppressors((prev) => {
			if (suppressed === prev.has(id)) return prev
			const next = new Set(prev)
			if (suppressed) next.add(id)
			else next.delete(id)
			return next
		})
	}, [])
	return (
		<ChartTooltipSetSuppressedContext.Provider value={setSuppressed}>
			<ChartTooltipSuppressedContext.Provider value={suppressors.size > 0}>
				{children}
			</ChartTooltipSuppressedContext.Provider>
		</ChartTooltipSetSuppressedContext.Provider>
	)
}

/**
 * The setter an in-chart overlay uses to hide/restore the chart's data tooltip.
 * Reads only the STABLE setter context (not the boolean, which changes whenever
 * suppression toggles) so the returned function keeps a stable identity and the
 * overlay doesn't rerender on toggles — overlays put it in effect deps, and an
 * unstable one would loop (cleanup re-fires → toggles state → re-renders → …).
 */
export function useSuppressChartTooltip(): (suppressed: boolean) => void {
	const setSuppressed = React.use(ChartTooltipSetSuppressedContext)
	const id = React.useId()
	return React.useCallback((suppressed: boolean) => setSuppressed?.(id, suppressed), [setSuppressed, id])
}

export function useChartTooltipSuppressed(): boolean {
	return React.use(ChartTooltipSuppressedContext)
}

/**
 * The tooltip card surface — the same translucent, blurred panel for every chart
 * tooltip. Module-local: charts get it via `ChartFloatingTooltip`, never directly.
 */
export const chartTooltipCardClassName =
	"border-border/50 bg-popover/90 text-popover-foreground rounded-xl border px-3 py-2 text-xs shadow-xl backdrop-blur-md"

/**
 * Gates the position transition so a tooltip snaps to its anchor on first
 * appearance and only *follows* on subsequent moves.
 *
 * Without this, a remount (recharts goes inactive whenever an in-chart overlay
 * such as the commit marker card swallows pointer events) would slide the card
 * in from the chart origin. So the transition is OFF for the first painted frame
 * after the closed→open edge, then ON. Continuous hovering never closes, so the
 * follow transition is never interrupted mid-hover.
 */
function useChartTooltipFollow(open: boolean): boolean {
	const [followEnabled, setFollowEnabled] = React.useState(false)
	const openRef = React.useRef(false)

	React.useEffect(() => {
		if (open === openRef.current) return
		openRef.current = open
		if (!open) {
			// Reset so the next open starts snapped, not sliding in from the origin.
			setFollowEnabled(false)
			return
		}
		const raf = requestAnimationFrame(() => setFollowEnabled(true))
		return () => cancelAnimationFrame(raf)
	}, [open])

	return followEnabled
}

/**
 * A tooltip card anchored to a point or box *inside* a chart, portalled to the
 * body so it can leave the widget card — whose `overflow-hidden` is deliberate
 * (see `widget-shell.tsx`) and would otherwise clip it to the tile.
 *
 * Every chart tooltip goes through here: the recharts path via
 * `ChartTooltipContent`, and the charts that compute their own anchor (pie,
 * heatmap) directly. Collision handling, the z-band, the snap-then-follow
 * transition and the suppression fade all live in one place as a result.
 */
export function ChartFloatingTooltip({
	containerRef,
	x,
	y,
	width = 0,
	height = 0,
	open,
	side = "right",
	sideOffset = 12,
	chartId,
	className,
	children,
}: {
	/** Element `x`/`y` are measured against; its live client rect is read per position pass. */
	containerRef: React.RefObject<HTMLElement | null>
	/** Anchor box in `containerRef`-local CSS pixels. Zero-sized means a point (the cursor). */
	x: number | undefined
	y: number | undefined
	width?: number
	height?: number
	/**
	 * `false` keeps the card mounted but transparent, so it fades out in place
	 * rather than vanishing — and so the next open resumes from where it sits.
	 */
	open: boolean
	side?: TooltipPrimitive.Positioner.Props["side"]
	sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"]
	/**
	 * Recharts-path only. Exactly one `[data-chart]` node may exist per open
	 * tooltip — a perf spec asserts it — so the self-anchoring charts pass
	 * nothing and are identified by `data-slot` instead.
	 */
	chartId?: string
	className?: string
	children: React.ReactNode
}): React.ReactElement | null {
	const suppressed = useChartTooltipSuppressed()
	const followEnabled = useChartTooltipFollow(open)

	if (x == null || y == null || !containerRef.current) {
		return null
	}

	const anchor = {
		getBoundingClientRect: () => {
			// Read live: the container may have scrolled or resized since the
			// last position pass, and base-ui re-invokes this on each one.
			const rect = containerRef.current?.getBoundingClientRect()
			const left = (rect?.left ?? 0) + x
			const top = (rect?.top ?? 0) + y
			return {
				x: left,
				y: top,
				width,
				height,
				top,
				left,
				right: left + width,
				bottom: top + height,
			}
		},
	}

	return (
		<TooltipPrimitive.Root open>
			<TooltipPrimitive.Portal>
				{/*
				 * The collision boundary is deliberately left at its default — which,
				 * because we're in a `body` portal, is the WINDOW, not the widget card.
				 * (`collisionBoundary: "clipping-ancestors"` resolves against the floating
				 * element, so the card's `overflow-hidden` never applies here.) Escaping
				 * the tile is the entire point of portalling: a 240px-tall widget would
				 * otherwise clamp the card permanently on top of the data it describes.
				 *
				 * `sticky` is likewise deliberately off — it implies cross-axis shift,
				 * which near the window edge would slide the card sideways across the
				 * cursor and the plot instead of flipping cleanly to the other side.
				 */}
				<TooltipPrimitive.Positioner
					anchor={anchor}
					side={side}
					sideOffset={sideOffset}
					collisionPadding={12}
					className={cn(
						// z-55 is the transient hover-surface band (see tooltip.tsx); z-50
						// is the modal band, where a tooltip inside a Sheet/Dialog would tie
						// with the modal and let portal mount order decide paint order.
						"z-55 pointer-events-none ease-out",
						// Positioning is transform-based (there's no `Viewport`, so base-ui's
						// `adaptiveOrigin` stays off and floating-ui's default `transform`
						// styles apply) — which keeps the follow composited and makes a
						// collision flip animate as one continuous slide rather than a
						// discontinuous `left` → `right` origin swap.
						followEnabled
							? "transition-[transform,opacity] duration-200"
							: "transition-opacity duration-200",
						// Closed, or an in-chart overlay (commit markers) is showing its own
						// card: stay mounted-but-transparent so the position transition
						// resumes from here rather than from the origin.
						(!open || suppressed) && "opacity-0",
					)}
				>
					<TooltipPrimitive.Popup data-chart={chartId} data-slot="chart-tooltip">
						<div
							className={cn(
								chartTooltipCardClassName,
								// `size()` publishes --available-height on the positioner.
								// Shift can't rescue a card taller than the window, and the
								// positioner is pointer-events-none so scrolling it isn't an
								// option — clamp instead of bleeding off both edges.
								"max-h-(--available-height) overflow-hidden",
								className,
							)}
						>
							{children}
						</div>
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	)
}
