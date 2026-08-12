import {
	ROOT_CONTAINER_KEY,
	containerKeyFor,
	containerKeyOf,
	withSectionTarget,
	type SectionTarget,
} from "@maple/domain/http"

import { CANONICAL_COLS } from "@/components/dashboard-builder/canvas/grid-breakpoints"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"

// Layout maths for a sectioned board. Every widget's `layout.x/y` is relative to
// its own container — the root canvas, or one (section, tab) — so each container
// is an independent coordinate space starting at (0, 0) and every helper here
// operates on one container's widgets at a time.
//
// Pure and React-free so the placement rules are testable without rendering a
// grid.

export { containerKeyFor, containerKeyOf, ROOT_CONTAINER_KEY, withSectionTarget }
export type { SectionTarget }

/**
 * Where a new widget of `newWidth` columns should land within one container.
 *
 * Fills the bottom row left-to-right while it fits, then starts a new row. The
 * caller must pass only the destination container's widgets: handing it the
 * whole board would place a grouped widget below unrelated tiles it will never
 * share a grid with.
 */
export function findNextPosition(
	widgets: ReadonlyArray<DashboardWidget>,
	newWidth: number,
): { x: number; y: number } {
	if (widgets.length === 0) return { x: 0, y: 0 }

	const maxY = Math.max(...widgets.map((w) => w.layout.y))
	const bottomRowWidgets = widgets.filter((w) => w.layout.y === maxY)
	const rightEdge = Math.max(...bottomRowWidgets.map((w) => w.layout.x + w.layout.w))

	if (rightEdge + newWidth <= CANONICAL_COLS) return { x: rightEdge, y: maxY }

	const maxBottom = Math.max(...widgets.map((w) => w.layout.y + w.layout.h))
	return { x: 0, y: maxBottom }
}

/** The widgets sharing one container, in document order. */
export function widgetsInContainer(
	widgets: ReadonlyArray<DashboardWidget>,
	target: SectionTarget,
): ReadonlyArray<DashboardWidget> {
	const key = containerKeyFor(target)
	return widgets.filter((widget) => containerKeyOf(widget) === key)
}

/**
 * Rank of a widget's container in reading order: root first, then sections in
 * array order, then tabs within each section.
 *
 * Widgets whose container has vanished rank as root, matching where they render.
 */
export function containerRank(
	widget: DashboardWidget,
	sections: ReadonlyArray<DashboardSection>,
): number {
	if (widget.sectionId === undefined || widget.tabId === undefined) return -1
	const sectionIndex = sections.findIndex((section) => section.id === widget.sectionId)
	if (sectionIndex === -1) return -1
	const tabIndex = sections[sectionIndex]!.tabs.findIndex((tab) => tab.id === widget.tabId)
	if (tabIndex === -1) return -1
	// Rank by (section, tab) without needing a global tab count: sections are
	// capped well below this multiplier, and only relative order matters.
	return sectionIndex * 1000 + tabIndex
}

/**
 * Sort widgets into visual order across the whole board.
 *
 * The grid compactor uses array order as a tiebreaker when items share a row, so
 * a stale order makes drag-to-swap snap back. Container rank leads the
 * comparator because each container restarts at `y: 0` — sorting on `(y, x)`
 * alone would interleave section 2's top row with section 1's.
 */
export function sortWidgetsForLayout(
	widgets: ReadonlyArray<DashboardWidget>,
	sections: ReadonlyArray<DashboardSection>,
): DashboardWidget[] {
	return widgets.toSorted((a, b) => {
		const rankDelta = containerRank(a, sections) - containerRank(b, sections)
		if (rankDelta !== 0) return rankDelta
		if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
		return a.layout.x - b.layout.x
	})
}

/** Lowest occupied row of the root canvas — where ungrouped widgets land. */
export function rootBottom(widgets: ReadonlyArray<DashboardWidget>): number {
	const root = widgetsInContainer(widgets, null)
	if (root.length === 0) return 0
	return Math.max(...root.map((w) => w.layout.y + w.layout.h))
}

/**
 * Move a section's widgets onto the root canvas, below whatever is already
 * there, and strip their membership.
 *
 * Offsetting by the current root bottom rather than dropping them at `y: 0` is
 * what stops an ungroup from burying the board's existing tiles under the ones
 * that just arrived.
 */
export function ungroupSectionWidgets(
	widgets: ReadonlyArray<DashboardWidget>,
	sectionId: string,
): DashboardWidget[] {
	const offset = rootBottom(widgets)
	return widgets.map((widget) => {
		if (widget.sectionId !== sectionId) return widget
		const moved = withSectionTarget(widget, null)
		return { ...moved, layout: { ...moved.layout, y: moved.layout.y + offset } }
	})
}

/**
 * Re-flow every container independently, each restarting at (0, 0).
 *
 * Reading order within a container is preserved; containers never bleed into
 * each other's coordinate space.
 */
export function autoLayoutPerContainer(
	widgets: ReadonlyArray<DashboardWidget>,
	sections: ReadonlyArray<DashboardSection>,
): DashboardWidget[] {
	const byContainer = new Map<string, DashboardWidget[]>()
	for (const widget of sortWidgetsForLayout(widgets, sections)) {
		const key = containerKeyOf(widget)
		const bucket = byContainer.get(key)
		if (bucket) bucket.push(widget)
		else byContainer.set(key, [widget])
	}

	const relaid = new Map<string, DashboardWidget>()
	for (const bucket of byContainer.values()) {
		let currentX = 0
		let currentY = 0
		let rowHeight = 0

		for (const widget of bucket) {
			const { w, h } = widget.layout
			if (currentX + w > CANONICAL_COLS) {
				currentX = 0
				currentY += rowHeight
				rowHeight = 0
			}
			relaid.set(widget.id, { ...widget, layout: { ...widget.layout, x: currentX, y: currentY } })
			currentX += w
			rowHeight = Math.max(rowHeight, h)
		}
	}

	// Rebuild in the board's sorted order so array order still matches visual
	// order for the compactor.
	return sortWidgetsForLayout(widgets, sections).map((widget) => relaid.get(widget.id) ?? widget)
}
