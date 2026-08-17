import { describe, expect, it } from "vitest"
import type { ShareOgCardTile } from "@maple/domain/http"
import { CARD_HEIGHT, CARD_WIDTH, ogCardNode } from "./card"

/** Walks the node tree, since takumi nodes are plain nested objects. */
const flatten = (node: unknown): Array<Record<string, unknown>> => {
	if (typeof node !== "object" || node === null) return []
	const record = node as Record<string, unknown>
	const children = Array.isArray(record.children) ? record.children : []
	return [record, ...children.flatMap(flatten)]
}

const texts = (node: unknown): Array<string> =>
	flatten(node)
		.filter((child) => child.type === "text")
		.map((child) => String(child.text))

const fontSizeOf = (node: unknown, label: string): number | undefined => {
	const match = flatten(node).find((child) => child.type === "text" && child.text === label)
	return (match?.style as Record<string, number> | undefined)?.fontSize
}

const tile = (title: string, section?: string): ShareOgCardTile => {
	const base = { x: 0, y: 0, w: 6, h: 4, title, visualization: "chart" }
	return section === undefined ? base : { ...base, section }
}

const tiles = (count: number, section?: string): Array<ShareOgCardTile> =>
	Array.from({ length: count }, (_, index) => tile(`Widget ${index + 1}`, section))

describe("ogCardNode", () => {
	it("renders at the advertised card size", () => {
		const node = ogCardNode({ title: "Checkout health", tiles: [] })

		expect(node).toMatchObject({ style: { width: CARD_WIDTH, height: CARD_HEIGHT } })
	})

	it("leads with the board's name, its author's description and its widget names", () => {
		const node = ogCardNode({
			title: "Checkout health",
			description: "Latency, traffic and errors for the checkout path.",
			widgetCount: 2,
			tiles: [tile("Requests"), tile("Error rate")],
		})

		expect(texts(node)).toEqual(
			expect.arrayContaining([
				"MAPLE",
				"Checkout health",
				"Latency, traffic and errors for the checkout path.",
				"Requests",
				"Error rate",
			]),
		)
	})

	it("names the org that published the link, with its own logo", () => {
		const node = ogCardNode({
			title: "Board",
			org: { name: "Acme Rockets", imageUrl: "https://img.example/acme.png" },
			tiles: [],
		})
		const images = flatten(node).filter((child) => child.type === "image")

		expect(texts(node)).toContain("Acme Rockets")
		expect(images.map((child) => String(child.src))).toContain("https://img.example/acme.png")
	})

	it("falls back to the org's initial when it has no logo of its own", () => {
		const node = ogCardNode({ title: "Board", org: { name: "acme rockets" }, tiles: [] })

		expect(texts(node)).toContain("A")
		// Only the Maple mark is left as artwork.
		expect(flatten(node).filter((child) => child.type === "image")).toHaveLength(1)
	})

	it("carries no byline at all when there is no directory to ask", () => {
		const node = ogCardNode({ title: "Board", tiles: [] })

		expect(texts(node)).toEqual(["MAPLE", "Board", "No widgets yet"])
	})

	it("groups widgets under the section headings their board gave them", () => {
		const node = ogCardNode({
			title: "Board",
			widgetCount: 3,
			tiles: [
				tile("Availability", "Service level"),
				tile("Deploys", "Context"),
				tile("Top errors", "Context"),
			],
		})

		// Upper-cased here rather than in the data: the heading is a label in this
		// design, and the board stores it as its author typed it.
		expect(texts(node)).toEqual(
			expect.arrayContaining(["SERVICE LEVEL", "Availability", "CONTEXT", "Deploys", "Top errors"]),
		)
	})

	it("counts the widgets it could not name rather than dropping them silently", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 20, tiles: tiles(10) })

		expect(texts(node).some((value) => value.startsWith("+"))).toBe(true)
		expect(texts(node)).toContain("+13 more")
	})

	it("never runs the list past the bottom of the card", () => {
		// Eight rows is the budget the layout is built around; a board with more
		// widgets than that has to lose rows, not overflow.
		const node = ogCardNode({ title: "Board", widgetCount: 30, tiles: tiles(20) })
		const named = texts(node).filter((value) => value.startsWith("Widget "))

		expect(named.length).toBeLessThanOrEqual(8)
	})

	it("shrinks the headline as the name grows, so it always clears the list", () => {
		const short = ogCardNode({ title: "Checkout", tiles: [] })
		const long = ogCardNode({
			title: "Production reliability review for checkout and payments",
			tiles: [],
		})

		expect(fontSizeOf(short, "Checkout")).toBeGreaterThan(
			fontSizeOf(long, "Production reliability review for checkout and payments") ?? 0,
		)
	})

	it("keeps a short list in one column", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 3, tiles: tiles(3) })
		const columns = flatten(node).filter(
			(child) => (child.style as Record<string, unknown> | undefined)?.width === "50%",
		)

		expect(columns).toHaveLength(1)
	})

	it("balances a long list across two columns instead of stranding one name", () => {
		const node = ogCardNode({ title: "Board", widgetCount: 6, tiles: tiles(6) })
		const columns = flatten(node).filter(
			(child) => (child.style as Record<string, unknown> | undefined)?.width === "50%",
		)

		expect(columns).toHaveLength(2)
		expect(columns.map((column) => (column.children as Array<unknown>).length)).toEqual([3, 3])
	})

	it("draws an empty board as an empty state rather than a blank panel", () => {
		const node = ogCardNode({ title: "Fresh board", tiles: [] })

		expect(texts(node)).toContain("No widgets yet")
	})

	it("carries the Maple mark as artwork, not as a coloured dot", () => {
		const node = ogCardNode({ title: "Board", tiles: [] })
		const mark = flatten(node).find((child) => child.type === "image")

		// evenodd is what keeps the knockouts open; without it the glyph fills solid.
		expect(String(mark?.src)).toContain("data:image/svg+xml;base64,")
		expect(atob(String(mark?.src).split(",")[1] ?? "")).toContain('fill-rule="evenodd"')
	})

	it("is deterministic, so the same board renders the same bytes every time", () => {
		const input = { title: "Board", widgetCount: 2, tiles: [tile("Requests"), tile("Errors")] }

		expect(JSON.stringify(ogCardNode(input))).toBe(JSON.stringify(ogCardNode(input)))
	})
})
