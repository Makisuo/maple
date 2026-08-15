import { useCallback, useMemo, type ComponentType } from "react"
import type { SectionMembership } from "@maple/widgets/dashboard"
import { GridLayout, noCompactor, verticalCompactor } from "react-grid-layout"
import type { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import {
	GRID_ROW_HEIGHT,
	projectLayout,
	type GridTier,
	type PlacedWidget,
} from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { useDashboardActionsOptional } from "@/components/dashboard-builder/dashboard-actions-context"

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

/** What the canvas needs of a widget: somewhere to put it, and which group it's in. */
export interface CanvasWidget extends PlacedWidget, SectionMembership {}

/**
 * How one widget draws itself.
 *
 * A component type rather than a `(widget) => ReactNode` callback: renderers
 * call hooks, and a function prop invoked inline would splice them into the
 * grid child's hook slot. Mirrors `visualizationFor`, which already returns a
 * component.
 */
export type WidgetRendererComponent<W> = ComponentType<{ widget: W }>

interface DashboardGridProps<W extends CanvasWidget> {
	widgets: ReadonlyArray<W>
	/** Measured container width in px. The caller owns measurement. */
	width: number
	tier: GridTier
	editable: boolean
	/**
	 * Required, never defaulted: a default cannot type-check against an
	 * arbitrary `W`, and naming the renderer at each mount point is what stops a
	 * read-only surface silently inheriting the authed data path.
	 */
	renderWidget: WidgetRendererComponent<W>
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
 *
 * Generic over the widget because the read-only surfaces render a redacted
 * widget whose data source cannot inhabit the stored union. The type parameter
 * carries that difference; nothing here needs a cast.
 */
export function DashboardGrid<W extends CanvasWidget>({
	widgets,
	width,
	tier,
	editable,
	renderWidget: Renderer,
}: DashboardGridProps<W>) {
	// Optional: a share link and a full-screen board mount this grid with no
	// store behind them. They are never editable, so there is nothing to persist.
	const actions = useDashboardActionsOptional()

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
			actions?.updateWidgetLayouts(next.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })))
		},
		[editable, layout, actions],
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
					<Renderer widget={widget} />
				</div>
			))}
		</GridLayout>
	)
}
