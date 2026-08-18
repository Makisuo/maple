import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderLineChart } from "../../charts/line/query-builder-line-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the grid
// inspectable as real nodes.
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

function hourlyRows() {
	const hour = 3_600_000
	const start = Math.floor(Date.now() / hour) * hour - 12 * hour
	return Array.from({ length: 12 }, (_, index) => ({
		bucket: new Date(start + index * hour).toISOString(),
		"demo-api": 900 + Math.round(180 * Math.sin(index / 2)),
	}))
}

describe("plot grid", () => {
	it("dashes the horizontal grid, as the Recharts CartesianGrid did", () => {
		const { container } = render(<QueryBuilderLineChart data={hourlyRows()} />)

		const grid = container.querySelector(".ts-chart__grid")
		expect(grid).not.toBeNull()
		// The dash is a GROUP style, inherited by every rule beneath it — the
		// built-in grid the mark replaces had no dash anywhere.
		expect(grid?.getAttribute("stroke-dasharray")).toBe("3 3")
		expect(grid?.querySelectorAll("line, path").length).toBeGreaterThan(0)
	})
})
