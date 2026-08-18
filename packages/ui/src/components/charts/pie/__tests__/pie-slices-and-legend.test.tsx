import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { MAX_CATEGORICAL, OTHER_LABEL } from "../../_shared/bucket-series"
import { QueryBuilderPieChart } from "../query-builder-pie-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to measure; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the wedges
// inspectable as real arc paths.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
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

/**
 * The outer radius the frame resolves for the fixed 800×400 box above: the
 * polar layout takes half the shorter side and subtracts the chart's inset.
 * Every hole assertion below is expressed against it, because the hole is
 * defined as a fraction of it rather than as a pixel constant.
 */
const OUTER_R = 400 / 2 - 8

/** The painted wedges: arc paths, excluding the label group's text nodes. */
function arcPaths(container: HTMLElement): string[] {
	return [...container.querySelectorAll("g.ts-chart__arc path")].map((node) => node.getAttribute("d") ?? "")
}

/** Every in-slice label, in draw order. */
function sliceLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("g.ts-chart__radial-text text")].map(
		(node) => node.textContent ?? "",
	)
}

/**
 * The hole radius a donut wedge was drawn with.
 *
 * A d3 arc emits the inner boundary as its own `A r,r` command, so the SMALLEST
 * radius named in the path is the hole. A full pie names only the outer radius,
 * which is how the two are told apart without measuring pixels.
 */
function radiiIn(path: string): number[] {
	return [...path.matchAll(/A(\d+(?:\.\d+)?),/g)].map((match) => Number(match[1]))
}

/** Narrows a query result without a cast, so a missing node fails loudly. */
function asHtml(node: Element | null | undefined): HTMLElement {
	if (!(node instanceof HTMLElement)) throw new Error("expected an HTMLElement, got none")
	return node
}

const rows = [
	{ name: "GET /a", value: 50 },
	{ name: "GET /b", value: 30 },
	{ name: "GET /c", value: 20 },
]

describe("query-builder pie: wedges", () => {
	it("draws one wedge per category", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		expect(arcPaths(container)).toHaveLength(3)
	})

	it("collapses the long tail into a single Other wedge", () => {
		// Six over the cap: the top `MAX_CATEGORICAL - 1` survive and the
		// remaining seven roll into one bucket, so the chart still draws exactly
		// `MAX_CATEGORICAL` wedges.
		const many = Array.from({ length: MAX_CATEGORICAL + 6 }, (_, index) => ({
			name: `svc-${index}`,
			value: 100 - index,
		}))
		const { container } = render(<QueryBuilderPieChart data={many} legend="right" />)
		expect(arcPaths(container)).toHaveLength(MAX_CATEGORICAL)
		const text = container.textContent ?? ""
		expect(text).toContain(OTHER_LABEL)
		// The collapsed count rides on the legend row, so the reader can tell how
		// much the bucket is hiding rather than assuming the chart is everything.
		expect(text).toContain(`${OTHER_LABEL} +7`)
		expect(text).not.toContain("svc-17")
	})

	it("drops rows that cannot be drawn as a wedge", () => {
		const { container } = render(
			<QueryBuilderPieChart
				data={[...rows, { name: "zero", value: 0 }, { name: "negative", value: -5 }]}
				legend="hidden"
			/>,
		)
		// A zero or negative row paints an invisible arc but would still take a
		// legend row.
		expect(arcPaths(container)).toHaveLength(3)
	})
})

describe("query-builder pie: donut vs pie", () => {
	it("a pie has no hole and no centre total", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		for (const path of arcPaths(container)) {
			expect(Math.min(...radiiIn(path))).toBeCloseTo(OUTER_R, 1)
		}
		expect(container.textContent ?? "").not.toContain("total")
	})

	it("a donut opens a hole at 58% of the radius and prints the total in it", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} donut legend="hidden" />)
		for (const path of arcPaths(container)) {
			expect(Math.min(...radiiIn(path))).toBeCloseTo(OUTER_R * 0.58, 1)
		}
		// 50 + 30 + 20, exact rather than compact — the centre total only goes
		// compact above 10k.
		expect(container.textContent ?? "").toContain("100")
		expect(container.textContent ?? "").toContain("total")
	})

	it("clamps an oversized innerRadius so the ring survives", () => {
		const { container } = render(
			<QueryBuilderPieChart data={rows} donut innerRadius={9999} legend="hidden" />,
		)
		for (const path of arcPaths(container)) {
			expect(Math.min(...radiiIn(path))).toBeCloseTo(OUTER_R - 6, 1)
		}
	})

	it("clamps a collapsed innerRadius so the hole survives", () => {
		const { container } = render(
			<QueryBuilderPieChart data={rows} donut innerRadius={0} legend="hidden" />,
		)
		for (const path of arcPaths(container)) {
			expect(Math.min(...radiiIn(path))).toBeCloseTo(8, 1)
		}
		// 8px of hole is below the floor the centre total needs, so it stays off
		// rather than spilling over the ring.
		expect(container.textContent ?? "").not.toContain("total")
	})
})

describe("query-builder pie: in-slice labels", () => {
	it("draws none unless asked", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		expect(sliceLabels(container)).toHaveLength(0)
	})

	it("labels each wedge with its share", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} showLabels legend="hidden" />)
		expect(sliceLabels(container)).toEqual(["50%", "30%", "20%"])
	})

	it("labels values instead when the percent mode is off", () => {
		const { container } = render(
			<QueryBuilderPieChart data={rows} showLabels showPercent={false} legend="hidden" />,
		)
		expect(sliceLabels(container)).toEqual(["50", "30", "20"])
	})

	it("leaves a wedge too narrow to host text unlabelled", () => {
		// 3 of 103 is under the 6% floor: the wedge is still drawn, but a label in
		// it would overflow onto its neighbours.
		const { container } = render(
			<QueryBuilderPieChart
				data={[...rows, { name: "sliver", value: 3 }]}
				showLabels
				legend="hidden"
			/>,
		)
		expect(arcPaths(container)).toHaveLength(4)
		expect(sliceLabels(container)).toHaveLength(3)
	})
})

describe("query-builder pie: legend", () => {
	it("renders none when it is hidden", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="hidden" />)
		expect(container.querySelectorAll("button")).toHaveLength(0)
	})

	it("gives the side legend a value and a share per row", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} legend="right" unit="count" />)
		const labels = [...container.querySelectorAll("button")].map((node) => node.textContent ?? "")
		expect(labels).toHaveLength(3)
		expect(labels[0]).toContain("GET /a")
		expect(labels[0]).toContain("50%")
	})

	it("keeps the bottom chips figure-free", () => {
		// The chip strip is a colour key, not a table: the numbers live in the
		// tooltip and in the side legend.
		const { container } = render(<QueryBuilderPieChart data={rows} legend="visible" />)
		const labels = [...container.querySelectorAll("button")].map((node) => node.textContent ?? "")
		expect(labels).toEqual(["GET /a", "GET /b", "GET /c"])
	})
})

describe("query-builder pie: the donut centre is not a hover target", () => {
	it("prints the total in the frame's overlay, centred on the plot rect", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} donut legend="hidden" />)

		const overlay = container.querySelector("[data-chart-overlay]")
		expect(overlay).not.toBeNull()

		const total = asHtml(overlay?.firstElementChild)
		expect(total.textContent).toBe("100total")

		// The plot rect published by the frame IS the whole 800x400 box: a polar
		// chart declares no axes, so the scene reserves no gutter and the centre
		// lands at the box's middle. The centre total is placed off that rect
		// rather than off the layer's own edges, so this pins both at once.
		expect(total.style.left).toBe("400px")
		expect(total.style.top).toBe("200px")
	})

	it("leaves the hole pointer-transparent, with no mark inside it", () => {
		const { container } = render(<QueryBuilderPieChart data={rows} donut showLabels legend="hidden" />)

		// The whole reason the total is DOM: a `radialText` at radius zero would
		// push a focus point into the middle of the hole, and `focusGroupAngle`
		// would resolve it to a slice the pointer is nowhere near. Only the three
		// in-slice labels exist, and each rides the ring.
		expect(sliceLabels(container)).toEqual(["50%", "30%", "20%"])

		// The layer never takes the pointer, and nothing inside it opts back in.
		const overlay = asHtml(container.querySelector("[data-chart-overlay]"))
		expect(overlay.className).toContain("pointer-events-none")
		expect(overlay.querySelectorAll("[class*='pointer-events-auto']")).toHaveLength(0)

		// And the hole itself is empty of painted geometry: every wedge starts at
		// the inner boundary, so nothing is drawn between the centre and it.
		for (const path of arcPaths(container)) {
			expect(Math.min(...radiiIn(path))).toBeCloseTo(OUTER_R * 0.58, 1)
		}
	})
})
