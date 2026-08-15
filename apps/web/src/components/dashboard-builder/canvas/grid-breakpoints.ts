import type { Layout, LayoutItem } from "react-grid-layout"

import type { DashboardWidget } from "@/components/dashboard-builder/types"

/**
 * Grid geometry for the dashboard canvas.
 *
 * Dashboards persist exactly one layout, authored against the 12-column
 * canonical grid. Narrower layouts are never stored — `projectLayout` derives
 * them at render time, so every existing dashboard is responsive without a
 * schema change or a migration.
 *
 * The corollary is that only the canonical tier may be edited: a layout derived
 * for a phone must never be written back over the authored one. The canvas
 * enforces that by gating `editable` and layout persistence on `tier.canonical`.
 */

/** Column count of the authored (persisted) layout. */
export const CANONICAL_COLS = 12

export const GRID_ROW_HEIGHT = 60

export interface GridTier {
	/** Minimum container width in px at which this tier applies. */
	minWidth: number
	cols: number
	/**
	 * Narrowest span a widget may shrink to at this tier. Pure proportional
	 * scaling collapses a `w:2` stat to a single column, which at 6 columns is
	 * ~17% of a ~480px canvas — an 80px tile. The floor is what stops a narrow
	 * grid from producing tiles narrower than the wide one did.
	 */
	minSpan: number
	margin: [number, number]
	/** Only the canonical tier may be edited and persisted. */
	canonical: boolean
}

/**
 * Ordered widest-first. Thresholds are *container* widths, not viewport widths:
 * an open nav sidebar plus page padding costs ~288px, so a 1440px desktop hands
 * the canvas only ~1152px. They're set from what a tile actually measures — at
 * 12 columns and an ~860px canvas the narrowest common widget (a `w:3` stat) is
 * still ~215px, which reads fine; below that it starts truncating.
 */
export const GRID_TIERS: readonly GridTier[] = [
	{ minWidth: 860, cols: CANONICAL_COLS, minSpan: 1, margin: [12, 12], canonical: true },
	{ minWidth: 640, cols: 8, minSpan: 2, margin: [10, 10], canonical: false },
	{ minWidth: 460, cols: 6, minSpan: 3, margin: [8, 8], canonical: false },
	{ minWidth: 0, cols: 1, minSpan: 1, margin: [8, 8], canonical: false },
]

export function tierForWidth(width: number): GridTier {
	return GRID_TIERS.find((tier) => width > tier.minWidth) ?? GRID_TIERS[GRID_TIERS.length - 1]
}

/** Column count for a container width — used by the template live preview. */
export function colsForWidth(width: number): number {
	return tierForWidth(width).cols
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

/**
 * Project the authored 12-column layout onto a narrower tier.
 *
 * Deliberately not react-grid-layout's own `findOrGenerateResponsiveLayout`:
 * that clamps each `w` to the column count and re-runs vertical compaction,
 * which leaves a `w:4` chart at 4 of 6 columns while a `w:2` stat squeezes into
 * the 2-column remainder, and then floats short tiles up into whatever holes
 * the clamping opened. The result reads as scattered rather than as a grid.
 *
 * Instead: scale every width proportionally (with `minSpan` as a floor), pack
 * widgets into rows in reading order, and justify each row so it fills the
 * width exactly. Rows stay rows, order is preserved, and nothing overlaps —
 * which is why the canvas pairs this with `noCompactor` on derived tiers.
 */
export function projectLayout(widgets: DashboardWidget[], tier: GridTier): Layout {
	const base = widgets.map((w) => ({
		i: w.id,
		x: w.layout.x,
		y: w.layout.y,
		w: w.layout.w,
		h: w.layout.h,
		minW: w.layout.minW ?? 2,
		minH: w.layout.minH ?? 2,
		...(w.layout.maxW != null ? { maxW: w.layout.maxW } : undefined),
		...(w.layout.maxH != null ? { maxH: w.layout.maxH } : undefined),
	}))

	if (tier.canonical) return base

	// Reading order: left-to-right within a row, then down.
	const ordered = base.toSorted((a, b) => a.y - b.y || a.x - b.x)

	const projected: LayoutItem[] = []
	let row: Array<{ i: string; w: number; h: number }> = []
	let rowY = 0

	// Grow the row's widgets until the row fills the grid exactly, so no tier
	// ever renders a ragged right edge.
	const flushRow = () => {
		if (row.length === 0) return
		let remainder = tier.cols - row.reduce((sum, item) => sum + item.w, 0)
		for (let index = 0; remainder > 0; index = (index + 1) % row.length) {
			row[index].w += 1
			remainder -= 1
		}

		// Every widget in a row takes the row's height. Left at their authored
		// heights, a short stat beside a tall gauge leaves a dead pocket that the
		// compactor can't fill (it's switched off here precisely so rows hold
		// together), and the result reads as holes rather than as a grid.
		let x = 0
		const rowHeight = Math.max(...row.map((item) => item.h))
		for (const item of row) {
			projected.push({ i: item.i, x, y: rowY, w: item.w, h: rowHeight })
			x += item.w
		}
		rowY += rowHeight
		row = []
	}

	for (const item of ordered) {
		const scaled = clamp(
			Math.round((item.w * tier.cols) / CANONICAL_COLS),
			Math.min(tier.minSpan, tier.cols),
			tier.cols,
		)
		const used = row.reduce((sum, r) => sum + r.w, 0)
		if (used + scaled > tier.cols) flushRow()
		row.push({ i: item.i, w: scaled, h: item.h })
	}
	flushRow()

	// `minW`/`maxW` are expressed in 12-column units and would fight the
	// projection; heights are unchanged, so their constraints carry over.
	return projected
}
