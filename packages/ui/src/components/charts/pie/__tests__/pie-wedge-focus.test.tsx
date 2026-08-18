import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderPieChart } from "../query-builder-pie-chart"

/**
 * The box every element reports, so both the renderer's own sizing and the SVG
 * surface's client→scene mapping resolve.
 *
 * On `Element`, not `HTMLElement`: the renderer measures its container (an HTML
 * div) but converts pointer coordinates through the `<svg>` element, which is an
 * `SVGElement` and would otherwise report jsdom's default 0×0 box and drop every
 * pointer event before it reached a focus strategy. Anchored at the origin with
 * the scene's own dimensions, so a client coordinate IS a scene coordinate.
 */
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

/** The polar layout the 800×400 box resolves to: half the shorter side, less the chart's inset. */
const OUTER_R = 400 / 2 - 8
const CENTER_X = 400
const CENTER_Y = 200

/**
 * The largest radius any wedge was drawn at.
 *
 * The hover affordance is a bigger arc — the focused slice gets its own mark at
 * `HOVER_GROWTH` of the layout radius — so this single number says whether the
 * chart thinks the pointer is on a slice, without reaching into React state.
 */
function largestArcRadius(container: HTMLElement): number {
	const radii = [...container.querySelectorAll("g.ts-chart__arc path")].flatMap((node) =>
		[...(node.getAttribute("d") ?? "").matchAll(/A(\d+(?:\.\d+)?),/g)].map((match) => Number(match[1])),
	)
	return Math.max(...radii)
}

/** Whether any wedge is faded — the `rest` mark's dimming, which is only correct during a real hover. */
function anyWedgeFaded(container: HTMLElement): boolean {
	return [...container.querySelectorAll("g.ts-chart__arc path")].some(
		(node) => node.getAttribute("fill-opacity") !== null,
	)
}

/**
 * Moves the pointer to a SCENE coordinate.
 *
 * A `MouseEvent` rather than `fireEvent.pointerMove`: jsdom has no
 * `PointerEvent`, and the renderer only reads `clientX`/`clientY`, which a mouse
 * event carries. It listens on its container, so dispatching at the surface and
 * letting the event bubble is the same path a real pointer takes.
 */
function movePointerTo(container: HTMLElement, x: number, y: number): void {
	const surface = container.querySelector("svg")
	if (!surface) throw new Error("the chart painted no SVG surface")
	fireEvent(surface, new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }))
}

/** Polar → scene, in `pie()`'s convention: zero at 12 o'clock, growing clockwise. */
function at(angle: number, radius: number): [number, number] {
	return [CENTER_X + Math.sin(angle) * radius, CENTER_Y - Math.cos(angle) * radius]
}

const rows = [
	{ name: "GET /a", value: 50 },
	{ name: "GET /b", value: 30 },
	{ name: "GET /c", value: 20 },
]

/** Twelve equal slices: the worst case for a proximity-scored focus strategy. */
const twelve = Array.from({ length: 12 }, (_, index) => ({ name: `svc-${index}`, value: 10 }))

describe("query-builder pie: the pointer takes focus only over a wedge", () => {
	it("grows the wedge the pointer is actually on", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		expect(largestArcRadius(container)).toBeCloseTo(OUTER_R, 1)

		// A quarter turn from 12 o'clock, mid-ring: squarely inside the first slice,
		// which spans 0 to half a turn.
		movePointerTo(container, ...at(Math.PI / 4, OUTER_R * 0.6))
		expect(largestArcRadius(container)).toBeGreaterThan(OUTER_R + 1)
		// …and the other two are dimmed, which is the affordance's other half.
		expect(anyWedgeFaded(container)).toBe(true)
	})

	it("ignores the donut's hole", () => {
		// `focusGroupAngle` scores by perpendicular distance to a slice's radial ray
		// and accepts anything within 48px of one, so every point in a hole this size
		// resolved to some slice: with twelve slices the worst case inside the hole is
		// `r · sin(15°)`, about 29px here. Sweeping the empty middle grew an arbitrary
		// wedge and opened a tooltip for it.
		const { container } = render(<QueryBuilderPieChart data={twelve} donut legend="hidden" />)
		const hole = OUTER_R * 0.58

		for (const [x, y] of [
			[CENTER_X, CENTER_Y],
			at(Math.PI / 12, hole * 0.9),
			at(Math.PI, hole * 0.5),
			at(Math.PI * 1.5, hole * 0.99),
		] as ReadonlyArray<readonly [number, number]>) {
			movePointerTo(container, x, y)
			expect(largestArcRadius(container)).toBeCloseTo(OUTER_R, 1)
			expect(anyWedgeFaded(container)).toBe(false)
		}
	})

	it("ignores the plot box's corners", () => {
		// The corner-to-circle distance is about 0.41 of the radius on a square plot,
		// which fell inside the old 48px acceptance for any pie under ~117px — and the
		// box here is wider than it is tall, so the left and right thirds are outside
		// the circle entirely.
		const { container } = render(<QueryBuilderPieChart data={twelve} legend="hidden" />)

		for (const [x, y] of [
			[0, 0],
			[799, 0],
			[0, 399],
			[799, 399],
			[CENTER_X + OUTER_R + 20, CENTER_Y],
		] as ReadonlyArray<readonly [number, number]>) {
			movePointerTo(container, x, y)
			expect(largestArcRadius(container)).toBeCloseTo(OUTER_R, 1)
			expect(anyWedgeFaded(container)).toBe(false)
		}
	})

	it("releases the hover when the pointer leaves the ring", () => {
		// The symptom this pins is the one that was visible without moving anything:
		// focus that never let go left the `rest` mark dimmed for as long as the
		// pointer was anywhere over the card.
		const { container } = render(<QueryBuilderPieChart data={rows} donut legend="hidden" />)

		movePointerTo(container, ...at(Math.PI / 4, OUTER_R * 0.8))
		expect(anyWedgeFaded(container)).toBe(true)

		movePointerTo(container, CENTER_X, CENTER_Y)
		expect(anyWedgeFaded(container)).toBe(false)
	})

	it("keeps a pie's own centre hoverable", () => {
		// A pie has no hole, so the containment test must not borrow the donut's
		// inner radius: the apex of every slice is still a slice.
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		movePointerTo(container, CENTER_X, CENTER_Y + 2)
		expect(largestArcRadius(container)).toBeGreaterThan(OUTER_R + 1)
	})

	it("keeps the grown wedge's own rim hoverable", () => {
		// The focused arc is drawn past the layout radius, so the outer bound has to
		// cover the growth or the wedge would shed the focus that grew it.
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		movePointerTo(container, ...at(Math.PI / 4, OUTER_R - 1))
		const grown = largestArcRadius(container)
		expect(grown).toBeGreaterThan(OUTER_R + 1)

		movePointerTo(container, ...at(Math.PI / 4, grown - 0.5))
		expect(largestArcRadius(container)).toBeCloseTo(grown, 1)
	})
})

describe("query-builder pie: the chip strip is centred and capped", () => {
	it("centres the chips under the pie and clips past two rows", () => {
		const { container } = render(<QueryBuilderPieChart data={twelve} legend="visible" />)
		// `div`, not a bare attribute selector: the chart surface carries the same
		// aria-label and is the earlier match.
		const strip = container.querySelector("div[aria-label='Share by category']")
		if (!(strip instanceof HTMLElement)) throw new Error("expected the chip strip")

		// Left-aligned chips under a centred pie read as a misalignment…
		expect(strip.className).toContain("justify-center")
		// …and an uncapped strip takes `PlotFrame`'s whole 45% legend allowance,
		// shrinking the pie by more than half on a short card.
		expect(strip.className).toContain("max-h-[50px]")
		expect(strip.className).toContain("overflow-hidden")
	})

	it("floors the plot so a short card overflows rather than drawing nothing", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="visible" />)
		const host = container.querySelector("[data-chart-host]")
		if (!(host instanceof HTMLElement)) throw new Error("expected the plot frame's host")
		expect(host.className).toContain("min-h-12")
	})
})
