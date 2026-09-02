import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { PlotFrame } from "../plot-frame"

// jsdom lays nothing out, so nothing here can prove the legend ENDS UP beside
// the plot — that was measured in a browser. What it can prove is which of the
// two arms rendered, and that each carries the classes the layout depends on:
// the row wrapper, the `min-w-0` that stops the plot ratcheting, and the caps.
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

const rows = [
	{ x: 0, y: 1 },
	{ x: 1, y: 4 },
	{ x: 2, y: 2 },
]

const definition = defineChart({
	marks: [lineY(rows, { x: (row: { x: number }) => row.x, y: (row: { y: number }) => row.y })],
	scales: {
		x: { scale: scaleLinear() },
		y: { scale: scaleLinear() },
	},
})

function frame(props: { legendPlacement?: "bottom" | "right"; legend?: boolean; footer?: boolean }) {
	return render(
		<PlotFrame
			definition={definition}
			ariaLabel="Demo"
			legend={props.legend === false ? undefined : <div data-testid="legend">key</div>}
			legendPlacement={props.legendPlacement}
			footer={props.footer ? <div data-testid="footer">note</div> : undefined}
		/>,
	)
}

/** The element the legend node was placed in — the frame's slot, not the node. */
function legendSlot(container: HTMLElement): HTMLElement {
	const node = container.querySelector("[data-testid='legend']")?.parentElement
	if (!(node instanceof HTMLElement)) throw new Error("expected the legend slot")
	return node
}

function plotBox(container: HTMLElement): HTMLElement {
	const anchor = container.querySelector("[data-chart-plot]")?.parentElement
	if (!(anchor instanceof HTMLElement)) throw new Error("expected the measured plot box")
	return anchor
}

describe("PlotFrame legend placement", () => {
	it("stacks the legend below the plot by default", () => {
		const { container } = frame({})

		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
		// The height cap that keeps a long series list from starving the plot.
		expect(legendSlot(container).className).toContain("max-h-[45%]")
		// The bottom arm's markup is unchanged, so the plot box takes no
		// cross-axis minimum it did not have before.
		expect(plotBox(container).className).not.toContain("min-w-0")
	})

	it("keeps the default when a caller asks for it explicitly", () => {
		const { container } = frame({ legendPlacement: "bottom" })
		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
		expect(legendSlot(container).className).toContain("max-h-[45%]")
	})

	it("puts the legend beside the plot on the right", () => {
		const { container } = frame({ legendPlacement: "right" })

		const row = container.querySelector("[data-chart-legend-row]")
		if (!(row instanceof HTMLElement)) throw new Error("expected the row wrapper")
		expect(row.className).toContain("flex-row")

		// The legend is a SIBLING of the measured plot box inside that row, which
		// is what makes it sit beside the plot rather than under it.
		expect(legendSlot(container).parentElement).toBe(row)
		expect(plotBox(container).parentElement).toBe(row)

		// Width, not height, is the axis this layout spends.
		expect(legendSlot(container).className).toContain("max-w-[45%]")
		expect(legendSlot(container).className).not.toContain("max-h-[45%]")
	})

	it("lets the plot shrink below its last measured width beside a legend", () => {
		const { container } = frame({ legendPlacement: "right" })
		// Without this the flex item's `min-width: auto` pins the plot at its
		// content width and the legend is pushed out of the card.
		expect(plotBox(container).className).toContain("min-w-0")
	})

	it("ignores the placement when there is no legend to place", () => {
		const { container } = frame({ legendPlacement: "right", legend: false })
		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
	})

	it("keeps the footer under the whole figure, not beside the legend", () => {
		const { container } = frame({ legendPlacement: "right", footer: true })
		const row = container.querySelector("[data-chart-legend-row]")
		const footer = container.querySelector("[data-testid='footer']")?.parentElement
		expect(footer?.parentElement).toBe(container.querySelector("[data-chart-host]"))
		expect(footer?.parentElement).not.toBe(row)
	})
})
