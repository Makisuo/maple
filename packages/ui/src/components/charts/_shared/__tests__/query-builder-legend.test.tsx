import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { QueryBuilderLegend } from "../query-builder-legend"

afterEach(cleanup)

const series = [
	{ key: "s1", label: "api", color: "#22d3ee" },
	{ key: "s2", label: "web", color: "#f87171" },
	{ key: "s3", label: "idle", color: "#a3a3a3" },
]

const stats = {
	s1: { min: 1, max: 9, mean: 4.5, last: 7 },
	s2: { min: 0.5, max: 2, mean: 1.1, last: 2 },
	// All zero: the row collapses its four columns to one muted 0.
	s3: { min: 0, max: 0, mean: 0, last: 0 },
}

function setup(props: Partial<Parameters<typeof QueryBuilderLegend>[0]> = {}) {
	const onToggle = vi.fn()
	const view = render(
		<QueryBuilderLegend
			series={series}
			stats={stats}
			hidden={new Set()}
			onToggle={onToggle}
			{...props}
		/>,
	)
	return { ...view, onToggle }
}

/**
 * The legend's state now arrives through `PlotLegend.Provider` rather than from
 * its own props closure, so these cover the wiring the markup itself cannot: a
 * click has to reach the chart's `toggle`, and the hidden set has to reach the
 * rows.
 */
describe("QueryBuilderLegend", () => {
	it("routes a stats-row click to the chart's toggle", () => {
		const { container, onToggle } = setup()
		const rows = container.querySelectorAll("tbody tr")
		;(rows[1] as HTMLElement).click()
		expect(onToggle).toHaveBeenCalledWith("s2")
	})

	it("routes a compact-strip click to the chart's toggle", () => {
		const { container, onToggle } = setup({ variant: "compact" })
		;(container.querySelectorAll("button")[2] as HTMLElement).click()
		expect(onToggle).toHaveBeenCalledWith("s3")
	})

	it("dims the hidden series in both variants", () => {
		const hidden = new Set(["s2"])
		const stats0 = setup({ hidden })
		expect([...stats0.container.querySelectorAll("tbody tr")].map((r) => r.className)).toEqual([
			expect.not.stringContaining("opacity-40"),
			expect.stringContaining("opacity-40"),
			expect.not.stringContaining("opacity-40"),
		])
		cleanup()
		const compact = setup({ hidden, variant: "compact" })
		expect([...compact.container.querySelectorAll("button")].map((b) => b.className)).toEqual([
			expect.not.stringContaining("opacity-40"),
			expect.stringContaining("opacity-40"),
			expect.not.stringContaining("opacity-40"),
		])
	})

	it("collapses an all-zero row to a single muted zero", () => {
		// Four zeros in a row read as noise, so the table spans them.
		const { container } = setup()
		const cells = container.querySelectorAll("tbody tr:last-child td")
		expect(cells).toHaveLength(2)
		expect(cells[1]?.getAttribute("colspan")).toBe("4")
		expect(cells[1]?.textContent).toBe("0")
	})

	it("renders nothing without series", () => {
		const { container } = render(
			<QueryBuilderLegend series={[]} stats={{}} hidden={new Set()} onToggle={() => {}} />,
		)
		expect(container.innerHTML).toBe("")
	})
})
