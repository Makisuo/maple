/**
 * Where an auto-placed widget lands on the canvas.
 *
 * There were four copies of this: the web store's `findNextPosition`, the MCP
 * tools' `findNextWidgetPosition` (whose comment read "Port of `findNextPosition`
 * … Keeps auto-layout behavior identical"), the Perses importer's `nextLayout`,
 * and `computeAutoLayout` in `create_dashboard`. Three implemented the same
 * algorithm and differed only in the *width* they asked for, which is a caller
 * policy — so the width is a parameter and the algorithm is here.
 */

/** The canvas is a 12-column grid. */
export const DASHBOARD_GRID_COLS = 12

/**
 * Structural, not `DashboardWidget`: the web and the API hold different widget
 * types (mutable vs readonly), and placement only ever reads the grid rectangle.
 */
export interface PlaceableWidget {
	readonly layout: {
		readonly x: number
		readonly y: number
		readonly w: number
		readonly h: number
	}
}

/**
 * Pack onto the end of the bottom row if the new tile fits beside what is
 * already there, otherwise start a fresh row under everything.
 *
 * `widgets` must already be scoped to the destination container — `layout.x/y`
 * are relative to the root canvas or to a (section, tab), never to one global
 * canvas, so placing against the whole board would drop a grouped widget below
 * tiles it will never share a grid with.
 */
export const findNextPosition = (
	widgets: ReadonlyArray<PlaceableWidget>,
	newWidth: number,
): { x: number; y: number } => {
	if (widgets.length === 0) return { x: 0, y: 0 }

	const maxY = Math.max(...widgets.map((widget) => widget.layout.y))
	const bottomRow = widgets.filter((widget) => widget.layout.y === maxY)
	const rightEdge = Math.max(...bottomRow.map((widget) => widget.layout.x + widget.layout.w))

	if (rightEdge + newWidth <= DASHBOARD_GRID_COLS) return { x: rightEdge, y: maxY }

	return { x: 0, y: Math.max(...widgets.map((widget) => widget.layout.y + widget.layout.h)) }
}
