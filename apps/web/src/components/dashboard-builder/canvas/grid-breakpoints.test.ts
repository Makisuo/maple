import { describe, expect, it } from "vitest"

import {
	CANONICAL_COLS,
	GRID_TIERS,
	projectLayout,
	tierForWidth,
	type PlacedWidget,
} from "@/components/dashboard-builder/canvas/grid-breakpoints"

// No cast: placement reads `id` and `layout`, and nothing else. That is the
// whole reason a redacted share widget can go through the same projection as a
// stored one.
function widget(id: string, x: number, y: number, w: number, h: number): PlacedWidget {
	return { id, layout: { x, y, w, h } }
}

/** A realistic authored dashboard: a row of stats over charts over a wide table. */
const AUTHORED = [
	widget("stat-a", 0, 0, 3, 4),
	widget("stat-b", 3, 0, 3, 4),
	widget("stat-c", 6, 0, 3, 4),
	widget("stat-d", 9, 0, 3, 4),
	widget("chart-a", 0, 4, 6, 6),
	widget("chart-b", 6, 4, 6, 6),
	widget("table", 0, 10, 12, 5),
]

const derivedTiers = GRID_TIERS.filter((tier) => !tier.canonical)

describe("tierForWidth", () => {
	it("returns the canonical tier on a desktop canvas", () => {
		expect(tierForWidth(1152).canonical).toBe(true)
		expect(tierForWidth(1152).cols).toBe(CANONICAL_COLS)
	})

	it("steps down as the canvas narrows, and never falls off the end", () => {
		expect(tierForWidth(736).cols).toBe(8)
		expect(tierForWidth(480).cols).toBe(6)
		expect(tierForWidth(343).cols).toBe(1)
		expect(tierForWidth(0).cols).toBe(1)
	})
})

describe("projectLayout", () => {
	it("passes the authored layout through untouched at the canonical tier", () => {
		const projected = projectLayout(AUTHORED, GRID_TIERS[0])
		expect(projected.map((l) => [l.i, l.x, l.y, l.w, l.h])).toEqual(
			AUTHORED.map((w) => [w.id, w.layout.x, w.layout.y, w.layout.w, w.layout.h]),
		)
	})

	// A plain loop rather than `describe.each`: its overload resolution is heavy
	// enough to push `tsc --noEmit` over its heap limit on this project.
	for (const tier of derivedTiers) {
		describe(`at ${tier.cols} columns`, () => {
			const projected = projectLayout(AUTHORED, tier)

			it("keeps every widget exactly once", () => {
				expect(projected.map((l) => l.i).toSorted()).toEqual(AUTHORED.map((w) => w.id).toSorted())
			})

			it("keeps every widget inside the grid", () => {
				for (const item of projected) {
					expect(item.x).toBeGreaterThanOrEqual(0)
					expect(item.w).toBeGreaterThanOrEqual(1)
					expect(item.x + item.w).toBeLessThanOrEqual(tier.cols)
				}
			})

			it("fills each row edge to edge, with no gaps or overlaps", () => {
				const rows = new Map<number, typeof projected>()
				for (const item of projected) {
					rows.set(item.y, [...(rows.get(item.y) ?? []), item])
				}
				for (const row of rows.values()) {
					const ordered = row.toSorted((a, b) => a.x - b.x)
					let cursor = 0
					for (const item of ordered) {
						// Abutting exactly proves no overlap and no gap in one check.
						expect(item.x).toBe(cursor)
						cursor += item.w
					}
					expect(cursor).toBe(tier.cols)
				}
			})

			it("preserves reading order", () => {
				const authoredOrder = AUTHORED.map((w) => w.id)
				const projectedOrder = projected.toSorted((a, b) => a.y - b.y || a.x - b.x).map((l) => l.i)
				expect(projectedOrder).toEqual(authoredOrder)
			})

			it("starts each row below the tallest widget of the row above", () => {
				const rowTops = [...new Set(projected.map((l) => l.y))].toSorted((a, b) => a - b)
				for (const [index, top] of rowTops.entries()) {
					const next = rowTops[index + 1]
					if (next === undefined) continue
					const tallest = Math.max(...projected.filter((l) => l.y === top).map((l) => l.h))
					expect(next).toBeGreaterThanOrEqual(top + tallest)
				}
			})

			it("gives every widget in a row the same height, so rows have no holes", () => {
				const rows = new Map<number, number[]>()
				for (const item of projected) {
					rows.set(item.y, [...(rows.get(item.y) ?? []), item.h])
				}
				for (const heights of rows.values()) {
					expect(new Set(heights).size).toBe(1)
				}
			})

			it("never shrinks a widget below its authored height", () => {
				for (const item of projected) {
					const source = AUTHORED.find((w) => w.id === item.i)
					expect(item.h).toBeGreaterThanOrEqual(source?.layout.h ?? 0)
				}
			})
		})
	}

	it("stacks every widget full width in a single column", () => {
		const single = GRID_TIERS.find((tier) => tier.cols === 1)
		if (!single) throw new Error("expected a single-column tier")
		const projected = projectLayout(AUTHORED, single)
		expect(projected.every((l) => l.x === 0 && l.w === 1)).toBe(true)
		expect(new Set(projected.map((l) => l.y)).size).toBe(AUTHORED.length)
	})

	it("honours the per-tier minimum span so narrow tiles never get narrower", () => {
		const sixCol = GRID_TIERS.find((tier) => tier.cols === 6)
		if (!sixCol) throw new Error("expected a six-column tier")
		// Four w:2 stats would each scale to a single column (~17%) without the floor.
		const stats = [
			widget("a", 0, 0, 2, 4),
			widget("b", 2, 0, 2, 4),
			widget("c", 4, 0, 2, 4),
			widget("d", 6, 0, 2, 4),
		]
		const projected = projectLayout(stats, sixCol)
		expect(projected.every((l) => l.w >= sixCol.minSpan)).toBe(true)
	})

	it("returns an empty layout for a dashboard with no widgets", () => {
		expect(projectLayout([], GRID_TIERS[2])).toEqual([])
	})
})

describe("PlacedWidget", () => {
	// Guards the seam rather than the maths: re-widening the parameter back to a
	// full `DashboardWidget` would break every read-only surface, and it would
	// break here first.
	it("projects a widget carrying nothing but an id and a layout", () => {
		const redactedWidgets = [
			{ id: "a", layout: { x: 0, y: 0, w: 6, h: 4 } },
			{ id: "b", layout: { x: 6, y: 0, w: 6, h: 4 } },
		]

		expect(projectLayout(redactedWidgets, GRID_TIERS[0])).toMatchObject([
			{ i: "a", x: 0, y: 0, w: 6, h: 4 },
			{ i: "b", x: 6, y: 0, w: 6, h: 4 },
		])
	})
})
