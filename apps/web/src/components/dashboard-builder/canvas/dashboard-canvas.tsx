import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GridLayout, noCompactor, verticalCompactor } from "react-grid-layout"
import type { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import { useContainerSize } from "@maple/ui/hooks/use-container-size"
import { cn } from "@maple/ui/lib/utils"

import {
	GRID_ROW_HEIGHT,
	projectLayout,
	tierForWidth,
	type GridTier,
} from "@/components/dashboard-builder/canvas/grid-breakpoints"
import type { DashboardWidget } from "@/components/dashboard-builder/types"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { WidgetActionsProvider } from "@/components/dashboard-builder/widgets/widget-actions-context"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { useWidgetData } from "@/hooks/use-widget-data"

/** Same widgets in the same boxes, ignoring order. */
function sameLayout(a: Layout, b: Layout): boolean {
	if (a.length !== b.length) return false
	const byId = new Map(b.map((item) => [item.i, item]))
	return a.every((item) => {
		const other = byId.get(item.i)
		return (
			other !== undefined &&
			other.x === item.x &&
			other.y === item.y &&
			other.w === item.w &&
			other.h === item.h
		)
	})
}

interface DashboardCanvasProps {
	widgets: DashboardWidget[]
	/**
	 * When true, the grid is read-only: drag/resize disabled, layout-change
	 * callbacks suppressed. Used while previewing a historical version so
	 * interactions don't accidentally mutate the live dashboard.
	 */
	readOnly?: boolean
}

/**
 * Latches `true` the first time the element scrolls into (near) the viewport,
 * then stays latched. Tiles fetch their data lazily on first reveal and keep it
 * — unlatching would unmount the tile's atom, and a non-sticky flag would then
 * refetch every time it scrolled back into view. The 200ms debounce absorbs
 * react-grid-layout's mount-time reflow, where tiles can briefly flash into
 * view before the layout settles.
 */
function useInViewportSticky() {
	const ref = useRef<HTMLDivElement>(null)
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		if (visible) return
		const element = ref.current
		if (!element) return
		if (typeof IntersectionObserver === "undefined") {
			setVisible(true)
			return
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		const observer = new IntersectionObserver(
			(entries) => {
				const isIntersecting = entries.some((entry) => entry.isIntersecting)
				if (isIntersecting && timer == null) {
					timer = setTimeout(() => setVisible(true), 200)
				} else if (!isIntersecting && timer != null) {
					clearTimeout(timer)
					timer = undefined
				}
			},
			{ rootMargin: "200px" },
		)
		observer.observe(element)
		return () => {
			if (timer != null) clearTimeout(timer)
			observer.disconnect()
		}
	}, [visible])

	return { ref, visible }
}

const WidgetRenderer = memo(function WidgetRenderer({ widget }: { widget: DashboardWidget }) {
	const { mode } = useDashboardActions()
	const { ref, visible } = useInViewportSticky()
	const { dataState, narrowRange, narrowRangeLabel } = useWidgetData(widget, visible)
	const Visualization = visualizationFor(widget.visualization)

	return (
		<div ref={ref} className="h-full w-full">
			<WidgetTimeRangeProvider timeRange={widget.timeRange}>
				<WidgetActionsProvider
					widget={widget}
					dataState={dataState}
					narrowRange={narrowRange}
					narrowRangeLabel={narrowRangeLabel}
				>
					<Visualization
						dataState={dataState}
						display={widget.display}
						mode={mode}
						rowLimit={widget.dataSource.transform?.limit}
					/>
				</WidgetActionsProvider>
			</WidgetTimeRangeProvider>
		</div>
	)
})

interface DashboardGridProps {
	widgets: DashboardWidget[]
	/** Measured container width in px. The caller owns measurement. */
	width: number
	tier: GridTier
	editable: boolean
}

/**
 * One react-grid-layout instance over one container's widgets.
 *
 * Deliberately measurement-free: a sectioned board renders several of these, and
 * they must all agree on the same tier or a group could decide it is on a
 * narrower breakpoint than its neighbour. The parent measures once and passes
 * `width`/`tier` down.
 *
 * Every widget's `layout.x/y` is relative to *this* grid, so each instance is an
 * independent coordinate space starting at (0, 0).
 */
export function DashboardGrid({ widgets, width, tier, editable }: DashboardGridProps) {
	const { updateWidgetLayouts } = useDashboardActions()

	const layout = useMemo(() => projectLayout(widgets, tier), [widgets, tier])

	// react-grid-layout fires onLayoutChange with the post-compaction layout
	// after every re-layout, not just on user edits — a tier crossing produces
	// one, and an upsert from a plain window resize would invalidate the
	// dashboards list and cascade a re-render of every widget.
	//
	// Comparing against the layout we handed the grid is what separates the two,
	// rather than counting callbacks: this version of react-grid-layout does not
	// fire on mount, so a "drop the first call per tier" rule swallows the user's
	// first real edit instead of the re-layout it was aiming at.
	//
	// The reported items are only this container's, and `updateWidgetLayouts`
	// matches by widget id, so sibling containers are untouched.
	const handleLayoutChange = useCallback(
		(next: Layout) => {
			if (!editable) return
			if (sameLayout(next, layout)) return
			updateWidgetLayouts(next.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })))
		},
		[editable, layout, updateWidgetLayouts],
	)

	return (
		<GridLayout
			width={width}
			layout={layout}
			gridConfig={{
				cols: tier.cols,
				rowHeight: GRID_ROW_HEIGHT,
				margin: tier.margin,
			}}
			dragConfig={{
				enabled: editable,
				handle: ".widget-drag-handle",
				bounded: false,
				threshold: 3,
			}}
			resizeConfig={{
				enabled: editable,
				handles: ["se"],
			}}
			// Derived tiers ship exact row-packed positions; letting the
			// vertical compactor run would float short tiles up into the
			// gaps beside taller neighbours and break the rows apart.
			compactor={tier.canonical ? verticalCompactor : noCompactor}
			onLayoutChange={handleLayoutChange}
		>
			{widgets.map((widget) => (
				<div key={widget.id}>
					<WidgetRenderer widget={widget} />
				</div>
			))}
		</GridLayout>
	)
}

/**
 * A single measured grid over a flat widget list.
 *
 * Still the entry point for the surfaces that render a board without sections —
 * the history preview and the template live preview. The sectioned dashboard
 * route goes through `DashboardSections`, which measures once for every group.
 */
export function DashboardCanvas({ widgets, readOnly = false }: DashboardCanvasProps) {
	const { mode } = useDashboardActions()
	// Deliberately not react-grid-layout's own `useContainerWidth`: it seeds
	// width at a hardcoded 1280 and its ResizeObserver was observed failing to
	// correct that here, so the grid laid every tile out for a 1280px canvas and
	// overflowed the real ~1150px one. `useContainerSize` reads the box
	// synchronously before observing, which is exactly the case that broke.
	const containerRef = useRef<HTMLDivElement>(null)
	const { width: measuredWidth } = useContainerSize(containerRef)
	// Rounded so subpixel container widths don't re-lay-out the whole grid.
	const width = Math.round(measuredWidth)
	const measured = width > 0

	// Only the canonical tier's layout is authored and persisted; narrower ones
	// are projected from it at render time. Editing there would write a
	// phone-shaped layout over the real one, so drag, resize and persistence are
	// all gated on `tier.canonical`.
	const tier = tierForWidth(width)
	const editable = mode === "edit" && !readOnly && tier.canonical

	return (
		// `is-layout-locked` lets WidgetShell hide its drag grip when the grid is
		// showing a generated layout — a grip that can't be dragged reads as a
		// bug. Widget-level actions (configure, clone, delete) stay available;
		// only the arrangement is locked.
		<div ref={containerRef} className={cn("group/canvas", !tier.canonical && "is-layout-locked")}>
			{mode === "edit" && !readOnly && !tier.canonical && (
				<p className="mb-3 text-xs text-muted-foreground">
					Showing a layout adapted to this width. Widen the window to rearrange widgets.
				</p>
			)}
			{measured && (
				<DashboardGrid widgets={widgets} width={width} tier={tier} editable={editable} />
			)}
		</div>
	)
}
