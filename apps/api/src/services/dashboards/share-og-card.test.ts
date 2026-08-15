import { describe, expect, it } from "vitest"
import type { RedactedDashboard } from "@maple/widgets/dashboard"
import { ogDescription, ogSubtitle, ogTiles, ogTitle } from "./share-og-card"

const widget = (id: string, overrides: Partial<RedactedDashboard["widgets"][number]> = {}) => ({
	id,
	visualization: "chart",
	display: { title: `Widget ${id}` },
	layout: { x: 0, y: 0, w: 6, h: 4 },
	dataSource: { kind: "query" as const },
	...overrides,
})

const dashboard = (overrides: Partial<RedactedDashboard> = {}): RedactedDashboard => ({
	id: "dash_1",
	name: "Checkout health",
	timeRange: { from: "now-12h", to: "now" },
	widgets: [widget("w1"), widget("w2")],
	...overrides,
})

describe("ogTitle", () => {
	it("uses the board name for a board share", () => {
		expect(ogTitle(dashboard(), undefined)).toBe("Checkout health")
	})

	it("leads with the chart's own title for a widget share", () => {
		expect(ogTitle(dashboard(), "w2")).toBe("Widget w2")
	})

	it("falls back to the board name when the widget has no title", () => {
		const board = dashboard({ widgets: [widget("w1", { display: {} })] })

		expect(ogTitle(board, "w1")).toBe("Checkout health")
	})

	it("names an untitled board rather than rendering an empty card", () => {
		expect(ogTitle(dashboard({ name: "   " }), undefined)).toBe("Untitled dashboard")
	})

	it("truncates a very long name", () => {
		const title = ogTitle(dashboard({ name: "x".repeat(400) }), undefined)

		expect(title.length).toBe(120)
		expect(title.endsWith("…")).toBe(true)
	})
})

describe("ogSubtitle", () => {
	it("prefers the description its author wrote", () => {
		const board = dashboard({ description: "Latency and errors for the checkout path." })

		expect(ogSubtitle(board, undefined)).toBe("Latency and errors for the checkout path.")
	})

	it("counts widgets when the board has no description", () => {
		expect(ogSubtitle(dashboard(), undefined)).toBe("Shared dashboard · 2 widgets")
	})

	it("counts sections when the board has them", () => {
		const board = dashboard({ sections: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] })

		expect(ogSubtitle(board, undefined)).toBe("Shared dashboard · 2 widgets · 3 sections")
	})

	it("singularises", () => {
		const board = dashboard({ widgets: [widget("w1")], sections: [{ id: "s1" }] })

		expect(ogSubtitle(board, undefined)).toBe("Shared dashboard · 1 widget · 1 section")
	})

	it("gives a widget share its board as context", () => {
		expect(ogSubtitle(dashboard(), "w1")).toBe("A shared chart from Checkout health")
	})
})

describe("ogTiles", () => {
	it("keeps the board's own grid coordinates", () => {
		const board = dashboard({
			widgets: [widget("w1", { layout: { x: 3, y: 2, w: 6, h: 4 }, visualization: "hbar" })],
		})

		expect(ogTiles(board)).toEqual([
			{ x: 3, y: 2, w: 6, h: 4, title: "Widget w1", visualization: "hbar" },
		])
	})

	it("omits a missing title rather than inventing one", () => {
		const board = dashboard({ widgets: [widget("w1", { display: { title: "  " } })] })

		expect(ogTiles(board)[0]).not.toHaveProperty("title")
	})

	it("skips widgets whose layout is not a drawable rectangle", () => {
		const board = dashboard({
			widgets: [
				widget("w1", { layout: undefined }),
				widget("w2", { layout: { x: 0, y: 0, w: 0, h: 4 } }),
				widget("w3", { layout: { x: "1", y: 0, w: 4, h: 4 } }),
				widget("w4"),
			],
		})

		expect(ogTiles(board).map((tile) => tile.title)).toEqual(["Widget w4"])
	})

	it("stacks sections instead of drawing them on top of each other", () => {
		// Every section restarts at y=0 in the stored document, so the second
		// section's rows have to be pushed past the first one's.
		const board = dashboard({
			widgets: [
				widget("w1", { sectionId: "s1", tabId: "t1", layout: { x: 0, y: 0, w: 12, h: 2 } }),
				widget("w2", { sectionId: "s2", tabId: "t1", layout: { x: 0, y: 0, w: 6, h: 4 } }),
				widget("w3", { sectionId: "s2", tabId: "t1", layout: { x: 6, y: 0, w: 6, h: 4 } }),
			],
		})

		expect(ogTiles(board).map((t) => ({ x: t.x, y: t.y }))).toEqual([
			{ x: 0, y: 0 },
			{ x: 0, y: 2 },
			{ x: 6, y: 2 },
		])
	})

	it("draws only the tab a viewer opens the section on", () => {
		const board = dashboard({
			widgets: [
				widget("w1", { sectionId: "s1", tabId: "t1" }),
				widget("w2", { sectionId: "s1", tabId: "t2", display: { title: "Hidden tab" } }),
			],
		})

		expect(ogTiles(board).map((t) => t.title)).toEqual(["Widget w1"])
	})

	it("stops at the first screen of a very tall board", () => {
		const board = dashboard({
			widgets: Array.from({ length: 10 }, (_, index) =>
				widget(`w${index}`, { sectionId: `s${index}`, layout: { x: 0, y: 0, w: 12, h: 4 } }),
			),
		})

		// 14 rows of budget, four rows per section.
		expect(ogTiles(board)).toHaveLength(4)
	})

	it("caps how many tiles a large board contributes", () => {
		const board = dashboard({
			widgets: Array.from({ length: 40 }, (_, index) =>
				widget(`w${index}`, { layout: { x: (index % 4) * 3, y: 0, w: 3, h: 1 } }),
			),
		})

		expect(ogTiles(board)).toHaveLength(10)
	})
})

describe("ogDescription", () => {
	it("passes the author's description through", () => {
		const board = dashboard({ description: "  Latency and errors.  " })

		expect(ogDescription(board, undefined)).toBe("Latency and errors.")
	})

	it("gives a widget share its board as context", () => {
		expect(ogDescription(dashboard(), "w1")).toBe("From Checkout health")
	})

	it("has nothing to say when the board says nothing", () => {
		expect(ogDescription(dashboard(), undefined)).toBeUndefined()
		expect(ogDescription(dashboard({ description: "   " }), undefined)).toBeUndefined()
	})
})
